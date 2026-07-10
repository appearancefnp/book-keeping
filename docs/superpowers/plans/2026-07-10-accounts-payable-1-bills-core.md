# Accounts Payable — Plan 1: Bills Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user enter a supplier bill (manually, or adopted from a received Peppol invoice), route it through the existing approval queue, post the payable on approval, and see what is owed — on the append-only ledger.

**Architecture:** A new `src/payables/` domain module with a first-class `bills` table (plus `bill_lines`). Entering a bill writes the bill rows (`awaiting_approval`) and a `posting` proposal; approving it posts *DR expense (per line) / DR VAT-input / CR payables* and flips the bill to `open`. Reuses `proposals`, `post-proposal`, `postEntry`, and the `parties` vendor kind unchanged. This plan is Part 1 of M2; the pay-out loop (settlement, pay run, camt.053 match, aging) is Plan 2.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node, Postgres (`pg`), Next.js App Router, Vitest, Zod. Money as integer cents via `src/db/money.ts`.

Spec: `docs/superpowers/specs/2026-07-10-accounts-payable-design.md`.

## Global Constraints

- **Money:** integer cents via `src/db/money.ts` (`toCents`/`fromCents`/`sumCents`); never floats. DB money columns are `bigint` cents; decimal money strings match `^-?\d+(\.\d{1,2})?$`.
- **Tenancy:** domain functions are `(tx, ctx, ...)` run inside `withTenant(ctx, ...)`; RLS enforced at the DB. Every mutation calls `appendAudit(...)`. Never bypass `withTenant`.
- **New tables:** `client_company_id uuid NOT NULL REFERENCES client_companies(id)`, `ENABLE`+`FORCE ROW LEVEL SECURITY`, a `*_tenant_isolation` policy `USING/WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid)`, and `GRANT SELECT, INSERT, UPDATE ON <table> TO bookkeeping_app;` — copy `migrations/014_bank_transactions.sql`.
- **Web API routes** (`web/app/api/.../route.ts`): `export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';` then `getSessionToken()` → `resolveTenantContext(token, clientCompanyId, nowUnix())` → domain call inside `withTenant`. Map errors with `errorToStatus(msg)` from `@/app/lib/authz`; gate mutations with `assertRoleAllowed(ctx.actorRole, '<perm>')`. Domain imports use the `@domain/*` alias; app imports use `@/app/*`.
- **Web framework caveat:** `web/AGENTS.md` warns this Next.js has breaking changes vs. training data — read the relevant guide in `web/node_modules/next/dist/docs/` before writing page/route code, and mirror an existing route/page (`web/app/api/parties/route.ts`, `web/app/(cabinet)/reports/page.tsx`, `web/app/(cabinet)/invoices/new/`) rather than inventing patterns.
- **Ledger is append-only** (DB triggers): corrections are reversals, never edits. `postEntry` requires an **open period** for the entry date and a **balanced** entry (Σdebit === Σcredit in cents), min 2 lines, each line exactly one of debit/credit > 0.
- **i18n:** every user-facing string added to all three catalogs (EN, LV, RU) in `web/app/lib/i18n.ts` (typed `Record<keyof typeof EN, string>` — TS build fails if any catalog misses a key). Dates via `LOCALE_FOR[lang]`.
- **Icons:** inline stroked SVG, `currentColor`, ~1.5px stroke (see `web/app/components/NavIcon.tsx`). No emoji.
- **Default account codes** (representative LR chart, *accountant to confirm* — matches `web/app/api/documents/capture/route.ts`): expense `7710`, VAT-input `5721`, payables `5310`, bank `2620`. Bill line `expense_account` is chosen per line by the operator; VAT-input and payables come from config defaults.
- **Commands:** `npm test` (root, Vitest — needs Postgres up: `docker compose up -d`) and `npx tsc --noEmit` in both repo root and `web/`.

## File Structure

New:
- `migrations/030_bills.sql` — `bills`, `bill_lines`; `ALTER parties ADD iban`.
- `src/payables/bills.ts` — `createBill`, `listBills`, `getBill`, `voidBill`, `buildBillEntry`, types.
- `tests/payables/bills.test.ts`
- `tests/payables/bill-approval.test.ts`
- `web/app/api/bills/route.ts` — GET (list) / POST (create).
- `web/app/api/bills/[id]/route.ts` — GET (detail) / PATCH (void).
- `web/app/(cabinet)/bills/page.tsx` + `page.module.css` — AP list.
- `web/app/(cabinet)/bills/new/page.tsx` + `page.module.css` — manual composer.
- `web/app/(cabinet)/bills/[id]/page.tsx` + `page.module.css` — detail.

Modified:
- `src/parties/parties.ts` — add `iban` to type, schema, SELECT_COLS, create/update.
- `src/proposals/post-proposal.ts` — after posting, flip a linked bill to `open`.
- `src/einvoice/inbound.ts` — also create a `bills` row (`source='peppol'`) beside the proposal.
- `src/dev/seed.ts` — add the VAT-input account `5721` if missing (so manual bills post in dev).
- `web/app/lib/i18n.ts` — `nav.bills`, `nav.short.bills`, `bills.*`.
- `web/app/components/NavIcon.tsx` — `'bills'` icon.
- `web/app/components/Sidebar.tsx` — `/bills` nav entry.
- `web/app/lib/authz.ts` — add `'bills.write'` permission (mirror `'parties.write'`).

Out of scope for Plan 1 (Plan 2 or later): settlement, pay runs, camt.053 AP matching, aging. **OCR/document-intake adoption into a bill row** is deferred — `documents/capture` continues to create a proposal only; adopting it follows the same one-line insert pattern as the Peppol task here once the table exists.

---

### Task 1: Migration `030_bills.sql`

**Files:**
- Create: `migrations/030_bills.sql`

**Interfaces:**
- Produces tables `bills`, `bill_lines` and column `parties.iban`, consumed by every later task.

- [ ] **Step 1: Write the migration**

Create `migrations/030_bills.sql`:

```sql
-- Accounts payable: vendor bills and their line detail (M2, Plan 1).
CREATE TABLE bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  vendor_party_id uuid NOT NULL REFERENCES parties(id),
  bill_number text NOT NULL,
  issue_date date NOT NULL,
  due_date date NOT NULL,
  currency char(3) NOT NULL,
  net_cents bigint NOT NULL,
  vat_cents bigint NOT NULL,
  grand_total_cents bigint NOT NULL,
  amount_paid_cents bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'awaiting_approval'
    CHECK (status IN ('awaiting_approval','open','partially_paid','paid','void')),
  source text NOT NULL CHECK (source IN ('manual','ocr','peppol')),
  posting_proposal_id uuid REFERENCES proposals(id),
  journal_entry_id uuid REFERENCES journal_entries(id),
  document_id uuid REFERENCES documents(id),
  einvoice_id uuid REFERENCES einvoices(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bills_client_status_due_idx ON bills(client_company_id, status, due_date);

ALTER TABLE bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE bills FORCE ROW LEVEL SECURITY;
CREATE POLICY bills_tenant_isolation ON bills
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON bills TO bookkeeping_app;

CREATE TABLE bill_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  bill_id uuid NOT NULL REFERENCES bills(id),
  line_no int NOT NULL,
  description text NOT NULL,
  expense_account text NOT NULL,
  net_cents bigint NOT NULL,
  vat_rate numeric NOT NULL,
  vat_cents bigint NOT NULL
);
CREATE INDEX bill_lines_bill_idx ON bill_lines(bill_id);

ALTER TABLE bill_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY bill_lines_tenant_isolation ON bill_lines
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON bill_lines TO bookkeeping_app;

ALTER TABLE parties ADD COLUMN iban text;
```

- [ ] **Step 2: Apply and verify the migration**

Run: `docker compose up -d` (Postgres), then `npx tsx -e "import('./src/db/migrate.js').then(m => m.runMigrations()).then(() => process.exit(0))"`
Expected: completes without error (migration runner applies `030`).

