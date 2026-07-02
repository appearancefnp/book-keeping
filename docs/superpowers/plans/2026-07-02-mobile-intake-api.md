# Mobile & Intake API — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the *backend-for-frontend* the mobile app (and web) needs: the documents read API, a capture→upload→intake endpoint (photo bytes → stored blob → document → drafted posting proposal), push-notification device-token registration, and a config-free mobile home summary — all fully tested against a real Postgres.

**Scope note — mobile UI deferred.** The React Native app (camera capture, offline queue, native views, push delivery) is a presentation/device layer that cannot be verified headless and is **out of scope**, exactly like the web UI (Plan 7). This plan delivers the API endpoints the RN app calls, verified by the same test suite as Plans 1–7. Actual push *delivery* (APNs/FCM) is an external integration behind the `device_tokens` source of truth built here.

**Architecture:** Extends the merged Plan 1–7 monolith. The capture endpoint is a **handler factory** `makeCaptureHandler({ blob, extractor, resolveTemplate })` — dependencies (blob store, LLM extractor, per-client posting template) are injected, so production wires the real `LocalBlobStore`/cloud + `AnthropicExtractor`, and tests wire in-memory stubs. Capture stores bytes, creates a `mobile`-source document, and runs the Plan 3 `runIntake` pipeline → a `pending_approval` posting proposal. All read/summary handlers reuse the Plan 7 `authed()` wrapper (session + per-client RBAC). Push notifications are modeled as data: `device_tokens` + a `pending-push` query joining unread notifications to registered tokens — a real delivery worker consumes that later.

**Tech Stack:** Same as Plans 1–7. No new runtime dependency.

## Global Constraints

- **Inherits all Plan 1–7 constraints** (integer-cents; `withTenant`; RLS ENABLE+FORCE + explicit `client_company_id` predicate; migrations as admin, minimal grants; audited state changes; the AI has no privileged write path — capture drafts a proposal, never posts directly).
- **All handlers go through `authed()`** (Plan 7) — session + per-client authorization; actor identity is session-derived.
- **The capture endpoint never posts to the ledger** — it drafts a `pending_approval` proposal via `runIntake` (the human approves later through the Plan 7 approve keystone).
- **Injected dependencies, not request-controlled** — the extractor, blob store, and template come from the factory (server config), never from the request body. **Migration numbering continues at 020.**

## Consumed interfaces (all on `main` after Plans 1–7)

```ts
withTenant(ctx, fn); TenantContext
authed(req, fn) / AuthedRequest / ApiResponse   // src/api/handlers.ts (export authed if not already)
resolveTenantContext(token, clientCompanyId, atUnixSeconds)
listDocuments(tx,ctx,{status}); getDocument(tx,ctx,id); createDocument(tx,ctx,{source,storageKey,mime,uploadedBy})
BlobStore, LocalBlobStore (src/blob/blob-store.ts)
DocumentExtractor, StubExtractor (src/intake/extractor.ts)
runIntake(tx,ctx,{documentId,blob,extractor,template}); PostingTemplate (src/intake/map-posting.ts)
listProposals(tx,ctx,{status}); listTasks(tx,ctx,{status})   // for the summary counts
appendAudit(tx,ctx,{...})
```

> Task 1 first ensures `authed` is exported from `src/api/handlers.ts` (Plan 7 kept it module-private). If it is not exported, export it — a one-line change — so mobile handlers reuse the exact same auth gate rather than duplicating it.

## File structure

```
migrations/
  020_device_tokens.sql
src/
  api/documents-handlers.ts   # documentsHandler (list), documentHandler (get one)
  api/capture-handler.ts      # makeCaptureHandler({blob,extractor,resolveTemplate})
  api/summary-handler.ts      # homeSummaryHandler (config-free counts)
  push/device-tokens.ts       # registerDeviceToken, listDeviceTokens, pendingPushNotifications
tests/
  api/documents-handlers.test.ts
  api/capture-handler.test.ts
  api/summary-handler.test.ts
  push/device-tokens.test.ts
```

