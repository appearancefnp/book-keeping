# Parties, Documents & the Proposal/Approval Model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the cross-cutting substrate the AI agent and the cabinet both depend on: business parties (debtors/creditors), a document store with extraction + version history, and a generic **proposal object** with an audited approval lifecycle that posts through the existing Ledger.

**Architecture:** Extends the merged foundation (Plan 1) in the same modular monolith. Three new modules — `parties`, `documents`, `proposals` — each with its own RLS-protected tables. The proposal model is the heart: every AI (or human) action is a `proposal` row (`suggested → pending_approval → approved/rejected → posted`) carrying an immutable payload + rationale + source references. Approving a `posting` proposal calls the foundation's `postEntry` in one transaction, links the source document to the produced journal entry, and records audit. This is the data-model realization of "does the work, asks approval, always explains."

**Tech Stack:** Same as Plan 1 — Node 24+/TypeScript (strict, ESM), PostgreSQL 16, `pg`, `zod`, `vitest`, raw SQL migrations run **as admin** by the in-repo runner. Docker/Colima Postgres for tests.

## Global Constraints

- **Inherits all Plan 1 constraints.** Money is `NUMERIC`/integer-cents; all DB access inside `withTenant`; every tenant table has `ENABLE` + `FORCE ROW LEVEL SECURITY` + a tenant policy on `current_setting('app.current_client_id', true)::uuid`; tenant-table **reads carry an explicit `client_company_id` predicate** in addition to RLS.
- **Migrations run as admin (owner), never as `bookkeeping_app`.** Migration numbering continues at **008**. Each new table migration ends with an explicit `GRANT` to `bookkeeping_app` (the runtime role owns nothing). Grant only what the module needs: `SELECT, INSERT` always; add `UPDATE` only where a documented operation requires it (`documents`, `proposals`, `parties`); **never** `DELETE`/`TRUNCATE`, and never `UPDATE` on append-only tables (`document_versions`).
- **Every state transition appends an audit row** (`appendAudit`) in the same transaction as the change.
- **Proposal core fields are immutable.** `type`, `payload`, `rationale`, `created_at` cannot be changed after insert — enforced by a DB trigger. Only lifecycle fields (`status`, `resolved_entry_id`, `resolved_by`, `resolved_at`, `reject_reason`) may be updated.
- **`document_versions` is append-only** (like the journal) — no UPDATE/DELETE, enforced by a trigger.
- **Proposal status values:** exactly `suggested | pending_approval | approved | rejected | posted`. **Proposal types:** exactly `posting | bank_match | declaration | task`.
- **Blob storage boundary:** documents store a `storage_key` (string reference to object storage) + metadata + extracted data. Uploading/serving the actual file bytes is out of scope here (belongs to Plan 3 / infra); this plan stores and links the reference.

## Consumed foundation interfaces (all exist on `main`)

```ts
// src/tenancy/context.ts
interface TenantContext { firmId: string; clientCompanyId: string; actorId: string; actorRole: string }
// src/db/pool.ts
function withTenant<T>(ctx: TenantContext, fn: (tx: PoolClient) => Promise<T>): Promise<T>
// src/ledger/posting.ts
interface NewJournalEntry { date: string; memo: string; currency: string; lines: NewJournalLine[]; sourceDocumentId?: string | null; reversesEntryId?: string | null }
function postEntry(tx: PoolClient, ctx: TenantContext, entry: NewJournalEntry): Promise<{ entryId: string }>
// src/audit/audit.ts
function appendAudit(tx: PoolClient, ctx: TenantContext, a: { action: string; entityType: string; entityId: string | null; before: unknown|null; after: unknown|null }): Promise<void>
// tests/helpers/db.ts
resetDb(), closeDb(), makeFirmAndClient(name?), ctx(t)
```

## File structure

```
migrations/
  008_parties.sql            # parties table + RLS + grants
  009_documents.sql          # documents table + RLS + grants (incl UPDATE)
  010_document_versions.sql  # append-only extraction versions + trigger + RLS + grants
  011_proposals.sql          # proposals table + immutability trigger + RLS + grants
src/
  parties/parties.ts         # createParty, getParty, listParties, updateParty
  documents/documents.ts     # createDocument, getDocument, listDocuments, setDocumentStatus
  documents/extraction.ts    # recordExtraction, getExtractionHistory
  proposals/proposals.ts     # createProposal, getProposal, listProposals (approval queue)
  proposals/lifecycle.ts     # submitForApproval, approveProposal, rejectProposal
  proposals/post-proposal.ts # postApprovedPosting (ties proposal → ledger.postEntry)
tests/
  parties/parties.test.ts
  documents/documents.test.ts
  documents/extraction.test.ts
  proposals/proposals.test.ts
  proposals/lifecycle.test.ts
  proposals/post-proposal.test.ts
```

**Interfaces produced by this plan** (Plan 3 — AI/OCR — consumes these):

