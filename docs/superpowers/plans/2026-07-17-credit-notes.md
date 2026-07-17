# Credit Notes (M7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add credit notes to both ledger sides — outbound customer credit notes (AR: reverse receivable + output VAT, dispatch as UBL CreditNote) and vendor credit notes (AP: reduce payables + input VAT, via manual entry and inbound Peppol), on the existing ledger, approval queue, VAT engine, and Peppol transport.

**Architecture:** Hybrid (spec Approach C). AR credit notes are recorded as `einvoices` rows discriminated by a new `doc_type` column and issued by `sendCreditNote` (mirror of `sendInvoice`). AP vendor credit notes get their own `vendor_credit_notes` table + `src/payables/credit-notes.ts` (mirror of `bills.ts` but a reversal posting, no settlement), so every M2 hardening against negative `bills` stays intact. VAT netting falls out of the existing `computeVat`; AP aging is extended to net applied credit notes.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), PostgreSQL with RLS, `pg` PoolClient, zod validation, vitest, Next.js (web — read `node_modules/next/dist/docs/` before touching web routes per `web/AGENTS.md`).

## Global Constraints

- **Money is integer cents (`bigint`)** via `toCents`/`fromCents`/`sumCents` (`src/db/money.ts`). Never use floats for money in domain code.
- **All amounts are stored non-negative (magnitudes).** Reversal direction is expressed by the posting (which account is debited/credited), never by a negative amount — this is what keeps credit notes clear of the M2 negative-`bills` hazard.
- **Every table is tenant-scoped**: `client_company_id` column + RLS `ENABLE`/`FORCE` + `tenant_isolation` policy + `GRANT SELECT, INSERT, UPDATE ... TO bookkeeping_app`, copied verbatim from the `bills`/`bill_lines` pattern in `migrations/030_bills.sql`.
- **Domain imports use `.js` specifiers** (e.g. `import { toCents } from '../db/money.js'`), even for `.ts` files. Web routes import domain via `@domain/*`.
- **Chart-of-accounts codes** come from env with LR defaults: receivable `2310`, sales `6110`, output VAT `5721`, input VAT `5722`, payables `5310`.
- **Role gating** reuses existing operations: AR credit notes = `einvoice.issue`; AP vendor credit notes = `bills.write`. No new operations.
- **Run the full suite** with `npm test` from the repo root; typecheck with `npm run -s typecheck` (root) and `cd web && npm run -s build` for the web build.

---

### Task 1: Migration — `doc_type` on einvoices + vendor credit note tables

**Files:**
- Create: `migrations/032_credit_notes.sql`
- Test: `tests/payables/credit-notes.test.ts` (schema assertions; grows in later tasks)

**Interfaces:**
- Consumes: existing `einvoices`, `parties`, `proposals`, `journal_entries`, `documents`, `client_companies` tables.
- Produces: `einvoices.doc_type` (`'invoice'|'credit_note'`), `einvoices.corrected_invoice_number` (nullable text); tables `vendor_credit_notes` and `vendor_credit_note_lines`.

- [ ] **Step 1: Write the migration**

Create `migrations/032_credit_notes.sql`:

```sql
-- Credit notes (M7): AR credit notes ride on einvoices (doc_type discriminator);
-- AP vendor credit notes get their own tables (a credit note is not a payable you pay).

-- AR side: discriminate einvoices, carry the optional EN 16931 preceding-invoice reference.
ALTER TABLE einvoices ADD COLUMN doc_type text NOT NULL DEFAULT 'invoice'
  CHECK (doc_type IN ('invoice','credit_note'));
ALTER TABLE einvoices ADD COLUMN corrected_invoice_number text;

-- AP side: vendor credit notes. Shaped like bills MINUS settlement (no amount_paid, no pay-run).
CREATE TABLE vendor_credit_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  vendor_party_id uuid NOT NULL REFERENCES parties(id),
  credit_note_number text NOT NULL,
  issue_date date NOT NULL,
  currency char(3) NOT NULL,
  net_cents bigint NOT NULL,
  vat_cents bigint NOT NULL,
  grand_total_cents bigint NOT NULL,
  corrected_bill_number text,
  status text NOT NULL DEFAULT 'awaiting_approval'
    CHECK (status IN ('awaiting_approval','applied','void')),
  source text NOT NULL CHECK (source IN ('manual','peppol')),
  posting_proposal_id uuid REFERENCES proposals(id),
  journal_entry_id uuid REFERENCES journal_entries(id),
  document_id uuid REFERENCES documents(id),
  einvoice_id uuid REFERENCES einvoices(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendor_credit_notes_client_status_idx
  ON vendor_credit_notes(client_company_id, status, issue_date);

ALTER TABLE vendor_credit_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_credit_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY vendor_credit_notes_tenant_isolation ON vendor_credit_notes
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON vendor_credit_notes TO bookkeeping_app;

CREATE TABLE vendor_credit_note_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  credit_note_id uuid NOT NULL REFERENCES vendor_credit_notes(id),
  line_no int NOT NULL,
  description text NOT NULL,
  expense_account text NOT NULL,
  net_cents bigint NOT NULL,
  vat_rate numeric NOT NULL,
  vat_cents bigint NOT NULL
);
CREATE INDEX vendor_credit_note_lines_cn_idx ON vendor_credit_note_lines(credit_note_id);

ALTER TABLE vendor_credit_note_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_credit_note_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY vendor_credit_note_lines_tenant_isolation ON vendor_credit_note_lines
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON vendor_credit_note_lines TO bookkeeping_app;
```

- [ ] **Step 2: Write the failing schema test**

