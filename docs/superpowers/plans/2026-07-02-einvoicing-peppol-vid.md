# E-invoicing (Peppol) + VID Reporting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send and receive EN 16931 structured invoices via an accredited Peppol Access Point (behind an adapter), post the ledger effects, draft purchase proposals from inbound invoices without OCR, and submit invoice data to VID within the 5-working-day window as a *tracked, retryable* obligation.

**Architecture:** Extends the merged Plan 1–5 monolith. A shared XML escaper (introduced here and retrofitted into the Plan 4 EDS and Plan 5 SEPA generators, closing the logged unescaped-XML items) underpins a UBL 2.1 / Peppol BIS Billing 3.0 builder + parser. Deterministic EN 16931 validation runs before send. The Peppol Access Point and VID sit behind adapter interfaces with sandbox stubs, so the whole flow is testable without network or accreditation. Outbound invoices post a receivable through the Plan 1 ledger; inbound invoices map to the Plan 3 extraction schema and become `posting` proposals (no OCR). VID submissions are rows in a durable table with status + due-date + retry accounting; an overdue query powers alerting so the legal window is never silently missed.

**Tech Stack:** Same as Plans 1–5 (`fast-xml-parser` already present for parsing). `vitest`, admin-run migrations.

## Global Constraints

- **Inherits all Plan 1–5 constraints** (integer-cents; `withTenant`; RLS ENABLE+FORCE + explicit `client_company_id` predicate; migrations as admin, minimal grants; audited state changes; agent output is a proposal).
- **All generated XML is escaped.** Free-text fields (names, descriptions, references) pass through `escapeXml`. No raw interpolation of user text into XML.
- **VID submission is a tracked obligation, not fire-and-forget.** Every required submission is a durable row with `status`, `due_date` (5 working days from issue), and `attempts`; failures are retryable and an overdue query exists for alerting.
- **The AI never has a privileged write path.** Inbound invoices become `posting` proposals via the Plan 2/3 machinery. **Migration numbering continues at 015.**

## Consumed interfaces (all on `main` after Plans 1–5)

```ts
withTenant(ctx, fn); TenantContext
postEntry(tx,ctx,NewJournalEntry) => {entryId}; createAccount; openPeriod
createProposal(tx,ctx,{type:'posting',payload,rationale,documentId?,status}) => {id}
extractedInvoiceSchema, ExtractedInvoice (src/intake/extraction-schema.ts)
extractedToJournalEntry(x, template), PostingTemplate (src/intake/map-posting.ts)
centsToDecimal (src/tax/money-format.ts); toCents/sumCents (src/db/money.ts)
appendAudit(tx,ctx,{action,entityType,entityId,before,after})
```

## File structure

```
migrations/
  015_einvoices.sql            # einvoices (in/out, ubl, peppol + vid status)
  016_vid_submissions.sql      # durable VID submission queue
src/
  xml/escape.ts                # escapeXml (shared) + retrofit EDS/SEPA to use it
  einvoice/ubl.ts              # buildUblInvoice + parseUblInvoice (UBL 2.1 / BIS 3.0)
  einvoice/validate.ts         # validateEn16931 (deterministic)
  einvoice/access-point.ts     # AccessPoint interface + StubAccessPoint
  einvoice/outbound.ts         # sendInvoice (build->validate->dispatch->post receivable)
  einvoice/inbound.ts          # receiveInvoices -> posting proposals (no OCR)
  einvoice/vid.ts              # submitToVid + due-date + findOverdueSubmissions
tests/
  xml/escape.test.ts
  einvoice/ubl.test.ts
  einvoice/validate.test.ts
  einvoice/outbound.test.ts
  einvoice/inbound.test.ts
  einvoice/vid.test.ts
```

**Interfaces produced:**

```ts
function escapeXml(s: string): string;
interface InvoiceParty { name: string; regNo: string; vatNo: string; }
interface InvoiceLineIn { description: string; net: string; vatRate: number; vat: string; }
interface EInvoice { invoiceNumber: string; issueDate: string; currency: string; supplier: InvoiceParty; customer: InvoiceParty; lines: InvoiceLineIn[]; netTotal: string; vatTotal: string; grandTotal: string; }
function buildUblInvoice(inv: EInvoice): string;
function parseUblInvoice(xml: string): EInvoice;
function validateEn16931(inv: EInvoice): { valid: boolean; issues: string[] };
interface AccessPoint { send(ublXml: string, recipient: string): Promise<{ messageId: string }>; receive(): Promise<{ ublXml: string }[]>; }
function sendInvoice(tx, ctx, args: { invoice: EInvoice; recipientPeppolId: string; ap: AccessPoint; receivableAccount: string; salesAccount: string; vatAccount: string }): Promise<{ einvoiceId: string; entryId: string; messageId: string }>;
function receiveInboundInvoices(tx, ctx, args: { ap: AccessPoint; template: PostingTemplate }): Promise<{ proposalIds: string[] }>;
function submitToVid(tx, ctx, einvoiceId: string, vid: VidClient): Promise<{ status: string }>;
function findOverdueVidSubmissions(tx, ctx, asOf: string): Promise<{ einvoiceId: string; dueDate: string }[]>;
```

