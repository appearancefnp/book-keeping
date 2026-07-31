# Design — M9 VAT completeness, slice A+B

Date: 2026-07-29. Roadmap row: `docs/ROADMAP-market-gaps.md` M9 (Tier 2). Covers **slice A**
(VAT category model + EN 16931 conformance fix + category-aware VAT return + reverse-charge
self-assessment) and **slice B** (EC Sales List / PVN 2 + filing periodicity). Intrastat is
slice C and is **not** in this spec.

## Why now

M9 is the only remaining gap that is legally mandatory rather than competitive: a VAT-registered
LV company trading inside the EU must file an EC Sales List. Three concrete defects motivate it:

1. **Cross-border VAT is silently wrong.** `computeVat` (`src/tax/vat-compute.ts`) is a two-account
   ledger sweep — output credits on `5721` minus input debits on `5722`. A reverse-charge purchase,
   an intra-EU 0% supply, and an exempt supply are indistinguishable from domestic 21%. There is no
   VAT category anywhere: `bill_lines` carries a bare `vat_rate numeric`, and sales documents carry
   no line rows at all.
2. **Every invoice we emit fails Peppol validation.** `src/einvoice/ubl.ts` writes
   `<cac:ClassifiedTaxCategory>` with `Percent` + `TaxScheme` but **no `<cbc:ID>`** — BT-151 is
   mandatory in EN 16931 / Peppol BIS 3.0. The parser (`parseUblInvoice`) reads only `Percent`, so
   inbound categories are lost too. This must be fixed before real Access Point connectivity
   (`HANDOFF §1`) lands.
3. **No filing surface exists.** The VAT return is only ever a `declaration` proposal in the
   approval queue; nobody can look up last quarter's filing.

## Decisions taken (and rejected alternatives)

| Decision | Chosen | Rejected |
|---|---|---|
| Where the VAT category lives | **Line-level everywhere** — new `einvoice_lines` table + `bill_lines.vat_category` | Document-level on `einvoices` (forces splitting mixed invoices, leaves Intrastat homeless); encoding treatment in dedicated account codes (deepens the account-mapping debt, and journal lines carry no party so per-counterparty ECSL would be impossible) |
| Source of truth for the return | **GL authoritative for money totals, documents for the category/partner breakdown, with a reconciliation indicator** | Documents authoritative (a manual JE on a VAT account would silently drop out of the return, and it breaks the house rule that the ledger is the record) |
| Reverse-charge posting | **Self-assess both legs at approval, honouring a per-line `vat_deductible` flag** mirroring `expense_claim_lines` | Always-fully-deductible (non-deductible reverse charge needs a manual JE); self-assess only at declaration time (contradicts GL-authoritative, understates both VAT accounts) |
| Filing surface | **New `/filings` page** with VAT return + EC Sales List tabs | Two more tabs on the eight-tab `/reports` page (a statutory filing has a due date, an approval state, and eventually a submission — it does not belong in a read-only reports surface); approval-queue-only (no way to review a past filing) |

## 1. Data model

Migration numbers: **`046`** (slice A) and **`047`** (slice B). Highest existing is `045`; per
`CLAUDE.md`, take max+1 across all files and never reuse — `tests/db/migration-numbering.test.ts`
fails the build on a new collision.

### `046_vat_categories.sql`

**`einvoice_lines`** (new) — the sales-side line rows that do not exist today:

```
id, client_company_id, einvoice_id, line_no, description,
net_cents bigint, vat_rate numeric, vat_cents bigint,
vat_category text NOT NULL CHECK (vat_category IN ('S','Z','E','AE','K','G','O')),
cn_code text,            -- Intrastat (slice C), unused here
net_mass_kg numeric      -- Intrastat (slice C), unused here
```

RLS + `FORCE ROW LEVEL SECURITY` + tenant-isolation policy + `GRANT SELECT, INSERT` to
`bookkeeping_app`, mirroring `bill_lines` in `030_bills.sql`. Index on `(einvoice_id)`.

Written **for outbound documents only.** Inbound Peppol invoices already land as `bill_lines` via
`receiveInboundInvoices`; writing both would double-count the purchase side of the breakdown. This
is a load-bearing invariant — the breakdown query filters `direction = 'outbound'` as a second
guard so a future inbound writer cannot silently corrupt the numbers.

