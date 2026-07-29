# M9 Slice B — EC Sales List (PVN 2), filing periodicity, `/filings` page

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aggregate intra-EU supplies into an EC Sales List (PVN 2), give both filings a monthly/quarterly period with a working-day due date, and surface the VAT return and ECSL on a new `/filings` page with export.

**Architecture:** `vat_settings` holds the client's VAT number and filing periodicity; `filing-periods.ts` turns that into concrete periods with due dates; `ecsl.ts` groups outbound `einvoice_lines` in ECSL categories by counterparty. Both filings are prepared as approval-gated proposals — there is **no submission path** (see the spec's §6 note), so the lifecycle ends at "approved, ready to file" with a downloadable XML.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Postgres 16 with RLS, `pg`, vitest, Next.js 16 App Router (`--webpack`), CSS modules.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-29-vat-completeness-design.md`. **Depends on plan `2026-07-29-vat-categories.md` being complete** — `einvoice_lines`, `parties.country_code`, `vatBreakdown`, and `VatDeclaration.reconciles` all come from it.
- Money is **integer cents** via `src/db/money.ts`. Never floats.
- This plan owns migration **`047`** only. Never reuse a number.
- New tables get RLS + `FORCE ROW LEVEL SECURITY` + tenant policy + explicit `GRANT`. Copy `migrations/045_expense_claims.sql`.
- Every user-facing string goes in all three catalogs (LV/RU/EN) in `web/app/lib/i18n.ts`.
- API routes follow the house pattern: `getSessionToken()` → `resolveTenantContext(token, clientCompanyId, nowUnix())` → `assertRoleAllowed(...)` → domain call inside `withTenant` → `errorToStatus` on failure. `export const runtime = 'nodejs'` and `export const dynamic = 'force-dynamic'` at the top of every route (`pg` cannot run on Edge).
- Declarations may **never** auto-submit. `createVatDeclarationProposal` asserts this; the ECSL proposal does the same.
- Run `npm test` (root) and `npx tsc --noEmit` in **both** root and `web/` before declaring any task done.
- **Never run two vitest suites concurrently** — `resetDb()` drops the public schema.
- Commit after every task with the trailer: `Claude-Session: https://claude.ai/code/session_01BQ5EiunbJpf7XY9Bge3gB1`

---

## File Structure

**Create:**
- `migrations/047_vat_settings.sql` — `vat_settings`; `proposals` type CHECK + `'ecsl'`.
- `src/tax/vat-settings.ts` — read/write the client's VAT number + periodicity.
- `src/tax/filing-periods.ts` — periods and due dates from a periodicity (pure).
- `src/tax/ecsl.ts` — `ecSalesList`, `toPvn2Xml`.
- `src/tax/ecsl-proposal.ts` — `createEcslProposal`.
- `web/app/api/filings/vat-return/route.ts`, `web/app/api/filings/ecsl/route.ts`, `web/app/api/vat-settings/route.ts`
- `web/app/(cabinet)/filings/page.tsx` + `page.module.css`
- `tests/tax/filing-periods.test.ts`, `tests/tax/vat-settings.test.ts`, `tests/tax/ecsl.test.ts`, `tests/tax/ecsl-proposal.test.ts`, `tests/calendar/next-working-day.test.ts`

**Modify:**
- `src/calendar/holidays.ts` — add `nextWorkingDay`.
- `src/authz/policy.ts` — `filings.prepare`, `vat.settings.write`.
- `src/proposals/proposals.ts` — `'ecsl'` in `ProposalType` + the zod enum.
- `src/proposals/material.ts` — an `ecsl` proposal is always material.
- `src/reports/tabular.ts` + `web/app/lib/report-labels.ts` — `vatReturnTable`, `ecslTable`, their labels.
- `web/app/api/reports/export/route.ts` — `vatreturn` and `ecsl` report keys.
- `web/app/components/Sidebar.tsx`, `web/app/components/NavIcon.tsx` — the nav entry.
- `web/app/lib/i18n.ts` — new keys in LV/RU/EN.
- `src/db/seed.ts` (or wherever `npm run seed` lives) — one intra-EU customer and supply.

---

### Task 1: Migration 047 + VAT settings

**Files:**
- Create: `migrations/047_vat_settings.sql`
- Create: `src/tax/vat-settings.ts`
- Modify: `src/authz/policy.ts`
- Test: `tests/tax/vat-settings.test.ts`

**Interfaces:**
- Consumes: nothing from slice B; `appendAudit` from `src/audit/audit.js`.
- Produces: `Periodicity = 'monthly' | 'quarterly'`, `VatSettings = { vatNo: string | null; periodicity: Periodicity }`, `getVatSettings(tx, ctx)`, `setVatSettings(tx, ctx, { vatNo, periodicity })`. Tasks 2–6 and the routes all consume these.

- [ ] **Step 1: Write the failing test**

`tests/tax/vat-settings.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { getVatSettings, setVatSettings } from '../../src/tax/vat-settings.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('defaults to monthly with no VAT number on first read', async () => {
  const t = await makeFirmAndClient();
  const s = await withTenant(ctx(t), (tx) => getVatSettings(tx, ctx(t)));
  expect(s).toEqual({ vatNo: null, periodicity: 'monthly' });
});

test('stores and returns the VAT number and periodicity', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), (tx) => setVatSettings(tx, ctx(t), { vatNo: 'LV40100000000', periodicity: 'quarterly' }));
  const s = await withTenant(ctx(t), (tx) => getVatSettings(tx, ctx(t)));
  expect(s).toEqual({ vatNo: 'LV40100000000', periodicity: 'quarterly' });
});

test('rejects an unknown periodicity', async () => {
  const t = await makeFirmAndClient();
  await expect(withTenant(ctx(t), (tx) =>
    setVatSettings(tx, ctx(t), { vatNo: null, periodicity: 'annual' as never })))
    .rejects.toThrow(/periodicity/i);
});

test('writes an audit record', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), (tx) => setVatSettings(tx, ctx(t), { vatNo: 'LV40100000000', periodicity: 'monthly' }));
  const rows = await withTenant(ctx(t), (tx) => tx.query(
    `SELECT action, entity_type FROM audit_log WHERE client_company_id = $1 AND entity_type = 'vat_settings'`,
    [t.clientCompanyId]));
  expect(rows.rowCount).toBe(1);
  expect(rows.rows[0]!.action).toBe('update');
});
```