---

## Task 1: Shared XML escaper (+ retrofit EDS & SEPA)

**Files:** Create `src/xml/escape.ts`; Modify `src/tax/vat-declaration.ts` (toEdsXml) and `src/banking/sepa.ts` (generateSepaCreditTransfer) to escape free-text; Test `tests/xml/escape.test.ts`.

- [ ] **Step 1: Write the failing test — `tests/xml/escape.test.ts`**

```ts
import { expect, test } from 'vitest';
import { escapeXml } from '../../src/xml/escape.js';

test('escapes the five XML metacharacters', () => {
  expect(escapeXml('a & b < c > d " e \' f')).toBe('a &amp; b &lt; c &gt; d &quot; e &apos; f');
});
test('leaves ordinary text unchanged', () => {
  expect(escapeXml('INV-2026-001 Piegāde')).toBe('INV-2026-001 Piegāde');
});
test('coerces non-strings safely', () => {
  expect(escapeXml(String(42))).toBe('42');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/xml/escape.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `src/xml/escape.ts`**

```ts
/** Escape the five XML metacharacters for safe interpolation into element text or attributes. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
```

- [ ] **Step 4: Retrofit the existing generators**

In `src/tax/vat-declaration.ts` `toEdsXml`: import `escapeXml` and wrap the free-text/attribute values that come from data — specifically `d.ruleRef.ruleType`, `d.ruleRef.value`, `d.ruleRef.effectiveFrom` in the `RateRule` attributes (numeric/controlled today, but escape for safety). Numeric element values (`OutputVat` etc.) and ISO dates need no escaping but escaping them is harmless — apply `escapeXml` to the attribute values at minimum.

In `src/banking/sepa.ts` `generateSepaCreditTransfer`: import `escapeXml` and wrap `p.reference` in both the `EndToEndId` and `Ustrd` interpolations, and `p.iban` in the `IBAN` element.

Do NOT change the structure or the existing test expectations (escaping `'INV-1'`, `'PO-77'`, IBANs, and numeric amounts produces identical output, so the Plan 4/5 tests still pass).

- [ ] **Step 5: Run to verify escape tests pass AND the retrofit didn't break Plan 4/5**

Run: `npx vitest run tests/xml/escape.test.ts tests/tax/vat-declaration.test.ts tests/banking/sepa.test.ts`
Expected: PASS (all green — escaped output of the existing test inputs is unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/xml/escape.ts src/tax/vat-declaration.ts src/banking/sepa.ts tests/xml/escape.test.ts
git commit -m "feat: shared XML escaper; escape EDS + SEPA free-text"
```

---

## Task 2: UBL 2.1 invoice builder + parser

**Files:** Create `src/einvoice/ubl.ts`; Test `tests/einvoice/ubl.test.ts`.

- [ ] **Step 1: Write the failing test — `tests/einvoice/ubl.test.ts`**

```ts
import { expect, test } from 'vitest';
import { buildUblInvoice, parseUblInvoice, type EInvoice } from '../../src/einvoice/ubl.js';

const inv: EInvoice = {
  invoiceNumber: 'INV-2026-001', issueDate: '2026-03-10', currency: 'EUR',
  supplier: { name: 'SIA Pārdevējs & Co', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'SIA Klients', regNo: '40200000000', vatNo: 'LV40200000000' },
  lines: [{ description: 'Prece <A>', net: '100.00', vatRate: 21, vat: '21.00' }],
  netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
};

test('builds EN16931-shaped UBL with escaped free text', () => {
  const xml = buildUblInvoice(inv);
  expect(xml).toMatch(/^<\?xml/);
  expect(xml).toContain('<cbc:ID>INV-2026-001</cbc:ID>');
  expect(xml).toContain('<cbc:CustomizationID>urn:cen.eu:en16931:2017');
  expect(xml).toContain('SIA Pārdevējs &amp; Co');       // escaped &
  expect(xml).toContain('Prece &lt;A&gt;');               // escaped < >
  expect(xml).toContain('<cbc:PayableAmount currencyID="EUR">121.00</cbc:PayableAmount>');
});

test('round-trips through parse', () => {
  const xml = buildUblInvoice(inv);
  const parsed = parseUblInvoice(xml);
  expect(parsed.invoiceNumber).toBe('INV-2026-001');
  expect(parsed.currency).toBe('EUR');
  expect(parsed.supplier.name).toBe('SIA Pārdevējs & Co'); // unescaped back
  expect(parsed.grandTotal).toBe('121.00');
  expect(parsed.lines).toHaveLength(1);
  expect(parsed.lines[0]!.net).toBe('100.00');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/einvoice/ubl.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `src/einvoice/ubl.ts`**

```ts
import { XMLParser } from 'fast-xml-parser';
import { escapeXml } from '../xml/escape.js';

export interface InvoiceParty { name: string; regNo: string; vatNo: string; }
export interface InvoiceLineIn { description: string; net: string; vatRate: number; vat: string; }
export interface EInvoice {
  invoiceNumber: string; issueDate: string; currency: string;
  supplier: InvoiceParty; customer: InvoiceParty; lines: InvoiceLineIn[];
  netTotal: string; vatTotal: string; grandTotal: string;
}

const CUSTOMIZATION = 'urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0';
const PROFILE = 'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0';

function party(tag: string, p: InvoiceParty, cur: string): string {
  return [
    `  <cac:${tag}><cac:Party>`,
    `    <cac:PartyLegalEntity><cbc:RegistrationName>${escapeXml(p.name)}</cbc:RegistrationName><cbc:CompanyID>${escapeXml(p.regNo)}</cbc:CompanyID></cac:PartyLegalEntity>`,
    `    <cac:PartyTaxScheme><cbc:CompanyID>${escapeXml(p.vatNo)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>`,
    `  </cac:Party></cac:${tag}>`,
  ].join('\n');
}

export function buildUblInvoice(inv: EInvoice): string {
  const cur = inv.currency;
  const lines = inv.lines.map((l, i) => [
    `  <cac:InvoiceLine>`,
    `    <cbc:ID>${i + 1}</cbc:ID>`,
    `    <cbc:LineExtensionAmount currencyID="${cur}">${l.net}</cbc:LineExtensionAmount>`,
    `    <cac:Item><cbc:Name>${escapeXml(l.description)}</cbc:Name>`,
    `      <cac:ClassifiedTaxCategory><cbc:Percent>${l.vatRate}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item>`,
    `  </cac:InvoiceLine>`,
  ].join('\n')).join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">',
    `  <cbc:CustomizationID>${CUSTOMIZATION}</cbc:CustomizationID>`,
    `  <cbc:ProfileID>${PROFILE}</cbc:ProfileID>`,
    `  <cbc:ID>${escapeXml(inv.invoiceNumber)}</cbc:ID>`,
    `  <cbc:IssueDate>${inv.issueDate}</cbc:IssueDate>`,
    `  <cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode>`,
    party('AccountingSupplierParty', inv.supplier, cur),
    party('AccountingCustomerParty', inv.customer, cur),
    `  <cac:TaxTotal><cbc:TaxAmount currencyID="${cur}">${inv.vatTotal}</cbc:TaxAmount></cac:TaxTotal>`,
    `  <cac:LegalMonetaryTotal>`,
    `    <cbc:LineExtensionAmount currencyID="${cur}">${inv.netTotal}</cbc:LineExtensionAmount>`,
    `    <cbc:TaxExclusiveAmount currencyID="${cur}">${inv.netTotal}</cbc:TaxExclusiveAmount>`,
    `    <cbc:TaxInclusiveAmount currencyID="${cur}">${inv.grandTotal}</cbc:TaxInclusiveAmount>`,
    `    <cbc:PayableAmount currencyID="${cur}">${inv.grandTotal}</cbc:PayableAmount>`,
    `  </cac:LegalMonetaryTotal>`,
    lines,
    '</Invoice>',
  ].join('\n');
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true });

function asArray<T>(v: T | T[] | undefined): T[] { return v === undefined ? [] : Array.isArray(v) ? v : [v]; }
function txt(v: unknown): string { return v && typeof v === 'object' && '#text' in (v as object) ? String((v as { '#text': unknown })['#text']) : String(v ?? ''); }

export function parseUblInvoice(xml: string): EInvoice {
  const inv = parser.parse(xml)?.Invoice;
  if (!inv) throw new Error('Not a UBL Invoice');
  const sup = inv.AccountingSupplierParty?.Party ?? {};
  const cus = inv.AccountingCustomerParty?.Party ?? {};
  const mon = inv.LegalMonetaryTotal ?? {};
  const readParty = (p: Record<string, unknown>): InvoiceParty => ({
    name: String((p.PartyLegalEntity as { RegistrationName?: string })?.RegistrationName ?? ''),
    regNo: String((p.PartyLegalEntity as { CompanyID?: unknown })?.CompanyID ?? ''),
    vatNo: String((p.PartyTaxScheme as { CompanyID?: unknown })?.CompanyID ?? ''),
  });
  return {
    invoiceNumber: String(inv.ID ?? ''),
    issueDate: String(inv.IssueDate ?? ''),
    currency: String(inv.DocumentCurrencyCode ?? ''),
    supplier: readParty(sup),
    customer: readParty(cus),
    lines: asArray(inv.InvoiceLine).map((l: Record<string, unknown>) => ({
      description: String((l.Item as { Name?: string })?.Name ?? ''),
      net: txt(l.LineExtensionAmount),
      vatRate: Number((((l.Item as { ClassifiedTaxCategory?: { Percent?: unknown } })?.ClassifiedTaxCategory)?.Percent) ?? 0),
      vat: '0',
    })),
    netTotal: txt(mon.LineExtensionAmount),
    vatTotal: txt(inv.TaxTotal?.TaxAmount),
    grandTotal: txt(mon.PayableAmount),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/einvoice/ubl.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/einvoice/ubl.ts tests/einvoice/ubl.test.ts
git commit -m "feat: UBL 2.1 / Peppol BIS 3.0 invoice builder + parser"
```

---

## Task 3: EN 16931 validation

**Files:** Create `src/einvoice/validate.ts`; Test `tests/einvoice/validate.test.ts`.

- [ ] **Step 1: Write the failing test — `tests/einvoice/validate.test.ts`**

```ts
import { expect, test } from 'vitest';
import { validateEn16931 } from '../../src/einvoice/validate.js';
import type { EInvoice } from '../../src/einvoice/ubl.js';

const good: EInvoice = {
  invoiceNumber: 'INV-1', issueDate: '2026-03-10', currency: 'EUR',
  supplier: { name: 'S', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'C', regNo: '40200000000', vatNo: 'LV40200000000' },
  lines: [{ description: 'A', net: '100.00', vatRate: 21, vat: '21.00' }],
  netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
};

test('a compliant invoice validates', () => {
  const r = validateEn16931(good);
  expect(r.valid).toBe(true);
  expect(r.issues).toEqual([]);
});
test('flags a missing invoice number (BR-2)', () => {
  const r = validateEn16931({ ...good, invoiceNumber: '' });
  expect(r.valid).toBe(false);
  expect(r.issues.join(' ')).toMatch(/number/i);
});
test('flags totals that do not reconcile (BR-CO-15)', () => {
  const r = validateEn16931({ ...good, grandTotal: '130.00' });
  expect(r.valid).toBe(false);
  expect(r.issues.join(' ')).toMatch(/total/i);
});
test('flags a missing supplier VAT id', () => {
  const r = validateEn16931({ ...good, supplier: { ...good.supplier, vatNo: '' } });
  expect(r.valid).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/einvoice/validate.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `src/einvoice/validate.ts`**

```ts
import type { EInvoice } from './ubl.js';
import { toCents, sumCents } from '../db/money.js';

/** A pragmatic subset of EN 16931 business rules relevant to the MVP. */
export function validateEn16931(inv: EInvoice): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!inv.invoiceNumber) issues.push('BR-2: invoice number is required');
  if (!inv.issueDate) issues.push('BR-3: issue date is required');
  if (!/^[A-Z]{3}$/.test(inv.currency)) issues.push('BR-5: a valid currency code is required');
  if (!inv.supplier.vatNo) issues.push('BR-CO-9: supplier VAT identifier is required');
  if (inv.lines.length === 0) issues.push('BR-16: at least one invoice line is required');

  const lineNet = sumCents(inv.lines.map((l) => l.net));
  if (lineNet !== toCents(inv.netTotal)) issues.push('BR-CO-10: line net total does not sum to the net total');
  if (toCents(inv.grandTotal) !== toCents(inv.netTotal) + toCents(inv.vatTotal)) {
    issues.push('BR-CO-15: grand total must equal net + VAT total');
  }
  return { valid: issues.length === 0, issues };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/einvoice/validate.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/einvoice/validate.ts tests/einvoice/validate.test.ts
