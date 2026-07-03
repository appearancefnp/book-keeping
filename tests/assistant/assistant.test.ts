import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { StubChatModel } from '../../src/assistant/chat-model.js';
import { buildAssistantTools } from '../../src/assistant/tools.js';
import { runAssistant } from '../../src/assistant/assistant.js';
import { listThread } from '../../src/assistant/store.js';

const config = { outputVatAccount: '5721', inputVatAccount: '5722', receivablesAccount: '2310' };

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('answers a VAT question by calling the tool, cites, and persists the thread', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Debtors', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, ctx(t), { code: '5721', name: 'Output VAT', type: 'liability' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    await postEntry(tx, ctx(t), { date: '2026-03-05', memo: 'Sale', currency: 'EUR', lines: [
      { accountCode: '2310', debit: '121.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '100.00' },
      { accountCode: '5721', debit: '0', credit: '21.00' },
    ]});
  });
  // Script: call get_vat_position, then answer using the tool result.
  const model = new StubChatModel([
    { kind: 'tool_use', toolName: 'get_vat_position', toolArgs: { fromDate: '2026-03-01', toDate: '2026-03-31' } },
    { kind: 'final', text: 'For March 2026 your net VAT payable is €21.00.' },
  ]);
  const out = await withTenant(ctx(t), (tx) => runAssistant(tx, ctx(t), { question: 'How much VAT do I owe for March?', model, tools: buildAssistantTools(config) }));
  expect(out.answer).toMatch(/21\.00/);
  expect(out.citations.length).toBeGreaterThan(0);
  const msgs = await withTenant(ctx(t), (tx) => listThread(tx, ctx(t), out.threadId));
  expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
});

test('a model that never finishes is bounded by the step budget', async () => {
  const t = await makeFirmAndClient();
  const loopy = new StubChatModel(Array.from({ length: 20 }, () => ({ kind: 'tool_use', toolName: 'get_trial_balance', toolArgs: {} } as const)));
  await withTenant(ctx(t), async (tx) => { await createAccount(tx, ctx(t), { code: '2310', name: 'D', type: 'asset' }); });
  const out = await withTenant(ctx(t), (tx) => runAssistant(tx, ctx(t), { question: 'loop', model: loopy, tools: buildAssistantTools(config), maxSteps: 3 }));
  expect(out.answer).toBeTruthy(); // returns a bounded fallback, does not hang
});
