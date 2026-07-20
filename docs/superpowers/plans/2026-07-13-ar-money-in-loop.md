# AR Money-In Loop Implementation Plan (M4 slice A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the accounts-receivable money-in loop — persist per-invoice customer + due date + payment status, settle receivables (manual + bank-match), age them, and surface aged receivables — as a faithful mirror of the M2 money-out loop.

**Architecture:** The outbound `einvoices` row *is* the receivable (mirroring how `bills` is the payable). We extend `einvoices` with open-item columns, add an `invoice_payments` table, a new `src/receivables/` domain module (`receivables`, `settlement`, `aging`), an invoice-linked AR bank matcher in `src/banking/match.ts` (retiring the unused GL-level `proposeMatches`), a `receivable_direct` branch in the bank-match confirm path, an `ar-aging` API route + reports tab, and customer default payment terms on `parties`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), PostgreSQL with RLS, `pg`, Zod, Vitest, Next.js (web). Money as integer cents via `src/db/money.ts`.

## Global Constraints

- Domain functions take `(tx: PoolClient, ctx: TenantContext, ...)`; every mutation calls `appendAudit(...)`. Never bypass `withTenant`.
- Money as integer cents through `src/db/money.ts` (`toCents`/`fromCents`/`sumCents`); never floats. Amount strings match `/^-?\d+(\.\d{1,2})?$/`.
- Every new table: `client_company_id uuid NOT NULL REFERENCES client_companies(id)`, `ENABLE`+`FORCE ROW LEVEL SECURITY`, a `_tenant_isolation` policy on `current_setting('app.current_client_id', true)::uuid` (USING + WITH CHECK), and `GRANT SELECT, INSERT, UPDATE ... TO bookkeeping_app`.
- Ledger is append-only; settlement posts reversing/settling entries via `postEntry`, never edits.
- Web API routes: `getSessionToken()` → `resolveTenantContext(token, clientCompanyId, nowUnix())` → (mutations) `assertRoleAllowed(...)` → domain call inside `withTenant`; caught errors mapped via `errorToStatus`.
- i18n: every user-facing string added to **all three** catalogs (EN, LV, RU) in `web/app/lib/i18n.ts` — the typed record fails the build if a key is missing in any language.
- Receivable/bank account defaults: receivable `'2310'`, bank `'2620'` (matching `web/app/api/einvoices/route.ts` and `web/app/api/bank/import/route.ts`).
- Verification gate for every task: `npx tsc --noEmit` (root) clean before commit; the full `npm test` and `web/` typecheck+build run at the end (Task 8).
- Test DB: tests use `resetDb()`/`closeDb()` from `tests/helpers/db.js`; follow the setup pattern in `tests/payables/settlement.test.ts` and `tests/api/capture-handler.test.ts`.

---

### Task 1: Migration 032 + customer payment terms

**Files:**
- Create: `migrations/032_receivables.sql`
- Modify: `src/parties/parties.ts`
- Modify: `web/app/api/parties/route.ts` (only if it whitelists fields — see step)
- Modify: `web/app/lib/i18n.ts` (parties terms label, all three catalogs)
- Modify: `web/app/(cabinet)/parties/page.tsx` (terms input)
- Test: `tests/parties/parties.test.ts`

**Interfaces:**
- Produces: `einvoices` gains `customer_party_id uuid`, `due_date date`, `amount_paid_cents bigint NOT NULL DEFAULT 0`, `status text` (nullable; values `open|partially_paid|paid|void`). New table `invoice_payments`. `parties` gains `payment_terms_days int`. `PartyRow.paymentTermsDays: number | null`; `createParty`/`updateParty` accept `paymentTermsDays?: number | null`.

- [ ] **Step 1: Write the migration**

Create `migrations/032_receivables.sql`:

```sql
-- Accounts receivable: open-item tracking on outbound einvoices + payments (M4 slice A).
-- The outbound einvoice row IS the receivable (mirrors bills for payables).
ALTER TABLE einvoices ADD COLUMN customer_party_id uuid REFERENCES parties(id);
ALTER TABLE einvoices ADD COLUMN due_date date;
ALTER TABLE einvoices ADD COLUMN amount_paid_cents bigint NOT NULL DEFAULT 0;
-- Nullable, no table default: set to 'open' only on the outbound issue path so inbound
-- rows stay NULL and never surface in AR aging/settlement.
ALTER TABLE einvoices ADD COLUMN status text
  CHECK (status IN ('open','partially_paid','paid','void'));
CREATE INDEX einvoices_ar_idx ON einvoices(client_company_id, direction, status, due_date);

-- Per-customer default payment terms (days from issue) used to compute an invoice due date.
ALTER TABLE parties ADD COLUMN payment_terms_days int;

CREATE TABLE invoice_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  einvoice_id uuid NOT NULL REFERENCES einvoices(id),
  amount_cents bigint NOT NULL,
  paid_date date NOT NULL,
  method text NOT NULL CHECK (method IN ('bank_match','manual')),
  bank_transaction_id uuid REFERENCES bank_transactions(id),
  journal_entry_id uuid NOT NULL REFERENCES journal_entries(id),
  cleared_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoice_payments_einvoice_idx ON invoice_payments(einvoice_id);
CREATE INDEX invoice_payments_banktxn_idx ON invoice_payments(client_company_id, bank_transaction_id);

ALTER TABLE invoice_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY invoice_payments_tenant_isolation ON invoice_payments
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON invoice_payments TO bookkeeping_app;
```

- [ ] **Step 2: Run the migration against the test DB and confirm it applies**

Run: `npm run migrate`
Expected: completes without error; `032_receivables.sql` reported applied.

- [ ] **Step 3: Write the failing test for customer payment terms round-trip**

Add to `tests/parties/parties.test.ts` (follow the existing setup in that file for `ctx`/`withTenant`):

```ts
test('stores and updates a customer default payment terms', async () => {
  const created = await withTenant(cid, (tx) => createParty(tx, cid, { kind: 'customer', name: 'SIA Klients', paymentTermsDays: 14 }));
  const afterCreate = await withTenant(cid, (tx) => getParty(tx, cid, created.id));
  expect(afterCreate.paymentTermsDays).toBe(14);
  await withTenant(cid, (tx) => updateParty(tx, cid, created.id, { paymentTermsDays: 30 }));
  const afterUpdate = await withTenant(cid, (tx) => getParty(tx, cid, created.id));
  expect(afterUpdate.paymentTermsDays).toBe(30);
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run tests/parties/parties.test.ts -t 'payment terms'`
Expected: FAIL — `paymentTermsDays` is `undefined` (column/field not wired).

- [ ] **Step 5: Wire `payment_terms_days` through `src/parties/parties.ts`**

