# AI/OCR Document Intake — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn an uploaded document into a validated, explainable **draft posting-proposal** — the platform's headline feature — with the AI kept behind a well-bounded, injectable adapter and every decision going through the Plan 2 proposal model.

**Architecture:** Extends the merged Plan 1 + Plan 2 monolith. External effects (blob storage, LLM extraction) sit behind **injectable interfaces** with hermetic test implementations, so the whole intake pipeline is unit- and integration-testable with no network or credentials. The pipeline — `capture → extract → record version → deterministically validate → resolve party → map to a balanced journal-entry payload → decide autonomy → create proposal` — produces a `posting` proposal (via Plan 2) that a human approves and posts through the Plan 1 ledger. The LLM never writes to the domain directly and never decides autonomy: validation and autonomy are deterministic, server-side code.

**Tech Stack:** Same as Plans 1–2 — Node 24+/TypeScript (strict, ESM), PostgreSQL 16, `pg`, `zod`, `vitest`, admin-run SQL migrations. Blob store uses the Node `fs` API. The real LLM extractor uses `fetch` to the Anthropic Messages API (no new dependency); it is integration-only (needs a key) — all pipeline tests inject a deterministic stub extractor.

## Global Constraints

- **Inherits all Plan 1 + Plan 2 constraints** (integer-cents money; `withTenant`; ENABLE+FORCE RLS + explicit `client_company_id` predicate on every tenant read; migrations run as admin, runtime role owns nothing and gets minimal grants; append-only where integrity matters; every state change audited in-transaction; the AI has no privileged write path — all agent output is a `proposal`).
- **The LLM is behind an injectable `DocumentExtractor` interface.** No pipeline code calls the network directly. Tests inject a deterministic stub. The real Anthropic-backed extractor is a thin adapter, integration-only (not unit-tested), and MUST be implemented using the **claude-api skill** for the correct model id and request shape.
- **Validation and autonomy are deterministic server-side code, never the LLM.** The LLM proposes fields; code decides whether they reconcile and whether a proposal may auto-submit.
- **Autonomy guardrails are absolute:** proposals of type `declaration` (and any tax filing), and any posting whose absolute total ≥ the client's material-sum threshold, are ALWAYS `pending_approval` regardless of the autonomy policy. Enforced in code, not in a prompt.
- **Migration numbering continues at 012.** Each new table migration ends with an explicit minimal `GRANT` to `bookkeeping_app`.

## Consumed interfaces (all on `main` after Plans 1–2)

```ts
// documents
createDocument(tx, ctx, {source,storageKey,mime,uploadedBy}) => {id}
getDocument(tx, ctx, id) => DocumentRow   // {id,source,storageKey,mime,status,partyId,journalEntryId,extractedData}
setDocumentStatus(tx, ctx, id, status)    // 'received'|'extracting'|'extracted'|'needs_review'|'posted'|'rejected'
recordExtraction(tx, ctx, documentId, {extractedData, confidence}) => {versionId}
// parties
listParties(tx, ctx, {kind?}) => PartyRow[]   // {id,kind,name,regNo,vatNo}
createParty(tx, ctx, {kind,name,regNo?,vatNo?}) => {id}
// proposals
createProposal(tx, ctx, {type,payload,rationale,documentId?,status?}) => {id}   // type 'posting'|..., status defaults 'suggested'
// ledger
NewJournalEntry { date; memo; currency; lines: {accountCode,debit,credit,description?}[]; sourceDocumentId?; reversesEntryId? }
// money
toCents(s) => bigint; sumCents(string[]) => bigint
```

## File structure

```
migrations/
  012_autonomy_policy.sql
src/
  blob/blob-store.ts          # BlobStore interface + LocalBlobStore (fs)
  intake/extraction-schema.ts # zod ExtractedInvoice + ExtractionResult types
  intake/extractor.ts         # DocumentExtractor interface + StubExtractor
  intake/anthropic-extractor.ts # real fetch-based adapter (integration-only)
  intake/validate.ts          # deterministic validateExtraction (pure)
  intake/resolve-party.ts     # resolveParty (find-or-flag)
  intake/map-posting.ts       # extractedToJournalEntry (pure) + PostingTemplate
  autonomy/autonomy.ts        # autonomy_policy table API + resolveAutonomy (guardrails)
  intake/intake.ts            # runIntake orchestration
tests/
  blob/blob-store.test.ts
  intake/extractor.test.ts
  intake/validate.test.ts
  intake/resolve-party.test.ts
  intake/map-posting.test.ts
  autonomy/autonomy.test.ts
  intake/intake.test.ts
```