**Interfaces produced (RN client consumes these):**

```ts
documentsHandler(req: AuthedRequest): Promise<ApiResponse>;   // body: { documents }
documentHandler(req: AuthedRequest): Promise<ApiResponse>;    // params.id -> { document }
function makeCaptureHandler(deps: { blob: BlobStore; extractor: DocumentExtractor; resolveTemplate: (clientCompanyId: string) => PostingTemplate }): (req: AuthedRequest) => Promise<ApiResponse>;
homeSummaryHandler(req: AuthedRequest): Promise<ApiResponse>; // { pendingApprovals, documentsNeedingReview, openTasks }
registerDeviceToken(tx, ctx, { token, platform }): Promise<{ id: string }>;
listDeviceTokens(tx, ctx): Promise<{ token: string; platform: string }[]>;
pendingPushNotifications(tx, ctx): Promise<{ token: string; platform: string; message: string }[]>;
```

---

## Task 1: Documents read API (closes the Plan 7 gap) + export `authed`

**Files:** Modify `src/api/handlers.ts` (export `authed`); Create `src/api/documents-handlers.ts`; Test `tests/api/documents-handlers.test.ts`.

- [ ] **Step 1: Ensure `authed` is exported**

In `src/api/handlers.ts`, change `async function authed(...)` to `export async function authed(...)` (if not already exported). Run `npx vitest run tests/api/handlers.test.ts` to confirm the Plan 7 handler tests still pass (the export is additive).

- [ ] **Step 2: Write the failing test — `tests/api/documents-handlers.test.ts`**

```ts
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
```

- [ ] **Step 3: Run to verify it fails**

Run: `docker compose up -d db && npx vitest run tests/api/documents-handlers.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Create `src/api/documents-handlers.ts`**

```ts
import { withTenant } from '../db/pool.js';
import { authed } from './handlers.js';
import type { AuthedRequest, ApiResponse } from './types.js';
import { listDocuments, getDocument, type DocumentStatus } from '../documents/documents.js';

export function documentsHandler(req: AuthedRequest): Promise<ApiResponse> {
  return authed(req, async (ctx) => {
    const status = (req.params?.status as DocumentStatus | undefined) ?? undefined;
    const documents = await withTenant(ctx, (tx) => listDocuments(tx, ctx, status ? { status } : {}));
    return { status: 200, body: { documents } };
  });
}

export function documentHandler(req: AuthedRequest): Promise<ApiResponse> {
  return authed(req, async (ctx) => {
    const id = req.params?.id;
    if (!id) return { status: 400, body: { error: 'missing document id' } };
    try {
      const document = await withTenant(ctx, (tx) => getDocument(tx, ctx, id));
      return { status: 200, body: { document } };
    } catch {
      return { status: 404, body: { error: 'document not found' } };
    }
  });
}
```

- [ ] **Step 5: Run to verify it passes; commit**

Run: `npx vitest run tests/api/documents-handlers.test.ts`
Expected: PASS (3 tests).

```bash
git add src/api/handlers.ts src/api/documents-handlers.ts tests/api/documents-handlers.test.ts
git commit -m "feat: documents read API + export authed wrapper"
```

---

## Task 2: Device tokens + pending-push query

**Files:** Create `migrations/020_device_tokens.sql`, `src/push/device-tokens.ts`; Test `tests/push/device-tokens.test.ts`.

- [ ] **Step 1: Create `migrations/020_device_tokens.sql`**

```sql
CREATE TABLE device_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  owner text NOT NULL,               -- the user id the token belongs to
  token text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('ios','android')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_company_id, token)
);
CREATE INDEX device_tokens_client_idx ON device_tokens(client_company_id);

ALTER TABLE device_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY device_tokens_tenant ON device_tokens
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

