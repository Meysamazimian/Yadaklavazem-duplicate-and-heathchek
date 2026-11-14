import { Router } from 'express';
import { config } from './config';
import { dst, toIso } from './db';
import { getEndpoints, } from './monitor';
import { getState } from './meta';
import { runCycle } from './cycle';

const router = Router();
const h = (fn: (req: any, res: any) => Promise<unknown>) => (req: any, res: any, next: any) => fn(req, res).catch(next);
const since = (hours: number) => new Date(Date.now() - hours * 3600_000);
const clampInt = (v: unknown, def: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : def;
};

const runRow = (r: any) =>
  r && {
    id: Number(r.id), trigger: r.trigger, status: r.status, startedAt: toIso(r.started_at), finishedAt: toIso(r.finished_at),
    durationMs: r.duration_ms, tablesTotal: r.tables_total, tablesWithRows: r.tables_with_rows, tablesFailed: r.tables_failed,
    rowsCopied: Number(r.rows_copied), rowsBehind: r.rows_behind === null ? null : Number(r.rows_behind), error: r.error,
  };

router.get('/summary', h(async (_req, res) => {
  const db = dst();
  const endpoints = await db('__mon_endpoints').where({ active: true });
  const down = endpoints.filter((e: any) => e.is_down).length;
  const unknown = endpoints.filter((e: any) => e.last_ok === null).length;

  const agg = (await db('__mon_checks')
    .where('checked_at', '>=', since(24))
    .select(db.raw('COUNT(*) AS total, SUM(ok) AS ok, AVG(latency_ms) AS avg, MAX(latency_ms) AS max')))[0] as any;

  const hourly = (await db('__mon_checks')
    .where('checked_at', '>=', since(24))
    .select(db.raw(`DATE_FORMAT(checked_at, '%Y-%m-%dT%H:00:00Z') AS t, COUNT(*) AS total, SUM(ok) AS ok, AVG(latency_ms) AS avg, MAX(latency_ms) AS max`))
    .groupByRaw(`DATE_FORMAT(checked_at, '%Y-%m-%dT%H:00:00Z')`)
    .orderBy('t', 'asc')) as any[];

  const lastRun = await db('__dup_runs').orderBy('id', 'desc').first();
  const lastOk = await db('__dup_runs').whereIn('status', ['ok', 'partial']).whereNotNull('finished_at').orderBy('id', 'desc').first();
  const tables = (await db('__dup_tables').select(
    db.raw('COUNT(*) AS n, COALESCE(SUM(total_copied),0) AS copied, COALESCE(SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END),0) AS failing, COALESCE(SUM(GREATEST(COALESCE(src_rows,0) - COALESCE(dst_rows,0), 0)),0) AS behind')
  ))[0] as any;

  const lastStart = await getState('last_cycle_started');
  const lastFinish = await getState('last_cycle_finished');
  const total = Number(agg?.total || 0);

  res.json({
    now: new Date().toISOString(),
    config: { intervalMinutes: config.cycleIntervalMinutes, scheduler: config.enableScheduler, cronEnabled: Boolean(config.cronKey), backendUrl: config.monitor.backendUrl },
    cycle: {
      lastStartedAt: lastStart ? new Date(Number(lastStart)).toISOString() : null,
      lastFinishedAt: lastFinish ? new Date(Number(lastFinish)).toISOString() : null,
      nextExpectedAt: lastStart ? new Date(Number(lastStart) + config.cycleIntervalMinutes * 60_000).toISOString() : null,
    },
    monitoring: {
      endpoints: endpoints.length, down, unknown, up: endpoints.length - down - unknown,
      uptime24h: total ? Number(agg.ok) / total : null,
      avgLatencyMs: total ? Math.round(Number(agg.avg)) : null,
      maxLatencyMs: total ? Number(agg.max) : null,
      hourly: hourly.map((r) => ({ t: r.t, total: Number(r.total), ok: Number(r.ok), avg: Math.round(Number(r.avg)), max: Number(r.max) })),
    },
    replication: {
      lastRun: runRow(lastRun),
      lastSuccessAt: lastOk ? toIso(lastOk.finished_at) : null,
      lagSeconds: lastOk?.finished_at ? Math.max(0, Math.round((Date.now() - new Date(toIso(lastOk.finished_at)!).getTime()) / 1000)) : null,
      tables: Number(tables?.n || 0), totalRowsCopied: Number(tables?.copied || 0),
      tablesFailing: Number(tables?.failing || 0), rowsBehind: Number(tables?.behind || 0),
    },
  });
}));

