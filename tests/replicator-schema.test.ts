// Additive schema sync against the CI databases: new columns, wider enums, tables without a primary key.
//   npm test   (needs SRC_DB_* / DST_DB_*, see .github/workflows/ci.yml)
import { hasDb, skipWithoutDb, ensureMetaSafely } from './helpers';

const TABLE = 'dup_test_schema';
const NO_PK = 'dup_test_no_pk';
process.env.REPLICATE_INCLUDE = `${TABLE},${NO_PK}`;

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { src, dst, closeDbs } = require('../src/db') as typeof import('../src/db');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runReplication } = require('../src/replicator') as typeof import('../src/replicator');

async function dropTables() {
  for (const t of [TABLE, NO_PK]) {
    await src().schema.dropTableIfExists(t);
    await dst().schema.dropTableIfExists(t);
    await dst()('__dup_tables').where({ table_name: t }).delete().catch(() => undefined);
  }
}

async function replicaColumnType(column: string): Promise<string | undefined> {
  const rows = (
    await dst().raw(
      'SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      [process.env.DST_DB_NAME, TABLE, column]
    )
  )[0] as Array<{ t: string }>;
  return rows[0]?.t;
}

before(async () => {
  if (!hasDb) return;
  await ensureMetaSafely();
  await dropTables();
  await src().raw(`CREATE TABLE \`${TABLE}\` (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, status ENUM('new','paid') NOT NULL)`);
  await src()(TABLE).insert({ status: 'new' });
  await src().raw(`CREATE TABLE \`${NO_PK}\` (code VARCHAR(20) NOT NULL, qty INT NOT NULL)`);
  await src()(NO_PK).insert({ code: 'x', qty: 1 });
  await runReplication('test');
});

after(async () => {
  if (!hasDb) return;
  await dropTables();
  await closeDbs();
});

test('a new source column is added to the replica', { skip: skipWithoutDb }, async () => {
  assert.equal(await replicaColumnType('note'), undefined);
  await src().raw(`ALTER TABLE \`${TABLE}\` ADD COLUMN note VARCHAR(100) NULL`);
  await src()(TABLE).insert({ status: 'paid', note: 'hello' });
  const res = await runReplication('test');
  assert.equal(res.status, 'ok');
  assert.equal(await replicaColumnType('note'), 'varchar(100)');
  const row = await dst()(TABLE).where({ status: 'paid' }).first('note');
  assert.equal(row.note, 'hello');
});

test('an enum only ever grows in the replica', { skip: skipWithoutDb }, async () => {
  await src().raw(`ALTER TABLE \`${TABLE}\` MODIFY COLUMN status ENUM('new','paid','refunded') NOT NULL`);
  await src()(TABLE).insert({ status: 'refunded' });
  await runReplication('test');
  assert.equal(await replicaColumnType('status'), "enum('new','paid','refunded')");
  assert.ok(await dst()(TABLE).where({ status: 'refunded' }).first());

  // Narrowing the source back never narrows the replica.
  await src()(TABLE).where({ status: 'refunded' }).update({ status: 'paid' });
  await src().raw(`ALTER TABLE \`${TABLE}\` MODIFY COLUMN status ENUM('new','paid') NOT NULL`);
  await runReplication('test');
  assert.equal(await replicaColumnType('status'), "enum('new','paid','refunded')");
});

test('a table without a primary key is marked skipped, not copied', { skip: skipWithoutDb }, async () => {
  const state = await dst()('__dup_tables').where({ table_name: NO_PK }).first('skipped_reason', 'total_copied');
  assert.match(String(state?.skipped_reason), /no primary key/);
  assert.equal(Number(state.total_copied), 0);
  assert.equal(await dst().schema.hasTable(NO_PK), false);
});
