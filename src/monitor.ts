import fs from 'fs';
import { config } from './config';
import { dst } from './db';
import { addEvent, getState, setState } from './meta';
import { statusMatches } from './expect';

export interface EndpointDef {
  key: string;
  method: string;
  path: string;
  origin: 'discovered' | 'configured';
  audience: string | null;
  auth: string | null;
  expected: string;
  headers?: Record<string, string>;
  body?: unknown;
  bodyContains?: string;
}

const AUDIENCES = ['storefront', 'admin', 'admin-sales', 'platform'];
const AUTH_SCHEMES: Record<string, string> = { platformAuth: 'platform', staffAuth: 'staff', customerAuth: 'customer', botAuth: 'bot' };

/** Always checked, with a strict expectation. */
const BUILT_IN: EndpointDef[] = [
  { key: 'GET /health', method: 'GET', path: '/health', origin: 'configured', audience: null, auth: 'none', expected: '200', bodyContains: '"ok":true' },
  { key: 'GET /api/health', method: 'GET', path: '/api/health', origin: 'configured', audience: null, auth: 'none', expected: '200', bodyContains: '"ok":true' },
  { key: 'GET /', method: 'GET', path: '/', origin: 'configured', audience: null, auth: 'none', expected: '200' },
];

const fetchWithTimeout = async (url: string, init: RequestInit, timeoutMs: number): Promise<Response> => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, redirect: 'manual' });
  } finally {
    clearTimeout(timer);
  }
};

/** Reads the Backend's own OpenAPI specs and returns every parameter-less GET route. */
async function discover(): Promise<EndpointDef[]> {
  const { backendUrl, swaggerPath, exclude, timeoutMs } = config.monitor;
  const excluder = exclude ? new RegExp(exclude) : null;
  const found = new Map<string, EndpointDef>();
  let okSpecs = 0;

  for (const audience of AUDIENCES) {
    try {
      const res = await fetchWithTimeout(`${backendUrl}${swaggerPath}/spec/${audience}.json`, {}, timeoutMs);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const spec: any = await res.json();
      okSpecs++;
      for (const [path, ops] of Object.entries<any>(spec.paths || {})) {
        if (!ops.get || path.includes('{')) continue;
        if (excluder && excluder.test(path)) continue;
        const key = `GET ${path}`;
        if (found.has(key)) continue;
        const schemeNames = new Set<string>();
        for (const req of ops.get.security || []) Object.keys(req).forEach((s) => schemeNames.add(s));
        const auth = [...schemeNames].map((s) => AUTH_SCHEMES[s]).find(Boolean) || 'none';
        // Without credentials the right answer for protected routes is 401/403, so "anything but a 5xx" means alive.
        found.set(key, { key, method: 'GET', path, origin: 'discovered', audience, auth, expected: '<500' });
      }
    } catch (err) {
      await addEvent('warn', 'discovery_failed', audience, `Could not read ${audience} OpenAPI spec: ${(err as Error).message}`);
    }
  }
  return okSpecs > 0 ? [...found.values()] : [];
}

/** Extra endpoints / overrides from ENDPOINTS_FILE: [{ "path": "/api/x", "method": "GET", "expect": "200", ... }] */
export function loadConfiguredEndpoints(file: string): EndpointDef[] {
  if (!file) return [];
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(raw)) throw new Error('ENDPOINTS_FILE must contain a JSON array');
  return raw.map((e: any) => {
    const method = String(e.method || 'GET').toUpperCase();
    const path = String(e.path || '');
    if (!path.startsWith('/')) throw new Error(`ENDPOINTS_FILE: invalid path "${path}"`);
    return {
      key: `${method} ${path}`,
      method,
      path,
      origin: 'configured' as const,
      audience: null,
      auth: e.auth ?? null,
      expected: e.expect === undefined ? '<500' : Array.isArray(e.expect) ? e.expect.join(',') : String(e.expect),
      headers: e.headers,
      body: e.body,
      bodyContains: e.bodyContains,
    };
  });
}

let cache: { at: number; defs: EndpointDef[] } | null = null;

/** Built-in + discovered + configured (later ones override earlier ones with the same key). */
export async function getEndpoints(forceRefresh = false): Promise<EndpointDef[]> {
  const maxAge = config.monitor.discoveryRefreshMinutes * 60_000;
  if (cache && !forceRefresh && Date.now() - cache.at < maxAge) return cache.defs;

  let discovered = await discover();
  if (discovered.length === 0) {
    // Backend down or specs unreachable: keep checking what we knew about.
    const known = await dst()('__mon_endpoints').where({ active: true, origin: 'discovered' });
    discovered = known.map((r: any) => ({
      key: r.endpoint_key, method: r.method, path: r.path, origin: 'discovered' as const,
      audience: r.audience, auth: r.auth, expected: r.expected,
    }));
  }

  const merged = new Map<string, EndpointDef>();
  for (const d of [...discovered, ...BUILT_IN, ...loadConfiguredEndpoints(config.monitor.endpointsFile)]) merged.set(d.key, d);
  const defs = [...merged.values()];

  // Persist definitions, deactivate routes that disappeared from the specs.
  for (const d of defs) {
    await dst()('__mon_endpoints')
      .insert({ endpoint_key: d.key, method: d.method, path: d.path, origin: d.origin, audience: d.audience, auth: d.auth, expected: d.expected, active: true })
      .onConflict('endpoint_key')
      .merge(['method', 'path', 'origin', 'audience', 'auth', 'expected', 'active']);
  }
  await dst()('__mon_endpoints').whereNotIn('endpoint_key', defs.map((d) => d.key)).update({ active: false });

  cache = { at: Date.now(), defs };
  return defs;
}

