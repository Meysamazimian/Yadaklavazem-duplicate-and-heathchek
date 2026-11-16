// Health monitor against a fake backend; results are stored in the CI replica database.
//   npm test   (needs SRC_DB_* / DST_DB_*, see .github/workflows/ci.yml)
import { hasDb, skipWithoutDb, ensureMetaSafely } from './helpers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// The fake backend's port is only known after it starts, so config is loaded inside before().
const endpointsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dup-monitor-')), 'endpoints.json');
const P = '/dup-monitor-test';
fs.writeFileSync(
  endpointsFile,
  JSON.stringify([
    { path: `${P}/ok`, expect: '200' },
    { path: `${P}/protected` }, // default expectation "<500": a 401 means the route is alive
    { path: `${P}/broken` },
    { path: `${P}/slow` },
    { path: `${P}/flaky` },
  ])
);

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

let flakyStatus = 500;
const server = http.createServer((req, res) => {
  const url = req.url || '/';
  if (url === `${P}/ok`) return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  if (url === `${P}/protected`) return void res.writeHead(401).end();
  if (url === `${P}/broken`) return void res.writeHead(500).end();
  if (url === `${P}/slow`) return void setTimeout(() => res.writeHead(200).end(), 2_000);
  if (url === `${P}/flaky`) return void res.writeHead(flakyStatus).end();
  res.writeHead(404).end();
});

let mod: {
  dst: typeof import('../src/db')['dst'];
  closeDbs: typeof import('../src/db')['closeDbs'];
  runHealthChecks: typeof import('../src/monitor')['runHealthChecks'];
};

const keys = ['ok', 'protected', 'broken', 'slow', 'flaky'].map((k) => `GET ${P}/${k}`);
const endpoint = (name: string) => mod.dst()('__mon_endpoints').where({ endpoint_key: `GET ${P}/${name}` }).first();
const events = (name: string) => mod.dst()('__mon_events').where({ subject: `GET ${P}/${name}` }).orderBy('id').select('type');

async function cleanup() {
  await mod.dst()('__mon_endpoints').whereIn('endpoint_key', keys).delete();
  await mod.dst()('__mon_checks').whereIn('endpoint_key', keys).delete();
  await mod.dst()('__mon_events').whereIn('subject', keys).delete();
}

before(async () => {
  if (!hasDb) return;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  process.env.BACKEND_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.BACKEND_SWAGGER_PATH = '/no-specs-here';
  process.env.ENDPOINTS_FILE = endpointsFile;
  process.env.REQUEST_TIMEOUT_MS = '300';
  process.env.FAIL_THRESHOLD = '2';
  /* eslint-disable @typescript-eslint/no-var-requires */
  const db = require('../src/db') as typeof import('../src/db');
  const monitor = require('../src/monitor') as typeof import('../src/monitor');
  /* eslint-enable @typescript-eslint/no-var-requires */
  mod = { dst: db.dst, closeDbs: db.closeDbs, runHealthChecks: monitor.runHealthChecks };
  await ensureMetaSafely();
  await cleanup();
  await mod.runHealthChecks();
});

after(async () => {
  server.close();
  if (!hasDb) return;
  await cleanup();
  await mod.closeDbs();
});

test('a 200 answer is healthy', { skip: skipWithoutDb }, async () => {
  const e = await endpoint('ok');
  assert.equal(Boolean(e.last_ok), true);
  assert.equal(e.last_status, 200);
  assert.equal(e.consecutive_failures, 0);
});

test('a 401 on a protected route counts as healthy', { skip: skipWithoutDb }, async () => {
  const e = await endpoint('protected');
  assert.equal(Boolean(e.last_ok), true);
  assert.equal(e.last_status, 401);
});

test('a 500 answer is unhealthy', { skip: skipWithoutDb }, async () => {
  const e = await endpoint('broken');
  assert.equal(Boolean(e.last_ok), false);
  assert.equal(e.last_status, 500);
  assert.match(String(e.last_error), /status 500/);
});

test('a timeout is unhealthy', { skip: skipWithoutDb }, async () => {
  const e = await endpoint('slow');
  assert.equal(Boolean(e.last_ok), false);
  assert.equal(e.last_status, null);
  assert.match(String(e.last_error), /timeout after 300ms/);
});

test('after FAIL_THRESHOLD failures the endpoint goes down, then comes back up', { skip: skipWithoutDb }, async () => {
  // One failure so far (from before()): below the threshold of 2, not down yet.
  let e = await endpoint('flaky');
  assert.equal(e.consecutive_failures, 1);
  assert.equal(Boolean(e.is_down), false);
  assert.deepEqual(await events('flaky'), []);

  await mod.runHealthChecks();
  e = await endpoint('flaky');
  assert.equal(e.consecutive_failures, 2);
  assert.equal(Boolean(e.is_down), true);
  assert.deepEqual((await events('flaky')).map((r: { type: string }) => r.type), ['endpoint_down']);

  flakyStatus = 200;
  await mod.runHealthChecks();
  e = await endpoint('flaky');
  assert.equal(e.consecutive_failures, 0);
  assert.equal(Boolean(e.is_down), false);
  assert.deepEqual((await events('flaky')).map((r: { type: string }) => r.type), ['endpoint_down', 'endpoint_up']);
});
