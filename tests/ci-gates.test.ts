// The CI gates themselves (DEP-04, DEP-12): the dependency audit verdict and the pinned-actions check. No database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const { evaluate, allowlistProblems } = require('../scripts/ci/audit.js');
const { problemsOf } = require('../scripts/ci/pinned-actions.js');

const TODAY = new Date('2026-11-17T12:00:00Z');
const advisory = (name: string, severity: string, ghsa: string) => ({
  vulnerabilities: {
    [name]: { name, severity, via: [{ source: 1, name, title: `${name} problem`, url: `https://github.com/advisories/${ghsa}`, severity }] },
    // A package that is only vulnerable through another one names it as a string; it adds no advisory of its own.
    wrapper: { name: 'wrapper', severity, via: [name] },
  },
});

test('audit: a high or critical advisory without an exception fails', () => {
  for (const severity of ['high', 'critical']) {
    const verdict = evaluate(advisory('lib', severity, 'GHSA-aaaa-bbbb-cccc'), [], TODAY);
    assert.equal(verdict.blocking.length, 1, severity);
    assert.equal(verdict.blocking[0].id, 'GHSA-AAAA-BBBB-CCCC');
  }
});

test('audit: moderate and low advisories do not block', () => {
  for (const severity of ['moderate', 'low']) {
    assert.equal(evaluate(advisory('lib', severity, 'GHSA-aaaa-bbbb-cccc'), [], TODAY).blocking.length, 0);
  }
});

test('audit: a valid dated exception lets the advisory pass', () => {
  const allow = [{ id: 'GHSA-aaaa-bbbb-cccc', reason: 'fix is DEP-06, not reachable', expires: '2026-12-15' }];
  const verdict = evaluate(advisory('lib', 'high', 'GHSA-aaaa-bbbb-cccc'), allow, TODAY);
  assert.deepEqual([verdict.blocking.length, verdict.excused.length, verdict.problems.length], [0, 1, 0]);
});

test('audit: an expired, undated, unexplained or too long exception is itself a failure', () => {
  const cases = [
    { id: 'GHSA-aaaa-bbbb-cccc', reason: 'fix is DEP-06, not reachable', expires: '2026-11-01' },
    { id: 'GHSA-aaaa-bbbb-cccc', reason: 'fix is DEP-06, not reachable' },
    { id: 'GHSA-aaaa-bbbb-cccc', reason: '', expires: '2026-12-15' },
    { id: 'GHSA-aaaa-bbbb-cccc', reason: 'fix is DEP-06, not reachable', expires: '2027-06-01' },
    { id: 'lib', reason: 'fix is DEP-06, not reachable', expires: '2026-12-15' },
  ];
  for (const entry of cases) assert.equal(allowlistProblems([entry], TODAY).length > 0, true, JSON.stringify(entry));
  assert.ok(allowlistProblems({}, TODAY).length > 0, 'not an array');
});

test('audit: the committed allowlist is valid today', () => {
  const file = path.join(__dirname, '..', 'security', 'audit-allowlist.json');
  assert.deepEqual(allowlistProblems(JSON.parse(fs.readFileSync(file, 'utf8')), new Date()), []);
});

test('workflows: a tag or branch instead of a full sha, or no permissions, is reported', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(problemsOf('ok.yml', `permissions:\n  contents: read\njobs:\n  x:\n    steps:\n      - uses: actions/checkout@${sha} # v4\n      - uses: ./local\n`), []);
  assert.equal(problemsOf('tag.yml', 'permissions: {}\n      - uses: actions/checkout@v4\n').length, 1);
  assert.equal(problemsOf('branch.yml', 'permissions: {}\n        uses: foo/bar@main\n').length, 1);
  assert.equal(problemsOf('short.yml', 'permissions: {}\n        uses: foo/bar@abc1234\n').length, 1);
  assert.equal(problemsOf('noperm.yml', `jobs:\n      - uses: foo/bar@${sha}\n`).length, 1);
});

test('workflows: the repository\'s own workflows pass the check', () => {
  const dir = path.join(__dirname, '..', '.github', 'workflows');
  const problems = fs.readdirSync(dir).filter((f) => f.endsWith('.yml')).flatMap((f) => problemsOf(f, fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.deepEqual(problems, []);
});
