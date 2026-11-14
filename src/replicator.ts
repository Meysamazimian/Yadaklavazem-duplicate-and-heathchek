import { config } from './config';
import { dst, q, src } from './db';
import { addEvent } from './meta';
import { INTEGER_TYPES, isGeneratedColumn, needsWidening, sanitizeCreateTable } from './ddl';

interface ColumnInfo {
  name: string;
  dataType: string;
  columnType: string;
  extra: string;
  nullable: boolean;
}

interface TableResult {
  copied: number;
  createdTable: boolean;
  skippedReason?: string;
}

export interface ReplicationResult {
  runId: number;
  status: 'ok' | 'partial' | 'error';
  tablesTotal: number;
  tablesWithRows: number;
  tablesFailed: number;
  rowsCopied: number;
  rowsBehind: number | null;
  error?: string;
}

const isOwnTable = (name: string) => name.startsWith('__');

async function listSourceTables(): Promise<string[]> {
  const rows = (
    await src().raw(
      `SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
      [config.source.database]
    )
  )[0] as Array<{ name: string }>;
  const { include, exclude } = config.replicate;
  return rows
    .map((r) => r.name)
    .filter((n) => !isOwnTable(n))
    .filter((n) => (include.length ? include.includes(n) : true))
    .filter((n) => !exclude.includes(n));
}

async function listTargetTables(): Promise<Set<string>> {
  const rows = (
    await dst().raw(`SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`, [
      config.target.database,
    ])
  )[0] as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

async function readColumns(db: ReturnType<typeof src>, schema: string, table: string): Promise<ColumnInfo[]> {
  const rows = (
    await db.raw(
      `SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType, COLUMN_TYPE AS columnType, EXTRA AS extra, IS_NULLABLE AS nullable
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [schema, table]
    )
  )[0] as any[];
  return rows.map((r) => ({
    name: r.name,
    dataType: String(r.dataType),
    columnType: String(r.columnType),
    extra: String(r.extra || ''),
    nullable: r.nullable === 'YES',
  }));
}