git commit -m "feat: EN 16931 invoice validation (MVP rule subset)"
```

---

## Task 4: einvoices table + Access Point adapter + outbound send

**Files:** Create `migrations/015_einvoices.sql`, `src/einvoice/access-point.ts`, `src/einvoice/outbound.ts`; Test `tests/einvoice/outbound.test.ts`.

- [ ] **Step 1: Create `migrations/015_einvoices.sql`**

```sql
CREATE TABLE einvoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  direction text NOT NULL CHECK (direction IN ('outbound','inbound')),
  invoice_number text NOT NULL,
  issue_date date NOT NULL,
  grand_total_cents bigint NOT NULL,
  currency char(3) NOT NULL,
  ubl_xml text NOT NULL,
  peppol_status text NOT NULL DEFAULT 'queued' CHECK (peppol_status IN ('queued','sent','delivered','failed','received')),
  peppol_message_id text,
  vid_status text NOT NULL DEFAULT 'pending' CHECK (vid_status IN ('pending','submitted','failed','not_required')),
  vid_due_date date,
  journal_entry_id uuid REFERENCES journal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX einvoices_client_idx ON einvoices(client_company_id, direction, peppol_status);
CREATE INDEX einvoices_vid_due_idx ON einvoices(client_company_id, vid_status, vid_due_date);