**Interfaces produced (later plans / the agent consume these):**

```ts
interface BlobStore { put(key: string, bytes: Buffer, mime: string): Promise<void>; get(key: string): Promise<{ bytes: Buffer; mime: string }>; }
interface ExtractionResult { extractedData: ExtractedInvoice; confidence: Record<string, number>; }
interface DocumentExtractor { extract(bytes: Buffer, mime: string): Promise<ExtractionResult>; }
function validateExtraction(x: ExtractedInvoice, confidence: Record<string, number>, opts?: {minConfidence?: number}): ValidationReport;
function resolveParty(tx, ctx, x: ExtractedInvoice): Promise<{ partyId: string | null; isNew: boolean }>;
function extractedToJournalEntry(x: ExtractedInvoice, template: PostingTemplate): NewJournalEntry;
function resolveAutonomy(tx, ctx, operationType: string, opts: { amountCents: bigint }): Promise<'auto' | 'approval'>;
function runIntake(tx, ctx, args: { documentId: string; blob: BlobStore; extractor: DocumentExtractor; template: PostingTemplate }): Promise<{ proposalId: string; status: ProposalStatus }>;
```

---

## Task 1: Blob storage adapter

**Files:** Create `src/blob/blob-store.ts`; Test `tests/blob/blob-store.test.ts`.

**Interfaces:** Produces `BlobStore` interface + `LocalBlobStore`.

- [ ] **Step 1: Write the failing test — `tests/blob/blob-store.test.ts`**

```ts
import { afterAll, beforeAll, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalBlobStore } from '../../src/blob/blob-store.js';

let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'blob-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

test('put then get round-trips bytes and mime', async () => {
  const store = new LocalBlobStore(dir);
  await store.put('docs/a.jpg', Buffer.from('hello'), 'image/jpeg');
  const got = await store.get('docs/a.jpg');
  expect(got.bytes.toString()).toBe('hello');
  expect(got.mime).toBe('image/jpeg');
});

test('get throws for a missing key', async () => {
  const store = new LocalBlobStore(dir);
  await expect(store.get('nope/missing.pdf')).rejects.toThrow();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/blob/blob-store.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `src/blob/blob-store.ts`**

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface BlobStore {
  put(key: string, bytes: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<{ bytes: Buffer; mime: string }>;
}

/** Filesystem-backed blob store for dev/test. Stores bytes at <base>/<key> and mime at <base>/<key>.mime. */
export class LocalBlobStore implements BlobStore {
  constructor(private readonly baseDir: string) {}

  private path(key: string): string {
    return join(this.baseDir, key);
  }

  async put(key: string, bytes: Buffer, mime: string): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes);
    await writeFile(`${p}.mime`, mime, 'utf8');
  }

  async get(key: string): Promise<{ bytes: Buffer; mime: string }> {
    const p = this.path(key);
    const bytes = await readFile(p);
    const mime = await readFile(`${p}.mime`, 'utf8');
    return { bytes, mime };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/blob/blob-store.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/blob/blob-store.ts tests/blob/blob-store.test.ts
git commit -m "feat: local blob storage adapter"
```

---

## Task 2: Extraction schema + extractor interface + stub

**Files:** Create `src/intake/extraction-schema.ts`, `src/intake/extractor.ts`; Test `tests/intake/extractor.test.ts`.

**Interfaces:** Produces `ExtractedInvoice`, `ExtractionResult`, `DocumentExtractor`, `StubExtractor`.

- [ ] **Step 1: Write the failing test — `tests/intake/extractor.test.ts`**

```ts
import { expect, test } from 'vitest';
import { StubExtractor } from '../../src/intake/extractor.js';
import { extractedInvoiceSchema } from '../../src/intake/extraction-schema.js';

test('StubExtractor returns a schema-valid extraction', async () => {
  const ex = new StubExtractor({
    extractedData: {
      supplierName: 'SIA Piegādātājs', supplierRegNo: '40100000000',
      date: '2026-03-10', currency: 'EUR',
      lineItems: [{ description: 'Prece', net: '100.00', vatRate: 21, vat: '21.00' }],
      vatTotal: '21.00', netTotal: '100.00', grandTotal: '121.00',
    },
    confidence: { supplierName: 0.98, grandTotal: 0.95 },
  });
  const res = await ex.extract(Buffer.from('x'), 'image/jpeg');
  expect(() => extractedInvoiceSchema.parse(res.extractedData)).not.toThrow();
  expect(res.confidence.grandTotal).toBe(0.95);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/intake/extractor.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Create `src/intake/extraction-schema.ts`**

```ts
import { z } from 'zod';