async function readPrimaryKey(table: string): Promise<string[]> {
  const rows = (
    await src().raw(
      `SELECT COLUMN_NAME AS name FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION`,
      [config.source.database, table]
    )
  )[0] as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/** Creates the table in the replica from the source definition. */
async function createTargetTable(table: string): Promise<void> {
  const res = (await src().raw(`SHOW CREATE TABLE ${q(table)}`))[0] as any[];
  const ddl: string = res[0]['Create Table'];
  await dst().raw(sanitizeCreateTable(ddl));
}

/** Additive schema sync for a table that already exists in the replica: new columns, wider enums/varchars. Never drops or narrows. */
async function syncTargetColumns(table: string, srcCols: ColumnInfo[]): Promise<string[]> {
  const dstCols = await readColumns(dst(), config.target.database, table);
  const byName = new Map(dstCols.map((c) => [c.name, c]));
  const changes: string[] = [];
  for (const col of srcCols) {
    if (isGeneratedColumn(col.extra)) continue;
    const existing = byName.get(col.name);
    if (!existing) {
      // NULL and no default: every copied row carries its own value for the column.
      await dst().raw(`ALTER TABLE ${q(table)} ADD COLUMN ${q(col.name)} ${col.columnType} NULL`);
      changes.push(`+${col.name}`);
    } else if (needsWidening(col.dataType, col.columnType, existing.columnType)) {
      await dst().raw(`ALTER TABLE ${q(table)} MODIFY COLUMN ${q(col.name)} ${col.columnType} ${existing.nullable ? 'NULL' : 'NOT NULL'}`);
      changes.push(`~${col.name}`);
    }
  }
  return changes;
}

/** INSERT IGNORE one batch. Returns how many rows were really inserted (ignored duplicates are not counted). */
async function insertIgnore(table: string, rows: Record<string, unknown>[]): Promise<number> {
  if (rows.length === 0) return 0;
  const compiled = dst()(table).insert(rows).onConflict().ignore().toSQL();
  const res = (await dst().raw(compiled.sql, compiled.bindings as any))[0] as { affectedRows?: number };
  return Number(res.affectedRows ?? 0);
}

async function loadState(table: string): Promise<{ watermark: string | null; totalCopied: number }> {
  const row = await dst()('__dup_tables').where({ table_name: table }).first('watermark', 'total_copied');
  return { watermark: row?.watermark ?? null, totalCopied: Number(row?.total_copied ?? 0) };
}

async function saveWatermark(table: string, mode: string, watermark: string | null): Promise<void> {
  await dst()('__dup_tables')
    .insert({ table_name: table, mode, watermark })
    .onConflict('table_name')
    .merge({ mode, watermark });
}

async function copyIncremental(table: string, pk: string, selectCols: string, deadline: number): Promise<number> {
  const { batchSize, lookback } = config.replicate;
  const state = await loadState(table);
  let cursor: string | null = state.watermark === null ? null : (BigInt(state.watermark) - BigInt(lookback)).toString();
  let watermark = state.watermark;
  let copied = 0;

  for (;;) {
    const query = src()(table).select(src().raw(selectCols)).orderBy(pk, 'asc').limit(batchSize);
    if (cursor !== null) query.where(pk, '>', cursor);
    const rows = (await query) as Record<string, unknown>[];
    if (rows.length === 0) break;

    copied += await insertIgnore(table, rows);
    const last = String(rows[rows.length - 1][pk]);
    cursor = last;
    if (watermark === null || BigInt(last) > BigInt(watermark)) {
      watermark = last;
      await saveWatermark(table, 'pk-incremental', watermark);
    }
    if (rows.length < batchSize) break;
    if (Date.now() > deadline) break; // continues next cycle from the saved watermark
  }
  return copied;
}

async function copyFullScan(table: string, pkCols: string[], selectCols: string, deadline: number): Promise<number> {
  const { batchSize } = config.replicate;
  const tuple = `(${pkCols.map(q).join(', ')})`;
  const marks = `(${pkCols.map(() => '?').join(', ')})`;
  let cursor: unknown[] | null = null;
  let copied = 0;

  for (;;) {
    const query = src()(table).select(src().raw(selectCols)).limit(batchSize);
    for (const col of pkCols) query.orderBy(col, 'asc');
    if (cursor) query.whereRaw(`${tuple} > ${marks}`, cursor as any);
    const rows = (await query) as Record<string, unknown>[];
    if (rows.length === 0) break;

    copied += await insertIgnore(table, rows);
    const last = rows[rows.length - 1];
    cursor = pkCols.map((c) => last[c]);
    if (rows.length < batchSize) break;
    // A full scan that is cut short just resumes from the start next time; INSERT IGNORE keeps that safe.
    if (Date.now() > deadline) break;
  }
  return copied;
}

async function replicateTable(table: string, targetTables: Set<string>, deadline: number): Promise<TableResult> {
  const srcCols = await readColumns(src(), config.source.database, table);
  if (srcCols.length === 0) return { copied: 0, createdTable: false, skippedReason: 'table has no columns' };

  const pkCols = await readPrimaryKey(table);
  if (pkCols.length === 0) {
    return { copied: 0, createdTable: false, skippedReason: 'no primary key: cannot copy insert-only safely' };
  }

  let createdTable = false;
  if (!targetTables.has(table)) {
    await createTargetTable(table);
    targetTables.add(table);
    createdTable = true;
  } else {
    const changes = await syncTargetColumns(table, srcCols);
    if (changes.length) await addEvent('info', 'schema_sync', table, `Replica columns updated: ${changes.join(', ')}`);
  }

  const insertable = srcCols.filter((c) => !isGeneratedColumn(c.extra));
  const selectCols = insertable.map((c) => q(c.name)).join(', ');
  const pkInfo = srcCols.find((c) => c.name === pkCols[0])!;
  const incremental = pkCols.length === 1 && INTEGER_TYPES.has(pkInfo.dataType.toLowerCase());

  if (!incremental) {
    const [{ n }] = (await src().raw(`SELECT COUNT(*) AS n FROM ${q(table)}`))[0] as Array<{ n: number | string }>;
    if (Number(n) > config.replicate.fullScanMaxRows) {
      return {
        copied: 0,
        createdTable,
        skippedReason: `primary key is not an integer and the table has ${n} rows (> FULL_SCAN_MAX_ROWS)`,
      };
    }
  }

  const copied = incremental
    ? await copyIncremental(table, pkCols[0], selectCols, deadline)
    : await copyFullScan(table, pkCols, selectCols, deadline);

  if (!incremental) await saveWatermark(table, 'full-scan', null);
  return { copied, createdTable };
}

async function countRows(table: string): Promise<{ srcRows: number; dstRows: number }> {
  const s = (await src().raw(`SELECT COUNT(*) AS n FROM ${q(table)}`))[0][0].n;
  const d = (await dst().raw(`SELECT COUNT(*) AS n FROM ${q(table)}`))[0][0].n;
  return { srcRows: Number(s), dstRows: Number(d) };
}

export async function runReplication(trigger: string): Promise<ReplicationResult> {
  const startedAt = new Date();
  const deadline = Date.now() + config.replicate.maxSeconds * 1000;
  const [runId] = await dst()('__dup_runs').insert({ trigger, started_at: startedAt, status: 'running' });

  let tables: string[] = [];
  let tablesWithRows = 0;
  let tablesFailed = 0;
  let rowsCopied = 0;
  let fatal: string | undefined;

  try {
    tables = await listSourceTables();
    const targetTables = await listTargetTables();

    for (const table of tables) {
      if (Date.now() > deadline) {
        await addEvent('warn', 'replication_time_limit', table, 'Time limit reached; remaining tables continue next cycle');
        break;
      }
      const t0 = Date.now();
      let result: TableResult | null = null;
      let error: string | null = null;
      try {
        result = await replicateTable(table, targetTables, deadline);
      } catch (err) {
        error = (err as Error).message;
        tablesFailed++;
        await addEvent('error', 'replication_table_failed', table, error);
      }

      const copied = result?.copied ?? 0;
      if (copied > 0) tablesWithRows++;
      rowsCopied += copied;

      let counts: { srcRows: number; dstRows: number } | null = null;
      if (!error && !result?.skippedReason && config.replicate.countRows) {
        try {
          counts = await countRows(table);
        } catch {
          counts = null;
        }
      }

      const state = await loadState(table);
      await dst()('__dup_tables')
        .insert({
          table_name: table,
          total_copied: state.totalCopied + copied,
          src_rows: counts?.srcRows ?? null,
          dst_rows: counts?.dstRows ?? null,
          last_run_id: runId,
          last_copied: copied,
          last_success_at: error ? undefined : new Date(),
          last_error: error ? error.slice(0, 2000) : null,
          skipped_reason: result?.skippedReason ?? null,
        })
        .onConflict('table_name')
        .merge(
          [
            'total_copied',
            'src_rows',
            'dst_rows',
            'last_run_id',
            'last_copied',
            'last_error',
            'skipped_reason',
            ...(error ? [] : ['last_success_at']),
          ] as any
        );

      if (copied > 0 || error || result?.createdTable) {
        await dst()('__dup_run_tables').insert({
          run_id: runId,
          table_name: table,
          copied,
          duration_ms: Date.now() - t0,
          created_table: result?.createdTable ?? false,
          error: error ? error.slice(0, 2000) : null,
        });
      }
    }
  } catch (err) {
    fatal = (err as Error).message;
    await addEvent('error', 'replication_failed', null, fatal);
  }

  const behind = (await dst()('__dup_tables').whereNotNull('src_rows').whereNotNull('dst_rows').select(dst().raw('COALESCE(SUM(GREATEST(src_rows - dst_rows, 0)), 0) AS n')))[0] as any;
  const rowsBehind = behind ? Number(behind.n) : null;
  const status: ReplicationResult['status'] = fatal ? 'error' : tablesFailed > 0 ? 'partial' : 'ok';

  await dst()('__dup_runs')
    .where({ id: runId })
    .update({
      finished_at: new Date(),
      duration_ms: Date.now() - startedAt.getTime(),
      status,
      tables_total: tables.length,
      tables_with_rows: tablesWithRows,
      tables_failed: tablesFailed,
      rows_copied: rowsCopied,
      rows_behind: rowsBehind,
      error: fatal ?? null,
    });

  return { runId: Number(runId), status, tablesTotal: tables.length, tablesWithRows, tablesFailed, rowsCopied, rowsBehind, error: fatal };
}
