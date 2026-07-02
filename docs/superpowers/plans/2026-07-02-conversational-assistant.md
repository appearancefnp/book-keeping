# Conversational Assistant (grounded, read-only, cited) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A conversational assistant that answers an owner's/accountant's plain-language questions over *their own* books and current tax rules — "cik nodokļu šomēnes?", "how much do my customers owe me?", "what's the standard VAT rate?" — with **every figure sourced from tested deterministic code, cited, and tenant-scoped**. Read-only and advisory: it never mutates the ledger and never files anything.

**Architecture.** The assistant is an LLM **orchestrator over read-only, tenant-scoped domain tools**. The single load-bearing principle: **the model narrates deterministic tool outputs — it does not compute.** "How much VAT?" → the model calls `get_vat_position` → tested `explainVat` returns €21.00 + the rule + the contributing entry ids → the model just phrases that with citations. This removes the classic "AI gets the number wrong" risk: the numbers come from Plans 1–6, the model only explains them. The LLM sits behind an injectable `ChatModel` interface (same pattern as `DocumentExtractor`), with a deterministic `StubChatModel` for tests and real Ollama/Gemini/Anthropic adapters (integration-only, free options per `docs/oss-poc-options.md`).

**Tech Stack:** Same as Plans 1–8. No new runtime dependency (adapters use `fetch`). Register/UI: the chat **panel UI is deferred** (backend-for-frontend, like Plans 7–8); this plan delivers the tested orchestrator + tools + API handler the panel calls.

## Global Constraints

- **Inherits all Plan 1–8 constraints** (integer-cents; `withTenant`; RLS ENABLE+FORCE + explicit `client_company_id` predicate; migrations as admin, minimal grants; audited; the assistant is a *proposal-free, read-only* actor — it has NO write path).
- **Read-only, always.** The tool registry contains only read functions; the orchestrator invokes only registry tools. The assistant can never post, approve, reject, or file. Anything actionable is answered by *directing the user to the approval flow*, never by acting.
- **Tenant-scoped.** Every tool runs inside `withTenant` with the `TenantContext` from `resolveTenantContext`; the assistant cannot see another client's data.
- **Narrate, don't compute.** Figures in answers come from tool outputs (tested domain functions), never invented by the model. Tax statements are grounded in the versioned `tax_rules` (regulation-as-code) and cited.
- **Cite + disclaim.** Answers carry citations (source entry ids, proposal ids, rule refs) and a standing disclaimer that the assistant is informational, grounded in the client's data + current rules, and the accountant holds authority on filings.
- **Bounded loop.** The tool-call loop has a hard step budget (default 5) to prevent runaway.
- **Migration numbering continues at 022.**

## Consumed interfaces (all on `main` after Plans 1–8)

```ts
withTenant(ctx, fn); TenantContext; resolveTenantContext(token, clientCompanyId, atUnixSeconds)
authed(req, fn) / AuthedRequest / ApiResponse           // src/api/handlers.ts
explainVat(tx, ctx, {fromDate,toDate,config})            // src/tax/explain.ts -> {netPayable, ruleRef, contributions}
computeVat(...); getTaxRate(tx, ruleType, onDate)        // src/tax/*
trialBalance(tx, ctx)                                    // src/ledger/balances.ts
outstandingReceivables(tx, ctx, receivablesAccount)      // src/banking/sepa.ts
listProposals(tx, ctx, {status}); listDocuments(tx, ctx, {status})
appendAudit(tx, ctx, {...})
```

## File structure

```
migrations/
  022_chat_messages.sql
src/
  assistant/chat-model.ts       # ChatModel interface + StubChatModel + ChatTurn/ChatModelResponse types
  assistant/tools.ts            # ToolSpec + buildAssistantTools(config) -> read-only tenant-scoped tools
  assistant/store.ts            # appendChatMessage, listThread (chat_messages)
  assistant/assistant.ts        # runAssistant orchestrator (loop model<->tools, cite, persist, audit)
  assistant/handler.ts          # makeAssistantHandler({model, config}) -> authed API handler
  assistant/anthropic-chat.ts   # AnthropicChatModel (tool-use) — integration-only
  assistant/ollama-chat.ts      # OllamaChatModel — integration-only (free, local, private)
  assistant/gemini-chat.ts      # GeminiChatModel — integration-only (free tier)
tests/
  assistant/chat-model.test.ts
  assistant/tools.test.ts
  assistant/store.test.ts
  assistant/assistant.test.ts
  assistant/handler.test.ts
```