const money = z.string().regex(/^-?\d+(\.\d{1,2})?$/);

export const lineItemSchema = z.object({
  description: z.string(),
  net: money,
  vatRate: z.number(),
  vat: money,
});

export const extractedInvoiceSchema = z.object({
  supplierName: z.string(),
  supplierRegNo: z.string().nullable().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  currency: z.string().length(3),
  lineItems: z.array(lineItemSchema).min(1),
  vatTotal: money,
  netTotal: money,
  grandTotal: money,
});

export type ExtractedInvoice = z.infer<typeof extractedInvoiceSchema>;
export interface ExtractionResult { extractedData: ExtractedInvoice; confidence: Record<string, number>; }
```

- [ ] **Step 4: Create `src/intake/extractor.ts`**

```ts
import type { ExtractionResult } from './extraction-schema.js';

export interface DocumentExtractor {
  extract(bytes: Buffer, mime: string): Promise<ExtractionResult>;
}

/** Deterministic extractor for tests: returns whatever it was constructed with. */
export class StubExtractor implements DocumentExtractor {
  constructor(private readonly canned: ExtractionResult) {}
  async extract(_bytes: Buffer, _mime: string): Promise<ExtractionResult> {
    return this.canned;
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/intake/extractor.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/intake/extraction-schema.ts src/intake/extractor.ts tests/intake/extractor.test.ts
git commit -m "feat: extraction schema + extractor interface with stub"
```

---

## Task 3: Deterministic validation

**Files:** Create `src/intake/validate.ts`; Test `tests/intake/validate.test.ts`.

**Interfaces:** Produces `ValidationReport`, `validateExtraction`.

- [ ] **Step 1: Write the failing test — `tests/intake/validate.test.ts`**

```ts
import { expect, test } from 'vitest';
import { validateExtraction } from '../../src/intake/validate.js';
import type { ExtractedInvoice } from '../../src/intake/extraction-schema.js';

const good: ExtractedInvoice = {
  supplierName: 'SIA X', supplierRegNo: '40100000000', date: '2026-03-10', currency: 'EUR',
  lineItems: [{ description: 'A', net: '100.00', vatRate: 21, vat: '21.00' }],
  vatTotal: '21.00', netTotal: '100.00', grandTotal: '121.00',
};

test('a consistent invoice validates clean', () => {
  const r = validateExtraction(good, { supplierName: 0.99, grandTotal: 0.97 });
  expect(r.valid).toBe(true);
  expect(r.issues).toEqual([]);
});

test('flags a total that does not reconcile', () => {
  const bad = { ...good, grandTotal: '130.00' };
  const r = validateExtraction(bad, { grandTotal: 0.99 });
  expect(r.valid).toBe(false);
  expect(r.issues.join(' ')).toMatch(/reconcile|total/i);
});

test('flags net+vat mismatch against line items', () => {
  const bad = { ...good, netTotal: '90.00' }; // lines sum to 100
  const r = validateExtraction(bad, {});
  expect(r.valid).toBe(false);
});

test('flags low-confidence fields below threshold', () => {
  const r = validateExtraction(good, { supplierName: 0.4 }, { minConfidence: 0.7 });
  expect(r.lowConfidenceFields).toContain('supplierName');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/intake/validate.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `src/intake/validate.ts`**

```ts
import type { ExtractedInvoice } from './extraction-schema.js';
import { toCents, sumCents } from '../db/money.js';

export interface ValidationReport { valid: boolean; issues: string[]; lowConfidenceFields: string[]; }

export function validateExtraction(
  x: ExtractedInvoice,
  confidence: Record<string, number>,
  opts: { minConfidence?: number } = {},
): ValidationReport {
  const issues: string[] = [];
  const min = opts.minConfidence ?? 0.7;

  // Line items must sum to the declared net and vat totals.
  const netFromLines = sumCents(x.lineItems.map((l) => l.net));
  const vatFromLines = sumCents(x.lineItems.map((l) => l.vat));
  if (netFromLines !== toCents(x.netTotal)) {
    issues.push(`Net total ${x.netTotal} does not reconcile with line items (${netFromLines} cents)`);
  }
  if (vatFromLines !== toCents(x.vatTotal)) {
    issues.push(`VAT total ${x.vatTotal} does not reconcile with line items (${vatFromLines} cents)`);
  }
  // Grand total must equal net + vat.
  if (toCents(x.grandTotal) !== toCents(x.netTotal) + toCents(x.vatTotal)) {
    issues.push(`Grand total ${x.grandTotal} does not equal net ${x.netTotal} + VAT ${x.vatTotal}`);
  }

  const lowConfidenceFields = Object.entries(confidence)
    .filter(([, c]) => c < min)
    .map(([field]) => field);

  return { valid: issues.length === 0, issues, lowConfidenceFields };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/intake/validate.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/intake/validate.ts tests/intake/validate.test.ts
git commit -m "feat: deterministic extraction validation"
```

---

## Task 4: Party resolution

**Files:** Create `src/intake/resolve-party.ts`; Test `tests/intake/resolve-party.test.ts`.

**Interfaces:** Consumes `listParties`, `createParty` (Plan 2). Produces `resolveParty`.

- [ ] **Step 1: Write the failing test — `tests/intake/resolve-party.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createParty } from '../../src/parties/parties.js';
import { resolveParty } from '../../src/intake/resolve-party.js';
import type { ExtractedInvoice } from '../../src/intake/extraction-schema.js';

const inv = (regNo: string | null): ExtractedInvoice => ({
  supplierName: 'SIA Piegādātājs', supplierRegNo: regNo, date: '2026-03-10', currency: 'EUR',
  lineItems: [{ description: 'A', net: '100.00', vatRate: 21, vat: '21.00' }],
  vatTotal: '21.00', netTotal: '100.00', grandTotal: '121.00',
});

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('resolves to an existing vendor by reg number', async () => {
  const t = await makeFirmAndClient();
  const existing = await withTenant(ctx(t), (tx) => createParty(tx, ctx(t), { kind: 'vendor', name: 'SIA Piegādātājs', regNo: '40100000000' }));
  const r = await withTenant(ctx(t), (tx) => resolveParty(tx, ctx(t), inv('40100000000')));
  expect(r.partyId).toBe(existing.id);
  expect(r.isNew).toBe(false);
});

test('flags a new supplier when no reg match exists', async () => {
  const t = await makeFirmAndClient();
  const r = await withTenant(ctx(t), (tx) => resolveParty(tx, ctx(t), inv('49999999999')));
  expect(r.partyId).toBeNull();
  expect(r.isNew).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/intake/resolve-party.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `src/intake/resolve-party.ts`**

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import type { ExtractedInvoice } from './extraction-schema.js';
import { listParties } from '../parties/parties.js';

/** Find an existing vendor/both party matching the supplier reg number; otherwise flag as new. */
export async function resolveParty(
  tx: PoolClient, ctx: TenantContext, x: ExtractedInvoice,
): Promise<{ partyId: string | null; isNew: boolean }> {
  if (!x.supplierRegNo) return { partyId: null, isNew: true };
  const parties = await listParties(tx, ctx);
  const match = parties.find((p) => (p.kind === 'vendor' || p.kind === 'both') && p.regNo === x.supplierRegNo);
  return match ? { partyId: match.id, isNew: false } : { partyId: null, isNew: true };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/intake/resolve-party.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/intake/resolve-party.ts tests/intake/resolve-party.test.ts
git commit -m "feat: party resolution from extracted supplier"
```

---

## Task 5: Draft posting mapping

**Files:** Create `src/intake/map-posting.ts`; Test `tests/intake/map-posting.test.ts`.

**Interfaces:** Produces `PostingTemplate`, `extractedToJournalEntry`.

A purchase invoice maps to: debit expense (net), debit VAT-input (vat), credit payables (gross). Account codes come from an injected `PostingTemplate` (per-client config; a default is provided but not hardcoded into the mapper). The produced `NewJournalEntry` must balance.

- [ ] **Step 1: Write the failing test — `tests/intake/map-posting.test.ts`**

```ts
import { expect, test } from 'vitest';
import { extractedToJournalEntry, type PostingTemplate } from '../../src/intake/map-posting.js';
import { sumCents } from '../../src/db/money.js';
import type { ExtractedInvoice } from '../../src/intake/extraction-schema.js';

const template: PostingTemplate = { expenseAccount: '7710', vatInputAccount: '5721', payablesAccount: '5310' };
const inv: ExtractedInvoice = {
  supplierName: 'SIA X', supplierRegNo: '40100000000', date: '2026-03-10', currency: 'EUR',
  lineItems: [{ description: 'A', net: '100.00', vatRate: 21, vat: '21.00' }],
  vatTotal: '21.00', netTotal: '100.00', grandTotal: '121.00',
};

test('maps a purchase invoice to a balanced 3-line entry', () => {
  const entry = extractedToJournalEntry(inv, template);
  expect(entry.date).toBe('2026-03-10');
  expect(entry.currency).toBe('EUR');
  const debits = sumCents(entry.lines.map((l) => l.debit));
  const credits = sumCents(entry.lines.map((l) => l.credit));
  expect(debits).toBe(credits);
  // net→expense debit, vat→vat-input debit, gross→payables credit
  const byAcct = Object.fromEntries(entry.lines.map((l) => [l.accountCode, l]));
  expect(byAcct['7710'].debit).toBe('100.00');
  expect(byAcct['5721'].debit).toBe('21.00');
  expect(byAcct['5310'].credit).toBe('121.00');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/intake/map-posting.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `src/intake/map-posting.ts`**

```ts
import type { ExtractedInvoice } from './extraction-schema.js';
import type { NewJournalEntry } from '../ledger/posting.js';

export interface PostingTemplate {
  expenseAccount: string;
  vatInputAccount: string;
  payablesAccount: string;
}

/** Map a purchase invoice to a balanced double-entry: DR expense (net), DR VAT-input (vat), CR payables (gross). */
export function extractedToJournalEntry(x: ExtractedInvoice, template: PostingTemplate): NewJournalEntry {
  return {
    date: x.date,
    memo: `Purchase — ${x.supplierName}`,
    currency: x.currency,
    lines: [
      { accountCode: template.expenseAccount, debit: x.netTotal, credit: '0', description: 'Net' },
      { accountCode: template.vatInputAccount, debit: x.vatTotal, credit: '0', description: 'VAT input' },
      { accountCode: template.payablesAccount, debit: '0', credit: x.grandTotal, description: 'Payable' },
    ],
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/intake/map-posting.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/intake/map-posting.ts tests/intake/map-posting.test.ts
git commit -m "feat: map extracted invoice to balanced journal entry"
```

---

## Task 6: Autonomy policy + guardrails

**Files:** Create `migrations/012_autonomy_policy.sql`, `src/autonomy/autonomy.ts`; Test `tests/autonomy/autonomy.test.ts`.

**Interfaces:** Produces `setAutonomy`, `resolveAutonomy`. `resolveAutonomy` returns `'auto'` only if a policy row says so AND no guardrail forces approval.

Guardrails (absolute): `operationType === 'declaration'` → always `'approval'`; `amountCents >= materialThresholdCents` → always `'approval'`. Default material threshold: **100000 cents (1000.00)**, configurable per client via the policy table.

- [ ] **Step 1: Create `migrations/012_autonomy_policy.sql`**

```sql
CREATE TABLE autonomy_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  operation_type text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('auto','approval')),
  material_threshold_cents bigint NOT NULL DEFAULT 100000,
  UNIQUE (client_company_id, operation_type)
);

ALTER TABLE autonomy_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE autonomy_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY autonomy_tenant_isolation ON autonomy_policy
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON autonomy_policy TO bookkeeping_app;
```

- [ ] **Step 2: Write the failing test — `tests/autonomy/autonomy.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { setAutonomy, resolveAutonomy } from '../../src/autonomy/autonomy.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('defaults to approval when no policy exists', async () => {
  const t = await makeFirmAndClient();
  const mode = await withTenant(ctx(t), (tx) => resolveAutonomy(tx, ctx(t), 'posting', { amountCents: 5000n }));
  expect(mode).toBe('approval');
});

test('auto when policy says auto and below threshold', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), (tx) => setAutonomy(tx, ctx(t), { operationType: 'posting', mode: 'auto', materialThresholdCents: 100000n }));
  const mode = await withTenant(ctx(t), (tx) => resolveAutonomy(tx, ctx(t), 'posting', { amountCents: 5000n }));
  expect(mode).toBe('auto');
});

