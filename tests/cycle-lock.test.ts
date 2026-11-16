// The cycle lock: two cycles at the same time never both run.
//   npm test   (needs SRC_DB_* / DST_DB_*, see .github/workflows/ci.yml)
import { hasDb, skipWithoutDb, ensureMetaSafely } from './helpers';

// Nothing to replicate and nothing to monitor: this test is only about the lock.
process.env.REPLICATE_INCLUDE = 'dup_test_cycle_no_such_table';
process.env.BACKEND_URL = 'http://127.0.0.1:9';
process.env.BACKEND_SWAGGER_PATH = '/none';
process.env.REQUEST_TIMEOUT_MS = '500';

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { dst, closeDbs } = require('../src/db') as typeof import('../src/db');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runCycle } = require('../src/cycle') as typeof import('../src/cycle');

before(async () => {
  if (!hasDb) return;
  await ensureMetaSafely();
  await dst()('__mon_lock').where({ name: 'cycle' }).delete();
});

after(async () => {
  if (!hasDb) return;
  await dst()('__mon_lock').where({ name: 'cycle' }).delete();
  await closeDbs();
});

test('two concurrent cycles: only one runs', { skip: skipWithoutDb }, async () => {
  // Same process: the second call is refused while the first is running.
  const [a, b] = await Promise.all([runCycle('test'), runCycle('test')]);
  assert.deepEqual([a.started, b.started].sort(), [false, true]);
  assert.match(String((a.started ? b : a).reason), /already running/);

  // Another process holding the database lock: a cycle here is refused too.
  await dst()('__mon_lock')
    .where({ name: 'cycle' })
    .update({ locked_until: new Date(Date.now() + 60_000), holder: 'other-host-1' });
  const blocked = await runCycle('test');
  assert.equal(blocked.started, false);
  assert.match(String(blocked.reason), /lock held/);

  // Once the other holder's lock has expired, the next cycle runs.
  await dst()('__mon_lock').where({ name: 'cycle' }).update({ locked_until: new Date(Date.now() - 1000) });
  assert.equal((await runCycle('test')).started, true);
});