(If a project-standard migration command exists — check `package.json` scripts — prefer it. `resetDb()` in tests also runs all migrations, so Task 3's test failing on a *missing table* would signal a migration problem.)

- [ ] **Step 3: Commit**

```bash
git add migrations/030_bills.sql
git commit -m "feat(payables): bills + bill_lines schema, parties.iban (M2)"
```

---

### Task 2: `parties.iban` in the domain layer

**Files:**
- Modify: `src/parties/parties.ts`
- Test: `tests/parties/iban.test.ts` (Create)

**Interfaces:**
- Consumes: `PartyRow` (existing).
- Produces: `PartyRow.iban: string | null`; `createParty`/`updateParty` accept optional `iban`.

- [ ] **Step 1: Write the failing test**

Create `tests/parties/iban.test.ts`:

```typescript
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createParty, getParty, updateParty } from '../../src/parties/parties.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('createParty stores iban and getParty returns it', async () => {
  const t = await makeFirmAndClient();
  const { id } = await withTenant(ctx(t), (tx) =>
    createParty(tx, ctx(t), { kind: 'vendor', name: 'Acme', iban: 'LV80BANK0000435195001' }));
  const p = await withTenant(ctx(t), (tx) => getParty(tx, ctx(t), id));
  expect(p.iban).toBe('LV80BANK0000435195001');
});

test('iban defaults to null and is patchable', async () => {
  const t = await makeFirmAndClient();
  const { id } = await withTenant(ctx(t), (tx) => createParty(tx, ctx(t), { kind: 'vendor', name: 'NoIban' }));
  let p = await withTenant(ctx(t), (tx) => getParty(tx, ctx(t), id));
  expect(p.iban).toBeNull();
  await withTenant(ctx(t), (tx) => updateParty(tx, ctx(t), id, { iban: 'LV12ABCD0000000000001' }));
  p = await withTenant(ctx(t), (tx) => getParty(tx, ctx(t), id));
  expect(p.iban).toBe('LV12ABCD0000000000001');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/parties/iban.test.ts`
Expected: FAIL — `iban` is not on `PartyRow` / not accepted by `createParty`.

- [ ] **Step 3: Write the implementation**

Edit `src/parties/parties.ts`:

1. Add `iban` to the interface:
```typescript
export interface PartyRow { id: string; kind: PartyKind; name: string; regNo: string | null; vatNo: string | null; iban: string | null; }
```
2. Add to the schema (after `vatNo`):
```typescript
  iban: z.string().min(1).nullable().optional(),
```
3. Extend `SELECT_COLS`:
```typescript
const SELECT_COLS = 'id, kind, name, reg_no AS "regNo", vat_no AS "vatNo", iban';
```
4. Update the `createParty` signature and INSERT:
```typescript
export async function createParty(
  tx: PoolClient, ctx: TenantContext,
  input: { kind: PartyKind; name: string; regNo?: string | null; vatNo?: string | null; iban?: string | null },
): Promise<{ id: string }> {
  const p = newPartySchema.parse(input);
  const res = await tx.query(
    `INSERT INTO parties(client_company_id, kind, name, reg_no, vat_no, iban)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [ctx.clientCompanyId, p.kind, p.name, p.regNo ?? null, p.vatNo ?? null, p.iban ?? null],
  );
  const id = res.rows[0].id as string;
  await appendAudit(tx, ctx, { action: 'create', entityType: 'party', entityId: id, before: null, after: p });
  return { id };
}
```
5. Update `updateParty` to merge `iban`:
```typescript
export async function updateParty(
  tx: PoolClient, ctx: TenantContext, id: string,
  patch: { name?: string; regNo?: string | null; vatNo?: string | null; kind?: PartyKind; iban?: string | null },
): Promise<void> {
  const before = await getParty(tx, ctx, id);
  const merged = {
    name: patch.name ?? before.name,
    regNo: patch.regNo !== undefined ? patch.regNo : before.regNo,
    vatNo: patch.vatNo !== undefined ? patch.vatNo : before.vatNo,
    kind: patch.kind ?? before.kind,
    iban: patch.iban !== undefined ? patch.iban : before.iban,
  };
  await tx.query(
    `UPDATE parties SET name=$1, reg_no=$2, vat_no=$3, kind=$4, iban=$5
     WHERE id=$6 AND client_company_id=$7`,
    [merged.name, merged.regNo, merged.vatNo, merged.kind, merged.iban, id, ctx.clientCompanyId],
  );
  await appendAudit(tx, ctx, { action: 'update', entityType: 'party', entityId: id, before, after: merged });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/parties/iban.test.ts` → Expected: PASS (2 tests).
Run: `npm test -- tests/parties` → Expected: existing parties tests still pass.
Run: `npx tsc --noEmit` (root) → Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/parties/parties.ts tests/parties/iban.test.ts
git commit -m "feat(parties): vendor IBAN column + CRUD (M2)"
```

---

### Task 3: `payables/bills.ts` — create, list, get, void

**Files:**
- Create: `src/payables/bills.ts`
- Test: `tests/payables/bills.test.ts`

**Interfaces:**
- Consumes: `TenantContext`; `createProposal`, `type Rationale` from `../proposals/proposals.js`; `rejectProposal` from `../proposals/lifecycle.js`; `type NewJournalEntry` from `../ledger/posting.js`; `toCents`, `fromCents`, `sumCents` from `../db/money.js`; `appendAudit` from `../audit/audit.js`.
- Produces:
  - `interface NewBillLine { description: string; expenseAccount: string; net: string; vatRate: number; vat: string; }`
  - `interface NewBill { vendorPartyId: string; billNumber: string; issueDate: string; dueDate: string; currency: string; lines: NewBillLine[]; source?: 'manual'|'ocr'|'peppol'; documentId?: string|null; einvoiceId?: string|null; }`
  - `interface BillAccounts { vatInputAccount: string; payablesAccount: string; }`
  - `interface BillRow { id: string; vendorPartyId: string; vendorName: string; billNumber: string; issueDate: string; dueDate: string; currency: string; netCents: string; vatCents: string; grandTotalCents: string; amountPaidCents: string; outstandingCents: string; status: string; source: string; postingProposalId: string|null; journalEntryId: string|null; }`
  - `interface BillDetail extends BillRow { lines: { lineNo: number; description: string; expenseAccount: string; netCents: string; vatRate: string; vatCents: string; }[]; }`
  - `buildBillEntry(bill: NewBill, accounts: BillAccounts): NewJournalEntry` — pure; DR each line's `expenseAccount` (net), DR `vatInputAccount` (Σvat, only if > 0), CR `payablesAccount` (grand). memo `Bill <billNumber>`.
  - `createBill(tx, ctx, bill: NewBill, accounts: BillAccounts): Promise<{ billId: string; proposalId: string }>`
  - `listBills(tx, ctx, filter?: { status?: string; vendorPartyId?: string }): Promise<BillRow[]>`
  - `getBill(tx, ctx, id: string): Promise<BillDetail>`
  - `voidBill(tx, ctx, id: string): Promise<void>` — only when `awaiting_approval`; sets `void` and rejects the linked proposal.

- [ ] **Step 1: Write the failing test**

Create `tests/payables/bills.test.ts`:

```typescript
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { createParty } from '../../src/parties/parties.js';
import { getProposal } from '../../src/proposals/proposals.js';
import { createBill, listBills, getBill, voidBill, buildBillEntry } from '../../src/payables/bills.js';

const ACCTS = { vatInputAccount: '5721', payablesAccount: '5310' };

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function seed() {
  const t = await makeFirmAndClient();
  const vendor = await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '7710', name: 'Expenses', type: 'expense' });
    await createAccount(tx, ctx(t), { code: '5721', name: 'VAT input', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '5310', name: 'Payables', type: 'liability' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    return createParty(tx, ctx(t), { kind: 'vendor', name: 'Acme Supplies', iban: 'LV80BANK0000435195001' });
  });
  return { t, vendorId: vendor.id };
}

const sampleBill = (vendorPartyId: string) => ({
  vendorPartyId, billNumber: 'INV-42', issueDate: '2026-03-10', dueDate: '2026-04-09', currency: 'EUR',
  lines: [
    { description: 'Widgets', expenseAccount: '7710', net: '100.00', vatRate: 21, vat: '21.00' },
    { description: 'Freight', expenseAccount: '7710', net: '50.00', vatRate: 21, vat: '10.50' },
  ],
});

test('buildBillEntry produces a balanced per-line payable entry', () => {
  const entry = buildBillEntry(sampleBill('v'), ACCTS);
  // 2 expense debits + 1 VAT debit + 1 payables credit
  expect(entry.lines).toHaveLength(4);
  const debit = entry.lines.reduce((a, l) => a + Number(l.debit), 0);
  const credit = entry.lines.reduce((a, l) => a + Number(l.credit), 0);
  expect(debit).toBeCloseTo(181.5);
  expect(credit).toBeCloseTo(181.5);
  const payable = entry.lines.find((l) => l.accountCode === '5310')!;
  expect(payable.credit).toBe('181.50');
});

test('createBill writes bill, lines, and a pending posting proposal', async () => {
  const { t, vendorId } = await seed();
  const { billId, proposalId } = await withTenant(ctx(t), (tx) => createBill(tx, ctx(t), sampleBill(vendorId), ACCTS));
  const detail = await withTenant(ctx(t), (tx) => getBill(tx, ctx(t), billId));
  expect(detail.status).toBe('awaiting_approval');
  expect(detail.grandTotalCents).toBe('18150');
  expect(detail.outstandingCents).toBe('18150');
  expect(detail.vendorName).toBe('Acme Supplies');
  expect(detail.lines).toHaveLength(2);
  const prop = await withTenant(ctx(t), (tx) => getProposal(tx, ctx(t), proposalId));
  expect(prop.type).toBe('posting');
  expect(prop.status).toBe('pending_approval');
});

test('listBills returns rows with outstanding and filters by status', async () => {
  const { t, vendorId } = await seed();
  await withTenant(ctx(t), (tx) => createBill(tx, ctx(t), sampleBill(vendorId), ACCTS));
  const all = await withTenant(ctx(t), (tx) => listBills(tx, ctx(t)));
  expect(all).toHaveLength(1);
  expect(all[0].outstandingCents).toBe('18150');
  const open = await withTenant(ctx(t), (tx) => listBills(tx, ctx(t), { status: 'open' }));
  expect(open).toHaveLength(0);
});

test('voidBill voids an awaiting_approval bill and rejects its proposal', async () => {
  const { t, vendorId } = await seed();
  const { billId, proposalId } = await withTenant(ctx(t), (tx) => createBill(tx, ctx(t), sampleBill(vendorId), ACCTS));
  await withTenant(ctx(t), (tx) => voidBill(tx, ctx(t), billId));
  const detail = await withTenant(ctx(t), (tx) => getBill(tx, ctx(t), billId));
  expect(detail.status).toBe('void');
  const prop = await withTenant(ctx(t), (tx) => getProposal(tx, ctx(t), proposalId));
  expect(prop.status).toBe('rejected');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/payables/bills.test.ts`
Expected: FAIL — cannot find module `../../src/payables/bills.js`.

- [ ] **Step 3: Write the implementation**

Create `src/payables/bills.ts`:

```typescript
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { createProposal, type Rationale } from '../proposals/proposals.js';
import { rejectProposal } from '../proposals/lifecycle.js';
import type { NewJournalEntry } from '../ledger/posting.js';
import { toCents, fromCents, sumCents } from '../db/money.js';
import { appendAudit } from '../audit/audit.js';

export interface NewBillLine { description: string; expenseAccount: string; net: string; vatRate: number; vat: string; }
export interface NewBill {
  vendorPartyId: string; billNumber: string; issueDate: string; dueDate: string; currency: string;
  lines: NewBillLine[]; source?: 'manual' | 'ocr' | 'peppol'; documentId?: string | null; einvoiceId?: string | null;
}
export interface BillAccounts { vatInputAccount: string; payablesAccount: string; }

export interface BillRow {
  id: string; vendorPartyId: string; vendorName: string; billNumber: string; issueDate: string; dueDate: string;
  currency: string; netCents: string; vatCents: string; grandTotalCents: string; amountPaidCents: string;
  outstandingCents: string; status: string; source: string; postingProposalId: string | null; journalEntryId: string | null;
}
export interface BillDetail extends BillRow {
  lines: { lineNo: number; description: string; expenseAccount: string; netCents: string; vatRate: string; vatCents: string }[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const newBillSchema = z.object({
  vendorPartyId: z.string().uuid(),
  billNumber: z.string().min(1),
  issueDate: z.string().regex(DATE),
  dueDate: z.string().regex(DATE),
  currency: z.string().length(3),
  lines: z.array(z.object({
    description: z.string().min(1),
    expenseAccount: z.string().min(1),
    net: z.string().regex(/^-?\d+(\.\d{1,2})?$/),
    vatRate: z.number(),
    vat: z.string().regex(/^-?\d+(\.\d{1,2})?$/),
  })).min(1),
  source: z.enum(['manual', 'ocr', 'peppol']).optional(),
  documentId: z.string().uuid().nullable().optional(),
  einvoiceId: z.string().uuid().nullable().optional(),
});

const ROW_COLS = `
  b.id, b.vendor_party_id AS "vendorPartyId", p.name AS "vendorName", b.bill_number AS "billNumber",
  to_char(b.issue_date,'YYYY-MM-DD') AS "issueDate", to_char(b.due_date,'YYYY-MM-DD') AS "dueDate",
  b.currency, b.net_cents::text AS "netCents", b.vat_cents::text AS "vatCents",
  b.grand_total_cents::text AS "grandTotalCents", b.amount_paid_cents::text AS "amountPaidCents",
  (b.grand_total_cents - b.amount_paid_cents)::text AS "outstandingCents",
  b.status, b.source, b.posting_proposal_id AS "postingProposalId", b.journal_entry_id AS "journalEntryId"`;

/** DR each line's expense account (net), DR VAT-input (Σvat, if > 0), CR payables (grand). */
export function buildBillEntry(bill: NewBill, accounts: BillAccounts): NewJournalEntry {
  const vat = sumCents(bill.lines.map((l) => l.vat));
  const grand = sumCents(bill.lines.map((l) => l.net)) + vat;
  const lines = bill.lines.map((l) => ({ accountCode: l.expenseAccount, debit: l.net, credit: '0', description: l.description }));
  if (vat > 0n) lines.push({ accountCode: accounts.vatInputAccount, debit: fromCents(vat), credit: '0', description: 'VAT input' });
  lines.push({ accountCode: accounts.payablesAccount, debit: '0', credit: fromCents(grand), description: 'Payable' });
  return { date: bill.issueDate, memo: `Bill ${bill.billNumber}`, currency: bill.currency, lines };
}

export async function createBill(
  tx: PoolClient, ctx: TenantContext, input: NewBill, accounts: BillAccounts,
): Promise<{ billId: string; proposalId: string }> {
  const bill = newBillSchema.parse(input);
  const netCents = sumCents(bill.lines.map((l) => l.net));
  const vatCents = sumCents(bill.lines.map((l) => l.vat));
  const grandCents = netCents + vatCents;
  const source = bill.source ?? 'manual';

  const billRes = await tx.query(
    `INSERT INTO bills(client_company_id, vendor_party_id, bill_number, issue_date, due_date, currency,
       net_cents, vat_cents, grand_total_cents, status, source, document_id, einvoice_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'awaiting_approval',$10,$11,$12) RETURNING id`,
    [ctx.clientCompanyId, bill.vendorPartyId, bill.billNumber, bill.issueDate, bill.dueDate, bill.currency,
      netCents.toString(), vatCents.toString(), grandCents.toString(), source, bill.documentId ?? null, bill.einvoiceId ?? null],
  );
  const billId = billRes.rows[0].id as string;

  for (let i = 0; i < bill.lines.length; i++) {
    const l = bill.lines[i]!;
    await tx.query(
      `INSERT INTO bill_lines(client_company_id, bill_id, line_no, description, expense_account, net_cents, vat_rate, vat_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ctx.clientCompanyId, billId, i + 1, l.description, l.expenseAccount, toCents(l.net).toString(), l.vatRate, toCents(l.vat).toString()],
    );
  }

  const rationale = {
    ruleRef: 'ap-bill',
    computation: `net ${fromCents(netCents)} + VAT ${fromCents(vatCents)} = ${fromCents(grandCents)}`,
    sourceRefs: { billId, billNumber: bill.billNumber, source },
  } as Rationale;
  const { id: proposalId } = await createProposal(tx, ctx, {
    type: 'posting', payload: buildBillEntry(bill, accounts), rationale,
    documentId: bill.documentId ?? null, status: 'pending_approval',
  });

  await tx.query(
    `UPDATE bills SET posting_proposal_id = $1 WHERE id = $2 AND client_company_id = $3`,
    [proposalId, billId, ctx.clientCompanyId],
  );
  await appendAudit(tx, ctx, { action: 'create', entityType: 'bill', entityId: billId, before: null, after: { billNumber: bill.billNumber, grandCents: grandCents.toString(), proposalId } });
  return { billId, proposalId };
}

