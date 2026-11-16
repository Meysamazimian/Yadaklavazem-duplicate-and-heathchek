// Shared setup for the tests that need the CI databases (dup_src and dup_dst).
// Import this file FIRST: src/config.ts reads the environment once, when it is first loaded.

process.env.DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'test-dashboard-password';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret';
process.env.ENABLE_SCHEDULER = 'false';
process.env.REPLICATE_COUNT_ROWS = process.env.REPLICATE_COUNT_ROWS || 'true';

/** True when the CI databases are configured; DB tests are skipped otherwise. */
export const hasDb = Boolean(process.env.SRC_DB_NAME && process.env.DST_DB_NAME);
export const skipWithoutDb = hasDb ? false : 'needs SRC_DB_* and DST_DB_* (the CI MariaDB)';

/** Creates the replica's bookkeeping tables. Test files run in parallel, so a create race is retried. */
export async function ensureMetaSafely(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ensureMeta } = require('../src/meta') as typeof import('../src/meta');
  for (let attempt = 0; ; attempt++) {
    try {
      await ensureMeta();
      return;
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}
