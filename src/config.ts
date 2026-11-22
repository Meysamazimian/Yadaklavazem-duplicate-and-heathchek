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

export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

const useMockDb = !str('SRC_DB_NAME') && !str('DST_DB_NAME');

const source: DbConfig = {
  host: str('SRC_DB_HOST', '127.0.0.1'),
  port: num('SRC_DB_PORT', 3306),
  user: str('SRC_DB_USER', useMockDb ? 'demo_src' : ''),
  password: process.env.SRC_DB_PASSWORD ?? '',
  database: str('SRC_DB_NAME', useMockDb ? 'yadak_main' : ''),
};

const target: DbConfig = {
  host: str('DST_DB_HOST', source.host),
  port: num('DST_DB_PORT', source.port),
  user: str('DST_DB_USER', source.user),
  password: str('DST_DB_PASSWORD') !== '' ? process.env.DST_DB_PASSWORD ?? '' : source.password,
  database: str('DST_DB_NAME', useMockDb ? 'yadak_replica' : ''),
};

const resolvedPort = str('APP_PORT')
  ? num('APP_PORT', 3000)
  : str('DEFAULT_APP_PORT')
  ? num('DEFAULT_APP_PORT', 3000)
  : num('PORT', 3000);

export const config = {
  port: resolvedPort,
  useMockDb,
  source,
  target,
  dashboardPassword: str('DASHBOARD_PASSWORD', useMockDb ? 'admin' : ''),
  sessionSecret: str('SESSION_SECRET'),
  cookieSecure: bool('COOKIE_SECURE', true),
  trustProxy: str('TRUST_PROXY', 'loopback, linklocal, uniquelocal'),
  cycleIntervalMinutes: Math.max(1, num('CYCLE_INTERVAL_MINUTES', 5)),
  enableScheduler: bool('ENABLE_SCHEDULER', true),
  cronKey: str('CRON_KEY'),
  replicate: {
    batchSize: Math.max(10, num('REPLICATE_BATCH_SIZE', 500)),
    maxSeconds: Math.max(10, num('REPLICATE_MAX_SECONDS', 240)),
    exclude: list('REPLICATE_EXCLUDE', 'cache,knex_migrations_lock'),
    include: list('REPLICATE_INCLUDE'),
    lookback: Math.max(0, num('REPLICATE_LOOKBACK', 1000)),
    fullScanMaxRows: num('FULL_SCAN_MAX_ROWS', 500000),
    countRows: bool('REPLICATE_COUNT_ROWS', true),
  },
  monitor: {
    backendUrl: str('BACKEND_URL', `http://127.0.0.1:${resolvedPort}`).replace(/\/+$/, ''),
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
export function validateConfig(): string[] {
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
  if (!config.dashboardPassword) problems.push('DASHBOARD_PASSWORD is required');
  return problems;
}
