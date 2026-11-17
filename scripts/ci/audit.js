#!/usr/bin/env node
// Dependency gate: fails when `npm audit --omit=dev` reports a high or critical advisory that is not on the dated
// allowlist. No dependencies; the same file is used in every Yadaklavazem repository.
//   node scripts/ci/audit.js                     runs npm audit
//   node scripts/ci/audit.js --report file.json  reads a saved `npm audit --json` report instead (tests)
// Allowlist: security/audit-allowlist.json = [{ "id": "GHSA-...", "reason": "...", "expires": "YYYY-MM-DD" }].
// An entry with no reason, a bad date, a date that has passed or a deadline further than 90 days away is itself
// a failure, so an exception can never quietly become permanent.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BLOCKING = new Set(['high', 'critical']);
const MAX_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const GHSA = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i;

/** The advisories of one `npm audit --json` report: [{ id, severity, package, title }], one row per advisory. */
function advisoriesOf(report) {
  const found = new Map();
  for (const [name, entry] of Object.entries(report.vulnerabilities || {})) {
    for (const via of entry.via || []) {
      // A string means "through another package"; that package has its own entry with the advisory itself.
      if (typeof via !== 'object' || via === null) continue;
      const id = (String(via.url || '').match(GHSA) || [String(via.source || via.title || name)])[0].toUpperCase();
      const key = `${id}|${via.name || name}`;
      if (!found.has(key)) found.set(key, { id, severity: String(via.severity || entry.severity || 'unknown'), package: via.name || name, title: String(via.title || '') });
    }
  }
  return [...found.values()];
}

/** Problems with the allowlist itself, as text lines. */
function allowlistProblems(allowlist, today) {
  if (!Array.isArray(allowlist)) return ['the allowlist must be a JSON array'];
  const problems = [];
  for (const [index, entry] of allowlist.entries()) {
    const label = entry && entry.id ? entry.id : `entry ${index + 1}`;
    if (!entry || typeof entry.id !== 'string' || !GHSA.test(entry.id)) problems.push(`${label}: "id" must be a GHSA id`);
    if (!entry || typeof entry.reason !== 'string' || entry.reason.trim().length < 10) problems.push(`${label}: "reason" is missing or too short`);
    const expires = entry && typeof entry.expires === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.expires) ? Date.parse(`${entry.expires}T23:59:59Z`) : NaN;
    if (Number.isNaN(expires)) problems.push(`${label}: "expires" must be YYYY-MM-DD`);
    else if (expires < today.getTime()) problems.push(`${label}: expired on ${entry.expires}; fix the dependency or renew with a reason`);
    else if (expires - today.getTime() > MAX_DAYS * DAY_MS) problems.push(`${label}: "expires" is more than ${MAX_DAYS} days away`);
  }
  return problems;
}

/**
 * The verdict for one report. `blocking` = high/critical advisories not excused; `excused` = those on the allowlist;
 * `problems` = what is wrong with the allowlist. The gate passes only when blocking and problems are both empty.
 */
function evaluate(report, allowlist, today = new Date()) {
  const problems = allowlistProblems(allowlist, today);
  const allowed = new Set((Array.isArray(allowlist) ? allowlist : []).map((entry) => String((entry && entry.id) || '').toUpperCase()));
  const serious = advisoriesOf(report).filter((advisory) => BLOCKING.has(advisory.severity));
  return {
    blocking: serious.filter((advisory) => !allowed.has(advisory.id)),
    excused: serious.filter((advisory) => allowed.has(advisory.id)),
    problems,
  };
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function runAudit() {
  const result = spawnSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // npm exits non-zero when it finds anything; only unparsable output is an error here.
  try {
    const report = JSON.parse(result.stdout);
    if (report.error) throw new Error(report.error.summary || report.error.code || 'npm audit failed');
    return report;
  } catch (error) {
    console.error(`npm audit did not return a report: ${error.message}`);
    console.error(String(result.stderr || '').slice(0, 2000));
    process.exit(2);
  }
}

function main(argv) {
  const reportFlag = argv.indexOf('--report');
  const allowFlag = argv.indexOf('--allowlist');
  const report = reportFlag >= 0 ? readJson(argv[reportFlag + 1], null) : runAudit();
  if (!report) {
    console.error('report file not found');
    return 2;
  }
  const allowlistFile = allowFlag >= 0 ? argv[allowFlag + 1] : path.join(process.cwd(), 'security', 'audit-allowlist.json');
  const { blocking, excused, problems } = evaluate(report, readJson(allowlistFile, []));

  const row = (advisory) => `  ${advisory.severity.padEnd(8)} ${advisory.package.padEnd(28)} ${advisory.id}  ${advisory.title.slice(0, 80)}`;
  if (excused.length) console.log(`Excused by security/audit-allowlist.json (${excused.length}):\n${excused.map(row).join('\n')}`);
  if (problems.length) console.log(`Allowlist problems (${problems.length}):\n${problems.map((line) => `  ${line}`).join('\n')}`);
  if (blocking.length) console.log(`High or critical advisories without an exception (${blocking.length}):\n${blocking.map(row).join('\n')}`);

  if (blocking.length || problems.length) {
    console.log('::error::dependency audit failed: update the package, or add a dated exception with a reason.');
    return 1;
  }
  console.log('Dependency audit passed: no high or critical advisory outside the allowlist.');
  return 0;
}

module.exports = { advisoriesOf, allowlistProblems, evaluate };
if (require.main === module) process.exit(main(process.argv.slice(2)));
