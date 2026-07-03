import { expect, test } from 'vitest';
import { StubChatModel } from '../../src/assistant/chat-model.js';

test('StubChatModel returns its scripted responses in order', async () => {
  const m = new StubChatModel([
    { kind: 'tool_use', toolName: 'get_vat_position', toolArgs: { fromDate: '2026-03-01', toDate: '2026-03-31' } },
    { kind: 'final', text: 'You owe €21.00 VAT for March 2026.' },
  ]);
  const tools = [{ name: 'get_vat_position', description: '...' }];
  const first = await m.respond([{ role: 'user', content: 'how much VAT this month?' }], tools);
  expect(first).toMatchObject({ kind: 'tool_use', toolName: 'get_vat_position' });
  const second = await m.respond([], tools);
  expect(second).toMatchObject({ kind: 'final' });
});

test('StubChatModel falls back to a final answer when the script is exhausted', async () => {
  const m = new StubChatModel([]);
  const r = await m.respond([{ role: 'user', content: 'hi' }], []);
  expect(r.kind).toBe('final');
});