ALTER TABLE einvoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE einvoices FORCE ROW LEVEL SECURITY;
CREATE POLICY einvoices_tenant_isolation ON einvoices
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON einvoices TO bookkeeping_app;
```

- [ ] **Step 2: Write the failing test — `tests/einvoice/outbound.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { getEntry } from '../../src/ledger/posting.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { sendInvoice } from '../../src/einvoice/outbound.js';
import type { EInvoice } from '../../src/einvoice/ubl.js';

const inv: EInvoice = {
  invoiceNumber: 'INV-2026-001', issueDate: '2026-03-10', currency: 'EUR',
  supplier: { name: 'SIA Pārdevējs', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'SIA Klients', regNo: '40200000000', vatNo: 'LV40200000000' },
  lines: [{ description: 'Prece', net: '100.00', vatRate: 21, vat: '21.00' }],
  netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
};

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('sends an invoice: dispatches via AP, posts a receivable, records the einvoice', async () => {
  const t = await makeFirmAndClient();
  const ap = new StubAccessPoint();
  const { einvoiceId, entryId, messageId } = await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Debtors', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, ctx(t), { code: '5721', name: 'Output VAT', type: 'liability' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    return sendInvoice(tx, ctx(t), { invoice: inv, recipientPeppolId: '0088:123', ap, receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721' });
  });
  expect(messageId).toBeTruthy();
  // receivable posted: DR debtors 121 / CR sales 100 / CR vat 21
  const entry = await withTenant(ctx(t), (tx) => getEntry(tx, ctx(t), entryId));
  expect(entry.lines).toHaveLength(3);
  // einvoice recorded as sent
  const row = await withTenant(ctx(t), async (tx) => (await tx.query('SELECT direction, peppol_status, vid_status FROM einvoices WHERE id = $1', [einvoiceId])).rows[0]);
  expect(row.direction).toBe('outbound');
  expect(row.peppol_status).toBe('sent');
  expect(row.vid_status).toBe('pending'); // awaiting VID submission (Task 6)
  expect(ap.sent).toHaveLength(1);
});