test('guardrail: at/above material threshold forces approval even when policy is auto', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), (tx) => setAutonomy(tx, ctx(t), { operationType: 'posting', mode: 'auto', materialThresholdCents: 100000n }));
  const mode = await withTenant(ctx(t), (tx) => resolveAutonomy(tx, ctx(t), 'posting', { amountCents: 100000n }));
  expect(mode).toBe('approval');
});

test('guardrail: declarations always require approval', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), (tx) => setAutonomy(tx, ctx(t), { operationType: 'declaration', mode: 'auto', materialThresholdCents: 100000n }));
  const mode = await withTenant(ctx(t), (tx) => resolveAutonomy(tx, ctx(t), 'declaration', { amountCents: 1n }));
  expect(mode).toBe('approval');
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/autonomy/autonomy.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Create `src/autonomy/autonomy.ts`**

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appendAudit } from '../audit/audit.js';

export type AutonomyMode = 'auto' | 'approval';

/** Operation types that may NEVER auto-execute, regardless of policy. */
const ALWAYS_APPROVAL = new Set(['declaration']);

export async function setAutonomy(
  tx: PoolClient, ctx: TenantContext,
  input: { operationType: string; mode: AutonomyMode; materialThresholdCents?: bigint },
): Promise<void> {
  await tx.query(
    `INSERT INTO autonomy_policy(client_company_id, operation_type, mode, material_threshold_cents)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (client_company_id, operation_type)
     DO UPDATE SET mode = EXCLUDED.mode, material_threshold_cents = EXCLUDED.material_threshold_cents`,
    [ctx.clientCompanyId, input.operationType, input.mode, (input.materialThresholdCents ?? 100000n).toString()],
  );
  await appendAudit(tx, ctx, { action: 'set', entityType: 'autonomy_policy', entityId: null, before: null, after: input });
}

