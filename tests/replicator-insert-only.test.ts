// Insert-only replication against the CI databases: new rows are copied, edits and deletes are not.
//   npm test   (needs SRC_DB_* / DST_DB_*, see .github/workflows/ci.yml)
import { hasDb, skipWithoutDb, ensureMetaSafely } from './helpers';

const TABLE = 'dup_test_insert_only';
process.env.REPLICATE_INCLUDE = TABLE;

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { src, dst, closeDbs } = require('../src/db') as typeof import('../src/db');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runReplication } = require('../src/replicator') as typeof import('../src/replicator');

async function dropTables() {
  await src().schema.dropTableIfExists(TABLE);
  await dst().schema.dropTableIfExists(TABLE);
  await dst()('__dup_tables').where({ table_name: TABLE }).delete().catch(() => undefined);
}

before(async () => {
  if (!hasDb) return;
  await ensureMetaSafely();
  await dropTables();
  await src().schema.createTable(TABLE, (t) => {
    t.bigIncrements('id');
    t.string('name', 50).notNullable();
  });
  await src()(TABLE).insert([{ name: 'a' }, { name: 'b' }]);
  const first = await runReplication('test');
  assert.equal(first.status, 'ok');
});

after(async () => {
  if (!hasDb) return;
  await dropTables();
  await closeDbs();
});

const replica = () => dst()(TABLE).orderBy('id').select('id', 'name');

test('a new source row is copied to the replica', { skip: skipWithoutDb }, async () => {
  assert.deepEqual(await replica(), [
    { id: '1', name: 'a' },
    { id: '2', name: 'b' },
  ]);
  await src()(TABLE).insert({ name: 'c' });
  const res = await runReplication('test');
  assert.equal(res.status, 'ok');
  assert.deepEqual((await replica()).map((r) => r.name), ['a', 'b', 'c']);
});

test('an edited source row is not changed in the replica', { skip: skipWithoutDb }, async () => {
  await src()(TABLE).where({ id: 1 }).update({ name: 'a-edited' });
  await runReplication('test');
  const row = await dst()(TABLE).where({ id: 1 }).first('name');
  assert.equal(row.name, 'a');
});

test('a row deleted from the source stays in the replica', { skip: skipWithoutDb }, async () => {
  await src()(TABLE).where({ id: 2 }).delete();
  await runReplication('test');
  const row = await dst()(TABLE).where({ id: 2 }).first('name');
  assert.equal(row?.name, 'b');
});