**`bill_lines`** gains:

```
vat_category text NOT NULL DEFAULT 'S' CHECK (... same list ...)
vat_deductible boolean NOT NULL DEFAULT true
cn_code text, net_mass_kg numeric     -- Intrastat (slice C), unused here
```

**`parties`** gains `country_code char(2) NOT NULL DEFAULT 'LV'`. ECSL reports per member state,
and reverse-charge eligibility is a country question. Deliberately **not** derived from the `vat_no`
prefix: `vat_no` is nullable and frequently blank on existing rows.

Every existing row therefore reads as domestic, standard-rate, deductible. No backfill; no
behaviour change for any current invoice or bill.

### `047_vat_settings.sql`

**`vat_settings`** (new, one row per client, following `expense_settings` / `dunning_policy`):

```
client_company_id uuid PRIMARY KEY REFERENCES client_companies(id),
vat_no text,
periodicity text NOT NULL DEFAULT 'monthly' CHECK (periodicity IN ('monthly','quarterly')),
created_at, updated_at
```

RLS + grants as above (`SELECT, INSERT, UPDATE`). Reads default to `monthly` when no row exists, so
the feature works before anyone visits the settings form. `client_companies` gains no columns.

`proposals_type_check` is extended with `'ecsl'` using the same
`ALTER TABLE proposals DROP CONSTRAINT / ADD CONSTRAINT` pattern as `043_recurring_invoices.sql`.

## 2. `src/tax/categories.ts` — category vocabulary (pure)

```ts
export type VatCategory = 'S' | 'Z' | 'E' | 'AE' | 'K' | 'G' | 'O';
```

The UNCL5305 subset EN 16931 BT-151 permits: **S** standard rate, **Z** zero-rated, **E** exempt,
**AE** VAT reverse charge, **K** intra-Community supply, **G** export outside the EU, **O** services
outside the scope of VAT.

Pure helpers, no DB access:

- `chargesVat(cat)` — true only for `S`.
- `selfAssesses(cat)` — true for `AE` and `K` on the **purchase** side.
- `inEcsl(cat)` — true for `AE` and `K`.
- `ecslSupplyType(cat)` — `K` → `'goods'`, `AE` → `'services'`. An intra-EU goods supply is
  categorised `K`; an intra-EU B2B service where the customer accounts for the VAT is `AE`. The
  category alone therefore distinguishes the two ECSL supply types and **no extra column is needed**.
- `exemptionReasonFor(cat)` — BT-120/BT-121 pairs, e.g. `K` → code `VATEX-EU-IC`, `AE` → reason
  text "Reverse charge".

One consistency rule, `assertCategoryConsistent(line)`:

- `S` requires `vat_rate > 0`.
- Every other category requires **invoiced** `vat_cents = 0`.
- `AE` / `K` still carry a nonzero `vat_rate` — that rate is what self-assessment multiplies by, so
  reduced rates (12% / 5%) work without a hidden `tax_rules` lookup.

## 3. EN 16931 conformance — `src/einvoice/ubl.ts`, `src/einvoice/validate.ts`

**Emit.** Each `<cac:ClassifiedTaxCategory>` gains the mandatory `<cbc:ID>` (BT-151). The
document-level `<cac:TaxTotal>` gains one `<cac:TaxSubtotal>` per distinct category with
`TaxableAmount`, `TaxAmount`, `TaxCategory/ID`, `Percent`, and
`TaxExemptionReasonCode` / `TaxExemptionReason` where the category requires them. Applies to both
`buildUblInvoice` and `buildUblCreditNote`.

**Parse.** `parseUblInvoice` / `parseUblCreditNote` read `ClassifiedTaxCategory/ID` into a new
`vatCategory` field per line, so inbound Peppol bills arrive pre-classified rather than looking
domestic. Unknown or absent codes fall back to `'S'` with the existing `Percent` behaviour.

**Types.** `InvoiceLineIn.vatCategory?: VatCategory` — optional, defaulting to `'S'` in the builder,
so the recurring templates' stored `invoice_payload` jsonb (`043_recurring_invoices.sql`) stays
valid without a data migration.