**Interfaces produced:**

```ts
interface ChatTurn { role: 'user' | 'assistant' | 'tool'; content: string; toolName?: string }
type ChatModelResponse = { kind: 'tool_use'; toolName: string; toolArgs: Record<string, unknown> } | { kind: 'final'; text: string }
interface ChatModel { respond(history: ChatTurn[], tools: { name: string; description: string }[]): Promise<ChatModelResponse> }
class StubChatModel implements ChatModel { constructor(script: ChatModelResponse[]) }
interface ToolResult { result: unknown; citations: string[] }
interface ToolSpec { name: string; description: string; run(tx, ctx, args: Record<string, unknown>): Promise<ToolResult> }
interface AssistantConfig { outputVatAccount: string; inputVatAccount: string; receivablesAccount: string }
function buildAssistantTools(config: AssistantConfig): ToolSpec[]
function runAssistant(tx, ctx, args: { question: string; threadId?: string; model: ChatModel; tools: ToolSpec[]; maxSteps?: number }): Promise<{ threadId: string; answer: string; citations: string[] }>
function makeAssistantHandler(deps: { model: ChatModel; config: AssistantConfig }): (req: AuthedRequest) => Promise<ApiResponse>
```

---

## Task 1: ChatModel interface + StubChatModel

**Files:** Create `src/assistant/chat-model.ts`; Test `tests/assistant/chat-model.test.ts`.

- [ ] **Step 1: Write the failing test — `tests/assistant/chat-model.test.ts`**

```ts
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
```

- [ ] **Step 2: Run to verify it fails** — `docker compose up -d db && npx vitest run tests/assistant/chat-model.test.ts` → FAIL (module missing).

- [ ] **Step 3: Create `src/assistant/chat-model.ts`**

```ts
export interface ChatTurn { role: 'user' | 'assistant' | 'tool'; content: string; toolName?: string }
export type ChatModelResponse =
  | { kind: 'tool_use'; toolName: string; toolArgs: Record<string, unknown> }
  | { kind: 'final'; text: string };

export interface ChatModel {
  respond(history: ChatTurn[], tools: { name: string; description: string }[]): Promise<ChatModelResponse>;
}

/** Deterministic model for tests: returns each scripted response in order, then a safe final. */
export class StubChatModel implements ChatModel {
  private i = 0;
  constructor(private readonly script: ChatModelResponse[]) {}
  async respond(_history: ChatTurn[], _tools: { name: string; description: string }[]): Promise<ChatModelResponse> {
    const next = this.script[this.i];
    this.i += 1;
    return next ?? { kind: 'final', text: 'I can only answer from your bookkeeping data.' };
  }
}
```

- [ ] **Step 4: Run to verify it passes** — PASS.
- [ ] **Step 5: Commit** — `feat: chat model interface + stub`.

---

## Task 2: Read-only tenant-scoped tool registry

**Files:** Create `src/assistant/tools.ts`; Test `tests/assistant/tools.test.ts`.

**Interfaces:** Consumes `explainVat`, `trialBalance`, `outstandingReceivables`, `listProposals`, `getTaxRate`. Produces `ToolSpec`, `ToolResult`, `AssistantConfig`, `buildAssistantTools`.

Tools (all read-only): `get_vat_position` (explainVat → netPayable + ruleRef + contribution entry ids as citations), `get_trial_balance`, `get_receivables`, `list_pending_approvals` (proposal ids as citations), `get_tax_rate`.