Create `tests/payables/credit-notes.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('migration adds doc_type to einvoices and vendor_credit_notes tables', async () => {
  const t = await makeFirmAndClient();
  const cols = await withTenant(ctx(t), async (tx) =>
    (await tx.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'einvoices' AND column_name IN ('doc_type','corrected_invoice_number')`,
    )).rows.map((r) => r.column_name).sort(),
  );
  expect(cols).toEqual(['corrected_invoice_number', 'doc_type']);

  const tbl = await withTenant(ctx(t), async (tx) =>
    (await tx.query(
      `SELECT to_regclass('public.vendor_credit_notes') AS a, to_regclass('public.vendor_credit_note_lines') AS b`,
    )).rows[0],
  );
  expect(tbl.a).toBe('vendor_credit_notes');
  expect(tbl.b).toBe('vendor_credit_note_lines');
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- tests/payables/credit-notes.test.ts`
Expected: FAIL — either `resetDb` errors applying an as-yet-unknown migration, or the columns/tables don't exist. (If `resetDb` already applies all `migrations/*.sql`, the test fails on the assertions until Step 1's file is picked up.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/payables/credit-notes.test.ts`
Expected: PASS (both assertions).

- [ ] **Step 5: Commit**

```bash
git add migrations/032_credit_notes.sql tests/payables/credit-notes.test.ts
git commit -m "feat(credit-notes): schema — einvoices doc_type + vendor_credit_notes tables (M7)"
```

---

### Task 2: UBL CreditNote build/parse + EN 16931 validation

**Files:**
- Modify: `src/einvoice/ubl.ts` (extract shared helpers; add credit-note build/parse + a `CreditNote` type)
- Modify: `src/einvoice/validate.ts` (doc-type-aware validation)
- Test: `tests/einvoice/credit-note-ubl.test.ts`

**Interfaces:**
- Consumes: `escapeXml` (`../xml/escape.js`), `toCents`/`sumCents` (`../db/money.js`), existing `InvoiceParty`, `InvoiceLineIn`, `EInvoice`.
- Produces:
  - `interface ECreditNote extends Omit<EInvoice, never>` — same fields as `EInvoice` plus `correctedInvoiceNumber?: string`. (Field-identical to `EInvoice` otherwise: `invoiceNumber` is the credit-note number, `issueDate`, `currency`, `supplier`, `customer`, `lines`, `netTotal`, `vatTotal`, `grandTotal`, optional `dueDate`/`note`/`paymentTerms`.)
  - `buildUblCreditNote(cn: ECreditNote): string`
  - `parseUblCreditNote(xml: string): ECreditNote`
  - `detectUblRoot(xml: string): 'Invoice' | 'CreditNote' | 'unknown'`
  - `validateEn16931(doc: EInvoice | ECreditNote): { valid: boolean; issues: string[] }` — unchanged signature; the same BR subset applies to both shapes.

- [ ] **Step 1: Write the failing tests**

Create `tests/einvoice/credit-note-ubl.test.ts`:

```ts
import { expect, test } from 'vitest';
import {
  buildUblCreditNote, parseUblCreditNote, detectUblRoot, buildUblInvoice,
  type ECreditNote,
} from '../../src/einvoice/ubl.js';
import { validateEn16931 } from '../../src/einvoice/validate.js';

const cn: ECreditNote = {
  invoiceNumber: 'CN-2026-001', issueDate: '2026-03-15', currency: 'EUR',
  correctedInvoiceNumber: 'INV-2026-001',
  supplier: { name: 'SIA Pārdevējs', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'SIA Klients', regNo: '40200000000', vatNo: 'LV40200000000' },
  lines: [{ description: 'Atgriešana', net: '100.00', vatRate: 21, vat: '21.00' }],
  netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
};

test('buildUblCreditNote emits a CreditNote root with a BillingReference', () => {
  const xml = buildUblCreditNote(cn);
  expect(xml).toContain('<CreditNote');
  expect(xml).toContain('<cac:CreditNoteLine>');
  expect(xml).toContain('<cbc:ID>CN-2026-001</cbc:ID>');
  expect(xml).toContain('INV-2026-001'); // BillingReference
});

test('round-trips build → parse', () => {
  const parsed = parseUblCreditNote(buildUblCreditNote(cn));
  expect(parsed.invoiceNumber).toBe('CN-2026-001');
  expect(parsed.correctedInvoiceNumber).toBe('INV-2026-001');
  expect(parsed.grandTotal).toBe('121.00');
  expect(parsed.lines).toHaveLength(1);
  expect(parsed.lines[0]!.net).toBe('100.00');
});

test('omits BillingReference when there is no corrected invoice', () => {
  const { correctedInvoiceNumber, ...standalone } = cn;
  const xml = buildUblCreditNote(standalone);
  expect(xml).not.toContain('BillingReference');
  expect(parseUblCreditNote(xml).correctedInvoiceNumber).toBeUndefined();
});

test('detectUblRoot distinguishes documents', () => {
  expect(detectUblRoot(buildUblCreditNote(cn))).toBe('CreditNote');
  expect(detectUblRoot(buildUblInvoice({ ...cn }))).toBe('Invoice');
  expect(detectUblRoot('<Foo/>')).toBe('unknown');
});

test('validateEn16931 accepts a well-formed credit note and flags an unbalanced one', () => {
  expect(validateEn16931(cn).valid).toBe(true);
  expect(validateEn16931({ ...cn, grandTotal: '999.00' }).valid).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/einvoice/credit-note-ubl.test.ts`
Expected: FAIL — `buildUblCreditNote`/`parseUblCreditNote`/`detectUblRoot` not exported.

- [ ] **Step 3: Refactor shared helpers and add credit-note functions in `src/einvoice/ubl.ts`**

Add the `ECreditNote` type near `EInvoice`:

```ts
export interface ECreditNote extends EInvoice { correctedInvoiceNumber?: string; }
```

The existing `party()` helper is already shared. Add credit-note build/parse and root detection. Append to `src/einvoice/ubl.ts` (reuse the module-level `party`, `parser`, `asArray`, `txt`, and the `CUSTOMIZATION` constant; add a CreditNote profile constant):

```ts
const CN_PROFILE = 'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0';

export function buildUblCreditNote(cn: ECreditNote): string {
  const cur = cn.currency;
  const lines = cn.lines.map((l, i) => [
    `  <cac:CreditNoteLine>`,
    `    <cbc:ID>${i + 1}</cbc:ID>`,
    `    <cbc:CreditedQuantity unitCode="C62">1</cbc:CreditedQuantity>`,
    `    <cbc:LineExtensionAmount currencyID="${cur}">${l.net}</cbc:LineExtensionAmount>`,
    `    <cac:Item><cbc:Name>${escapeXml(l.description)}</cbc:Name>`,
    `      <cac:ClassifiedTaxCategory><cbc:Percent>${l.vatRate}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item>`,
    `  </cac:CreditNoteLine>`,
  ].join('\n')).join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">',
    `  <cbc:CustomizationID>${CUSTOMIZATION}</cbc:CustomizationID>`,
    `  <cbc:ProfileID>${CN_PROFILE}</cbc:ProfileID>`,
    `  <cbc:ID>${escapeXml(cn.invoiceNumber)}</cbc:ID>`,
    `  <cbc:IssueDate>${escapeXml(cn.issueDate)}</cbc:IssueDate>`,
    cn.note ? `  <cbc:Note>${escapeXml(cn.note)}</cbc:Note>` : null,
    `  <cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode>`,
    cn.correctedInvoiceNumber
      ? `  <cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${escapeXml(cn.correctedInvoiceNumber)}</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>`
      : null,
    party('AccountingSupplierParty', cn.supplier, cur),
    party('AccountingCustomerParty', cn.customer, cur),
    `  <cac:TaxTotal><cbc:TaxAmount currencyID="${cur}">${cn.vatTotal}</cbc:TaxAmount></cac:TaxTotal>`,
    `  <cac:LegalMonetaryTotal>`,
    `    <cbc:LineExtensionAmount currencyID="${cur}">${cn.netTotal}</cbc:LineExtensionAmount>`,
    `    <cbc:TaxExclusiveAmount currencyID="${cur}">${cn.netTotal}</cbc:TaxExclusiveAmount>`,
    `    <cbc:TaxInclusiveAmount currencyID="${cur}">${cn.grandTotal}</cbc:TaxInclusiveAmount>`,
    `    <cbc:PayableAmount currencyID="${cur}">${cn.grandTotal}</cbc:PayableAmount>`,
    `  </cac:LegalMonetaryTotal>`,
    lines,
    '</CreditNote>',
  ].filter(Boolean).join('\n');
}

export function detectUblRoot(xml: string): 'Invoice' | 'CreditNote' | 'unknown' {
  const parsed = parser.parse(xml);
  if (parsed?.Invoice) return 'Invoice';
  if (parsed?.CreditNote) return 'CreditNote';
  return 'unknown';
}

export function parseUblCreditNote(xml: string): ECreditNote {
  const cn = parser.parse(xml)?.CreditNote;
  if (!cn) throw new Error('Not a UBL CreditNote');
  const sup = cn.AccountingSupplierParty?.Party ?? {};
  const cus = cn.AccountingCustomerParty?.Party ?? {};
  const mon = cn.LegalMonetaryTotal ?? {};
  const readParty = (p: Record<string, unknown>): InvoiceParty => ({
    name: String((p.PartyLegalEntity as { RegistrationName?: string })?.RegistrationName ?? ''),
    regNo: String((p.PartyLegalEntity as { CompanyID?: unknown })?.CompanyID ?? ''),
    vatNo: String((p.PartyTaxScheme as { CompanyID?: unknown })?.CompanyID ?? ''),
  });
  const correctedInvoiceNumber = (cn.BillingReference as { InvoiceDocumentReference?: { ID?: unknown } })
    ?.InvoiceDocumentReference?.ID;
  return {
    invoiceNumber: String(cn.ID ?? ''),
    issueDate: String(cn.IssueDate ?? ''),
    currency: String(cn.DocumentCurrencyCode ?? ''),
    ...(cn.Note !== undefined && { note: String(cn.Note) }),
    ...(correctedInvoiceNumber !== undefined && { correctedInvoiceNumber: String(correctedInvoiceNumber) }),
    supplier: readParty(sup),
    customer: readParty(cus),
    lines: asArray(cn.CreditNoteLine).map((l: Record<string, unknown>) => ({
      description: String((l.Item as { Name?: string })?.Name ?? ''),
      net: txt(l.LineExtensionAmount),
      vatRate: Number((((l.Item as { ClassifiedTaxCategory?: { Percent?: unknown } })?.ClassifiedTaxCategory)?.Percent) ?? 0),
      vat: '0',
    })),
    netTotal: txt(mon.LineExtensionAmount),
    vatTotal: txt(cn.TaxTotal?.TaxAmount),
    grandTotal: txt(mon.PayableAmount),
  };
}
```

Note: `validateEn16931` already takes an `EInvoice`; since `ECreditNote extends EInvoice`, its signature accepts credit notes with no code change. Update only its parameter type annotation in `src/einvoice/validate.ts`:

```ts
import type { EInvoice, ECreditNote } from './ubl.js';
import { toCents, sumCents } from '../db/money.js';

/** A pragmatic subset of EN 16931 business rules relevant to the MVP (invoice or credit note). */
export function validateEn16931(inv: EInvoice | ECreditNote): { valid: boolean; issues: string[] } {
  // ... body unchanged ...
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/einvoice/credit-note-ubl.test.ts`
Expected: PASS (all five tests).

- [ ] **Step 5: Run the existing invoice UBL tests to confirm no regression**

Run: `npm test -- tests/einvoice/ubl.test.ts tests/einvoice/validate.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/einvoice/ubl.ts src/einvoice/validate.ts tests/einvoice/credit-note-ubl.test.ts
git commit -m "feat(credit-notes): UBL CreditNote build/parse + root detection + validation (M7)"
```

---

### Task 3: AR — `sendCreditNote` posts the reversal, records the einvoice, dispatches

**Files:**
- Modify: `src/einvoice/outbound.ts` (add `sendCreditNote`)
- Modify: `src/einvoice/query.ts` (surface `docType` + `correctedInvoiceNumber` in `EinvoiceRow`/`listEinvoices`)
- Test: `tests/einvoice/credit-note-outbound.test.ts`

**Interfaces:**
- Consumes: `buildUblCreditNote`, `validateEn16931`, `ECreditNote` (Task 2); `postEntry` (`../ledger/posting.js`); `AccessPoint`; `toCents` (`../db/money.js`); `appendAudit`.
- Produces: `sendCreditNote(tx, ctx, args): Promise<{ einvoiceId; entryId; messageId }>` where
  `args = { creditNote: ECreditNote; recipientPeppolId: string; ap: AccessPoint; receivableAccount: string; salesAccount: string; vatAccount: string }`.
  `EinvoiceRow` gains `docType: 'invoice' | 'credit_note'` and `correctedInvoiceNumber: string | null`.

- [ ] **Step 1: Write the failing test**

Create `tests/einvoice/credit-note-outbound.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { getEntry } from '../../src/ledger/posting.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { sendCreditNote } from '../../src/einvoice/outbound.js';
import { listEinvoices } from '../../src/einvoice/query.js';
import type { ECreditNote } from '../../src/einvoice/ubl.js';

const cn: ECreditNote = {
  invoiceNumber: 'CN-2026-001', issueDate: '2026-03-15', currency: 'EUR',
  correctedInvoiceNumber: 'INV-2026-001',
  supplier: { name: 'SIA Pārdevējs', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'SIA Klients', regNo: '40200000000', vatNo: 'LV40200000000' },
  lines: [{ description: 'Atgriešana', net: '100.00', vatRate: 21, vat: '21.00' }],
  netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
};

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('sendCreditNote reverses the receivable and records a credit_note einvoice', async () => {
  const t = await makeFirmAndClient();
  const ap = new StubAccessPoint();
  const { einvoiceId, entryId } = await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Debtors', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, ctx(t), { code: '5721', name: 'Output VAT', type: 'liability' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    return sendCreditNote(tx, ctx(t), { creditNote: cn, recipientPeppolId: '0088:123', ap, receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721' });
  });

  // Reversal of a sale: DR sales 100 / DR output VAT 21 / CR receivable 121.
  const entry = await withTenant(ctx(t), (tx) => getEntry(tx, ctx(t), entryId));
  const byAcct = Object.fromEntries(entry.lines.map((l) => [l.accountId, l]));
  expect(entry.lines).toHaveLength(3);
  const debitTotal = entry.lines.reduce((a, l) => a + Number(l.debit), 0);
  const creditTotal = entry.lines.reduce((a, l) => a + Number(l.credit), 0);
  expect(debitTotal).toBeCloseTo(121);
  expect(creditTotal).toBeCloseTo(121);

  const rows = await withTenant(ctx(t), (tx) => listEinvoices(tx, ctx(t), { direction: 'outbound' }));
  const row = rows.find((r) => r.id === einvoiceId)!;
  expect(row.docType).toBe('credit_note');
  expect(row.correctedInvoiceNumber).toBe('INV-2026-001');
  expect(ap.sent).toHaveLength(1);
});