Change the `PartyRow` interface, select cols, schema, and both writers:

```ts
export interface PartyRow { id: string; kind: PartyKind; name: string; regNo: string | null; vatNo: string | null; iban: string | null; paymentTermsDays: number | null; }

const newPartySchema = z.object({
  kind: z.enum(['customer', 'vendor', 'both']),
  name: z.string().min(1),
  regNo: z.string().min(1).nullable().optional(),
  vatNo: z.string().min(1).nullable().optional(),
  iban: z.string().min(1).nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
});

const SELECT_COLS = 'id, kind, name, reg_no AS "regNo", vat_no AS "vatNo", iban, payment_terms_days AS "paymentTermsDays"';
```

In `createParty`, extend the signature and INSERT:

```ts
export async function createParty(
  tx: PoolClient, ctx: TenantContext,
  input: { kind: PartyKind; name: string; regNo?: string | null; vatNo?: string | null; iban?: string | null; paymentTermsDays?: number | null },
): Promise<{ id: string }> {
  const p = newPartySchema.parse(input);
  const res = await tx.query(
    `INSERT INTO parties(client_company_id, kind, name, reg_no, vat_no, iban, payment_terms_days)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [ctx.clientCompanyId, p.kind, p.name, p.regNo ?? null, p.vatNo ?? null, p.iban ?? null, p.paymentTermsDays ?? null],
  );
  const id = res.rows[0].id as string;
  await appendAudit(tx, ctx, { action: 'create', entityType: 'party', entityId: id, before: null, after: p });
  return { id };
}
```

In `updateParty`, extend the patch type, merged object, and UPDATE:

```ts
export async function updateParty(
  tx: PoolClient, ctx: TenantContext, id: string,
  patch: { name?: string; regNo?: string | null; vatNo?: string | null; kind?: PartyKind; iban?: string | null; paymentTermsDays?: number | null },
): Promise<void> {
  const before = await getParty(tx, ctx, id);
  const merged = {
    name: patch.name ?? before.name,
    regNo: patch.regNo !== undefined ? patch.regNo : before.regNo,
    vatNo: patch.vatNo !== undefined ? patch.vatNo : before.vatNo,
    kind: patch.kind ?? before.kind,
    iban: patch.iban !== undefined ? patch.iban : before.iban,
    paymentTermsDays: patch.paymentTermsDays !== undefined ? patch.paymentTermsDays : before.paymentTermsDays,
  };
  await tx.query(
    `UPDATE parties SET name=$1, reg_no=$2, vat_no=$3, kind=$4, iban=$5, payment_terms_days=$6
     WHERE id=$7 AND client_company_id=$8`,
    [merged.name, merged.regNo, merged.vatNo, merged.kind, merged.iban, merged.paymentTermsDays, id, ctx.clientCompanyId],
  );
  await appendAudit(tx, ctx, { action: 'update', entityType: 'party', entityId: id, before, after: merged });
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/parties/parties.test.ts`
Expected: PASS (all parties tests, including the new one).

- [ ] **Step 7: Surface the field in the parties API + UI**

First check whether `web/app/api/parties/route.ts` explicitly picks body fields before calling `createParty`/`updateParty`. If it forwards a whitelist, add `paymentTermsDays` to it; if it forwards the whole body, no change is needed. Then in `web/app/(cabinet)/parties/page.tsx` add a number input labelled `t('parties.paymentTerms')` bound to the customer's `paymentTermsDays` (mirror the existing `iban` field's control). Add the key to all three catalogs in `web/app/lib/i18n.ts`:

```ts
// EN
'parties.paymentTerms': 'Payment terms (days)',
// LV
'parties.paymentTerms': 'Apmaksas termiņš (dienas)',
// RU
'parties.paymentTerms': 'Срок оплаты (дни)',
```

- [ ] **Step 8: Typecheck and commit**

Run: `npx tsc --noEmit` (expect clean). Then in `web/`: `npx tsc --noEmit` (expect clean).

```bash
git add migrations/032_receivables.sql src/parties/parties.ts web/app/api/parties/route.ts web/app/\(cabinet\)/parties/page.tsx web/app/lib/i18n.ts tests/parties/parties.test.ts
git commit -m "feat(receivables): migration 032 + customer payment terms (M4 slice A)"
```

---

### Task 2: Receivables read model + issue-time persistence

**Files:**
- Create: `src/receivables/receivables.ts`
- Modify: `src/einvoice/outbound.ts`
- Test: `tests/receivables/receivables.test.ts`

**Interfaces:**
- Consumes: `einvoices` open-item columns (Task 1).
- Produces:
  - `ReceivableRow { id; invoiceNumber; customerPartyId: string | null; issueDate; dueDate: string | null; currency; grandTotalCents; amountPaidCents; outstandingCents; status: 'open'|'partially_paid'|'paid'|'void' | null }`
  - `getReceivable(tx, ctx, id): Promise<ReceivableRow>` (outbound only; throws if not found)
  - `listReceivables(tx, ctx, filter?: { status?: string }): Promise<ReceivableRow[]>`
  - `voidReceivable(tx, ctx, id): Promise<void>`
  - `sendInvoice` args gain `customerPartyId?: string | null` and `dueDate?: string | null`; the einvoice row is written with those plus `status='open'`.

- [ ] **Step 1: Write the failing test**

Create `tests/receivables/receivables.test.ts` (mirror the setup blocks in `tests/einvoice/outbound.test.ts` for firm/client/user/accounts/period + a `StubAccessPoint`; issue one invoice, then read it back):

```ts
test('an issued invoice is persisted as an open receivable with customer + due date', async () => {
  const { cid, customerId } = await setup(); // creates a 'customer' party, receivable/sales/vat accounts, open period
  const { einvoiceId } = await withTenant(cid, (tx) => sendInvoice(tx, cid, {
    invoice: SAMPLE_INVOICE,           // grandTotal '121.00', net '100.00', vat '21.00', issueDate '2026-03-10'
    recipientPeppolId: '0088:test', ap: new StubAccessPoint(),
    receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721',
    customerPartyId: customerId, dueDate: '2026-03-24',
  }));
  const r = await withTenant(cid, (tx) => getReceivable(tx, cid, einvoiceId));
  expect(r.status).toBe('open');
  expect(r.customerPartyId).toBe(customerId);
  expect(r.dueDate).toBe('2026-03-24');
  expect(r.grandTotalCents).toBe('12100');
  expect(r.amountPaidCents).toBe('0');
  expect(r.outstandingCents).toBe('12100');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/receivables/receivables.test.ts`
Expected: FAIL — `sendInvoice` has no `customerPartyId`/`dueDate` args and `getReceivable` doesn't exist.

- [ ] **Step 3: Extend `sendInvoice` to persist open-item fields**

In `src/einvoice/outbound.ts`, extend the args type and the INSERT:

```ts
export async function sendInvoice(
  tx: PoolClient, ctx: TenantContext,
  args: { invoice: EInvoice; recipientPeppolId: string; ap: AccessPoint; receivableAccount: string; salesAccount: string; vatAccount: string; customerPartyId?: string | null; dueDate?: string | null },
): Promise<{ einvoiceId: string; entryId: string; messageId: string }> {
```

Replace the einvoice INSERT (step 5 in that file) with one that includes the new columns:

```ts
  const res = await tx.query(
    `INSERT INTO einvoices(client_company_id, direction, invoice_number, issue_date, grand_total_cents, currency, ubl_xml, vid_status, peppol_status, peppol_message_id, journal_entry_id, customer_party_id, due_date, status)
     VALUES ($1,'outbound',$2,$3,$4,$5,$6,'pending','sent',$7,$8,$9,$10,'open') RETURNING id`,
    [ctx.clientCompanyId, inv.invoiceNumber, inv.issueDate, toCents(inv.grandTotal).toString(), inv.currency, ubl, messageId, entryId, args.customerPartyId ?? null, args.dueDate ?? inv.dueDate ?? null],
  );
```

- [ ] **Step 4: Create the receivables read model**

Create `src/receivables/receivables.ts`:

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appendAudit } from '../audit/audit.js';

export type ReceivableStatus = 'open' | 'partially_paid' | 'paid' | 'void';
export interface ReceivableRow {
  id: string; invoiceNumber: string; customerPartyId: string | null; issueDate: string;
  dueDate: string | null; currency: string; grandTotalCents: string; amountPaidCents: string;
  outstandingCents: string; status: ReceivableStatus | null;
}

const ROW_COLS = `
  id, invoice_number AS "invoiceNumber", customer_party_id AS "customerPartyId",
  to_char(issue_date,'YYYY-MM-DD') AS "issueDate", to_char(due_date,'YYYY-MM-DD') AS "dueDate",
  currency, grand_total_cents::text AS "grandTotalCents", amount_paid_cents::text AS "amountPaidCents",
  (grand_total_cents - amount_paid_cents)::text AS "outstandingCents", status`;

export async function getReceivable(tx: PoolClient, ctx: TenantContext, id: string): Promise<ReceivableRow> {
  const res = await tx.query(
    `SELECT ${ROW_COLS} FROM einvoices WHERE id = $1 AND client_company_id = $2 AND direction = 'outbound'`,
    [id, ctx.clientCompanyId],
  );
  if (!res.rowCount) throw new Error(`Receivable not found: ${id}`);
  return res.rows[0];
}

export async function listReceivables(
  tx: PoolClient, ctx: TenantContext, filter: { status?: string } = {},
): Promise<ReceivableRow[]> {
  const res = await tx.query(
    `SELECT ${ROW_COLS} FROM einvoices
     WHERE client_company_id = $1 AND direction = 'outbound'
       AND ($2::text IS NULL OR status = $2)
     ORDER BY due_date ASC NULLS LAST, created_at ASC`,
    [ctx.clientCompanyId, filter.status ?? null],
  );
  return res.rows;
}

export async function voidReceivable(tx: PoolClient, ctx: TenantContext, id: string): Promise<void> {
  const r = await getReceivable(tx, ctx, id);
  if (r.status !== 'open') throw new Error(`Only an open receivable can be voided (status=${r.status})`);
  await tx.query(`UPDATE einvoices SET status = 'void' WHERE id = $1 AND client_company_id = $2`, [id, ctx.clientCompanyId]);
  await appendAudit(tx, ctx, { action: 'void', entityType: 'receivable', entityId: id, before: { status: r.status }, after: { status: 'void' } });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/receivables/receivables.test.ts`
Expected: PASS.

- [ ] **Step 6: Confirm the existing outbound test still passes**

Run: `npx vitest run tests/einvoice/outbound.test.ts`
Expected: PASS (new args are optional; existing callers unaffected).

- [ ] **Step 7: Typecheck and commit**

Run: `npx tsc --noEmit` (expect clean).

```bash
git add src/receivables/receivables.ts src/einvoice/outbound.ts tests/receivables/receivables.test.ts
git commit -m "feat(receivables): read model + issue-time customer/due-date/status persistence"
```

---

### Task 3: settleReceivable

**Files:**
- Create: `src/receivables/settlement.ts`
- Test: `tests/receivables/settlement.test.ts`

**Interfaces:**
- Consumes: `getReceivable` (Task 2), `postEntry`, `fromCents`, `appendAudit`.
- Produces: `settleReceivable(tx, ctx, { einvoiceId, amountCents, paidDate, method, bankTransactionId?, bankAccount, receivableAccount }): Promise<{ entryId: string; invoicePaymentId: string }>`. `method: 'bank_match' | 'manual'`. Posts `DR bankAccount / CR receivableAccount`, inserts `invoice_payments`, advances `open→partially_paid→paid`.

- [ ] **Step 1: Write the failing tests**

Create `tests/receivables/settlement.test.ts` (reuse the Task 2 `setup()` + issue helper; a partial then a final settlement, plus guard cases):

```ts
test('full settlement marks the receivable paid and posts DR bank / CR receivable', async () => {
  const { cid, einvoiceId } = await issueOpenReceivable(); // grand 12100
  const { entryId } = await withTenant(cid, (tx) => settleReceivable(tx, cid, {
    einvoiceId, amountCents: '12100', paidDate: '2026-03-20', method: 'manual', bankAccount: '2620', receivableAccount: '2310',
  }));
  expect(entryId).toBeTruthy();
  const r = await withTenant(cid, (tx) => getReceivable(tx, cid, einvoiceId));
  expect(r.status).toBe('paid');
  expect(r.amountPaidCents).toBe('12100');
  expect(r.outstandingCents).toBe('0');
});

test('partial settlement marks partially_paid, second settles to paid', async () => {
  const { cid, einvoiceId } = await issueOpenReceivable();
  await withTenant(cid, (tx) => settleReceivable(tx, cid, { einvoiceId, amountCents: '5000', paidDate: '2026-03-20', method: 'manual', bankAccount: '2620', receivableAccount: '2310' }));
  let r = await withTenant(cid, (tx) => getReceivable(tx, cid, einvoiceId));
  expect(r.status).toBe('partially_paid');
  await withTenant(cid, (tx) => settleReceivable(tx, cid, { einvoiceId, amountCents: '7100', paidDate: '2026-03-21', method: 'manual', bankAccount: '2620', receivableAccount: '2310' }));
  r = await withTenant(cid, (tx) => getReceivable(tx, cid, einvoiceId));
  expect(r.status).toBe('paid');
});

test('rejects over-payment beyond outstanding', async () => {
  const { cid, einvoiceId } = await issueOpenReceivable();
  await expect(withTenant(cid, (tx) => settleReceivable(tx, cid, { einvoiceId, amountCents: '12101', paidDate: '2026-03-20', method: 'manual', bankAccount: '2620', receivableAccount: '2310' }))).rejects.toThrow(/exceeds outstanding/);
});

test('rejects settling a void receivable', async () => {
  const { cid, einvoiceId } = await issueOpenReceivable();
  await withTenant(cid, (tx) => voidReceivable(tx, cid, einvoiceId));
  await expect(withTenant(cid, (tx) => settleReceivable(tx, cid, { einvoiceId, amountCents: '100', paidDate: '2026-03-20', method: 'manual', bankAccount: '2620', receivableAccount: '2310' }))).rejects.toThrow(/not settleable/);
});

test('rejects a second settlement referencing the same bank transaction', async () => {
  const { cid, einvoiceId, bankTxnId } = await issueOpenReceivableWithBankTxn(); // amount 12100
  await withTenant(cid, (tx) => settleReceivable(tx, cid, { einvoiceId, amountCents: '6000', paidDate: '2026-03-20', method: 'bank_match', bankTransactionId: bankTxnId, bankAccount: '2620', receivableAccount: '2310' }));
  await expect(withTenant(cid, (tx) => settleReceivable(tx, cid, { einvoiceId, amountCents: '6000', paidDate: '2026-03-21', method: 'bank_match', bankTransactionId: bankTxnId, bankAccount: '2620', receivableAccount: '2310' }))).rejects.toThrow(/already settled by bank transaction/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/receivables/settlement.test.ts`
Expected: FAIL — `settleReceivable` not defined.

- [ ] **Step 3: Implement `settleReceivable`**

Create `src/receivables/settlement.ts`:

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { getReceivable } from './receivables.js';
import { postEntry } from '../ledger/posting.js';
import { fromCents } from '../db/money.js';
import { appendAudit } from '../audit/audit.js';

export interface SettleReceivableArgs {
  einvoiceId: string;
  amountCents: string;
  paidDate: string;
  method: 'bank_match' | 'manual';
  bankTransactionId?: string | null;
  bankAccount: string;
  receivableAccount: string;
}

/** Post DR bank / CR receivable for amountCents, record the payment, advance receivable status. */
export async function settleReceivable(
  tx: PoolClient, ctx: TenantContext, args: SettleReceivableArgs,
): Promise<{ entryId: string; invoicePaymentId: string }> {
  const r = await getReceivable(tx, ctx, args.einvoiceId);
  if (r.status !== 'open' && r.status !== 'partially_paid') {
    throw new Error(`Receivable ${r.invoiceNumber} is not settleable (status=${r.status})`);
  }
  const amount = BigInt(args.amountCents);
  const outstanding = BigInt(r.outstandingCents);
  if (amount <= 0n) throw new Error(`Settlement amount must be positive (got ${args.amountCents})`);
  if (amount > outstanding) throw new Error(`Settlement ${args.amountCents} exceeds outstanding ${r.outstandingCents}`);

  // Dedup: a given bank transaction may settle a receivable at most once.
  if (args.bankTransactionId) {
    const dup = await tx.query(
      `SELECT 1 FROM invoice_payments WHERE client_company_id = $1 AND bank_transaction_id = $2 LIMIT 1`,
      [ctx.clientCompanyId, args.bankTransactionId],
    );
    if (dup.rowCount) throw new Error(`Receivable already settled by bank transaction ${args.bankTransactionId}`);
  }

  const dec = fromCents(amount);
  const { entryId } = await postEntry(tx, ctx, {
    date: args.paidDate, memo: `Invoice payment ${r.invoiceNumber}`, currency: r.currency,
    lines: [
      { accountCode: args.bankAccount, debit: dec, credit: '0', description: 'Bank receipt' },
      { accountCode: args.receivableAccount, debit: '0', credit: dec, description: 'Settle receivable' },
    ],
  });

  const pay = await tx.query(
    `INSERT INTO invoice_payments(client_company_id, einvoice_id, amount_cents, paid_date, method, bank_transaction_id, journal_entry_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [ctx.clientCompanyId, args.einvoiceId, amount.toString(), args.paidDate, args.method, args.bankTransactionId ?? null, entryId],
  );
  const invoicePaymentId = pay.rows[0].id as string;

  const newPaid = BigInt(r.amountPaidCents) + amount;
  const status = newPaid >= BigInt(r.grandTotalCents) ? 'paid' : 'partially_paid';
  await tx.query(
    `UPDATE einvoices SET amount_paid_cents = $1, status = $2 WHERE id = $3 AND client_company_id = $4`,
    [newPaid.toString(), status, args.einvoiceId, ctx.clientCompanyId],
  );

  await appendAudit(tx, ctx, {
    action: 'settle', entityType: 'receivable', entityId: args.einvoiceId,
    before: { amountPaidCents: r.amountPaidCents, status: r.status },
    after: { amountPaidCents: newPaid.toString(), status, method: args.method, entryId },
  });
  return { entryId, invoicePaymentId };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/receivables/settlement.test.ts`
Expected: PASS (all five).

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit` (expect clean).

```bash
git add src/receivables/settlement.ts tests/receivables/settlement.test.ts
git commit -m "feat(receivables): settleReceivable (manual + bank_match, dedup + guards)"
```

---

### Task 4: arAging + ar-aging API route

**Files:**
- Create: `src/receivables/aging.ts`
- Create: `web/app/api/reports/ar-aging/route.ts`
- Test: `tests/receivables/aging.test.ts`

**Interfaces:**
- Consumes: `fromCents`; the `einvoices` open-item columns.
- Produces: `ArAging { asOf; current; d1_30; d31_60; d61_90; d90plus; total }`; `arAging(tx, ctx, { asOf }): Promise<ArAging>`. GET `/api/reports/ar-aging?clientCompanyId&asOf` → `{ report: ArAging }`.

- [ ] **Step 1: Write the failing test**

Create `tests/receivables/aging.test.ts` (issue receivables with varying due dates relative to `asOf`, mirror `tests/payables/aging.test.ts` bucket boundaries):

```ts
test('buckets outstanding receivables by asOf - due_date', async () => {
  const { cid } = await setup();
  await issue(cid, { due: '2026-04-10', grand: '100.00' }); // asOf 2026-04-10 → 0 days → current
  await issue(cid, { due: '2026-03-25', grand: '50.00' });  // 16 days → d1_30
  await issue(cid, { due: '2026-02-01', grand: '30.00' });  // 68 days → d61_90
  const r = await withTenant(cid, (tx) => arAging(tx, cid, { asOf: '2026-04-10' }));
  expect(r.current).toBe('100.00');
  expect(r.d1_30).toBe('50.00');
  expect(r.d61_90).toBe('30.00');
  expect(r.total).toBe('180.00');
});

test('excludes paid and void receivables', async () => {
  const { cid, paidId, voidId } = await setupWithPaidAndVoid();
  const r = await withTenant(cid, (tx) => arAging(tx, cid, { asOf: '2026-04-10' }));
  expect(r.total).toBe('0.00');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/receivables/aging.test.ts`
Expected: FAIL — `arAging` not defined.

- [ ] **Step 3: Implement `arAging`**

Create `src/receivables/aging.ts`:

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { fromCents } from '../db/money.js';

export interface ArAging {
  asOf: string; current: string; d1_30: string; d31_60: string; d61_90: string; d90plus: string; total: string;
}

/** Aged receivables: outstanding on open/partially-paid outbound invoices, bucketed by
 *  (asOf - due_date). Falls back to issue_date when due_date is null. */
export async function arAging(
  tx: PoolClient, ctx: TenantContext, opts: { asOf: string },
): Promise<ArAging> {
  const res = await tx.query(
    `SELECT ($2::date - COALESCE(due_date, issue_date)) AS days,
            (grand_total_cents - amount_paid_cents) AS outstanding
     FROM einvoices
     WHERE client_company_id = $1 AND direction = 'outbound'
       AND status IN ('open','partially_paid')
       AND (grand_total_cents - amount_paid_cents) > 0`,
    [ctx.clientCompanyId, opts.asOf],
  );

  let current = 0n, d1_30 = 0n, d31_60 = 0n, d61_90 = 0n, d90plus = 0n;
  for (const r of res.rows) {
    const days = Number(r.days);
    const amt = BigInt(r.outstanding);
    if (days <= 0) current += amt;
    else if (days <= 30) d1_30 += amt;
    else if (days <= 60) d31_60 += amt;
    else if (days <= 90) d61_90 += amt;
    else d90plus += amt;
  }
  const total = current + d1_30 + d31_60 + d61_90 + d90plus;
  return {
    asOf: opts.asOf,
    current: fromCents(current), d1_30: fromCents(d1_30), d31_60: fromCents(d31_60),
    d61_90: fromCents(d61_90), d90plus: fromCents(d90plus), total: fromCents(total),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/receivables/aging.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the API route (mirror `ap-aging`)**

Create `web/app/api/reports/ar-aging/route.ts`:

```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { arAging } from '@domain/receivables/aging.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { errorToStatus } from '@/app/lib/authz';
import { isValidIsoDate } from '@/app/lib/date';

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const asOf = req.nextUrl.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10);
  if (!isValidIsoDate(asOf)) return NextResponse.json({ error: 'asOf must be a valid YYYY-MM-DD date' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const report = await withTenant(ctx, (tx) => arAging(tx, ctx, { asOf }));
    return NextResponse.json({ report }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
```

- [ ] **Step 6: Typecheck (root + web) and commit**

Run: `npx tsc --noEmit` (root, clean). Then in `web/`: `npx tsc --noEmit` (clean).

```bash
git add src/receivables/aging.ts web/app/api/reports/ar-aging/route.ts tests/receivables/aging.test.ts
git commit -m "feat(receivables): arAging domain + /api/reports/ar-aging route"
```

---

### Task 5: Invoice-linked AR bank matcher; retire GL-level proposeMatches

**Files:**
- Modify: `src/banking/match.ts`
- Modify: `src/dev/seed.ts`
- Test: `tests/banking/match.test.ts` (replace the `proposeMatches` tests)

**Interfaces:**
- Consumes: `createProposal`, `Rationale`; `einvoices` open-item columns.
- Produces: `ArMatchConfig { receivableAccount: string; bankAccount: string }`; `proposeArMatches(tx, ctx, config): Promise<{ proposalIds: string[] }>` — for each unmatched **credit** bank txn, find one open/partially-paid outbound receivable whose outstanding equals the amount and is not already claimed (Set + NOT EXISTS on `proposals.payload->>'einvoiceId'`), create a `bank_match` proposal with `payload = { kind: 'receivable_direct', bankTransactionId, einvoiceId, amountCents, bankAccount, receivableAccount }`, mark the txn `matched`. Removes `proposeMatches` and `MatchConfig`.

- [ ] **Step 1: Rewrite the matcher test for `proposeArMatches`**

Replace the two `proposeMatches` tests in `tests/banking/match.test.ts` (keep the file's setup helpers) with:

```ts
import { proposeArMatches } from '../../src/banking/match.js';

test('proposes an invoice-linked bank_match for a credit equal to an open receivable', async () => {
  const { cid, einvoiceId } = await issueOpenReceivable(); // grand 12100
  await importCreditTxn(cid, '12100');                      // one unmatched credit of 121.00
  const ids = await withTenant(cid, (tx) => proposeArMatches(tx, cid, { receivableAccount: '2310', bankAccount: '2620' }).then((r) => r.proposalIds));
  expect(ids).toHaveLength(1);
  const prop = await withTenant(cid, (tx) => getProposal(tx, cid, ids[0]!));
  expect(prop.type).toBe('bank_match');
  expect((prop.payload as any).kind).toBe('receivable_direct');
  expect((prop.payload as any).einvoiceId).toBe(einvoiceId);
});

test('does not propose when no open receivable matches the amount', async () => {
  const { cid } = await issueOpenReceivable();  // 12100
  await importCreditTxn(cid, '9999');
  const ids = await withTenant(cid, (tx) => proposeArMatches(tx, cid, { receivableAccount: '2310', bankAccount: '2620' }).then((r) => r.proposalIds));
  expect(ids).toHaveLength(0);
});

test('does not double-claim one receivable for two equal credits', async () => {
  await issueOpenReceivable();       // single 12100 receivable
  await importCreditTxn(cid, '12100');
  await importCreditTxn(cid, '12100');
  const ids = await withTenant(cid, (tx) => proposeArMatches(tx, cid, { receivableAccount: '2310', bankAccount: '2620' }).then((r) => r.proposalIds));
  expect(ids).toHaveLength(1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/banking/match.test.ts`
Expected: FAIL — `proposeArMatches` not defined.

- [ ] **Step 3: Replace `proposeMatches` with `proposeArMatches` in `src/banking/match.ts`**

Delete the `MatchConfig` interface and the `proposeMatches` function. Add (keeping `proposeApMatches` untouched below it):

```ts
export interface ArMatchConfig { receivableAccount: string; bankAccount: string; }

/**
 * Propose settlements for unmatched CREDIT transactions against open receivables.
 * Match an open/partially-paid outbound invoice whose OUTSTANDING equals the credit amount
 * → settle directly on approval (postApprovedBankMatch 'receivable_direct' branch).
 *
 * Dedup mirrors proposeApMatches: a bank credit may claim a given receivable at most once,
 * guarded within one import (claimed Set) and across imports (NOT EXISTS against unresolved
 * bank_match proposals referencing the same einvoiceId). Amount-only matching is an accepted
 * MVP limitation (no reference/fuzzy matching yet).
 */
export async function proposeArMatches(
  tx: PoolClient, ctx: TenantContext, config: ArMatchConfig,
): Promise<{ proposalIds: string[] }> {
  const txns = await tx.query(
    `SELECT id, amount_cents::text AS "amountCents", reference, counterparty
     FROM bank_transactions
     WHERE client_company_id = $1 AND status = 'unmatched' AND side = 'credit'
     ORDER BY booking_date, id`,
    [ctx.clientCompanyId],
  );

  const proposalIds: string[] = [];
  const claimedIds = new Set<string>();
  for (const t of txns.rows) {
    const amountEur = (Number(t.amountCents) / 100).toFixed(2);
    const inv = await tx.query(
      `SELECT e.id, e.invoice_number AS "invoiceNumber" FROM einvoices e
       WHERE e.client_company_id = $1 AND e.direction = 'outbound'
         AND e.status IN ('open','partially_paid')
         AND (e.grand_total_cents - e.amount_paid_cents) = $2::bigint
         AND ($3::uuid[] IS NULL OR e.id <> ALL($3::uuid[]))
         AND NOT EXISTS (
           SELECT 1 FROM proposals p
           WHERE p.client_company_id = $1 AND p.type = 'bank_match'
             AND p.status IN ('pending_approval','approved')
             AND p.payload->>'einvoiceId' = e.id::text
         )
       ORDER BY e.due_date NULLS LAST LIMIT 1`,
      [ctx.clientCompanyId, t.amountCents, claimedIds.size ? [...claimedIds] : null],
    );
    if (!inv.rowCount) continue;
    const einvoiceId = inv.rows[0].id as string;
    const { id } = await createProposal(tx, ctx, {
      type: 'bank_match',
      payload: { kind: 'receivable_direct', bankTransactionId: t.id, einvoiceId, amountCents: t.amountCents, bankAccount: config.bankAccount, receivableAccount: config.receivableAccount },
      rationale: { ruleRef: 'ar-direct', computation: `Bank credit of ${amountEur} EUR settles invoice ${inv.rows[0].invoiceNumber}${t.counterparty ? ` from ${t.counterparty}` : ''}.`, sourceRefs: { bankTransactionId: t.id, einvoiceId } } as Rationale,
      status: 'pending_approval',
    });
    await tx.query(`UPDATE bank_transactions SET status = 'matched' WHERE id = $1 AND client_company_id = $2`, [t.id, ctx.clientCompanyId]);
    claimedIds.add(einvoiceId);
    proposalIds.push(id);
  }
  return { proposalIds };
}
```

- [ ] **Step 4: Update the seed to use the new matcher**

In `src/dev/seed.ts`, change the import at line 27 and the call at line 114:

```ts
import { proposeArMatches } from '../banking/match.js';
// ...
await proposeArMatches(tx, ctx, { receivableAccount: '2310', bankAccount: '2620' });
```

(If the seed relied on a receivable existing as an einvoice, ensure the seed issues an outbound invoice before matching; if the seeded receivable was only a raw journal entry, drop that matching call — note it in the commit body.)

- [ ] **Step 5: Run to verify tests pass**

Run: `npx vitest run tests/banking/match.test.ts`
Expected: PASS (all three).

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit` (expect clean — verify no other file imports `proposeMatches`/`MatchConfig`; grep first: `grep -rn "proposeMatches\|MatchConfig" src tests web`).

```bash
git add src/banking/match.ts src/dev/seed.ts tests/banking/match.test.ts
git commit -m "feat(receivables): invoice-linked AR bank matcher; retire GL-level proposeMatches"
```

---

### Task 6: receivable_direct confirm branch + wire matcher into bank import

**Files:**
- Modify: `src/banking/confirm-match.ts`
- Modify: `web/app/api/bank/import/route.ts`
- Test: `tests/banking/confirm-match.test.ts`

**Interfaces:**
- Consumes: `settleReceivable` (Task 3), `proposeArMatches` (Task 5).
- Produces: `postApprovedBankMatch` handles `kind === 'receivable_direct'` by calling `settleReceivable` and reconciling the txn. Bank import route runs `proposeArMatches` alongside `proposeApMatches` and returns `arProposals` count.

- [ ] **Step 1: Write the failing test**

Add to `tests/banking/confirm-match.test.ts` (issue an open receivable, import a matching credit, propose via `proposeArMatches`, approve, confirm):

```ts
test('confirming a receivable_direct match settles the invoice and reconciles the txn', async () => {
  const { cid, einvoiceId } = await issueOpenReceivable(); // 12100
  await importCreditTxn(cid, '12100');
  const [proposalId] = await withTenant(cid, (tx) => proposeArMatches(tx, cid, { receivableAccount: '2310', bankAccount: '2620' }).then((r) => r.proposalIds));
  await withTenant(cid, (tx) => approveProposal(tx, cid, proposalId!)); // existing approval helper
  const { entryId } = await withTenant(cid, (tx) => postApprovedBankMatch(tx, cid, proposalId!));
  expect(entryId).toBeTruthy();
  const r = await withTenant(cid, (tx) => getReceivable(tx, cid, einvoiceId));
  expect(r.status).toBe('paid');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/banking/confirm-match.test.ts`
Expected: FAIL — no `receivable_direct` branch; the generic branch posts a bare GL settlement and leaves the receivable `open`.

- [ ] **Step 3: Add the `receivable_direct` branch**

In `src/banking/confirm-match.ts`, immediately after the `payable_direct` branch (before the generic fallback at the `const payload = prop.payload as {...}` line), insert:

```ts
  if (raw.kind === 'receivable_direct') {
    const p = prop.payload as { einvoiceId: string; receivableAccount: string; bankAccount: string };
    const { settleReceivable } = await import('../receivables/settlement.js');
    const { entryId } = await settleReceivable(tx, ctx, {
      einvoiceId: p.einvoiceId, amountCents: raw.amountCents, paidDate: bookingDate, method: 'bank_match',
      bankTransactionId: raw.bankTransactionId, bankAccount: p.bankAccount, receivableAccount: p.receivableAccount,
    });
    await tx.query(`UPDATE proposals SET status='posted', resolved_entry_id=$1, resolved_by=$2, resolved_at=now() WHERE id=$3 AND client_company_id=$4`, [entryId, ctx.actorId, proposalId, ctx.clientCompanyId]);
    await tx.query(`UPDATE bank_transactions SET status='reconciled', matched_entry_id=$1 WHERE id=$2 AND client_company_id=$3`, [entryId, raw.bankTransactionId, ctx.clientCompanyId]);
    await appendAudit(tx, ctx, { action: 'posted', entityType: 'bank_match', entityId: proposalId, before: { status: 'approved' }, after: { status: 'posted', entryId, kind: 'receivable_direct' } });
    return { entryId };
  }
```

(The generic kind-less branch below stays as-is — a harmless legacy GL settlement path retained so `tests/banking/confirm-match.test.ts`'s existing test keeps passing.)

- [ ] **Step 4: Wire `proposeArMatches` into the bank import route**

In `web/app/api/bank/import/route.ts`, add the import and the call. Update the import line and the `withTenant` block:

```ts
import { proposeApMatches, proposeArMatches } from '@domain/banking/match.js';
// ...
const AR_MATCH = { receivableAccount: '2310', bankAccount: '2620' };
// ...
    const result = await withTenant(ctx, async (tx) => {
      const imported = await importStatement(tx, ctx, stmt);
      const ap = await proposeApMatches(tx, ctx, AP_MATCH);
      const ar = await proposeArMatches(tx, ctx, AR_MATCH);
      return { ...imported, apProposals: ap.proposalIds.length, arProposals: ar.proposalIds.length };
    });
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/banking/confirm-match.test.ts`
Expected: PASS (new test + existing generic-branch test).

- [ ] **Step 6: Typecheck (root + web) and commit**

Run: `npx tsc --noEmit` (root, clean). In `web/`: `npx tsc --noEmit` (clean).

```bash
git add src/banking/confirm-match.ts web/app/api/bank/import/route.ts tests/banking/confirm-match.test.ts
git commit -m "feat(receivables): receivable_direct confirm branch + AR matching on bank import"
```

---

### Task 7: Compose path — persist customer + due date; manual settle route

**Files:**
- Modify: `web/app/api/einvoices/route.ts`
- Create: `web/app/api/receivables/[id]/route.ts`
- Modify: `web/app/(cabinet)/invoices/new/page.tsx` (send `customerPartyId` + due date)
- Test: `tests/api/receivables-route.test.ts` (via the handler pattern if a testable handler is extracted) OR an einvoices-persistence test in `tests/einvoice/`

**Interfaces:**
- Consumes: `sendInvoice` (Task 2 args), `settleReceivable`/`voidReceivable` (Tasks 2–3).
- Produces: POST `/api/einvoices` accepts `customerPartyId` + optional `dueDate` (computed from the customer's `payment_terms_days` when absent) and threads them to `sendInvoice`. POST `/api/receivables/[id]` performs `{ action: 'settle', amountCents, paidDate }` or `{ action: 'void' }`, role-gated `einvoice.issue`.

- [ ] **Step 1: Extend the einvoices POST to capture customer + due date**

In `web/app/api/einvoices/route.ts`, widen the body type and the `sendInvoice` call. Compute `dueDate` from the customer's terms when the client didn't supply one:

```ts
  const body = (await req.json().catch(() => ({}))) as {
    clientCompanyId?: string; invoice?: EInvoice; recipientPeppolId?: string;
    customerPartyId?: string; dueDate?: string;
  };
  // ...existing missing-field guards...
  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'einvoice.issue');
    const result = await withTenant(ctx, async (tx) => {
      let dueDate = body.dueDate ?? body.invoice!.dueDate ?? null;
      if (!dueDate && body.customerPartyId) {
        const { getParty } = await import('@domain/parties/parties.js');
        const party = await getParty(tx, ctx, body.customerPartyId);
        if (party.paymentTermsDays != null) {
          const d = new Date(`${body.invoice!.issueDate}T00:00:00Z`);
          d.setUTCDate(d.getUTCDate() + party.paymentTermsDays);
          dueDate = d.toISOString().slice(0, 10);
        }
      }
      return sendInvoice(tx, ctx, {
        invoice: body.invoice!, recipientPeppolId: body.recipientPeppolId!, ap: accessPoint,
        receivableAccount: RECEIVABLE_ACCOUNT, salesAccount: SALES_ACCOUNT, vatAccount: VAT_ACCOUNT,
        customerPartyId: body.customerPartyId ?? null, dueDate,
      });
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) { /* unchanged errorToStatus mapping */ }
```

- [ ] **Step 2: Add the manual settle / void route**

Create `web/app/api/receivables/[id]/route.ts` (params are async in this Next.js version — mirror an existing `[id]` route such as `web/app/api/bills/[id]/route.ts` for the exact params signature):

```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { settleReceivable } from '@domain/receivables/settlement.js';
import { voidReceivable } from '@domain/receivables/receivables.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

const RECEIVABLE_ACCOUNT = process.env.EINVOICE_RECEIVABLE_ACCOUNT ?? '2310';
const BANK_ACCOUNT = process.env.BANK_ACCOUNT ?? '2620';

export async function POST(req: NextRequest, ctxArg: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const { id } = await ctxArg.params;
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string; action?: 'settle' | 'void'; amountCents?: string; paidDate?: string };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'einvoice.issue');
    const result = await withTenant(ctx, async (tx) => {
      if (body.action === 'void') { await voidReceivable(tx, ctx, id); return { voided: true }; }
      if (body.action === 'settle') {
        if (!body.amountCents || !body.paidDate) throw new Error('settle requires amountCents and paidDate');
        return settleReceivable(tx, ctx, { einvoiceId: id, amountCents: body.amountCents, paidDate: body.paidDate, method: 'manual', bankAccount: BANK_ACCOUNT, receivableAccount: RECEIVABLE_ACCOUNT });
      }
      throw new Error('unknown action');
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
```

- [ ] **Step 3: Send `customerPartyId` + due date from the composer**

In `web/app/(cabinet)/invoices/new/page.tsx`, include the already-selected customer party id as `customerPartyId` in the POST body, and add an optional due-date `<input type="date">` sent as `dueDate` (label `t('invoices.dueDate')`). Add `invoices.dueDate` to all three i18n catalogs:

```ts
// EN / LV / RU
'invoices.dueDate': 'Due date',
'invoices.dueDate': 'Apmaksas termiņš',
'invoices.dueDate': 'Срок оплаты',
```

- [ ] **Step 4: Add a persistence test**

Add to `tests/einvoice/` (or a new `tests/api/einvoices-persistence.test.ts`) a test that calls `sendInvoice` with `customerPartyId` + `dueDate` and asserts `getReceivable` returns them (this locks the route's contract at the domain boundary; the route itself is thin plumbing):

```ts
test('sendInvoice persists customerPartyId and dueDate on the receivable', async () => {
  const { cid, customerId, einvoiceId } = await issueWith({ customerPartyId, dueDate: '2026-03-24' });
  const r = await withTenant(cid, (tx) => getReceivable(tx, cid, einvoiceId));
  expect(r.customerPartyId).toBe(customerId);
  expect(r.dueDate).toBe('2026-03-24');
});
```

(If this assertion is already covered by Task 2's receivables test, skip creating a duplicate and note it in the commit.)

- [ ] **Step 5: Run tests + typecheck (root + web) and commit**

Run: `npx vitest run tests/einvoice tests/receivables` (expect PASS). `npx tsc --noEmit` (root, clean); in `web/`: `npx tsc --noEmit` (clean).

```bash
git add web/app/api/einvoices/route.ts web/app/api/receivables web/app/\(cabinet\)/invoices/new/page.tsx web/app/lib/i18n.ts tests
git commit -m "feat(receivables): compose-path customer/due-date persistence + manual settle route"
```

---

### Task 8: Aged-receivables tab on /reports + full verification

**Files:**
- Modify: `web/app/(cabinet)/reports/page.tsx`
- Modify: `web/app/lib/i18n.ts`

**Interfaces:**
- Consumes: GET `/api/reports/ar-aging` (Task 4).
- Produces: a third-and-fourth reports tab state; an `araging` tab rendering AR buckets.

- [ ] **Step 1: Add i18n keys (all three catalogs)**

In `web/app/lib/i18n.ts`, alongside the existing `reports.aging.*` keys, add for EN, LV, RU respectively:

```ts
// EN
'reports.tab.araging': 'Aged receivables',
'reports.aging.totalReceivable': 'Total receivable',
// LV
'reports.tab.araging': 'Debitoru parādi pēc termiņa',
'reports.aging.totalReceivable': 'Kopā debitori',
// RU
'reports.tab.araging': 'Дебиторка по срокам',
'reports.aging.totalReceivable': 'Итого к получению',
```

- [ ] **Step 2: Extend the reports page tab type + fetch**

In `web/app/(cabinet)/reports/page.tsx`:
- Add `ArAging` interface (identical shape to `ApAging`) or reuse the existing `ApAging` interface renamed to a shared `Aging`.
- Change `type Tab = 'pl' | 'bs' | 'apaging'` → `type Tab = 'pl' | 'bs' | 'apaging' | 'araging'`.
- In the fetch `useEffect`, add the URL branch:

```ts
else if (tab === 'apaging') url = `/api/reports/ap-aging?clientCompanyId=${encodeURIComponent(clientCompanyId)}&asOf=${asOf}`;
else url = `/api/reports/ar-aging?clientCompanyId=${encodeURIComponent(clientCompanyId)}&asOf=${asOf}`;
```
- Update the result-assignment branch so `araging` sets the same aging state used by `apaging` (both share `asOf` + the buckets shape), clearing `pl`/`bs`.

- [ ] **Step 3: Add the tab button + panel**

Add a tab button after the `apaging` one:

```tsx
<button role="tab" aria-selected={tab === 'araging'} className={tab === 'araging' ? styles.tabActive : styles.tab} onClick={() => setTab('araging')}>{t('reports.tab.araging')}</button>
```

Render the AR panel; reuse the generic bucket labels and the AR-specific total. Gate it on `tab === 'araging'`:

```tsx
{!error && !loading && tab === 'araging' && aging && (
  <>
    <table className={styles.table}><tbody>
      <tr><td className={styles.name}>{t('reports.aging.current')}</td><td className={styles.amount}>{fmtMoney(aging.current)}</td></tr>
      <tr><td className={styles.name}>{t('reports.aging.d1_30')}</td><td className={styles.amount}>{fmtMoney(aging.d1_30)}</td></tr>
      <tr><td className={styles.name}>{t('reports.aging.d31_60')}</td><td className={styles.amount}>{fmtMoney(aging.d31_60)}</td></tr>
      <tr><td className={styles.name}>{t('reports.aging.d61_90')}</td><td className={styles.amount}>{fmtMoney(aging.d61_90)}</td></tr>
      <tr><td className={styles.name}>{t('reports.aging.d90plus')}</td><td className={styles.amount}>{fmtMoney(aging.d90plus)}</td></tr>
    </tbody></table>
    <div className={styles.grandTotal}><span>{t('reports.aging.totalReceivable')}</span><span className={styles.amount}>{fmtMoney(aging.total)}</span></div>
  </>
)}
```

Make sure the `asOf` date picker also shows for `tab === 'araging'` (extend the condition that currently shows it for `bs`/`apaging`).

- [ ] **Step 4: Full verification gate**

Run each and confirm the stated result before committing:

```bash
npm test                       # root: full suite — all green (was 333 + new receivables/api tests)
npx tsc --noEmit               # root: clean
cd web && npx tsc --noEmit     # web: clean
cd web && npm run build        # web: build succeeds
```

Expected: full suite green; both typechecks clean; web build clean.

- [ ] **Step 5: Commit**

```bash
git add web/app/\(cabinet\)/reports/page.tsx web/app/lib/i18n.ts
git commit -m "feat(receivables): aged-receivables tab on /reports (M4 slice A)"
```

---

## Self-Review

**Spec coverage:**
- Data model (extend einvoices + invoice_payments + parties.payment_terms_days) → Task 1. ✓
- Issue-time customer + due-date persistence → Task 2 (+ route in Task 7). ✓
- `settleReceivable` (manual + bank_match, guards, dedup) → Task 3. ✓
- `arAging` + aged-receivables API + tab → Tasks 4, 8. ✓
- Invoice-linked AR matcher wired into import; retire `proposeMatches` → Tasks 5, 6. ✓
- `receivable_direct` confirm branch → Task 6. ✓
- Customer default payment terms → Task 1 (domain/UI), Task 7 (compose-path use). ✓
- Deferred (outbox status columns, statement, dunning/recurring/quotes) → not in any task, by design. ✓

**Placeholder scan:** No TBD/TODO; each code step contains the full code. The two "skip if duplicate" notes (Task 5 seed, Task 7 persistence test) are explicit either/or instructions, not placeholders.

**Type consistency:** `ReceivableRow`/`ReceivableStatus` defined in Task 2 and consumed unchanged in Tasks 3/7; `settleReceivable` signature identical across Tasks 3, 6, 7; `proposeArMatches`/`ArMatchConfig` identical across Tasks 5, 6; payload `kind: 'receivable_direct'` with `einvoiceId` consistent across Tasks 5, 6; `arAging`/`ArAging` identical across Tasks 4, 8. Payment-terms field is `paymentTermsDays` (camel) / `payment_terms_days` (snake) consistently.
