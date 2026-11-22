import { knex, Knex } from 'knex';
import { config, DbConfig } from './config';
import { createMockKnexPair } from './mock-db';

const make = (c: DbConfig): Knex =>
  knex({
    client: 'mysql2',
    connection: {
      host: c.host,
      port: c.port,
      user: c.user,
      password: c.password,
      database: c.database,
      charset: 'utf8mb4',
      timezone: 'Z',
      // Copy values exactly as MySQL stores them: no Date/JSON/BigInt conversion on the way through.
      dateStrings: true,
      jsonStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    } as any,
    pool: { min: 0, max: 4 },
  });

let srcDb: Knex | null = null;
let dstDb: Knex | null = null;

function initMockIfNeeded(): void {
  if (config.useMockDb && (!srcDb || !dstDb)) {
    const pair = createMockKnexPair();
    srcDb = pair.src;
    dstDb = pair.dst;
  }
}

/** Source (main) database. This app only ever reads from it. */
export const src = (): Knex => {
  initMockIfNeeded();
  return (srcDb ??= make(config.source));
};
/** Replica database. Holds the copied tables plus this app's own `__dup_*` / `__mon_*` tables. */
export const dst = (): Knex => {
  initMockIfNeeded();
  return (dstDb ??= make(config.target));
};

export async function closeDbs(): Promise<void> {
  await Promise.allSettled([srcDb?.destroy(), dstDb?.destroy()]);
  srcDb = null;
  dstDb = null;
}

export const q = (identifier: string): string => '`' + identifier.replace(/`/g, '``') + '`';

/** MySQL DATETIME string (UTC) -> ISO string, passes null through. */
export const toIso = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  return s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
};