test('sendCreditNote refuses an unbalanced credit note before dispatch', async () => {
  const t = await makeFirmAndClient();
  const ap = new StubAccessPoint();
  await expect(withTenant(ctx(t), (tx) => sendCreditNote(tx, ctx(t), {
    creditNote: { ...cn, grandTotal: '999.00' }, recipientPeppolId: '0088:123', ap,
    receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721',
  }))).rejects.toThrow(/EN16931|total/i);
  expect(ap.sent).toHaveLength(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/einvoice/credit-note-outbound.test.ts`
Expected: FAIL — `sendCreditNote` not exported; `docType`/`correctedInvoiceNumber` missing on rows.

- [ ] **Step 3: Add `sendCreditNote` to `src/einvoice/outbound.ts`**

Add imports and the function (mirror of `sendInvoice`, reversed posting, `doc_type='credit_note'`):

```ts
import { buildUblInvoice, buildUblCreditNote, type EInvoice, type ECreditNote } from './ubl.js';
// ...existing imports (validateEn16931, postEntry, toCents, appendAudit)...

export async function sendCreditNote(
  tx: PoolClient, ctx: TenantContext,
  args: { creditNote: ECreditNote; recipientPeppolId: string; ap: AccessPoint; receivableAccount: string; salesAccount: string; vatAccount: string },
): Promise<{ einvoiceId: string; entryId: string; messageId: string }> {
  const cn = args.creditNote;

  const v = validateEn16931(cn);
  if (!v.valid) throw new Error(`EN16931 validation failed: ${v.issues.join('; ')}`);

  const ubl = buildUblCreditNote(cn);

  // Reverse the sale: DR sales (net) / DR output VAT (vat) / CR receivable (grand).
  const { entryId } = await postEntry(tx, ctx, {
    date: cn.issueDate, memo: `Credit note ${cn.invoiceNumber}`, currency: cn.currency,
    lines: [
      { accountCode: args.salesAccount, debit: cn.netTotal, credit: '0', description: 'Sales reversal' },
      { accountCode: args.vatAccount, debit: cn.vatTotal, credit: '0', description: 'Output VAT reversal' },
      { accountCode: args.receivableAccount, debit: '0', credit: cn.grandTotal, description: 'Receivable reduction' },
    ],
  });

  const { messageId } = await args.ap.send(ubl, args.recipientPeppolId);

  const res = await tx.query(
    `INSERT INTO einvoices(client_company_id, direction, doc_type, invoice_number, corrected_invoice_number, issue_date, grand_total_cents, currency, ubl_xml, vid_status, peppol_status, peppol_message_id, journal_entry_id)
     VALUES ($1,'outbound','credit_note',$2,$3,$4,$5,$6,$7,'pending','sent',$8,$9) RETURNING id`,
    [ctx.clientCompanyId, cn.invoiceNumber, cn.correctedInvoiceNumber ?? null, cn.issueDate, toCents(cn.grandTotal).toString(), cn.currency, ubl, messageId, entryId],
  );
  const einvoiceId = res.rows[0].id as string;
  await appendAudit(tx, ctx, { action: 'send', entityType: 'einvoice', entityId: einvoiceId, before: null, after: { docType: 'credit_note', invoiceNumber: cn.invoiceNumber, messageId, entryId } });
  return { einvoiceId, entryId, messageId };
}
```

Note: if `buildUblInvoice` is not already imported in `outbound.ts`, keep the existing import line and only add `buildUblCreditNote`/`ECreditNote` to it. (`sendInvoice` currently imports `{ buildUblInvoice, type EInvoice }`.)

- [ ] **Step 4: Surface `docType`/`correctedInvoiceNumber` in `src/einvoice/query.ts`**

Add to `EinvoiceRow`:

```ts
  docType: 'invoice' | 'credit_note';
  correctedInvoiceNumber: string | null;
```

Add to the `SELECT` column list: `doc_type, corrected_invoice_number,`. Add to the row mapper:

```ts
    docType: r.doc_type,
    correctedInvoiceNumber: r.corrected_invoice_number,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- tests/einvoice/credit-note-outbound.test.ts tests/einvoice/query.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/einvoice/outbound.ts src/einvoice/query.ts tests/einvoice/credit-note-outbound.test.ts
git commit -m "feat(credit-notes): AR sendCreditNote — reversal posting + credit_note einvoice (M7)"
```

---

### Task 4: AP — `buildCreditNoteEntry` + `createVendorCreditNote` + approval flip

**Files:**
- Create: `src/payables/credit-notes.ts`
- Modify: `src/proposals/post-proposal.ts` (flip an originating vendor credit note to `applied` on posting)
- Test: `tests/payables/credit-notes.test.ts` (extend the file from Task 1)

**Interfaces:**
- Consumes: `createProposal` + `Rationale` (`../proposals/proposals.js`), `rejectProposal` (`../proposals/lifecycle.js`), `NewJournalEntry` (`../ledger/posting.js`), `toCents`/`fromCents`/`sumCents` (`../db/money.js`), `appendAudit`.
- Produces:
  - `interface NewVendorCreditNoteLine { description: string; expenseAccount: string; net: string; vatRate: number; vat: string; }`
  - `interface NewVendorCreditNote { vendorPartyId: string; creditNoteNumber: string; issueDate: string; currency: string; lines: NewVendorCreditNoteLine[]; correctedBillNumber?: string | null; source?: 'manual' | 'peppol'; documentId?: string | null; einvoiceId?: string | null; }`
  - `interface CreditNoteAccounts { vatInputAccount: string; payablesAccount: string; }`
  - `buildCreditNoteEntry(cn: NewVendorCreditNote, accounts: CreditNoteAccounts): NewJournalEntry`
  - `createVendorCreditNote(tx, ctx, input, accounts): Promise<{ creditNoteId: string; proposalId: string }>`
  - `listVendorCreditNotes(tx, ctx, filter?): Promise<VendorCreditNoteRow[]>`
  - `getVendorCreditNote(tx, ctx, id): Promise<VendorCreditNoteDetail>`

- [ ] **Step 1: Write the failing tests (append to `tests/payables/credit-notes.test.ts`)**

Add these imports at the top of the existing file and the tests below:

```ts
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { createParty } from '../../src/parties/parties.js';
import { getProposal } from '../../src/proposals/proposals.js';
import { approveProposal } from '../../src/proposals/lifecycle.js';
import { postApprovedPosting } from '../../src/proposals/post-proposal.js';
import { getEntry } from '../../src/ledger/posting.js';
import {
  buildCreditNoteEntry, createVendorCreditNote, getVendorCreditNote,
  type NewVendorCreditNote,
} from '../../src/payables/credit-notes.js';

const CN_ACCTS = { vatInputAccount: '5722', payablesAccount: '5310' };

const sampleCn = (vendorPartyId: string): NewVendorCreditNote => ({
  vendorPartyId, creditNoteNumber: 'VCN-7', issueDate: '2026-03-20', currency: 'EUR',
  correctedBillNumber: 'INV-42',
  lines: [{ description: 'Return', expenseAccount: '7710', net: '100.00', vatRate: 21, vat: '21.00' }],
});

async function seedVendor() {
  const t = await makeFirmAndClient();
  const vendor = await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '7710', name: 'Expenses', type: 'expense' });
    await createAccount(tx, ctx(t), { code: '5722', name: 'VAT input', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '5310', name: 'Payables', type: 'liability' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    return createParty(tx, ctx(t), { kind: 'vendor', name: 'Acme Supplies' });
  });
  return { t, vendorId: vendor.id };
}

test('buildCreditNoteEntry reverses the bill: DR payables / CR expense / CR VAT-input', () => {
  const entry = buildCreditNoteEntry(sampleCn('v'), CN_ACCTS);
  const debit = entry.lines.reduce((a, l) => a + Number(l.debit), 0);
  const credit = entry.lines.reduce((a, l) => a + Number(l.credit), 0);
  expect(debit).toBeCloseTo(121);
  expect(credit).toBeCloseTo(121);
  const payable = entry.lines.find((l) => l.accountCode === '5310')!;
  expect(payable.debit).toBe('121.00'); // payables reduced (debit)
  const vat = entry.lines.find((l) => l.accountCode === '5722')!;
  expect(vat.credit).toBe('21.00'); // input VAT reversed (credit)
});

test('buildCreditNoteEntry omits the VAT line when VAT is zero', () => {
  const entry = buildCreditNoteEntry({
    ...sampleCn('v'), lines: [{ description: 'x', expenseAccount: '7710', net: '50.00', vatRate: 0, vat: '0.00' }],
  }, CN_ACCTS);
  expect(entry.lines.find((l) => l.accountCode === '5722')).toBeUndefined();
  expect(entry.lines).toHaveLength(2); // CR expense + DR payables
});

test('createVendorCreditNote writes the credit note, lines, and a pending posting proposal', async () => {
  const { t, vendorId } = await seedVendor();
  const { creditNoteId, proposalId } = await withTenant(ctx(t), (tx) => createVendorCreditNote(tx, ctx(t), sampleCn(vendorId), CN_ACCTS));
  const detail = await withTenant(ctx(t), (tx) => getVendorCreditNote(tx, ctx(t), creditNoteId));
  expect(detail.status).toBe('awaiting_approval');
  expect(detail.grandTotalCents).toBe('12100');
  expect(detail.vendorName).toBe('Acme Supplies');
  expect(detail.correctedBillNumber).toBe('INV-42');
  const prop = await withTenant(ctx(t), (tx) => getProposal(tx, ctx(t), proposalId));
  expect(prop.type).toBe('posting');
  expect(prop.status).toBe('pending_approval');
});

test('approving the proposal posts the reversal and flips the credit note to applied', async () => {
  const { t, vendorId } = await seedVendor();
  const { creditNoteId, proposalId } = await withTenant(ctx(t), (tx) => createVendorCreditNote(tx, ctx(t), sampleCn(vendorId), CN_ACCTS));
  const detail = await withTenant(ctx(t), async (tx) => {
    await approveProposal(tx, ctx(t), proposalId);
    await postApprovedPosting(tx, ctx(t), proposalId);
    return getVendorCreditNote(tx, ctx(t), creditNoteId);
  });
  expect(detail.status).toBe('applied');
  expect(detail.journalEntryId).not.toBeNull();
  const entry = await withTenant(ctx(t), (tx) => getEntry(tx, ctx(t), detail.journalEntryId!));
  expect(entry.lines).toHaveLength(3);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/payables/credit-notes.test.ts`
Expected: FAIL — `src/payables/credit-notes.js` module missing.

- [ ] **Step 3: Create `src/payables/credit-notes.ts`**

```ts
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { createProposal, type Rationale } from '../proposals/proposals.js';
import { rejectProposal } from '../proposals/lifecycle.js';
import type { NewJournalEntry } from '../ledger/posting.js';
import { toCents, fromCents, sumCents } from '../db/money.js';
import { appendAudit } from '../audit/audit.js';

export interface NewVendorCreditNoteLine { description: string; expenseAccount: string; net: string; vatRate: number; vat: string; }
export interface NewVendorCreditNote {
  vendorPartyId: string; creditNoteNumber: string; issueDate: string; currency: string;
  lines: NewVendorCreditNoteLine[]; correctedBillNumber?: string | null;
  source?: 'manual' | 'peppol'; documentId?: string | null; einvoiceId?: string | null;
}
export interface CreditNoteAccounts { vatInputAccount: string; payablesAccount: string; }

export interface VendorCreditNoteRow {
  id: string; vendorPartyId: string; vendorName: string; creditNoteNumber: string; issueDate: string;
  currency: string; netCents: string; vatCents: string; grandTotalCents: string; correctedBillNumber: string | null;
  status: string; source: string; postingProposalId: string | null; journalEntryId: string | null;
}
export interface VendorCreditNoteDetail extends VendorCreditNoteRow {
  lines: { lineNo: number; description: string; expenseAccount: string; netCents: string; vatRate: string; vatCents: string }[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const schema = z.object({
  vendorPartyId: z.string().uuid(),
  creditNoteNumber: z.string().min(1),
  issueDate: z.string().regex(DATE),
  currency: z.string().length(3),
  lines: z.array(z.object({
    description: z.string().min(1),
    expenseAccount: z.string().min(1),
    net: z.string().regex(/^\d+(\.\d{1,2})?$/),   // non-negative magnitudes only
    vatRate: z.number(),
    vat: z.string().regex(/^\d+(\.\d{1,2})?$/),
  })).min(1),
  correctedBillNumber: z.string().nullable().optional(),
  source: z.enum(['manual', 'peppol']).optional(),
  documentId: z.string().uuid().nullable().optional(),
  einvoiceId: z.string().uuid().nullable().optional(),
});

const ROW_COLS = `
  c.id, c.vendor_party_id AS "vendorPartyId", p.name AS "vendorName", c.credit_note_number AS "creditNoteNumber",
  to_char(c.issue_date,'YYYY-MM-DD') AS "issueDate", c.currency,
  c.net_cents::text AS "netCents", c.vat_cents::text AS "vatCents", c.grand_total_cents::text AS "grandTotalCents",
  c.corrected_bill_number AS "correctedBillNumber", c.status, c.source,
  c.posting_proposal_id AS "postingProposalId", c.journal_entry_id AS "journalEntryId"`;

/** Reverse the bill: CR each expense line (net), CR VAT-input (Σvat, if > 0), DR payables (grand). */
export function buildCreditNoteEntry(cn: NewVendorCreditNote, accounts: CreditNoteAccounts): NewJournalEntry {
  const vat = sumCents(cn.lines.map((l) => l.vat));
  const grand = sumCents(cn.lines.map((l) => l.net)) + vat;
  const lines = cn.lines.map((l) => ({ accountCode: l.expenseAccount, debit: '0', credit: l.net, description: l.description }));
  if (vat > 0n) lines.push({ accountCode: accounts.vatInputAccount, debit: '0', credit: fromCents(vat), description: 'VAT input reversal' });
  lines.push({ accountCode: accounts.payablesAccount, debit: fromCents(grand), credit: '0', description: 'Payable reduction' });
  return { date: cn.issueDate, memo: `Vendor credit note ${cn.creditNoteNumber}`, currency: cn.currency, lines };
}

export async function createVendorCreditNote(
  tx: PoolClient, ctx: TenantContext, input: NewVendorCreditNote, accounts: CreditNoteAccounts,
): Promise<{ creditNoteId: string; proposalId: string }> {
  const cn = schema.parse(input);
  const netCents = sumCents(cn.lines.map((l) => l.net));
  const vatCents = sumCents(cn.lines.map((l) => l.vat));
  const grandCents = netCents + vatCents;
  const source = cn.source ?? 'manual';

  const res = await tx.query(
    `INSERT INTO vendor_credit_notes(client_company_id, vendor_party_id, credit_note_number, issue_date, currency,
       net_cents, vat_cents, grand_total_cents, corrected_bill_number, status, source, document_id, einvoice_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'awaiting_approval',$10,$11,$12) RETURNING id`,
    [ctx.clientCompanyId, cn.vendorPartyId, cn.creditNoteNumber, cn.issueDate, cn.currency,
      netCents.toString(), vatCents.toString(), grandCents.toString(), cn.correctedBillNumber ?? null,
      source, cn.documentId ?? null, cn.einvoiceId ?? null],
  );
  const creditNoteId = res.rows[0].id as string;

  for (let i = 0; i < cn.lines.length; i++) {
    const l = cn.lines[i]!;
    await tx.query(
      `INSERT INTO vendor_credit_note_lines(client_company_id, credit_note_id, line_no, description, expense_account, net_cents, vat_rate, vat_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ctx.clientCompanyId, creditNoteId, i + 1, l.description, l.expenseAccount, toCents(l.net).toString(), l.vatRate, toCents(l.vat).toString()],
    );
  }

  const rationale = {
    ruleRef: 'ap-credit-note',
    computation: `net ${fromCents(netCents)} + VAT ${fromCents(vatCents)} = ${fromCents(grandCents)} reduces payables`,
    sourceRefs: { creditNoteId, creditNoteNumber: cn.creditNoteNumber, source },
  } as Rationale;
  const { id: proposalId } = await createProposal(tx, ctx, {
    type: 'posting', payload: buildCreditNoteEntry(cn, accounts), rationale,
    documentId: cn.documentId ?? null, status: 'pending_approval',
  });

  await tx.query(
    `UPDATE vendor_credit_notes SET posting_proposal_id = $1 WHERE id = $2 AND client_company_id = $3`,
    [proposalId, creditNoteId, ctx.clientCompanyId],
  );
  await appendAudit(tx, ctx, { action: 'create', entityType: 'vendor_credit_note', entityId: creditNoteId, before: null, after: { creditNoteNumber: cn.creditNoteNumber, grandCents: grandCents.toString(), proposalId } });
  return { creditNoteId, proposalId };
}

export async function listVendorCreditNotes(
  tx: PoolClient, ctx: TenantContext, filter: { status?: string; vendorPartyId?: string } = {},
): Promise<VendorCreditNoteRow[]> {
  const res = await tx.query(
    `SELECT ${ROW_COLS} FROM vendor_credit_notes c JOIN parties p ON p.id = c.vendor_party_id
     WHERE c.client_company_id = $1
       AND ($2::text IS NULL OR c.status = $2)
       AND ($3::uuid IS NULL OR c.vendor_party_id = $3)
     ORDER BY c.issue_date DESC, c.created_at DESC`,
    [ctx.clientCompanyId, filter.status ?? null, filter.vendorPartyId ?? null],
  );
  return res.rows;
}

export async function getVendorCreditNote(tx: PoolClient, ctx: TenantContext, id: string): Promise<VendorCreditNoteDetail> {
  const c = await tx.query(
    `SELECT ${ROW_COLS} FROM vendor_credit_notes c JOIN parties p ON p.id = c.vendor_party_id
     WHERE c.id = $1 AND c.client_company_id = $2`,
    [id, ctx.clientCompanyId],
  );
  if (!c.rowCount) throw new Error(`Vendor credit note not found: ${id}`);
  const lines = await tx.query(
    `SELECT line_no AS "lineNo", description, expense_account AS "expenseAccount",
            net_cents::text AS "netCents", vat_rate::text AS "vatRate", vat_cents::text AS "vatCents"
     FROM vendor_credit_note_lines WHERE credit_note_id = $1 AND client_company_id = $2 ORDER BY line_no`,
    [id, ctx.clientCompanyId],
  );
  return { ...c.rows[0], lines: lines.rows };
}
```

- [ ] **Step 4: Flip the credit note to `applied` on posting in `src/proposals/post-proposal.ts`**

After the existing "Link + open a payables bill" UPDATE block, add:

```ts
  // Link + apply a vendor credit note, if this posting proposal originated from one.
  await tx.query(
    `UPDATE vendor_credit_notes SET journal_entry_id = $1, status = 'applied'
     WHERE posting_proposal_id = $2 AND client_company_id = $3 AND status = 'awaiting_approval'`,
    [entryId, proposalId, ctx.clientCompanyId],
  );
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- tests/payables/credit-notes.test.ts`
Expected: PASS (all credit-note tests, including the schema tests from Task 1).

- [ ] **Step 6: Run the bill-approval test to confirm no regression to `postApprovedPosting`**

Run: `npm test -- tests/payables/bill-approval.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/payables/credit-notes.ts src/proposals/post-proposal.ts tests/payables/credit-notes.test.ts
git commit -m "feat(credit-notes): AP vendor credit notes — reversal entry, approval flip to applied (M7)"
```

---

### Task 5: AP aging nets applied vendor credit notes

**Files:**
- Modify: `src/payables/aging.ts` (`apAging` subtracts applied credit notes)
- Test: `tests/payables/aging.test.ts` (extend)

**Interfaces:**
- Consumes: existing `apAging(tx, ctx, { asOf })` and `ApAging`.
- Produces: unchanged signature; `apAging` now nets `vendor_credit_notes` with `status='applied'` as negative outstanding, bucketed by the credit note's `issue_date` vs `asOf`.

- [ ] **Step 1: Write the failing test (append to `tests/payables/aging.test.ts`)**

Add imports and a test:

```ts
import { createVendorCreditNote } from '../../src/payables/credit-notes.js';

test('apAging nets an applied vendor credit note against outstanding', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    for (const [code, type] of [['7710','expense'],['5721','asset'],['5722','asset'],['5310','liability']] as const) await createAccount(tx, ctx(t), { code, name: code, type });
    for (const m of [1,2,3,4,5,6,7]) await openPeriod(tx, ctx(t), { year: 2026, month: m });
  });
  await billDue(t, '2026-07-01', '100.00', 'A'); // asOf 2026-06-15 → current, 100

  // A €40 credit note dated in the current bucket, approved → applied.
  await withTenant(ctx(t), async (tx) => {
    const v = await createParty(tx, ctx(t), { kind: 'vendor', name: 'CN-Vendor' });
    const { proposalId } = await createVendorCreditNote(tx, ctx(t), {
      vendorPartyId: v.id, creditNoteNumber: 'VCN-1', issueDate: '2026-06-10', currency: 'EUR',
      lines: [{ description: 'return', expenseAccount: '7710', net: '40.00', vatRate: 0, vat: '0.00' }],
    }, { vatInputAccount: '5722', payablesAccount: '5310' });
    await approveProposal(tx, ctx(t), proposalId);
    await postApprovedPosting(tx, ctx(t), proposalId);
  });

  const aging = await withTenant(ctx(t), (tx) => apAging(tx, ctx(t), { asOf: '2026-06-15' }));
  expect(aging.current).toBe('60.00'); // 100 bill − 40 credit
  expect(aging.total).toBe('60.00');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/payables/aging.test.ts`
Expected: FAIL — `current`/`total` still `100.00` (credit not netted).

- [ ] **Step 3: Net credit notes in `src/payables/aging.ts`**

After the existing bills query and the bucket accumulation loop, query applied credit notes and subtract them into the same buckets (by `issue_date`):

```ts
  const creditRes = await tx.query(
    `SELECT ($2::date - issue_date) AS days, grand_total_cents AS amount
     FROM vendor_credit_notes
     WHERE client_company_id = $1 AND status = 'applied' AND grand_total_cents > 0`,
    [ctx.clientCompanyId, opts.asOf],
  );
  for (const r of creditRes.rows) {
    const days = Number(r.days);
    const amt = BigInt(r.amount);
    if (days <= 0) current -= amt;
    else if (days <= 30) d1_30 -= amt;
    else if (days <= 60) d31_60 -= amt;
    else if (days <= 90) d61_90 -= amt;
    else d90plus -= amt;
  }
```

The existing `total` line (`current + d1_30 + ... + d90plus`) picks up the netting automatically. Leave the `let` declarations of the bucket accumulators as-is (they are already `let`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/payables/aging.test.ts`
Expected: PASS (both the original bucketing test and the new netting test).

- [ ] **Step 5: Commit**

```bash
git add src/payables/aging.ts tests/payables/aging.test.ts
git commit -m "feat(credit-notes): AP aging nets applied vendor credit notes (M7)"
```

---

### Task 6: Inbound Peppol routes CreditNote → vendor credit note

**Files:**
- Modify: `src/einvoice/inbound.ts` (root detection; route to `createVendorCreditNote`)
- Test: `tests/einvoice/credit-note-inbound.test.ts`

**Interfaces:**
- Consumes: `detectUblRoot`, `parseUblCreditNote` (Task 2); `createVendorCreditNote`, `CreditNoteAccounts` (Task 4); existing `parseUblInvoice`, `createBill`, `resolveOrCreateVendor`.
- Produces: `receiveInboundInvoices` return type extends to `{ billIds: string[]; proposalIds: string[]; creditNoteIds: string[] }`. A received `CreditNote` no longer fails the batch — it creates a vendor credit note (`awaiting_approval`) + posting proposal.

- [ ] **Step 1: Write the failing test**

Create `tests/einvoice/credit-note-inbound.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { buildUblCreditNote, type ECreditNote } from '../../src/einvoice/ubl.js';
import { receiveInboundInvoices } from '../../src/einvoice/inbound.js';
import { getProposal } from '../../src/proposals/proposals.js';
import { getVendorCreditNote } from '../../src/payables/credit-notes.js';

const template = { expenseAccount: '7710', vatInputAccount: '5722', payablesAccount: '5310' };
const accounts = { vatInputAccount: '5722', payablesAccount: '5310' };
const cn: ECreditNote = {
  invoiceNumber: 'SUP-CN-3', issueDate: '2026-03-18', currency: 'EUR',
  correctedInvoiceNumber: 'SUP-INV-9',
  supplier: { name: 'SIA Piegādātājs', regNo: '40300000000', vatNo: 'LV40300000000' },
  customer: { name: 'Us', regNo: '40100000000', vatNo: 'LV40100000000' },
  lines: [{ description: 'Atgriešana', net: '200.00', vatRate: 21, vat: '42.00' }],
  netTotal: '200.00', vatTotal: '42.00', grandTotal: '242.00',
};

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('inbound Peppol CreditNote becomes a vendor credit note with a pending proposal', async () => {
  const t = await makeFirmAndClient();
  const ap = new StubAccessPoint([{ ublXml: buildUblCreditNote(cn) }]);
  const { billIds, creditNoteIds, proposalIds } = await withTenant(ctx(t), (tx) => receiveInboundInvoices(tx, ctx(t), { ap, template, accounts }));
  expect(billIds).toHaveLength(0);
  expect(creditNoteIds).toHaveLength(1);
  expect(proposalIds).toHaveLength(1);
  const detail = await withTenant(ctx(t), (tx) => getVendorCreditNote(tx, ctx(t), creditNoteIds[0]!));
  expect(detail.source).toBe('peppol');
  expect(detail.correctedBillNumber).toBe('SUP-INV-9');
  expect(detail.grandTotalCents).toBe('24200');
  const p = await withTenant(ctx(t), (tx) => getProposal(tx, ctx(t), proposalIds[0]!));
  expect(p.status).toBe('pending_approval');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/einvoice/credit-note-inbound.test.ts`
Expected: FAIL — `receiveInboundInvoices` currently parses every message as an Invoice and would throw (unrecognised totals) or lack `creditNoteIds`.

- [ ] **Step 3: Add root-based routing in `src/einvoice/inbound.ts`**

Add imports:

```ts
import { parseUblInvoice, parseUblCreditNote, detectUblRoot } from './ubl.js';
import { createVendorCreditNote, type CreditNoteAccounts } from '../payables/credit-notes.js';
```

Change the return type and the loop. Replace the `billIds`/`proposalIds` declarations with:

```ts
  const billIds: string[] = [];
  const proposalIds: string[] = [];
  const creditNoteIds: string[] = [];
```

Wrap the per-message body with a root check. For `CreditNote` messages, parse and create a vendor credit note; keep the existing invoice path unchanged for `Invoice`:

```ts
  for (const msg of batch) {
    const root = detectUblRoot(msg.ublXml);

    if (root === 'CreditNote') {
      const cn = parseUblCreditNote(msg.ublXml);
      const netTotalCents = toCents(cn.netTotal);
      const vatTotalCents = toCents(cn.vatTotal);
      const grandTotalCents = toCents(cn.grandTotal);
      if (netTotalCents + vatTotalCents !== grandTotalCents) {
        throw new Error(`Inbound credit note ${cn.invoiceNumber}: declared totals do not reconcile; manual review required`);
      }
      const lineNetCents = sumCents(cn.lines.map((l) => l.net));
      if (lineNetCents !== netTotalCents) {
        throw new Error(`Inbound credit note ${cn.invoiceNumber}: line net total (${fromCents(lineNetCents)}) does not reconcile with the declared net total (${cn.netTotal}); manual review required`);
      }
      const rec = await tx.query(
        `INSERT INTO einvoices(client_company_id, direction, doc_type, invoice_number, corrected_invoice_number, issue_date, grand_total_cents, currency, ubl_xml, peppol_status, vid_status)
         VALUES ($1,'inbound','credit_note',$2,$3,$4,$5,$6,$7,'received','not_required') RETURNING id`,
        [ctx.clientCompanyId, cn.invoiceNumber, cn.correctedInvoiceNumber ?? null, cn.issueDate, grandTotalCents.toString(), cn.currency, msg.ublXml],
      );
      const einvoiceId = rec.rows[0].id as string;
      const vendorPartyId = await resolveOrCreateVendor(tx, ctx, cn.supplier);
      const lineVat = reconciledLineVatCents(cn.lines, cn.vatTotal);
      const { creditNoteId, proposalId } = await createVendorCreditNote(tx, ctx, {
        vendorPartyId, creditNoteNumber: cn.invoiceNumber, issueDate: cn.issueDate, currency: cn.currency,
        correctedBillNumber: cn.correctedInvoiceNumber ?? null,
        lines: cn.lines.map((l, i) => ({
          description: l.description, expenseAccount: args.template.expenseAccount,
          net: l.net, vatRate: l.vatRate, vat: fromCents(lineVat[i]!),
        })),
        source: 'peppol', einvoiceId,
      }, args.accounts);
      creditNoteIds.push(creditNoteId);
      proposalIds.push(proposalId);
      continue;
    }

    const ubl = parseUblInvoice(msg.ublXml);
    // ... existing invoice reconciliation + createBill body unchanged ...
  }
  return { billIds, proposalIds, creditNoteIds };
```

Note: `args.accounts` is typed `BillAccounts` (`{ vatInputAccount; payablesAccount }`), which is structurally identical to `CreditNoteAccounts`, so it is passed directly. The `CreditNoteAccounts` import is for clarity/reuse only; if TypeScript flags an unused import, drop it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/einvoice/credit-note-inbound.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the existing inbound + peppol-adopt tests for no regression**

Run: `npm test -- tests/einvoice/inbound.test.ts tests/payables/peppol-adopt.test.ts`
Expected: PASS. (If either destructures `receiveInboundInvoices`' result, the added `creditNoteIds` field is additive and safe.)

- [ ] **Step 6: Commit**

```bash
git add src/einvoice/inbound.ts tests/einvoice/credit-note-inbound.test.ts
git commit -m "feat(credit-notes): inbound Peppol CreditNote → vendor credit note (M7)"
```

---

### Task 7: AR API route + credit-note composer mode + outbox column

**Files:**
- Create: `web/app/api/credit-notes/route.ts`
- Modify: `web/app/(cabinet)/invoices/new/page.tsx` (add a "Credit note" mode with optional invoice prefill)
- Modify: `web/app/(cabinet)/invoices/page.tsx` (document-type column in the outbox)
- Test: manual verification via the running app (this task has no unit test — it is glue over Task 3, exercised by the integration run in Task 9)

**Interfaces:**
- Consumes: `sendCreditNote` (Task 3), `ECreditNote` (Task 2), `resolveTenantContext`, `withTenant`, `assertRoleAllowed`, `errorToStatus`, session helpers, `accessPoint`.
- Produces: `POST /api/credit-notes` → `{ einvoiceId, entryId, messageId }`.

- [ ] **Step 1: Read the Next.js route/page docs before editing web code**

Run: `ls node_modules/next/dist/docs/ && sed -n '1,40p' web/app/api/einvoices/route.ts`
Read the relevant guide(s). `web/AGENTS.md` warns this Next.js differs from training data.

- [ ] **Step 2: Create `web/app/api/credit-notes/route.ts`**

Mirror `web/app/api/einvoices/route.ts` POST, calling `sendCreditNote`. Use the same env-defaulted account codes:

```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { sendCreditNote } from '@domain/einvoice/outbound.js';
import type { ECreditNote } from '@domain/einvoice/ubl.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { accessPoint } from '@/app/lib/access-point';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

const RECEIVABLE_ACCOUNT = process.env.EINVOICE_RECEIVABLE_ACCOUNT ?? '2310';
const SALES_ACCOUNT = process.env.EINVOICE_SALES_ACCOUNT ?? '6110';
const VAT_ACCOUNT = process.env.EINVOICE_VAT_ACCOUNT ?? '5721';

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as {
    clientCompanyId?: string; creditNote?: ECreditNote; recipientPeppolId?: string;
  };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.creditNote) return NextResponse.json({ error: 'missing creditNote' }, { status: 400 });
  if (!body.recipientPeppolId) return NextResponse.json({ error: 'missing recipientPeppolId' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'einvoice.issue');
    const result = await withTenant(ctx, (tx) => sendCreditNote(tx, ctx, {
      creditNote: body.creditNote!, recipientPeppolId: body.recipientPeppolId!, ap: accessPoint,
      receivableAccount: RECEIVABLE_ACCOUNT, salesAccount: SALES_ACCOUNT, vatAccount: VAT_ACCOUNT,
    }));
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
```

- [ ] **Step 3: Add a "Credit note" mode to the composer**

In `web/app/(cabinet)/invoices/new/page.tsx`, add a document-type toggle (Invoice / Credit note). When "Credit note" is selected: (a) POST to `/api/credit-notes` with `{ creditNote, recipientPeppolId }` instead of `/api/einvoices`; (b) show an optional "Credit an existing invoice" number field bound to `correctedInvoiceNumber`; (c) the payload shape is the same `EInvoice` fields plus `correctedInvoiceNumber`. Reuse the existing line editor and live cent-safe totals unchanged. Keep all trilingual labels (LV/RU/EN) consistent with the existing composer strings.

- [ ] **Step 4: Add a document-type column to the outbox**

In `web/app/(cabinet)/invoices/page.tsx`, render each row's `docType` (from `listEinvoices`, surfaced in Task 3) as a labelled column so invoices and credit notes are distinguishable; when `correctedInvoiceNumber` is present on a credit note, show it as "credits INV-…".

- [ ] **Step 5: Typecheck + build the web app**

Run: `cd web && npm run -s build`
Expected: build succeeds, no type errors.

- [ ] **Step 6: Commit**

```bash
git add web/app/api/credit-notes/route.ts "web/app/(cabinet)/invoices/new/page.tsx" "web/app/(cabinet)/invoices/page.tsx"
git commit -m "feat(credit-notes): AR credit-note API route + composer mode + outbox column (M7)"
```

---

### Task 8: AP vendor-credit-note API route + entry UI + payables netting display

**Files:**
- Create: `web/app/api/vendor-credit-notes/route.ts`
- Create: `web/app/(cabinet)/bills/credit-notes/new/page.tsx` (manual vendor credit note entry)
- Modify: `web/app/(cabinet)/bills/page.tsx` (link to credit-note entry; optionally list applied credit notes)
- Test: manual verification via the running app (glue over Tasks 4–5)

**Interfaces:**
- Consumes: `createVendorCreditNote`, `listVendorCreditNotes`, `NewVendorCreditNote` (Task 4); auth/session/tenant helpers.
- Produces: `GET /api/vendor-credit-notes` → `{ creditNotes }`; `POST /api/vendor-credit-notes` → `{ creditNoteId, proposalId }`.

- [ ] **Step 1: Read the Next.js docs + the bills route as the pattern**

Run: `sed -n '1,60p' web/app/api/bills/route.ts`
Confirm the `AP_ACCOUNTS` default (`{ vatInputAccount: '5722', payablesAccount: '5310' }`) and role gate (`bills.write`).

- [ ] **Step 2: Create `web/app/api/vendor-credit-notes/route.ts`**

Mirror `web/app/api/bills/route.ts` GET/POST, calling `listVendorCreditNotes` / `createVendorCreditNote`:

```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { listVendorCreditNotes, createVendorCreditNote, type NewVendorCreditNote } from '@domain/payables/credit-notes.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

const AP_ACCOUNTS = { vatInputAccount: '5722', payablesAccount: '5310' };

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const status = req.nextUrl.searchParams.get('status') ?? undefined;
  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const creditNotes = await withTenant(ctx, (tx) => listVendorCreditNotes(tx, ctx, { status }));
    return NextResponse.json({ creditNotes }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string } & Partial<NewVendorCreditNote>;
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.vendorPartyId || !body.creditNoteNumber || !body.lines?.length) {
    return NextResponse.json({ error: 'missing credit note fields' }, { status: 400 });
  }
  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'bills.write');
    const result = await withTenant(ctx, (tx) => createVendorCreditNote(tx, ctx, {
      vendorPartyId: body.vendorPartyId!, creditNoteNumber: body.creditNoteNumber!, issueDate: body.issueDate!,
      currency: body.currency ?? 'EUR', lines: body.lines!, correctedBillNumber: body.correctedBillNumber ?? null, source: 'manual',
    }, AP_ACCOUNTS));
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
```

- [ ] **Step 3: Create the vendor credit note entry page**

Create `web/app/(cabinet)/bills/credit-notes/new/page.tsx` modelled on the manual bill entry UI: vendor picker (from parties), credit-note number, issue date, optional "corrects bill number", and the same line editor (description / expense account / net / VAT rate / VAT) with live cent-safe totals. POST to `/api/vendor-credit-notes`. Trilingual labels consistent with the bills UI.

- [ ] **Step 4: Link from the bills page**

In `web/app/(cabinet)/bills/page.tsx`, add a "New credit note" link to `/bills/credit-notes/new`. Optionally fetch `GET /api/vendor-credit-notes` and show applied credit notes so the payables picture is complete.

- [ ] **Step 5: Typecheck + build the web app**

Run: `cd web && npm run -s build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add web/app/api/vendor-credit-notes/route.ts "web/app/(cabinet)/bills/credit-notes/new/page.tsx" "web/app/(cabinet)/bills/page.tsx"
git commit -m "feat(credit-notes): AP vendor-credit-note API route + entry UI + bills link (M7)"
```

---

### Task 9: Integration — VAT return nets both credit notes; full verification

**Files:**
- Test: `tests/tax/credit-note-vat.test.ts`

**Interfaces:**
- Consumes: `sendCreditNote` (AR), `createVendorCreditNote` + approval (AP), `computeVat` (`src/tax/vat-compute.ts`, unchanged).
- Produces: proof that an AR credit note reduces output VAT and an AP credit note reduces input VAT within a period, with no change to `computeVat`.

- [ ] **Step 1: Write the failing integration test**

Create `tests/tax/credit-note-vat.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { createParty } from '../../src/parties/parties.js';
import { approveProposal } from '../../src/proposals/lifecycle.js';
import { postApprovedPosting } from '../../src/proposals/post-proposal.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { sendInvoice, sendCreditNote } from '../../src/einvoice/outbound.js';
import { createBill } from '../../src/payables/bills.js';
import { createVendorCreditNote } from '../../src/payables/credit-notes.js';
import { computeVat } from '../../src/tax/vat-compute.js';
import type { EInvoice, ECreditNote } from '../../src/einvoice/ubl.js';

const supplier = { name: 'Us', regNo: '40100000000', vatNo: 'LV40100000000' };
const customer = { name: 'Them', regNo: '40200000000', vatNo: 'LV40200000000' };

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('a period VAT return nets AR and AP credit notes', async () => {
  const t = await makeFirmAndClient();
  const ap = new StubAccessPoint();
  const config = { outputVatAccount: '5721', inputVatAccount: '5722' };

  const vat = await withTenant(ctx(t), async (tx) => {
    for (const [code, type] of [['2310','asset'],['6110','income'],['5721','liability'],['5722','asset'],['7710','expense'],['5310','liability']] as const) await createAccount(tx, ctx(t), { code, name: code, type });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    const vendor = await createParty(tx, ctx(t), { kind: 'vendor', name: 'Vend' });

    // Sale: +100 net / +21 output VAT.
    const inv: EInvoice = { invoiceNumber: 'INV-1', issueDate: '2026-03-05', currency: 'EUR', supplier, customer, lines: [{ description: 's', net: '100.00', vatRate: 21, vat: '21.00' }], netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00' };
    await sendInvoice(tx, ctx(t), { invoice: inv, recipientPeppolId: '0088:1', ap, receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721' });
    // AR credit note: −21 output VAT.
    const cn: ECreditNote = { invoiceNumber: 'CN-1', issueDate: '2026-03-06', currency: 'EUR', correctedInvoiceNumber: 'INV-1', supplier, customer, lines: [{ description: 'r', net: '20.00', vatRate: 21, vat: '4.20' }], netTotal: '20.00', vatTotal: '4.20', grandTotal: '24.20' };
    await sendCreditNote(tx, ctx(t), { creditNote: cn, recipientPeppolId: '0088:1', ap, receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721' });

    // Bill: +50 input VAT worth 10.50.
    const bill = await createBill(tx, ctx(t), { vendorPartyId: vendor.id, billNumber: 'B-1', issueDate: '2026-03-07', dueDate: '2026-04-06', currency: 'EUR', lines: [{ description: 'p', expenseAccount: '7710', net: '50.00', vatRate: 21, vat: '10.50' }] }, config.inputVatAccount === '5722' ? { vatInputAccount: '5722', payablesAccount: '5310' } : { vatInputAccount: '5722', payablesAccount: '5310' });
    await approveProposal(tx, ctx(t), bill.proposalId);
    await postApprovedPosting(tx, ctx(t), bill.proposalId);
    // AP credit note: −input VAT 4.20.
    const vcn = await createVendorCreditNote(tx, ctx(t), { vendorPartyId: vendor.id, creditNoteNumber: 'VCN-1', issueDate: '2026-03-08', currency: 'EUR', lines: [{ description: 'r', expenseAccount: '7710', net: '20.00', vatRate: 21, vat: '4.20' }] }, { vatInputAccount: '5722', payablesAccount: '5310' });
    await approveProposal(tx, ctx(t), vcn.proposalId);
    await postApprovedPosting(tx, ctx(t), vcn.proposalId);

    return computeVat(tx, ctx(t), { fromDate: '2026-03-01', toDate: '2026-03-31', config });
  });

  // Output VAT: 21.00 − 4.20 = 16.80 → 1680 cents. Input VAT: 10.50 − 4.20 = 6.30 → 630 cents.
  expect(vat.outputVatCents).toBe('1680');
  expect(vat.inputVatCents).toBe('630');
  expect(vat.netPayableCents).toBe('1050'); // 1680 − 630
});
```

- [ ] **Step 2: Run the test to verify it fails (then passes)**

Run: `npm test -- tests/tax/credit-note-vat.test.ts`
Expected: FAIL only if any earlier task is incomplete; with Tasks 1–6 done, it PASSES. Fix any real discrepancy (it exercises the whole reversal chain end-to-end).

- [ ] **Step 3: Run the full backend suite**

Run: `npm test`
Expected: all tests pass (the M2 baseline was 333/333; this adds the new credit-note tests on top). Investigate and fix any failure before proceeding.

- [ ] **Step 4: Typecheck root + build web**

Run: `npm run -s typecheck && cd web && npm run -s build`
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add tests/tax/credit-note-vat.test.ts
git commit -m "test(credit-notes): VAT return nets AR + AP credit notes end-to-end (M7)"
```

---

### Task 10: Docs — update roadmap + HANDOFF

**Files:**
- Modify: `docs/ROADMAP-market-gaps.md` (M7 → shipped)
- Modify: `HANDOFF.md` (progress note; clear the M2 "negative bills → M7" follow-up)

- [ ] **Step 1: Mark M7 shipped in the roadmap**

In `docs/ROADMAP-market-gaps.md`, change the M7 row status from ⛔ to ✅ with a dated note: AR credit notes (`sendCreditNote`, UBL CreditNote, composer mode) + AP vendor credit notes (`src/payables/credit-notes.ts`, inbound Peppol routing) + VAT/aging netting.

- [ ] **Step 2: Update HANDOFF**

In `HANDOFF.md`, add an M7 progress bullet under the market-gaps block and note that the M2 negative-bill rejection is now the intended split (bills stay non-negative; credit notes are their own path) — no longer an open follow-up.

- [ ] **Step 3: Commit**

```bash
git add docs/ROADMAP-market-gaps.md HANDOFF.md
git commit -m "docs: M7 credit notes shipped — roadmap + handoff (M7)"
```

---

## Self-Review

**1. Spec coverage:**
- Data model (einvoices `doc_type`/`corrected_invoice_number`; `vendor_credit_notes` + lines) → Task 1. ✅
- AR reversal posting + direct issue + Peppol dispatch → Task 3. ✅
- AP reversal posting + approval proposal + flip to `applied` → Task 4. ✅
- VAT unchanged, nets automatically → verified in Task 9. ✅
- AP aging nets applied credit notes → Task 5. ✅
- UBL CreditNote build/parse + validate + inbound root detection → Tasks 2 and 6. ✅
- API + UI (AR route + composer + outbox; AP route + entry UI + bills link) → Tasks 7 and 8. ✅
- Testing (build*Entry, UBL round-trip, inbound routing, aging netting, VAT integration) → Tasks 2–9. ✅
- Optional invoice/bill link (BillingReference / corrected_bill_number) → Tasks 1, 2, 3, 4, 6. ✅
- Ledger-only, no refund flow → honoured throughout (no cash/refund action anywhere). ✅
- Out-of-scope items (refunds, multi-currency, hard over-credit enforcement, credit-note pay-run) → not built. ✅

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N" — each code step carries full code. UI Tasks 7–8 describe concrete field-level changes with the exact route/payload shapes; they are glue over tested domain functions and are verified by the web build + Task 9's end-to-end domain test. ✅

**3. Type consistency:** `ECreditNote` (Task 2) is consumed by `sendCreditNote` (Task 3) and inbound routing (Task 6). `NewVendorCreditNote`/`CreditNoteAccounts`/`buildCreditNoteEntry`/`createVendorCreditNote`/`listVendorCreditNotes`/`getVendorCreditNote` (Task 4) are consumed consistently by Tasks 5, 6, 8. `EinvoiceRow.docType`/`correctedInvoiceNumber` (Task 3) consumed by Task 7. `detectUblRoot`/`parseUblCreditNote` (Task 2) consumed by Task 6. Account defaults (`2310/6110/5721/5722/5310`) consistent across tasks and env constants. ✅