export async function listBills(
  tx: PoolClient, ctx: TenantContext, filter: { status?: string; vendorPartyId?: string } = {},
): Promise<BillRow[]> {
  const res = await tx.query(
    `SELECT ${ROW_COLS} FROM bills b JOIN parties p ON p.id = b.vendor_party_id
     WHERE b.client_company_id = $1
       AND ($2::text IS NULL OR b.status = $2)
       AND ($3::uuid IS NULL OR b.vendor_party_id = $3)
     ORDER BY b.due_date ASC, b.created_at ASC`,
    [ctx.clientCompanyId, filter.status ?? null, filter.vendorPartyId ?? null],
  );
  return res.rows;
}

export async function getBill(tx: PoolClient, ctx: TenantContext, id: string): Promise<BillDetail> {
  const b = await tx.query(
    `SELECT ${ROW_COLS} FROM bills b JOIN parties p ON p.id = b.vendor_party_id
     WHERE b.id = $1 AND b.client_company_id = $2`,
    [id, ctx.clientCompanyId],
  );
  if (!b.rowCount) throw new Error(`Bill not found: ${id}`);
  const lines = await tx.query(
    `SELECT line_no AS "lineNo", description, expense_account AS "expenseAccount",
            net_cents::text AS "netCents", vat_rate::text AS "vatRate", vat_cents::text AS "vatCents"
     FROM bill_lines WHERE bill_id = $1 AND client_company_id = $2 ORDER BY line_no`,
    [id, ctx.clientCompanyId],
  );
  return { ...b.rows[0], lines: lines.rows };
}