interface CheckOutcome {
  def: EndpointDef;
  status: number | null;
  ok: boolean;
  latencyMs: number;
  error: string | null;
}

async function checkOne(def: EndpointDef): Promise<CheckOutcome> {
  const { backendUrl, internalToken, shopHost, timeoutMs } = config.monitor;
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'yadaklavazem-healthcheck/1.0' };
  if (internalToken) headers['x-internal-token'] = internalToken;
  if (shopHost) headers['x-forwarded-host'] = shopHost;
  Object.assign(headers, def.headers || {});
  const init: RequestInit = { method: def.method, headers };
  if (def.body !== undefined) {
    init.body = typeof def.body === 'string' ? def.body : JSON.stringify(def.body);
    if (!headers['content-type']) headers['content-type'] = 'application/json';
  }

  const t0 = performance.now();
  try {
    const res = await fetchWithTimeout(backendUrl + def.path, init, timeoutMs);
    const text = await res.text();
    const latencyMs = Math.round(performance.now() - t0);
    let ok = statusMatches(def.expected, res.status);
    let error: string | null = ok ? null : `status ${res.status}, expected ${def.expected}`;
    if (ok && def.bodyContains && !text.replace(/\s/g, '').includes(def.bodyContains.replace(/\s/g, ''))) {
      ok = false;
      error = `body does not contain ${def.bodyContains}`;
    }
    return { def, status: res.status, ok, latencyMs, error };
  } catch (err) {
    const e = err as Error;
    const aborted = e.name === 'AbortError';
    return {
      def, status: null, ok: false, latencyMs: Math.round(performance.now() - t0),
      error: aborted ? `timeout after ${timeoutMs}ms` : String((e as any).cause?.code || e.message).slice(0, 300),
    };
  }
}

export interface MonitorResult {
  total: number;
  ok: number;
  failed: number;
}

export async function runHealthChecks(): Promise<MonitorResult> {
  const defs = await getEndpoints();
  const outcomes: CheckOutcome[] = [];
  let next = 0;
  const worker = async () => {
    while (next < defs.length) outcomes.push(await checkOne(defs[next++]));
  };
  await Promise.all(Array.from({ length: Math.min(config.monitor.concurrency, defs.length) }, worker));

  const now = new Date();
  const db = dst();
  for (let i = 0; i < outcomes.length; i += 200) {
    await db('__mon_checks').insert(
      outcomes.slice(i, i + 200).map((o) => ({
        endpoint_key: o.def.key, status_code: o.status, ok: o.ok, latency_ms: o.latencyMs, error: o.error, checked_at: now,
      }))
    );
  }

  const prevRows = await db('__mon_endpoints').whereIn('endpoint_key', outcomes.map((o) => o.def.key));
  const prev = new Map<string, any>(prevRows.map((r: any) => [r.endpoint_key, r]));

  for (const o of outcomes) {
    const p = prev.get(o.def.key);
    const failures = o.ok ? 0 : (p?.consecutive_failures ?? 0) + 1;
    const wasDown = Boolean(p?.is_down);
    const isDown = o.ok ? false : failures >= config.monitor.failThreshold ? true : wasDown;
    const stateChanged = p?.last_ok === null || p?.last_ok === undefined || Boolean(p.last_ok) !== o.ok;

    await db('__mon_endpoints').where({ endpoint_key: o.def.key }).update({
      consecutive_failures: failures,
      is_down: isDown,
      last_status: o.status,
      last_ok: o.ok,
      last_latency_ms: o.latencyMs,
      last_error: o.error,
      last_checked_at: now,
      ...(stateChanged ? { state_since: now } : {}),
    });

    if (isDown && !wasDown) await addEvent('error', 'endpoint_down', o.def.key, o.error || 'down');
    if (!isDown && wasDown) await addEvent('info', 'endpoint_up', o.def.key, `Recovered (status ${o.status}, ${o.latencyMs}ms)`);
  }

  const okCount = outcomes.filter((o) => o.ok).length;
  return { total: outcomes.length, ok: okCount, failed: outcomes.length - okCount };
}

/** Deletes monitoring history past the retention window. Only this app's own tables; copied data is never touched. */
export async function pruneHistory(): Promise<void> {
  const last = await getState('last_prune');
  if (last && Date.now() - Number(last) < 6 * 3600_000) return;
  const cutoff = new Date(Date.now() - config.retentionDays * 86400_000);
  const db = dst();
  await db('__mon_checks').where('checked_at', '<', cutoff).delete();
  await db('__dup_run_tables').whereIn('run_id', db('__dup_runs').where('started_at', '<', cutoff).select('id')).delete();
  await db('__dup_runs').where('started_at', '<', cutoff).delete();
  await db('__mon_events').where('at', '<', new Date(Date.now() - Math.max(config.retentionDays, 90) * 86400_000)).delete();
  await setState('last_prune', String(Date.now()));
}
