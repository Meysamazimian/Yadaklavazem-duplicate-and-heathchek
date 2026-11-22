import test from 'node:test';
import assert from 'node:assert/strict';
import { needsWidening, sanitizeCreateTable, isGeneratedColumn } from '../src/ddl';
import { statusMatches } from '../src/expect';
import { createMockKnexPair } from '../src/mock-db';

test('sanitizeCreateTable drops foreign keys, auto_increment and fixes the trailing comma', () => {
  const ddl = [
    'CREATE TABLE `products` (',
    '  `id` bigint NOT NULL AUTO_INCREMENT,',
    '  `tenant_id` bigint NOT NULL,',
    '  PRIMARY KEY (`id`),',
    '  KEY `fk_t` (`tenant_id`),',
    '  CONSTRAINT `fk_t` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE CASCADE',
    ') ENGINE=InnoDB AUTO_INCREMENT=42 DEFAULT CHARSET=utf8mb4',
  ].join('\n');
  const out = sanitizeCreateTable(ddl);
  assert.match(out, /^CREATE TABLE IF NOT EXISTS `products`/);
  assert.doesNotMatch(out, /FOREIGN KEY/);
  assert.doesNotMatch(out, /AUTO_INCREMENT=42/);
  assert.match(out, /AUTO_INCREMENT,/); // the column attribute stays
  assert.match(out, /KEY `fk_t` \(`tenant_id`\)\n\)/); // no dangling comma
});

test('needsWidening only widens enum/set and longer varchar', () => {
  assert.equal(needsWidening('enum', "enum('a','b','c')", "enum('a','b')"), true);
  assert.equal(needsWidening('varchar', 'varchar(255)', 'varchar(100)'), true);
  assert.equal(needsWidening('varchar', 'varchar(50)', 'varchar(100)'), false);
  assert.equal(needsWidening('int', 'bigint', 'int'), false);
  assert.equal(needsWidening('enum', "enum('a')", "enum('a')"), false);
});

test('generated columns are detected, default expressions are not', () => {
  assert.equal(isGeneratedColumn('VIRTUAL GENERATED'), true);
  assert.equal(isGeneratedColumn('STORED GENERATED'), true);
  assert.equal(isGeneratedColumn('DEFAULT_GENERATED'), false);
  assert.equal(isGeneratedColumn('auto_increment'), false);
});

test('statusMatches understands lists, classes and < expressions', () => {
  assert.equal(statusMatches('200', 200), true);
  assert.equal(statusMatches('200,204', 204), true);
  assert.equal(statusMatches('2xx,3xx', 301), true);
  assert.equal(statusMatches('2xx', 404), false);
  assert.equal(statusMatches('<500', 401), true);
  assert.equal(statusMatches('<500', 502), false);
});

test('createMockKnexPair seeds source tables and supports insert ignore into replica', async () => {
  const { src, dst } = createMockKnexPair();
  const [srcTables] = await src.raw(
    `SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
    ['yadak_main']
  );
  assert.equal(srcTables.length >= 4, true);

  const [ddlRes] = await src.raw('SHOW CREATE TABLE `products`');
  await dst.raw(sanitizeCreateTable(ddlRes[0]['Create Table']));

  const rows = await src('products').select(src.raw('`id`, `sku`, `title`')).orderBy('id', 'asc').limit(5);
  assert.equal(rows.length, 5);

  const compiled = dst('products').insert(rows).onConflict().ignore().toSQL();
  const [res1] = await dst.raw(compiled.sql, compiled.bindings as any);
  assert.equal(res1.affectedRows, 5);

  // Duplicate insert ignore should insert 0 rows
  const [res2] = await dst.raw(compiled.sql, compiled.bindings as any);
  assert.equal(res2.affectedRows, 0);
});
