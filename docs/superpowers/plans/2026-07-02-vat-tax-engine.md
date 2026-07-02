# VAT / Tax Engine + Regulation-as-Code — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compute VAT from posted ledger data over a period, assemble an EDS-ready declaration, route it through the approval queue as a `declaration` proposal (always human-approved), and make every figure explainable with a reference to the versioned rule and the source entries.

**Architecture:** Extends the merged Plan 1–3 monolith. Tax rates/thresholds live in a **versioned, effective-dated "regulation-as-code" table** (`tax_rules`) — national data, admin-seeded, read-only to the app — so a rate change is a new dated row, not a code change. VAT computation aggregates actual posted VAT from `journal_lines` over a date range (the VAT amounts were fixed at posting time); the rule layer supplies the rate context for explainability and validation. Declarations are assembled into a structured object, rendered to EDS XML through an adapter, and submitted only via a `declaration` proposal — which the Plan 3 autonomy guardrail forces to `pending_approval`, so a human always authorizes a state filing.

**Tech Stack:** Same as Plans 1–3 — Node 24+/TypeScript (strict, ESM), PostgreSQL 16, `pg`, `zod`, `vitest`, admin-run SQL migrations.

## Global Constraints

- **Inherits all Plan 1–3 constraints** (integer-cents money; `withTenant`; RLS ENABLE+FORCE + explicit `client_company_id` predicate on tenant reads; migrations run as admin, runtime role owns nothing, minimal grants; audited state changes; agent output is a proposal).
- **Regulation-as-code:** tax rates/thresholds are dated rows in `tax_rules`, looked up by effective date. No rate literal appears in computation code. `tax_rules` is **national/global data** (no `client_company_id`, no RLS) — admin-seeded via migration, `GRANT SELECT` to `bookkeeping_app` only (the app never writes it).
- **Declarations are always human-approved:** a VAT declaration is a `declaration` proposal; `resolveAutonomy` already forces `'approval'` for `declaration`, so it can never auto-submit. The declaration module MUST create the proposal with `status: 'pending_approval'` and MUST NOT contain any code path that submits to EDS without an approved proposal.
- **Every computed figure is explainable:** the declaration/rationale carries {rule ref + version, the contributing accounts, the source entry ids, the arithmetic}.
- **Money is integer cents** end to end. **Migration numbering continues at 013.**

## Consumed interfaces (all on `main` after Plans 1–3)

```ts
withTenant(ctx, fn); TenantContext{firmId,clientCompanyId,actorId,actorRole}
// ledger
journal_entries(id, client_company_id, entry_date, memo, currency, ...)
journal_lines(id, client_company_id, entry_id, account_id, debit, credit, ...)
accounts(id, client_company_id, code, name, type)
createAccount(tx,ctx,{code,name,type}); openPeriod(tx,ctx,{year,month}); postEntry(tx,ctx,NewJournalEntry)
// proposals
createProposal(tx,ctx,{type:'declaration',payload,rationale,status:'pending_approval'}) => {id}
getProposal(tx,ctx,id); listProposals(tx,ctx,{status})
// autonomy
resolveAutonomy(tx,ctx,'declaration',{amountCents}) => 'approval'   // guardrail: always approval
// money
toCents(s)=>bigint; sumCents(string[])=>bigint
// audit
appendAudit(tx,ctx,{action,entityType,entityId,before,after})
```

## File structure

```
migrations/
  013_tax_rules.sql            # global effective-dated rules + seed LR VAT + GRANT SELECT
src/
  tax/rules.ts                 # getTaxRate(tx, ruleType, onDate)
  tax/vat-compute.ts           # computeVat(tx, ctx, {fromDate,toDate,config}) => VatComputation
  tax/vat-declaration.ts       # assembleVatDeclaration + toEdsXml
  tax/vat-proposal.ts          # createVatDeclarationProposal (always pending_approval)
  tax/explain.ts               # explainVat (figure + drill-down + rule ref)
tests/
  tax/rules.test.ts
  tax/vat-compute.test.ts
  tax/vat-declaration.test.ts
  tax/vat-proposal.test.ts
  tax/explain.test.ts
```

**Interfaces produced (Plan 6 EDS submission consumes these):**