```ts
// src/documents/documents.ts
type DocumentSource = 'mobile' | 'web' | 'email' | 'peppol';
type DocumentStatus = 'received' | 'extracting' | 'extracted' | 'needs_review' | 'posted' | 'rejected';
interface DocumentRow { id: string; source: DocumentSource; storageKey: string; mime: string; status: DocumentStatus; partyId: string | null; journalEntryId: string | null; extractedData: unknown | null }
function createDocument(tx, ctx, input: { source: DocumentSource; storageKey: string; mime: string; uploadedBy: string }): Promise<{ id: string }>
function getDocument(tx, ctx, id: string): Promise<DocumentRow>
function listDocuments(tx, ctx, filter?: { status?: DocumentStatus }): Promise<DocumentRow[]>
function setDocumentStatus(tx, ctx, id: string, status: DocumentStatus): Promise<void>
// src/documents/extraction.ts
function recordExtraction(tx, ctx, documentId: string, extraction: { extractedData: unknown; confidence: unknown }): Promise<{ versionId: string }>
// src/proposals/proposals.ts
type ProposalType = 'posting' | 'bank_match' | 'declaration' | 'task';
type ProposalStatus = 'suggested' | 'pending_approval' | 'approved' | 'rejected' | 'posted';
interface Rationale { ruleRef?: string; computation?: string; sourceRefs?: unknown }
function createProposal(tx, ctx, input: { type: ProposalType; payload: unknown; rationale: Rationale; documentId?: string | null; status?: ProposalStatus }): Promise<{ id: string }>
function getProposal(tx, ctx, id: string): Promise<ProposalRow>
function listProposals(tx, ctx, filter?: { status?: ProposalStatus }): Promise<ProposalRow[]>
// src/proposals/lifecycle.ts
function submitForApproval(tx, ctx, id: string): Promise<void>
function approveProposal(tx, ctx, id: string): Promise<void>
function rejectProposal(tx, ctx, id: string, reason: string): Promise<void>
// src/proposals/post-proposal.ts
function postApprovedPosting(tx, ctx, proposalId: string): Promise<{ entryId: string }>
```

---

## Task 1: Parties (debtors/creditors)

**Files:**
- Create: `migrations/008_parties.sql`, `src/parties/parties.ts`
- Test: `tests/parties/parties.test.ts`

**Interfaces:**
- Consumes: `withTenant`, `TenantContext`, `appendAudit`.
- Produces: `createParty`, `getParty`, `listParties`, `updateParty`, `PartyKind`, `PartyRow`.

- [ ] **Step 1: Create `migrations/008_parties.sql`**

```sql
CREATE TABLE parties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  kind text NOT NULL CHECK (kind IN ('customer','vendor','both')),
  name text NOT NULL,
  reg_no text,
  vat_no text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_company_id, kind, reg_no)
);
CREATE INDEX parties_client_idx ON parties(client_company_id);

ALTER TABLE parties ENABLE ROW LEVEL SECURITY;
ALTER TABLE parties FORCE ROW LEVEL SECURITY;
CREATE POLICY parties_tenant_isolation ON parties
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON parties TO bookkeeping_app;
```

- [ ] **Step 2: Write the failing test — `tests/parties/parties.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createParty, getParty, listParties, updateParty } from '../../src/parties/parties.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('creates a vendor and reads it back', async () => {
  const t = await makeFirmAndClient();
  const { id } = await withTenant(ctx(t), (tx) => createParty(tx, ctx(t), { kind: 'vendor', name: 'SIA Piegādātājs', regNo: '40100000000' }));
  const p = await withTenant(ctx(t), (tx) => getParty(tx, ctx(t), id));
  expect(p.kind).toBe('vendor');
  expect(p.name).toBe('SIA Piegādātājs');
});

test('lists parties filtered by kind, ordered by name', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await createParty(tx, ctx(t), { kind: 'customer', name: 'Beta' });
    await createParty(tx, ctx(t), { kind: 'customer', name: 'Alfa' });
    await createParty(tx, ctx(t), { kind: 'vendor', name: 'Gamma' });
  });
  const customers = await withTenant(ctx(t), (tx) => listParties(tx, ctx(t), { kind: 'customer' }));
  expect(customers.map((p) => p.name)).toEqual(['Alfa', 'Beta']);
});

test('updateParty changes mutable fields', async () => {
  const t = await makeFirmAndClient();
  const { id } = await withTenant(ctx(t), (tx) => createParty(tx, ctx(t), { kind: 'customer', name: 'Old' }));
  await withTenant(ctx(t), (tx) => updateParty(tx, ctx(t), id, { name: 'New', vatNo: 'LV40100000000' }));
  const p = await withTenant(ctx(t), (tx) => getParty(tx, ctx(t), id));
  expect(p.name).toBe('New');
  expect(p.vatNo).toBe('LV40100000000');
});

test('rejects an invalid kind', async () => {
  const t = await makeFirmAndClient();
  await expect(withTenant(ctx(t), (tx) => createParty(tx, ctx(t), { kind: 'bogus' as never, name: 'X' }))).rejects.toThrow();
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `docker compose up -d db && npx vitest run tests/parties/parties.test.ts`
Expected: FAIL — `src/parties/parties.js` missing.

- [ ] **Step 4: Create `src/parties/parties.ts`**

```ts
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appendAudit } from '../audit/audit.js';

export type PartyKind = 'customer' | 'vendor' | 'both';
export interface PartyRow { id: string; kind: PartyKind; name: string; regNo: string | null; vatNo: string | null; }

const newPartySchema = z.object({
  kind: z.enum(['customer', 'vendor', 'both']),
  name: z.string().min(1),
  regNo: z.string().min(1).nullable().optional(),
  vatNo: z.string().min(1).nullable().optional(),
});

const SELECT_COLS = 'id, kind, name, reg_no AS "regNo", vat_no AS "vatNo"';