export async function resolveAutonomy(
  tx: PoolClient, ctx: TenantContext, operationType: string, opts: { amountCents: bigint },
): Promise<AutonomyMode> {
  if (ALWAYS_APPROVAL.has(operationType)) return 'approval';

  const res = await tx.query(
    `SELECT mode, material_threshold_cents AS "threshold"
     FROM autonomy_policy WHERE client_company_id = $1 AND operation_type = $2`,
    [ctx.clientCompanyId, operationType],
  );
  const row = res.rows[0];
  if (!row || row.mode !== 'auto') return 'approval';       // default-closed
  if (opts.amountCents >= BigInt(row.threshold)) return 'approval'; // material-sum guardrail
  return 'auto';
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/autonomy/autonomy.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add migrations/012_autonomy_policy.sql src/autonomy/autonomy.ts tests/autonomy/autonomy.test.ts
git commit -m "feat: autonomy policy with absolute guardrails"
```

---

## Task 7: Intake orchestration (end-to-end)

**Files:** Create `src/intake/intake.ts`; Test `tests/intake/intake.test.ts`.

**Interfaces:** Consumes everything above + `getDocument`/`setDocumentStatus`/`recordExtraction` (Plan 2), `createProposal` (Plan 2), `toCents` (Plan 1). Produces `runIntake`.

Pipeline: load the document → fetch bytes from the blob store → `extractor.extract` → `recordExtraction` (stores version + sets doc `extracted`) → `validateExtraction` → `resolveParty` → `extractedToJournalEntry` → `resolveAutonomy` (opType `posting`, amount = grandTotal) → `createProposal` (type `posting`, payload = the entry, rationale carries the extraction + validation + party). If validation fails OR low-confidence fields exist → proposal `pending_approval` and document `needs_review`; else the autonomy result decides `suggested`/auto vs `pending_approval`. (Auto-posting itself is out of scope here — even `auto` creates a `suggested` proposal for now; actual auto-post is wired in a later plan. The distinction is recorded in the rationale.)

- [ ] **Step 1: Write the failing test — `tests/intake/intake.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { LocalBlobStore } from '../../src/blob/blob-store.js';
import { StubExtractor } from '../../src/intake/extractor.js';
import { createDocument, getDocument } from '../../src/documents/documents.js';
import { getProposal } from '../../src/proposals/proposals.js';
import { runIntake } from '../../src/intake/intake.js';
import type { PostingTemplate } from '../../src/intake/map-posting.js';

let dir: string;
const template: PostingTemplate = { expenseAccount: '7710', vatInputAccount: '5721', payablesAccount: '5310' };
const canned = {
  extractedData: {
    supplierName: 'SIA Piegādātājs', supplierRegNo: '40100000000', date: '2026-03-10', currency: 'EUR',
    lineItems: [{ description: 'Prece', net: '100.00', vatRate: 21, vat: '21.00' }],
    vatTotal: '21.00', netTotal: '100.00', grandTotal: '121.00',
  },
  confidence: { supplierName: 0.98, grandTotal: 0.97 },
};

beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'intake-')); await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); await closeDb(); });

