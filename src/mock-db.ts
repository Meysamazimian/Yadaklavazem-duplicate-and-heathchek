import type { Knex } from 'knex';

export interface MockColumnInfo {
  name: string;
  dataType: string;
  columnType: string;
  extra: string;
  nullable: boolean;
}

interface TableSchema {
  name: string;
  columns: MockColumnInfo[];
  pk: string[];
  ddl: string;
  defaults: Map<string, unknown>;
  rows: Record<string, any>[];
  autoId: number;
}

class RawExpr {
  constructor(
    public readonly sql: string,
    public readonly bindings?: unknown[]
  ) {}
}

function unquote(ident: string): string {
  return ident.trim().replace(/^`|`$/g, '').replace(/``/g, '`');
}

function toHourBucket(val: unknown): string {
  const d = val instanceof Date ? val : new Date(String(val));
  const iso = d.toISOString();
  return `${iso.slice(0, 13)}:00:00Z`;
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (a instanceof Date || b instanceof Date) {
    const ta = a instanceof Date ? a.getTime() : new Date(String(a)).getTime();
    const tb = b instanceof Date ? b.getTime() : new Date(String(b)).getTime();
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  }
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== '' && String(b).trim() !== '') {
    return na < nb ? -1 : na > nb ? 1 : 0;
  }
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function createInitialSourceTables(): Map<string, TableSchema> {
  const tables = new Map<string, TableSchema>();
  const now = new Date();
  const isoAt = (minsAgo: number) => new Date(now.getTime() - minsAgo * 60_000).toISOString().replace('T', ' ').slice(0, 19);

  tables.set('products', {
    name: 'products',
    pk: ['id'],
    columns: [
      { name: 'id', dataType: 'bigint', columnType: 'bigint', extra: 'auto_increment', nullable: false },
      { name: 'sku', dataType: 'varchar', columnType: 'varchar(64)', extra: '', nullable: false },
      { name: 'title', dataType: 'varchar', columnType: 'varchar(255)', extra: '', nullable: false },
      { name: 'brand', dataType: 'varchar', columnType: 'varchar(120)', extra: '', nullable: false },
      { name: 'price_irr', dataType: 'bigint', columnType: 'bigint', extra: '', nullable: false },
      { name: 'stock', dataType: 'int', columnType: 'int', extra: '', nullable: false },
      { name: 'created_at', dataType: 'datetime', columnType: 'datetime', extra: '', nullable: false },
    ],
    ddl: [
      'CREATE TABLE `products` (',
      '  `id` bigint NOT NULL AUTO_INCREMENT,',
      '  `sku` varchar(64) NOT NULL,',
      '  `title` varchar(255) NOT NULL,',
      '  `brand` varchar(120) NOT NULL,',
      '  `price_irr` bigint NOT NULL,',
      '  `stock` int NOT NULL,',
      '  `created_at` datetime NOT NULL,',
      '  PRIMARY KEY (`id`)',
      ') ENGINE=InnoDB AUTO_INCREMENT=1025 DEFAULT CHARSET=utf8mb4',
    ].join('\n'),
    defaults: new Map(),
    autoId: 1024,
    rows: Array.from({ length: 24 }, (_, i) => ({
      id: String(1001 + i),
      sku: `YDK-${1001 + i}`,
      title: `قطعه یدکی شماره ${1001 + i}`,
      brand: ['ایساکو', 'عظام', 'کروز', 'بوش', 'والئو'][i % 5],
      price_irr: String((i + 1) * 450_000),
      stock: (i * 7) % 40,
      created_at: isoAt(120 - i * 4),
    })),
  });

  tables.set('orders', {
    name: 'orders',
    pk: ['id'],
    columns: [
      { name: 'id', dataType: 'bigint', columnType: 'bigint', extra: 'auto_increment', nullable: false },
      { name: 'customer_id', dataType: 'bigint', columnType: 'bigint', extra: '', nullable: false },
      { name: 'status', dataType: 'enum', columnType: "enum('pending','paid','shipped','delivered')", extra: '', nullable: false },
      { name: 'total_irr', dataType: 'bigint', columnType: 'bigint', extra: '', nullable: false },
      { name: 'created_at', dataType: 'datetime', columnType: 'datetime', extra: '', nullable: false },
    ],
    ddl: [
      'CREATE TABLE `orders` (',
      '  `id` bigint NOT NULL AUTO_INCREMENT,',
      '  `customer_id` bigint NOT NULL,',
      "  `status` enum('pending','paid','shipped','delivered') NOT NULL,",
      '  `total_irr` bigint NOT NULL,',
      '  `created_at` datetime NOT NULL,',
      '  PRIMARY KEY (`id`),',
      '  CONSTRAINT `fk_orders_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE',
      ') ENGINE=InnoDB AUTO_INCREMENT=5019 DEFAULT CHARSET=utf8mb4',
    ].join('\n'),
    defaults: new Map(),
    autoId: 5018,
    rows: Array.from({ length: 18 }, (_, i) => ({
      id: String(5001 + i),
      customer_id: String(2001 + (i % 15)),
      status: ['paid', 'shipped', 'delivered', 'pending'][i % 4],
      total_irr: String((i + 2) * 1_250_000),
      created_at: isoAt(90 - i * 3),
    })),
  });

  tables.set('customers', {
    name: 'customers',
    pk: ['id'],
    columns: [
      { name: 'id', dataType: 'bigint', columnType: 'bigint', extra: 'auto_increment', nullable: false },
      { name: 'full_name', dataType: 'varchar', columnType: 'varchar(180)', extra: '', nullable: false },
      { name: 'phone', dataType: 'varchar', columnType: 'varchar(20)', extra: '', nullable: false },
      { name: 'city', dataType: 'varchar', columnType: 'varchar(80)', extra: '', nullable: false },
    ],
    ddl: [
      'CREATE TABLE `customers` (',
      '  `id` bigint NOT NULL AUTO_INCREMENT,',
      '  `full_name` varchar(180) NOT NULL,',
      '  `phone` varchar(20) NOT NULL,',
      '  `city` varchar(80) NOT NULL,',
      '  PRIMARY KEY (`id`)',
      ') ENGINE=InnoDB AUTO_INCREMENT=2016 DEFAULT CHARSET=utf8mb4',
    ].join('\n'),
    defaults: new Map(),
    autoId: 2015,
    rows: Array.from({ length: 15 }, (_, i) => ({
      id: String(2001 + i),
      full_name: `مشتری ${i + 1}`,
      phone: `0912000${String(1000 + i)}`,
      city: ['تهران', 'اصفهان', 'مشهد', 'تبریز', 'شیراز'][i % 5],
    })),
  });

  tables.set('categories', {
    name: 'categories',
    pk: ['slug'],
    columns: [
      { name: 'slug', dataType: 'varchar', columnType: 'varchar(64)', extra: '', nullable: false },
      { name: 'title', dataType: 'varchar', columnType: 'varchar(120)', extra: '', nullable: false },
    ],
    ddl: [
      'CREATE TABLE `categories` (',
      '  `slug` varchar(64) NOT NULL,',
      '  `title` varchar(120) NOT NULL,',
      '  PRIMARY KEY (`slug`)',
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
    ].join('\n'),
    defaults: new Map(),
    autoId: 0,
    rows: [
      { slug: 'body-parts', title: 'قطعات بدنه و چراغ' },
      { slug: 'brake-system', title: 'سیستم ترمز و لنت' },
      { slug: 'cooling', title: 'سیستم خنک‌کننده و رادیاتور' },
      { slug: 'electrical', title: 'برق و انژکتور' },
      { slug: 'engine-parts', title: 'قطعات موتوری' },
      { slug: 'filters', title: 'فیلتر هوا و روغن' },
      { slug: 'suspension', title: 'جلوبندی و تعلیق' },
      { slug: 'transmission', title: 'گیربکس و کلاچ' },
    ],
  });

  return tables;
}

