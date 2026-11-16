// The dashboard app over HTTP: login, the protected API and the cron trigger.
//   npm test   (needs SRC_DB_* / DST_DB_*, see .github/workflows/ci.yml)
import { hasDb, skipWithoutDb, ensureMetaSafely } from './helpers';

const PASSWORD = 'correct-horse-battery';
const CRON_KEY = 'cron-key-for-tests';
process.env.DASHBOARD_PASSWORD = PASSWORD;
process.env.CRON_KEY = CRON_KEY;
process.env.COOKIE_SECURE = 'false';
// A cron-started cycle must not copy or probe anything real.
process.env.REPLICATE_INCLUDE = 'dup_test_app_no_such_table';
process.env.BACKEND_URL = 'http://127.0.0.1:9';
process.env.BACKEND_SWAGGER_PATH = '/none';
process.env.REQUEST_TIMEOUT_MS = '300';

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/* eslint-disable @typescript-eslint/no-var-requires */
const { createApp } = require('../src/app') as typeof import('../src/app');
const { closeDbs } = require('../src/db') as typeof import('../src/db');
/* eslint-enable @typescript-eslint/no-var-requires */

let server: Server;
let base: string;

before(async () => {
  if (hasDb) await ensureMetaSafely();
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  // Let a cycle started by /cron/run finish before the pools close.
  await new Promise((r) => setTimeout(r, 1_500));
  await closeDbs();
});

const login = (password: string) =>
  fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }).toString(),
    redirect: 'manual',
  });

test('login with the right password sets a session cookie', async () => {
  const res = await login(PASSWORD);
  assert.equal(res.status, 303);
  const cookie = res.headers.get('set-cookie') || '';
  assert.match(cookie, /dm_session=/);
  assert.match(cookie, /HttpOnly/i);

  const session = await fetch(`${base}/session`, { headers: { cookie: cookie.split(';')[0] } });
  assert.deepEqual(await session.json(), { authenticated: true });
});

test('login with a wrong password is refused', async () => {
  const res = await login('wrong-password');
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('set-cookie'), null);
});

test('/api/summary without a session is refused', async () => {
  const res = await fetch(`${base}/api/summary`);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { ok: false, error: 'unauthenticated' });
});

test('/cron/run with the right key answers 202', { skip: skipWithoutDb }, async () => {
  const res = await fetch(`${base}/cron/run?key=${CRON_KEY}`);
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { ok: true, accepted: true });
});

test('/cron/run with a wrong or missing key is refused', async () => {
  assert.equal((await fetch(`${base}/cron/run?key=nope`)).status, 404);
  assert.equal((await fetch(`${base}/cron/run`)).status, 404);
  assert.equal((await fetch(`${base}/cron/run`, { method: 'POST', headers: { 'x-cron-key': 'nope' } })).status, 404);
});