**Validate.** `validateEn16931` gains:

- BR-IC-1 — an intra-Community supply (`K`) requires a customer VAT identifier and an exemption
  reason.
- BR-AE-* — a reverse-charge line must carry zero VAT.
- BR-S-* — a standard-rate line must have a rate greater than zero.
- BR-E-* — an exempt line requires an exemption reason.

These run in `sendInvoice` / `sendCreditNote` before anything else, as today.

## 4. Posting — `src/payables/bills.ts`, `src/payables/credit-notes.ts`

`buildBillEntry` becomes per-line category-aware. Self-assessed VAT on an `AE`/`K` line is
`net × vat_rate`.

Deductible reverse-charge line, net 1000 at 21%:

```
DR expense            1000
CR payables           1000
DR 5722 input VAT      210
CR 5721 output VAT     210     -> net VAT impact 0
```

Same line, not deductible:

```
DR expense            1210     (net + self-assessed VAT — non-deductible VAT is part of the cost)
CR payables           1000
CR 5721 output VAT     210     -> 210 of real cost
```

Payables credit is unchanged: Σ net + Σ **invoiced** VAT (a reverse-charge line invoices zero VAT,
so the vendor is paid net). Vendor credit notes mirror the same logic in reverse. The `newBillSchema`
zod object gains `vatCategory` (optional, default `'S'`) and `vatDeductible` (optional, default
`true`), plus the `assertCategoryConsistent` refinement alongside the existing negative-amount
refinement.

Sales side needs **no posting change**: a `K`/`AE`/`E`/`Z`/`G`/`O` invoice has `vatTotal` 0, and the
existing `invVat > 0n` guard in `sendInvoice` already skips the VAT leg. Only line persistence into
`einvoice_lines` is new.

## 5. Return + ECSL — `src/tax/`

**`vat-breakdown.ts`** — `vatBreakdown(tx, ctx, { fromDate, toDate })` returns, per category:
`salesNetCents`, `salesVatCents`, `purchaseNetCents`, `purchaseVatCents`, `selfAssessedVatCents`.
Sales from `einvoice_lines` joined to outbound `einvoices` by `issue_date`; purchases from
`bill_lines` joined to `bills` by `issue_date`.

**`vat-declaration.ts`** — `assembleVatDeclaration` keeps `computeVat`'s GL totals as the
authoritative money figures and gains `breakdown` plus `reconciles: boolean`. Reconciliation compares
GL output/input VAT against the document-derived equivalents, exact to the cent. A mismatch **flags
and never throws** — the same indicator pattern as the M1 statements' `balanced` / reconciliation
flags. `toEdsXml` gains the per-category breakdown, keeping its existing "exact VID element names
finalized with tax-advisor input" disclaimer.

**`ecsl.ts`** — `ecSalesList(tx, ctx, { fromDate, toDate })` groups outbound `einvoice_lines` whose
category satisfies `inEcsl` by (partner VAT number, `country_code`, `ecslSupplyType`), summing net.
Rows whose partner has no VAT number surface in an `issues[]` array rather than being silently
dropped — an ECSL row without a counterparty VAT number is rejected by VID, so the operator must see
it. `toPvn2Xml()` is a representative mock carrying the same disclaimer as `toEdsXml`. It is
generated and stored on the proposal's rationale, not transmitted — see the no-submission note in
§6; no new integration and no change to `src/einvoice/vid.ts`.

**`filing-periods.ts`** — `filingPeriodsFor(year, periodicity)` and
`currentFilingPeriod(date, periodicity)`. Both filings follow the client's `vat_settings.periodicity`.
Each period's due date is the 20th of the following month, rolled forward by a new `nextWorkingDay()`
in `src/calendar/` that reuses `isLatvianHoliday` (the existing `addWorkingDays` advances *n* days
and cannot express "this day, or the next working one").

## 6. API + UI

**Routes** (house pattern: `getSessionToken()` → `resolveTenantContext` → `assertRoleAllowed` →
domain call inside `withTenant`, errors via `errorToStatus`):