GRANT SELECT, INSERT ON device_tokens TO bookkeeping_app;
```

- [ ] **Step 2: Write the failing test — `tests/push/device-tokens.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { registerDeviceToken, listDeviceTokens, pendingPushNotifications } from '../../src/push/device-tokens.js';
import { notify } from '../../src/collab/notifications.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('register is idempotent and lists tokens', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await registerDeviceToken(tx, ctx(t), { token: 'tok-1', platform: 'ios' });
    await registerDeviceToken(tx, ctx(t), { token: 'tok-1', platform: 'ios' }); // duplicate, no error
  });
  const tokens = await withTenant(ctx(t), (tx) => listDeviceTokens(tx, ctx(t)));
  expect(tokens).toHaveLength(1);
  expect(tokens[0]!.platform).toBe('ios');
});

test('pendingPushNotifications joins unread notifications to the recipient\'s device tokens', async () => {
  const t = await makeFirmAndClient();
  const c = ctx(t);
  await withTenant(c, async (tx) => {
    await registerDeviceToken(tx, c, { token: 'tok-1', platform: 'android' });
    await notify(tx, c, { recipient: c.actorId, kind: 'approval_needed', message: 'Approve please' });
  });
  const pending = await withTenant(c, (tx) => pendingPushNotifications(tx, c));
  expect(pending).toHaveLength(1);
  expect(pending[0]!.token).toBe('tok-1');
  expect(pending[0]!.message).toBe('Approve please');
});
```

> Note: `registerDeviceToken` uses `ctx.actorId` as `owner`, and `notify` uses the same `ctx.actorId` as `recipient`, so the join in `pendingPushNotifications` (owner = recipient) matches. The test's `ctx(t)` returns a fresh actorId each call — so bind `const c = ctx(t)` once and reuse it (as the second test does).

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/push/device-tokens.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Create `src/push/device-tokens.ts`**

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export async function registerDeviceToken(
  tx: PoolClient, ctx: TenantContext, input: { token: string; platform: 'ios' | 'android' },
): Promise<{ id: string | null }> {
  const res = await tx.query(
    `INSERT INTO device_tokens(client_company_id, owner, token, platform)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (client_company_id, token) DO NOTHING
     RETURNING id`,
    [ctx.clientCompanyId, ctx.actorId, input.token, input.platform],
  );
  return { id: res.rows[0]?.id ?? null };
}

export async function listDeviceTokens(tx: PoolClient, ctx: TenantContext): Promise<{ token: string; platform: string }[]> {
  const res = await tx.query(
    `SELECT token, platform FROM device_tokens WHERE client_company_id = $1 ORDER BY created_at`,
    [ctx.clientCompanyId],
  );
  return res.rows;
}

/** Unread notifications joined to the recipient's device tokens — the work list a push worker would send. */
export async function pendingPushNotifications(
  tx: PoolClient, ctx: TenantContext,
): Promise<{ token: string; platform: string; message: string }[]> {
  const res = await tx.query(
    `SELECT d.token, d.platform, n.message
     FROM notifications n
     JOIN device_tokens d ON d.owner = n.recipient AND d.client_company_id = n.client_company_id
     WHERE n.client_company_id = $1 AND n.read = false
     ORDER BY n.created_at`,
    [ctx.clientCompanyId],
  );
  return res.rows;
}
```

- [ ] **Step 5: Run to verify it passes; commit**

Run: `npx vitest run tests/push/device-tokens.test.ts`
Expected: PASS (2 tests).

```bash
git add migrations/020_device_tokens.sql src/push/device-tokens.ts tests/push/device-tokens.test.ts
git commit -m "feat: device-token registration + pending-push query"
```

---

## Task 3: Capture → upload → intake handler (factory)

**Files:** Create `src/api/capture-handler.ts`; Test `tests/api/capture-handler.test.ts`.

`makeCaptureHandler({ blob, extractor, resolveTemplate })` returns an `authed` handler that: decodes `body.bytesBase64` + `body.mime`, stores to `blob` under a generated key, `createDocument({source:'mobile'})`, runs `runIntake` (Plan 3) → a `pending_approval` posting proposal. Deps are injected (server config), never from the request.