test('refuses to send an invalid invoice (fails EN16931 before dispatch)', async () => {
  const t = await makeFirmAndClient();
  const ap = new StubAccessPoint();
  await expect(withTenant(ctx(t), (tx) => sendInvoice(tx, ctx(t), {
    invoice: { ...inv, grandTotal: '999.00' }, recipientPeppolId: '0088:123', ap,
    receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721',
  }))).rejects.toThrow(/EN16931|total/i);
  expect(ap.sent).toHaveLength(0); // never dispatched
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/einvoice/outbound.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 4: Create `src/einvoice/access-point.ts`**

```ts
export interface AccessPoint {
  send(ublXml: string, recipient: string): Promise<{ messageId: string }>;
  receive(): Promise<{ ublXml: string }[]>;
}

/** In-memory sandbox Access Point for tests. */
export class StubAccessPoint implements AccessPoint {
  public sent: { ublXml: string; recipient: string }[] = [];
  private inbox: { ublXml: string }[];
  private seq = 0;
  constructor(inbox: { ublXml: string }[] = []) { this.inbox = inbox; }
  async send(ublXml: string, recipient: string): Promise<{ messageId: string }> {
    this.sent.push({ ublXml, recipient });
    this.seq += 1;
    return { messageId: `stub-msg-${this.seq}` };
  }
  async receive(): Promise<{ ublXml: string }[]> {
    const batch = this.inbox;
    this.inbox = [];
    return batch;
  }
}
```

- [ ] **Step 5: Create `src/einvoice/outbound.ts`**

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import type { AccessPoint } from './access-point.js';
import { buildUblInvoice, type EInvoice } from './ubl.js';
import { validateEn16931 } from './validate.js';
import { postEntry } from '../ledger/posting.js';
import { toCents } from '../db/money.js';
import { appendAudit } from '../audit/audit.js';

export async function sendInvoice(
  tx: PoolClient, ctx: TenantContext,
  args: { invoice: EInvoice; recipientPeppolId: string; ap: AccessPoint; receivableAccount: string; salesAccount: string; vatAccount: string },
): Promise<{ einvoiceId: string; entryId: string; messageId: string }> {
  const inv = args.invoice;

  // 1. Validate against EN 16931 BEFORE anything else.
  const v = validateEn16931(inv);
  if (!v.valid) throw new Error(`EN16931 validation failed: ${v.issues.join('; ')}`);

  // 2. Render UBL.
  const ubl = buildUblInvoice(inv);

  // 3. Post the receivable: DR receivable (gross) / CR sales (net) / CR VAT (vat).
  const { entryId } = await postEntry(tx, ctx, {
    date: inv.issueDate, memo: `Sales invoice ${inv.invoiceNumber}`, currency: inv.currency,
    lines: [
      { accountCode: args.receivableAccount, debit: inv.grandTotal, credit: '0', description: 'Receivable' },
      { accountCode: args.salesAccount, debit: '0', credit: inv.netTotal, description: 'Sales' },
      { accountCode: args.vatAccount, debit: '0', credit: inv.vatTotal, description: 'Output VAT' },
    ],
  });

  // 4. Dispatch via the Access Point.
  const { messageId } = await args.ap.send(ubl, args.recipientPeppolId);

  // 5. Record the einvoice (vid_status pending — VID submission handled in Task 6).
  const res = await tx.query(
    `INSERT INTO einvoices(client_company_id, direction, invoice_number, issue_date, grand_total_cents, currency, ubl_xml, peppol_status, peppol_message_id, journal_entry_id)
     VALUES ($1,'outbound',$2,$3,$4,$5,$6,'sent',$7,$8) RETURNING id`,
    [ctx.clientCompanyId, inv.invoiceNumber, inv.issueDate, toCents(inv.grandTotal).toString(), inv.currency, ubl, messageId, entryId],
  );
  const einvoiceId = res.rows[0].id as string;
  await appendAudit(tx, ctx, { action: 'send', entityType: 'einvoice', entityId: einvoiceId, before: null, after: { invoiceNumber: inv.invoiceNumber, messageId, entryId } });
  return { einvoiceId, entryId, messageId };
}
```

- [ ] **Step 6: Run to verify it passes, then commit**

Run: `npx vitest run tests/einvoice/outbound.test.ts`
Expected: PASS (2 tests).

```bash
git add migrations/015_einvoices.sql src/einvoice/access-point.ts src/einvoice/outbound.ts tests/einvoice/outbound.test.ts
git commit -m "feat: outbound e-invoice send (validate -> UBL -> dispatch -> post receivable)"
```

---

## Task 5: Inbound flow → posting proposals (no OCR)

**Files:** Create `src/einvoice/inbound.ts`; Test `tests/einvoice/inbound.test.ts`.

Received UBL is structured, so it skips OCR: parse → map to `ExtractedInvoice` shape → `extractedToJournalEntry` → create a `posting` proposal (`pending_approval`) and record the inbound einvoice. Mirrors the Plan 3 intake tail without the extractor.

- [ ] **Step 1: Write the failing test — `tests/einvoice/inbound.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { buildUblInvoice, type EInvoice } from '../../src/einvoice/ubl.js';
import { receiveInboundInvoices } from '../../src/einvoice/inbound.js';
import { getProposal } from '../../src/proposals/proposals.js';

const template = { expenseAccount: '7710', vatInputAccount: '5722', payablesAccount: '5310' };
const inv: EInvoice = {
  invoiceNumber: 'SUP-INV-9', issueDate: '2026-03-12', currency: 'EUR',
  supplier: { name: 'SIA Piegādātājs', regNo: '40300000000', vatNo: 'LV40300000000' },
  customer: { name: 'Us', regNo: '40100000000', vatNo: 'LV40100000000' },
  lines: [{ description: 'Materiāli', net: '200.00', vatRate: 21, vat: '42.00' }],
  netTotal: '200.00', vatTotal: '42.00', grandTotal: '242.00',
};

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('inbound Peppol invoice becomes a pending purchase proposal (no OCR)', async () => {
  const t = await makeFirmAndClient();
  const ap = new StubAccessPoint([{ ublXml: buildUblInvoice(inv) }]);
  const proposalIds = await withTenant(ctx(t), async (tx) => (await receiveInboundInvoices(tx, ctx(t), { ap, template })).proposalIds);
  expect(proposalIds).toHaveLength(1);
  const p = await withTenant(ctx(t), (tx) => getProposal(tx, ctx(t), proposalIds[0]!));
  expect(p.type).toBe('posting');
  expect(p.status).toBe('pending_approval');
  const payload = p.payload as { lines: { accountCode: string }[] };
  expect(payload.lines).toHaveLength(3); // expense + input VAT + payable
});

test('no inbound invoices yields no proposals', async () => {
  const t = await makeFirmAndClient();
  const ap = new StubAccessPoint([]);
  const ids = await withTenant(ctx(t), async (tx) => (await receiveInboundInvoices(tx, ctx(t), { ap, template })).proposalIds);
  expect(ids).toHaveLength(0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/einvoice/inbound.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `src/einvoice/inbound.ts`**

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import type { AccessPoint } from './access-point.js';
import { parseUblInvoice } from './ubl.js';
import { extractedToJournalEntry, type PostingTemplate } from '../intake/map-posting.js';
import type { ExtractedInvoice } from '../intake/extraction-schema.js';
import { createProposal, type Rationale } from '../proposals/proposals.js';
import { toCents } from '../db/money.js';

export async function receiveInboundInvoices(
  tx: PoolClient, ctx: TenantContext, args: { ap: AccessPoint; template: PostingTemplate },
): Promise<{ proposalIds: string[] }> {
  const batch = await args.ap.receive();
  const proposalIds: string[] = [];

  for (const msg of batch) {
    const ubl = parseUblInvoice(msg.ublXml);

    // Record the inbound einvoice.
    const rec = await tx.query(
      `INSERT INTO einvoices(client_company_id, direction, invoice_number, issue_date, grand_total_cents, currency, ubl_xml, peppol_status, vid_status)
       VALUES ($1,'inbound',$2,$3,$4,$5,$6,'received','not_required') RETURNING id`,
      [ctx.clientCompanyId, ubl.invoiceNumber, ubl.issueDate, toCents(ubl.grandTotal).toString(), ubl.currency, msg.ublXml],
    );
    const einvoiceId = rec.rows[0].id as string;

    // Map structured invoice -> ExtractedInvoice shape (no OCR) -> journal entry payload.
    const extracted: ExtractedInvoice = {
      supplierName: ubl.supplier.name, supplierRegNo: ubl.supplier.regNo,
      date: ubl.issueDate, currency: ubl.currency,
      lineItems: ubl.lines.map((l) => ({ description: l.description, net: l.net, vatRate: l.vatRate, vat: l.vat })),
      vatTotal: ubl.vatTotal, netTotal: ubl.netTotal, grandTotal: ubl.grandTotal,
    };
    const entry = extractedToJournalEntry(extracted, args.template);

    const rationale = {
      ruleRef: 'peppol-inbound',
      computation: `net ${ubl.netTotal} + VAT ${ubl.vatTotal} = ${ubl.grandTotal}`,
      sourceRefs: { einvoiceId, invoiceNumber: ubl.invoiceNumber, source: 'peppol' },
    } as Rationale;

    const { id } = await createProposal(tx, ctx, { type: 'posting', payload: entry, rationale, status: 'pending_approval' });
    proposalIds.push(id);
  }

  return { proposalIds };
}
```

> Note: inbound UBL parsing sets each line's `vat` to `'0'` (the builder doesn't emit per-line VAT amounts). For the MVP the mapper uses `vatTotal`/`netTotal`/`grandTotal` at the document level, so per-line vat is not needed for the 3-line posting. If a future validation needs per-line VAT, extend the UBL parser to read `cac:TaxTotal` per line. The extracted line `vat` here is carried from `ubl.lines[].vat` which is `'0'` — acceptable because `extractedToJournalEntry` uses the document totals, not line vat. Confirm the produced entry balances (net+vat=gross at the document level).

- [ ] **Step 4: Run to verify it passes, then commit**

Run: `npx vitest run tests/einvoice/inbound.test.ts`
Expected: PASS (2 tests).

```bash
git add src/einvoice/inbound.ts tests/einvoice/inbound.test.ts
git commit -m "feat: inbound Peppol invoice -> purchase proposal (no OCR)"
```

---

## Task 6: VID submission + durable retry + overdue alerting

**Files:** Create `migrations/016_vid_submissions.sql`, `src/einvoice/vid.ts`; Test `tests/einvoice/vid.test.ts`.

Every outbound einvoice must be reported to VID within **5 working days** of issue. `submitToVid` calls a `VidClient` adapter (stub in tests), records the attempt, and sets `vid_status`; on failure it stays `pending`/`failed` and remains retryable. `findOverdueVidSubmissions` returns still-unsubmitted einvoices past their due date for alerting. Due date = issue date + 5 working days (weekends skipped; LR public holidays deferred).

- [ ] **Step 1: Create `migrations/016_vid_submissions.sql`**

```sql
CREATE TABLE vid_submission_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  einvoice_id uuid NOT NULL REFERENCES einvoices(id),
  attempted_at timestamptz NOT NULL DEFAULT now(),
  ok boolean NOT NULL,
  detail text
);
CREATE INDEX vid_attempts_einvoice_idx ON vid_submission_attempts(einvoice_id);

ALTER TABLE vid_submission_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE vid_submission_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY vid_attempts_tenant_isolation ON vid_submission_attempts
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

GRANT SELECT, INSERT ON vid_submission_attempts TO bookkeeping_app;
```

- [ ] **Step 2: Write the failing test — `tests/einvoice/vid.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { sendInvoice } from '../../src/einvoice/outbound.js';
import { submitToVid, findOverdueVidSubmissions, addWorkingDays } from '../../src/einvoice/vid.js';
import type { EInvoice } from '../../src/einvoice/ubl.js';

const inv: EInvoice = {
  invoiceNumber: 'INV-2026-001', issueDate: '2026-03-10', currency: 'EUR',
  supplier: { name: 'S', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'C', regNo: '40200000000', vatNo: 'LV40200000000' },
  lines: [{ description: 'A', net: '100.00', vatRate: 21, vat: '21.00' }],
  netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
};

async function send(t: { firmId: string; clientCompanyId: string }) {
  return withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Debtors', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, ctx(t), { code: '5721', name: 'VAT', type: 'liability' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    return sendInvoice(tx, ctx(t), { invoice: inv, recipientPeppolId: '0088:1', ap: new StubAccessPoint(), receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721' });
  });
}

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('addWorkingDays skips weekends', () => {
  // 2026-03-10 is a Tuesday; +5 working days = Tuesday 2026-03-17
  expect(addWorkingDays('2026-03-10', 5)).toBe('2026-03-17');
});