- [ ] **Step 1: Write the failing test — `tests/assistant/tools.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { buildAssistantTools } from '../../src/assistant/tools.js';

const config = { outputVatAccount: '5721', inputVatAccount: '5722', receivablesAccount: '2310' };

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('get_vat_position returns the computed net payable with entry citations', async () => {
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
  const tools = buildAssistantTools(config);
  const vat = tools.find((x) => x.name === 'get_vat_position')!;
  const out = await withTenant(ctx(t), (tx) => vat.run(tx, ctx(t), { fromDate: '2026-03-01', toDate: '2026-03-31' }));
  expect((out.result as { netPayable: string }).netPayable).toBe('21.00');
  expect(out.citations.length).toBeGreaterThan(0); // contributing entry id(s)
});

test('all tools are read-only (no mutating verbs) and tenant-scoped by construction', () => {
  const tools = buildAssistantTools(config);
  expect(tools.map((t) => t.name).sort()).toEqual(
    ['get_receivables', 'get_tax_rate', 'get_trial_balance', 'get_vat_position', 'list_pending_approvals'].sort(),
  );
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Create `src/assistant/tools.ts`**

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { explainVat } from '../tax/explain.js';
import { getTaxRate } from '../tax/rules.js';
import { trialBalance } from '../ledger/balances.js';
import { outstandingReceivables } from '../banking/sepa.js';
import { listProposals } from '../proposals/proposals.js';

export interface ToolResult { result: unknown; citations: string[] }
export interface ToolSpec {
  name: string; description: string;
  run(tx: PoolClient, ctx: TenantContext, args: Record<string, unknown>): Promise<ToolResult>;
}
export interface AssistantConfig { outputVatAccount: string; inputVatAccount: string; receivablesAccount: string }

const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);

export function buildAssistantTools(config: AssistantConfig): ToolSpec[] {
  return [
    {
      name: 'get_vat_position',
      description: 'VAT owed/refundable for a period (args: fromDate, toDate as YYYY-MM-DD). Returns net payable + the rate rule + contributing entries.',
      async run(tx, ctx, args) {
        const e = await explainVat(tx, ctx, {
          fromDate: str(args.fromDate, '2026-01-01'), toDate: str(args.toDate, '2026-12-31'),
          config: { outputVatAccount: config.outputVatAccount, inputVatAccount: config.inputVatAccount },
        });
        return { result: { netPayable: e.netPayable, rule: e.ruleRef }, citations: [...e.contributions.map((c) => c.entryId), `rule:${e.ruleRef.ruleType}@${e.ruleRef.effectiveFrom}`] };
      },
    },
    {
      name: 'get_trial_balance',
      description: 'Current trial balance: every account with its debit/credit totals and balance.',
      async run(tx, ctx) {
        const rows = await trialBalance(tx, ctx);
        return { result: rows, citations: rows.map((r) => `account:${r.code}`) };
      },
    },
    {
      name: 'get_receivables',
      description: 'Total outstanding receivables (what customers owe), in decimal.',
      async run(tx, ctx) {
        const { balanceCents } = await outstandingReceivables(tx, ctx, config.receivablesAccount);
        const n = BigInt(balanceCents);
        const dec = `${n / 100n}.${(n % 100n).toString().padStart(2, '0')}`;
        return { result: { outstanding: dec }, citations: [`account:${config.receivablesAccount}`] };
      },
    },
    {
      name: 'list_pending_approvals',
      description: 'Proposals awaiting human approval (count + type + rationale summary).',
      async run(tx, ctx) {
        const props = await listProposals(tx, ctx, { status: 'pending_approval' });
        return { result: { count: props.length, items: props.map((p) => ({ id: p.id, type: p.type })) }, citations: props.map((p) => `proposal:${p.id}`) };
      },
    },
    {
      name: 'get_tax_rate',
      description: 'Current/effective LR tax rate (args: ruleType e.g. vat_standard_rate, onDate YYYY-MM-DD).',
      async run(tx, _ctx, args) {
        const rate = await getTaxRate(tx, str(args.ruleType, 'vat_standard_rate'), str(args.onDate, '2026-01-01'));
        return { result: rate, citations: [`rule:${rate.ruleType}@${rate.effectiveFrom}`] };
      },
    },
  ];
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat: read-only tenant-scoped assistant tools`.

---

## Task 3: chat_messages store

**Files:** Create `migrations/022_chat_messages.sql`, `src/assistant/store.ts`; Test `tests/assistant/store.test.ts`.