- [ ] **Step 1: Write the failing test — `tests/api/capture-handler.test.ts`**

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/api/capture-handler.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `src/api/capture-handler.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { withTenant } from '../db/pool.js';
import { authed } from './handlers.js';
import type { AuthedRequest, ApiResponse } from './types.js';
import type { BlobStore } from '../blob/blob-store.js';
import type { DocumentExtractor } from '../intake/extractor.js';
import { createDocument } from '../documents/documents.js';
import { runIntake } from '../intake/intake.js';
import type { PostingTemplate } from '../intake/map-posting.js';

export function makeCaptureHandler(deps: {
  blob: BlobStore; extractor: DocumentExtractor; resolveTemplate: (clientCompanyId: string) => PostingTemplate;
}): (req: AuthedRequest) => Promise<ApiResponse> {
  return (req) => authed(req, async (ctx) => {
    const body = (req.body ?? {}) as { bytesBase64?: string; mime?: string };
    if (!body.bytesBase64 || !body.mime) return { status: 400, body: { error: 'bytesBase64 and mime are required' } };

    const bytes = Buffer.from(body.bytesBase64, 'base64');
    const storageKey = `${ctx.clientCompanyId}/${randomUUID()}`;
    await deps.blob.put(storageKey, bytes, body.mime);

    const result = await withTenant(ctx, async (tx) => {
      const doc = await createDocument(tx, ctx, { source: 'mobile', storageKey, mime: body.mime!, uploadedBy: ctx.actorId });
      const intake = await runIntake(tx, ctx, { documentId: doc.id, blob: deps.blob, extractor: deps.extractor, template: deps.resolveTemplate(ctx.clientCompanyId) });
      return { documentId: doc.id, proposalId: intake.proposalId, status: intake.status };
    });
    return { status: 200, body: result };
  });
}
```

> Note: the blob write happens before the `withTenant` transaction (object storage is not transactional). If the DB transaction rolls back, an orphan blob remains under `storageKey` with no document row — harmless (unreferenced), and a periodic sweep can GC orphans. Documented here as an accepted MVP behavior (same class as the Plan 6 dual-write note).

- [ ] **Step 4: Run to verify it passes; commit**

Run: `npx vitest run tests/api/capture-handler.test.ts`
Expected: PASS (2 tests).

```bash
git add src/api/capture-handler.ts tests/api/capture-handler.test.ts
git commit -m "feat: mobile capture -> upload -> intake handler (factory)"
```

---

## Task 4: Mobile home summary handler

**Files:** Create `src/api/summary-handler.ts`; Test `tests/api/summary-handler.test.ts`.

Config-free counts for the mobile home screen: pending approvals, documents needing review, open tasks — all via existing list functions (no per-client accounting config needed).

- [ ] **Step 1: Write the failing test — `tests/api/summary-handler.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createFirm, createClientCompany } from '../../src/tenancy/firms.js';
import { createUser } from '../../src/auth/users.js';
import { totpCodeFor } from '../../src/auth/totp.js';
import { login } from '../../src/auth/sessions.js';
import { assignUserToClient } from '../../src/auth/context.js';
import { createProposal } from '../../src/proposals/proposals.js';
import { createTask } from '../../src/collab/tasks.js';
import { createDocument, setDocumentStatus } from '../../src/documents/documents.js';
import { homeSummaryHandler } from '../../src/api/summary-handler.js';

const NOW = 1_700_000_000;

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('home summary returns pending-approval, needs-review, and open-task counts', async () => {
  const firm = await createFirm('Firm');
  const client = await createClientCompany(firm.id, { name: 'SIA K', regNo: '40100000000' });
  const { id: userId, totpSecret } = await createUser({ firmId: firm.id, email: 'a@b.lv', password: 'password123', role: 'owner' });
  await assignUserToClient(userId, client.id);
  const { sessionToken } = await login('a@b.lv', 'password123', totpCodeFor(totpSecret, NOW), NOW);
  const cid = { firmId: firm.id, clientCompanyId: client.id, actorId: userId, actorRole: 'owner' };
  await withTenant(cid, async (tx) => {
    await createProposal(tx, cid, { type: 'posting', payload: {}, rationale: {}, status: 'pending_approval' });
    await createTask(tx, cid, { title: 'Missing contract' });
    const d = await createDocument(tx, cid, { source: 'mobile', storageKey: 'k', mime: 'image/jpeg', uploadedBy: userId });
    await setDocumentStatus(tx, cid, d.id, 'needs_review');
  });
  const res = await homeSummaryHandler({ token: sessionToken, clientCompanyId: client.id, atUnixSeconds: NOW });
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ pendingApprovals: 1, documentsNeedingReview: 1, openTasks: 1 });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/api/summary-handler.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `src/api/summary-handler.ts`**

```ts
import { withTenant } from '../db/pool.js';
import { authed } from './handlers.js';
import type { AuthedRequest, ApiResponse } from './types.js';
import { listProposals } from '../proposals/proposals.js';
import { listTasks } from '../collab/tasks.js';
import { listDocuments } from '../documents/documents.js';

