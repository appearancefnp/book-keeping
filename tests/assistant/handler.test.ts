import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createFirm, createClientCompany } from '../../src/tenancy/firms.js';
import { createUser } from '../../src/auth/users.js';
import { totpCodeFor } from '../../src/auth/totp.js';
import { login } from '../../src/auth/sessions.js';
import { assignUserToClient } from '../../src/auth/context.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { StubChatModel } from '../../src/assistant/chat-model.js';
import { makeAssistantHandler } from '../../src/assistant/handler.js';
import { buildAssistantTools } from '../../src/assistant/tools.js';

const NOW = 1_700_000_000;
const config = { outputVatAccount: '5721', inputVatAccount: '5722', receivablesAccount: '2310' };

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

  await withTenant(cid, async (tx) => {
    await createAccount(tx, cid, { code: '2310', name: 'Debtors', type: 'asset' });
    await createAccount(tx, cid, { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, cid, { code: '5721', name: 'Output VAT', type: 'liability' });
    await openPeriod(tx, cid, { year: 2026, month: 3 });
    await postEntry(tx, cid, { date: '2026-03-05', memo: 'Sale', currency: 'EUR', lines: [
      { accountCode: '2310', debit: '121.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '100.00' },
      { accountCode: '5721', debit: '0', credit: '21.00' },
    ]});
  });

  return { clientId: client.id, sessionToken };
}

test('assistant handler returns 200 with answer containing 21.00 and non-empty citations', async () => {
  const { clientId, sessionToken } = await setup();

  const model = new StubChatModel([
    { kind: 'tool_use', toolName: 'get_vat_position', toolArgs: { fromDate: '2026-03-01', toDate: '2026-03-31' } },
    { kind: 'final', text: 'For March 2026 your net VAT payable is €21.00.' },
  ]);
  const handler = makeAssistantHandler({ model, config });

  const res = await handler({ token: sessionToken, clientCompanyId: clientId, body: { question: 'How much VAT do I owe for March?' }, atUnixSeconds: NOW });
  expect(res.status).toBe(200);
  const body = res.body as { threadId: string; answer: string; citations: string[] };
  expect(body.answer).toMatch(/21\.00/);
  expect(body.citations.length).toBeGreaterThan(0);
  expect(typeof body.threadId).toBe('string');
});

test('assistant handler returns 401 for bogus token', async () => {
  const { clientId } = await setup();
  const model = new StubChatModel([]);
  const handler = makeAssistantHandler({ model, config });

  const res = await handler({ token: 'bogus-token', clientCompanyId: clientId, body: { question: 'Any question?' }, atUnixSeconds: NOW });
  expect(res.status).toBe(401);
});

test('assistant handler returns 400 when question is missing', async () => {
  const { clientId, sessionToken } = await setup();
  const model = new StubChatModel([]);
  const handler = makeAssistantHandler({ model, config });

  const res = await handler({ token: sessionToken, clientCompanyId: clientId, body: {}, atUnixSeconds: NOW });
  expect(res.status).toBe(400);
});