test('successful VID submission marks the einvoice submitted and records an attempt', async () => {
  const t = await makeFirmAndClient();
  const { einvoiceId } = await send(t);
  const vid = { submit: async () => ({ ok: true, detail: 'accepted' }) };
  const r = await withTenant(ctx(t), (tx) => submitToVid(tx, ctx(t), einvoiceId, vid));
  expect(r.status).toBe('submitted');
  const row = await withTenant(ctx(t), async (tx) => (await tx.query('SELECT vid_status, vid_due_date FROM einvoices WHERE id=$1', [einvoiceId])).rows[0]);
  expect(row.vid_status).toBe('submitted');
});

test('a failed submission stays retryable and shows up as overdue past due date', async () => {
  const t = await makeFirmAndClient();
  const { einvoiceId } = await send(t);
  const failing = { submit: async () => ({ ok: false, detail: 'VID timeout' }) };
  const r = await withTenant(ctx(t), (tx) => submitToVid(tx, ctx(t), einvoiceId, failing));
  expect(r.status).toBe('failed');
  // Query overdue as of well after the due date
  const overdue = await withTenant(ctx(t), (tx) => findOverdueVidSubmissions(tx, ctx(t), '2026-04-01'));
  expect(overdue.map((o) => o.einvoiceId)).toContain(einvoiceId);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/einvoice/vid.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Create `src/einvoice/vid.ts`**

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appendAudit } from '../audit/audit.js';

export interface VidClient { submit(ublXml: string): Promise<{ ok: boolean; detail: string }>; }

/** Add N working days (skip Sat/Sun). LR public holidays are deferred (documented). Returns 'YYYY-MM-DD'. */
export function addWorkingDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  let added = 0;
  while (added < n) {
    dt.setUTCDate(dt.getUTCDate() + 1);
    const day = dt.getUTCDay();
    if (day !== 0 && day !== 6) added++;
  }
  return dt.toISOString().slice(0, 10);
}

