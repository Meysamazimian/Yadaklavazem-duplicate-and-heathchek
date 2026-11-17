process.env.DASHBOARD_PASSWORD = 'dashboard-password';
process.env.SESSION_SECRET = 'test-secret-'.padEnd(40, 'x');

import test from 'node:test';
import assert from 'node:assert/strict';
import { issueToken, safeEqual, verifyToken } from '../src/auth';

test('session tokens verify, expire and reject tampering', () => {
  const now = Date.now();
  const token = issueToken(now);
  assert.equal(verifyToken(token, now + 1000), true);
  assert.equal(verifyToken(token, now + 13 * 3600_000), false);
  const [exp, sig] = token.split('.');
  assert.equal(verifyToken(`${Number(exp) + 1}.${sig}`, now), false);
  assert.equal(verifyToken(undefined), false);
  assert.equal(verifyToken('garbage'), false);
});

test('safeEqual compares strings of different length without throwing', () => {
  assert.equal(safeEqual('a', 'abc'), false);
  assert.equal(safeEqual('same', 'same'), true);
});
