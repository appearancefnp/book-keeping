import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import type { ChatModel, ChatTurn } from './chat-model.js';
import type { ToolSpec } from './tools.js';
import { appendChatMessage } from './store.js';
import { appendAudit } from '../audit/audit.js';

const DISCLAIMER =
  'This is informational, based on your bookkeeping data and current rules; your accountant holds authority on filings.';

export async function runAssistant(
  tx: PoolClient, ctx: TenantContext,
  args: { question: string; threadId?: string; model: ChatModel; tools: ToolSpec[]; maxSteps?: number },
): Promise<{ threadId: string; answer: string; citations: string[] }> {
  const threadId = args.threadId ?? randomUUID();
  const maxSteps = args.maxSteps ?? 5;
  const toolList = args.tools.map((t) => ({ name: t.name, description: t.description }));
  const byName = new Map(args.tools.map((t) => [t.name, t]));
  const history: ChatTurn[] = [{ role: 'user', content: args.question }];
  const citations: string[] = [];

  await appendChatMessage(tx, ctx, { threadId, role: 'user', content: args.question, citations: [] });

  let answer = 'I can only answer from your bookkeeping data.';
  for (let step = 0; step < maxSteps; step += 1) {
    const r = await args.model.respond(history, toolList);
    if (r.kind === 'final') { answer = r.text; break; }
    const tool = byName.get(r.toolName); // read-only: only registry tools are runnable
    if (!tool) { history.push({ role: 'tool', content: `unknown tool ${r.toolName}`, toolName: r.toolName }); continue; }
    const out = await tool.run(tx, ctx, r.toolArgs);
    citations.push(...out.citations);
    history.push({ role: 'assistant', content: `calls ${r.toolName}` });
    history.push({ role: 'tool', content: JSON.stringify(out.result), toolName: r.toolName });
  }

  const finalAnswer = `${answer}\n\n${DISCLAIMER}`;
  const uniqueCitations = [...new Set(citations)];
  await appendChatMessage(tx, ctx, { threadId, role: 'assistant', content: finalAnswer, citations: uniqueCitations });
  await appendAudit(tx, ctx, { action: 'assistant_answer', entityType: 'chat', entityId: null, before: null, after: { threadId, question: args.question, citations: uniqueCitations } });
  return { threadId, answer: finalAnswer, citations: uniqueCitations };
}