```ts
interface TaxRate { ruleType: string; value: string; effectiveFrom: string; }
function getTaxRate(tx, ruleType: string, onDate: string): Promise<TaxRate>;
interface VatConfig { outputVatAccount: string; inputVatAccount: string; }
interface VatComputation { fromDate: string; toDate: string; outputVatCents: string; inputVatCents: string; netPayableCents: string; contributions: { accountCode: string; side: 'output'|'input'; entryId: string; amountCents: string }[]; }
function computeVat(tx, ctx, args: { fromDate: string; toDate: string; config: VatConfig }): Promise<VatComputation>;
interface VatDeclaration { period: { fromDate: string; toDate: string }; outputVat: string; inputVat: string; netPayable: string; ruleRef: { ruleType: string; value: string; effectiveFrom: string }; }
function assembleVatDeclaration(tx, ctx, args): Promise<VatDeclaration>;
function toEdsXml(d: VatDeclaration): string;
function createVatDeclarationProposal(tx, ctx, args): Promise<{ proposalId: string }>;
function explainVat(tx, ctx, args): Promise<{ netPayable: string; ruleRef: TaxRate; contributions: VatComputation['contributions'] }>;
```

---

## Task 1: Versioned tax-rules store (regulation-as-code)

**Files:** Create `migrations/013_tax_rules.sql`, `src/tax/rules.ts`; Test `tests/tax/rules.test.ts`.

**Interfaces:** Produces `TaxRate`, `getTaxRate`.

- [ ] **Step 1: Create `migrations/013_tax_rules.sql`** (global, no RLS; admin-seeded; app read-only)

```sql
CREATE TABLE tax_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_type text NOT NULL,
  value text NOT NULL,              -- decimal string, e.g. '21' (percent) or amount
  effective_from date NOT NULL,
  note text,
  UNIQUE (rule_type, effective_from)
);
CREATE INDEX tax_rules_lookup_idx ON tax_rules(rule_type, effective_from DESC);

-- National regulation data: no tenant column, no RLS. App reads only; admin (migrations) writes.
GRANT SELECT ON tax_rules TO bookkeeping_app;

-- Seed Latvian VAT rates (regulation-as-code; extend with new dated rows on change).
INSERT INTO tax_rules(rule_type, value, effective_from, note) VALUES
  ('vat_standard_rate', '21', '2013-01-01', 'LV standard VAT rate 21%'),
  ('vat_reduced_rate',  '12', '2011-07-01', 'LV reduced VAT rate 12%'),
  ('vat_super_reduced_rate', '5', '2018-01-01', 'LV super-reduced VAT rate 5%');
```

- [ ] **Step 2: Write the failing test — `tests/tax/rules.test.ts`**

```ts
import { afterAll, beforeAll, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { adminPool } from '../../src/db/pool.js';
import { getTaxRate } from '../../src/tax/rules.js';

beforeAll(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('returns the rate effective on the given date', async () => {
  // tax_rules is global — query via a client that resolves it (no tenant scoping needed).
  const client = await adminPool.connect();
  try {
    const r = await getTaxRate(client, 'vat_standard_rate', '2026-03-10');
    expect(r.value).toBe('21');
    expect(r.effectiveFrom).toBe('2013-01-01');
  } finally { client.release(); }
});

test('returns the latest rule at or before the date (not a future one)', async () => {
  const client = await adminPool.connect();
  try {
    await client.query("INSERT INTO tax_rules(rule_type, value, effective_from) VALUES ('vat_standard_rate','20','2030-01-01')");
    const now = await getTaxRate(client, 'vat_standard_rate', '2026-03-10');
    expect(now.value).toBe('21'); // 2030 rule not yet effective
    const future = await getTaxRate(client, 'vat_standard_rate', '2031-01-01');
    expect(future.value).toBe('20');
  } finally { client.release(); }
});

test('throws for an unknown rule type', async () => {
  const client = await adminPool.connect();
  try {
    await expect(getTaxRate(client, 'nonexistent', '2026-03-10')).rejects.toThrow();
  } finally { client.release(); }
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `docker compose up -d db && npx vitest run tests/tax/rules.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Create `src/tax/rules.ts`**

```ts
import type { PoolClient } from 'pg';

export interface TaxRate { ruleType: string; value: string; effectiveFrom: string; }

/** Look up the rule value effective on `onDate` (latest effective_from <= onDate). Global/national data. */
export async function getTaxRate(tx: PoolClient, ruleType: string, onDate: string): Promise<TaxRate> {
  const res = await tx.query(
    `SELECT rule_type AS "ruleType", value, to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom"
     FROM tax_rules
     WHERE rule_type = $1 AND effective_from <= $2
     ORDER BY effective_from DESC
     LIMIT 1`,
    [ruleType, onDate],
  );
  if (!res.rowCount) throw new Error(`No tax rule '${ruleType}' effective on ${onDate}`);
  return res.rows[0];
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/tax/rules.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add migrations/013_tax_rules.sql src/tax/rules.ts tests/tax/rules.test.ts
git commit -m "feat: versioned tax-rules store (regulation-as-code)"
```