export async function voidBill(tx: PoolClient, ctx: TenantContext, id: string): Promise<void> {
  const b = await getBill(tx, ctx, id);
  if (b.status !== 'awaiting_approval') throw new Error(`Only an awaiting_approval bill can be voided (status=${b.status})`);
  await tx.query(`UPDATE bills SET status = 'void' WHERE id = $1 AND client_company_id = $2`, [id, ctx.clientCompanyId]);
  if (b.postingProposalId) await rejectProposal(tx, ctx, b.postingProposalId, 'bill voided');
  await appendAudit(tx, ctx, { action: 'void', entityType: 'bill', entityId: id, before: { status: b.status }, after: { status: 'void' } });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/payables/bills.test.ts` → Expected: PASS (4 tests).
Run: `npx tsc --noEmit` (root) → Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/payables/bills.ts tests/payables/bills.test.ts
git commit -m "feat(payables): bills domain — create/list/get/void + entry builder (M2)"
```

---

### Task 4: Approval hook — post the payable, flip the bill to `open`

**Files:**
- Modify: `src/proposals/post-proposal.ts`
- Test: `tests/payables/bill-approval.test.ts`

**Interfaces:**
- Consumes: `postApprovedPosting` (existing dispatch target in `src/api/handlers.ts`).
- Produces: after a `posting` proposal is posted, any `bills` row with `posting_proposal_id = <id>` and `status = 'awaiting_approval'` gets `journal_entry_id` set and `status = 'open'`. No behavior change for non-bill postings.

- [ ] **Step 1: Write the failing test**

Create `tests/payables/bill-approval.test.ts`:

```typescript
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { createParty } from '../../src/parties/parties.js';
import { approveProposal } from '../../src/proposals/lifecycle.js';
import { postApprovedPosting } from '../../src/proposals/post-proposal.js';
import { getEntry } from '../../src/ledger/posting.js';
import { createBill, getBill } from '../../src/payables/bills.js';

const ACCTS = { vatInputAccount: '5721', payablesAccount: '5310' };

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function seedBill() {
  const t = await makeFirmAndClient();
  const setup = await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '7710', name: 'Expenses', type: 'expense' });
    await createAccount(tx, ctx(t), { code: '5721', name: 'VAT input', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '5310', name: 'Payables', type: 'liability' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    const v = await createParty(tx, ctx(t), { kind: 'vendor', name: 'Acme' });
    return createBill(tx, ctx(t), {
      vendorPartyId: v.id, billNumber: 'INV-9', issueDate: '2026-03-10', dueDate: '2026-04-09', currency: 'EUR',
      lines: [{ description: 'Svc', expenseAccount: '7710', net: '200.00', vatRate: 21, vat: '42.00' }],
    }, ACCTS);
  });
  return { t, ...setup };
}

test('approving a bill proposal posts the payable and opens the bill', async () => {
  const { t, billId, proposalId } = await seedBill();
  const { entryId } = await withTenant(ctx(t), async (tx) => {
    await approveProposal(tx, ctx(t), proposalId);
    return postApprovedPosting(tx, ctx(t), proposalId);
  });
  const detail = await withTenant(ctx(t), (tx) => getBill(tx, ctx(t), billId));
  expect(detail.status).toBe('open');
  expect(detail.journalEntryId).toBe(entryId);

  const entry = await withTenant(ctx(t), (tx) => getEntry(tx, ctx(t), entryId));
  // DR expense 200, DR VAT 42, CR payables 242
  const totalDebit = entry.lines.reduce((a, l) => a + Number(l.debit), 0);
  const totalCredit = entry.lines.reduce((a, l) => a + Number(l.credit), 0);
  expect(totalDebit).toBeCloseTo(242);
  expect(totalCredit).toBeCloseTo(242);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/payables/bill-approval.test.ts`
Expected: FAIL — bill stays `awaiting_approval` / `journalEntryId` is null (hook not present).

- [ ] **Step 3: Write the implementation**

In `src/proposals/post-proposal.ts`, inside `postApprovedPosting`, after the `documents` link block and **before** the `appendAudit` call, add:

```typescript
  // Link + open a payables bill, if this posting proposal originated from one.
  await tx.query(
    `UPDATE bills SET journal_entry_id = $1, status = 'open'
     WHERE posting_proposal_id = $2 AND client_company_id = $3 AND status = 'awaiting_approval'`,
    [entryId, proposalId, ctx.clientCompanyId],
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/payables/bill-approval.test.ts` → Expected: PASS.
Run: `npm test -- tests/proposals tests/reports` → Expected: existing posting flows unaffected.
Run: `npx tsc --noEmit` (root) → Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/proposals/post-proposal.ts tests/payables/bill-approval.test.ts
git commit -m "feat(payables): posting a bill proposal opens the bill (M2)"
```

---

### Task 5: Adopt received Peppol invoices into bills

**Files:**
- Modify: `src/einvoice/inbound.ts`
- Test: `tests/payables/peppol-adopt.test.ts`

**Interfaces:**
- Consumes: `createBill` from `../payables/bills.js`; existing `receiveInboundInvoices` shape.
- Produces: `receiveInboundInvoices` also returns `billIds: string[]` and creates a `bills` row (`source='peppol'`, linked `einvoice_id`) per inbound invoice, replacing the ad-hoc proposal it created before with the one `createBill` makes. Signature gains `accounts` and a `dueDays` option.

- [ ] **Step 1: Write the failing test**

Create `tests/payables/peppol-adopt.test.ts`:

```typescript
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { buildUblInvoice } from '../../src/einvoice/ubl.js';
import { receiveInboundInvoices } from '../../src/einvoice/inbound.js';
import { listBills } from '../../src/payables/bills.js';

const TEMPLATE = { expenseAccount: '7710', vatInputAccount: '5721', payablesAccount: '5310' };
const ACCTS = { vatInputAccount: '5721', payablesAccount: '5310' };

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('inbound Peppol invoice creates a bill (source=peppol) + proposal', async () => {
  const t = await makeFirmAndClient();
  const ap = new StubAccessPoint();
  const ubl = buildUblInvoice({
    invoiceNumber: 'S-1', issueDate: '2026-03-05', currency: 'EUR',
    supplier: { name: 'Vendor Oy', regNo: 'FI123' }, customer: { name: 'Us', regNo: 'LV1' },
    lines: [{ description: 'Parts', net: '100.00', vatRate: 21, vat: '21.00' }],
    netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
  });
  await ap.send(ubl, 'urn:us'); // seed the stub inbox

  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '7710', name: 'Expenses', type: 'expense' });
    await createAccount(tx, ctx(t), { code: '5721', name: 'VAT input', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '5310', name: 'Payables', type: 'liability' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
  });

  const res = await withTenant(ctx(t), (tx) =>
    receiveInboundInvoices(tx, ctx(t), { ap, template: TEMPLATE, accounts: ACCTS, dueDays: 30 }));
  expect(res.billIds).toHaveLength(1);

  const bills = await withTenant(ctx(t), (tx) => listBills(tx, ctx(t)));
  expect(bills).toHaveLength(1);
  expect(bills[0].source).toBe('peppol');
  expect(bills[0].grandTotalCents).toBe('12100');
  expect(bills[0].dueDate).toBe('2026-04-04'); // 2026-03-05 + 30 days
});
```

> If `StubAccessPoint`'s send/receive semantics differ (e.g., `receive()` drains a shared inbox), adjust the seeding line to match `src/einvoice/access-point.ts`; the assertions on bills are what matter.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/payables/peppol-adopt.test.ts`
Expected: FAIL — `receiveInboundInvoices` has no `billIds` / doesn't accept `accounts`.