export async function createParty(
  tx: PoolClient, ctx: TenantContext,
  input: { kind: PartyKind; name: string; regNo?: string | null; vatNo?: string | null },
): Promise<{ id: string }> {
  const p = newPartySchema.parse(input);
  const res = await tx.query(
    `INSERT INTO parties(client_company_id, kind, name, reg_no, vat_no)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [ctx.clientCompanyId, p.kind, p.name, p.regNo ?? null, p.vatNo ?? null],
  );
  const id = res.rows[0].id as string;
  await appendAudit(tx, ctx, { action: 'create', entityType: 'party', entityId: id, before: null, after: p });
  return { id };
}

export async function getParty(tx: PoolClient, ctx: TenantContext, id: string): Promise<PartyRow> {
  const res = await tx.query(
    `SELECT ${SELECT_COLS} FROM parties WHERE id = $1 AND client_company_id = $2`,
    [id, ctx.clientCompanyId],
  );
  if (!res.rowCount) throw new Error(`Party not found: ${id}`);
  return res.rows[0];
}

export async function listParties(
  tx: PoolClient, ctx: TenantContext, filter: { kind?: PartyKind } = {},
): Promise<PartyRow[]> {
  const res = await tx.query(
    `SELECT ${SELECT_COLS} FROM parties
     WHERE client_company_id = $1 AND ($2::text IS NULL OR kind = $2)
     ORDER BY name`,
    [ctx.clientCompanyId, filter.kind ?? null],
  );
  return res.rows;
}

export async function updateParty(
  tx: PoolClient, ctx: TenantContext, id: string,
  patch: { name?: string; regNo?: string | null; vatNo?: string | null; kind?: PartyKind },
): Promise<void> {
  const before = await getParty(tx, ctx, id);
  const merged = {
    name: patch.name ?? before.name,
    regNo: patch.regNo !== undefined ? patch.regNo : before.regNo,
    vatNo: patch.vatNo !== undefined ? patch.vatNo : before.vatNo,
    kind: patch.kind ?? before.kind,
  };
  await tx.query(
    `UPDATE parties SET name=$1, reg_no=$2, vat_no=$3, kind=$4
     WHERE id=$5 AND client_company_id=$6`,
    [merged.name, merged.regNo, merged.vatNo, merged.kind, id, ctx.clientCompanyId],
  );
  await appendAudit(tx, ctx, { action: 'update', entityType: 'party', entityId: id, before, after: merged });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/parties/parties.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add migrations/008_parties.sql src/parties/parties.ts tests/parties/parties.test.ts
git commit -m "feat: parties (debtors/creditors) module"
```

---

## Task 2: Documents store

**Files:**
- Create: `migrations/009_documents.sql`, `src/documents/documents.ts`
- Test: `tests/documents/documents.test.ts`

**Interfaces:**
- Consumes: `withTenant`, `TenantContext`, `appendAudit`.
- Produces: `DocumentSource`, `DocumentStatus`, `DocumentRow`, `createDocument`, `getDocument`, `listDocuments`, `setDocumentStatus`.

- [ ] **Step 1: Create `migrations/009_documents.sql`**

```sql
CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  source text NOT NULL CHECK (source IN ('mobile','web','email','peppol')),
  storage_key text NOT NULL,
  mime text NOT NULL,
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','extracting','extracted','needs_review','posted','rejected')),
  party_id uuid REFERENCES parties(id),
  journal_entry_id uuid REFERENCES journal_entries(id),
  extracted_data jsonb,
  uploaded_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_client_status_idx ON documents(client_company_id, status);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
CREATE POLICY documents_tenant_isolation ON documents
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON documents TO bookkeeping_app;
```

- [ ] **Step 2: Write the failing test — `tests/documents/documents.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createDocument, getDocument, listDocuments, setDocumentStatus } from '../../src/documents/documents.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('a new document starts in status "received"', async () => {
  const t = await makeFirmAndClient();
  const { id } = await withTenant(ctx(t), (tx) => createDocument(tx, ctx(t), {
    source: 'mobile', storageKey: 's3://bucket/abc.jpg', mime: 'image/jpeg', uploadedBy: 'user-1',
  }));
  const doc = await withTenant(ctx(t), (tx) => getDocument(tx, ctx(t), id));
  expect(doc.status).toBe('received');
  expect(doc.source).toBe('mobile');
  expect(doc.journalEntryId).toBeNull();
});

test('setDocumentStatus transitions status', async () => {
  const t = await makeFirmAndClient();
  const { id } = await withTenant(ctx(t), (tx) => createDocument(tx, ctx(t), {
    source: 'web', storageKey: 'k', mime: 'application/pdf', uploadedBy: 'u',
  }));
  await withTenant(ctx(t), (tx) => setDocumentStatus(tx, ctx(t), id, 'extracting'));
  const doc = await withTenant(ctx(t), (tx) => getDocument(tx, ctx(t), id));
  expect(doc.status).toBe('extracting');
});

test('listDocuments filters by status', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    const a = await createDocument(tx, ctx(t), { source: 'web', storageKey: 'a', mime: 'application/pdf', uploadedBy: 'u' });
    await createDocument(tx, ctx(t), { source: 'web', storageKey: 'b', mime: 'application/pdf', uploadedBy: 'u' });
    await setDocumentStatus(tx, ctx(t), a.id, 'needs_review');
  });
  const review = await withTenant(ctx(t), (tx) => listDocuments(tx, ctx(t), { status: 'needs_review' }));
  expect(review).toHaveLength(1);
});

test('rejects an invalid status', async () => {
  const t = await makeFirmAndClient();
  const { id } = await withTenant(ctx(t), (tx) => createDocument(tx, ctx(t), { source: 'web', storageKey: 'k', mime: 'x', uploadedBy: 'u' }));
  await expect(withTenant(ctx(t), (tx) => setDocumentStatus(tx, ctx(t), id, 'bogus' as never))).rejects.toThrow();
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/documents/documents.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Create `src/documents/documents.ts`**

```ts
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appendAudit } from '../audit/audit.js';

export type DocumentSource = 'mobile' | 'web' | 'email' | 'peppol';
export type DocumentStatus = 'received' | 'extracting' | 'extracted' | 'needs_review' | 'posted' | 'rejected';
export interface DocumentRow {
  id: string; source: DocumentSource; storageKey: string; mime: string; status: DocumentStatus;
  partyId: string | null; journalEntryId: string | null; extractedData: unknown | null;
}

const STATUSES = ['received', 'extracting', 'extracted', 'needs_review', 'posted', 'rejected'] as const;
const newDocSchema = z.object({
  source: z.enum(['mobile', 'web', 'email', 'peppol']),
  storageKey: z.string().min(1),
  mime: z.string().min(1),
  uploadedBy: z.string().min(1),
});
const statusSchema = z.enum(STATUSES);

const SELECT_COLS =
  'id, source, storage_key AS "storageKey", mime, status, party_id AS "partyId", journal_entry_id AS "journalEntryId", extracted_data AS "extractedData"';

export async function createDocument(
  tx: PoolClient, ctx: TenantContext,
  input: { source: DocumentSource; storageKey: string; mime: string; uploadedBy: string },
): Promise<{ id: string }> {
  const d = newDocSchema.parse(input);
  const res = await tx.query(
    `INSERT INTO documents(client_company_id, source, storage_key, mime, uploaded_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [ctx.clientCompanyId, d.source, d.storageKey, d.mime, d.uploadedBy],
  );
  const id = res.rows[0].id as string;
  await appendAudit(tx, ctx, { action: 'create', entityType: 'document', entityId: id, before: null, after: d });
  return { id };
}

export async function getDocument(tx: PoolClient, ctx: TenantContext, id: string): Promise<DocumentRow> {
  const res = await tx.query(
    `SELECT ${SELECT_COLS} FROM documents WHERE id = $1 AND client_company_id = $2`,
    [id, ctx.clientCompanyId],
  );
  if (!res.rowCount) throw new Error(`Document not found: ${id}`);
  return res.rows[0];
}

export async function listDocuments(
  tx: PoolClient, ctx: TenantContext, filter: { status?: DocumentStatus } = {},
): Promise<DocumentRow[]> {
  const res = await tx.query(
    `SELECT ${SELECT_COLS} FROM documents
     WHERE client_company_id = $1 AND ($2::text IS NULL OR status = $2)
     ORDER BY created_at DESC`,
    [ctx.clientCompanyId, filter.status ?? null],
  );
  return res.rows;
}

export async function setDocumentStatus(
  tx: PoolClient, ctx: TenantContext, id: string, status: DocumentStatus,
): Promise<void> {
  const s = statusSchema.parse(status);
  const res = await tx.query(
    `UPDATE documents SET status = $1, updated_at = now()
     WHERE id = $2 AND client_company_id = $3`,
    [s, id, ctx.clientCompanyId],
  );
  if (!res.rowCount) throw new Error(`Document not found: ${id}`);
  await appendAudit(tx, ctx, { action: 'status', entityType: 'document', entityId: id, before: null, after: { status: s } });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/documents/documents.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add migrations/009_documents.sql src/documents/documents.ts tests/documents/documents.test.ts
git commit -m "feat: documents store"
```

---

## Task 3: Document extraction + append-only versions

**Files:**
- Create: `migrations/010_document_versions.sql`, `src/documents/extraction.ts`
- Test: `tests/documents/extraction.test.ts`

**Interfaces:**
- Consumes: `documents` (Task 2), the DB `forbid_mutation()` function created in `005_journal.sql`, `appendAudit`.
- Produces: `recordExtraction`, `getExtractionHistory`, `ExtractionVersion`.

- [ ] **Step 1: Create `migrations/010_document_versions.sql`** (reuses the generic `forbid_mutation()` from 005)

```sql
CREATE TABLE document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  document_id uuid NOT NULL REFERENCES documents(id),
  extracted_data jsonb NOT NULL,
  confidence jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_versions_doc_idx ON document_versions(document_id);

-- Append-only: reuse forbid_mutation() defined in 005_journal.sql
CREATE TRIGGER document_versions_append_only
  BEFORE UPDATE OR DELETE ON document_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY document_versions_tenant_isolation ON document_versions
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

-- Append-only: SELECT + INSERT only (no UPDATE/DELETE)
GRANT SELECT, INSERT ON document_versions TO bookkeeping_app;
```

- [ ] **Step 2: Write the failing test — `tests/documents/extraction.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createDocument, getDocument } from '../../src/documents/documents.js';
import { recordExtraction, getExtractionHistory } from '../../src/documents/extraction.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function seedDoc(t: { firmId: string; clientCompanyId: string }) {
  return withTenant(ctx(t), (tx) => createDocument(tx, ctx(t), { source: 'mobile', storageKey: 'k', mime: 'image/jpeg', uploadedBy: 'u' }));
}

test('recordExtraction stores a version and updates the document', async () => {
  const t = await makeFirmAndClient();
  const doc = await seedDoc(t);
  await withTenant(ctx(t), (tx) => recordExtraction(tx, ctx(t), doc.id, {
    extractedData: { supplier: 'SIA X', total: '121.00' },
    confidence: { supplier: 0.98, total: 0.95 },
  }));
  const updated = await withTenant(ctx(t), (tx) => getDocument(tx, ctx(t), doc.id));
  expect(updated.status).toBe('extracted');
  expect(updated.extractedData).toEqual({ supplier: 'SIA X', total: '121.00' });
});

test('multiple extractions are kept as a version history (append-only)', async () => {
  const t = await makeFirmAndClient();
  const doc = await seedDoc(t);
  await withTenant(ctx(t), async (tx) => {
    await recordExtraction(tx, ctx(t), doc.id, { extractedData: { total: '100.00' }, confidence: {} });
    await recordExtraction(tx, ctx(t), doc.id, { extractedData: { total: '121.00' }, confidence: {} });
  });
  const history = await withTenant(ctx(t), (tx) => getExtractionHistory(tx, ctx(t), doc.id));
  expect(history).toHaveLength(2);
  // latest reflected on the document
  const updated = await withTenant(ctx(t), (tx) => getDocument(tx, ctx(t), doc.id));
  expect(updated.extractedData).toEqual({ total: '121.00' });
});

test('document_versions is append-only: UPDATE is blocked', async () => {
  const t = await makeFirmAndClient();
  const doc = await seedDoc(t);
  const { versionId } = await withTenant(ctx(t), (tx) => recordExtraction(tx, ctx(t), doc.id, { extractedData: { a: 1 }, confidence: {} }));
  await expect(withTenant(ctx(t), (tx) =>
    tx.query("UPDATE document_versions SET extracted_data = '{}'::jsonb WHERE id = $1", [versionId]),
  )).rejects.toThrow(/permission denied|append-only/i);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/documents/extraction.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Create `src/documents/extraction.ts`**

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appendAudit } from '../audit/audit.js';

export interface ExtractionVersion { id: string; extractedData: unknown; confidence: unknown; createdAt: string; }

export async function recordExtraction(
  tx: PoolClient, ctx: TenantContext, documentId: string,
  extraction: { extractedData: unknown; confidence: unknown },
): Promise<{ versionId: string }> {
  // Insert an immutable version row.
  const ver = await tx.query(
    `INSERT INTO document_versions(client_company_id, document_id, extracted_data, confidence)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [ctx.clientCompanyId, documentId, JSON.stringify(extraction.extractedData), JSON.stringify(extraction.confidence)],
  );
  const versionId = ver.rows[0].id as string;

  // Reflect the latest extraction on the document + advance status to 'extracted'.
  const upd = await tx.query(
    `UPDATE documents SET extracted_data = $1, status = 'extracted', updated_at = now()
     WHERE id = $2 AND client_company_id = $3`,
    [JSON.stringify(extraction.extractedData), documentId, ctx.clientCompanyId],
  );
  if (!upd.rowCount) throw new Error(`Document not found: ${documentId}`);

  await appendAudit(tx, ctx, {
    action: 'extract', entityType: 'document', entityId: documentId,
    before: null, after: { versionId },
  });
  return { versionId };
}

export async function getExtractionHistory(
  tx: PoolClient, ctx: TenantContext, documentId: string,
): Promise<ExtractionVersion[]> {
  const res = await tx.query(
    `SELECT id, extracted_data AS "extractedData", confidence, created_at AS "createdAt"
     FROM document_versions
     WHERE document_id = $1 AND client_company_id = $2
     ORDER BY created_at ASC, id ASC`,
    [documentId, ctx.clientCompanyId],
  );
  return res.rows;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/documents/extraction.test.ts`
Expected: PASS (3 tests). (The append-only UPDATE is blocked by lack of privilege AND the trigger.)

- [ ] **Step 6: Commit**

```bash
git add migrations/010_document_versions.sql src/documents/extraction.ts tests/documents/extraction.test.ts
git commit -m "feat: append-only document extraction versions"
```

---

## Task 4: Proposal model + immutability

**Files:**
- Create: `migrations/011_proposals.sql`, `src/proposals/proposals.ts`
- Test: `tests/proposals/proposals.test.ts`

**Interfaces:**
- Consumes: `withTenant`, `appendAudit`, `documents` (optional FK).
- Produces: `ProposalType`, `ProposalStatus`, `Rationale`, `ProposalRow`, `createProposal`, `getProposal`, `listProposals`.

- [ ] **Step 1: Create `migrations/011_proposals.sql`**

```sql
CREATE TABLE proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  type text NOT NULL CHECK (type IN ('posting','bank_match','declaration','task')),
  status text NOT NULL DEFAULT 'suggested'
    CHECK (status IN ('suggested','pending_approval','approved','rejected','posted')),
  payload jsonb NOT NULL,
  rationale jsonb NOT NULL,
  document_id uuid REFERENCES documents(id),
  resolved_entry_id uuid REFERENCES journal_entries(id),
  resolved_by text,
  resolved_at timestamptz,
  reject_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX proposals_client_status_idx ON proposals(client_company_id, status);

-- Core fields are immutable; only lifecycle fields may change.
CREATE OR REPLACE FUNCTION forbid_proposal_core_mutation() RETURNS trigger AS $$
BEGIN
  IF NEW.type <> OLD.type OR NEW.payload <> OLD.payload
     OR NEW.rationale <> OLD.rationale OR NEW.created_at <> OLD.created_at
     OR NEW.client_company_id <> OLD.client_company_id THEN
    RAISE EXCEPTION 'proposal core fields (type, payload, rationale, created_at) are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER proposals_core_immutable
  BEFORE UPDATE ON proposals
  FOR EACH ROW EXECUTE FUNCTION forbid_proposal_core_mutation();

ALTER TABLE proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY proposals_tenant_isolation ON proposals
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

-- INSERT (create), SELECT (read), UPDATE (lifecycle transitions). No DELETE/TRUNCATE.
GRANT SELECT, INSERT, UPDATE ON proposals TO bookkeeping_app;
```

- [ ] **Step 2: Write the failing test — `tests/proposals/proposals.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createProposal, getProposal, listProposals } from '../../src/proposals/proposals.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('creates a proposal with payload + rationale, default status suggested', async () => {
  const t = await makeFirmAndClient();
  const { id } = await withTenant(ctx(t), (tx) => createProposal(tx, ctx(t), {
    type: 'posting',
    payload: { date: '2026-03-10', memo: 'Sale', currency: 'EUR', lines: [] },
    rationale: { ruleRef: 'VAT 21%', computation: '100 + 21', sourceRefs: { documentId: null } },
  }));
  const p = await withTenant(ctx(t), (tx) => getProposal(tx, ctx(t), id));
  expect(p.status).toBe('suggested');
  expect(p.type).toBe('posting');
  expect(p.rationale).toMatchObject({ ruleRef: 'VAT 21%' });
});

