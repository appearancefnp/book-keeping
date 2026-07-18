import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { checkLoginAllowed, recordLoginFailure, clearLoginFailures } from '../../src/auth/rate-limit.js';

const NOW = 1_700_000_000;

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('allows up to 5 failures, blocks the 6th attempt in the window', async () => {
  const ids = ['email:a@t.lv'];
  for (let i = 0; i < 5; i++) {
    expect(await checkLoginAllowed(ids, NOW)).toBe(true);
    await recordLoginFailure(ids, NOW);
  }
  expect(await checkLoginAllowed(ids, NOW)).toBe(false);
});

test('window expiry unblocks; failure after expiry starts a fresh window', async () => {
  const ids = ['email:b@t.lv'];
  for (let i = 0; i < 5; i++) await recordLoginFailure(ids, NOW);
  expect(await checkLoginAllowed(ids, NOW + 899)).toBe(false);
  expect(await checkLoginAllowed(ids, NOW + 901)).toBe(true);
  await recordLoginFailure(ids, NOW + 901);
  expect(await checkLoginAllowed(ids, NOW + 901)).toBe(true); // count restarted at 1
});

test('success clears; identifiers are independent but ANY blocked identifier blocks', async () => {
  const ids = ['email:c@t.lv', 'ip:1.2.3.4'];
  for (let i = 0; i < 5; i++) await recordLoginFailure(ids, NOW);
  expect(await checkLoginAllowed(['email:c@t.lv'], NOW)).toBe(false);
  expect(await checkLoginAllowed(['ip:1.2.3.4'], NOW)).toBe(false);
  expect(await checkLoginAllowed(['email:other@t.lv', 'ip:9.9.9.9'], NOW)).toBe(true);
  await clearLoginFailures(ids);
  expect(await checkLoginAllowed(ids, NOW)).toBe(true);
});
