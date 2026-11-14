import test from 'node:test';
import assert from 'node:assert/strict';
import { needsWidening, sanitizeCreateTable, isGeneratedColumn } from '../src/ddl';
import { statusMatches } from '../src/expect';

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
