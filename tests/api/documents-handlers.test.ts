import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createFirm, createClientCompany } from '../../src/tenancy/firms.js';
import { createUser } from '../../src/auth/users.js';
import { totpCodeFor } from '../../src/auth/totp.js';
import { login } from '../../src/auth/sessions.js';
import { assignUserToClient } from '../../src/auth/context.js';
import { createDocument } from '../../src/documents/documents.js';
import { documentsHandler, documentHandler } from '../../src/api/documents-handlers.js';

const NOW = 1_700_000_000;

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function setup() {
  const firm = await createFirm('Firm');
  const client = await createClientCompany(firm.id, { name: 'SIA K', regNo: '40100000000' });
  const { id: userId, totpSecret } = await createUser({ firmId: firm.id, email: 'a@b.lv', password: 'password123', role: 'accountant' });
  await assignUserToClient(userId, client.id);
  const { sessionToken } = await login('a@b.lv', 'password123', totpCodeFor(totpSecret, NOW), NOW);
  const cid = { firmId: firm.id, clientCompanyId: client.id, actorId: userId, actorRole: 'accountant' };
  const docId = (await withTenant(cid, (tx) => createDocument(tx, cid, { source: 'mobile', storageKey: 'k', mime: 'image/jpeg', uploadedBy: userId }))).id;
  return { clientId: client.id, sessionToken, docId };
}

test('documentsHandler lists documents for the authed client', async () => {
  const { clientId, sessionToken } = await setup();
  const res = await documentsHandler({ token: sessionToken, clientCompanyId: clientId, atUnixSeconds: NOW });
  expect(res.status).toBe(200);
  expect((res.body as { documents: unknown[] }).documents).toHaveLength(1);
});
test('documentHandler returns one document by id', async () => {
  const { clientId, sessionToken, docId } = await setup();
  const res = await documentHandler({ token: sessionToken, clientCompanyId: clientId, params: { id: docId }, atUnixSeconds: NOW });
  expect(res.status).toBe(200);
  expect((res.body as { document: { id: string } }).document.id).toBe(docId);
});
test('unauthenticated request is 401', async () => {
  const { clientId } = await setup();
  const res = await documentsHandler({ token: 'bogus', clientCompanyId: clientId, atUnixSeconds: NOW });
  expect(res.status).toBe(401);
});
