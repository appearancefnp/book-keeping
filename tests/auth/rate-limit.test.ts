import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { checkLoginAllowed, recordLoginFailure, clearLoginFailures } from '../../src/auth/rate-limit.js';
import { appPool } from '../../src/db/pool.js';

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

test('a failure at exactly the window edge (900s) starts a fresh window', async () => {
  const at = 1_750_000_000;
  const ids = ['email:edge@test.lv'];
  for (let i = 0; i < 5; i++) await recordLoginFailure(ids, at);
  expect(await checkLoginAllowed(ids, at)).toBe(false);
  // exactly WINDOW_SECONDS later the old window no longer blocks
  expect(await checkLoginAllowed(ids, at + 900)).toBe(true);
});

test('identifiers are isolated: locking one email does not lock another', async () => {
  const at = 1_750_000_000;
  for (let i = 0; i < 5; i++) await recordLoginFailure(['email:a@test.lv', 'ip:1.2.3.4'], at);
  expect(await checkLoginAllowed(['email:a@test.lv'], at)).toBe(false);
  expect(await checkLoginAllowed(['ip:1.2.3.4'], at)).toBe(false); // shared ip locked
  expect(await checkLoginAllowed(['email:b@test.lv'], at)).toBe(true); // other email free
  expect(await checkLoginAllowed(['email:b@test.lv', 'ip:1.2.3.4'], at)).toBe(false); // combined: ip still blocks
});

test('recordLoginFailure prunes rows older than 24h', async () => {
  const old = 1_750_000_000;
  await recordLoginFailure(['email:stale@test.lv'], old);
  await recordLoginFailure(['email:fresh@test.lv'], old + 24 * 3600 + 1);
  const rows = await appPool.query(`SELECT identifier FROM login_attempts ORDER BY identifier`);
  expect(rows.rows.map((r) => r.identifier)).toEqual(['email:fresh@test.lv']);
});