export function homeSummaryHandler(req: AuthedRequest): Promise<ApiResponse> {
  return authed(req, async (ctx) => {
    const summary = await withTenant(ctx, async (tx) => {
      const [pending, needsReview, openTasks] = await Promise.all([
        listProposals(tx, ctx, { status: 'pending_approval' }),
        listDocuments(tx, ctx, { status: 'needs_review' }),
        listTasks(tx, ctx, { status: 'open' }),
      ]);
      return { pendingApprovals: pending.length, documentsNeedingReview: needsReview.length, openTasks: openTasks.length };
    });
    return { status: 200, body: summary };
  });
}
```

> Note: the three list queries run on the same `tx` via `Promise.all`. `pg`'s `PoolClient` serializes queries on one connection, so concurrent `tx.query` calls are safe (they queue) — but if a future change needs true parallelism, split into separate transactions. For three small counts this is fine.

- [ ] **Step 4: Run to verify it passes; full suite + typecheck**

Run: `npx vitest run tests/api/summary-handler.test.ts && npx vitest run && npm run typecheck`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/api/summary-handler.ts tests/api/summary-handler.test.ts
git commit -m "feat: mobile home summary handler (counts)"
```

---

## Self-review

**Spec coverage (design §4.3 mobile, §6.10 mobile app, §5 cabinet API):**
- Document capture from mobile → stored + drafted proposal (no OCR templates; the injected extractor does extraction) → Task 3. ✓
- Documents read API (the Plan 7 gap) → Task 1. ✓
- Notifications for approvals/deadlines delivered to devices → Task 2 (device tokens + pending-push query; the delivery worker consumes it). ✓
- Mobile core views (approvals/review/tasks counts) → Task 4; financial figures via the Plan 7 `financialsHandler`. ✓
- Everything behind the Plan 7 `authed()` per-client RBAC; capture drafts a `pending_approval` proposal (AI never posts directly). ✓

**Deliberately deferred (documented):** the **React Native app itself** (camera, one-tap send, offline queue, native screens, LV/RU/EN UI) — device/presentation layer, built interactively; **actual push delivery** (APNs/FCM) — an external integration over the `device_tokens` + pending-push source of truth; a **per-client accounting-config table** (receivables/VAT accounts, PostingTemplate) — currently injected/parameterized across Plans 3–6 and the capture factory; consolidating it into a table is a clean future task that would also let the home summary include live financial figures; the `node:http`/route wiring — trivial over these tested handlers when a server is stood up.

**Placeholder scan:** none — handlers reuse the real Plan 7 auth gate and real domain modules; capture runs the real Plan 3 pipeline with an injected extractor (stub in tests, Anthropic in prod). Orphan-blob-on-rollback is a documented, accepted MVP behavior.

**Type consistency:** consumed Plan 1–7 signatures match `main` (`authed`, `runIntake`, `createDocument`, `listProposals`/`listTasks`/`listDocuments`, `BlobStore`, `DocumentExtractor`, `PostingTemplate`). The capture factory injects deps by the same interfaces Plan 3 defined, so the mobile upload and the (future) email/Peppol intakes all converge on `runIntake` → the one approval flow.