- `GET /api/filings/vat-return?clientCompanyId&from&to` — totals, breakdown, `reconciles`.
- `GET /api/filings/ecsl?clientCompanyId&from&to` — rows + `issues`.
- `POST /api/filings/vat-return` — prepares the existing approval-gated `declaration` proposal.
  `createVatDeclarationProposal`'s guardrail (declarations may **never** auto-submit) stands.
- `POST /api/filings/ecsl` — prepares an `ecsl` proposal, same approval gate.
- `GET` / `POST /api/vat-settings`.

**Authz** — new `Operation`s in `src/authz/policy.ts`: `filings.prepare` and `vat.settings.write`,
both firm-side only (`firm_admin`, `accountant`).

**No filing-submission op, deliberately.** There is no declaration-submission path in the codebase
today: approving a `declaration` proposal only marks it approved (`src/api/handlers.ts` —
"declaration/task: approval only, no ledger post here"), and `submitToVid` accepts an *einvoice* id,
not a filing. A `filings.submit` operation would have nothing to gate. The lifecycle this slice ships
is therefore **draft → pending approval → approved (ready to file)**, with the generated EDS/PVN 2
XML downloadable from the page for manual EDS upload — consistent with `CLAUDE.md`'s standing caveat
that VID sends do not leave the building yet. Wiring an actual filing submission belongs with
`HANDOFF §2` (real EDS filing), not here.

**`/filings` page** — two tabs; period picker driven by periodicity; the VAT-return tab shows GL
totals, the per-category breakdown, and the reconciliation indicator; the ECSL tab shows the partner
table and the issues list; both show the filing status and due date, with an XML download for the
approved filing; CSV / Excel / PDF via two new `src/reports/tabular.ts` builders
(`vatReturnTable`, `ecslTable`) registered as report keys on the existing
`GET /api/reports/export`. Nav entry in `web/app/components/` with an inline stroked SVG icon.

**Form changes** — the `/invoices/new` composer and the bill-entry form each gain a per-line category
select (default `S`, showing the derived self-assessment for `AE`/`K`); the party form gains country
code and VAT number.

**i18n** — every new string in all three catalogs (LV/RU/EN) in `web/app/lib/i18n.ts`; the typed
`Record<keyof typeof EN, string>` fails the build on a missing key.

## 7. Tests

- `tests/tax/categories.test.ts` — predicates, `ecslSupplyType`, consistency rule (pure, no DB).
- `tests/tax/vat-breakdown.test.ts` — per-category sales/purchase aggregation; outbound-only guard.
- `tests/tax/ecsl.test.ts` — partner grouping, goods-vs-services split, missing-VAT-number issues.
- `tests/tax/filing-periods.test.ts` — monthly and quarterly periods, 20th-of-next-month due date,
  weekend/holiday rollover.
- `tests/einvoice/ubl-categories.test.ts` — emit→parse round-trip asserting BT-151 is present and
  per-category `TaxSubtotal` is correct; new validation rules reject the bad cases.
- `tests/payables/bills-reverse-charge.test.ts` — deductible and non-deductible postings both
  balance and hit the right accounts.
- `tests/tax/vat-reconciliation.test.ts` — a manual JE against a VAT account makes `reconciles`
  false without throwing.
- Backward compatibility — untouched invoices and bills still read as `S` and post identically.

Slice B also seeds one intra-EU customer and supply into demo data so `/filings` is not empty after
`npm run seed`.

Run `npm test` (root) and `npx tsc --noEmit` in both root and `web/` before declaring done. Only one
vitest suite at a time — `resetDb` drops the schema on a shared DB.

## Out of scope (named, not forgotten)

- **Intrastat** — slice C; needs CN commodity codes, net mass, and threshold monitoring. The
  `cn_code` / `net_mass_kg` columns land now so slice C needs no migration on hot tables.
- **OSS** for digital services, the **cash-accounting scheme**, and triangulation reporting.
- **VIES validation** of counterparty VAT numbers against the live service — format checks only here;
  a real VIES client would be another adapter+stub seam.
- Moving the hard-coded `5721` / `5722` account map into `vat_settings`. That debt (see the M2 row in
  `docs/ROADMAP-market-gaps.md`) stays as-is rather than being half-migrated.
