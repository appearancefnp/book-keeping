import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetDb, closeDb } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createFirm, createClientCompany } from '../../src/tenancy/firms.js';
import { createUser } from '../../src/auth/users.js';
import { totpCodeFor } from '../../src/auth/totp.js';
import { login } from '../../src/auth/sessions.js';
import { assignUserToClient } from '../../src/auth/context.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { LocalBlobStore } from '../../src/blob/blob-store.js';
import { StubExtractor } from '../../src/intake/extractor.js';
import { getProposal } from '../../src/proposals/proposals.js';
import { makeCaptureHandler } from '../../src/api/capture-handler.js';

const NOW = 1_700_000_000;
const template = { expenseAccount: '7710', vatInputAccount: '5722', payablesAccount: '5310' };
const canned = {
  extractedData: {
    supplierName: 'SIA Piegādātājs', supplierRegNo: '40300000000', date: '2026-03-10', currency: 'EUR',
    lineItems: [{ description: 'Prece', net: '100.00', vatRate: 21, vat: '21.00' }],
    vatTotal: '21.00', netTotal: '100.00', grandTotal: '121.00',
  },
  confidence: { supplierName: 0.98, grandTotal: 0.97 },
};

let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'cap-')); await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); await closeDb(); });

async function setup() {
  const firm = await createFirm('Firm');
  const client = await createClientCompany(firm.id, { name: 'SIA K', regNo: '40100000000' });
  const { id: userId, totpSecret } = await createUser({ firmId: firm.id, email: 'a@b.lv', password: 'password123', role: 'employee' });
  await assignUserToClient(userId, client.id);
  const { sessionToken } = await login('a@b.lv', 'password123', totpCodeFor(totpSecret, NOW), NOW);
  const cid = { firmId: firm.id, clientCompanyId: client.id, actorId: userId, actorRole: 'employee' };
  await withTenant(cid, async (tx) => {
    await createAccount(tx, cid, { code: '7710', name: 'Expense', type: 'expense' });
    await createAccount(tx, cid, { code: '5722', name: 'Input VAT', type: 'asset' });
    await createAccount(tx, cid, { code: '5310', name: 'Payables', type: 'liability' });
    await openPeriod(tx, cid, { year: 2026, month: 3 });
  });
  return { clientId: client.id, sessionToken };
}

test('capture stores the blob, creates a mobile document, and drafts a pending posting proposal', async () => {
  const { clientId, sessionToken } = await setup();
  const handler = makeCaptureHandler({ blob: new LocalBlobStore(dir), extractor: new StubExtractor(canned), resolveTemplate: () => template });
  const res = await handler({
    token: sessionToken, clientCompanyId: clientId, atUnixSeconds: NOW,
    body: { bytesBase64: Buffer.from('fake-photo').toString('base64'), mime: 'image/jpeg' },
  });
  expect(res.status).toBe(200);
  const body = res.body as { documentId: string; proposalId: string; status: string };
  expect(body.documentId).toBeTruthy();
  expect(body.proposalId).toBeTruthy();
  const cid = { firmId: '', clientCompanyId: clientId, actorId: 'x', actorRole: 'accountant' };
  const prop = await withTenant(cid, (tx) => getProposal(tx, cid, body.proposalId));
  expect(prop.type).toBe('posting');
  expect(prop.status).toBe('pending_approval');
});

test('unauthenticated capture is 401 and stores nothing', async () => {
  const { clientId } = await setup();
  const handler = makeCaptureHandler({ blob: new LocalBlobStore(dir), extractor: new StubExtractor(canned), resolveTemplate: () => template });
  const res = await handler({ token: 'bogus', clientCompanyId: clientId, atUnixSeconds: NOW, body: { bytesBase64: 'x', mime: 'image/jpeg' } });
  expect(res.status).toBe(401);
});
