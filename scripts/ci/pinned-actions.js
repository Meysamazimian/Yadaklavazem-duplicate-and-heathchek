#!/usr/bin/env node
// Fails when a workflow uses an action by tag or branch instead of a full commit sha, or has no top-level
// `permissions`. A tag can be moved to other code by whoever owns the action; a 40-character sha cannot.
//   node scripts/ci/pinned-actions.js [workflows directory]
'use strict';
const fs = require('fs');
const path = require('path');

const USES = /^\s*(?:-\s*)?uses:\s*([^\s#]+)/;
const FULL_SHA = /@[0-9a-f]{40}$/;

/** Problems of one workflow file's text, as lines. */
function problemsOf(name, text) {
  const problems = [];
  text.split('\n').forEach((line, index) => {
    const match = line.match(USES);
    if (!match) return;
    const target = match[1].replace(/^['"]|['"]$/g, '');
    // A local action (./path) is part of this repository's own commit.
    if (target.startsWith('./')) return;
    if (!FULL_SHA.test(target)) problems.push(`${name}:${index + 1}: "${target}" is not pinned to a full commit sha`);
  });
  if (!/^permissions:/m.test(text)) problems.push(`${name}: no top-level "permissions:"`);
  return problems;
}

function main(dir) {
  const files = fs.readdirSync(dir).filter((file) => /\.ya?ml$/.test(file));
  const problems = files.flatMap((file) => problemsOf(file, fs.readFileSync(path.join(dir, file), 'utf8')));
  if (problems.length) {
    console.log(problems.join('\n'));
    console.log(`::error::${problems.length} workflow problem(s): pin every action to a commit sha and declare permissions.`);
    return 1;
  }
  console.log(`${files.length} workflow file(s): every action is pinned to a commit sha and permissions are declared.`);
  return 0;
}

module.exports = { problemsOf };
if (require.main === module) process.exit(main(process.argv[2] || path.join(process.cwd(), '.github', 'workflows')));
