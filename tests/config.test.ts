// validateConfig rules. src/config.ts reads the environment when it is loaded, so each case loads it fresh.
import test from 'node:test';
import assert from 'node:assert/strict';

const KEYS = [
  'SRC_DB_HOST', 'SRC_DB_PORT', 'SRC_DB_USER', 'SRC_DB_PASSWORD', 'SRC_DB_NAME',
  'DST_DB_HOST', 'DST_DB_PORT', 'DST_DB_USER', 'DST_DB_PASSWORD', 'DST_DB_NAME',
  'DASHBOARD_PASSWORD',
];

const good: Record<string, string> = {
  SRC_DB_HOST: '127.0.0.1',
  SRC_DB_PORT: '3306',
  SRC_DB_USER: 'main_user',
  SRC_DB_NAME: 'yadak_main',
  DST_DB_NAME: 'yadak_replica',
  DASHBOARD_PASSWORD: 'secret',
};

function problemsWith(env: Record<string, string>): string[] {
  const saved = new Map(KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, env);
    const file = require.resolve('../src/config');
    delete require.cache[file];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require(file) as typeof import('../src/config')).validateConfig();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('the same database as source and replica is refused', () => {
  const problems = problemsWith({ ...good, DST_DB_NAME: good.SRC_DB_NAME });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /DST_DB_NAME must be a different database/);

  // Same name on another server is fine: it is a different database.
  assert.deepEqual(problemsWith({ ...good, DST_DB_NAME: good.SRC_DB_NAME, DST_DB_HOST: 'replica.example' }), []);
});

test('an empty DASHBOARD_PASSWORD is refused', () => {
  assert.deepEqual(problemsWith({ ...good, DASHBOARD_PASSWORD: '' }), ['DASHBOARD_PASSWORD is required']);
  assert.deepEqual(problemsWith({ ...good, DASHBOARD_PASSWORD: '   ' }), ['DASHBOARD_PASSWORD is required']);
});

test('a correct configuration is accepted', () => {
  assert.deepEqual(problemsWith(good), []);
});