test('listProposals filters to the approval queue', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await createProposal(tx, ctx(t), { type: 'posting', payload: {}, rationale: {}, status: 'pending_approval' });
    await createProposal(tx, ctx(t), { type: 'task', payload: {}, rationale: {} });
  });
  const queue = await withTenant(ctx(t), (tx) => listProposals(tx, ctx(t), { status: 'pending_approval' }));
  expect(queue).toHaveLength(1);
  expect(queue[0].type).toBe('posting');
});

test('proposal core fields are immutable (payload cannot be updated)', async () => {
  const t = await makeFirmAndClient();
  const { id } = await withTenant(ctx(t), (tx) => createProposal(tx, ctx(t), { type: 'task', payload: { a: 1 }, rationale: {} }));
  await expect(withTenant(ctx(t), (tx) =>
    tx.query("UPDATE proposals SET payload = '{\"a\":2}'::jsonb WHERE id = $1", [id]),
  )).rejects.toThrow(/immutable/i);
});

test('rejects an invalid type', async () => {
  const t = await makeFirmAndClient();
  await expect(withTenant(ctx(t), (tx) => createProposal(tx, ctx(t), { type: 'bogus' as never, payload: {}, rationale: {} }))).rejects.toThrow();
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/proposals/proposals.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Create `src/proposals/proposals.ts`**

```ts
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appendAudit } from '../audit/audit.js';

export type ProposalType = 'posting' | 'bank_match' | 'declaration' | 'task';
export type ProposalStatus = 'suggested' | 'pending_approval' | 'approved' | 'rejected' | 'posted';
export interface Rationale { ruleRef?: string; computation?: string; sourceRefs?: unknown; }
export interface ProposalRow {
  id: string; type: ProposalType; status: ProposalStatus; payload: unknown; rationale: Rationale;
  documentId: string | null; resolvedEntryId: string | null; rejectReason: string | null;
}

const newProposalSchema = z.object({
  type: z.enum(['posting', 'bank_match', 'declaration', 'task']),
  payload: z.unknown(),
  rationale: z.object({ ruleRef: z.string().optional(), computation: z.string().optional(), sourceRefs: z.unknown().optional() }).passthrough(),
  documentId: z.string().uuid().nullable().optional(),
  status: z.enum(['suggested', 'pending_approval', 'approved', 'rejected', 'posted']).optional(),
});

const SELECT_COLS =
  'id, type, status, payload, rationale, document_id AS "documentId", resolved_entry_id AS "resolvedEntryId", reject_reason AS "rejectReason"';

export async function createProposal(
  tx: PoolClient, ctx: TenantContext,
  input: { type: ProposalType; payload: unknown; rationale: Rationale; documentId?: string | null; status?: ProposalStatus },
): Promise<{ id: string }> {
  const p = newProposalSchema.parse(input);
  const res = await tx.query(
    `INSERT INTO proposals(client_company_id, type, status, payload, rationale, document_id)
     VALUES ($1,$2,COALESCE($3,'suggested'),$4,$5,$6) RETURNING id`,
    [ctx.clientCompanyId, p.type, p.status ?? null, JSON.stringify(p.payload), JSON.stringify(p.rationale), p.documentId ?? null],
  );
  const id = res.rows[0].id as string;
  await appendAudit(tx, ctx, { action: 'create', entityType: 'proposal', entityId: id, before: null, after: { type: p.type, status: p.status ?? 'suggested' } });
  return { id };
}

export async function getProposal(tx: PoolClient, ctx: TenantContext, id: string): Promise<ProposalRow> {
  const res = await tx.query(
    `SELECT ${SELECT_COLS} FROM proposals WHERE id = $1 AND client_company_id = $2`,
    [id, ctx.clientCompanyId],
  );
  if (!res.rowCount) throw new Error(`Proposal not found: ${id}`);
  return res.rows[0];
}

export async function listProposals(
  tx: PoolClient, ctx: TenantContext, filter: { status?: ProposalStatus } = {},
): Promise<ProposalRow[]> {
  const res = await tx.query(
    `SELECT ${SELECT_COLS} FROM proposals
     WHERE client_company_id = $1 AND ($2::text IS NULL OR status = $2)
     ORDER BY created_at ASC`,
    [ctx.clientCompanyId, filter.status ?? null],
  );
  return res.rows;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/proposals/proposals.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add migrations/011_proposals.sql src/proposals/proposals.ts tests/proposals/proposals.test.ts
git commit -m "feat: proposal model with immutable core fields"
```

---

## Task 5: Proposal lifecycle transitions

**Files:**
- Create: `src/proposals/lifecycle.ts`
- Test: `tests/proposals/lifecycle.test.ts`

**Interfaces:**
- Consumes: `getProposal` (Task 4), `appendAudit`.
- Produces: `submitForApproval`, `approveProposal`, `rejectProposal`. Each validates the current status and records audit; invalid transitions throw.

Allowed transitions: `suggested → pending_approval` (submit); `pending_approval → approved` (approve); `pending_approval → rejected` (reject). `approved → posted` happens only in Task 6.

- [ ] **Step 1: Write the failing test — `tests/proposals/lifecycle.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createProposal, getProposal } from '../../src/proposals/proposals.js';
import { submitForApproval, approveProposal, rejectProposal } from '../../src/proposals/lifecycle.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function mk(t: { firmId: string; clientCompanyId: string }, status?: 'suggested' | 'pending_approval') {
  return withTenant(ctx(t), (tx) => createProposal(tx, ctx(t), { type: 'task', payload: {}, rationale: {}, status }));
}

test('submit → approve happy path', async () => {
  const t = await makeFirmAndClient();
  const { id } = await mk(t);
  await withTenant(ctx(t), (tx) => submitForApproval(tx, ctx(t), id));
  expect((await withTenant(ctx(t), (tx) => getProposal(tx, ctx(t), id))).status).toBe('pending_approval');
  await withTenant(ctx(t), (tx) => approveProposal(tx, ctx(t), id));
  expect((await withTenant(ctx(t), (tx) => getProposal(tx, ctx(t), id))).status).toBe('approved');
});

test('reject records a reason', async () => {
  const t = await makeFirmAndClient();
  const { id } = await mk(t, 'pending_approval');
  await withTenant(ctx(t), (tx) => rejectProposal(tx, ctx(t), id, 'wrong account'));
  const p = await withTenant(ctx(t), (tx) => getProposal(tx, ctx(t), id));
  expect(p.status).toBe('rejected');
  expect(p.rejectReason).toBe('wrong account');
});

test('cannot approve a proposal that is not pending_approval', async () => {
  const t = await makeFirmAndClient();
  const { id } = await mk(t); // status 'suggested'
  await expect(withTenant(ctx(t), (tx) => approveProposal(tx, ctx(t), id))).rejects.toThrow(/pending_approval|transition/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/proposals/lifecycle.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `src/proposals/lifecycle.ts`**

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { getProposal, type ProposalStatus } from './proposals.js';
import { appendAudit } from '../audit/audit.js';

async function transition(
  tx: PoolClient, ctx: TenantContext, id: string, from: ProposalStatus, to: ProposalStatus,
  extra: { rejectReason?: string } = {},
): Promise<void> {
  const before = await getProposal(tx, ctx, id);
  if (before.status !== from) {
    throw new Error(`Invalid transition for proposal ${id}: expected status ${from}, found ${before.status}`);
  }
  await tx.query(
    `UPDATE proposals
     SET status = $1, reject_reason = $2, resolved_by = $3, resolved_at = now()
     WHERE id = $4 AND client_company_id = $5`,
    [to, extra.rejectReason ?? null, ctx.actorId, id, ctx.clientCompanyId],
  );
  await appendAudit(tx, ctx, {
    action: to, entityType: 'proposal', entityId: id,
    before: { status: before.status }, after: { status: to, ...(extra.rejectReason ? { rejectReason: extra.rejectReason } : {}) },
  });
}

export async function submitForApproval(tx: PoolClient, ctx: TenantContext, id: string): Promise<void> {
  await transition(tx, ctx, id, 'suggested', 'pending_approval');
}

export async function approveProposal(tx: PoolClient, ctx: TenantContext, id: string): Promise<void> {
  await transition(tx, ctx, id, 'pending_approval', 'approved');
}

export async function rejectProposal(tx: PoolClient, ctx: TenantContext, id: string, reason: string): Promise<void> {
  await transition(tx, ctx, id, 'pending_approval', 'rejected', { rejectReason: reason });
}
```

> Note: `submitForApproval`/`approve`/`reject` all set `resolved_by`/`resolved_at`. For `submitForApproval` these mark who moved it into the queue; that's acceptable and keeps one code path. If a reviewer objects, split submit into its own query without `resolved_*`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/proposals/lifecycle.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/proposals/lifecycle.ts tests/proposals/lifecycle.test.ts
git commit -m "feat: proposal lifecycle transitions with audit"
```

---

## Task 6: Post an approved posting-proposal to the ledger (keystone)

**Files:**
- Create: `src/proposals/post-proposal.ts`
- Test: `tests/proposals/post-proposal.test.ts`

**Interfaces:**
- Consumes: `getProposal` (Task 4), `postEntry` + `NewJournalEntry` (Plan 1), `setDocumentStatus` + documents table (Task 2), `appendAudit`.
- Produces: `postApprovedPosting(tx, ctx, proposalId)` → `{ entryId }`.

This ties the whole model together: an **approved** proposal of type `posting`, whose `payload` is a `NewJournalEntry`, is posted through the foundation's `postEntry`; the proposal moves to `posted` with `resolved_entry_id`; if the proposal references a document, that document is linked to the entry and moved to `posted`. All in one transaction.

- [ ] **Step 1: Write the failing test — `tests/proposals/post-proposal.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { getEntry } from '../../src/ledger/posting.js';
import { createDocument, getDocument } from '../../src/documents/documents.js';
import { createProposal, getProposal } from '../../src/proposals/proposals.js';
import { approveProposal, submitForApproval } from '../../src/proposals/lifecycle.js';
import { postApprovedPosting } from '../../src/proposals/post-proposal.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('approving and posting a posting-proposal creates a balanced entry and links the document', async () => {
  const t = await makeFirmAndClient();
  const { entryId, docId, proposalId } = await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    const doc = await createDocument(tx, ctx(t), { source: 'mobile', storageKey: 'k', mime: 'image/jpeg', uploadedBy: 'u' });
    const prop = await createProposal(tx, ctx(t), {
      type: 'posting',
      documentId: doc.id,
      payload: {
        date: '2026-03-10', memo: 'Sale', currency: 'EUR',
        lines: [
          { accountCode: '2310', debit: '121.00', credit: '0' },
          { accountCode: '6110', debit: '0', credit: '121.00' },
        ],
      },
      rationale: { ruleRef: 'VAT 21%' },
    });
    await submitForApproval(tx, ctx(t), prop.id);
    await approveProposal(tx, ctx(t), prop.id);
    const posted = await postApprovedPosting(tx, ctx(t), prop.id);
    return { entryId: posted.entryId, docId: doc.id, proposalId: prop.id };
  });

  const [entry, doc, prop] = await withTenant(ctx(t), async (tx) => [
    await getEntry(tx, ctx(t), entryId),
    await getDocument(tx, ctx(t), docId),
    await getProposal(tx, ctx(t), proposalId),
  ]);
  expect(entry.lines).toHaveLength(2);
  expect(entry.memo).toBe('Sale');
  expect(prop.status).toBe('posted');
  expect(prop.resolvedEntryId).toBe(entryId);
  expect(doc.status).toBe('posted');
  expect(doc.journalEntryId).toBe(entryId);
});

