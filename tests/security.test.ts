// Dashboard hardening (DPL-01 to DPL-04). No database: only the HTTP layer, the config check and the table filter.
process.env.DASHBOARD_PASSWORD = 'dashboard-password-for-tests';
process.env.SESSION_SECRET = 's'.repeat(40);
process.env.CRON_KEY = 'k'.repeat(40);
process.env.ENABLE_SCHEDULER = 'false';
process.env.REPLICATE_EXCLUDE = '';

import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'net';
import { config, DEFAULT_REPLICATE_EXCLUDE, validateConfig } from '../src/config';
import { createApp, CSP } from '../src/app';
import { resetLoginLimits } from '../src/auth';
import { tablesToCopy } from '../src/replicator';

async function withServer(fn: (base: string) => Promise<void>) {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const login = (base: string, password: string) =>
  fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }),
  });

test('DPL-01: a short password, a missing or short session secret, or a short cron key stop the app', () => {
  const ok = { dashboardPassword: 'p'.repeat(12), sessionSecret: 's'.repeat(32), cronKey: '' };
  assert.deepEqual(validateConfig(ok).filter((p) => !p.includes('DB_')), []);
  const cases: [Partial<typeof ok>, string][] = [
    [{ dashboardPassword: '' }, 'DASHBOARD_PASSWORD'],
    [{ dashboardPassword: 'p'.repeat(11) }, 'DASHBOARD_PASSWORD'],
    [{ sessionSecret: '' }, 'SESSION_SECRET'],
    [{ sessionSecret: 's'.repeat(31) }, 'SESSION_SECRET'],
    [{ cronKey: 'short' }, 'CRON_KEY'],
  ];
  for (const [over, name] of cases) {
    const problems = validateConfig({ ...ok, ...over });
    assert.ok(problems.some((p) => p.startsWith(name)), `${JSON.stringify(over)} -> ${problems.join(' | ')}`);
  }
});

test('DPL-02: /cron/run takes the key only from the header', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/cron/run?key=${config.cronKey}`)).status, 404);
    assert.equal((await fetch(`${base}/cron/run?key=${config.cronKey}`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${base}/cron/run`, { headers: { 'x-cron-key': 'k'.repeat(39) + 'x' } })).status, 404);
  });
});

test('DPL-03: sensitive tables are not copied by default', () => {
  assert.deepEqual(config.replicate.exclude, DEFAULT_REPLICATE_EXCLUDE);
  const source = ['products', 'orders', 'refresh_tokens', 'otp_codes', 'rate_limits', 'idempotency_keys', 'cache', 'jobs', '__mon_runs'];
  assert.deepEqual(tablesToCopy(source), ['products', 'orders']);
  // The env still decides when the owner sets it.
  assert.deepEqual(tablesToCopy(source, { include: [], exclude: ['orders'] }), source.filter((t) => t !== 'orders' && !t.startsWith('__')));
});

test('DPL-04: every answer carries the CSP header', async () => {
  await withServer(async (base) => {
    for (const p of ['/healthz', '/', '/api/anything', '/session', '/nope', '/cron/run']) {
      const res = await fetch(base + p);
      assert.equal(res.headers.get('content-security-policy'), CSP, p);
    }
    assert.equal((await login(base, 'wrong')).headers.get('content-security-policy'), CSP);
  });
  assert.match(CSP, /script-src 'self'(;|$)/);
  assert.match(CSP, /frame-ancestors 'none'/);
});

test('DPL-04: 20 failed logins from many addresses lock the login for everyone, even with the right password', async () => {
  resetLoginLimits();
  // Each request comes from another address (trusted proxy on loopback), so the per-IP limit never triggers.
  await withServer(async (base) => {
    const from = (i: number, password: string) =>
      fetch(`${base}/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': `10.0.${Math.floor(i / 250)}.${(i % 250) + 1}` },
        body: new URLSearchParams({ password }),
      });
    assert.equal((await from(0, config.dashboardPassword)).status, 303, 'the right password works before the lock');
    for (let i = 1; i <= 19; i++) assert.equal((await from(i, 'wrong')).status, 401, `attempt ${i}`);
    assert.equal((await from(100, config.dashboardPassword)).status, 303, '19 failures do not lock yet');
    assert.equal((await from(20, 'wrong')).status, 401);
    assert.equal((await from(101, config.dashboardPassword)).status, 429, 'locked for everyone after 20');
  });
  resetLoginLimits();
});

test('the per-IP limit still blocks one address after 5 failures', async () => {
  resetLoginLimits();
  await withServer(async (base) => {
    for (let i = 0; i < 5; i++) assert.equal((await login(base, 'wrong')).status, 401);
    assert.equal((await login(base, config.dashboardPassword)).status, 429);
  });
  resetLoginLimits();
});