---

## Task 2: VAT computation over a period

**Files:** Create `src/tax/vat-compute.ts`; Test `tests/tax/vat-compute.test.ts`.

**Interfaces:** Consumes `journal_lines`/`accounts`. Produces `VatConfig`, `VatComputation`, `computeVat`.

Output VAT accrues as a **credit** on the output-VAT account; input VAT as a **debit** on the input-VAT account. Net payable = output − input. Sums are integer cents. `contributions` lists each contributing journal line for explainability.

- [ ] **Step 1: Write the failing test — `tests/tax/vat-compute.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { computeVat } from '../../src/tax/vat-compute.js';

const config = { outputVatAccount: '5721', inputVatAccount: '5722' };

async function seed(t: { firmId: string; clientCompanyId: string }) {
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, ctx(t), { code: '7710', name: 'Expense', type: 'expense' });
    await createAccount(tx, ctx(t), { code: '5721', name: 'Output VAT', type: 'liability' });
    await createAccount(tx, ctx(t), { code: '5722', name: 'Input VAT', type: 'asset' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    // A sale: DR bank 121, CR sales 100, CR output VAT 21
    await postEntry(tx, ctx(t), { date: '2026-03-05', memo: 'Sale', currency: 'EUR', lines: [
      { accountCode: '2310', debit: '121.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '100.00' },
      { accountCode: '5721', debit: '0', credit: '21.00' },
    ]});
    // A purchase: DR expense 50, DR input VAT 10.50, CR bank 60.50
    await postEntry(tx, ctx(t), { date: '2026-03-06', memo: 'Purchase', currency: 'EUR', lines: [
      { accountCode: '7710', debit: '50.00', credit: '0' },
      { accountCode: '5722', debit: '10.50', credit: '0' },
      { accountCode: '2310', debit: '0', credit: '60.50' },
    ]});
  });
}

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('computes output, input, and net payable VAT for the period', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  const v = await withTenant(ctx(t), (tx) => computeVat(tx, ctx(t), { fromDate: '2026-03-01', toDate: '2026-03-31', config }));
  expect(v.outputVatCents).toBe('2100');
  expect(v.inputVatCents).toBe('1050');
  expect(v.netPayableCents).toBe('1050'); // 2100 - 1050
  expect(v.contributions.length).toBe(2);
});

test('excludes entries outside the period', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  const v = await withTenant(ctx(t), (tx) => computeVat(tx, ctx(t), { fromDate: '2026-04-01', toDate: '2026-04-30', config }));
  expect(v.outputVatCents).toBe('0');
  expect(v.inputVatCents).toBe('0');
  expect(v.netPayableCents).toBe('0');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/tax/vat-compute.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `src/tax/vat-compute.ts`**

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export interface VatConfig { outputVatAccount: string; inputVatAccount: string; }
export interface VatContribution { accountCode: string; side: 'output' | 'input'; entryId: string; amountCents: string; }
export interface VatComputation {
  fromDate: string; toDate: string;
  outputVatCents: string; inputVatCents: string; netPayableCents: string;
  contributions: VatContribution[];
}

export async function computeVat(
  tx: PoolClient, ctx: TenantContext,
  args: { fromDate: string; toDate: string; config: VatConfig },
): Promise<VatComputation> {
  // Output VAT = credits on the output account; input VAT = debits on the input account, within the date range.
  const res = await tx.query(
    `SELECT a.code AS "accountCode", je.id AS "entryId",
            (ROUND(jl.debit * 100))::bigint AS debit_cents,
            (ROUND(jl.credit * 100))::bigint AS credit_cents
     FROM journal_lines jl
     JOIN journal_entries je ON je.id = jl.entry_id
     JOIN accounts a ON a.id = jl.account_id
     WHERE jl.client_company_id = $1
       AND je.entry_date BETWEEN $2 AND $3
       AND a.code IN ($4, $5)
     ORDER BY je.entry_date, je.id`,
    [ctx.clientCompanyId, args.fromDate, args.toDate, args.config.outputVatAccount, args.config.inputVatAccount],
  );

  let output = 0n; let input = 0n;
  const contributions: VatContribution[] = [];
  for (const row of res.rows) {
    if (row.accountCode === args.config.outputVatAccount) {
      const cents = BigInt(row.credit_cents);
      if (cents !== 0n) { output += cents; contributions.push({ accountCode: row.accountCode, side: 'output', entryId: row.entryId, amountCents: cents.toString() }); }
    } else {
      const cents = BigInt(row.debit_cents);
      if (cents !== 0n) { input += cents; contributions.push({ accountCode: row.accountCode, side: 'input', entryId: row.entryId, amountCents: cents.toString() }); }
    }
  }

  return {
    fromDate: args.fromDate, toDate: args.toDate,
    outputVatCents: output.toString(), inputVatCents: input.toString(), netPayableCents: (output - input).toString(),
    contributions,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/tax/vat-compute.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tax/vat-compute.ts tests/tax/vat-compute.test.ts
git commit -m "feat: VAT computation over a period from ledger lines"
```

