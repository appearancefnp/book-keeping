# M9 Slice A — VAT category model, EN 16931 fix, category-aware return

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every invoice and bill line an EN 16931 VAT category, fix the mandatory BT-151 code missing from our UBL, self-assess reverse-charge purchases into the ledger, and add a per-category breakdown plus reconciliation indicator to the VAT return.

**Architecture:** A pure `src/tax/categories.ts` owns the category vocabulary and every derived rule (charges VAT, self-assesses, ECSL supply type, exemption reason, self-assessed amount, consistency issues). Storage is line-level: a new `einvoice_lines` table for outbound sales documents, plus `vat_category` / `vat_deductible` on the existing `bill_lines`. `computeVat` keeps sweeping the ledger for authoritative totals; a new `vat-breakdown.ts` aggregates documents for the category detail, and `assembleVatDeclaration` reports a `reconciles` flag when the two disagree.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Postgres 16 with RLS, `pg`, zod, vitest, Next.js 16 App Router in `web/`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-29-vat-completeness-design.md`. Read it before Task 1.
- Money is **integer cents** via `src/db/money.ts` (`toCents`, `fromCents`, `sumCents`). Never floats.
- The ledger is **append-only** (DB triggers). Corrections are reversals, never edits.
- Every domain call runs inside `withTenant(ctx, ...)`; every mutation calls `appendAudit(...)`.
- Migration numbers: **never reuse**. This plan owns **`046`** only. `tests/db/migration-numbering.test.ts` fails the build on a new collision.
- New tables get `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + a tenant-isolation policy on `client_company_id = current_setting('app.current_client_id', true)::uuid` + explicit `GRANT` to `bookkeeping_app`. Copy `migrations/030_bills.sql`.
- Every user-facing string goes in all three catalogs (LV/RU/EN) in `web/app/lib/i18n.ts`.
- The VAT category code list is exactly `S, Z, E, AE, K, G, O` — the same list in the TypeScript union, both SQL `CHECK` constraints, and the zod enums.
- **The AE/K rate is side-dependent, and this is load-bearing.** On a *wire* document (an outbound invoice, or a supplier's inbound one) BR-AE-5 / BR-IC-5 require the invoiced rate to be **0** — the customer accounts for the VAT at their own domestic rate, which is never transmitted. In *our own purchase records* (`bill_lines`, vendor credit notes) the same line must carry the **domestic rate** (21/12/5), because `buildBillEntry` multiplies by it to self-assess. Hence `categoryIssues(line, side)`, and hence the inbound path substituting the domestic rate from `tax_rules`. Sales fixtures use rate 0 on AE/K lines; purchase fixtures use the real rate.
- Run `npm test` (root) and `npx tsc --noEmit` in **both** root and `web/` before declaring any task done.
- **Never run two vitest suites concurrently** — `resetDb()` drops the public schema on a shared database.
- Commit after every task, with the session trailer: `Claude-Session: https://claude.ai/code/session_01BQ5EiunbJpf7XY9Bge3gB1`

---

## File Structure

**Create:**
- `migrations/046_vat_categories.sql` — `einvoice_lines`; `bill_lines` + `vat_category`, `vat_deductible`, `cn_code`, `net_mass_kg`; `parties` + `country_code`.
- `src/tax/categories.ts` — the category vocabulary and all pure rules derived from it.
- `src/einvoice/lines.ts` — `insertEinvoiceLines`, `listEinvoiceLines`; the only writer/reader of `einvoice_lines`.
- `src/tax/vat-breakdown.ts` — document-derived per-category aggregation.
- `tests/tax/categories.test.ts`, `tests/tax/vat-breakdown.test.ts`, `tests/tax/vat-reconciliation.test.ts`, `tests/einvoice/ubl-categories.test.ts`, `tests/einvoice/einvoice-lines.test.ts`, `tests/payables/bills-reverse-charge.test.ts`, `tests/parties/country.test.ts`.

**Modify:**
- `src/einvoice/ubl.ts` — emit BT-151 + per-category `TaxSubtotal`; parse the category back; `vatCategory` on `InvoiceLineIn`.
- `src/einvoice/validate.ts` — category business rules.
- `src/einvoice/outbound.ts` — persist lines for invoice + credit note.
- `src/einvoice/inbound.ts` — carry the parsed category into `bill_lines`; category-aware per-line VAT split.
- `src/payables/bills.ts` — `vatCategory` / `vatDeductible` on lines, category-aware `buildBillEntry`, persistence, `getBill` detail.
- `src/payables/credit-notes.ts` — the same treatment, reversed.
- `src/parties/parties.ts` — `countryCode` on create/update/read.
- `src/tax/vat-declaration.ts` — `breakdown` + `reconciles`, breakdown in `toEdsXml`.
- `web/app/api/bills/route.ts`, `web/app/api/parties/route.ts`, `web/app/api/parties/[id]/route.ts` — pass the new fields.
- `web/app/(cabinet)/bills/*`, `web/app/(cabinet)/invoices/new/*`, `web/app/(cabinet)/parties/*` — the form controls.
- `web/app/lib/i18n.ts` — new keys in LV/RU/EN.

---

### Task 1: Migration 046 + the category vocabulary

**Files:**
- Create: `migrations/046_vat_categories.sql`
- Create: `src/tax/categories.ts`
- Test: `tests/tax/categories.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `VatCategory`, `VAT_CATEGORIES`, `isVatCategory`, `chargesVat`, `selfAssesses`, `inEcsl`, `ecslSupplyType`, `exemptionReasonFor`, `selfAssessedVatCents`, `DocumentSide`, `categoryIssues(line, side?)` — every later task depends on these exact names. `categoryIssues` defaults to `'sales'`; the bills and credit-note schemas pass `'purchase'`.

- [ ] **Step 1: Write the failing test**

`tests/tax/categories.test.ts` (pure — no DB, no `resetDb`):

```ts
import { expect, test } from 'vitest';
import {
  VAT_CATEGORIES, isVatCategory, chargesVat, selfAssesses, inEcsl, ecslSupplyType,
  exemptionReasonFor, selfAssessedVatCents, categoryIssues,
} from '../../src/tax/categories.js';

test('the code list is exactly the EN 16931 subset we support', () => {
  expect([...VAT_CATEGORIES]).toEqual(['S', 'Z', 'E', 'AE', 'K', 'G', 'O']);
  expect(isVatCategory('S')).toBe(true);
  expect(isVatCategory('X')).toBe(false);
});

test('only standard-rated lines charge VAT', () => {
  expect(chargesVat('S')).toBe(true);
  for (const c of ['Z', 'E', 'AE', 'K', 'G', 'O'] as const) expect(chargesVat(c)).toBe(false);
});

test('reverse charge and intra-Community acquisitions self-assess', () => {
  expect(selfAssesses('AE')).toBe(true);
  expect(selfAssesses('K')).toBe(true);
  expect(selfAssesses('S')).toBe(false);
  expect(selfAssesses('E')).toBe(false);
});

test('ECSL covers AE and K, split goods vs services by category', () => {
  expect(inEcsl('K')).toBe(true);
  expect(inEcsl('AE')).toBe(true);
  expect(inEcsl('S')).toBe(false);
  expect(ecslSupplyType('K')).toBe('goods');
  expect(ecslSupplyType('AE')).toBe('services');
  expect(ecslSupplyType('S')).toBe(null);
});

test('exemption reasons follow the BR-*-10 rules; S and Z need none', () => {
  expect(exemptionReasonFor('S')).toBe(null);
  expect(exemptionReasonFor('Z')).toBe(null);
  expect(exemptionReasonFor('K')).toEqual({ code: 'VATEX-EU-IC', text: 'Intra-Community supply' });
  expect(exemptionReasonFor('AE')).toEqual({ text: 'Reverse charge' });
  expect(exemptionReasonFor('E')?.code).toBe('VATEX-EU-132');
  expect(exemptionReasonFor('G')?.code).toBe('VATEX-EU-147');
  expect(exemptionReasonFor('O')?.text).toBe('Not subject to VAT');
});

test('self-assessed VAT rounds half-up per line', () => {
  expect(selfAssessedVatCents(100000n, 21)).toBe(21000n);
  expect(selfAssessedVatCents(1n, 21)).toBe(0n);       // 0.21 cents -> 0
  expect(selfAssessedVatCents(3n, 21)).toBe(1n);       // 0.63 cents -> 1
  expect(selfAssessedVatCents(10050n, 12)).toBe(1206n);
  expect(selfAssessedVatCents(100000n, 0)).toBe(0n);
});

test('categoryIssues enforces rate/VAT consistency per category', () => {
  expect(categoryIssues({ vatCategory: 'S', vatRate: 21, vatCents: 2100n })).toEqual([]);
  expect(categoryIssues({ vatCategory: 'S', vatRate: 0, vatCents: 0n })[0]).toContain('BR-S-5');
  expect(categoryIssues({ vatCategory: 'K', vatRate: 21, vatCents: 2100n })[0]).toContain('BR-IC-8');
  expect(categoryIssues({ vatCategory: 'E', vatRate: 21, vatCents: 0n })[0]).toContain('BR-E-5');
  expect(categoryIssues({ vatCategory: 'Z', vatRate: 0, vatCents: 100n })[0]).toContain('BR-Z-8');
});

test('a sales-side reverse-charge or intra-EU line must carry a zero rate (BR-AE-5, BR-IC-5)', () => {
  // The customer applies their own domestic rate; it is never transmitted on the invoice.
  expect(categoryIssues({ vatCategory: 'AE', vatRate: 0, vatCents: 0n }, 'sales')).toEqual([]);
  expect(categoryIssues({ vatCategory: 'K', vatRate: 0, vatCents: 0n }, 'sales')).toEqual([]);
  expect(categoryIssues({ vatCategory: 'AE', vatRate: 21, vatCents: 0n }, 'sales')[0]).toContain('BR-AE-5');
  expect(categoryIssues({ vatCategory: 'K', vatRate: 21, vatCents: 0n }, 'sales')[0]).toContain('BR-IC-5');
});

test('a purchase-side reverse-charge line must carry the domestic rate it self-assesses at', () => {
  // Our own bill record, not a wire document: the vendor invoices 0%, we supply the LV rate.
  expect(categoryIssues({ vatCategory: 'AE', vatRate: 21, vatCents: 0n }, 'purchase')).toEqual([]);
  expect(categoryIssues({ vatCategory: 'K', vatRate: 21, vatCents: 0n }, 'purchase')).toEqual([]);
  expect(categoryIssues({ vatCategory: 'AE', vatRate: 0, vatCents: 0n }, 'purchase')[0]).toContain('BR-AE-5');
});

test('sales is the default side', () => {
  expect(categoryIssues({ vatCategory: 'AE', vatRate: 21, vatCents: 0n }))
    .toEqual(categoryIssues({ vatCategory: 'AE', vatRate: 21, vatCents: 0n }, 'sales'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tax/categories.test.ts`
Expected: FAIL — `Cannot find module '../../src/tax/categories.js'`.

- [ ] **Step 3: Write the migration**

`migrations/046_vat_categories.sql`:

```sql
-- M9 slice A: EN 16931 VAT categories on document lines.
-- Sales documents had no line rows at all (einvoices stored only ubl_xml + totals), so the
-- sales side gets a real line table here. cn_code / net_mass_kg are Intrastat (slice C) and
-- are deliberately unused by slice A+B — they land now so slice C needs no migration on
-- these hot tables.

CREATE TABLE einvoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  einvoice_id uuid NOT NULL REFERENCES einvoices(id),
  line_no int NOT NULL,
  description text NOT NULL,
  net_cents bigint NOT NULL,
  vat_rate numeric NOT NULL,
  vat_cents bigint NOT NULL,
  vat_category text NOT NULL CHECK (vat_category IN ('S','Z','E','AE','K','G','O')),
  cn_code text,
  net_mass_kg numeric
);
CREATE INDEX einvoice_lines_einvoice_idx ON einvoice_lines(einvoice_id);
CREATE INDEX einvoice_lines_client_category_idx ON einvoice_lines(client_company_id, vat_category);

ALTER TABLE einvoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE einvoice_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY einvoice_lines_tenant_isolation ON einvoice_lines
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
GRANT SELECT, INSERT ON einvoice_lines TO bookkeeping_app;

ALTER TABLE bill_lines ADD COLUMN vat_category text NOT NULL DEFAULT 'S'
  CHECK (vat_category IN ('S','Z','E','AE','K','G','O'));
ALTER TABLE bill_lines ADD COLUMN vat_deductible boolean NOT NULL DEFAULT true;
ALTER TABLE bill_lines ADD COLUMN cn_code text;
ALTER TABLE bill_lines ADD COLUMN net_mass_kg numeric;

-- ECSL reports per member state, and reverse-charge eligibility is a country question.
-- Not derived from the vat_no prefix: vat_no is nullable and often blank on existing rows.
ALTER TABLE parties ADD COLUMN country_code char(2) NOT NULL DEFAULT 'LV';
```

- [ ] **Step 4: Apply the migration**

Run: `docker compose up -d db && npm run migrate`
Expected: applies cleanly, no error. Re-run it once more — migrations are idempotent, so the second run must also succeed without re-applying.

- [ ] **Step 5: Write `src/tax/categories.ts`**

```ts
/**
 * EN 16931 VAT category codes (BT-151, UNCL5305 subset) and every rule derived from them.
 * Pure — no DB, no side effects — so both the domain and the UBL layer can share it.
 */
export type VatCategory = 'S' | 'Z' | 'E' | 'AE' | 'K' | 'G' | 'O';

/** S standard · Z zero-rated · E exempt · AE reverse charge · K intra-Community · G export · O out of scope. */
export const VAT_CATEGORIES: readonly VatCategory[] = ['S', 'Z', 'E', 'AE', 'K', 'G', 'O'];

export function isVatCategory(v: string): v is VatCategory {
  return (VAT_CATEGORIES as readonly string[]).includes(v);
}

/** Only a standard-rated line charges VAT to the counterparty. */
export function chargesVat(cat: VatCategory): boolean {
  return cat === 'S';
}

/** On the purchase side, AE and K mean the buyer self-assesses the VAT. */
export function selfAssesses(cat: VatCategory): boolean {
  return cat === 'AE' || cat === 'K';
}

/** Sales in these categories belong on the EC Sales List (PVN 2). */
export function inEcsl(cat: VatCategory): boolean {
  return cat === 'AE' || cat === 'K';
}

/**
 * An intra-EU goods supply is categorised K; an intra-EU B2B service where the customer
 * accounts for the VAT is AE. The category therefore carries the ECSL supply type and no
 * separate goods/services column is needed.
 */
export function ecslSupplyType(cat: VatCategory): 'goods' | 'services' | null {
  if (cat === 'K') return 'goods';
  if (cat === 'AE') return 'services';
  return null;
}

export interface ExemptionReason { code?: string; text: string }

/**
 * BT-120 (reason code) / BT-121 (reason text). S needs none; Z needs none either
 * (BR-Z requires a zero rate, not a reason).
 */
export function exemptionReasonFor(cat: VatCategory): ExemptionReason | null {
  switch (cat) {
    case 'S': return null;
    case 'Z': return null;
    case 'E': return { code: 'VATEX-EU-132', text: 'Exempt supply' };
    case 'AE': return { text: 'Reverse charge' };
    case 'K': return { code: 'VATEX-EU-IC', text: 'Intra-Community supply' };
    case 'G': return { code: 'VATEX-EU-147', text: 'Export outside the EU' };
    case 'O': return { text: 'Not subject to VAT' };
  }
}

/**
 * Self-assessed VAT for one line: net × rate, half-up to the cent. Same arithmetic as
 * the inbound per-line derivation in src/einvoice/inbound.ts, kept in one place.
 */
export function selfAssessedVatCents(netCents: bigint, vatRate: number): bigint {
  const rateBp = BigInt(Math.round(vatRate * 100)); // 21 -> 2100 basis points
  return (netCents * rateBp + 5000n) / 10000n;
}

/**
 * Which side of the trade a line sits on. The two differ on ONE point: what VAT rate an
 * AE/K line carries.
 *
 * - `'sales'` is a wire document. BR-AE-5 / BR-IC-5 require the invoiced rate to be 0:
 *   the customer accounts for the VAT at *their* domestic rate, which is never
 *   transmitted on the invoice.
 * - `'purchase'` is our own bill record. The vendor invoiced 0%, so the domestic rate we
 *   self-assess at has to be supplied locally — buildBillEntry multiplies by it.
 */
export type DocumentSide = 'sales' | 'purchase';

/**
 * Consistency rules between a line's category, its rate, and its *invoiced* VAT.
 * Returns EN 16931-flavoured issue strings; empty means consistent. Shared by the zod
 * schemas (bills, credit notes — `'purchase'`) and validateEn16931 (`'sales'`).
 */
export function categoryIssues(
  line: { vatCategory: VatCategory; vatRate: number; vatCents: bigint },
  side: DocumentSide = 'sales',
): string[] {
  const issues: string[] = [];
  const { vatCategory: cat, vatRate: rate, vatCents: vat } = line;

  if (cat === 'S') {
    if (!(rate > 0)) issues.push('BR-S-5: a standard-rated line requires a VAT rate greater than zero');
    return issues;
  }

  // Every non-standard category invoices zero VAT.
  if (vat !== 0n) {
    const rule = cat === 'K' ? 'BR-IC-8' : cat === 'AE' ? 'BR-AE-8' : `BR-${cat}-8`;
    issues.push(`${rule}: a '${cat}' line must carry zero invoiced VAT`);
  }

  if (selfAssesses(cat)) {
    const rule = cat === 'K' ? 'BR-IC-5' : 'BR-AE-5';
    if (side === 'sales' && rate !== 0) {
      issues.push(`${rule}: a sales '${cat}' line must have a zero VAT rate — the customer accounts for the VAT at their own domestic rate`);
    }
    if (side === 'purchase' && !(rate > 0)) {
      issues.push(`${rule}: a purchase '${cat}' line requires the domestic VAT rate used for self-assessment`);
    }
  } else if (rate !== 0) {
    issues.push(`BR-${cat}-5: a '${cat}' line must have a zero VAT rate`);
  }
  return issues;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/tax/categories.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 7: Verify the migration numbering guard still passes**

Run: `npx vitest run tests/db/migration-numbering.test.ts`
Expected: PASS — `046` collides with nothing.

- [ ] **Step 8: Commit**

```bash
git add migrations/046_vat_categories.sql src/tax/categories.ts tests/tax/categories.test.ts
git commit -m "feat(tax): VAT category vocabulary + migration 046 (einvoice_lines, bill_lines categories)

Claude-Session: https://claude.ai/code/session_01BQ5EiunbJpf7XY9Bge3gB1"
```

---

### Task 2: UBL — emit BT-151 and per-category TaxSubtotal, parse it back

**Files:**
- Modify: `src/einvoice/ubl.ts`
- Test: `tests/einvoice/ubl-categories.test.ts`

**Interfaces:**
- Consumes: `VatCategory`, `exemptionReasonFor`, `isVatCategory` from Task 1.
- Produces: `InvoiceLineIn.vatCategory?: VatCategory` (optional, defaults to `'S'`); `categoryTotals(lines): CategoryTotal[]` exported for tests; `parseUblInvoice` / `parseUblCreditNote` now fill `vatCategory` per line.

This is the conformance fix: `<cac:ClassifiedTaxCategory>` currently ships `Percent` + `TaxScheme` with **no `<cbc:ID>`**, which is mandatory (BT-151) in Peppol BIS 3.0, and `<cac:TaxTotal>` has no `TaxSubtotal` at all.

- [ ] **Step 1: Write the failing test**

`tests/einvoice/ubl-categories.test.ts` (pure):

```ts
import { expect, test } from 'vitest';
import { buildUblInvoice, buildUblCreditNote, parseUblInvoice, parseUblCreditNote, categoryTotals, type EInvoice } from '../../src/einvoice/ubl.js';

const base: EInvoice = {
  invoiceNumber: 'INV-1', issueDate: '2026-06-10', currency: 'EUR',
  supplier: { name: 'SIA Pardevejs', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'OU Ostja', regNo: '11111111', vatNo: 'EE101010101' },
  lines: [
    // A sales AE/K line carries rate 0 on the wire (BR-AE-5 / BR-IC-5).
    { description: 'Consulting', net: '1000.00', vatRate: 0, vat: '0.00', vatCategory: 'AE' },
    { description: 'Local part', net: '100.00', vatRate: 21, vat: '21.00', vatCategory: 'S' },
  ],
  netTotal: '1100.00', vatTotal: '21.00', grandTotal: '1121.00',
};

test('every line carries the mandatory BT-151 category code', () => {
  const xml = buildUblInvoice(base);
  expect(xml).toContain('<cac:ClassifiedTaxCategory><cbc:ID>AE</cbc:ID>');
  expect(xml).toContain('<cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID>');
});

test('a line with no explicit category defaults to standard rate', () => {
  const xml = buildUblInvoice({ ...base, lines: [{ description: 'X', net: '10.00', vatRate: 21, vat: '2.10' }], netTotal: '10.00', vatTotal: '2.10', grandTotal: '12.10' });
  expect(xml).toContain('<cbc:ID>S</cbc:ID>');
});

test('categoryTotals groups by category and rate, preserving first-seen order', () => {
  expect(categoryTotals(base.lines)).toEqual([
    { category: 'AE', rate: 0, taxableCents: 100000n, taxCents: 0n },
    { category: 'S', rate: 21, taxableCents: 10000n, taxCents: 2100n },
  ]);
});

test('TaxTotal carries one TaxSubtotal per category with its exemption reason', () => {
  const xml = buildUblInvoice(base);
  expect(xml).toContain('<cbc:TaxableAmount currencyID="EUR">1000.00</cbc:TaxableAmount>');
  expect(xml).toContain('<cbc:TaxExemptionReason>Reverse charge</cbc:TaxExemptionReason>');
  expect(xml).toContain('<cbc:TaxableAmount currencyID="EUR">100.00</cbc:TaxableAmount>');
  // The document-level TaxAmount is unchanged and still the invoiced total.
  expect(xml).toContain('<cac:TaxTotal>\n    <cbc:TaxAmount currencyID="EUR">21.00</cbc:TaxAmount>');
  // Exactly two subtotals.
  expect(xml.match(/<cac:TaxSubtotal>/g)?.length).toBe(2);
});

test('an intra-Community supply emits the VATEX-EU-IC reason code at a zero rate', () => {
  const xml = buildUblInvoice({
    ...base,
    lines: [{ description: 'Goods', net: '500.00', vatRate: 0, vat: '0.00', vatCategory: 'K' }],
    netTotal: '500.00', vatTotal: '0.00', grandTotal: '500.00',
  });
  expect(xml).toContain('<cbc:TaxExemptionReasonCode>VATEX-EU-IC</cbc:TaxExemptionReasonCode>');
  expect(xml).toContain('<cbc:ID>K</cbc:ID>\n        <cbc:Percent>0</cbc:Percent>');
});

test('the category round-trips through the parser', () => {
  const parsed = parseUblInvoice(buildUblInvoice(base));
  expect(parsed.lines.map((l) => l.vatCategory)).toEqual(['AE', 'S']);
  expect(parsed.lines[0]!.vatRate).toBe(0);   // a wire AE line carries no rate
  expect(parsed.lines[1]!.vatRate).toBe(21);
});

test('a missing or unknown category parses as standard rate', () => {
  const legacy = buildUblInvoice(base).replace('<cbc:ID>AE</cbc:ID>', '<cbc:ID>QQ</cbc:ID>');
  expect(parseUblInvoice(legacy).lines[0]!.vatCategory).toBe('S');
});

test('credit notes get the same treatment', () => {
  const xml = buildUblCreditNote({ ...base, correctedInvoiceNumber: 'INV-0' });
  expect(xml).toContain('<cac:ClassifiedTaxCategory><cbc:ID>AE</cbc:ID>');
  expect(xml.match(/<cac:TaxSubtotal>/g)?.length).toBe(2);
  expect(parseUblCreditNote(xml).lines.map((l) => l.vatCategory)).toEqual(['AE', 'S']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/einvoice/ubl-categories.test.ts`
Expected: FAIL — `categoryTotals` is not exported and no `<cbc:ID>` is emitted.

- [ ] **Step 3: Add the type field and the grouping helper to `src/einvoice/ubl.ts`**

Extend the line interface (import `VatCategory` and friends at the top of the file):

```ts
import { type VatCategory, exemptionReasonFor, isVatCategory } from '../tax/categories.js';
import { toCents, fromCents } from '../db/money.js';

export interface InvoiceLineIn {
  description: string; net: string; vatRate: number; vat: string;
  /** BT-151. Optional so stored recurring-template payloads stay valid; absent means 'S'. */
  vatCategory?: VatCategory;
}
```

Add the grouping helper next to the builders:

```ts
export interface CategoryTotal { category: VatCategory; rate: number; taxableCents: bigint; taxCents: bigint }

/** Group lines by (category, rate) into BG-23 tax subtotals, preserving first-seen order. */
export function categoryTotals(lines: InvoiceLineIn[]): CategoryTotal[] {
  const order: string[] = [];
  const acc = new Map<string, CategoryTotal>();
  for (const l of lines) {
    const category = l.vatCategory ?? 'S';
    const key = `${category}|${l.vatRate}`;
    let row = acc.get(key);
    if (!row) {
      row = { category, rate: l.vatRate, taxableCents: 0n, taxCents: 0n };
      acc.set(key, row);
      order.push(key);
    }
    row.taxableCents += toCents(l.net);
    row.taxCents += toCents(l.vat);
  }
  return order.map((k) => acc.get(k)!);
}

function taxSubtotal(t: CategoryTotal, cur: string): string {
  const reason = exemptionReasonFor(t.category);
  return [
    `    <cac:TaxSubtotal>`,
    `      <cbc:TaxableAmount currencyID="${cur}">${fromCents(t.taxableCents)}</cbc:TaxableAmount>`,
    `      <cbc:TaxAmount currencyID="${cur}">${fromCents(t.taxCents)}</cbc:TaxAmount>`,
    `      <cac:TaxCategory>`,
    `        <cbc:ID>${t.category}</cbc:ID>`,
    `        <cbc:Percent>${t.rate}</cbc:Percent>`,
    reason?.code ? `        <cbc:TaxExemptionReasonCode>${escapeXml(reason.code)}</cbc:TaxExemptionReasonCode>` : null,
    reason ? `        <cbc:TaxExemptionReason>${escapeXml(reason.text)}</cbc:TaxExemptionReason>` : null,
    `        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>`,
    `      </cac:TaxCategory>`,
    `    </cac:TaxSubtotal>`,
  ].filter(Boolean).join('\n');
}
```

The child order inside `TaxCategory` (ID, Percent, TaxExemptionReasonCode, TaxExemptionReason, TaxScheme) is the UBL schema sequence — do not reorder it.

- [ ] **Step 4: Emit the category on lines and the subtotals in TaxTotal**

In `buildUblInvoice`, replace the `ClassifiedTaxCategory` line with:

```ts
    `      <cac:ClassifiedTaxCategory><cbc:ID>${l.vatCategory ?? 'S'}</cbc:ID><cbc:Percent>${l.vatRate}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item>`,
```

and replace the single-line `TaxTotal` with:

```ts
    `  <cac:TaxTotal>`,
    `    <cbc:TaxAmount currencyID="${cur}">${inv.vatTotal}</cbc:TaxAmount>`,
    categoryTotals(inv.lines).map((t) => taxSubtotal(t, cur)).join('\n'),
    `  </cac:TaxTotal>`,
```

Apply the identical two changes in `buildUblCreditNote` (same `ClassifiedTaxCategory` string, same `TaxTotal` block over `cn.lines`).

- [ ] **Step 5: Parse the category back**

In both `parseUblInvoice` and `parseUblCreditNote`, the line mapper reads the category next to the percent:

```ts
    lines: asArray(inv.InvoiceLine).map((l: Record<string, unknown>) => {
      const ctc = (l.Item as { ClassifiedTaxCategory?: { Percent?: unknown; ID?: unknown } })?.ClassifiedTaxCategory;
      const rawCat = ctc?.ID === undefined ? '' : String(ctc.ID);
      return {
        description: String((l.Item as { Name?: string })?.Name ?? ''),
        net: txt(l.LineExtensionAmount),
        vatRate: Number(ctc?.Percent ?? 0),
        vat: '0',
        vatCategory: isVatCategory(rawCat) ? rawCat : ('S' as const),
      };
    }),
```

(In `parseUblCreditNote` the array is `cn.CreditNoteLine` — otherwise identical.)

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/einvoice/ubl-categories.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 7: Run the existing UBL and einvoice suites for regressions**

Run: `npx vitest run tests/einvoice`
Expected: PASS. If `tests/einvoice/ubl.test.ts` asserts the old single-line `TaxTotal` string, update that assertion to the new structure — the old form was non-conformant.

- [ ] **Step 8: Commit**

```bash
git add src/einvoice/ubl.ts tests/einvoice/ubl-categories.test.ts tests/einvoice/ubl.test.ts
git commit -m "fix(einvoice): emit mandatory BT-151 category code + per-category TaxSubtotal

Every invoice we emitted failed Peppol BIS 3.0 validation: ClassifiedTaxCategory
carried Percent and TaxScheme but no cbc:ID, and TaxTotal had no TaxSubtotal.
The parser now round-trips the category so inbound bills arrive classified.

Claude-Session: https://claude.ai/code/session_01BQ5EiunbJpf7XY9Bge3gB1"
```

---

### Task 3: EN 16931 category business rules

**Files:**
- Modify: `src/einvoice/validate.ts`
- Test: `tests/einvoice/validate.test.ts` (extend)

**Interfaces:**
- Consumes: `categoryIssues`, `exemptionReasonFor` (Task 1); `InvoiceLineIn.vatCategory` (Task 2).
- Produces: no new exports — `validateEn16931` gains rules. It is already called first in `sendInvoice` / `sendCreditNote`.

- [ ] **Step 1: Write the failing test**

Append to `tests/einvoice/validate.test.ts`:

```ts
import { validateEn16931 } from '../../src/einvoice/validate.js';
import type { EInvoice } from '../../src/einvoice/ubl.js';

const ok: EInvoice = {
  invoiceNumber: 'INV-9', issueDate: '2026-06-10', currency: 'EUR',
  supplier: { name: 'SIA A', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'OU B', regNo: '11111111', vatNo: 'EE101010101' },
  lines: [{ description: 'Goods', net: '500.00', vatRate: 0, vat: '0.00', vatCategory: 'K' }],
  netTotal: '500.00', vatTotal: '0.00', grandTotal: '500.00',
};

test('an intra-Community supply is valid with a customer VAT id', () => {
  expect(validateEn16931(ok).valid).toBe(true);
});

test('BR-IC-5: a sales intra-Community line may not carry a VAT rate', () => {
  const bad: EInvoice = {
    ...ok,
    lines: [{ description: 'Goods', net: '500.00', vatRate: 21, vat: '0.00', vatCategory: 'K' }],
  };
  expect(validateEn16931(bad).issues.join(' ')).toContain('BR-IC-5');
});

test('BR-IC-1: an intra-Community supply requires a customer VAT identifier', () => {
  const bad = { ...ok, customer: { ...ok.customer, vatNo: '' } };
  const r = validateEn16931(bad);
  expect(r.valid).toBe(false);
  expect(r.issues.join(' ')).toContain('BR-IC-1');
});

test('a reverse-charge line may not carry VAT', () => {
  const bad: EInvoice = {
    ...ok,
    lines: [{ description: 'Svc', net: '100.00', vatRate: 21, vat: '21.00', vatCategory: 'AE' }],
    netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
  };
  expect(validateEn16931(bad).issues.join(' ')).toContain('BR-AE-8');
});

test('a standard-rated line needs a nonzero rate', () => {
  const bad: EInvoice = {
    ...ok,
    lines: [{ description: 'X', net: '100.00', vatRate: 0, vat: '0.00', vatCategory: 'S' }],
    netTotal: '100.00', vatTotal: '0.00', grandTotal: '100.00',
  };
  expect(validateEn16931(bad).issues.join(' ')).toContain('BR-S-5');
});

test('BR-CO-14: the VAT total must equal the sum of the category subtotals', () => {
  const bad: EInvoice = {
    ...ok,
    lines: [{ description: 'X', net: '100.00', vatRate: 21, vat: '21.00', vatCategory: 'S' }],
    netTotal: '100.00', vatTotal: '20.00', grandTotal: '120.00',
  };
  expect(validateEn16931(bad).issues.join(' ')).toContain('BR-CO-14');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/einvoice/validate.test.ts`
Expected: FAIL — the BR-IC-1 / BR-AE-8 / BR-S-5 / BR-CO-14 assertions find no such issues.

- [ ] **Step 3: Add the rules**

In `src/einvoice/validate.ts`, after the existing checks and before the `return`:

```ts
  // Per-line category consistency. 'sales' — this is a wire document, so an AE/K line
  // must carry a zero rate (BR-AE-5 / BR-IC-5); the purchase side passes 'purchase'.
  for (const [i, l] of inv.lines.entries()) {
    for (const issue of categoryIssues({ vatCategory: l.vatCategory ?? 'S', vatRate: l.vatRate, vatCents: toCents(l.vat) }, 'sales')) {
      issues.push(`line ${i + 1}: ${issue}`);
    }
  }

  // BR-IC-1 / BR-AE-1: a supply where the customer accounts for the VAT requires the
  // customer's VAT identifier — without it the supply cannot be reported or justified.
  const needsCustomerVat = inv.lines.some((l) => l.vatCategory === 'K' || l.vatCategory === 'AE');
  if (needsCustomerVat && !inv.customer.vatNo) {
    issues.push('BR-IC-1: an intra-Community supply or reverse-charge line requires the customer VAT identifier');
  }

  // BR-CO-14: the invoice VAT total must equal the sum of the per-category VAT amounts.
  const categoryVat = sumCents(inv.lines.map((l) => l.vat));
  if (categoryVat !== toCents(inv.vatTotal)) {
    issues.push('BR-CO-14: the VAT total must equal the sum of the category VAT amounts');
  }
```

Add the imports: `import { categoryIssues } from '../tax/categories.js';` and extend the existing money import to `import { toCents, sumCents } from '../db/money.js';`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/einvoice/validate.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full einvoice suite**

Run: `npx vitest run tests/einvoice`
Expected: PASS — existing fixtures have no `vatCategory`, so they default to `'S'` at a nonzero rate and stay valid.

- [ ] **Step 6: Commit**

```bash
git add src/einvoice/validate.ts tests/einvoice/validate.test.ts
git commit -m "feat(einvoice): EN 16931 category rules (BR-IC-1, BR-AE-8, BR-S-5, BR-CO-14)

Claude-Session: https://claude.ai/code/session_01BQ5EiunbJpf7XY9Bge3gB1"
```

---

### Task 4: Persist outbound document lines

**Files:**
- Create: `src/einvoice/lines.ts`
- Modify: `src/einvoice/outbound.ts`
- Test: `tests/einvoice/einvoice-lines.test.ts`

**Interfaces:**
- Consumes: `InvoiceLineIn` (Task 2); `einvoice_lines` (Task 1).
- Produces: `insertEinvoiceLines(tx, ctx, einvoiceId, lines): Promise<void>` and `listEinvoiceLines(tx, ctx, einvoiceId): Promise<EinvoiceLineRow[]>` with `EinvoiceLineRow = { lineNo: number; description: string; netCents: string; vatRate: string; vatCents: string; vatCategory: VatCategory }`. Task 9 reads `einvoice_lines` directly in SQL; nothing else writes it.

- [ ] **Step 1: Write the failing test**

`tests/einvoice/einvoice-lines.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { sendInvoice, sendCreditNote } from '../../src/einvoice/outbound.js';
import { listEinvoiceLines } from '../../src/einvoice/lines.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import type { EInvoice } from '../../src/einvoice/ubl.js';

const accounts = { receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721' };

const invoice: EInvoice = {
  invoiceNumber: 'INV-100', issueDate: '2026-06-15', currency: 'EUR',
  supplier: { name: 'SIA A', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'OU B', regNo: '11111111', vatNo: 'EE101010101' },
  lines: [
    { description: 'Goods to EE', net: '500.00', vatRate: 0, vat: '0.00', vatCategory: 'K' },
    { description: 'Domestic', net: '100.00', vatRate: 21, vat: '21.00', vatCategory: 'S' },
  ],
  netTotal: '600.00', vatTotal: '21.00', grandTotal: '621.00',
};

async function seed(t: { firmId: string; clientCompanyId: string }) {
  await withTenant(ctx(t), async (tx) => {
    for (const [code, name, type] of [
      ['2310', 'Receivables', 'asset'], ['6110', 'Sales', 'income'], ['5721', 'Output VAT', 'liability'],
    ] as const) await createAccount(tx, ctx(t), { code, name, type });
    await openPeriod(tx, ctx(t), { year: 2026, month: 6 });
  });
}

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('sendInvoice persists one categorised line row per invoice line', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  const { einvoiceId } = await withTenant(ctx(t), (tx) =>
    sendInvoice(tx, ctx(t), { invoice, recipientPeppolId: '0088:ee', ap: new StubAccessPoint(), ...accounts }));

  const lines = await withTenant(ctx(t), (tx) => listEinvoiceLines(tx, ctx(t), einvoiceId));
  expect(lines.map((l) => [l.lineNo, l.vatCategory, l.netCents, l.vatCents]))
    .toEqual([[1, 'K', '50000', '0'], [2, 'S', '10000', '2100']]);
});

test('a line with no explicit category persists as standard rate', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  const plain: EInvoice = {
    ...invoice, invoiceNumber: 'INV-101',
    lines: [{ description: 'X', net: '100.00', vatRate: 21, vat: '21.00' }],
    netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
  };
  const { einvoiceId } = await withTenant(ctx(t), (tx) =>
    sendInvoice(tx, ctx(t), { invoice: plain, recipientPeppolId: '0088:ee', ap: new StubAccessPoint(), ...accounts }));
  const lines = await withTenant(ctx(t), (tx) => listEinvoiceLines(tx, ctx(t), einvoiceId));
  expect(lines[0]!.vatCategory).toBe('S');
});

test('sendCreditNote persists its lines too', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  const { einvoiceId } = await withTenant(ctx(t), (tx) =>
    sendCreditNote(tx, ctx(t), {
      creditNote: { ...invoice, invoiceNumber: 'CN-1' },
      recipientPeppolId: '0088:ee', ap: new StubAccessPoint(), ...accounts,
    }));
  const lines = await withTenant(ctx(t), (tx) => listEinvoiceLines(tx, ctx(t), einvoiceId));
  expect(lines.length).toBe(2);
  expect(lines[0]!.vatCategory).toBe('K');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/einvoice/einvoice-lines.test.ts`
Expected: FAIL — `Cannot find module '../../src/einvoice/lines.js'`.

- [ ] **Step 3: Write `src/einvoice/lines.ts`**

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import type { InvoiceLineIn } from './ubl.js';
import type { VatCategory } from '../tax/categories.js';
import { toCents } from '../db/money.js';

export interface EinvoiceLineRow {
  lineNo: number; description: string;
  netCents: string; vatRate: string; vatCents: string; vatCategory: VatCategory;
}

/**
 * Persist the line detail of an OUTBOUND einvoice. Inbound documents already land as
 * bill_lines via receiveInboundInvoices — writing both would double-count the purchase
 * side of the VAT breakdown, so this is only ever called on the outbound path.
 */
export async function insertEinvoiceLines(
  tx: PoolClient, ctx: TenantContext, einvoiceId: string, lines: InvoiceLineIn[],
): Promise<void> {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    await tx.query(
      `INSERT INTO einvoice_lines(client_company_id, einvoice_id, line_no, description, net_cents, vat_rate, vat_cents, vat_category)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ctx.clientCompanyId, einvoiceId, i + 1, l.description,
        toCents(l.net).toString(), l.vatRate, toCents(l.vat).toString(), l.vatCategory ?? 'S'],
    );
  }
}

export async function listEinvoiceLines(
  tx: PoolClient, ctx: TenantContext, einvoiceId: string,
): Promise<EinvoiceLineRow[]> {
  const res = await tx.query(
    `SELECT line_no AS "lineNo", description, net_cents::text AS "netCents",
            vat_rate::text AS "vatRate", vat_cents::text AS "vatCents", vat_category AS "vatCategory"
     FROM einvoice_lines WHERE einvoice_id = $1 AND client_company_id = $2 ORDER BY line_no`,
    [einvoiceId, ctx.clientCompanyId],
  );
  return res.rows;
}
```

- [ ] **Step 4: Call it from both outbound paths**

In `src/einvoice/outbound.ts`, add `import { insertEinvoiceLines } from './lines.js';` and insert one call in each function immediately after `const einvoiceId = res.rows[0].id as string;`:

```ts
  await insertEinvoiceLines(tx, ctx, einvoiceId, inv.lines);
```

and in `sendCreditNote`:

```ts
  await insertEinvoiceLines(tx, ctx, einvoiceId, cn.lines);
```

Place both **before** the `appendAudit` call so a failed line insert rolls the whole document back.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/einvoice/einvoice-lines.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Check the recurring-invoice path still works**

Run: `npx vitest run tests/recurring tests/einvoice`
Expected: PASS — recurring generation calls `sendInvoice`, so its invoices now persist lines too, with `'S'` defaults from the stored jsonb payload.

- [ ] **Step 7: Commit**

```bash
git add src/einvoice/lines.ts src/einvoice/outbound.ts tests/einvoice/einvoice-lines.test.ts
git commit -m "feat(einvoice): persist outbound line detail into einvoice_lines

Claude-Session: https://claude.ai/code/session_01BQ5EiunbJpf7XY9Bge3gB1"
```

---

### Task 5: Reverse-charge self-assessment on bills

**Files:**
- Modify: `src/payables/bills.ts`
- Modify: `web/app/api/bills/route.ts` (new required account)
- Test: `tests/payables/bills-reverse-charge.test.ts`

**Interfaces:**
- Consumes: `selfAssesses`, `selfAssessedVatCents`, `categoryIssues`, `VatCategory` (Task 1).
- Produces: `NewBillLine` gains `vatCategory?: VatCategory` (default `'S'`) and `vatDeductible?: boolean` (default `true`); `BillAccounts` gains a **required** `vatOutputAccount: string`; `BillDetail.lines[]` gains `vatCategory` and `vatDeductible`. Task 6 (`credit-notes.ts`) and Task 7 (`inbound.ts`) both depend on the new `BillAccounts` shape.

- [ ] **Step 1: Write the failing test**

`tests/payables/bills-reverse-charge.test.ts`:

```ts
import { expect, test } from 'vitest';
import { buildBillEntry, type NewBill } from '../../src/payables/bills.js';

const accounts = { vatInputAccount: '5722', vatOutputAccount: '5721', payablesAccount: '5310' };

const base: Omit<NewBill, 'lines'> = {
  vendorPartyId: '00000000-0000-0000-0000-000000000001',
  billNumber: 'B-1', issueDate: '2026-06-10', dueDate: '2026-07-10', currency: 'EUR',
};

function totals(entry: { lines: { accountCode: string; debit: string; credit: string }[] }) {
  const d = entry.lines.reduce((a, l) => a + Number(l.debit), 0);
  const c = entry.lines.reduce((a, l) => a + Number(l.credit), 0);
  return { debit: d.toFixed(2), credit: c.toFixed(2) };
}

test('a domestic standard-rated bill posts exactly as before', () => {
  const e = buildBillEntry({ ...base, lines: [
    { description: 'Goods', expenseAccount: '7710', net: '100.00', vatRate: 21, vat: '21.00' },
  ] }, accounts);
  expect(e.lines).toEqual([
    { accountCode: '7710', debit: '100.00', credit: '0', description: 'Goods' },
    { accountCode: '5722', debit: '21.00', credit: '0', description: 'VAT input' },
    { accountCode: '5310', debit: '0', credit: '121.00', description: 'Payable' },
  ]);
});

test('a deductible reverse-charge line self-assesses both legs and nets to zero VAT', () => {
  const e = buildBillEntry({ ...base, lines: [
    { description: 'EU service', expenseAccount: '7710', net: '1000.00', vatRate: 21, vat: '0.00', vatCategory: 'AE' },
  ] }, accounts);
  expect(e.lines).toEqual([
    { accountCode: '7710', debit: '1000.00', credit: '0', description: 'EU service' },
    { accountCode: '5722', debit: '210.00', credit: '0', description: 'VAT input' },
    { accountCode: '5310', debit: '0', credit: '1000.00', description: 'Payable' },
    { accountCode: '5721', debit: '0', credit: '210.00', description: 'Reverse-charge output VAT' },
  ]);
  expect(totals(e)).toEqual({ debit: '1210.00', credit: '1210.00' });
});

test('a non-deductible reverse-charge line capitalises the VAT into the expense', () => {
  const e = buildBillEntry({ ...base, lines: [
    { description: 'Representation', expenseAccount: '7730', net: '1000.00', vatRate: 21, vat: '0.00', vatCategory: 'AE', vatDeductible: false },
  ] }, accounts);
  expect(e.lines).toEqual([
    { accountCode: '7730', debit: '1210.00', credit: '0', description: 'Representation' },
    { accountCode: '5310', debit: '0', credit: '1000.00', description: 'Payable' },
    { accountCode: '5721', debit: '0', credit: '210.00', description: 'Reverse-charge output VAT' },
  ]);
  expect(totals(e)).toEqual({ debit: '1210.00', credit: '1210.00' });
});

test('an intra-Community acquisition of goods self-assesses like AE', () => {
  const e = buildBillEntry({ ...base, lines: [
    { description: 'EU goods', expenseAccount: '7710', net: '500.00', vatRate: 21, vat: '0.00', vatCategory: 'K' },
  ] }, accounts);
  expect(e.lines.find((l) => l.accountCode === '5721')?.credit).toBe('105.00');
  expect(e.lines.find((l) => l.accountCode === '5722')?.debit).toBe('105.00');
});

test('a mixed bill combines invoiced and self-assessed input VAT into one line', () => {
  const e = buildBillEntry({ ...base, lines: [
    { description: 'Domestic', expenseAccount: '7710', net: '100.00', vatRate: 21, vat: '21.00' },
    { description: 'EU service', expenseAccount: '7710', net: '200.00', vatRate: 21, vat: '0.00', vatCategory: 'AE' },
  ] }, accounts);
  expect(e.lines.find((l) => l.accountCode === '5722')?.debit).toBe('63.00'); // 21 invoiced + 42 self-assessed
  expect(e.lines.find((l) => l.accountCode === '5721')?.credit).toBe('42.00');
  expect(e.lines.find((l) => l.accountCode === '5310')?.credit).toBe('321.00'); // net 300 + invoiced VAT 21
  expect(totals(e)).toEqual({ debit: '384.00', credit: '384.00' });
});

test('an exempt line posts net with no VAT legs at all', () => {
  const e = buildBillEntry({ ...base, lines: [
    { description: 'Exempt', expenseAccount: '7710', net: '100.00', vatRate: 0, vat: '0.00', vatCategory: 'E' },
  ] }, accounts);
  expect(e.lines).toEqual([
    { accountCode: '7710', debit: '100.00', credit: '0', description: 'Exempt' },
    { accountCode: '5310', debit: '0', credit: '100.00', description: 'Payable' },
  ]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/payables/bills-reverse-charge.test.ts`
Expected: FAIL — `vatOutputAccount` is not in `BillAccounts` and the AE cases post no VAT legs.

- [ ] **Step 3: Extend the types and the zod schema in `src/payables/bills.ts`**

```ts
import { type VatCategory, VAT_CATEGORIES, selfAssesses, selfAssessedVatCents, categoryIssues } from '../tax/categories.js';

export interface NewBillLine {
  description: string; expenseAccount: string; net: string; vatRate: number; vat: string;
  /** BT-151; absent means 'S'. */
  vatCategory?: VatCategory;
  /** Self-assessed VAT on an AE/K line is deductible unless this is explicitly false. */
  vatDeductible?: boolean;
}
export interface BillAccounts { vatInputAccount: string; vatOutputAccount: string; payablesAccount: string; }
```

In `newBillSchema`, extend the line object and add the consistency refinement alongside the existing negative-amount one:

```ts
  lines: z.array(z.object({
    description: z.string().min(1),
    expenseAccount: z.string().min(1),
    net: z.string().regex(/^-?\d+(\.\d{1,2})?$/),
    vatRate: z.number(),
    vat: z.string().regex(/^-?\d+(\.\d{1,2})?$/),
    vatCategory: z.enum(VAT_CATEGORIES as unknown as [VatCategory, ...VatCategory[]]).optional(),
    vatDeductible: z.boolean().optional(),
  }).refine((l) => toCents(l.net) >= 0n && toCents(l.vat) >= 0n, {
    // Credit notes (negative net/VAT) are out of scope for M2 (see M7). Without this,
    // buildBillEntry's `vat > 0n` guard drops the VAT line for negative-VAT bills while
    // still crediting payables for the full (negative) grand total, producing an
    // unbalanced entry that postEntry rejects with a confusing "does not balance" error.
    message: 'Negative amounts are not supported (credit notes are out of scope — see M7)',
  }).refine(
    // 'purchase': the vendor invoiced 0% on an AE/K line, so OUR record must carry the
    // domestic rate we self-assess at. The sales side requires the opposite (rate 0).
    (l) => categoryIssues({ vatCategory: l.vatCategory ?? 'S', vatRate: l.vatRate, vatCents: toCents(l.vat) }, 'purchase').length === 0,
    (l) => ({ message: categoryIssues({ vatCategory: l.vatCategory ?? 'S', vatRate: l.vatRate, vatCents: toCents(l.vat) }, 'purchase').join('; ') }),
  )).min(1),
```

Extend `BillDetail`:

```ts
export interface BillDetail extends BillRow {
  lines: {
    lineNo: number; description: string; expenseAccount: string;
    netCents: string; vatRate: string; vatCents: string;
    vatCategory: VatCategory; vatDeductible: boolean;
  }[];
}
```

- [ ] **Step 4: Rewrite `buildBillEntry`**

```ts
/**
 * DR each line's expense account, DR VAT-input (invoiced + deductible self-assessed),
 * CR payables (net + *invoiced* VAT — a reverse-charge line invoices nothing), and
 * CR VAT-output for self-assessed reverse-charge / intra-Community VAT.
 *
 * A non-deductible self-assessed line debits its expense account with net + the
 * self-assessed VAT instead of debiting VAT-input: non-deductible VAT is part of the cost.
 */
export function buildBillEntry(bill: NewBill, accounts: BillAccounts): NewJournalEntry {
  const invoicedVat = sumCents(bill.lines.map((l) => l.vat));
  const grand = sumCents(bill.lines.map((l) => l.net)) + invoicedVat;

  const lines: { accountCode: string; debit: string; credit: string; description: string }[] = [];
  let selfAssessedTotal = 0n;
  let selfAssessedDeductible = 0n;

  for (const l of bill.lines) {
    const category = l.vatCategory ?? 'S';
    if (!selfAssesses(category)) {
      lines.push({ accountCode: l.expenseAccount, debit: l.net, credit: '0', description: l.description });
      continue;
    }
    const assessed = selfAssessedVatCents(toCents(l.net), l.vatRate);
    selfAssessedTotal += assessed;
    if (l.vatDeductible === false) {
      lines.push({ accountCode: l.expenseAccount, debit: fromCents(toCents(l.net) + assessed), credit: '0', description: l.description });
    } else {
      selfAssessedDeductible += assessed;
      lines.push({ accountCode: l.expenseAccount, debit: l.net, credit: '0', description: l.description });
    }
  }

  const inputVat = invoicedVat + selfAssessedDeductible;
  if (inputVat > 0n) lines.push({ accountCode: accounts.vatInputAccount, debit: fromCents(inputVat), credit: '0', description: 'VAT input' });
  lines.push({ accountCode: accounts.payablesAccount, debit: '0', credit: fromCents(grand), description: 'Payable' });
  if (selfAssessedTotal > 0n) lines.push({ accountCode: accounts.vatOutputAccount, debit: '0', credit: fromCents(selfAssessedTotal), description: 'Reverse-charge output VAT' });

  return { date: bill.issueDate, memo: `Bill ${bill.billNumber}`, currency: bill.currency, lines };
}
```

- [ ] **Step 5: Persist and read back the new columns**

In `createBill`, extend the line insert:

```ts
    await tx.query(
      `INSERT INTO bill_lines(client_company_id, bill_id, line_no, description, expense_account, net_cents, vat_rate, vat_cents, vat_category, vat_deductible)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [ctx.clientCompanyId, billId, i + 1, l.description, l.expenseAccount,
        toCents(l.net).toString(), l.vatRate, toCents(l.vat).toString(),
        l.vatCategory ?? 'S', l.vatDeductible ?? true],
    );
```

In `getBill`, extend the line select:

```ts
    `SELECT line_no AS "lineNo", description, expense_account AS "expenseAccount",
            net_cents::text AS "netCents", vat_rate::text AS "vatRate", vat_cents::text AS "vatCents",
            vat_category AS "vatCategory", vat_deductible AS "vatDeductible"
     FROM bill_lines WHERE bill_id = $1 AND client_company_id = $2 ORDER BY line_no`,
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/payables/bills-reverse-charge.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 7: Fix every `BillAccounts` construction site**

Run: `npx tsc --noEmit` and `grep -rn "vatInputAccount" src/ web/app tests/ --include=*.ts --include=*.tsx`
Every object literal built as `BillAccounts` now needs `vatOutputAccount`. In `web/app/api/bills/route.ts` add a route-level env constant next to the existing ones:

```ts
const VAT_OUTPUT_ACCOUNT = process.env.BILL_VAT_OUTPUT_ACCOUNT ?? '5721';
```

and pass `vatOutputAccount: VAT_OUTPUT_ACCOUNT`. Do the same for any other route or handler that builds `BillAccounts` (check `web/app/api/documents/capture/route.ts` and `src/api/capture-handler.ts`), and add `vatOutputAccount: '5721'` to the test fixtures the compiler flags.

- [ ] **Step 8: Run the payables and api suites**

Run: `npx vitest run tests/payables tests/api`
Expected: PASS — existing bills default to `'S'` and post byte-identically to before (first test in Step 1 asserts exactly that).

- [ ] **Step 9: Commit**

```bash
git add src/payables/bills.ts web/app/api/bills/route.ts tests/payables/bills-reverse-charge.test.ts
git add -u
git commit -m "feat(payables): self-assess reverse-charge VAT on bills, honouring line deductibility

Claude-Session: https://claude.ai/code/session_01BQ5EiunbJpf7XY9Bge3gB1"
```

---

### Task 6: Vendor credit notes — the same treatment, reversed

**Files:**
- Modify: `src/payables/credit-notes.ts`
- Test: `tests/payables/credit-notes.test.ts` (extend)

**Interfaces:**
- Consumes: everything from Task 5, including the new `BillAccounts.vatOutputAccount`.
- Produces: the vendor-credit-note line type gains the same optional `vatCategory` / `vatDeductible`; its entry builder mirrors `buildBillEntry` with debits and credits swapped.

- [ ] **Step 1: Read the current implementation**

Run: `sed -n '1,120p' src/payables/credit-notes.ts`
Note the exact name of the entry builder and its line type — the steps below refer to them as *the credit-note entry builder* and *the credit-note line type*.

- [ ] **Step 2: Write the failing test**

Append to `tests/payables/credit-notes.test.ts`:

```ts
test('a reverse-charge vendor credit note reverses both self-assessed legs', async () => {
  const t = await makeFirmAndClient();
  await seed(t);   // reuse the file's existing seed helper
  const { creditNoteId } = await withTenant(ctx(t), (tx) => createVendorCreditNote(tx, ctx(t), {
    vendorPartyId: t.vendorPartyId, creditNoteNumber: 'VCN-RC-1', issueDate: '2026-06-20',
    currency: 'EUR', correctedBillNumber: null,
    lines: [{ description: 'EU service credit', expenseAccount: '7710', net: '1000.00', vatRate: 21, vat: '0.00', vatCategory: 'AE' }],
  }, { vatInputAccount: '5722', vatOutputAccount: '5721', payablesAccount: '5310' }));

  const detail = await withTenant(ctx(t), (tx) => getVendorCreditNote(tx, ctx(t), creditNoteId));
  expect(detail.lines[0]!.vatCategory).toBe('AE');

  // The proposal payload is the reversal: CR expense 1000, CR input VAT 210, DR payables 1000, DR output VAT 210.
  const payload = detail.postingPayload;
  expect(payload.lines.find((l) => l.accountCode === '5722')?.credit).toBe('210.00');
  expect(payload.lines.find((l) => l.accountCode === '5721')?.debit).toBe('210.00');
  expect(payload.lines.find((l) => l.accountCode === '5310')?.debit).toBe('1000.00');
});
```

Adjust the helper names (`seed`, `getVendorCreditNote`, `detail.postingPayload`) to whatever the file already uses — read it in Step 1 and match, rather than inventing new accessors. If the existing test file reads the proposal payload via `getProposal`, do the same here.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/payables/credit-notes.test.ts`
Expected: FAIL — the AE line produces no VAT legs.

- [ ] **Step 4: Mirror the Task 5 logic**

In `src/payables/credit-notes.ts`:
1. Add `vatCategory?: VatCategory` and `vatDeductible?: boolean` to the credit-note line type, plus the same two zod fields and the same `categoryIssues(..., 'purchase')` refinement used in Task 5 — a vendor credit note is a purchase-side record, so an AE/K line carries the domestic rate it self-assesses at.
2. In the entry builder, walk the lines exactly as `buildBillEntry` does, but emit each amount on the opposite side: a deductible self-assessed line becomes `CR expense net`, `CR vatInputAccount assessed`, `DR payables net`, `DR vatOutputAccount assessed`; a non-deductible one becomes `CR expense (net + assessed)`, `DR payables net`, `DR vatOutputAccount assessed`.
3. Persist `vat_category` / `vat_deductible` in the credit-note line insert and select them back in the detail reader, matching Task 5's SQL.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/payables/credit-notes.test.ts`
Expected: PASS, including the pre-existing credit-note tests.

- [ ] **Step 6: Confirm the VAT netting still holds**

Run: `npx vitest run tests/tax/credit-note-vat.test.ts`
Expected: PASS — `computeVat` nets both directions per VAT account (fixed in M7), and self-assessed reversals are ordinary debits/credits on those same accounts.

- [ ] **Step 7: Commit**

```bash
git add src/payables/credit-notes.ts tests/payables/credit-notes.test.ts
git commit -m "feat(payables): reverse self-assessed VAT on vendor credit notes

Claude-Session: https://claude.ai/code/session_01BQ5EiunbJpf7XY9Bge3gB1"
```

---

### Task 7: Inbound Peppol — carry the category into bill lines

**Files:**
- Modify: `src/einvoice/inbound.ts`
- Test: `tests/einvoice/inbound.test.ts` (extend)

**Interfaces:**
- Consumes: parsed `vatCategory` (Task 2); `NewBillLine.vatCategory` (Task 5); `chargesVat` / `selfAssesses` (Task 1); `getTaxRate` from `src/tax/rules.js`.
- Produces: no new exports. `reconciledLineVatCents` becomes category-aware — it distributes the vendor's declared VAT total across **charging lines only** — and the invoice branch substitutes the client's domestic rate on self-assessing lines.

Two problems to solve here:

1. `reconciledLineVatCents` currently spreads the declared VAT total across every line and dumps the rounding remainder on the last one. On a mixed invoice (one standard line, one reverse-charge line) that would assign VAT to a line that must carry none.
2. **A vendor's AE/K line legitimately arrives at rate 0** — BR-AE-5 / BR-IC-5 forbid the supplier from stating a rate, because the *buyer* applies their own domestic rate. So the parsed rate cannot be stored as-is: `buildBillEntry` multiplies `vat_rate` by the net to self-assess, and a zero rate would silently self-assess nothing. The inbound path must substitute the client's domestic standard rate (`getTaxRate(tx, 'vat_standard_rate', issueDate)`) on every self-assessing line. This is also why `categoryIssues` takes a side: the same line is rate-0 on the wire and rate-21 in our books.

- [ ] **Step 1: Write the failing test**

Append to `tests/einvoice/inbound.test.ts` — build a two-line inbound UBL where one line is `AE` and one is `S`, feed it through `receiveInboundInvoices` with a `StubAccessPoint` primed with that XML, then assert:

```ts
test('a mixed inbound invoice keeps VAT off the reverse-charge line', async () => {
  const t = await makeFirmAndClient();
  await seed(t);   // reuse this file's existing seed helper
  const xml = buildUblInvoice({
    invoiceNumber: 'IN-MIX-1', issueDate: '2026-06-12', currency: 'EUR',
    supplier: { name: 'OU Vendor', regNo: '11111111', vatNo: 'EE101010101' },
    customer: { name: 'SIA Us', regNo: '40100000000', vatNo: 'LV40100000000' },
    lines: [
      // The vendor states no rate on the reverse-charge line — that is the conformant form.
      { description: 'EU service', net: '200.00', vatRate: 0, vat: '0.00', vatCategory: 'AE' },
      { description: 'Domestic goods', net: '100.00', vatRate: 21, vat: '21.00', vatCategory: 'S' },
    ],
    netTotal: '300.00', vatTotal: '21.00', grandTotal: '321.00',
  });
  const ap = new StubAccessPoint([{ ublXml: xml, messageId: 'm1' }]);

  const { billIds } = await withTenant(ctx(t), (tx) => receiveInboundInvoices(tx, ctx(t), {
    ap, template, accounts: { vatInputAccount: '5722', vatOutputAccount: '5721', payablesAccount: '5310' },
  }));

  const bill = await withTenant(ctx(t), (tx) => getBill(tx, ctx(t), billIds[0]!));
  expect(bill.lines.map((l) => [l.vatCategory, l.vatCents])).toEqual([['AE', '0'], ['S', '2100']]);
});

test('an inbound reverse-charge line is stored at the domestic rate so it self-assesses', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  const xml = buildUblInvoice({
    invoiceNumber: 'IN-RC-1', issueDate: '2026-06-12', currency: 'EUR',
    supplier: { name: 'OU Vendor', regNo: '11111111', vatNo: 'EE101010101' },
    customer: { name: 'SIA Us', regNo: '40100000000', vatNo: 'LV40100000000' },
    lines: [{ description: 'EU service', net: '1000.00', vatRate: 0, vat: '0.00', vatCategory: 'AE' }],
    netTotal: '1000.00', vatTotal: '0.00', grandTotal: '1000.00',
  });
  const { billIds } = await withTenant(ctx(t), (tx) => receiveInboundInvoices(tx, ctx(t), {
    ap: new StubAccessPoint([{ ublXml: xml, messageId: 'm2' }]),
    template, accounts: { vatInputAccount: '5722', vatOutputAccount: '5721', payablesAccount: '5310' },
  }));

  const bill = await withTenant(ctx(t), (tx) => getBill(tx, ctx(t), billIds[0]!));
  // Stored at the LV standard rate (21 from tax_rules), not the vendor's 0.
  expect(bill.lines[0]!.vatRate).toBe('21');
  expect(bill.lines[0]!.vatCents).toBe('0');       // nothing was invoiced
  expect(bill.grandTotalCents).toBe('100000');     // the vendor is paid net
});
```

Match the file's existing `StubAccessPoint` construction — read `src/einvoice/access-point.ts` for how canned messages are supplied.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/einvoice/inbound.test.ts`
Expected: FAIL — the AE line receives a share of the declared VAT.

- [ ] **Step 3: Make the per-line split category-aware**

Replace `reconciledLineVatCents` in `src/einvoice/inbound.ts`:

```ts
// UBL invoice lines carry a VAT *rate* (Percent) but not a per-line VAT amount, so
// parseUblInvoice cannot fill it in (it always reports '0'). Derive per-line VAT from
// net × rate for the lines that actually charge VAT — a reverse-charge, exempt, or
// intra-Community line carries none, and the buyer self-assesses it at posting time
// instead (see buildBillEntry). THEN reconcile the sum to the vendor's declared
// vatTotal: per-line rounding can drift a cent or two from the vendor's total-level
// rounding, and the bill's totals (Σ net + Σ vat) must match the einvoice row we write
// from toCents(ubl.grandTotal). The whole remainder lands on the LAST CHARGING line, so
// Σ(line vat) == toCents(ubl.vatTotal) exactly without polluting a zero-VAT category.
function reconciledLineVatCents(
  lines: { net: string; vatRate: number; vatCategory?: VatCategory }[], vatTotal: string,
): bigint[] {
  const charging = lines.map((l) => chargesVat(l.vatCategory ?? 'S'));
  const per = lines.map((l, i) =>
    charging[i] ? (toCents(l.net) * BigInt(Math.round(l.vatRate * 100)) + 5000n) / 10000n : 0n);
  const lastCharging = charging.lastIndexOf(true);
  if (lastCharging === -1) return per;   // nothing charges VAT — declared total must be zero
  const remainder = toCents(vatTotal) - per.reduce((a, c) => a + c, 0n);
  per[lastCharging] = per[lastCharging]! + remainder;
  return per;
}
```

Add `import { chargesVat, selfAssesses, type VatCategory } from '../tax/categories.js';` and `import { getTaxRate } from '../tax/rules.js';`.

- [ ] **Step 4: Pass the category through, substituting the domestic rate where we self-assess**

Add a small helper next to `reconciledLineVatCents`:

```ts
/**
 * The VAT rate to STORE for a parsed line. A conformant supplier states no rate on an
 * AE/K line (BR-AE-5 / BR-IC-5) because the buyer applies their own — so we substitute
 * the client's domestic standard rate, which is what buildBillEntry self-assesses at.
 * Every other category keeps the rate the supplier stated.
 */
function storedVatRate(line: { vatRate: number; vatCategory?: VatCategory }, domesticRate: number): number {
  return selfAssesses(line.vatCategory ?? 'S') ? domesticRate : line.vatRate;
}
```

In both the invoice and credit-note branches of `receiveInboundInvoices`, read the domestic rate once per document (it is date-effective) and use it in the line mapper:

```ts
      const domesticRate = Number((await getTaxRate(tx, 'vat_standard_rate', cn.issueDate)).value);
      ...
        lines: cn.lines.map((l, i) => ({
          description: l.description, expenseAccount: args.template.expenseAccount,
          net: l.net, vatRate: storedVatRate(l, domesticRate), vat: fromCents(lineVat[i]!),
          vatCategory: l.vatCategory ?? 'S',
        })),
```

Apply the same two additions in the invoice branch (using that branch's issue date). `reconciledLineVatCents` still runs on the **parsed** lines, before substitution — it only derives VAT for charging lines, and substitution never touches those.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/einvoice/inbound.test.ts tests/einvoice/credit-note-inbound.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the peppol adoption suite**

Run: `npx vitest run tests/payables/peppol-adopt.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/einvoice/inbound.ts tests/einvoice/inbound.test.ts
git commit -m "feat(einvoice): route inbound VAT categories into bill lines, split VAT only across charging lines

Claude-Session: https://claude.ai/code/session_01BQ5EiunbJpf7XY9Bge3gB1"
```

---

### Task 8: Party country code

**Files:**
- Modify: `src/parties/parties.ts`
- Modify: `web/app/api/parties/route.ts`, `web/app/api/parties/[id]/route.ts`
- Test: `tests/parties/country.test.ts`

**Interfaces:**
- Consumes: `parties.country_code` (Task 1).
- Produces: `countryCode` on the party create input (optional, defaults to `'LV'`), on the update input, and on every party row read. Task 9 of plan 2 (`ecsl.ts`) joins on it.

- [ ] **Step 1: Write the failing test**

`tests/parties/country.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createParty, getParty, updateParty } from '../../src/parties/parties.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('a party defaults to LV and round-trips an explicit country', async () => {
  const t = await makeFirmAndClient();
  const [lv, ee] = await withTenant(ctx(t), async (tx) => [
    await createParty(tx, ctx(t), { kind: 'customer', name: 'SIA Local', regNo: '40100000001' }),
    await createParty(tx, ctx(t), { kind: 'customer', name: 'OU Eesti', regNo: '11111111', vatNo: 'EE101010101', countryCode: 'EE' }),
  ]);
  const lvRow = await withTenant(ctx(t), (tx) => getParty(tx, ctx(t), lv.id));
  const eeRow = await withTenant(ctx(t), (tx) => getParty(tx, ctx(t), ee.id));
  expect(lvRow.countryCode).toBe('LV');
  expect(eeRow.countryCode).toBe('EE');
});

test('the country code is normalised to upper case and must be two letters', async () => {
  const t = await makeFirmAndClient();
  const p = await withTenant(ctx(t), (tx) => createParty(tx, ctx(t), { kind: 'customer', name: 'X', regNo: '40100000002', countryCode: 'ee' }));
  expect((await withTenant(ctx(t), (tx) => getParty(tx, ctx(t), p.id))).countryCode).toBe('EE');
  await expect(withTenant(ctx(t), (tx) => createParty(tx, ctx(t), { kind: 'customer', name: 'Y', regNo: '40100000003', countryCode: 'EST' })))
    .rejects.toThrow();
});

test('updateParty can change the country', async () => {
  const t = await makeFirmAndClient();
  const p = await withTenant(ctx(t), (tx) => createParty(tx, ctx(t), { kind: 'customer', name: 'Z', regNo: '40100000004' }));
  await withTenant(ctx(t), (tx) => updateParty(tx, ctx(t), p.id, { countryCode: 'LT' }));
  expect((await withTenant(ctx(t), (tx) => getParty(tx, ctx(t), p.id))).countryCode).toBe('LT');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/parties/country.test.ts`
Expected: FAIL — `countryCode` is neither accepted nor returned.

- [ ] **Step 3: Read the current module and add the field**

Run `cat src/parties/parties.ts`, then thread `countryCode` through exactly as `vatNo` and `iban` are already threaded: add it to the party interface and the zod schema as `z.string().length(2).transform((s) => s.toUpperCase()).optional()`, include `country_code` in the INSERT (defaulting to `'LV'` when absent), in the UPDATE builder, and in every `SELECT` column list as `country_code AS "countryCode"`. Match `updateParty`'s existing partial-update mechanics rather than inventing a new one.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/parties/country.test.ts tests/parties`
Expected: PASS.

- [ ] **Step 5: Accept it over HTTP**

In `web/app/api/parties/route.ts` (POST) and `web/app/api/parties/[id]/route.ts` (PATCH/POST), add `countryCode` to the destructured body type and pass it through to the domain call. Change nothing about the authz or error mapping.

- [ ] **Step 6: Typecheck both projects**

Run: `npx tsc --noEmit && cd web && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/parties/parties.ts web/app/api/parties tests/parties/country.test.ts
git commit -m "feat(parties): country code on customers and vendors (ECSL prerequisite)

Claude-Session: https://claude.ai/code/session_01BQ5EiunbJpf7XY9Bge3gB1"
```

---

### Task 9: Document-derived VAT breakdown

**Files:**
- Create: `src/tax/vat-breakdown.ts`
- Test: `tests/tax/vat-breakdown.test.ts`

**Interfaces:**
- Consumes: `einvoice_lines` (Tasks 1, 4); `bill_lines.vat_category` / `vat_deductible` (Tasks 1, 5).
- Produces: `vatBreakdown(tx, ctx, { fromDate, toDate }): Promise<VatBreakdown>` where `VatBreakdown = { rows: VatCategoryRow[]; documentOutputVatCents: string; documentInputVatCents: string }` and `VatCategoryRow = { category: VatCategory; salesNetCents: string; salesVatCents: string; purchaseNetCents: string; purchaseVatCents: string; selfAssessedVatCents: string; selfAssessedDeductibleCents: string }`. Task 10 and plan 2's tabular builder consume these names.

- [ ] **Step 1: Write the failing test**

`tests/tax/vat-breakdown.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { createParty } from '../../src/parties/parties.js';
import { sendInvoice } from '../../src/einvoice/outbound.js';
import { createBill } from '../../src/payables/bills.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { vatBreakdown } from '../../src/tax/vat-breakdown.js';
import type { EInvoice } from '../../src/einvoice/ubl.js';

const billAccounts = { vatInputAccount: '5722', vatOutputAccount: '5721', payablesAccount: '5310' };
const period = { fromDate: '2026-06-01', toDate: '2026-06-30' };

async function seed(t: { firmId: string; clientCompanyId: string }) {
  return withTenant(ctx(t), async (tx) => {
    for (const [code, name, type] of [
      ['2310', 'Receivables', 'asset'], ['6110', 'Sales', 'income'], ['7710', 'Expense', 'expense'],
      ['5721', 'Output VAT', 'liability'], ['5722', 'Input VAT', 'asset'], ['5310', 'Payables', 'liability'],
    ] as const) await createAccount(tx, ctx(t), { code, name, type });
    await openPeriod(tx, ctx(t), { year: 2026, month: 6 });
    const vendor = await createParty(tx, ctx(t), { kind: 'vendor', name: 'OU Vendor', regNo: '11111111', vatNo: 'EE101010101', countryCode: 'EE' });
    return vendor.id;
  });
}

function invoice(number: string, lines: EInvoice['lines'], net: string, vat: string, grand: string): EInvoice {
  return {
    invoiceNumber: number, issueDate: '2026-06-15', currency: 'EUR',
    supplier: { name: 'SIA A', regNo: '40100000000', vatNo: 'LV40100000000' },
    customer: { name: 'OU B', regNo: '11111111', vatNo: 'EE101010101' },
    lines, netTotal: net, vatTotal: vat, grandTotal: grand,
  };
}

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('aggregates sales and purchases per category', async () => {
  const t = await makeFirmAndClient();
  const vendorId = await seed(t);
  await withTenant(ctx(t), async (tx) => {
    await sendInvoice(tx, ctx(t), {
      invoice: invoice('S-1', [
        { description: 'Domestic', net: '100.00', vatRate: 21, vat: '21.00', vatCategory: 'S' },
        { description: 'EU goods', net: '500.00', vatRate: 0, vat: '0.00', vatCategory: 'K' },
      ], '600.00', '21.00', '621.00'),
      recipientPeppolId: '0088:ee', ap: new StubAccessPoint(),
      receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721',
    });
    await createBill(tx, ctx(t), {
      vendorPartyId: vendorId, billNumber: 'B-1', issueDate: '2026-06-16', dueDate: '2026-07-16', currency: 'EUR',
      lines: [
        { description: 'Domestic', expenseAccount: '7710', net: '200.00', vatRate: 21, vat: '42.00' },
        { description: 'EU service', expenseAccount: '7710', net: '1000.00', vatRate: 21, vat: '0.00', vatCategory: 'AE' },
        { description: 'Representation', expenseAccount: '7710', net: '100.00', vatRate: 21, vat: '0.00', vatCategory: 'AE', vatDeductible: false },
      ],
    }, billAccounts);
  });

  const b = await withTenant(ctx(t), (tx) => vatBreakdown(tx, ctx(t), period));
  const byCat = Object.fromEntries(b.rows.map((r) => [r.category, r]));

  expect(byCat.S!.salesNetCents).toBe('10000');
  expect(byCat.S!.salesVatCents).toBe('2100');
  expect(byCat.K!.salesNetCents).toBe('50000');
  expect(byCat.K!.salesVatCents).toBe('0');
  expect(byCat.S!.purchaseNetCents).toBe('20000');
  expect(byCat.S!.purchaseVatCents).toBe('4200');
  expect(byCat.AE!.purchaseNetCents).toBe('110000');
  expect(byCat.AE!.selfAssessedVatCents).toBe('23100');            // 210.00 + 21.00
  expect(byCat.AE!.selfAssessedDeductibleCents).toBe('21000');     // only the deductible line

  // Document-derived totals: output = sales VAT + all self-assessed; input = purchase VAT + deductible self-assessed.
  expect(b.documentOutputVatCents).toBe('25200');   // 2100 + 23100
  expect(b.documentInputVatCents).toBe('25200');    // 4200 + 21000
});

test('excludes documents outside the period', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  await withTenant(ctx(t), (tx) => sendInvoice(tx, ctx(t), {
    invoice: invoice('S-2', [{ description: 'X', net: '100.00', vatRate: 21, vat: '21.00', vatCategory: 'S' }], '100.00', '21.00', '121.00'),
    recipientPeppolId: '0088:ee', ap: new StubAccessPoint(),
    receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721',
  }));
  const b = await withTenant(ctx(t), (tx) => vatBreakdown(tx, ctx(t), { fromDate: '2026-07-01', toDate: '2026-07-31' }));
  expect(b.rows).toEqual([]);
  expect(b.documentOutputVatCents).toBe('0');
});

test('an empty period returns zeroed totals, not an error', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  const b = await withTenant(ctx(t), (tx) => vatBreakdown(tx, ctx(t), period));
  expect(b.rows).toEqual([]);
  expect(b.documentOutputVatCents).toBe('0');
  expect(b.documentInputVatCents).toBe('0');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tax/vat-breakdown.test.ts`
Expected: FAIL — `Cannot find module '../../src/tax/vat-breakdown.js'`.

- [ ] **Step 3: Write `src/tax/vat-breakdown.ts`**

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { VAT_CATEGORIES, type VatCategory } from './categories.js';

export interface VatCategoryRow {
  category: VatCategory;
  salesNetCents: string; salesVatCents: string;
  purchaseNetCents: string; purchaseVatCents: string;
  /** Self-assessed reverse-charge VAT on purchases, whether deductible or not. */
  selfAssessedVatCents: string;
  /** The deductible part of the above — what the input-VAT side of the return may claim. */
  selfAssessedDeductibleCents: string;
}

export interface VatBreakdown {
  rows: VatCategoryRow[];
  /** Σ sales VAT + Σ self-assessed VAT — the document-derived counterpart of the GL output total. */
  documentOutputVatCents: string;
  /** Σ purchase VAT + Σ deductible self-assessed VAT — the counterpart of the GL input total. */
  documentInputVatCents: string;
}

const ZERO: Omit<VatCategoryRow, 'category'> = {
  salesNetCents: '0', salesVatCents: '0', purchaseNetCents: '0', purchaseVatCents: '0',
  selfAssessedVatCents: '0', selfAssessedDeductibleCents: '0',
};

/**
 * Per-category VAT aggregation from the DOCUMENTS (outbound einvoice_lines + bill_lines),
 * as opposed to computeVat's authoritative sweep of the ledger. The two are compared in
 * assembleVatDeclaration to produce the `reconciles` indicator.
 *
 * Sales read outbound documents only: an inbound Peppol invoice is recorded both as an
 * einvoice row and as a bill, and only the bill carries its line detail — see
 * src/einvoice/lines.ts. Self-assessed VAT is rounded PER LINE (half-up), matching
 * selfAssessedVatCents so the aggregate agrees with what buildBillEntry posted.
 */
export async function vatBreakdown(
  tx: PoolClient, ctx: TenantContext, args: { fromDate: string; toDate: string },
): Promise<VatBreakdown> {
  const rows = new Map<VatCategory, VatCategoryRow>();
  const row = (category: VatCategory): VatCategoryRow => {
    let r = rows.get(category);
    if (!r) { r = { category, ...ZERO }; rows.set(category, r); }
    return r;
  };

  const sales = await tx.query(
    `SELECT el.vat_category AS "category",
            COALESCE(SUM(el.net_cents), 0)::text AS "netCents",
            COALESCE(SUM(el.vat_cents), 0)::text AS "vatCents"
     FROM einvoice_lines el
     JOIN einvoices e ON e.id = el.einvoice_id
     WHERE el.client_company_id = $1
       AND e.direction = 'outbound'
       AND e.issue_date BETWEEN $2 AND $3
     GROUP BY el.vat_category`,
    [ctx.clientCompanyId, args.fromDate, args.toDate],
  );
  for (const s of sales.rows) {
    const r = row(s.category as VatCategory);
    r.salesNetCents = s.netCents;
    r.salesVatCents = s.vatCents;
  }

  const purchases = await tx.query(
    `SELECT bl.vat_category AS "category",
            COALESCE(SUM(bl.net_cents), 0)::text AS "netCents",
            COALESCE(SUM(bl.vat_cents), 0)::text AS "vatCents",
            COALESCE(SUM(ROUND(bl.net_cents * bl.vat_rate / 100)), 0)::text AS "selfAssessed",
            COALESCE(SUM(CASE WHEN bl.vat_deductible THEN ROUND(bl.net_cents * bl.vat_rate / 100) ELSE 0 END), 0)::text AS "selfAssessedDeductible"
     FROM bill_lines bl
     JOIN bills b ON b.id = bl.bill_id
     WHERE bl.client_company_id = $1
       AND b.status <> 'void'
       AND b.issue_date BETWEEN $2 AND $3
     GROUP BY bl.vat_category`,
    [ctx.clientCompanyId, args.fromDate, args.toDate],
  );
  for (const p of purchases.rows) {
    const category = p.category as VatCategory;
    const r = row(category);
    r.purchaseNetCents = p.netCents;
    r.purchaseVatCents = p.vatCents;
    // Only AE/K self-assess; for every other category the rate-derived sum is noise.
    if (category === 'AE' || category === 'K') {
      r.selfAssessedVatCents = p.selfAssessed;
      r.selfAssessedDeductibleCents = p.selfAssessedDeductible;
    }
  }

  const ordered = VAT_CATEGORIES.filter((c) => rows.has(c)).map((c) => rows.get(c)!);
  const sum = (pick: (r: VatCategoryRow) => string): bigint =>
    ordered.reduce((a, r) => a + BigInt(pick(r)), 0n);

  return {
    rows: ordered,
    documentOutputVatCents: (sum((r) => r.salesVatCents) + sum((r) => r.selfAssessedVatCents)).toString(),
    documentInputVatCents: (sum((r) => r.purchaseVatCents) + sum((r) => r.selfAssessedDeductibleCents)).toString(),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/tax/vat-breakdown.test.ts`
Expected: PASS, 3 tests. If the `ROUND(...)` aggregate returns a decimal string (e.g. `'21000.0'`), cast it as `ROUND(...)::bigint` inside the `SUM` and re-run — `BigInt()` on a decimal string throws.

- [ ] **Step 5: Commit**

```bash
git add src/tax/vat-breakdown.ts tests/tax/vat-breakdown.test.ts
git commit -m "feat(tax): document-derived per-category VAT breakdown

Claude-Session: https://claude.ai/code/session_01BQ5EiunbJpf7XY9Bge3gB1"
```

---

### Task 10: Breakdown and reconciliation on the VAT declaration

**Files:**
- Modify: `src/tax/vat-declaration.ts`
- Test: `tests/tax/vat-reconciliation.test.ts`
- Test: `tests/tax/vat-declaration.test.ts` (extend)

**Interfaces:**
- Consumes: `vatBreakdown` (Task 9), `computeVat` (unchanged).
- Produces: `VatDeclaration` gains `breakdown: VatBreakdown` and `reconciles: boolean`; `toEdsXml` emits a `<CategoryBreakdown>` block. Plan 2's `/filings` route and tabular builder consume both.

- [ ] **Step 1: Write the failing test**

`tests/tax/vat-reconciliation.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { sendInvoice } from '../../src/einvoice/outbound.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { assembleVatDeclaration, toEdsXml } from '../../src/tax/vat-declaration.js';
import type { EInvoice } from '../../src/einvoice/ubl.js';

const config = { outputVatAccount: '5721', inputVatAccount: '5722' };
const period = { fromDate: '2026-06-01', toDate: '2026-06-30' };

const inv: EInvoice = {
  invoiceNumber: 'R-1', issueDate: '2026-06-10', currency: 'EUR',
  supplier: { name: 'SIA A', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'SIA B', regNo: '40200000000', vatNo: 'LV40200000000' },
  lines: [{ description: 'Domestic', net: '100.00', vatRate: 21, vat: '21.00', vatCategory: 'S' }],
  netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
};

async function seed(t: { firmId: string; clientCompanyId: string }) {
  await withTenant(ctx(t), async (tx) => {
    for (const [code, name, type] of [
      ['2310', 'Receivables', 'asset'], ['6110', 'Sales', 'income'],
      ['5721', 'Output VAT', 'liability'], ['5722', 'Input VAT', 'asset'],
    ] as const) await createAccount(tx, ctx(t), { code, name, type });
    await openPeriod(tx, ctx(t), { year: 2026, month: 6 });
  });
}

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('GL and documents agree when every entry came from a document', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  await withTenant(ctx(t), (tx) => sendInvoice(tx, ctx(t), {
    invoice: inv, recipientPeppolId: '0088:lv', ap: new StubAccessPoint(),
    receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721',
  }));
  const d = await withTenant(ctx(t), (tx) => assembleVatDeclaration(tx, ctx(t), { ...period, config }));
  expect(d.outputVat).toBe('21.00');
  expect(d.reconciles).toBe(true);
  expect(d.breakdown.rows.map((r) => r.category)).toEqual(['S']);
});

test('a manual journal entry on a VAT account flags a mismatch without throwing', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  await withTenant(ctx(t), (tx) => postEntry(tx, ctx(t), {
    date: '2026-06-20', memo: 'Manual VAT adjustment', currency: 'EUR',
    lines: [
      { accountCode: '2310', debit: '12.10', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '10.00' },
      { accountCode: '5721', debit: '0', credit: '2.10' },
    ],
  }));
  const d = await withTenant(ctx(t), (tx) => assembleVatDeclaration(tx, ctx(t), { ...period, config }));
  expect(d.outputVat).toBe('2.10');            // the ledger stays authoritative
  expect(d.breakdown.documentOutputVatCents).toBe('0');
  expect(d.reconciles).toBe(false);            // flagged, not thrown
});

test('the EDS XML carries the category breakdown', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  await withTenant(ctx(t), (tx) => sendInvoice(tx, ctx(t), {
    invoice: inv, recipientPeppolId: '0088:lv', ap: new StubAccessPoint(),
    receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721',
  }));
  const d = await withTenant(ctx(t), (tx) => assembleVatDeclaration(tx, ctx(t), { ...period, config }));
  const xml = toEdsXml(d);
  expect(xml).toContain('<CategoryBreakdown>');
  expect(xml).toContain('<Category code="S"');
  expect(xml).toContain('reconciles="true"');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tax/vat-reconciliation.test.ts`
Expected: FAIL — `reconciles` and `breakdown` do not exist.

- [ ] **Step 3: Extend `src/tax/vat-declaration.ts`**

```ts
import { vatBreakdown, type VatBreakdown } from './vat-breakdown.js';

export interface VatDeclaration {
  period: { fromDate: string; toDate: string };
  outputVat: string; inputVat: string; netPayable: string;
  ruleRef: TaxRate;
  /** Per-category detail derived from the documents (the ledger stays authoritative for the totals). */
  breakdown: VatBreakdown;
  /**
   * True when the GL totals equal the document-derived totals to the cent. False means
   * something reached a VAT account without a document behind it (typically a manual
   * journal entry) — surfaced as an indicator, never an error.
   */
  reconciles: boolean;
}

export async function assembleVatDeclaration(
  tx: PoolClient, ctx: TenantContext,
  args: { fromDate: string; toDate: string; config: VatConfig },
): Promise<VatDeclaration> {
  const v = await computeVat(tx, ctx, args);
  const ruleRef = await getTaxRate(tx, 'vat_standard_rate', args.toDate);
  const breakdown = await vatBreakdown(tx, ctx, { fromDate: args.fromDate, toDate: args.toDate });
  const reconciles =
    BigInt(v.outputVatCents) === BigInt(breakdown.documentOutputVatCents) &&
    BigInt(v.inputVatCents) === BigInt(breakdown.documentInputVatCents);

  return {
    period: { fromDate: args.fromDate, toDate: args.toDate },
    outputVat: centsToDecimal(v.outputVatCents),
    inputVat: centsToDecimal(v.inputVatCents),
    netPayable: centsToDecimal(v.netPayableCents),
    ruleRef, breakdown, reconciles,
  };
}
```

And in `toEdsXml`, before the closing `</VatDeclaration>`:

```ts
    `  <CategoryBreakdown reconciles="${d.reconciles}">`,
    ...d.breakdown.rows.map((r) =>
      `    <Category code="${r.category}" salesNet="${centsToDecimal(r.salesNetCents)}" salesVat="${centsToDecimal(r.salesVatCents)}" purchaseNet="${centsToDecimal(r.purchaseNetCents)}" purchaseVat="${centsToDecimal(r.purchaseVatCents)}" selfAssessedVat="${centsToDecimal(r.selfAssessedVatCents)}"/>`),
    `  </CategoryBreakdown>`,
```

The category codes are a fixed enum and the amounts are generated decimal strings, so no `escapeXml` is needed on them — unlike `ruleRef`, which stays escaped.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/tax/vat-reconciliation.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Run the whole tax suite plus the proposal path**

Run: `npx vitest run tests/tax`
Expected: PASS. `createVatDeclarationProposal` embeds the declaration as its payload, so `breakdown` and `reconciles` now ride along in the proposal — no change needed there.

- [ ] **Step 6: Commit**

```bash
git add src/tax/vat-declaration.ts tests/tax/vat-reconciliation.test.ts tests/tax/vat-declaration.test.ts
git commit -m "feat(tax): category breakdown + GL/document reconciliation flag on the VAT return

Claude-Session: https://claude.ai/code/session_01BQ5EiunbJpf7XY9Bge3gB1"
```

---

### Task 11: UI — category controls on the invoice composer, bill form, and party form

**Files:**
- Modify: `web/app/(cabinet)/invoices/new/page.tsx` (or the composer component it renders)
- Modify: `web/app/(cabinet)/bills/*` (the bill-entry form)
- Modify: `web/app/(cabinet)/parties/*` (the party form)
- Modify: `web/app/lib/i18n.ts`

**Interfaces:**
- Consumes: `VatCategory` + `VAT_CATEGORIES` (Task 1) via `@domain/tax/categories.js`; the API shapes from Tasks 5 and 8.
- Produces: no new domain exports. This task is the last of plan 1 — after it, a bookkeeper can actually classify a line.

- [ ] **Step 1: Find the forms**

Run: `ls web/app/\(cabinet\)/invoices/new web/app/\(cabinet\)/bills web/app/\(cabinet\)/parties && grep -rn "vatRate" web/app/\(cabinet\) | head -20`
Read each line editor before changing it, and match its existing state shape and styling (CSS modules, no inline styles).

- [ ] **Step 2: Add the i18n keys**

In `web/app/lib/i18n.ts`, add to the **EN** catalog and then the identical keys to LV and RU (the typed `Record<keyof typeof EN, string>` fails the build if either misses one):

```ts
  'vat.category': 'VAT treatment',
  'vat.category.S': 'Standard rate',
  'vat.category.Z': 'Zero-rated',
  'vat.category.E': 'Exempt',
  'vat.category.AE': 'Reverse charge',
  'vat.category.K': 'Intra-EU supply',
  'vat.category.G': 'Export outside the EU',
  'vat.category.O': 'Outside the scope of VAT',
  'vat.deductible': 'VAT deductible',
  'vat.selfAssessed': 'Self-assessed VAT',
  'party.countryCode': 'Country',
```

LV: `'VAT treatment'` → `'PVN režīms'`, `'Standard rate'` → `'Standarta likme'`, `'Zero-rated'` → `'Ar nulles likmi'`, `'Exempt'` → `'Atbrīvots'`, `'Reverse charge'` → `'Apgrieztā maksāšana'`, `'Intra-EU supply'` → `'ES iekšējā piegāde'`, `'Export outside the EU'` → `'Eksports ārpus ES'`, `'Outside the scope of VAT'` → `'Ārpus PVN darbības jomas'`, `'VAT deductible'` → `'PVN atskaitāms'`, `'Self-assessed VAT'` → `'Pašaprēķinātais PVN'`, `'Country'` → `'Valsts'`.

RU: `'Режим НДС'`, `'Стандартная ставка'`, `'Нулевая ставка'`, `'Освобождено'`, `'Обратное начисление'`, `'Поставка внутри ЕС'`, `'Экспорт за пределы ЕС'`, `'Вне сферы НДС'`, `'НДС к вычету'`, `'Самостоятельно начисленный НДС'`, `'Страна'`.

- [ ] **Step 3: Add the category select to the bill-entry line editor**

Each line gains a `<select>` bound to `vatCategory` (default `'S'`) whose options are `VAT_CATEGORIES` labelled via `t(\`vat.category.${c}\`)`. When the selected category self-assesses (`AE` / `K`), additionally render a `VAT deductible` checkbox bound to `vatDeductible` (default checked) and show the derived self-assessed amount as read-only text (`net × rate`, computed client-side for display only — the server recomputes it). When the category is not `S`, force the line's VAT amount input to `0.00` and disable it; when it is `Z`/`E`/`G`/`O`, force the rate to `0` as well. Post `vatCategory` and `vatDeductible` in the existing bills POST body.

- [ ] **Step 4: Add the same select to the invoice composer**

The composer builds an `EInvoice`; each line gains the same category select, writing `vatCategory` into the line object it already assembles. Apply the identical "non-standard category ⇒ VAT 0, and zero rate except AE/K" rule so the client cannot submit a shape `validateEn16931` will reject. No deductibility control here — deductibility is a purchase-side concept.

- [ ] **Step 5: Add the country field to the party form**

A two-letter country input (default `LV`, upper-cased on change) next to the existing VAT-number field, posted as `countryCode`.

- [ ] **Step 6: Typecheck and build the web project**

Run: `cd web && npx tsc --noEmit && npm run build`
Expected: clean typecheck; build succeeds. A missing i18n key in LV or RU fails here — that is the guard working.

- [ ] **Step 7: Exercise the flow in the running app**

Run: `npm run seed` (root), note the printed login + TOTP, then `cd web && npm run dev`. Sign in, and:
1. Create a vendor with country `EE` and an EE VAT number.
2. Enter a bill with one `Reverse charge` line (net 1000, rate 21) and approve it from the queue.
3. Open `/journal` and confirm the entry shows DR expense 1000, DR 5722 210, CR 5310 1000, CR 5721 210.

Expected: exactly those four lines. If the entry is unbalanced, stop and fix `buildBillEntry` — do not proceed.

- [ ] **Step 8: Full verification**

Run: `npm test` (root), then `npx tsc --noEmit` (root), then `cd web && npx tsc --noEmit`
Expected: all green. Record the test count.

- [ ] **Step 9: Commit**

```bash
git add web/app tests
git commit -m "feat(web): VAT category controls on the invoice composer, bill form, and party form

Claude-Session: https://claude.ai/code/session_01BQ5EiunbJpf7XY9Bge3gB1"
```

---

## Self-review — spec coverage

| Spec section | Task |
|---|---|
| §1 `einvoice_lines`, `bill_lines` columns, `parties.country_code` | 1 (migration), 4 (writer), 5 (bills), 8 (parties) |
| §1 `vat_settings`, `proposals` `ecsl` type | **plan 2** (migration `047`) |
| §2 category vocabulary + rules | 1 |
| §3 BT-151 emit/parse, `TaxSubtotal`, validation rules | 2, 3 |
| §4 reverse-charge posting, deductibility, credit notes | 5, 6 |
| §4 sales side needs no posting change | 4 (lines only) |
| §5 `vat-breakdown.ts` | 9 |
| §5 `reconciles` + breakdown on the declaration + `toEdsXml` | 10 |
| §5 `ecsl.ts`, `filing-periods.ts`, `nextWorkingDay` | **plan 2** |
| §6 `/filings` page, routes, authz, export | **plan 2** |
| §6 composer / bill / party form controls, i18n | 11 |
| §7 tests | every task |
| §7 demo seed data | **plan 2** |

Inbound category propagation (Task 7) is not a numbered spec section but follows from §3's "inbound bills arrive pre-classified" — without it the parsed category would be dropped on the floor.