- [ ] **Step 3: Write the implementation**

Replace `src/einvoice/inbound.ts` with (keeps the einvoice record + proposal; adds the bill via `createBill`, and derives `due_date`):

```typescript
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import type { AccessPoint } from './access-point.js';
import { parseUblInvoice } from './ubl.js';
import type { PostingTemplate } from '../intake/map-posting.js';
import { createBill, type BillAccounts } from '../payables/bills.js';
import { toCents } from '../db/money.js';

/** Add whole days to a YYYY-MM-DD date, returning YYYY-MM-DD (UTC-safe). */
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function receiveInboundInvoices(
  tx: PoolClient, ctx: TenantContext,
  args: { ap: AccessPoint; template: PostingTemplate; accounts: BillAccounts; dueDays?: number },
): Promise<{ billIds: string[]; proposalIds: string[] }> {
  const batch = await args.ap.receive();
  const billIds: string[] = [];
  const proposalIds: string[] = [];

  for (const msg of batch) {
    const ubl = parseUblInvoice(msg.ublXml);

    const rec = await tx.query(
      `INSERT INTO einvoices(client_company_id, direction, invoice_number, issue_date, grand_total_cents, currency, ubl_xml, peppol_status, vid_status)
       VALUES ($1,'inbound',$2,$3,$4,$5,$6,'received','not_required') RETURNING id`,
      [ctx.clientCompanyId, ubl.invoiceNumber, ubl.issueDate, toCents(ubl.grandTotal).toString(), ubl.currency, msg.ublXml],
    );
    const einvoiceId = rec.rows[0].id as string;

    // The customer has no per-line expense mapping from the vendor's UBL, so all
    // lines post to the template's single expense account (accountant can re-map later).
    const { billId, proposalId } = await createBill(tx, ctx, {
      vendorPartyId: await resolveOrCreateVendor(tx, ctx, ubl.supplier),
      billNumber: ubl.invoiceNumber, issueDate: ubl.issueDate, dueDate: addDays(ubl.issueDate, args.dueDays ?? 30),
      currency: ubl.currency,
      lines: ubl.lines.map((l) => ({ description: l.description, expenseAccount: args.template.expenseAccount, net: l.net, vatRate: l.vatRate, vat: l.vat })),
      source: 'peppol', einvoiceId,
    }, args.accounts);

    billIds.push(billId);
    proposalIds.push(proposalId);
  }
  return { billIds, proposalIds };
}

/** Find a vendor party by reg-no (or name); create one if absent. */
async function resolveOrCreateVendor(
  tx: PoolClient, ctx: TenantContext, supplier: { name: string; regNo?: string | null },
): Promise<string> {
  const found = await tx.query(
    `SELECT id FROM parties WHERE client_company_id = $1 AND kind IN ('vendor','both')
       AND ($2::text IS NOT NULL AND reg_no = $2 OR $2::text IS NULL AND name = $3) LIMIT 1`,
    [ctx.clientCompanyId, supplier.regNo ?? null, supplier.name],
  );
  if (found.rowCount) return found.rows[0].id as string;
  const ins = await tx.query(
    `INSERT INTO parties(client_company_id, kind, name, reg_no) VALUES ($1,'vendor',$2,$3) RETURNING id`,
    [ctx.clientCompanyId, supplier.name, supplier.regNo ?? null],
  );
  return ins.rows[0].id as string;
}
```

> **Note:** this removes the old direct `createProposal`/`extractedToJournalEntry` path from `inbound.ts` in favor of `createBill` (one posting path). If any caller of `receiveInboundInvoices` exists (grep `receiveInboundInvoices` across `src/`, `web/`, `tests/`), update it to pass `accounts` and consume `billIds`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/payables/peppol-adopt.test.ts` → Expected: PASS.
Run: `grep -rn "receiveInboundInvoices" src web tests --include=*.ts` then run any impacted test files → Expected: pass (fix call sites if the grep finds them).
Run: `npx tsc --noEmit` (root) → Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/einvoice/inbound.ts tests/payables/peppol-adopt.test.ts
git commit -m "feat(payables): received Peppol invoices become bills (M2)"
```

---

### Task 6: `bills.write` permission + API routes

**Files:**
- Modify: `web/app/lib/authz.ts`
- Create: `web/app/api/bills/route.ts`
- Create: `web/app/api/bills/[id]/route.ts`

**Interfaces:**
- Consumes: `createBill`, `listBills`, `getBill`, `voidBill` from `@domain/payables/bills.js`; `resolveTenantContext`, `withTenant`, `getSessionToken`, `nowUnix`, `assertRoleAllowed`, `errorToStatus`.
- Produces:
  - `GET /api/bills?clientCompanyId=&status=&vendorPartyId=` → `{ bills: BillRow[] }`
  - `POST /api/bills` body `{ clientCompanyId, vendorPartyId, billNumber, issueDate, dueDate, currency, lines }` → `{ billId, proposalId }` (201)
  - `GET /api/bills/:id?clientCompanyId=` → `{ bill: BillDetail }`
  - `PATCH /api/bills/:id` body `{ clientCompanyId, action: 'void' }` → `{ ok: true }`

- [ ] **Step 1: Add the permission**

In `web/app/lib/authz.ts`, add `'bills.write'` alongside `'parties.write'` (mirror its role set — grep `parties.write` in that file and copy the entry).

- [ ] **Step 2: Write the list/create route**

Create `web/app/api/bills/route.ts`:

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { listBills, createBill, type NewBill } from '@domain/payables/bills.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

// Representative LR chart defaults — accountant to confirm; matches documents/capture.
const AP_ACCOUNTS = { vatInputAccount: '5721', payablesAccount: '5310' };

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const status = req.nextUrl.searchParams.get('status') ?? undefined;
  const vendorPartyId = req.nextUrl.searchParams.get('vendorPartyId') ?? undefined;
  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const bills = await withTenant(ctx, (tx) => listBills(tx, ctx, { status, vendorPartyId }));
    return NextResponse.json({ bills }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string } & Partial<NewBill>;
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.vendorPartyId || !body.billNumber || !body.lines?.length) {
    return NextResponse.json({ error: 'missing bill fields' }, { status: 400 });
  }
  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'bills.write');
    const result = await withTenant(ctx, (tx) => createBill(tx, ctx, {
      vendorPartyId: body.vendorPartyId!, billNumber: body.billNumber!, issueDate: body.issueDate!,
      dueDate: body.dueDate!, currency: body.currency ?? 'EUR', lines: body.lines!, source: 'manual',
    }, AP_ACCOUNTS));
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
```

- [ ] **Step 3: Write the detail/void route**

Create `web/app/api/bills/[id]/route.ts`:

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { getBill, voidBill } from '@domain/payables/bills.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const { id } = await context.params;
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const bill = await withTenant(ctx, (tx) => getBill(tx, ctx, id));
    return NextResponse.json({ bill }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const { id } = await context.params;
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string; action?: string };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (body.action !== 'void') return NextResponse.json({ error: 'unsupported action' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'bills.write');
    await withTenant(ctx, (tx) => voidBill(tx, ctx, id));
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
```

- [ ] **Step 4: Verify typecheck**

Run: `cd web && npx tsc --noEmit` → Expected: no errors (confirms `@domain/payables/bills.js` resolves and `bills.write` exists).

- [ ] **Step 5: Commit**

```bash
git add web/app/lib/authz.ts web/app/api/bills/route.ts "web/app/api/bills/[id]/route.ts"
git commit -m "feat(web): bills API routes + bills.write permission (M2)"
```

---

### Task 7: i18n strings, nav icon, sidebar entry

**Files:**
- Modify: `web/app/lib/i18n.ts`, `web/app/components/NavIcon.tsx`, `web/app/components/Sidebar.tsx`

