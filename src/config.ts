import dotenv from 'dotenv';

dotenv.config();

const str = (key: string, fallback = ''): string => {
  const v = process.env[key];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
};
const num = (key: string, fallback: number): number => {
  const n = Number(str(key));
  return Number.isFinite(n) && str(key) !== '' ? n : fallback;
};
const bool = (key: string, fallback: boolean): boolean => {
  const v = str(key).toLowerCase();
  if (v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v);
};
const list = (key: string, fallback = ''): string[] =>
  str(key, fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Tables never copied unless REPLICATE_EXCLUDE says otherwise. */
export const DEFAULT_REPLICATE_EXCLUDE = ['refresh_tokens', 'otp_codes', 'rate_limits', 'idempotency_keys', 'cache', 'jobs', 'knex_migrations_lock'];

export const MIN_PASSWORD_LENGTH = 12;
export const MIN_SECRET_LENGTH = 32;

export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

const source: DbConfig = {
  host: str('SRC_DB_HOST', '127.0.0.1'),
  port: num('SRC_DB_PORT', 3306),
  user: str('SRC_DB_USER'),
  password: process.env.SRC_DB_PASSWORD ?? '',
  database: str('SRC_DB_NAME'),
};

const target: DbConfig = {
  host: str('DST_DB_HOST', source.host),
  port: num('DST_DB_PORT', source.port),
  user: str('DST_DB_USER', source.user),
  password: str('DST_DB_PASSWORD') !== '' ? process.env.DST_DB_PASSWORD ?? '' : source.password,
  database: str('DST_DB_NAME'),
};

export const config = {
  port: num('PORT', 3100),
  source,
  target,
  dashboardPassword: str('DASHBOARD_PASSWORD'),
  sessionSecret: str('SESSION_SECRET'),
  cookieSecure: bool('COOKIE_SECURE', true),
  trustProxy: str('TRUST_PROXY', 'loopback, linklocal, uniquelocal'),
  cycleIntervalMinutes: Math.max(1, num('CYCLE_INTERVAL_MINUTES', 5)),
  enableScheduler: bool('ENABLE_SCHEDULER', true),
  cronKey: str('CRON_KEY'),
  replicate: {
    batchSize: Math.max(10, num('REPLICATE_BATCH_SIZE', 500)),
    maxSeconds: Math.max(10, num('REPLICATE_MAX_SECONDS', 240)),
    // Sessions, login codes, rate-limit counters, idempotency keys, cache and queued jobs are worthless as a backup and
    // would only make the replica a second place to steal them from (DPL-03). REPLICATE_EXCLUDE replaces this list.
    exclude: list('REPLICATE_EXCLUDE', DEFAULT_REPLICATE_EXCLUDE.join(',')),
    include: list('REPLICATE_INCLUDE'),
    lookback: Math.max(0, num('REPLICATE_LOOKBACK', 1000)),
    fullScanMaxRows: num('FULL_SCAN_MAX_ROWS', 500000),
    countRows: bool('REPLICATE_COUNT_ROWS', true),
  },
  monitor: {
    backendUrl: str('BACKEND_URL', 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    internalToken: str('INTERNAL_PROXY_TOKEN'),
    shopHost: str('MONITOR_SHOP_HOST'),
    swaggerPath: str('BACKEND_SWAGGER_PATH', '/api/internal/swagger-docs'),
    exclude: str('MONITOR_EXCLUDE', '/api/bot/|/api/payment/|/logout|/swagger'),
    endpointsFile: str('ENDPOINTS_FILE'),
    timeoutMs: num('REQUEST_TIMEOUT_MS', 10000),
    concurrency: Math.max(1, num('MONITOR_CONCURRENCY', 5)),
    failThreshold: Math.max(1, num('FAIL_THRESHOLD', 2)),
    discoveryRefreshMinutes: Math.max(1, num('DISCOVERY_REFRESH_MINUTES', 60)),
  },
  retentionDays: Math.max(1, num('RETENTION_DAYS', 14)),
};

/** Returns a list of human readable problems; empty means the configuration is usable. */
export function validateConfig(
  c: Pick<typeof config, 'dashboardPassword' | 'sessionSecret' | 'cronKey'> = config
): string[] {
  const problems: string[] = [];
  if (!source.user || !source.database) problems.push('SRC_DB_USER and SRC_DB_NAME are required');
  if (!target.database) problems.push('DST_DB_NAME is required');
  if (
    source.database &&
    source.database === target.database &&
    source.host.toLowerCase() === target.host.toLowerCase() &&
    source.port === target.port
  ) {
    problems.push('DST_DB_NAME must be a different database than SRC_DB_NAME (the replica is written to)');
  }
  // The dashboard sits next to a full copy of the main database (DPL-01).
  if (c.dashboardPassword.length < MIN_PASSWORD_LENGTH) {
    problems.push(`DASHBOARD_PASSWORD is required and must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (c.sessionSecret.length < MIN_SECRET_LENGTH) {
    problems.push(`SESSION_SECRET is required and must be at least ${MIN_SECRET_LENGTH} random characters (e.g. openssl rand -hex 32)`);
  }
  if (c.cronKey && c.cronKey.length < MIN_SECRET_LENGTH) problems.push(`CRON_KEY must be at least ${MIN_SECRET_LENGTH} characters (or empty to turn /cron/run off)`);
  return problems;
}