test('a clean document produces a posting proposal and marks the document extracted', async () => {
  const t = await makeFirmAndClient();
  const blob = new LocalBlobStore(dir);
  await blob.put('doc-1', Buffer.from('fake-image'), 'image/jpeg');

  const { proposalId, docId } = await withTenant(ctx(t), async (tx) => {
    const doc = await createDocument(tx, ctx(t), { source: 'mobile', storageKey: 'doc-1', mime: 'image/jpeg', uploadedBy: 'u' });
    const r = await runIntake(tx, ctx(t), { documentId: doc.id, blob, extractor: new StubExtractor(canned), template });
    return { proposalId: r.proposalId, docId: doc.id };
  });

  const [prop, doc] = await withTenant(ctx(t), async (tx) => [
    await getProposal(tx, ctx(t), proposalId),
    await getDocument(tx, ctx(t), docId),
  ]);
  expect(prop.type).toBe('posting');
  expect((prop.payload as { lines: unknown[] }).lines).toHaveLength(3);
  expect(prop.documentId).toBe(docId);
  expect(doc.status).toBe('extracted');
  expect(doc.extractedData).toMatchObject({ grandTotal: '121.00' });
});

test('a non-reconciling document yields needs_review + pending_approval', async () => {
  const t = await makeFirmAndClient();
  const blob = new LocalBlobStore(dir);
  await blob.put('doc-2', Buffer.from('x'), 'image/jpeg');
  const bad = { extractedData: { ...canned.extractedData, grandTotal: '999.00' }, confidence: canned.confidence };

  const { proposalId, docId, status } = await withTenant(ctx(t), async (tx) => {
    const doc = await createDocument(tx, ctx(t), { source: 'mobile', storageKey: 'doc-2', mime: 'image/jpeg', uploadedBy: 'u' });
    const r = await runIntake(tx, ctx(t), { documentId: doc.id, blob, extractor: new StubExtractor(bad), template });
    return { proposalId: r.proposalId, docId: doc.id, status: r.status };
  });

  const doc = await withTenant(ctx(t), (tx) => getDocument(tx, ctx(t), docId));
  expect(status).toBe('pending_approval');
  expect(doc.status).toBe('needs_review');
  const prop = await withTenant(ctx(t), (tx) => getProposal(tx, ctx(t), proposalId));
  expect((prop.rationale as { validationIssues?: string[] }).validationIssues?.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/intake/intake.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `src/intake/intake.ts`**

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import type { BlobStore } from '../blob/blob-store.js';
import type { DocumentExtractor } from './extractor.js';
import { extractedInvoiceSchema } from './extraction-schema.js';
import { getDocument, setDocumentStatus } from '../documents/documents.js';
import { recordExtraction } from '../documents/extraction.js';
import { validateExtraction } from './validate.js';
import { resolveParty } from './resolve-party.js';
import { extractedToJournalEntry, type PostingTemplate } from './map-posting.js';
import { resolveAutonomy } from '../autonomy/autonomy.js';
import { createProposal, type ProposalStatus } from '../proposals/proposals.js';
import { toCents } from '../db/money.js';

export async function runIntake(
  tx: PoolClient, ctx: TenantContext,
  args: { documentId: string; blob: BlobStore; extractor: DocumentExtractor; template: PostingTemplate },
): Promise<{ proposalId: string; status: ProposalStatus }> {
  const doc = await getDocument(tx, ctx, args.documentId);

  // Extract (LLM behind the adapter).
  await setDocumentStatus(tx, ctx, doc.id, 'extracting');
  const { bytes, mime } = await args.blob.get(doc.storageKey);
  const result = await args.extractor.extract(bytes, mime);
  const extracted = extractedInvoiceSchema.parse(result.extractedData);

  // Persist the extraction version (also sets document status 'extracted').
  await recordExtraction(tx, ctx, doc.id, { extractedData: extracted, confidence: result.confidence });

  // Deterministic validation + party resolution.
  const report = validateExtraction(extracted, result.confidence);
  const party = await resolveParty(tx, ctx, extracted);
  const needsReview = !report.valid || report.lowConfidenceFields.length > 0 || party.isNew;

  // Draft the posting.
  const entry = { ...extractedToJournalEntry(extracted, args.template), sourceDocumentId: doc.id };

  // Decide status: guardrails + validation gate.
  const autonomy = await resolveAutonomy(tx, ctx, 'posting', { amountCents: toCents(extracted.grandTotal) < 0n ? -toCents(extracted.grandTotal) : toCents(extracted.grandTotal) });
  const status: ProposalStatus = needsReview || autonomy === 'approval' ? 'pending_approval' : 'suggested';

  const { id: proposalId } = await createProposal(tx, ctx, {
    type: 'posting',
    documentId: doc.id,
    payload: entry,
    status,
    rationale: {
      ruleRef: 'purchase-invoice-template',
      computation: `net ${extracted.netTotal} + VAT ${extracted.vatTotal} = ${extracted.grandTotal}`,
      sourceRefs: { documentId: doc.id, partyId: party.partyId, partyIsNew: party.isNew },
      validationIssues: report.issues,
      lowConfidenceFields: report.lowConfidenceFields,
      autonomy,
    },
  });

  await setDocumentStatus(tx, ctx, doc.id, needsReview ? 'needs_review' : 'extracted');
  return { proposalId, status };
}
```

> Note on `createProposal`'s `rationale` type: it is typed `Rationale` with `.passthrough()` in Plan 2, so the extra keys (`validationIssues`, `lowConfidenceFields`, `autonomy`) are accepted and stored. Confirm this compiles; if the type is too strict, widen the `rationale` argument type to `Record<string, unknown>` at the call site.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/intake/intake.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run full suite + typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add src/intake/intake.ts tests/intake/intake.test.ts
git commit -m "feat: document intake orchestration (extract -> validate -> draft proposal)"
```

---

## Task 8: Real Anthropic extractor adapter (integration-only)

**Files:** Create `src/intake/anthropic-extractor.ts`. No unit test (needs a live key); must typecheck and be documented.

**Interfaces:** Produces `AnthropicExtractor implements DocumentExtractor`.

> **The implementer MUST consult the `claude-api` skill** for the current model id, the Messages API request/response shape, and how to send an image (base64 `image` content block) + a JSON-output instruction. Do not guess the model id.

- [ ] **Step 1: Create `src/intake/anthropic-extractor.ts`** (uses `fetch`; no new dependency)

```ts
import type { DocumentExtractor } from './extractor.js';
import { extractedInvoiceSchema, type ExtractionResult } from './extraction-schema.js';

/**
 * Real extractor backed by the Anthropic Messages API. Integration-only: requires ANTHROPIC_API_KEY.
 * Not unit-tested (all pipeline tests use StubExtractor). The model id, request shape, and image
 * content-block format MUST be taken from the claude-api skill, not memory.
 */
export class AnthropicExtractor implements DocumentExtractor {
  constructor(
    private readonly apiKey = process.env.ANTHROPIC_API_KEY ?? '',
    private readonly model = process.env.EXTRACTOR_MODEL ?? '<set-from-claude-api-skill>',
  ) {}

  async extract(bytes: Buffer, mime: string): Promise<ExtractionResult> {
    if (!this.apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
    const body = {
      model: this.model,
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data: bytes.toString('base64') } },
          { type: 'text', text: 'Extract this invoice as JSON matching {supplierName, supplierRegNo, date (YYYY-MM-DD), currency, lineItems:[{description,net,vatRate,vat}], vatTotal, netTotal, grandTotal}. Also return a confidence 0-1 per top-level field. Respond ONLY with JSON {extractedData, confidence}.' },
        ],
      }],
    };
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { content: { type: string; text?: string }[] };
    const text = json.content.find((c) => c.type === 'text')?.text ?? '{}';
    const parsed = JSON.parse(text) as { extractedData: unknown; confidence: Record<string, number> };
    return { extractedData: extractedInvoiceSchema.parse(parsed.extractedData), confidence: parsed.confidence ?? {} };
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean. (The `anthropic-version` header value and model id should be confirmed against the claude-api skill; update the placeholder model default accordingly.)

- [ ] **Step 3: Commit**

```bash
git add src/intake/anthropic-extractor.ts
git commit -m "feat: Anthropic-backed document extractor (integration-only)"
```

---

## Self-review

**Spec coverage (design §4 AI agent, §6.7 doc recognition):**
- Capture → extract (no templates, behind adapter) → structured fields + confidence → Tasks 1, 2, 8. ✓
- Deterministic validation (totals reconcile, VAT math, low-confidence flags) → Task 3. ✓
- Supplier resolves to a party or flagged new → Task 4. ✓
- Draft posting with rationale + source refs → Tasks 5, 7. ✓
- Autonomy configurable per client × operation type, with absolute guardrails (taxes/declarations, material sums always approval) → Task 6. ✓
- Everything becomes a proposal through Plan 2; the LLM has no privileged write path and does not decide autonomy → Task 7. ✓

**Deliberately deferred:** actual auto-posting of `auto` proposals (a later plan wires the auto-post step; here `auto` still yields a `suggested` proposal, recorded in rationale); the conversational assistant (Phase 2); per-client default `PostingTemplate` configuration UI (comes with the cabinet, Plan 7) — the mapper takes the template as input. Real extractor accuracy is an integration concern verified with a live key, not in CI.

**Placeholder scan:** the only intentional placeholder is the model-id default in `anthropic-extractor.ts`, which the implementer resolves via the claude-api skill; it is documented, not a silent TODO. All testable code is complete.

**Type consistency:** consumed Plan 1/2 signatures match `main` verbatim; `ExtractedInvoice`, `ExtractionResult`, `DocumentExtractor`, `PostingTemplate`, `ValidationReport` are used identically across Tasks 2–8. The `rationale` passthrough assumption in Task 7 is called out with a fallback.