**Interfaces:**
- Produces: `nav.bills`, `nav.short.bills`, and `bills.*` keys in all three catalogs; `NavIconName` includes `'bills'`; Sidebar shows `/bills` for accountant/firm_admin (and owner).

- [ ] **Step 1: Add the `'bills'` icon**

In `web/app/components/NavIcon.tsx`, add `| 'bills'` to the `NavIconName` union and this `PATHS` entry (a document-with-lines glyph):

```tsx
  // Bills / accounts payable (invoice document)
  bills: (
    <>
      <path d="M5 3.5h8l2 2v11H5z" strokeLinejoin="round" />
      <path d="M7.5 8h5M7.5 11h5M7.5 14h3" strokeLinecap="round" />
    </>
  ),
```

- [ ] **Step 2: Add i18n keys to all three catalogs**

In `web/app/lib/i18n.ts`, add to **EN**:

```typescript
  'nav.bills': 'Bills',
  'nav.short.bills': 'Bills',
  'bills.title': 'Bills',
  'bills.new': 'New bill',
  'bills.vendor': 'Vendor',
  'bills.number': 'Bill number',
  'bills.issueDate': 'Issue date',
  'bills.dueDate': 'Due date',
  'bills.status': 'Status',
  'bills.outstanding': 'Outstanding',
  'bills.total': 'Total',
  'bills.net': 'Net',
  'bills.vat': 'VAT',
  'bills.vatRate': 'VAT %',
  'bills.description': 'Description',
  'bills.account': 'Expense account',
  'bills.addLine': 'Add line',
  'bills.removeLine': 'Remove',
  'bills.submit': 'Submit for approval',
  'bills.void': 'Void',
  'bills.lines': 'Lines',
  'bills.status.awaiting_approval': 'Awaiting approval',
  'bills.status.open': 'Open',
  'bills.status.partially_paid': 'Partially paid',
  'bills.status.paid': 'Paid',
  'bills.status.void': 'Void',
  'bills.empty': 'No bills yet.',
  'bills.emptyDetail': 'Enter a supplier bill to track what you owe.',
  'bills.saved': 'Bill submitted for approval.',
```

Add the **same keys** with Latvian values to the LV object:

```typescript
  'nav.bills': 'Rēķini (ienākošie)',
  'nav.short.bills': 'Rēķini',
  'bills.title': 'Ienākošie rēķini',
  'bills.new': 'Jauns rēķins',
  'bills.vendor': 'Piegādātājs',
  'bills.number': 'Rēķina numurs',
  'bills.issueDate': 'Izrakstīšanas datums',
  'bills.dueDate': 'Apmaksas termiņš',
  'bills.status': 'Statuss',
  'bills.outstanding': 'Atlikums',
  'bills.total': 'Kopā',
  'bills.net': 'Neto',
  'bills.vat': 'PVN',
  'bills.vatRate': 'PVN %',
  'bills.description': 'Apraksts',
  'bills.account': 'Izdevumu konts',
  'bills.addLine': 'Pievienot rindu',
  'bills.removeLine': 'Noņemt',
  'bills.submit': 'Iesniegt apstiprināšanai',
  'bills.void': 'Anulēt',
  'bills.lines': 'Rindas',
  'bills.status.awaiting_approval': 'Gaida apstiprinājumu',
  'bills.status.open': 'Atvērts',
  'bills.status.partially_paid': 'Daļēji apmaksāts',
  'bills.status.paid': 'Apmaksāts',
  'bills.status.void': 'Anulēts',
  'bills.empty': 'Vēl nav rēķinu.',
  'bills.emptyDetail': 'Ievadiet piegādātāja rēķinu, lai sekotu saistībām.',
  'bills.saved': 'Rēķins iesniegts apstiprināšanai.',
```

Add the **same keys** with Russian values to the RU object:

```typescript
  'nav.bills': 'Счета (входящие)',
  'nav.short.bills': 'Счета',
  'bills.title': 'Входящие счета',
  'bills.new': 'Новый счёт',
  'bills.vendor': 'Поставщик',
  'bills.number': 'Номер счёта',
  'bills.issueDate': 'Дата выставления',
  'bills.dueDate': 'Срок оплаты',
  'bills.status': 'Статус',
  'bills.outstanding': 'Остаток',
  'bills.total': 'Итого',
  'bills.net': 'Нетто',
  'bills.vat': 'НДС',
  'bills.vatRate': 'НДС %',
  'bills.description': 'Описание',
  'bills.account': 'Счёт расходов',
  'bills.addLine': 'Добавить строку',
  'bills.removeLine': 'Удалить',
  'bills.submit': 'Отправить на утверждение',
  'bills.void': 'Аннулировать',
  'bills.lines': 'Строки',
  'bills.status.awaiting_approval': 'Ожидает утверждения',
  'bills.status.open': 'Открыт',
  'bills.status.partially_paid': 'Частично оплачен',
  'bills.status.paid': 'Оплачен',
  'bills.status.void': 'Аннулирован',
  'bills.empty': 'Счетов пока нет.',
  'bills.emptyDetail': 'Введите счёт поставщика, чтобы отслеживать задолженность.',
  'bills.saved': 'Счёт отправлен на утверждение.',
```

- [ ] **Step 3: Add the Sidebar nav entry**

In `web/app/components/Sidebar.tsx`:
1. Extend the `key` / `shortKey` unions in `NavItem` to include `'nav.bills'` / `'nav.short.bills'`.
2. Add to `BASE_ITEMS`, right after the `nav.parties` (or `nav.invoices`) line:
```typescript
  { key: 'nav.bills', shortKey: 'nav.short.bills', href: '/bills', icon: 'bills' },
```
3. Add the same entry to `OWNER_ITEMS` if owners should see bills (match how `/invoices` is handled there).

- [ ] **Step 4: Verify typecheck**

Run: `cd web && npx tsc --noEmit` → Expected: no errors (a missing catalog key fails here — the i18n guard working).

- [ ] **Step 5: Commit**

```bash
git add web/app/lib/i18n.ts web/app/components/NavIcon.tsx web/app/components/Sidebar.tsx
git commit -m "feat(web): bills nav entry, icon, trilingual copy (M2)"
```

---

### Task 8: `/bills` list, `/bills/new` composer, `/bills/[id]` detail

**Files:**
- Create: `web/app/(cabinet)/bills/page.tsx` + `page.module.css`
- Create: `web/app/(cabinet)/bills/new/page.tsx` + `page.module.css`
- Create: `web/app/(cabinet)/bills/[id]/page.tsx` + `page.module.css`

**Interfaces:**
- Consumes: `/api/bills`, `/api/bills/:id`, `/api/parties?kind=vendor`; `useMessages`, `SkeletonCard`, `ErrorState`, `EmptyState` (existing). Client id from the `client` search param (journal/reports convention: URL param `client` → API `clientCompanyId`).

> **Before writing:** open `web/app/(cabinet)/reports/page.tsx` and `web/app/(cabinet)/invoices/new/page.tsx` and mirror their structure (Suspense wrapper, `useSearchParams`, fetch with `cache: 'no-store'`, `fmtMoney`, state/error handling). The code below follows those patterns.

- [ ] **Step 1: Write the list page**

Create `web/app/(cabinet)/bills/page.tsx`:

