import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { createFirm } from '../../src/tenancy/firms.js';
import { createUser } from '../../src/auth/users.js';
import { totpCodeFor } from '../../src/auth/totp.js';
import { login, validateSession, logout } from '../../src/auth/sessions.js';

const NOW = 1_700_000_000;

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function seedUser() {
  const firm = await createFirm('Firm');
  const { id, totpSecret } = await createUser({ firmId: firm.id, email: 'a@b.lv', password: 'password123', role: 'accountant' });
  return { firmId: firm.id, userId: id, totpSecret };
}

test('login requires a valid password AND totp; returns a session', async () => {
  const { totpSecret } = await seedUser();
  const { sessionToken } = await login('a@b.lv', 'password123', totpCodeFor(totpSecret, NOW), NOW);
  expect(sessionToken).toBeTruthy();
  const s = await validateSession(sessionToken, NOW);
  expect(s?.role).toBe('accountant');
});
test('wrong password is rejected', async () => {
  await seedUser();
  await expect(login('a@b.lv', 'nope', '000000', NOW)).rejects.toThrow(/credentials/i);
});
test('valid password but wrong totp is rejected (2FA mandatory)', async () => {
  await seedUser();
  await expect(login('a@b.lv', 'password123', '000000', NOW)).rejects.toThrow(/2fa|code/i);
});
test('logout invalidates the session', async () => {
  const { totpSecret } = await seedUser();
  const { sessionToken } = await login('a@b.lv', 'password123', totpCodeFor(totpSecret, NOW), NOW);
  await logout(sessionToken);
  expect(await validateSession(sessionToken, NOW)).toBeNull();
});
test('an expired session does not validate', async () => {
  const { totpSecret } = await seedUser();
  const { sessionToken } = await login('a@b.lv', 'password123', totpCodeFor(totpSecret, NOW), NOW);
  expect(await validateSession(sessionToken, NOW + 60 * 60 * 24 * 30)).toBeNull(); // 30 days later
});