test('refuses to post a proposal that is not approved', async () => {
  const t = await makeFirmAndClient();
  const { id } = await withTenant(ctx(t), (tx) => createProposal(tx, ctx(t), {
    type: 'posting', payload: { date: '2026-03-10', memo: 'x', currency: 'EUR', lines: [] }, rationale: {},
  }));
  await expect(withTenant(ctx(t), (tx) => postApprovedPosting(tx, ctx(t), id))).rejects.toThrow(/approved/i);
});

test('refuses to post a non-posting proposal', async () => {
  const t = await makeFirmAndClient();
  const { id } = await withTenant(ctx(t), async (tx) => {
    const p = await createProposal(tx, ctx(t), { type: 'task', payload: {}, rationale: {}, status: 'pending_approval' });
    await approveProposal(tx, ctx(t), p.id);
    return p;
  });
  await expect(withTenant(ctx(t), (tx) => postApprovedPosting(tx, ctx(t), id))).rejects.toThrow(/posting/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/proposals/post-proposal.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `src/proposals/post-proposal.ts`**

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { getProposal } from './proposals.js';
import { postEntry, type NewJournalEntry } from '../ledger/posting.js';
import { appendAudit } from '../audit/audit.js';

export async function postApprovedPosting(
  tx: PoolClient, ctx: TenantContext, proposalId: string,
): Promise<{ entryId: string }> {
  const prop = await getProposal(tx, ctx, proposalId);
  if (prop.type !== 'posting') throw new Error(`Proposal ${proposalId} is not a posting proposal (type=${prop.type})`);
  if (prop.status !== 'approved') throw new Error(`Proposal ${proposalId} must be approved before posting (status=${prop.status})`);

  // The payload is a NewJournalEntry; carry the source document through to the ledger.
  const entryInput = { ...(prop.payload as NewJournalEntry), sourceDocumentId: prop.documentId ?? null };
  const { entryId } = await postEntry(tx, ctx, entryInput);

  // Mark the proposal posted (lifecycle fields only — core fields stay immutable).
  await tx.query(
    `UPDATE proposals SET status = 'posted', resolved_entry_id = $1, resolved_by = $2, resolved_at = now()
     WHERE id = $3 AND client_company_id = $4`,
    [entryId, ctx.actorId, proposalId, ctx.clientCompanyId],
  );

  // Link + advance the source document, if any.
  if (prop.documentId) {
    await tx.query(
      `UPDATE documents SET journal_entry_id = $1, status = 'posted', updated_at = now()
       WHERE id = $2 AND client_company_id = $3`,
      [entryId, prop.documentId, ctx.clientCompanyId],
    );
  }

  await appendAudit(tx, ctx, {
    action: 'posted', entityType: 'proposal', entityId: proposalId,
    before: { status: 'approved' }, after: { status: 'posted', entryId },
  });
  return { entryId };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/proposals/post-proposal.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, no type errors (foundation's 27 tests + this plan's new tests all green).

- [ ] **Step 6: Commit**

```bash
git add src/proposals/post-proposal.ts tests/proposals/post-proposal.test.ts
git commit -m "feat: post approved posting-proposals through the ledger"
```

---

## Self-review

**Spec coverage (design §3 Parties & Documents, §4 proposal/approval, §6 approval queue):**
- Parties (customers/vendors, debtor/creditor) → Task 1. ✓ (Balances derive from the ledger — no stored balance, consistent with Plan 1.)
- Document store: original file (by `storage_key`) + extracted data + version history + link to produced journal entry + status → Tasks 2, 3, 6. ✓
- Proposal object with status lifecycle + immutable rationale + source references → Tasks 4, 5. ✓
- Approval queue (`listProposals({status:'pending_approval'})`) → Task 4. ✓
- Approve → post through the Ledger, in one transaction, with audit + document link → Task 6. ✓ (This is the "does the work, asks approval, always explains" data path made real.)

**Deliberately deferred (later plans):** actual blob upload/serving of file bytes (Plan 3 / infra); the OCR extraction *pipeline* that produces the extraction data and drafts proposals (Plan 3); autonomy policy that decides auto-post vs pending_approval per client × operation type (Plan 3, the agent). This plan provides the tables/APIs those consume.

**Placeholder scan:** none — every code step is complete.

**Type consistency:** consumed foundation signatures match `main` verbatim (`postEntry`, `NewJournalEntry`, `appendAudit`, `withTenant`, `TenantContext`). Produced signatures are used identically across Tasks 4–6 (`getProposal`, `ProposalStatus`, `createDocument`/`setDocumentStatus`).

**Migration/grants pattern:** each new table migration (008–011) runs as admin, enables + forces RLS, adds a tenant policy, and grants `bookkeeping_app` the minimal privileges — `SELECT, INSERT` plus `UPDATE` only where a documented operation needs it (parties edit, document status, proposal lifecycle), never `UPDATE`/`DELETE` on the append-only `document_versions`. Consistent with the Plan 1 C1 role-separation model.
