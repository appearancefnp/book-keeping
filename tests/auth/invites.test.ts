import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { createFirm } from '../../src/tenancy/firms.js';
import { createUser } from '../../src/auth/users.js';
import { login, validateSession } from '../../src/auth/sessions.js';
import { totpCodeFor } from '../../src/auth/totp.js';
import { createInvite, previewInvite, acceptInvite } from '../../src/auth/invites.js';

const NOW = 1_700_000_000;
const DAY = 86_400;

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function setup() {
  const firm = await createFirm('Invite Firm');
  const admin = await createUser({ firmId: firm.id, email: 'admin@t.lv', password: 'password123', role: 'firm_admin' });
  const invitee = await createUser({ firmId: firm.id, email: 'new@t.lv', password: 'placeholder-never-used-1', role: 'owner' });
  return { firm, adminId: admin.id, userId: invitee.id };
}

test('full happy path: invite → preview → accept → login', async () => {
  const { adminId, userId } = await setup();
  const { token } = await createInvite(userId, adminId, NOW);

  const preview = await previewInvite(token, NOW);
  expect(preview).not.toBeNull();
  expect(preview!.email).toBe('new@t.lv');
  expect(preview!.firmName).toBe('Invite Firm');
  expect(preview!.otpauthUri).toContain('otpauth://totp/');

  // Invited user cannot log in yet (even with correct new-ish credentials).
  await expect(login('new@t.lv', 'placeholder-never-used-1', totpCodeFor(preview!.totpSecret, NOW), NOW))
    .rejects.toThrow(/invalid credentials/i);

  await acceptInvite(token, { password: 'a-strong-password-12', totpCode: totpCodeFor(preview!.totpSecret, NOW) }, NOW);
  const { sessionToken } = await login('new@t.lv', 'a-strong-password-12', totpCodeFor(preview!.totpSecret, NOW), NOW);
  expect(sessionToken).toBeTruthy();
});

test('token is single-use and expired/garbage tokens are rejected identically', async () => {
  const { adminId, userId } = await setup();
  const { token } = await createInvite(userId, adminId, NOW);
  const preview = await previewInvite(token, NOW);
  await acceptInvite(token, { password: 'a-strong-password-12', totpCode: totpCodeFor(preview!.totpSecret, NOW) }, NOW);

  await expect(acceptInvite(token, { password: 'another-password-123', totpCode: totpCodeFor(preview!.totpSecret, NOW) }, NOW))
    .rejects.toThrow(/invalid invite/i);
  expect(await previewInvite(token, NOW)).toBeNull();
  expect(await previewInvite('deadbeef'.repeat(8), NOW)).toBeNull();

  const { token: t2 } = await createInvite(userId, adminId, NOW);
  expect(await previewInvite(t2, NOW + 3 * DAY + 1)).toBeNull(); // 72h expiry
});

test('wrong TOTP code leaves invite usable and user inactive', async () => {
  const { adminId, userId } = await setup();
  const { token } = await createInvite(userId, adminId, NOW);
  await expect(acceptInvite(token, { password: 'a-strong-password-12', totpCode: '000000' }, NOW))
    .rejects.toThrow(/invalid invite/i);
  expect(await previewInvite(token, NOW)).not.toBeNull(); // still unused
  await expect(login('new@t.lv', 'a-strong-password-12', '000000', NOW)).rejects.toThrow();
});

test('re-invite rotates the TOTP secret and invalidates prior invites', async () => {
  const { adminId, userId } = await setup();
  const { token: first } = await createInvite(userId, adminId, NOW);
  const firstPreview = await previewInvite(first, NOW);
  const { token: second } = await createInvite(userId, adminId, NOW);
  expect(await previewInvite(first, NOW)).toBeNull(); // prior invite invalidated
  const secondPreview = await previewInvite(second, NOW);
  expect(secondPreview!.totpSecret).not.toBe(firstPreview!.totpSecret);
  expect(secondPreview!.otpauthUri).toContain(secondPreview!.totpSecret);
});

test('re-invite revokes the account\'s live sessions', async () => {
  const { adminId, userId } = await setup();
  const { token } = await createInvite(userId, adminId, NOW);
  const preview = await previewInvite(token, NOW);
  await acceptInvite(token, { password: 'a-strong-password-12', totpCode: totpCodeFor(preview!.totpSecret, NOW) }, NOW);
  const { sessionToken } = await login('new@t.lv', 'a-strong-password-12', totpCodeFor(preview!.totpSecret, NOW), NOW);
  expect(await validateSession(sessionToken, NOW)).not.toBeNull();

  await createInvite(userId, adminId, NOW);
  expect(await validateSession(sessionToken, NOW)).toBeNull();
});

test('short password is rejected', async () => {
  const { adminId, userId } = await setup();
  const { token } = await createInvite(userId, adminId, NOW);
  const preview = await previewInvite(token, NOW);
  await expect(acceptInvite(token, { password: 'short', totpCode: totpCodeFor(preview!.totpSecret, NOW) }, NOW))
    .rejects.toThrow(); // zod min(12)
});