```tsx
'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { EmptyState } from '@/app/components/EmptyState';
import styles from './page.module.css';

interface BillRow {
  id: string; vendorName: string; billNumber: string; dueDate: string; currency: string;
  grandTotalCents: string; outstandingCents: string; status: string;
}

function money(cents: string): string {
  return new Intl.NumberFormat('lv-LV', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(cents) / 100);
}

function BillsInner() {
  const { t } = useMessages();
  const params = useSearchParams();
  const client = params.get('client');
  const [bills, setBills] = useState<BillRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!client) return;
    setError(null); setBills(null);
    try {
      const res = await fetch(`/api/bills?clientCompanyId=${encodeURIComponent(client)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setBills((await res.json()).bills as BillRow[]);
    } catch (err) { setError((err as Error).message); }
  }, [client]);

  useEffect(() => { load(); }, [load]);

  const q = client ? `?client=${encodeURIComponent(client)}` : '';

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.header}>
          <h1 className={styles.pageHeading}>{t('bills.title')}</h1>
          <Link className={styles.newButton} href={`/bills/new${q}`}>{t('bills.new')}</Link>
        </div>
        {error && <ErrorState message={error} onRetry={load} />}
        {!error && !bills && <div className={styles.skeletons}><SkeletonCard /><SkeletonCard /></div>}
        {!error && bills && bills.length === 0 && <EmptyState message={t('bills.empty')} detail={t('bills.emptyDetail')} />}
        {!error && bills && bills.length > 0 && (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{t('bills.vendor')}</th><th>{t('bills.number')}</th><th>{t('bills.dueDate')}</th>
                <th className={styles.right}>{t('bills.outstanding')}</th><th>{t('bills.status')}</th>
              </tr>
            </thead>
            <tbody>
              {bills.map((b) => (
                <tr key={b.id}>
                  <td><Link href={`/bills/${b.id}${q}`}>{b.vendorName}</Link></td>
                  <td>{b.billNumber}</td>
                  <td>{b.dueDate}</td>
                  <td className={styles.right}>{money(b.outstandingCents)}</td>
                  <td>{t(`bills.status.${b.status}` as Parameters<typeof t>[0])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </div>
  );
}

export default function BillsPage() {
  return <Suspense fallback={<SkeletonCard />}><BillsInner /></Suspense>;
}
```

- [ ] **Step 2: Write the list stylesheet**

Create `web/app/(cabinet)/bills/page.module.css`:

```css
.page { display: flex; flex-direction: column; }
.main { width: 100%; max-width: 60rem; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
.header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
.pageHeading { font-size: 1.5rem; font-weight: 650; margin: 0; }
.newButton {
  appearance: none; text-decoration: none; cursor: pointer; font: inherit; font-size: .875rem;
  padding: .5rem .875rem; border-radius: .375rem; background: var(--fg, #111827); color: var(--bg, #fff);
}
.table { width: 100%; border-collapse: collapse; }
.table th { text-align: left; font-size: .75rem; color: var(--muted, #6b7280); font-weight: 600; padding: .375rem .5rem; border-bottom: 1px solid var(--border, #e5e7eb); }
.table td { padding: .5rem; border-bottom: 1px solid var(--border-subtle, #f3f4f6); }
.right { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.skeletons { display: flex; flex-direction: column; gap: 1rem; }
```

- [ ] **Step 3: Write the composer page**

Create `web/app/(cabinet)/bills/new/page.tsx`:

```tsx
'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import styles from './page.module.css';

interface Vendor { id: string; name: string; }
interface Line { description: string; expenseAccount: string; net: string; vatRate: number; vat: string; }

const emptyLine = (): Line => ({ description: '', expenseAccount: '7710', net: '0.00', vatRate: 21, vat: '0.00' });
function money(n: number): string { return (Math.round(n * 100) / 100).toFixed(2); }

function NewBillInner() {
  const { t } = useMessages();
  const router = useRouter();
  const params = useSearchParams();
  const client = params.get('client');

  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [vendorPartyId, setVendorPartyId] = useState('');
  const [billNumber, setBillNumber] = useState('');
  const [issueDate, setIssueDate] = useState(new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState(new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!client) return;
    fetch(`/api/parties?clientCompanyId=${encodeURIComponent(client)}&kind=vendor`, { cache: 'no-store' })
      .then((r) => r.json()).then((d) => setVendors(d.parties ?? [])).catch(() => {});
  }, [client]);

  const totals = useMemo(() => {
    const net = lines.reduce((a, l) => a + Number(l.net || 0), 0);
    const vat = lines.reduce((a, l) => a + Number(l.vat || 0), 0);
    return { net, vat, grand: net + vat };
  }, [lines]);

  const setLine = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, j) => {
      if (j !== i) return l;
      const next = { ...l, ...patch };
      if (patch.net !== undefined || patch.vatRate !== undefined) next.vat = money(Number(next.net || 0) * next.vatRate / 100);
      return next;
    }));

  const submit = useCallback(async () => {
    if (!client) return;
    setSaving(true); setError(null);
    try {
      const res = await fetch('/api/bills', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientCompanyId: client, vendorPartyId, billNumber, issueDate, dueDate, currency: 'EUR', lines }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      router.push(`/bills?client=${encodeURIComponent(client)}`);
    } catch (err) { setError((err as Error).message); setSaving(false); }
  }, [client, vendorPartyId, billNumber, issueDate, dueDate, lines, router]);

  const valid = vendorPartyId && billNumber && lines.length > 0 && lines.every((l) => l.description);

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <h1 className={styles.pageHeading}>{t('bills.new')}</h1>
        {error && <ErrorState message={error} />}
        <div className={styles.fields}>
          <label className={styles.field}>{t('bills.vendor')}
            <select value={vendorPartyId} onChange={(e) => setVendorPartyId(e.target.value)}>
              <option value="">—</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </label>
          <label className={styles.field}>{t('bills.number')}
            <input value={billNumber} onChange={(e) => setBillNumber(e.target.value)} />
          </label>
          <label className={styles.field}>{t('bills.issueDate')}
            <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
          </label>
          <label className={styles.field}>{t('bills.dueDate')}
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </label>
        </div>

        <table className={styles.table}>
          <thead>
            <tr>
              <th>{t('bills.description')}</th><th>{t('bills.account')}</th>
              <th className={styles.right}>{t('bills.net')}</th><th className={styles.right}>{t('bills.vatRate')}</th>
              <th className={styles.right}>{t('bills.vat')}</th><th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td><input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} /></td>
                <td><input value={l.expenseAccount} onChange={(e) => setLine(i, { expenseAccount: e.target.value })} className={styles.acct} /></td>
                <td className={styles.right}><input value={l.net} onChange={(e) => setLine(i, { net: e.target.value })} className={styles.num} /></td>
                <td className={styles.right}><input value={l.vatRate} onChange={(e) => setLine(i, { vatRate: Number(e.target.value) })} className={styles.num} /></td>
                <td className={styles.right}>{l.vat}</td>
                <td>{lines.length > 1 && <button type="button" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>{t('bills.removeLine')}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" className={styles.addLine} onClick={() => setLines((ls) => [...ls, emptyLine()])}>{t('bills.addLine')}</button>

        <div className={styles.totals}>
          <div><span>{t('bills.net')}</span><span className={styles.right}>{money(totals.net)}</span></div>
          <div><span>{t('bills.vat')}</span><span className={styles.right}>{money(totals.vat)}</span></div>
          <div className={styles.grand}><span>{t('bills.total')}</span><span className={styles.right}>{money(totals.grand)}</span></div>
        </div>

        <button type="button" className={styles.submit} disabled={!valid || saving} onClick={submit}>{t('bills.submit')}</button>
      </main>
    </div>
  );
}

export default function NewBillPage() {
  return <Suspense fallback={<SkeletonCard />}><NewBillInner /></Suspense>;
}
```

- [ ] **Step 4: Write the composer + detail stylesheets and detail page**

Create `web/app/(cabinet)/bills/new/page.module.css`:

```css
.page { display: flex; flex-direction: column; }
.main { width: 100%; max-width: 52rem; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
.pageHeading { font-size: 1.5rem; font-weight: 650; margin: 0 0 1rem; }
.fields { display: flex; flex-wrap: wrap; gap: 1rem; margin-bottom: 1.5rem; }
.field { display: flex; flex-direction: column; gap: .25rem; font-size: .8125rem; color: var(--muted, #6b7280); }
.field input, .field select { font: inherit; padding: .375rem .5rem; border: 1px solid var(--border, #e5e7eb); border-radius: .375rem; }
.table { width: 100%; border-collapse: collapse; }
.table th { text-align: left; font-size: .75rem; color: var(--muted, #6b7280); padding: .375rem .5rem; }
.table td { padding: .25rem .5rem; }
.table input { font: inherit; width: 100%; padding: .3125rem .5rem; border: 1px solid var(--border, #e5e7eb); border-radius: .375rem; }
.num { text-align: right; font-variant-numeric: tabular-nums; max-width: 6rem; }
.acct { max-width: 7rem; }
.right { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.addLine { margin: .5rem 0 1.5rem; appearance: none; cursor: pointer; font: inherit; font-size: .8125rem; padding: .375rem .625rem; border: 1px solid var(--border, #e5e7eb); border-radius: .375rem; background: none; }
.totals { display: flex; flex-direction: column; gap: .25rem; align-items: flex-end; margin-bottom: 1.5rem; }
.totals > div { display: flex; gap: 2rem; min-width: 14rem; justify-content: space-between; }
.grand { font-weight: 700; font-size: 1.0625rem; border-top: 2px solid var(--fg, #111827); padding-top: .375rem; }
.submit { appearance: none; cursor: pointer; font: inherit; padding: .625rem 1rem; border: none; border-radius: .375rem; background: var(--fg, #111827); color: var(--bg, #fff); }
.submit:disabled { opacity: .5; cursor: not-allowed; }
```

Create `web/app/(cabinet)/bills/[id]/page.tsx`:

```tsx
'use client';

import { Suspense, use, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import styles from './page.module.css';

interface BillDetail {
  id: string; vendorName: string; billNumber: string; issueDate: string; dueDate: string; currency: string;
  netCents: string; vatCents: string; grandTotalCents: string; outstandingCents: string; status: string;
  lines: { lineNo: number; description: string; expenseAccount: string; netCents: string; vatRate: string; vatCents: string }[];
}
function money(cents: string): string { return new Intl.NumberFormat('lv-LV', { minimumFractionDigits: 2 }).format(Number(cents) / 100); }

function DetailInner({ id }: { id: string }) {
  const { t } = useMessages();
  const router = useRouter();
  const client = useSearchParams().get('client');
  const [bill, setBill] = useState<BillDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!client) return;
    setError(null);
    try {
      const res = await fetch(`/api/bills/${id}?clientCompanyId=${encodeURIComponent(client)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setBill((await res.json()).bill as BillDetail);
    } catch (err) { setError((err as Error).message); }
  }, [client, id]);
  useEffect(() => { load(); }, [load]);

  const voidBill = useCallback(async () => {
    if (!client) return;
    const res = await fetch(`/api/bills/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientCompanyId: client, action: 'void' }),
    });
    if (res.ok) router.push(`/bills?client=${encodeURIComponent(client)}`); else setError((await res.json().catch(() => ({}))).error ?? 'error');
  }, [client, id, router]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!bill) return <SkeletonCard />;

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <h1 className={styles.pageHeading}>{bill.vendorName} · {bill.billNumber}</h1>
        <dl className={styles.meta}>
          <div><dt>{t('bills.issueDate')}</dt><dd>{bill.issueDate}</dd></div>
          <div><dt>{t('bills.dueDate')}</dt><dd>{bill.dueDate}</dd></div>
          <div><dt>{t('bills.status')}</dt><dd>{t(`bills.status.${bill.status}` as Parameters<typeof t>[0])}</dd></div>
          <div><dt>{t('bills.outstanding')}</dt><dd>{money(bill.outstandingCents)}</dd></div>
        </dl>
        <h2 className={styles.h2}>{t('bills.lines')}</h2>
        <table className={styles.table}>
          <thead><tr><th>{t('bills.description')}</th><th>{t('bills.account')}</th><th className={styles.right}>{t('bills.net')}</th><th className={styles.right}>{t('bills.vat')}</th></tr></thead>
          <tbody>
            {bill.lines.map((l) => (
              <tr key={l.lineNo}><td>{l.description}</td><td>{l.expenseAccount}</td><td className={styles.right}>{money(l.netCents)}</td><td className={styles.right}>{money(l.vatCents)}</td></tr>
            ))}
          </tbody>
        </table>
        {bill.status === 'awaiting_approval' && <button type="button" className={styles.void} onClick={voidBill}>{t('bills.void')}</button>}
      </main>
    </div>
  );
}

export default function BillDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <Suspense fallback={<SkeletonCard />}><DetailInner id={id} /></Suspense>;
}
```

Create `web/app/(cabinet)/bills/[id]/page.module.css`:

```css
.page { display: flex; flex-direction: column; }
.main { width: 100%; max-width: 48rem; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
.pageHeading { font-size: 1.375rem; font-weight: 650; margin: 0 0 1rem; }
.meta { display: flex; flex-wrap: wrap; gap: 1.5rem; margin: 0 0 1.5rem; }
.meta div { display: flex; flex-direction: column; }
.meta dt { font-size: .75rem; color: var(--muted, #6b7280); }
.meta dd { margin: 0; font-variant-numeric: tabular-nums; }
.h2 { font-size: 1rem; font-weight: 600; margin: 0 0 .5rem; }
.table { width: 100%; border-collapse: collapse; margin-bottom: 1.5rem; }
.table th { text-align: left; font-size: .75rem; color: var(--muted, #6b7280); padding: .375rem .5rem; border-bottom: 1px solid var(--border, #e5e7eb); }
.table td { padding: .375rem .5rem; border-bottom: 1px solid var(--border-subtle, #f3f4f6); }
.right { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.void { appearance: none; cursor: pointer; font: inherit; font-size: .8125rem; padding: .5rem .875rem; border: 1px solid var(--danger, #b91c1c); color: var(--danger, #b91c1c); border-radius: .375rem; background: none; }
```

- [ ] **Step 5: Verify build + smoke test**

Run: `cd web && npx tsc --noEmit` → Expected: no errors.
Run: `cd web && npm run build` → Expected: build succeeds; `/bills`, `/bills/new`, `/bills/[id]` in the route list.

Manual (Postgres up, `npm run seed` from root if available; ensure accounts `7710`, `5721`, `5310` and an open period exist for the client): sign in, select a client, open `/bills` → empty state → "New bill" → pick a vendor, add lines, submit → the bill appears in `/bills` as *Awaiting approval*; the approval queue (`/`) shows the posting proposal; approving it turns the bill *Open* and posts DR expense/VAT / CR payables (verify on `/journal`).

- [ ] **Step 6: Commit**

```bash
git add "web/app/(cabinet)/bills"
git commit -m "feat(web): /bills list, composer, and detail pages (M2)"
```

---

### Task 9: Full verification + docs

**Files:**
- Modify: `src/dev/seed.ts` (ensure `5721` exists), `HANDOFF.md`, `docs/ROADMAP-market-gaps.md`

- [ ] **Step 1: Ensure the VAT-input account is seeded**

In `src/dev/seed.ts`, confirm/add the input-VAT account so manual bills post in dev:
```typescript
  { code: '5721', name: 'Priekšnodoklis (VAT input)', type: 'asset' },
```
(Add it to the same accounts array as `2620`/`5310` if not already present. Skip if present.)

- [ ] **Step 2: Run the whole suite**

Run: `npm test` (root) → Expected: all pass, including `tests/payables/*` and untouched suites.
Run: `npx tsc --noEmit` (root) and `cd web && npx tsc --noEmit` → Expected: no errors.

- [ ] **Step 3: Update roadmap + handoff**

In `docs/ROADMAP-market-gaps.md`, update M2's status to 🔶 with a note: "Bills core shipped 2026-07-10 — `src/payables/` (bills + lines), approval-gated posting, `/bills` list/composer/detail, Peppol inbound → bills. Pay-out loop (settlement, pay run, camt.053 match, aging) tracked in Plan 2." In `HANDOFF.md`, add a line under the market-gaps progress note.

- [ ] **Step 4: Commit**

```bash
git add src/dev/seed.ts HANDOFF.md docs/ROADMAP-market-gaps.md
git commit -m "docs: mark M2 bills core shipped; seed VAT-input account (M2)"
```

---

## Self-Review notes

- **Spec coverage (Plan 1 portion):** bills + bill_lines schema (Task 1) ✓; vendor IBAN, needed by Plan 2's pay run, added early (Task 2) ✓; first-class bills with per-line expense accounts + approval-gated posting via existing queue (Tasks 3–4) ✓; Peppol inbound adopted into bills, one posting path (Task 5) ✓; API + pages + i18n/nav (Tasks 6–8) ✓; docs/roadmap (Task 9) ✓. Deferred to Plan 2: settlement, pay runs, camt.053 AP matching, aging. OCR-document adoption explicitly deferred.
- **Type consistency:** `NewBill`/`NewBillLine`/`BillAccounts`/`BillRow`/`BillDetail` defined in `bills.ts` and consumed by `inbound.ts`, the routes, and pages; `createBill` returns `{ billId, proposalId }` used consistently; `getBill` returns `BillDetail` with `lines`; API `{ bills }` / `{ bill }` envelopes match the pages' parsing.
- **Convention match:** new-table RLS block copied from `014`; `(tx, ctx, …)` domain signatures inside `withTenant`; integer-cent money; `appendAudit` on every mutation; route auth/error pattern from `parties/route.ts`; page pattern from `reports`/`invoices/new`; i18n in all three catalogs; stroked icon.
- **Assumptions flagged:** default account codes (`7710/5721/5310`) representative — accountant to confirm; a per-client account-mapping settings screen is deferred.
