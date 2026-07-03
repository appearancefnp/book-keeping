import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { appendChatMessage, listThread } from '../../src/assistant/store.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('append + list a thread in order with citations', async () => {
  const t = await makeFirmAndClient();
  const threadId = '33333333-3333-3333-3333-333333333333';
  await withTenant(ctx(t), async (tx) => {
    await appendChatMessage(tx, ctx(t), { threadId, role: 'user', content: 'how much VAT this month?', citations: [] });
    await appendChatMessage(tx, ctx(t), { threadId, role: 'assistant', content: 'You owe €21.00.', citations: ['entry:x', 'rule:vat_standard_rate@2013-01-01'] });
  });
  const msgs = await withTenant(ctx(t), (tx) => listThread(tx, ctx(t), threadId));
  expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
  expect(msgs[1]!.citations).toContain('rule:vat_standard_rate@2013-01-01');
});