If `audit_log` has a different table or column name, read `src/audit/audit.ts` and match it — do not create a new one.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tax/vat-settings.test.ts`
Expected: FAIL — `Cannot find module '../../src/tax/vat-settings.js'`.

- [ ] **Step 3: Write the migration**

`migrations/047_vat_settings.sql`:

```sql
-- M9 slice B: per-client VAT registration + filing periodicity, and the ECSL proposal type.
CREATE TABLE vat_settings (
  client_company_id uuid PRIMARY KEY REFERENCES client_companies(id),
  vat_no text,
  periodicity text NOT NULL DEFAULT 'monthly' CHECK (periodicity IN ('monthly','quarterly')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE vat_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE vat_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY vat_settings_tenant_isolation ON vat_settings
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON vat_settings TO bookkeeping_app;

-- The EC Sales List is prepared as an approval-gated proposal, like the VAT declaration.
ALTER TABLE proposals DROP CONSTRAINT proposals_type_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_type_check
  CHECK (type IN ('posting','bank_match','declaration','task','recurring_invoice','ecsl'));
```

- [ ] **Step 4: Apply it**

Run: `npm run migrate` (twice — it must be idempotent)
Expected: clean both times.

- [ ] **Step 5: Write `src/tax/vat-settings.ts`**

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appendAudit } from '../audit/audit.js';

export type Periodicity = 'monthly' | 'quarterly';
export const PERIODICITIES: readonly Periodicity[] = ['monthly', 'quarterly'];

export interface VatSettings { vatNo: string | null; periodicity: Periodicity }

/** Read the client's VAT settings, creating the default row (monthly, no VAT number) on first use. */
export async function getVatSettings(tx: PoolClient, ctx: TenantContext): Promise<VatSettings> {
  await tx.query(
    'INSERT INTO vat_settings(client_company_id) VALUES ($1) ON CONFLICT (client_company_id) DO NOTHING',
    [ctx.clientCompanyId],
  );
  const res = await tx.query(
    `SELECT vat_no AS "vatNo", periodicity FROM vat_settings WHERE client_company_id = $1`,
    [ctx.clientCompanyId],
  );
  return res.rows[0];
}

export async function setVatSettings(
  tx: PoolClient, ctx: TenantContext, next: { vatNo: string | null; periodicity: Periodicity },
): Promise<void> {
  if (!(PERIODICITIES as readonly string[]).includes(next.periodicity)) {
    throw new Error(`Invalid periodicity: "${next.periodicity}" (monthly or quarterly)`);
  }
  const vatNo = next.vatNo?.trim() ? next.vatNo.trim().toUpperCase() : null;

  const before = await getVatSettings(tx, ctx);
  await tx.query(
    `UPDATE vat_settings SET vat_no = $1, periodicity = $2, updated_at = now() WHERE client_company_id = $3`,
    [vatNo, next.periodicity, ctx.clientCompanyId],
  );
  await appendAudit(tx, ctx, {
    action: 'update', entityType: 'vat_settings', entityId: ctx.clientCompanyId,
    before, after: { vatNo, periodicity: next.periodicity },
  });
}
```

- [ ] **Step 6: Add the authz operations**

In `src/authz/policy.ts`, extend the `Operation` union and `OPERATION_ROLES` together (both, or the compiler fails):

```ts
  | 'filings.prepare' // prepare a VAT return / EC Sales List for approval — firm-side only
  | 'vat.settings.write'; // set the client's VAT number + filing periodicity — firm-side only
```

```ts
  'filings.prepare': ['firm_admin', 'accountant'],
  'vat.settings.write': ['firm_admin', 'accountant'],
```

There is deliberately **no** `filings.submit`: nothing in the codebase submits a filing (approving a `declaration` proposal posts nothing — see `src/api/handlers.ts`), so the op would gate nothing.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/tax/vat-settings.test.ts tests/db/migration-numbering.test.ts tests/authz`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add migrations/047_vat_settings.sql src/tax/vat-settings.ts src/authz/policy.ts tests/tax/vat-settings.test.ts
git commit -m "feat(tax): vat_settings (VAT number + filing periodicity) + filings authz ops

Claude-Session: https://claude.ai/code/session_01BQ5EiunbJpf7XY9Bge3gB1"
```

---

### Task 2: `nextWorkingDay` + filing periods

**Files:**
- Modify: `src/calendar/holidays.ts`
- Create: `src/tax/filing-periods.ts`
- Test: `tests/calendar/next-working-day.test.ts`, `tests/tax/filing-periods.test.ts`

**Interfaces:**
- Consumes: `isLatvianHoliday` (`src/calendar/holidays.js`), `Periodicity` (Task 1).
- Produces: `nextWorkingDay(date, isHoliday?)`; `FilingPeriod = { label: string; fromDate: string; toDate: string; dueDate: string }`, `filingPeriodsFor(year, periodicity)`, `currentFilingPeriod(onDate, periodicity)`, `filingPeriodByLabel(label, periodicity)`. Tasks 4–6 and the routes consume all four.

The existing `addWorkingDays(date, n)` advances *n* working days and cannot express "this day, or the next working one" — hence a separate helper.

- [ ] **Step 1: Write the failing tests**

`tests/calendar/next-working-day.test.ts`:

```ts
import { expect, test } from 'vitest';
import { nextWorkingDay } from '../../src/calendar/holidays.js';

test('a plain working day is returned unchanged', () => {
  expect(nextWorkingDay('2026-06-22')).toBe('2026-06-22'); // Monday
});

test('a Saturday rolls to Monday', () => {
  expect(nextWorkingDay('2026-06-20')).toBe('2026-06-22');
});

test('a Sunday rolls to Monday', () => {
  expect(nextWorkingDay('2026-06-21')).toBe('2026-06-22');
});

test('a public holiday rolls forward', () => {
  // 2026-06-23 (Līgo) and 2026-06-24 (Jāņi) are LR public holidays; 25 June 2026 is a Thursday.
  expect(nextWorkingDay('2026-06-23')).toBe('2026-06-25');
});

test('the holiday predicate is injectable', () => {
  expect(nextWorkingDay('2026-06-22', (d) => d === '2026-06-22')).toBe('2026-06-23');
});
```

`tests/tax/filing-periods.test.ts`:

```ts
import { expect, test } from 'vitest';
import { filingPeriodsFor, currentFilingPeriod, filingPeriodByLabel } from '../../src/tax/filing-periods.js';

test('a monthly year has twelve periods labelled YYYY-MM', () => {
  const p = filingPeriodsFor(2026, 'monthly');
  expect(p.length).toBe(12);
  expect(p[0]).toEqual({ label: '2026-01', fromDate: '2026-01-01', toDate: '2026-01-31', dueDate: '2026-02-20' });
  expect(p[1]!.toDate).toBe('2026-02-28');   // 2026 is not a leap year
  expect(p[11]).toEqual({ label: '2026-12', fromDate: '2026-12-01', toDate: '2026-12-31', dueDate: '2027-01-20' });
});

test('a quarterly year has four periods labelled YYYY-Qn', () => {
  const p = filingPeriodsFor(2026, 'quarterly');
  expect(p.length).toBe(4);
  expect(p[0]).toEqual({ label: '2026-Q1', fromDate: '2026-01-01', toDate: '2026-03-31', dueDate: '2026-04-20' });
  expect(p[3]!.toDate).toBe('2026-12-31');
  expect(p[3]!.dueDate).toBe('2027-01-20');
});

test('a due date landing on a weekend or holiday rolls to the next working day', () => {
  // 20 September 2026 is a Sunday -> Monday the 21st.
  expect(filingPeriodsFor(2026, 'monthly')[7]!.dueDate).toBe('2026-09-21'); // August period
});

test('currentFilingPeriod finds the period containing a date', () => {
  expect(currentFilingPeriod('2026-06-15', 'monthly').label).toBe('2026-06');
  expect(currentFilingPeriod('2026-06-15', 'quarterly').label).toBe('2026-Q2');
  expect(currentFilingPeriod('2026-01-01', 'quarterly').fromDate).toBe('2026-01-01');
  expect(currentFilingPeriod('2026-12-31', 'monthly').toDate).toBe('2026-12-31');
});

test('filingPeriodByLabel round-trips every label it produces', () => {
  for (const p of [...filingPeriodsFor(2026, 'monthly'), ...filingPeriodsFor(2026, 'quarterly')]) {
    expect(filingPeriodByLabel(p.label, p.label.includes('Q') ? 'quarterly' : 'monthly')).toEqual(p);
  }
});

test('an unparseable label throws', () => {
  expect(() => filingPeriodByLabel('2026-13', 'monthly')).toThrow();
  expect(() => filingPeriodByLabel('2026-Q5', 'quarterly')).toThrow();
});
```

Before trusting the `2026-09-21` and `2026-06-25` expectations, confirm them: `node -e "const {isLatvianHoliday}=require('./dist/calendar/holidays.js')"` will not work on the TS source, so instead assert them from the module inside the test run — if the holiday calendar disagrees, fix the *expectation* to match `isLatvianHoliday` and note the actual date in a comment. The rollover behaviour is what matters, not the specific date.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/calendar/next-working-day.test.ts tests/tax/filing-periods.test.ts`
Expected: FAIL — neither `nextWorkingDay` nor the module exists.

- [ ] **Step 3: Add `nextWorkingDay` to `src/calendar/holidays.ts`**

```ts
/**
 * `date` itself if it is a working day, else the next one. Distinct from
 * addWorkingDays(date, n), which always advances at least one day — statutory filing
 * deadlines ("the 20th, or the next working day") need this form.
 */
export function nextWorkingDay(
  date: string, isHoliday: (d: string) => boolean = isLatvianHoliday,
): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  for (;;) {
    const iso = dt.toISOString().slice(0, 10);
    const day = dt.getUTCDay();
    if (day !== 0 && day !== 6 && !isHoliday(iso)) return iso;
    dt.setUTCDate(dt.getUTCDate() + 1);
  }
}
```

- [ ] **Step 4: Write `src/tax/filing-periods.ts`**

```ts
import { nextWorkingDay } from '../calendar/holidays.js';
import type { Periodicity } from './vat-settings.js';

export interface FilingPeriod {
  /** 'YYYY-MM' for monthly, 'YYYY-Qn' for quarterly. Stable — used as an API parameter. */
  label: string;
  fromDate: string; toDate: string;
  /** The 20th of the month following the period, rolled to the next working day. */
  dueDate: string;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Last calendar day of a month, via day 0 of the following month. */
function lastDayOf(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 0));
  return d.toISOString().slice(0, 10);
}