export function createMockKnexPair(): { src: Knex; dst: Knex } {
  const srcTables = createInitialSourceTables();
  const dstTables = new Map<string, TableSchema>();

  const buildInstance = (tables: Map<string, TableSchema>, peerTables: Map<string, TableSchema>): Knex => {
    const ensureTable = (name: string): TableSchema => {
      let t = tables.get(name);
      if (!t) {
        t = { name, columns: [], pk: ['id'], ddl: '', defaults: new Map(), rows: [], autoId: 0 };
        tables.set(name, t);
      }
      return t;
    };

    const insertRowsInto = (table: TableSchema, inputRows: Record<string, any>[], mode: 'normal' | 'ignore' | 'merge', mergeSpec?: string[] | Record<string, any>): { inserted: number; lastId: number } => {
      let inserted = 0;
      let lastId = table.autoId;

      for (const rawRow of inputRows) {
        const row: Record<string, any> = {};
        for (const [k, d] of table.defaults.entries()) {
          row[k] = d;
        }
        for (const [k, v] of Object.entries(rawRow)) {
          if (v !== undefined) row[k] = v;
        }

        const existingIdx =
          table.pk.length > 0 && table.pk.every((k) => row[k] !== undefined && row[k] !== null)
            ? table.rows.findIndex((r) => table.pk.every((k) => String(r[k]) === String(row[k])))
            : -1;

        if (existingIdx >= 0) {
          if (mode === 'ignore') {
            continue;
          }
          if (mode === 'merge') {
            const target = table.rows[existingIdx];
            if (Array.isArray(mergeSpec)) {
              for (const col of mergeSpec) {
                if (rawRow[col] !== undefined) target[col] = rawRow[col];
              }
            } else if (mergeSpec && typeof mergeSpec === 'object') {
              for (const [k, v] of Object.entries(mergeSpec)) {
                if (v !== undefined) target[k] = v;
              }
            } else {
              for (const [k, v] of Object.entries(rawRow)) {
                if (v !== undefined) target[k] = v;
              }
            }
            continue;
          }
        }

        if (table.pk.length === 1 && table.pk[0] === 'id' && (row.id === undefined || row.id === null)) {
          table.autoId += 1;
          row.id = table.autoId;
          lastId = table.autoId;
        }
        table.rows.push(row);
        inserted += 1;
      }

      return { inserted, lastId };
    };

    const executeRaw = async (sql: string, bindings?: unknown[]): Promise<any> => {
      const s = sql.trim();

      if (s.startsWith('__MOCK_INSERT_IGNORE__:')) {
        const tableName = s.slice('__MOCK_INSERT_IGNORE__:'.length);
        const table = ensureTable(tableName);
        const rows = (bindings as Record<string, any>[]) || [];
        const { inserted } = insertRowsInto(table, rows, 'ignore');
        return [{ affectedRows: inserted }];
      }

      if (/FROM\s+information_schema\.TABLES/i.test(s)) {
        const list = Array.from(tables.keys())
          .sort()
          .map((name) => ({ name }));
        return [list];
      }

      if (/FROM\s+information_schema\.COLUMNS/i.test(s)) {
        const tableName = String((bindings as any)?.[1] ?? '');
        const t = tables.get(tableName);
        return [
          (t?.columns ?? []).map((c) => ({
            name: c.name,
            dataType: c.dataType,
            columnType: c.columnType,
            extra: c.extra,
            nullable: c.nullable ? 'YES' : 'NO',
          })),
        ];
      }

      if (/FROM\s+information_schema\.KEY_COLUMN_USAGE/i.test(s)) {
        const tableName = String((bindings as any)?.[1] ?? '');
        const t = tables.get(tableName);
        return [(t?.pk ?? []).map((name) => ({ name }))];
      }

      const showMatch = /^SHOW\s+CREATE\s+TABLE\s+`([^`]+)`/i.exec(s);
      if (showMatch) {
        const tableName = showMatch[1];
        const t = tables.get(tableName);
        return [[{ 'Create Table': t?.ddl || `CREATE TABLE \`${tableName}\` (\`id\` bigint PRIMARY KEY)` }]];
      }

      const createMatch = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`([^`]+)`/i.exec(s);
      if (createMatch) {
        const tableName = createMatch[1];
        if (!tables.has(tableName)) {
          const srcT = peerTables.get(tableName);
          tables.set(tableName, {
            name: tableName,
            columns: srcT ? srcT.columns.map((c) => ({ ...c })) : [],
            pk: srcT ? [...srcT.pk] : ['id'],
            ddl: s,
            defaults: new Map(),
            rows: [],
            autoId: 0,
          });
        }
        return [{ affectedRows: 0 }];
      }

      const alterMatch = /^ALTER\s+TABLE\s+`([^`]+)`/i.exec(s);
      if (alterMatch) {
        return [{ affectedRows: 0 }];
      }

      const countMatch = /^SELECT\s+COUNT\(\*\)\s+AS\s+n\s+FROM\s+`([^`]+)`/i.exec(s);
      if (countMatch) {
        const tableName = countMatch[1];
        const t = tables.get(tableName);
        return [[{ n: t ? t.rows.length : 0 }]];
      }

      return [[]];
    };

    const queryBuilder = (tableName: string): any => {
      const filters: Array<(row: Record<string, any>) => boolean> = [];
      const asyncFilters: Array<() => Promise<(row: Record<string, any>) => boolean>> = [];
      const orders: Array<{ column: string; order: 'asc' | 'desc' }> = [];
      let selectArgs: unknown[] = [];
      let groupCol: string | null = null;
      let groupHourly = false;
      let limitCount: number | null = null;
      let op: 'select' | 'first' | 'insert' | 'update' | 'delete' = 'select';
      let firstCols: string[] = [];
      let insertPayload: Record<string, any>[] = [];
      let conflictMode: 'normal' | 'ignore' | 'merge' = 'normal';
      let mergeSpec: string[] | Record<string, any> | undefined;
      let updatePayload: Record<string, any> = {};

      const addWhere = (arg1: any, arg2?: any, arg3?: any) => {
        if (typeof arg1 === 'object' && arg1 !== null && !(arg1 instanceof RawExpr)) {
          const cond = arg1 as Record<string, any>;
          filters.push((row) => Object.entries(cond).every(([k, v]) => row[k] === v));
          return qb;
        }
        const col = String(arg1);
        const operator = arg3 === undefined ? '=' : String(arg2);
        const val = arg3 === undefined ? arg2 : arg3;
        filters.push((row) => {
          const c = compareValues(row[col], val);
          if (operator === '=') return row[col] === val || String(row[col]) === String(val);
          if (operator === '<') return c < 0;
          if (operator === '<=') return c <= 0;
          if (operator === '>') return c > 0;
          if (operator === '>=') return c >= 0;
          if (operator === '!=' || operator === '<>') return c !== 0;
          return false;
        });
        return qb;
      };

      const evaluate = async (): Promise<any> => {
        const table = ensureTable(tableName);

        if (op === 'insert') {
          const { lastId } = insertRowsInto(table, insertPayload, conflictMode, mergeSpec);
          return [lastId];
        }

        const resolvedAsync = await Promise.all(asyncFilters.map((fn) => fn()));
        const allFilters = [...filters, ...resolvedAsync];
        const matched = table.rows.filter((r) => allFilters.every((fn) => fn(r)));

        if (op === 'update') {
          for (const r of matched) {
            for (const [k, v] of Object.entries(updatePayload)) {
              if (v !== undefined) r[k] = v;
            }
          }
          return matched.length;
        }

        if (op === 'delete') {
          const toRemove = new Set(matched);
          const before = table.rows.length;
          table.rows = table.rows.filter((r) => !toRemove.has(r));
          return before - table.rows.length;
        }

        const rawSelect = selectArgs.find((a): a is RawExpr => a instanceof RawExpr);

        if (rawSelect) {
          const expr = rawSelect.sql;
          if (expr.includes('DATE_FORMAT(checked_at')) {
            const buckets = new Map<string, Record<string, any>[]>();
            for (const r of matched) {
              const t = toHourBucket(r.checked_at);
              const list = buckets.get(t) || [];
              list.push(r);
              buckets.set(t, list);
            }
            return Array.from(buckets.entries())
              .map(([t, list]) => ({
                t,
                total: list.length,
                ok: list.reduce((acc, r) => acc + (r.ok ? 1 : 0), 0),
                avg: list.length ? list.reduce((acc, r) => acc + Number(r.latency_ms || 0), 0) / list.length : 0,
                max: list.length ? Math.max(...list.map((r) => Number(r.latency_ms || 0))) : 0,
              }))
              .sort((a, b) => a.t.localeCompare(b.t));
          }

          if (expr.includes('COUNT(*) AS total') && groupCol) {
            const groups = new Map<string, Record<string, any>[]>();
            for (const r of matched) {
              const k = String(r[groupCol]);
              const list = groups.get(k) || [];
              list.push(r);
              groups.set(k, list);
            }
            return Array.from(groups.entries()).map(([k, list]) => ({
              [groupCol!]: k,
              total: list.length,
              ok: list.reduce((acc, r) => acc + (r.ok ? 1 : 0), 0),
              avg: list.length ? list.reduce((acc, r) => acc + Number(r.latency_ms || 0), 0) / list.length : 0,
            }));
          }

          if (expr.includes('COUNT(*) AS total, SUM(ok) AS ok, AVG(latency_ms) AS avg, MAX(latency_ms) AS max')) {
            return [
              {
                total: matched.length,
                ok: matched.reduce((acc, r) => acc + (r.ok ? 1 : 0), 0),
                avg: matched.length ? matched.reduce((acc, r) => acc + Number(r.latency_ms || 0), 0) / matched.length : null,
                max: matched.length ? Math.max(...matched.map((r) => Number(r.latency_ms || 0))) : null,
              },
            ];
          }

          if (expr.includes('COALESCE(SUM(total_copied),0) AS copied')) {
            return [
              {
                n: matched.length,
                copied: matched.reduce((acc, r) => acc + Number(r.total_copied || 0), 0),
                failing: matched.reduce((acc, r) => acc + (r.last_error !== null && r.last_error !== undefined ? 1 : 0), 0),
                behind: matched.reduce((acc, r) => acc + Math.max(Number(r.src_rows || 0) - Number(r.dst_rows || 0), 0), 0),
              },
            ];
          }

          if (expr.includes('COALESCE(SUM(GREATEST(src_rows - dst_rows, 0)), 0) AS n')) {
            return [
              {
                n: matched.reduce((acc, r) => acc + Math.max(Number(r.src_rows || 0) - Number(r.dst_rows || 0), 0), 0),
              },
            ];
          }
        }

        let result = matched.map((r) => ({ ...r }));

        if (orders.length > 0) {
          result.sort((a, b) => {
            for (const o of orders) {
              const cmp = compareValues(a[o.column], b[o.column]);
              if (cmp !== 0) return o.order === 'desc' ? -cmp : cmp;
            }
            return 0;
          });
        }

        if (limitCount !== null) {
          result = result.slice(0, limitCount);
        }

        if (rawSelect && rawSelect.sql.includes('`')) {
          const cols = rawSelect.sql.split(',').map(unquote).filter(Boolean);
          result = result.map((r) => {
            const picked: Record<string, any> = {};
            for (const c of cols) picked[c] = r[c];
            return picked;
          });
        } else if (selectArgs.length > 0 && selectArgs.every((a) => typeof a === 'string')) {
          const cols = selectArgs as string[];
          result = result.map((r) => {
            const picked: Record<string, any> = {};
            for (const c of cols) picked[c] = r[c];
            return picked;
          });
        }

        if (op === 'first') {
          const firstRow = result[0];
          if (!firstRow) return undefined;
          if (firstCols.length > 0) {
            const picked: Record<string, any> = {};
            for (const c of firstCols) picked[c] = firstRow[c];
            return picked;
          }
          return firstRow;
        }

        return result;
      };

      const qb: any = {
        where: addWhere,
        andWhere: addWhere,
        whereIn(col: string, valuesOrSub: any) {
          if (Array.isArray(valuesOrSub)) {
            const set = new Set(valuesOrSub.map(String));
            filters.push((row) => set.has(String(row[col])));
          } else {
            asyncFilters.push(async () => {
              const rows = await valuesOrSub;
              const set = new Set(
                (Array.isArray(rows) ? rows : []).map((r: any) =>
                  typeof r === 'object' && r !== null ? String(Object.values(r)[0]) : String(r)
                )
              );
              return (row) => set.has(String(row[col]));
            });
          }
          return qb;
        },
        whereNotIn(col: string, values: unknown[]) {
          const set = new Set(values.map(String));
          filters.push((row) => !set.has(String(row[col])));
          return qb;
        },
        whereNotNull(col: string) {
          filters.push((row) => row[col] !== null && row[col] !== undefined);
          return qb;
        },
        whereRaw(sql: string, bindings?: unknown[]) {
          const cols = (sql.match(/`[^`]+`/g) || []).map(unquote);
          const vals = (bindings || []).map(String);
          if (cols.length > 0) {
            filters.push((row) => {
              for (let i = 0; i < cols.length; i++) {
                const cmp = compareValues(String(row[cols[i]]), vals[i]);
                if (cmp !== 0) return cmp > 0;
              }
              return false;
            });
          }
          return qb;
        },
        select(...args: unknown[]) {
          selectArgs.push(...args);
          return qb;
        },
        groupBy(col: string) {
          groupCol = col;
          return qb;
        },
        groupByRaw() {
          groupHourly = true;
          void groupHourly;
          return qb;
        },
        orderBy(colOrList: string | Array<{ column: string; order?: 'asc' | 'desc' }>, dir: 'asc' | 'desc' = 'asc') {
          if (Array.isArray(colOrList)) {
            for (const item of colOrList) {
              orders.push({ column: item.column, order: item.order || 'asc' });
            }
          } else {
            orders.push({ column: colOrList, order: dir });
          }
          return qb;
        },
        limit(n: number) {
          limitCount = n;
          return qb;
        },
        first(...cols: string[]) {
          op = 'first';
          firstCols = cols;
          return qb;
        },
        insert(data: Record<string, any> | Record<string, any>[]) {
          op = 'insert';
          insertPayload = Array.isArray(data) ? data : [data];
          return qb;
        },
        onConflict() {
          return {
            ignore() {
              conflictMode = 'ignore';
              return qb;
            },
            merge(spec?: string[] | Record<string, any>) {
              conflictMode = 'merge';
              mergeSpec = spec;
              return qb;
            },
          };
        },
        toSQL() {
          return {
            sql: `__MOCK_INSERT_IGNORE__:${tableName}`,
            bindings: insertPayload,
          };
        },
        update(data: Record<string, any>) {
          op = 'update';
          updatePayload = data;
          return qb;
        },
        delete() {
          op = 'delete';
          return qb;
        },
        then(onFulfilled?: (v: any) => any, onRejected?: (e: any) => any) {
          return evaluate().then(onFulfilled, onRejected);
        },
        catch(onRejected?: (e: any) => any) {
          return evaluate().catch(onRejected);
        },
      };

      return qb;
    };

    const instance: any = (tableName: string) => queryBuilder(tableName);

    instance.raw = (sql: string, bindings?: unknown[]) => {
      const expr = new RawExpr(sql, bindings);
      return Object.assign(expr, {
        then(onFulfilled?: (v: any) => any, onRejected?: (e: any) => any) {
          return executeRaw(sql, bindings).then(onFulfilled, onRejected);
        },
        catch(onRejected?: (e: any) => any) {
          return executeRaw(sql, bindings).catch(onRejected);
        },
      });
    };

    instance.schema = {
      async hasTable(name: string): Promise<boolean> {
        return tables.has(name);
      },
      async createTable(name: string, build: (t: any) => void): Promise<void> {
        const schema: TableSchema = {
          name,
          columns: [],
          pk: [],
          ddl: `CREATE TABLE \`${name}\` ()`,
          defaults: new Map(),
          rows: [],
          autoId: 0,
        };
        const makeCol = (colName: string, dataType: string) => {
          const col: MockColumnInfo = { name: colName, dataType, columnType: dataType, extra: '', nullable: true };
          schema.columns.push(col);
          const chain: any = {
            notNullable() {
              col.nullable = false;
              return chain;
            },
            nullable() {
              col.nullable = true;
              if (!schema.defaults.has(colName)) schema.defaults.set(colName, null);
              return chain;
            },
            defaultTo(v: unknown) {
              schema.defaults.set(colName, v);
              return chain;
            },
            primary() {
              if (!schema.pk.includes(colName)) schema.pk.push(colName);
              return chain;
            },
          };
          return chain;
        };
        const builder = {
          bigIncrements(colName: string) {
            schema.pk = [colName];
            return makeCol(colName, 'bigint');
          },
          string(colName: string) {
            return makeCol(colName, 'varchar');
          },
          dateTime(colName: string) {
            return makeCol(colName, 'datetime');
          },
          integer(colName: string) {
            return makeCol(colName, 'int');
          },
          bigInteger(colName: string) {
            return makeCol(colName, 'bigint');
          },
          boolean(colName: string) {
            return makeCol(colName, 'tinyint');
          },
          text(colName: string) {
            return makeCol(colName, 'text');
          },
          index() {
            return builder;
          },
        };
        build(builder);
        tables.set(name, schema);
      },
    };

    instance.destroy = async () => undefined;

    return instance as Knex;
  };

  return {
    src: buildInstance(srcTables, dstTables),
    dst: buildInstance(dstTables, srcTables),
  };
}
