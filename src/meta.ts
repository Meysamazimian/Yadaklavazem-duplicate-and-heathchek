import { dst } from './db';

/** Creates this app's own bookkeeping tables in the replica database (never touches the copied tables). */
export async function ensureMeta(): Promise<void> {
  const db = dst();
  const create = async (name: string, build: (t: any) => void) => {
    if (!(await db.schema.hasTable(name))) await db.schema.createTable(name, build);
  };

  await create('__dup_runs', (t) => {
    t.bigIncrements('id');
    t.string('trigger', 20).notNullable();
    t.dateTime('started_at', { precision: 3 }).notNullable();
    t.dateTime('finished_at', { precision: 3 }).nullable();
    t.integer('duration_ms').nullable();
    t.string('status', 16).notNullable(); // running | ok | partial | error
    t.integer('tables_total').notNullable().defaultTo(0);
    t.integer('tables_with_rows').notNullable().defaultTo(0);
    t.integer('tables_failed').notNullable().defaultTo(0);
    t.bigInteger('rows_copied').notNullable().defaultTo(0);
    t.bigInteger('rows_behind').nullable();
    t.text('error').nullable();
    t.index(['started_at']);
  });

  await create('__dup_run_tables', (t) => {
    t.bigIncrements('id');
    t.bigInteger('run_id').notNullable();
    t.string('table_name', 128).notNullable();
    t.integer('copied').notNullable().defaultTo(0);
    t.integer('duration_ms').notNullable().defaultTo(0);
    t.boolean('created_table').notNullable().defaultTo(false);
    t.text('error').nullable();
    t.index(['run_id']);
  });

  await create('__dup_tables', (t) => {
    t.string('table_name', 128).primary();
    t.string('mode', 24).nullable(); // pk-incremental | full-scan | skipped
    t.string('watermark', 191).nullable();
    t.bigInteger('total_copied').notNullable().defaultTo(0);
    t.bigInteger('src_rows').nullable();
    t.bigInteger('dst_rows').nullable();
    t.bigInteger('last_run_id').nullable();
    t.integer('last_copied').notNullable().defaultTo(0);
    t.dateTime('last_success_at', { precision: 3 }).nullable();
    t.text('last_error').nullable();
    t.string('skipped_reason', 191).nullable();
  });

  await create('__mon_endpoints', (t) => {
    t.string('endpoint_key', 255).primary(); // "GET /api/health"
    t.string('method', 10).notNullable();
    t.string('path', 255).notNullable();
    t.string('origin', 16).notNullable(); // discovered | configured
    t.string('audience', 32).nullable();
    t.string('auth', 24).nullable();
    t.string('expected', 64).notNullable();
    t.boolean('active').notNullable().defaultTo(true);
    t.boolean('is_down').notNullable().defaultTo(false);
    t.integer('consecutive_failures').notNullable().defaultTo(0);
    t.integer('last_status').nullable();
    t.boolean('last_ok').nullable();
    t.integer('last_latency_ms').nullable();
    t.string('last_error', 500).nullable();
    t.dateTime('last_checked_at', { precision: 3 }).nullable();
    t.dateTime('state_since', { precision: 3 }).nullable();
  });

  await create('__mon_checks', (t) => {
    t.bigIncrements('id');
    t.string('endpoint_key', 255).notNullable();
    t.integer('status_code').nullable();
    t.boolean('ok').notNullable();
    t.integer('latency_ms').notNullable();
    t.string('error', 500).nullable();
    t.dateTime('checked_at', { precision: 3 }).notNullable();
    t.index(['endpoint_key', 'checked_at']);
    t.index(['checked_at']);
  });

  await create('__mon_events', (t) => {
    t.bigIncrements('id');
    t.dateTime('at', { precision: 3 }).notNullable();
    t.string('level', 8).notNullable(); // info | warn | error
    t.string('type', 32).notNullable();
    t.string('subject', 255).nullable();
    t.text('message').nullable();
    t.index(['at']);
  });

  await create('__mon_lock', (t) => {
    t.string('name', 64).primary();
    t.dateTime('locked_until', { precision: 3 }).notNullable();
    t.string('holder', 64).nullable();
  });

  await create('__mon_state', (t) => {
    t.string('k', 64).primary();
    t.text('v').nullable();
  });
}

export async function getState(key: string): Promise<string | null> {
  const row = await dst()('__mon_state').where({ k: key }).first('v');
  return row ? row.v : null;
}

export async function setState(key: string, value: string): Promise<void> {
  await dst()('__mon_state').insert({ k: key, v: value }).onConflict('k').merge();
}

export async function addEvent(level: 'info' | 'warn' | 'error', type: string, subject: string | null, message: string): Promise<void> {
  try {
    await dst()('__mon_events').insert({ at: new Date(), level, type, subject, message: message.slice(0, 4000) });
  } catch (err) {
    console.error('[events] could not write event:', (err as Error).message);
  }
}