/** The 20th of the month after `toDate`'s month, rolled forward to a working day. */
function dueDateAfter(year: number, month: number): string {
  const y = month === 12 ? year + 1 : year;
  const m = month === 12 ? 1 : month + 1;
  return nextWorkingDay(`${y}-${pad(m)}-20`);
}

function monthlyPeriod(year: number, month: number): FilingPeriod {
  return {
    label: `${year}-${pad(month)}`,
    fromDate: `${year}-${pad(month)}-01`,
    toDate: lastDayOf(year, month),
    dueDate: dueDateAfter(year, month),
  };
}

function quarterlyPeriod(year: number, quarter: number): FilingPeriod {
  const endMonth = quarter * 3;
  return {
    label: `${year}-Q${quarter}`,
    fromDate: `${year}-${pad(endMonth - 2)}-01`,
    toDate: lastDayOf(year, endMonth),
    dueDate: dueDateAfter(year, endMonth),
  };
}

export function filingPeriodsFor(year: number, periodicity: Periodicity): FilingPeriod[] {
  return periodicity === 'monthly'
    ? Array.from({ length: 12 }, (_, i) => monthlyPeriod(year, i + 1))
    : Array.from({ length: 4 }, (_, i) => quarterlyPeriod(year, i + 1));
}

export function currentFilingPeriod(onDate: string, periodicity: Periodicity): FilingPeriod {
  const [y, m] = onDate.split('-').map(Number);
  return periodicity === 'monthly'
    ? monthlyPeriod(y!, m!)
    : quarterlyPeriod(y!, Math.floor((m! - 1) / 3) + 1);
}

export function filingPeriodByLabel(label: string, periodicity: Periodicity): FilingPeriod {
  if (periodicity === 'monthly') {
    const m = /^(\d{4})-(\d{2})$/.exec(label);
    const month = m ? Number(m[2]) : 0;
    if (!m || month < 1 || month > 12) throw new Error(`Invalid monthly filing period: "${label}"`);
    return monthlyPeriod(Number(m[1]), month);
  }
  const q = /^(\d{4})-Q([1-4])$/.exec(label);
  if (!q) throw new Error(`Invalid quarterly filing period: "${label}"`);
  return quarterlyPeriod(Number(q[1]), Number(q[2]));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/calendar tests/tax/filing-periods.test.ts`
Expected: PASS. If a `dueDate` expectation is off, check it against `isLatvianHoliday` and correct the expectation (see Step 1's note).

- [ ] **Step 6: Commit**

```bash
git add src/calendar/holidays.ts src/tax/filing-periods.ts tests/calendar/next-working-day.test.ts tests/tax/filing-periods.test.ts
git commit -m "feat(tax): filing periods with working-day due dates + nextWorkingDay helper

Claude-Session: https://claude.ai/code/session_01BQ5EiunbJpf7XY9Bge3gB1"
```

---

### Task 3: EC Sales List aggregation

**Files:**
- Create: `src/tax/ecsl.ts`
- Test: `tests/tax/ecsl.test.ts`

**Interfaces:**
- Consumes: `einvoice_lines` + `parties.country_code` + `inEcsl` / `ecslSupplyType` (plan 1); `escapeXml` from `src/xml/escape.js`.
- Produces: `EcslRow = { countryCode: string; vatNo: string; supplyType: 'goods' | 'services'; netCents: string; invoiceCount: number }`, `EcSalesList = { period: { fromDate: string; toDate: string }; rows: EcslRow[]; totalNetCents: string; issues: string[] }`, `ecSalesList(tx, ctx, { fromDate, toDate })`, `toPvn2Xml(list, { vatNo })`. Tasks 4–6 consume these.

- [ ] **Step 1: Write the failing test**

`tests/tax/ecsl.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { createParty } from '../../src/parties/parties.js';
import { sendInvoice } from '../../src/einvoice/outbound.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { ecSalesList, toPvn2Xml } from '../../src/tax/ecsl.js';
import type { EInvoice } from '../../src/einvoice/ubl.js';

const period = { fromDate: '2026-06-01', toDate: '2026-06-30' };
const salesAccounts = { receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721' };

async function seed(t: { firmId: string; clientCompanyId: string }) {
  return withTenant(ctx(t), async (tx) => {
    for (const [code, name, type] of [
      ['2310', 'Receivables', 'asset'], ['6110', 'Sales', 'income'], ['5721', 'Output VAT', 'liability'],
    ] as const) await createAccount(tx, ctx(t), { code, name, type });
    await openPeriod(tx, ctx(t), { year: 2026, month: 6 });
    const ee = await createParty(tx, ctx(t), { kind: 'customer', name: 'OU Eesti', regNo: '11111111', vatNo: 'EE101010101', countryCode: 'EE' });
    const lt = await createParty(tx, ctx(t), { kind: 'customer', name: 'UAB Lietuva', regNo: '22222222', vatNo: 'LT100001', countryCode: 'LT' });
    const noVat = await createParty(tx, ctx(t), { kind: 'customer', name: 'OU NoVat', regNo: '33333333', countryCode: 'EE' });
    return { ee: ee.id, lt: lt.id, noVat: noVat.id };
  });
}

function inv(number: string, lines: EInvoice['lines'], net: string, vat: string, grand: string): EInvoice {
  return {
    invoiceNumber: number, issueDate: '2026-06-15', currency: 'EUR',
    supplier: { name: 'SIA A', regNo: '40100000000', vatNo: 'LV40100000000' },
    customer: { name: 'C', regNo: '11111111', vatNo: 'EE101010101' },
    lines, netTotal: net, vatTotal: vat, grandTotal: grand,
  };
}

async function issue(t: { firmId: string; clientCompanyId: string }, invoice: EInvoice, customerPartyId: string) {
  return withTenant(ctx(t), (tx) => sendInvoice(tx, ctx(t), {
    invoice, recipientPeppolId: '0088:x', ap: new StubAccessPoint(), ...salesAccounts, customerPartyId,
  }));
}

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('groups intra-EU supplies by counterparty, country, and supply type', async () => {
  const t = await makeFirmAndClient();
  const p = await seed(t);
  await issue(t, inv('E-1', [
    { description: 'Goods', net: '500.00', vatRate: 21, vat: '0.00', vatCategory: 'K' },
    { description: 'Service', net: '300.00', vatRate: 21, vat: '0.00', vatCategory: 'AE' },
    { description: 'Domestic', net: '100.00', vatRate: 21, vat: '21.00', vatCategory: 'S' },
  ], '900.00', '21.00', '921.00'), p.ee);
  await issue(t, inv('E-2', [
    { description: 'More goods', net: '200.00', vatRate: 21, vat: '0.00', vatCategory: 'K' },
  ], '200.00', '0.00', '200.00'), p.ee);
  await issue(t, inv('E-3', [
    { description: 'LT goods', net: '400.00', vatRate: 21, vat: '0.00', vatCategory: 'K' },
  ], '400.00', '0.00', '400.00'), p.lt);

  const list = await withTenant(ctx(t), (tx) => ecSalesList(tx, ctx(t), period));

  expect(list.rows).toEqual([
    { countryCode: 'EE', vatNo: 'EE101010101', supplyType: 'goods', netCents: '70000', invoiceCount: 2 },
    { countryCode: 'EE', vatNo: 'EE101010101', supplyType: 'services', netCents: '30000', invoiceCount: 1 },
    { countryCode: 'LT', vatNo: 'LT100001', supplyType: 'goods', netCents: '40000', invoiceCount: 1 },
  ]);
  expect(list.totalNetCents).toBe('140000');   // the domestic line is excluded
  expect(list.issues).toEqual([]);
});

test('an intra-EU supply to a party with no VAT number becomes an issue, not a silent drop', async () => {
  const t = await makeFirmAndClient();
  const p = await seed(t);
  await issue(t, inv('E-4', [{ description: 'Goods', net: '150.00', vatRate: 21, vat: '0.00', vatCategory: 'K' }], '150.00', '0.00', '150.00'), p.noVat);

  const list = await withTenant(ctx(t), (tx) => ecSalesList(tx, ctx(t), period));
  expect(list.rows).toEqual([]);
  expect(list.issues.length).toBe(1);
  expect(list.issues[0]).toContain('OU NoVat');
  expect(list.issues[0]).toContain('E-4');
});

test('a supply with no linked customer party is reported as an issue', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  await withTenant(ctx(t), (tx) => sendInvoice(tx, ctx(t), {
    invoice: inv('E-5', [{ description: 'Goods', net: '10.00', vatRate: 21, vat: '0.00', vatCategory: 'K' }], '10.00', '0.00', '10.00'),
    recipientPeppolId: '0088:x', ap: new StubAccessPoint(), ...salesAccounts,   // no customerPartyId
  }));
  const list = await withTenant(ctx(t), (tx) => ecSalesList(tx, ctx(t), period));
  expect(list.rows).toEqual([]);
  expect(list.issues.join(' ')).toContain('E-5');
});

test('an empty period yields no rows and no issues', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  const list = await withTenant(ctx(t), (tx) => ecSalesList(tx, ctx(t), period));
  expect(list).toEqual({ period, rows: [], totalNetCents: '0', issues: [] });
});

