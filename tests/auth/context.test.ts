import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { createFirm, createClientCompany } from '../../src/tenancy/firms.js';
import { createUser } from '../../src/auth/users.js';
import { totpCodeFor } from '../../src/auth/totp.js';
import { login } from '../../src/auth/sessions.js';
import { assignUserToClient, resolveTenantContext } from '../../src/auth/context.js';

const NOW = 1_700_000_000;

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function setup() {
  const firm = await createFirm('Firm');
  const client = await createClientCompany(firm.id, { name: 'SIA K', regNo: '40100000000' });
  const { id: userId, totpSecret } = await createUser({ firmId: firm.id, email: 'a@b.lv', password: 'password123', role: 'accountant' });
  const { sessionToken } = await login('a@b.lv', 'password123', totpCodeFor(totpSecret, NOW), NOW);
  return { firmId: firm.id, clientId: client.id, userId, sessionToken };
}

test('resolves a TenantContext for an assigned client', async () => {
  const { clientId, userId, sessionToken } = await setup();
  await assignUserToClient(userId, clientId);
  const ctx = await resolveTenantContext(sessionToken, clientId, NOW);
  expect(ctx.clientCompanyId).toBe(clientId);
  expect(ctx.actorId).toBe(userId);
  expect(ctx.actorRole).toBe('accountant');
});
test('refuses a client the user is NOT assigned to', async () => {
  const { clientId, sessionToken } = await setup();
  await expect(resolveTenantContext(sessionToken, clientId, NOW)).rejects.toThrow(/not authorized|assign/i);
});
test('refuses an invalid session', async () => {
  const { clientId } = await setup();
  await expect(resolveTenantContext('bogus-token', clientId, NOW)).rejects.toThrow(/session/i);
});