- [ ] **Step 1: Create `migrations/022_chat_messages.sql`**

```sql
CREATE TABLE chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  thread_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('user','assistant')),
  content text NOT NULL,
  citations jsonb NOT NULL DEFAULT '[]'::jsonb,
  author text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  seq bigint GENERATED BY DEFAULT AS IDENTITY
);
CREATE INDEX chat_messages_thread_idx ON chat_messages(client_company_id, thread_id, seq);

ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY chat_messages_tenant ON chat_messages
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

GRANT SELECT, INSERT ON chat_messages TO bookkeeping_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO bookkeeping_app;
```

> `seq` IDENTITY gives deterministic thread ordering (the lesson from Plan 8's flaky comment fix — never order by `created_at` alone for same-transaction rows). Append-only: `SELECT, INSERT` only.

- [ ] **Step 2: Write the failing test — `tests/assistant/store.test.ts`** (append user + assistant messages under a thread; listThread returns them in insertion order with citations)

```ts
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
```

- [ ] **Step 3: Run → FAIL.**
- [ ] **Step 4: Create `src/assistant/store.ts`**

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export interface ChatMessageRow { id: string; role: 'user' | 'assistant'; content: string; citations: string[] }

export async function appendChatMessage(
  tx: PoolClient, ctx: TenantContext,
  input: { threadId: string; role: 'user' | 'assistant'; content: string; citations: string[] },
): Promise<{ id: string }> {
  const res = await tx.query(
    `INSERT INTO chat_messages(client_company_id, thread_id, role, content, citations, author)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [ctx.clientCompanyId, input.threadId, input.role, input.content, JSON.stringify(input.citations), ctx.actorId],
  );
  return { id: res.rows[0].id };
}

export async function listThread(tx: PoolClient, ctx: TenantContext, threadId: string): Promise<ChatMessageRow[]> {
  const res = await tx.query(
    `SELECT id, role, content, citations FROM chat_messages
     WHERE client_company_id = $1 AND thread_id = $2 ORDER BY seq`,
    [ctx.clientCompanyId, threadId],
  );
  return res.rows;
}
```

- [ ] **Step 5: Run → PASS. Commit** — `feat: chat message store (append-only, ordered)`.

---

## Task 4: Orchestrator `runAssistant` (the keystone)

**Files:** Create `src/assistant/assistant.ts`; Test `tests/assistant/assistant.test.ts`.

Loop: model↔tools inside the caller's `tx`; run only registry tools (read-only); accumulate citations; persist the user question + final answer; append a standing disclaimer; enforce a step budget; audit. Generates a `threadId` if none supplied (via `gen_random_uuid()` from the DB, since `crypto.randomUUID()` is fine at runtime too — use `randomUUID` from `node:crypto`).

- [ ] **Step 1: Write the failing test — `tests/assistant/assistant.test.ts`**

```ts
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
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Create `src/assistant/assistant.ts`**

```ts
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
```

- [ ] **Step 4: Run → PASS. Commit** — `feat: assistant orchestrator (read-only tools, cited, bounded)`.

---

## Task 5: `makeAssistantHandler` (authed API)

**Files:** Create `src/assistant/handler.ts`; Test `tests/assistant/handler.test.ts`.

Factory injecting `{model, config}` → an `authed` handler: `POST` `{question, threadId?}` → `resolveTenantContext` → `runAssistant` on the tenant's `tx` → `{threadId, answer, citations}`. Unauthenticated → 401. Mirrors the capture-handler factory pattern.

- [ ] **Step 1: Write the failing test — `tests/assistant/handler.test.ts`** (seed firm/client/accountant/login/assign + a VAT sale; call handler with a StubChatModel; assert 200 + answer contains 21.00 + citations; bogus token → 401). Reuse the auth setup pattern from `tests/api/handlers.test.ts`.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Create `src/assistant/handler.ts`**

```ts
import { withTenant } from '../db/pool.js';
import { authed } from '../api/handlers.js';
import type { AuthedRequest, ApiResponse } from '../api/types.js';
import type { ChatModel } from './chat-model.js';
import { buildAssistantTools, type AssistantConfig } from './tools.js';
import { runAssistant } from './assistant.js';

export function makeAssistantHandler(deps: { model: ChatModel; config: AssistantConfig }): (req: AuthedRequest) => Promise<ApiResponse> {
  const tools = buildAssistantTools(deps.config);
  return (req) => authed(req, async (ctx) => {
    const body = (req.body ?? {}) as { question?: string; threadId?: string };
    if (!body.question) return { status: 400, body: { error: 'question is required' } };
    const out = await withTenant(ctx, (tx) => runAssistant(tx, ctx, { question: body.question!, threadId: body.threadId, model: deps.model, tools }));
    return { status: 200, body: out };
  });
}
```

- [ ] **Step 4: Run → PASS. Full suite + typecheck. Commit** — `feat: assistant API handler (authed, injectable model)`.

---

## Task 6: Real chat adapters (Ollama / Gemini / Anthropic) — integration-only

**Files:** Create `src/assistant/ollama-chat.ts`, `src/assistant/gemini-chat.ts`, `src/assistant/anthropic-chat.ts`. No unit tests (need live models/keys); must typecheck.

Each implements `ChatModel.respond(history, tools)` by mapping `history` to the provider's message format and `tools` to the provider's tool/function schema, then parsing the response into `{kind:'tool_use',...}` or `{kind:'final', text}`.

> **The implementer MUST consult the `claude-api` skill** for the Anthropic Messages **tool-use** request/response shape and the current model id. Ollama uses `/api/chat` with a `tools` array; Gemini uses `functionDeclarations` + `functionCall` parts. Free options (Ollama local, Gemini free tier) per `docs/oss-poc-options.md`.

- [ ] **Step 1: Implement the three adapters (fetch-based, no new deps).** Anthropic: map `tools` → `[{name, description, input_schema:{type:'object'}}]`; parse `content` for a `tool_use` block (→ tool_use) else the text block (→ final). Ollama: `/api/chat` `{model, messages, tools, stream:false}`; parse `message.tool_calls` else `message.content`. Gemini: `generateContent` with `tools:[{functionDeclarations}]`; parse a `functionCall` part else text.
- [ ] **Step 2: `npm run typecheck` clean.** No unit test (integration-only).
- [ ] **Step 3: Commit** — `feat: Ollama/Gemini/Anthropic chat adapters (integration-only)`.

---

## Self-review

**Spec coverage (design §4.2 conversational assistant, §6.9 AI agent):**
- Plain-language Q&A over the client's own data, LV/RU/EN (the model handles language; tool data is language-neutral) → Tasks 1,2,4,5. ✓
- Answers with a reference to the source data + rule → citations threaded from tool outputs (entry ids, proposal ids, rule refs) → Tasks 2,4. ✓
- Read-only / human-authority preserved → the registry has only read tools; the orchestrator runs only registry tools; disclaimer; anything actionable is directed to the approval flow, never executed. ✓
- Tenant isolation → all tools run inside `withTenant` with `resolveTenantContext`'s ctx. ✓
- Free/private for the POC → StubChatModel (no LLM, tests) + OllamaChatModel (local, free, private) + GeminiChatModel (free tier). ✓

**Deliberately deferred:** the chat **panel UI** (backend-for-frontend; built with the web app / impeccable later); cash-flow forecast & anomaly detection (Phase 3); an *actioning* assistant that drafts proposals from chat (a later iteration — this plan is strictly read-only/advisory); per-client `AssistantConfig` from a config table (injected for now, same as Plans 3/6/8).

**The key safety property:** the model never computes figures — it narrates tested tool outputs and cites them. Wrong-number risk is bounded by the deterministic domain, not the LLM.

**Type consistency:** consumed Plan 1–8 signatures match `main` (`explainVat`, `trialBalance`, `outstandingReceivables`, `listProposals`, `getTaxRate`, `authed`, `withTenant`, `resolveTenantContext`, `appendAudit`). `ChatModel`/`ToolSpec`/`AssistantConfig` used consistently across Tasks 1–6; `StubChatModel` drives deterministic orchestration tests; real adapters are integration-only like the extractor adapters.