test('the PVN 2 XML lists every row with its supply type', async () => {
  const t = await makeFirmAndClient();
  const p = await seed(t);
  await issue(t, inv('E-6', [{ description: 'Goods', net: '500.00', vatRate: 21, vat: '0.00', vatCategory: 'K' }], '500.00', '0.00', '500.00'), p.ee);
  const list = await withTenant(ctx(t), (tx) => ecSalesList(tx, ctx(t), period));
  const xml = toPvn2Xml(list, { vatNo: 'LV40100000000' });
  expect(xml).toContain('<EcSalesList>');
  expect(xml).toContain('<DeclarantVatNo>LV40100000000</DeclarantVatNo>');
  expect(xml).toContain('<Row country="EE" vatNo="EE101010101" supplyType="goods" net="500.00"/>');
  expect(xml).toContain('<TotalNet>500.00</TotalNet>');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tax/ecsl.test.ts`
Expected: FAIL — `Cannot find module '../../src/tax/ecsl.js'`.

- [ ] **Step 3: Write `src/tax/ecsl.ts`**

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { escapeXml } from '../xml/escape.js';
import { centsToDecimal } from './money-format.js';

export interface EcslRow {
  countryCode: string; vatNo: string;
  supplyType: 'goods' | 'services';
  netCents: string;
  invoiceCount: number;
}

export interface EcSalesList {
  period: { fromDate: string; toDate: string };
  rows: EcslRow[];
  totalNetCents: string;
  /**
   * Supplies that belong on the list but cannot be reported — no linked customer party,
   * or a party with no VAT number. VID rejects such a row outright, so these are surfaced
   * for the operator to fix rather than dropped.
   */
  issues: string[];
}

/**
 * EC Sales List (PVN 2) for a period, from the OUTBOUND document lines whose VAT category
 * puts them on the list: K (intra-Community goods) and AE (reverse-charge services, where
 * the customer accounts for the VAT). The category carries the goods/services split — see
 * ecslSupplyType in src/tax/categories.ts.
 */
export async function ecSalesList(
  tx: PoolClient, ctx: TenantContext, period: { fromDate: string; toDate: string },
): Promise<EcSalesList> {
  const res = await tx.query(
    `SELECT p.country_code AS "countryCode", p.vat_no AS "vatNo", p.name AS "partyName",
            CASE el.vat_category WHEN 'K' THEN 'goods' ELSE 'services' END AS "supplyType",
            SUM(el.net_cents)::text AS "netCents",
            COUNT(DISTINCT e.id)::int AS "invoiceCount"
     FROM einvoice_lines el
     JOIN einvoices e ON e.id = el.einvoice_id
     LEFT JOIN parties p ON p.id = e.customer_party_id
     WHERE el.client_company_id = $1
       AND e.direction = 'outbound'
       AND e.issue_date BETWEEN $2 AND $3
       AND el.vat_category IN ('K','AE')
     GROUP BY p.country_code, p.vat_no, p.name, "supplyType"
     ORDER BY p.country_code NULLS LAST, p.vat_no NULLS LAST, "supplyType"`,
    [ctx.clientCompanyId, period.fromDate, period.toDate],
  );

  const rows: EcslRow[] = [];
  const unreportable: { partyName: string | null; supplyType: string; netCents: string }[] = [];
  for (const r of res.rows) {
    if (!r.vatNo || !r.countryCode) {
      unreportable.push({ partyName: r.partyName ?? null, supplyType: r.supplyType, netCents: r.netCents });
      continue;
    }
    rows.push({
      countryCode: r.countryCode, vatNo: r.vatNo, supplyType: r.supplyType,
      netCents: r.netCents, invoiceCount: r.invoiceCount,
    });
  }

  // Name the offending invoices so the issue is actionable.
  const issues: string[] = [];
  if (unreportable.length > 0) {
    const bad = await tx.query(
      `SELECT DISTINCT e.invoice_number AS "invoiceNumber", p.name AS "partyName"
       FROM einvoice_lines el
       JOIN einvoices e ON e.id = el.einvoice_id
       LEFT JOIN parties p ON p.id = e.customer_party_id
       WHERE el.client_company_id = $1
         AND e.direction = 'outbound'
         AND e.issue_date BETWEEN $2 AND $3
         AND el.vat_category IN ('K','AE')
         AND (e.customer_party_id IS NULL OR p.vat_no IS NULL OR p.vat_no = '')
       ORDER BY e.invoice_number`,
      [ctx.clientCompanyId, period.fromDate, period.toDate],
    );
    for (const b of bad.rows) {
      issues.push(
        `Invoice ${b.invoiceNumber}: intra-EU supply to ${b.partyName ?? 'an unlinked customer'} has no counterparty VAT number — it cannot be reported on the EC Sales List`,
      );
    }
  }

  const totalNetCents = rows.reduce((a, r) => a + BigInt(r.netCents), 0n).toString();
  return { period, rows, totalNetCents, issues };
}

/**
 * Representative PVN 2 XML. Exact VID element names are finalized with tax-advisor input
 * (same standing caveat as toEdsXml). Generated for review/manual EDS upload — nothing
 * transmits it; there is no filing-submission path in the codebase.
 */
export function toPvn2Xml(list: EcSalesList, declarant: { vatNo: string | null }): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<EcSalesList>',
    `  <DeclarantVatNo>${escapeXml(declarant.vatNo ?? '')}</DeclarantVatNo>`,
    `  <PeriodFrom>${list.period.fromDate}</PeriodFrom>`,
    `  <PeriodTo>${list.period.toDate}</PeriodTo>`,
    ...list.rows.map((r) =>
      `  <Row country="${escapeXml(r.countryCode)}" vatNo="${escapeXml(r.vatNo)}" supplyType="${r.supplyType}" net="${centsToDecimal(r.netCents)}"/>`),
    `  <TotalNet>${centsToDecimal(list.totalNetCents)}</TotalNet>`,
    '</EcSalesList>',
  ].join('\n');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/tax/ecsl.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tax/ecsl.ts tests/tax/ecsl.test.ts
git commit -m "feat(tax): EC Sales List (PVN 2) aggregation with unreportable-supply issues

Claude-Session: https://claude.ai/code/session_01BQ5EiunbJpf7XY9Bge3gB1"
```

---

### Task 4: The ECSL approval proposal

**Files:**
- Create: `src/tax/ecsl-proposal.ts`
- Modify: `src/proposals/proposals.ts`, `src/proposals/material.ts`
- Test: `tests/tax/ecsl-proposal.test.ts`

**Interfaces:**
- Consumes: `ecSalesList`, `toPvn2Xml` (Task 3); `getVatSettings` (Task 1); `createProposal` + `Rationale` from `src/proposals/proposals.js`; `resolveAutonomy` from `src/autonomy/autonomy.js`.
- Produces: `createEcslProposal(tx, ctx, { fromDate, toDate }): Promise<{ proposalId: string; list: EcSalesList }>`.

`autonomy_policy.operation_type` is free text with no CHECK, so the ECSL reuses the `'declaration'` autonomy operation rather than introducing a new one — the guardrail (a filing may never auto-submit) is identical. `approveHandler` in `src/api/handlers.ts` already falls through to "approval only, no ledger post" for any type that is not `posting` / `bank_match`, so an `ecsl` proposal needs no handler change.

- [ ] **Step 1: Write the failing test**

`tests/tax/ecsl-proposal.test.ts` — reuse the seeding helpers from `tests/tax/ecsl.test.ts` (copy them into this file; do not export test helpers across files):

```ts
test('creates a pending-approval ecsl proposal carrying the PVN 2 XML', async () => {
  const t = await makeFirmAndClient();
  const p = await seed(t);
  await issue(t, inv('P-1', [{ description: 'Goods', net: '500.00', vatRate: 21, vat: '0.00', vatCategory: 'K' }], '500.00', '0.00', '500.00'), p.ee);

  const { proposalId, list } = await withTenant(ctx(t), (tx) =>
    createEcslProposal(tx, ctx(t), { fromDate: '2026-06-01', toDate: '2026-06-30' }));

  expect(list.rows.length).toBe(1);
  const prop = await withTenant(ctx(t), (tx) => getProposal(tx, ctx(t), proposalId));
  expect(prop.type).toBe('ecsl');
  expect(prop.status).toBe('pending_approval');
  expect(String(prop.rationale.xml)).toContain('<EcSalesList>');
});

test('an ecsl proposal is always material for the owner view', async () => {
  const t = await makeFirmAndClient();
  const p = await seed(t);
  await issue(t, inv('P-2', [{ description: 'Goods', net: '500.00', vatRate: 21, vat: '0.00', vatCategory: 'K' }], '500.00', '0.00', '500.00'), p.ee);
  await withTenant(ctx(t), (tx) => createEcslProposal(tx, ctx(t), { fromDate: '2026-06-01', toDate: '2026-06-30' }));
  const material = await withTenant(ctx(t), (tx) => listMaterialApprovals(tx, ctx(t)));
  expect(material.map((m) => m.type)).toContain('ecsl');
});

test('unreportable supplies ride along on the proposal rationale', async () => {
  const t = await makeFirmAndClient();
  const p = await seed(t);
  await issue(t, inv('P-3', [{ description: 'Goods', net: '150.00', vatRate: 21, vat: '0.00', vatCategory: 'K' }], '150.00', '0.00', '150.00'), p.noVat);
  const { proposalId, list } = await withTenant(ctx(t), (tx) =>
    createEcslProposal(tx, ctx(t), { fromDate: '2026-06-01', toDate: '2026-06-30' }));
  expect(list.issues.length).toBe(1);
  const prop = await withTenant(ctx(t), (tx) => getProposal(tx, ctx(t), proposalId));
  expect(JSON.stringify(prop.rationale)).toContain('no counterparty VAT number');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tax/ecsl-proposal.test.ts`
Expected: FAIL — the module does not exist and `'ecsl'` is not a valid proposal type.

- [ ] **Step 3: Widen the proposal type**

In `src/proposals/proposals.ts`:

```ts
export type ProposalType = 'posting' | 'bank_match' | 'declaration' | 'task' | 'recurring_invoice' | 'ecsl';
```

and in the zod schema: `type: z.enum(['posting', 'bank_match', 'declaration', 'task', 'recurring_invoice', 'ecsl']),`

In `src/proposals/material.ts`, extend the always-material rule:

```ts
    if (row.type === 'declaration' || row.type === 'ecsl') return true; // filings are always material
```

- [ ] **Step 4: Write `src/tax/ecsl-proposal.ts`**

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { ecSalesList, toPvn2Xml, type EcSalesList } from './ecsl.js';
import { getVatSettings } from './vat-settings.js';
import { resolveAutonomy } from '../autonomy/autonomy.js';
import { createProposal, type Rationale } from '../proposals/proposals.js';

/**
 * Prepare an EC Sales List for approval. Like the VAT declaration, a filing may NEVER
 * auto-submit — the guardrail below is the same one createVatDeclarationProposal applies,
 * and it reuses the 'declaration' autonomy operation (autonomy_policy.operation_type is
 * free text, so no new operation or migration is needed).
 */
export async function createEcslProposal(
  tx: PoolClient, ctx: TenantContext, args: { fromDate: string; toDate: string },
): Promise<{ proposalId: string; list: EcSalesList }> {
  const list = await ecSalesList(tx, ctx, args);
  const settings = await getVatSettings(tx, ctx);
  const xml = toPvn2Xml(list, { vatNo: settings.vatNo });

  const mode = await resolveAutonomy(tx, ctx, 'declaration', { amountCents: 0n });
  if (mode !== 'approval') throw new Error('declaration must require approval');

  const rationale = {
    ruleRef: 'ecsl-pvn2',
    computation: `${list.rows.length} counterparty row(s), total net ${list.totalNetCents} cents`,
    sourceRefs: { period: list.period, rows: list.rows, issues: list.issues },
    xml,
  } as Rationale;

  const { id } = await createProposal(tx, ctx, {
    type: 'ecsl', payload: list, rationale, status: 'pending_approval',
  });
  return { proposalId: id, list };
}
```

If `resolveAutonomy`'s second argument shape differs (check `src/autonomy/autonomy.ts` and how `createVatDeclarationProposal` calls it), match that call exactly.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/tax/ecsl-proposal.test.ts tests/proposals`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tax/ecsl-proposal.ts src/proposals/proposals.ts src/proposals/material.ts tests/tax/ecsl-proposal.test.ts
git commit -m "feat(tax): approval-gated ecsl proposal type

Claude-Session: https://claude.ai/code/session_01BQ5EiunbJpf7XY9Bge3gB1"
```

---

### Task 5: Tabular models and export keys

**Files:**
- Modify: `src/reports/tabular.ts`
- Modify: `web/app/lib/report-labels.ts`
- Modify: `web/app/api/reports/export/route.ts`
- Modify: `web/app/lib/i18n.ts`
- Test: `tests/reports/tabular.test.ts` (extend)

**Interfaces:**
- Consumes: `VatDeclaration` (plan 1 Task 10), `EcSalesList` (Task 3).
- Produces: `vatReturnTable(d: VatDeclaration, labels: ReportLabels): ReportTable` and `ecslTable(list: EcSalesList, labels: ReportLabels): ReportTable`; `ReportLabels` gains `vatReturn`, `ecsl`, `category`, `salesNet`, `salesVat`, `purchaseNet`, `purchaseVat`, `selfAssessedVat`, `country`, `vatNo`, `supplyType`, `goods`, `services`, `invoices`, `outputVat`, `inputVat`, `netPayable`, `reconciled`, `notReconciled`. The `/filings` page (Task 7) reuses both builders through the export route.

- [ ] **Step 1: Write the failing test**

Append to `tests/reports/tabular.test.ts`:

```ts
import { vatReturnTable, ecslTable } from '../../src/reports/tabular.js';

const labels = /* reuse this file's existing test labels object */;

test('the VAT return table lists totals then one row per category', () => {
  const table = vatReturnTable({
    period: { fromDate: '2026-06-01', toDate: '2026-06-30' },
    outputVat: '21.00', inputVat: '10.50', netPayable: '10.50',
    ruleRef: { ruleType: 'vat_standard_rate', value: '21', effectiveFrom: '2013-01-01' },
    reconciles: true,
    breakdown: {
      rows: [{ category: 'S', salesNetCents: '10000', salesVatCents: '2100', purchaseNetCents: '5000', purchaseVatCents: '1050', selfAssessedVatCents: '0', selfAssessedDeductibleCents: '0' }],
      documentOutputVatCents: '2100', documentInputVatCents: '1050',
    },
  }, labels);

  expect(table.rows.some((r) => r.cells.includes('21.00'))).toBe(true);
  expect(table.rows.some((r) => r.cells[0] === 'S')).toBe(true);
  expect(table.meta.some((m) => m.value === '2026-06-01 – 2026-06-30')).toBe(true);
});

test('the ECSL table lists one row per counterparty and supply type', () => {
  const table = ecslTable({
    period: { fromDate: '2026-06-01', toDate: '2026-06-30' },
    rows: [
      { countryCode: 'EE', vatNo: 'EE101010101', supplyType: 'goods', netCents: '70000', invoiceCount: 2 },
      { countryCode: 'LT', vatNo: 'LT100001', supplyType: 'services', netCents: '40000', invoiceCount: 1 },
    ],
    totalNetCents: '110000', issues: [],
  }, labels);

  expect(table.rows.filter((r) => r.kind === 'data').length).toBe(2);
  expect(table.rows.at(-1)!.kind).toBe('subtotal');
  expect(table.rows.at(-1)!.cells).toContain('1100.00');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/reports/tabular.test.ts`
Expected: FAIL — neither builder is exported.

- [ ] **Step 3: Add the labels**

In `src/reports/tabular.ts`, extend the `ReportLabels` interface with the names listed in **Interfaces** above. In `web/app/lib/report-labels.ts`, map each one to a new i18n key (`filings.*`). In `web/app/lib/i18n.ts`, add all of them to EN, LV, and RU:

```ts
  'filings.title': 'Filings',
  'filings.tab.vatreturn': 'VAT return',
  'filings.tab.ecsl': 'EC Sales List',
  'filings.period': 'Filing period',
  'filings.due': 'Due',
  'filings.prepare': 'Prepare for approval',
  'filings.prepared': 'Prepared — awaiting approval',
  'filings.approved': 'Approved — ready to file',
  'filings.downloadXml': 'Download XML',
  'filings.reconciled': 'Ledger and documents agree',
  'filings.notReconciled': 'Ledger and documents disagree',
  'filings.issues': 'Cannot be reported',
  'filings.col.category': 'VAT treatment',
  'filings.col.salesNet': 'Sales (net)',
  'filings.col.salesVat': 'Sales VAT',
  'filings.col.purchaseNet': 'Purchases (net)',
  'filings.col.purchaseVat': 'Purchase VAT',
  'filings.col.selfAssessedVat': 'Self-assessed VAT',
  'filings.col.country': 'Country',
  'filings.col.vatNo': 'VAT number',
  'filings.col.supplyType': 'Supply',
  'filings.col.invoices': 'Invoices',
  'filings.goods': 'Goods',
  'filings.services': 'Services',
  'filings.outputVat': 'Output VAT',
  'filings.inputVat': 'Input VAT',
  'filings.netPayable': 'Net payable',
  'filings.settings': 'VAT settings',
  'filings.vatNo': 'VAT number',
  'filings.periodicity': 'Filing frequency',
  'filings.periodicity.monthly': 'Monthly',
  'filings.periodicity.quarterly': 'Quarterly',
  'nav.filings': 'Filings',
  'nav.short.filings': 'Filings',
```

LV: `'Deklarācijas'`, `'PVN deklarācija'`, `'PVN 2 pārskats'`, `'Deklarācijas periods'`, `'Termiņš'`, `'Sagatavot apstiprināšanai'`, `'Sagatavots — gaida apstiprinājumu'`, `'Apstiprināts — gatavs iesniegšanai'`, `'Lejupielādēt XML'`, `'Virsgrāmata un dokumenti sakrīt'`, `'Virsgrāmata un dokumenti nesakrīt'`, `'Nevar iekļaut pārskatā'`, `'PVN režīms'`, `'Pārdošana (neto)'`, `'Pārdošanas PVN'`, `'Iepirkumi (neto)'`, `'Iepirkumu PVN'`, `'Pašaprēķinātais PVN'`, `'Valsts'`, `'PVN numurs'`, `'Piegāde'`, `'Rēķini'`, `'Preces'`, `'Pakalpojumi'`, `'Aprēķinātais PVN'`, `'Atskaitāmais PVN'`, `'Maksājamais PVN'`, `'PVN iestatījumi'`, `'PVN numurs'`, `'Deklarēšanas periodiskums'`, `'Reizi mēnesī'`, `'Reizi ceturksnī'`, `'Deklarācijas'`, `'Dekl.'`.

RU: `'Декларации'`, `'Декларация НДС'`, `'Отчёт PVN 2'`, `'Период декларации'`, `'Срок'`, `'Подготовить к утверждению'`, `'Подготовлено — ожидает утверждения'`, `'Утверждено — готово к подаче'`, `'Скачать XML'`, `'Главная книга и документы совпадают'`, `'Главная книга и документы не совпадают'`, `'Нельзя включить в отчёт'`, `'Режим НДС'`, `'Продажи (нетто)'`, `'НДС с продаж'`, `'Покупки (нетто)'`, `'НДС с покупок'`, `'Самостоятельно начисленный НДС'`, `'Страна'`, `'Номер НДС'`, `'Поставка'`, `'Счета'`, `'Товары'`, `'Услуги'`, `'Начисленный НДС'`, `'НДС к вычету'`, `'НДС к уплате'`, `'Настройки НДС'`, `'Номер НДС'`, `'Периодичность декларирования'`, `'Ежемесячно'`, `'Ежеквартально'`, `'Декларации'`, `'Декл.'`.

- [ ] **Step 4: Write the two builders**

Add to `src/reports/tabular.ts`, following the shape of `apAgingTable` (import the two result types at the top of the file):

```ts
export function vatReturnTable(d: VatDeclaration, labels: ReportLabels): ReportTable {
  return {
    title: labels.vatReturn,
    meta: [
      { label: labels.period, value: `${d.period.fromDate} – ${d.period.toDate}` },
      { label: labels.outputVat, value: d.outputVat },
      { label: labels.inputVat, value: d.inputVat },
      { label: labels.netPayable, value: d.netPayable },
      { label: labels.reconciled, value: d.reconciles ? labels.reconciled : labels.notReconciled },
    ],
    columns: [
      { key: 'category', label: labels.category, align: 'left' },
      { key: 'salesNet', label: labels.salesNet, align: 'right' },
      { key: 'salesVat', label: labels.salesVat, align: 'right' },
      { key: 'purchaseNet', label: labels.purchaseNet, align: 'right' },
      { key: 'purchaseVat', label: labels.purchaseVat, align: 'right' },
      { key: 'selfAssessedVat', label: labels.selfAssessedVat, align: 'right' },
    ],
    rows: d.breakdown.rows.map((r) => ({
      kind: 'data' as const,
      cells: [
        r.category,
        centsToMoney(r.salesNetCents), centsToMoney(r.salesVatCents),
        centsToMoney(r.purchaseNetCents), centsToMoney(r.purchaseVatCents),
        centsToMoney(r.selfAssessedVatCents),
      ],
    })),
  };
}

export function ecslTable(list: EcSalesList, labels: ReportLabels): ReportTable {
  const rows: ReportRow[] = list.rows.map((r) => ({
    kind: 'data' as const,
    cells: [r.countryCode, r.vatNo, r.supplyType === 'goods' ? labels.goods : labels.services,
      String(r.invoiceCount), centsToMoney(r.netCents)],
  }));
  rows.push({ kind: 'subtotal', cells: ['', '', '', labels.total, centsToMoney(list.totalNetCents)] });
  return {
    title: labels.ecsl,
    meta: [{ label: labels.period, value: `${list.period.fromDate} – ${list.period.toDate}` }],
    columns: [
      { key: 'country', label: labels.country, align: 'left' },
      { key: 'vatNo', label: labels.vatNo, align: 'left' },
      { key: 'supplyType', label: labels.supplyType, align: 'left' },
      { key: 'invoices', label: labels.invoices, align: 'right' },
      { key: 'net', label: labels.amount, align: 'right' },
    ],
    rows,
  };
}
```

`centsToMoney` is whatever cents→string helper this file already uses for the aging tables (it may be `centsToDecimal` from `src/tax/money-format.js` or a local function) — reuse it, do not add another.

- [ ] **Step 5: Register the export keys**

In `web/app/api/reports/export/route.ts`: add `'vatreturn'` and `'ecsl'` to `REPORTS`, import `assembleVatDeclaration` / `ecSalesList` / `getVatSettings` / the two new builders, and add two `case` branches:

```ts
        case 'vatreturn':
          return vatReturnTable(await assembleVatDeclaration(tx, ctx, { fromDate: from, toDate: to, config: VAT_CONFIG }), L);
        case 'ecsl':
          return ecslTable(await ecSalesList(tx, ctx, { fromDate: from, toDate: to }), L);
```

with `const VAT_CONFIG = { outputVatAccount: process.env.VAT_OUTPUT_ACCOUNT ?? '5721', inputVatAccount: process.env.VAT_INPUT_ACCOUNT ?? '5722' };` as a module constant, matching how the other routes declare env-overridable account codes. Both new reports are period-based, so leave the `stamp` expression alone (it already falls through to `${from}_${to}`).

- [ ] **Step 6: Run the tests and typecheck**

Run: `npx vitest run tests/reports && npx tsc --noEmit && cd web && npx tsc --noEmit`
Expected: PASS and clean. A missing LV or RU key fails the web typecheck.

- [ ] **Step 7: Commit**

```bash
git add src/reports/tabular.ts web/app/lib/report-labels.ts web/app/lib/i18n.ts web/app/api/reports/export/route.ts tests/reports/tabular.test.ts
git commit -m "feat(reports): VAT-return + EC Sales List tabular models and export keys

Claude-Session: https://claude.ai/code/session_01BQ5EiunbJpf7XY9Bge3gB1"
```

---

### Task 6: Filings and VAT-settings API routes

**Files:**
- Create: `web/app/api/filings/vat-return/route.ts`, `web/app/api/filings/ecsl/route.ts`, `web/app/api/vat-settings/route.ts`
- Test: none (web route handlers are thin and untested by convention — `tests/api/` covers only the shared `src/api/handlers.ts`; the domain is already covered by Tasks 1–4)

**Interfaces:**
- Consumes: `assembleVatDeclaration`, `createVatDeclarationProposal`, `ecSalesList`, `createEcslProposal`, `getVatSettings`, `setVatSettings`, `filingPeriodByLabel`, `currentFilingPeriod`.
- Produces: the HTTP contract the page in Task 7 consumes — `GET /api/filings/vat-return?clientCompanyId&period` → `{ period, declaration }`; `GET /api/filings/ecsl?clientCompanyId&period` → `{ period, list }`; `POST` on each with `{ clientCompanyId, period }` → `{ proposalId }`; `GET /api/vat-settings?clientCompanyId` → `{ settings }`; `POST /api/vat-settings` with `{ clientCompanyId, vatNo, periodicity }` → `{ ok: true }`.

- [ ] **Step 1: Read an existing route as the template**

Run: `cat web/app/api/periods/route.ts`
That file is the canonical GET+POST shape: `runtime`/`dynamic` exports, `getSessionToken`, `resolveTenantContext`, `assertRoleAllowed`, `withTenant`, `errorToStatus`. Follow it exactly.

- [ ] **Step 2: Write `web/app/api/vat-settings/route.ts`**

GET: resolve the context, `withTenant(ctx, (tx) => getVatSettings(tx, ctx))`, return `{ settings }`. No authz gate on the read (it is client-scoped configuration, like the invoice profile GET).

POST: body `{ clientCompanyId, vatNo, periodicity }`; 400 when `clientCompanyId` is missing or `periodicity` is neither `'monthly'` nor `'quarterly'`; then `assertRoleAllowed(ctx.actorRole, 'vat.settings.write')` and `setVatSettings`. Return `{ ok: true }`.

- [ ] **Step 3: Write `web/app/api/filings/vat-return/route.ts`**

Resolve the period from the query first, because both verbs need it:

```ts
async function resolvePeriod(tx: PoolClient, ctx: TenantContext, label: string | null) {
  const { periodicity } = await getVatSettings(tx, ctx);
  return label ? filingPeriodByLabel(label, periodicity) : currentFilingPeriod(new Date().toISOString().slice(0, 10), periodicity);
}
```

GET returns `{ period, declaration: await assembleVatDeclaration(tx, ctx, { fromDate: period.fromDate, toDate: period.toDate, config: VAT_CONFIG }) }`, with `VAT_CONFIG` declared as the same env-overridable module constant used in Task 5.

POST calls `assertRoleAllowed(ctx.actorRole, 'filings.prepare')` and then `createVatDeclarationProposal(tx, ctx, { fromDate, toDate, config: VAT_CONFIG })`, returning `{ proposalId }` with status 201.

An invalid period label makes `filingPeriodByLabel` throw; `errorToStatus` maps it to 403, which is wrong for a client-fixable input, so validate the label shape yourself and return 400:

```ts
  const label = req.nextUrl.searchParams.get('period');
  if (label !== null && !/^\d{4}-(\d{2}|Q[1-4])$/.test(label)) {
    return NextResponse.json({ error: 'invalid period' }, { status: 400 });
  }
```

- [ ] **Step 4: Write `web/app/api/filings/ecsl/route.ts`**

The same structure: GET returns `{ period, list: await ecSalesList(tx, ctx, { fromDate, toDate }) }`; POST gates on `'filings.prepare'` and calls `createEcslProposal`, returning `{ proposalId }` with 201. Same period-label validation.

- [ ] **Step 5: Typecheck and smoke-test**

Run: `cd web && npx tsc --noEmit`, then `npm run dev` and, signed in:
```
curl -s 'http://localhost:3000/api/filings/vat-return?clientCompanyId=<id>&period=2026-06' -H 'cookie: <session>'
curl -s 'http://localhost:3000/api/filings/ecsl?clientCompanyId=<id>&period=2026-Q2' -H 'cookie: <session>'
```
Expected: 200 with the documented shapes. Easiest way to get a session: `GET /api/dev/bootstrap` (dev-only) then reuse its cookie.

- [ ] **Step 6: Commit**

```bash
git add web/app/api/filings web/app/api/vat-settings
git commit -m "feat(web): filings + VAT-settings API routes

Claude-Session: https://claude.ai/code/session_01BQ5EiunbJpf7XY9Bge3gB1"
```

---

### Task 7: The `/filings` page

**Files:**
- Create: `web/app/(cabinet)/filings/page.tsx`, `web/app/(cabinet)/filings/page.module.css`
- Modify: `web/app/components/Sidebar.tsx`, `web/app/components/NavIcon.tsx`

**Interfaces:**
- Consumes: the routes from Task 6 and the export keys from Task 5.
- Produces: the user-facing surface. Nothing consumes it.

- [ ] **Step 1: Read the model page**

Run: `sed -n '1,140p' web/app/\(cabinet\)/reports/page.tsx`
Copy its shape: `'use client'`, the client-company context hook, `useI18n`, tab state, `fetch` with `cache: 'no-store'`, the CSV/Excel/PDF button group pointing at `/api/reports/export`, and CSS-module classes. Do not invent a new page skeleton.

- [ ] **Step 2: Add the nav icon**

In `web/app/components/NavIcon.tsx`, add `'filings'` to the icon-name union and an entry to the icon map: an inline stroked SVG using `currentColor` at ~1.5px, in the style of the neighbouring icons (a document with a stamp/check reads well). No emoji, no icon font.

- [ ] **Step 3: Add the nav entry**

In `web/app/components/Sidebar.tsx`, add `'nav.filings'` / `'nav.short.filings'` to both key unions and one entry to **both** nav arrays (the firm-side and client-side lists — check which roles each array serves and place `filings` next to `reports` in each), `href: '/filings'`, `icon: 'filings'`.

- [ ] **Step 4: Build the page**

State: `tab: 'vatreturn' | 'ecsl'`, `periodLabel: string`, `settings`, `data`, `busy`, `error`.

On mount, `GET /api/vat-settings` to learn the periodicity, then default `periodLabel` to the current period for that periodicity (client-side: `YYYY-MM`, or `YYYY-Qn` from the month) and fetch the active tab. Render:

- A period `<select>` built from the twelve months or four quarters of the selected year plus a year stepper; changing it refetches.
- The period's due date, from the API response's `period.dueDate`.
- **VAT return tab:** output VAT / input VAT / net payable as a summary row; then the per-category table (`breakdown.rows`) with the columns from Task 5; then the reconciliation indicator — reuse the `styles.unbalanced` treatment the reports page already applies to its balanced/unbalanced indicators, showing `filings.reconciled` or `filings.notReconciled`.
- **ECSL tab:** the counterparty table (country, VAT number, supply type, invoice count, net) with the total row, and — when `list.issues.length > 0` — an issues block listing each string under the `filings.issues` heading, in the same warning style.
- A **Prepare for approval** button per tab, POSTing to the matching route and, on success, showing `filings.prepared` with a link to the approval queue.
- CSV / Excel / PDF buttons per tab, linking to `/api/reports/export?report=vatreturn|ecsl&format=…&from=…&to=…&lang=…` — the same query shape the reports page builds.

Every string comes from `t(...)`; dates format via `LOCALE_FOR[lang]`.

- [ ] **Step 5: Build and check**

Run: `cd web && npx tsc --noEmit && npm run build`
Expected: clean typecheck, successful build.

- [ ] **Step 6: Walk the page in the browser**

Run `npm run seed` (root — note the login and TOTP), then `cd web && npm run dev`. Sign in and:
1. Open `/filings` — both tabs render for the current period with no crash on empty data.
2. Set the periodicity to quarterly in the settings control; the period picker switches to quarters.
3. Switch to the period containing the seeded intra-EU supply (Task 8) and confirm the ECSL row appears with the counterparty's VAT number.
4. Press **Prepare for approval** on the VAT return; confirm a pending proposal appears in the approval queue.
5. Export the VAT return as CSV and open it — the category rows must match the screen.

Expected: all five. Fix anything that does not before committing.

- [ ] **Step 7: Commit**

```bash
git add web/app
git commit -m "feat(web): /filings page — VAT return + EC Sales List with export

Claude-Session: https://claude.ai/code/session_01BQ5EiunbJpf7XY9Bge3gB1"
```

---

### Task 8: Demo seed data + final verification

**Files:**
- Modify: the seed script (`src/db/seed.ts` or whatever `npm run seed` runs — check `package.json`)
- Modify: `docs/ROADMAP-market-gaps.md`, `HANDOFF.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing — this is the closing task.

- [ ] **Step 1: Find the seed script**

Run: `grep -n '"seed"' package.json && ls src/dev`
Read how it creates its existing customers and invoices.

- [ ] **Step 2: Add one intra-EU customer and supply**

Add a customer with `countryCode: 'EE'`, `vatNo: 'EE101010101'`, and issue one invoice to them with a single `K` line (net 1500.00, `vatRate: 21`, `vat: '0.00'`) dated inside the seeded demo period, plus one vendor bill from an EE vendor with an `AE` line (net 800.00, rate 21, vat 0.00) so the reverse-charge posting and the ECSL both have data. Set the client's `vat_no` via `setVatSettings` so the PVN 2 XML has a declarant.

- [ ] **Step 3: Re-seed and verify end to end**

Run: `npm run seed`
Then, in the app: `/filings` → ECSL tab shows one EE goods row for 1500.00 with no issues; VAT return tab shows the `K` sales row and the `AE` purchase row with 168.00 self-assessed VAT, and the reconciliation indicator reads "agree".

Expected: exactly that. If reconciliation reports a disagreement on freshly seeded data, stop — that is a real bug in the breakdown or the posting, not a seeding problem.

- [ ] **Step 4: Full verification**

Run, one at a time (never two vitest suites at once):
```bash
npm test
npx tsc --noEmit
cd web && npx tsc --noEmit && npm run build
```
Expected: all green. Record the test count; it should exceed the 609 from M6 by roughly 40.

- [ ] **Step 5: Update the docs**

In `docs/ROADMAP-market-gaps.md`, rewrite the M9 row: status `🔶` (not ✅ — Intrastat, OSS, and the cash-accounting scheme remain), dated 2026-07-29, naming what shipped (category model, BT-151 fix, reverse-charge self-assessment, category breakdown + reconciliation, EC Sales List, filing periodicity, `/filings`) and what did not, and pointing at the spec plus both plans. Update the "Suggested sequencing" paragraph so M9 is no longer listed as unstarted.

In `HANDOFF.md`, add a progress entry in the same style as the M6 and M1 ones, and record the known debt explicitly: no filing-submission path (approval is the terminus), `5721`/`5722` still hard-coded env constants rather than per-client settings, VAT numbers format-checked but not VIES-validated, and Intrastat's `cn_code` / `net_mass_kg` columns present but unused.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs+seed: M9 slice A+B shipped — VAT categories, EN 16931 fix, EC Sales List

Claude-Session: https://claude.ai/code/session_01BQ5EiunbJpf7XY9Bge3gB1"
```

---

## Self-review — spec coverage

| Spec section | Task |
|---|---|
| §1 `vat_settings`, `proposals` `'ecsl'` type | 1 |
| §1 `einvoice_lines`, `bill_lines`, `parties.country_code` | plan 1 |
| §5 `filing-periods.ts`, `nextWorkingDay` | 2 |
| §5 `ecsl.ts` — grouping, goods/services split, issues, `toPvn2Xml` | 3 |
| §5 approval-gated filing proposals, never auto-submit | 4 |
| §6 `GET`/`POST /api/filings/*`, `/api/vat-settings` | 6 |
| §6 `filings.prepare`, `vat.settings.write`; no `filings.submit` | 1 (ops), 6 (enforcement) |
| §6 `/filings` page, tabs, period picker, reconciliation indicator, issues list | 7 |
| §6 CSV/Excel/PDF via the existing export machinery | 5 |
| §6 nav entry + i18n in three catalogs | 5 (keys), 7 (nav) |
| §7 tests | 1–5 |
| §7 demo seed data | 8 |
| Out-of-scope items recorded as known debt | 8 |

**Type consistency check:** `Periodicity` is defined once in `src/tax/vat-settings.ts` and imported by `filing-periods.ts` (Task 2), the routes (Task 6), and the page (Task 7). `FilingPeriod.label` is the only period identifier crossing the HTTP boundary — the routes accept `period=<label>` and never `from`/`to` pairs, while the *export* route keeps its existing `from`/`to` contract, which the page derives from the fetched `period`. `EcSalesList` and `VatDeclaration` are consumed by name in Tasks 4, 5, 6, and 7 exactly as Task 3 and plan 1 Task 10 define them.