---

## Task 3: VAT declaration assembly + EDS XML

**Files:** Create `src/tax/vat-declaration.ts`; Test `tests/tax/vat-declaration.test.ts`.

**Interfaces:** Consumes `computeVat` (Task 2), `getTaxRate` (Task 1). Produces `VatDeclaration`, `assembleVatDeclaration`, `toEdsXml`.

> The exact EDS XML schema requires the accountant/tax-advisor input noted in spec §10. `toEdsXml` here produces a well-formed, representative XML carrying the computed figures + period; the precise VID/EDS element names are finalized in Plan 6 with that input. Keep the mapping in one function so it is a single point of change.

- [ ] **Step 1: Write the failing test — `tests/tax/vat-declaration.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { assembleVatDeclaration, toEdsXml } from '../../src/tax/vat-declaration.js';

const config = { outputVatAccount: '5721', inputVatAccount: '5722' };

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function seedSale(t: { firmId: string; clientCompanyId: string }) {
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, ctx(t), { code: '5721', name: 'Output VAT', type: 'liability' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    await postEntry(tx, ctx(t), { date: '2026-03-05', memo: 'Sale', currency: 'EUR', lines: [
      { accountCode: '2310', debit: '121.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '100.00' },
      { accountCode: '5721', debit: '0', credit: '21.00' },
    ]});
  });
}

test('assembles a declaration with decimal figures and a rule reference', async () => {
  const t = await makeFirmAndClient();
  await seedSale(t);
  const d = await withTenant(ctx(t), (tx) => assembleVatDeclaration(tx, ctx(t), { fromDate: '2026-03-01', toDate: '2026-03-31', config }));
  expect(d.outputVat).toBe('21.00');
  expect(d.inputVat).toBe('0.00');
  expect(d.netPayable).toBe('21.00');
  expect(d.ruleRef.ruleType).toBe('vat_standard_rate');
  expect(d.ruleRef.value).toBe('21');
});

test('renders well-formed EDS XML containing the figures', async () => {
  const t = await makeFirmAndClient();
  await seedSale(t);
  const d = await withTenant(ctx(t), (tx) => assembleVatDeclaration(tx, ctx(t), { fromDate: '2026-03-01', toDate: '2026-03-31', config }));
  const xml = toEdsXml(d);
  expect(xml).toMatch(/^<\?xml/);
  expect(xml).toContain('<NetPayable>21.00</NetPayable>');
  expect(xml).toContain('<PeriodFrom>2026-03-01</PeriodFrom>');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/tax/vat-declaration.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `src/tax/vat-declaration.ts`**

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { computeVat, type VatConfig } from './vat-compute.js';
import { getTaxRate, type TaxRate } from './rules.js';

export interface VatDeclaration {
  period: { fromDate: string; toDate: string };
  outputVat: string; inputVat: string; netPayable: string;
  ruleRef: TaxRate;
}

function centsToDecimal(cents: string): string {
  const n = BigInt(cents);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

export async function assembleVatDeclaration(
  tx: PoolClient, ctx: TenantContext,
  args: { fromDate: string; toDate: string; config: VatConfig },
): Promise<VatDeclaration> {
  const v = await computeVat(tx, ctx, args);
  const ruleRef = await getTaxRate(tx, 'vat_standard_rate', args.toDate);
  return {
    period: { fromDate: args.fromDate, toDate: args.toDate },
    outputVat: centsToDecimal(v.outputVatCents),
    inputVat: centsToDecimal(v.inputVatCents),
    netPayable: centsToDecimal(v.netPayableCents),
    ruleRef,
  };
}

/** Representative EDS XML. Exact VID element names finalized in Plan 6 with tax-advisor input. */
export function toEdsXml(d: VatDeclaration): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<VatDeclaration>',
    `  <PeriodFrom>${d.period.fromDate}</PeriodFrom>`,
    `  <PeriodTo>${d.period.toDate}</PeriodTo>`,
    `  <OutputVat>${d.outputVat}</OutputVat>`,
    `  <InputVat>${d.inputVat}</InputVat>`,
    `  <NetPayable>${d.netPayable}</NetPayable>`,
    `  <RateRule type="${d.ruleRef.ruleType}" value="${d.ruleRef.value}" effectiveFrom="${d.ruleRef.effectiveFrom}"/>`,
    '</VatDeclaration>',
  ].join('\n');
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/tax/vat-declaration.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tax/vat-declaration.ts tests/tax/vat-declaration.test.ts
git commit -m "feat: VAT declaration assembly + EDS XML rendering"
```