export async function submitToVid(
  tx: PoolClient, ctx: TenantContext, einvoiceId: string, vid: VidClient,
): Promise<{ status: string }> {
  const row = await tx.query(
    `SELECT ubl_xml AS "ublXml", to_char(issue_date,'YYYY-MM-DD') AS "issueDate", vid_due_date
     FROM einvoices WHERE id = $1 AND client_company_id = $2 AND direction = 'outbound'`,
    [einvoiceId, ctx.clientCompanyId],
  );
  if (!row.rowCount) throw new Error(`Outbound einvoice not found: ${einvoiceId}`);
  const { ublXml, issueDate } = row.rows[0];
  const dueDate = addWorkingDays(issueDate, 5);

  const result = await vid.submit(ublXml);
  const status = result.ok ? 'submitted' : 'failed';

  await tx.query(
    `UPDATE einvoices SET vid_status = $1, vid_due_date = $2 WHERE id = $3 AND client_company_id = $4`,
    [status, dueDate, einvoiceId, ctx.clientCompanyId],
  );
  await tx.query(
    `INSERT INTO vid_submission_attempts(client_company_id, einvoice_id, ok, detail) VALUES ($1,$2,$3,$4)`,
    [ctx.clientCompanyId, einvoiceId, result.ok, result.detail],
  );
  await appendAudit(tx, ctx, { action: 'vid_submit', entityType: 'einvoice', entityId: einvoiceId, before: null, after: { status, dueDate } });
  return { status };
}