router.get('/endpoints', h(async (_req, res) => {
  const db = dst();
  const rows = await db('__mon_endpoints').where({ active: true }).orderBy([{ column: 'is_down', order: 'desc' }, { column: 'endpoint_key', order: 'asc' }]);
  const uptime = new Map<string, { total: number; ok: number; avg: number }>();
  (await db('__mon_checks').where('checked_at', '>=', since(24)).groupBy('endpoint_key')
    .select('endpoint_key', db.raw('COUNT(*) AS total, SUM(ok) AS ok, AVG(latency_ms) AS avg')) as any[])
    .forEach((r) => uptime.set(r.endpoint_key, { total: Number(r.total), ok: Number(r.ok), avg: Math.round(Number(r.avg)) }));

  const spark = new Map<string, number[]>();
  (await db('__mon_checks').where('checked_at', '>=', since(3)).orderBy('checked_at', 'asc').select('endpoint_key', 'latency_ms', 'ok') as any[])
    .forEach((r) => {
      const arr = spark.get(r.endpoint_key) || [];
      arr.push(r.ok ? r.latency_ms : -r.latency_ms);
      spark.set(r.endpoint_key, arr.slice(-36));
    });

  res.json(rows.map((r: any) => {
    const u = uptime.get(r.endpoint_key);
    return {
      key: r.endpoint_key, method: r.method, path: r.path, origin: r.origin, audience: r.audience, auth: r.auth, expected: r.expected,
      isDown: Boolean(r.is_down), lastOk: r.last_ok === null ? null : Boolean(r.last_ok), lastStatus: r.last_status,
      lastLatencyMs: r.last_latency_ms, lastError: r.last_error, lastCheckedAt: toIso(r.last_checked_at), stateSince: toIso(r.state_since),
      uptime24h: u && u.total ? u.ok / u.total : null, avgLatency24h: u ? u.avg : null, spark: spark.get(r.endpoint_key) || [],
    };
  }));
}));

router.get('/endpoints/history', h(async (req, res) => {
  const key = String(req.query.key || '');
  const hours = clampInt(req.query.hours, 24, 1, 24 * 30);
  const rows = await dst()('__mon_checks').where('endpoint_key', key).andWhere('checked_at', '>=', since(hours)).orderBy('checked_at', 'desc').limit(1000);
  res.json(rows.map((r: any) => ({ at: toIso(r.checked_at), status: r.status_code, ok: Boolean(r.ok), latencyMs: r.latency_ms, error: r.error })).reverse());
}));

router.get('/replication/runs', h(async (req, res) => {
  const rows = await dst()('__dup_runs').orderBy('id', 'desc').limit(clampInt(req.query.limit, 50, 1, 500));
  res.json(rows.map(runRow));
}));

router.get('/replication/runs/:id/tables', h(async (req, res) => {
  const rows = await dst()('__dup_run_tables').where({ run_id: Number(req.params.id) }).orderBy('copied', 'desc');
  res.json(rows.map((r: any) => ({ table: r.table_name, copied: r.copied, durationMs: r.duration_ms, createdTable: Boolean(r.created_table), error: r.error })));
}));

router.get('/replication/tables', h(async (_req, res) => {
  const rows = await dst()('__dup_tables').orderBy('table_name', 'asc');
  res.json(rows.map((r: any) => ({
    table: r.table_name, mode: r.mode, watermark: r.watermark, totalCopied: Number(r.total_copied),
    srcRows: r.src_rows === null ? null : Number(r.src_rows), dstRows: r.dst_rows === null ? null : Number(r.dst_rows),
    lastCopied: r.last_copied, lastSuccessAt: toIso(r.last_success_at), lastError: r.last_error, skippedReason: r.skipped_reason,
  })));
}));

router.get('/events', h(async (req, res) => {
  const q = dst()('__mon_events').orderBy('id', 'desc').limit(clampInt(req.query.limit, 100, 1, 500));
  if (['info', 'warn', 'error'].includes(String(req.query.level))) q.where('level', String(req.query.level));
  const rows = await q;
  res.json(rows.map((r: any) => ({ id: Number(r.id), at: toIso(r.at), level: r.level, type: r.type, subject: r.subject, message: r.message })));
}));

// Manual "run now" button. SameSite=Strict cookie + a custom header keep it away from cross-site forms.
router.post('/run', h(async (req, res) => {
  if (req.headers['x-requested-with'] !== 'dashboard') return res.status(400).json({ ok: false, error: 'bad request' });
  runCycle('manual').catch((err) => console.error('[manual cycle]', err.message));
  res.status(202).json({ ok: true });
}));

router.post('/refresh-endpoints', h(async (req, res) => {
  if (req.headers['x-requested-with'] !== 'dashboard') return res.status(400).json({ ok: false, error: 'bad request' });
  const defs = await getEndpoints(true);
  res.json({ ok: true, endpoints: defs.length });
}));

export default router;