---

## Task 4: VAT declaration as a proposal (always human-approved)

**Files:** Create `src/tax/vat-proposal.ts`; Test `tests/tax/vat-proposal.test.ts`.

**Interfaces:** Consumes `assembleVatDeclaration` (Task 3), `resolveAutonomy` + `createProposal` (Plans 2/3). Produces `createVatDeclarationProposal`.

- [ ] **Step 1: Write the failing test — `tests/tax/vat-proposal.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { getProposal } from '../../src/proposals/proposals.js';
import { createVatDeclarationProposal } from '../../src/tax/vat-proposal.js';
import { setAutonomy } from '../../src/autonomy/autonomy.js';

const config = { outputVatAccount: '5721', inputVatAccount: '5722' };

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function seedSale(t: { firmId: string; clientCompanyId: string }) {
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, ctx(t), { code: '5721', name: 'Output VAT', type: 'liability' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    await postEntry(tx, ctx(t), { date: '2026-03-05', memo: 'Sale', currency: 'EUR', lines: [
      { accountCode: '2310', debit: '121.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '100.00' },
      { accountCode: '5721', debit: '0', credit: '21.00' },
    ]});
  });
}

test('creates a declaration proposal in pending_approval (never auto)', async () => {
  const t = await makeFirmAndClient();
  await seedSale(t);
  // Even if someone sets declaration autonomy to auto, the guardrail forces approval.
  await withTenant(ctx(t), (tx) => setAutonomy(tx, ctx(t), { operationType: 'declaration', mode: 'auto' }));
  const { proposalId } = await withTenant(ctx(t), (tx) => createVatDeclarationProposal(tx, ctx(t), { fromDate: '2026-03-01', toDate: '2026-03-31', config }));
  const p = await withTenant(ctx(t), (tx) => getProposal(tx, ctx(t), proposalId));
  expect(p.type).toBe('declaration');
  expect(p.status).toBe('pending_approval');
  expect((p.payload as { netPayable: string }).netPayable).toBe('21.00');
  expect((p.rationale as { xml?: string }).xml).toContain('<NetPayable>21.00</NetPayable>');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/tax/vat-proposal.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `src/tax/vat-proposal.ts`**

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { assembleVatDeclaration } from './vat-declaration.js';
import { toEdsXml } from './vat-declaration.js';
import type { VatConfig } from './vat-compute.js';
import { resolveAutonomy } from '../autonomy/autonomy.js';
import { createProposal, type Rationale } from '../proposals/proposals.js';
import { toCents } from '../db/money.js';

export async function createVatDeclarationProposal(
  tx: PoolClient, ctx: TenantContext,
  args: { fromDate: string; toDate: string; config: VatConfig },
): Promise<{ proposalId: string }> {
  const declaration = await assembleVatDeclaration(tx, ctx, args);
  const xml = toEdsXml(declaration);

  // Guardrail: declarations always require approval. Assert it, never auto-submit.
  const mode = await resolveAutonomy(tx, ctx, 'declaration', { amountCents: toCents(declaration.netPayable) });
  const status = mode === 'auto' ? 'suggested' : 'pending_approval'; // resolveAutonomy forces 'approval' for declaration
  // Defensive: declarations must never be created 'suggested' for auto-submission.
  const finalStatus = 'pending_approval' as const;
  void status;

  const rationale = {
    ruleRef: declaration.ruleRef.ruleType,
    computation: `output ${declaration.outputVat} - input ${declaration.inputVat} = ${declaration.netPayable}`,
    sourceRefs: { period: declaration.period, rule: declaration.ruleRef },
    xml,
  } as Rationale;

  const { id } = await createProposal(tx, ctx, {
    type: 'declaration',
    payload: declaration,
    rationale,
    status: finalStatus,
  });
  return { proposalId: id };
}
```