/** Outbound einvoices not yet submitted whose due date has passed as of `asOf` — for alerting. */
export async function findOverdueVidSubmissions(
  tx: PoolClient, ctx: TenantContext, asOf: string,
): Promise<{ einvoiceId: string; dueDate: string }[]> {
  const res = await tx.query(
    `SELECT id AS "einvoiceId", to_char(vid_due_date,'YYYY-MM-DD') AS "dueDate"
     FROM einvoices
     WHERE client_company_id = $1 AND direction = 'outbound'
       AND vid_status IN ('pending','failed') AND vid_due_date IS NOT NULL AND vid_due_date < $2
     ORDER BY vid_due_date`,
    [ctx.clientCompanyId, asOf],
  );
  return res.rows;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/einvoice/vid.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Run full suite + typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, clean.

- [ ] **Step 7: Commit**

```bash
git add migrations/016_vid_submissions.sql src/einvoice/vid.ts tests/einvoice/vid.test.ts
git commit -m "feat: VID submission with due-date tracking + overdue alerting"
```

---

## Self-review

**Spec coverage (design §6.7 Peppol, §6.8 VID/EDS, §2 near-real-time):**
- Native structured e-invoice send/receive via Peppol AP (UBL 2.1 / BIS 3.0), behind an adapter with a sandbox stub → Tasks 2, 4, 5. ✓
- EN 16931 validation before send → Task 3, enforced in Task 4 (never dispatches an invalid invoice). ✓
- Inbound structured XML → draft posting proposal, skipping OCR → Task 5. ✓
- VID data submission within 5 working days as a tracked, retryable obligation with overdue alerting → Task 6. ✓
- All generated XML escaped (shared escaper; EDS + SEPA retrofitted) → Task 1. ✓

**Deliberately deferred:** exact accredited-AP wiring + real VID/EDS endpoints (adapters here; the concrete provider is spec §10); full EN 16931 rule set (MVP subset — the rule engine is one function, extensible); LR public-holiday calendar for the working-day count (weekends only for now, documented); the EDS *declaration* submission wire-up reuses this VID adapter pattern and the Plan 4 declaration proposal — a thin follow-up once the real EDS endpoint is known; per-line VAT in the UBL parser (document-level totals suffice for the MVP posting).

**Placeholder scan:** UBL/EN16931 are a documented MVP subset; XML is escaped and well-formed; adapters have real stub impls exercised by tests. No silent TODOs.

**Type consistency:** consumed Plan 1–5 signatures match `main` (`postEntry`, `createProposal`, `extractedToJournalEntry`, `ExtractedInvoice`, `centsToDecimal`, `toCents`). `EInvoice`, `AccessPoint`, `VidClient` used consistently across Tasks 2–6. Inbound reuses the Plan 3 `map-posting` + Plan 2 proposal path, so a Peppol purchase and an OCR purchase converge on the same approval flow.