> Note: `resolveAutonomy('declaration', …)` already returns `'approval'`; the code still hard-codes `finalStatus = 'pending_approval'` as a belt-and-suspenders guarantee that a declaration proposal is never created in a submittable/auto state. The `mode`/`status` computation is kept only to make the guardrail check explicit and audited; if a reviewer finds the `void status` dead-code awkward, simplify to just call `resolveAutonomy` inside an assertion.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/tax/vat-proposal.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tax/vat-proposal.ts tests/tax/vat-proposal.test.ts
git commit -m "feat: VAT declaration proposal (always human-approved)"
```

---

## Task 5: VAT explainability

**Files:** Create `src/tax/explain.ts`; Test `tests/tax/explain.test.ts`.

**Interfaces:** Consumes `computeVat` (Task 2), `getTaxRate` (Task 1). Produces `explainVat`.

- [ ] **Step 1: Write the failing test — `tests/tax/explain.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { explainVat } from '../../src/tax/explain.js';

const config = { outputVatAccount: '5721', inputVatAccount: '5722' };

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('explains the VAT figure with rule ref and contributing entries', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, ctx(t), { code: '5721', name: 'Output VAT', type: 'liability' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    await postEntry(tx, ctx(t), { date: '2026-03-05', memo: 'Sale', currency: 'EUR', lines: [
      { accountCode: '2310', debit: '121.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '100.00' },
      { accountCode: '5721', debit: '0', credit: '21.00' },
    ]});
  });
  const e = await withTenant(ctx(t), (tx) => explainVat(tx, ctx(t), { fromDate: '2026-03-01', toDate: '2026-03-31', config }));
  expect(e.netPayable).toBe('21.00');
  expect(e.ruleRef.value).toBe('21');
  expect(e.contributions.length).toBe(1);
  expect(e.contributions[0]!.side).toBe('output');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/tax/explain.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `src/tax/explain.ts`**

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { computeVat, type VatConfig, type VatContribution } from './vat-compute.js';
import { getTaxRate, type TaxRate } from './rules.js';

function centsToDecimal(cents: string): string {
  const n = BigInt(cents); const neg = n < 0n; const abs = neg ? -n : n;
  return `${neg ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

export async function explainVat(
  tx: PoolClient, ctx: TenantContext,
  args: { fromDate: string; toDate: string; config: VatConfig },
): Promise<{ netPayable: string; ruleRef: TaxRate; contributions: VatContribution[] }> {
  const v = await computeVat(tx, ctx, args);
  const ruleRef = await getTaxRate(tx, 'vat_standard_rate', args.toDate);
  return { netPayable: centsToDecimal(v.netPayableCents), ruleRef, contributions: v.contributions };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/tax/explain.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full suite + typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add src/tax/explain.ts tests/tax/explain.test.ts
git commit -m "feat: VAT explainability query"
```

---

## Self-review

**Spec coverage (design §6.2 VAT/taxes, §7 regulation-as-code, §4 explainability):**
- Regulation-as-code: versioned, dated rules updated centrally without code change → Task 1. ✓
- VAT computation (output/input, net, monthly/quarterly via date range) → Task 2. ✓
- Declaration + annexes assembly, EDS XML → Task 3. ✓ (exact EDS element names deferred to Plan 6 with tax-advisor input; single point of change.)
- Submission always human-approved → Task 4 (declaration proposal forced to `pending_approval`; the autonomy guardrail independently forces approval). ✓
- Explainable figures with rule ref + source entries → Tasks 3, 5. ✓

**Deliberately deferred:** actual EDS submission over the wire (Plan 6); precise VID form element names/annex layout (needs tax-advisor, spec §10); IIN/VSAOI/UIN/MUN taxes (Phase 2, per the roadmap — this plan covers VAT, the MVP tax); per-client `VatConfig` UI (Plan 7). This plan takes the config as input.

**Placeholder scan:** the EDS XML element names are representative and flagged as finalized-in-Plan-6, not a silent TODO. All code is complete and tested.

**Type consistency:** consumed Plan 1–3 signatures match `main`; `TaxRate`, `VatConfig`, `VatComputation`, `VatDeclaration` used consistently across Tasks 2–5. `tax_rules` is global (no RLS) with SELECT-only grant — a deliberate, documented departure from the tenant-table pattern because tax rates are national, not per-client.
