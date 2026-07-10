# Payroll (Algas) Phase 1 — Calculation Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deterministic Latvian payroll calculation core — employee card, monthly tax-status data, orders (rīkojumi), gross→net calculation (IIN/VSAOI), average earnings, sick/vacation pay, vacation accrual, and journal postings — per `Algu_modula_darbibas_instrukcija_3.docx` sections 2.1, 3.1–3.4, 3.6–3.8, 4, and 8 (posms 1).

**Architecture:** New `src/payroll/` domain module following existing repo conventions: SQL migrations with RLS + minimal grants, pure functions taking `(tx, ctx, ...)`, money as integer cents (bigint) internally and `numeric(18,2)`/decimal strings at boundaries, every mutation audited via `appendAudit`, postings through the existing append-only `postEntry`. National payroll parameters are seeded into the existing global `tax_rules` table (regulation-as-code, date-versioned). The calculation itself (`computePayroll`) is a **pure function** — no DB, no AI, 100% repeatable, with an explanation trail (spec section 6: the strict core).

**Tech Stack:** TypeScript (ESM, Node 24), pg, zod, vitest. No new dependencies.

**Deliberately deferred (not in this plan):** VID EDS report generation (3.5) — last step per user decision; order PDF rendering + eParaksts signing (4.2); employee self-service portal (2.3, phase 3); AI layer (7.x, phase 4); business-trip orders and per-diem; LR public-holiday calendar (workday math is Mon–Fri; same known gap as `addWorkingDays` in `src/einvoice/vid.ts`); MUN-regime calculation (flag stored, calc refuses); web UI pages (separate plan). VSAOI annual-cap note: above the €105,300 cap, contributions legally continue at the same rates as solidarity tax, so withholding is unchanged — the cap drives a warning only (this intentionally diverges from the instruction doc's "stop calculating", which does not match VID practice).

**Decimal convention:** `toCents('25.5') = 2550n` — the same parser doubles for money (cents) and percentages (basis points, "bp"). All rounding is half-up at the final step of each component via `divRound`.

**Key 2026 parameter values (seeded, date-versioned):** IIN 25.5% to €105,300/yr (33% above), non-taxable minimum €550/mo, dependent relief €250/mo, disability relief €154/€120, VSAOI 10.5%/23.59% (cap €105,300), min wage €780, risk duty €0.36, night +50%, overtime/holiday +100%, sick A: day 1 unpaid / days 2–3 75% / days 4–9 80%, vacation 1.67 days/mo, deduction cap 20%.

---

### Task 1: Money helpers — `fromCents`, `divRound`, `applyBp`

**Files:**
- Modify: `src/db/money.ts`
- Create: `src/payroll/rates.ts`
- Test: `tests/payroll/money-math.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/payroll/money-math.test.ts
import { expect, test } from 'vitest';
import { fromCents, toCents } from '../../src/db/money.js';
import { applyBp, divRound } from '../../src/payroll/rates.js';

test('fromCents formats cents as a 2dp decimal string', () => {
  expect(fromCents(87077n)).toBe('870.77');
  expect(fromCents(0n)).toBe('0.00');
  expect(fromCents(5n)).toBe('0.05');
  expect(fromCents(-2423n)).toBe('-24.23');
  expect(toCents(fromCents(123456789n))).toBe(123456789n);
});

test('divRound divides with half-up rounding', () => {
  expect(divRound(10n, 4n)).toBe(3n);   // 2.5 -> 3
  expect(divRound(9n, 4n)).toBe(2n);    // 2.25 -> 2
  expect(divRound(550000n, 22n)).toBe(25000n);
  expect(() => divRound(1n, 0n)).toThrow();
});

test('applyBp applies a basis-point rate with half-up rounding', () => {
  // 10.5% of 1000.00 EUR = 105.00
  expect(applyBp(100000n, 1050n)).toBe(10500n);
  // 25.5% of 95.00 = 24.225 -> 24.23
  expect(applyBp(9500n, 2550n)).toBe(2423n);
  // 23.59% of 1000.00 = 235.90
  expect(applyBp(100000n, 2359n)).toBe(23590n);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/payroll/money-math.test.ts`
Expected: FAIL — `fromCents` is not exported / module `src/payroll/rates.ts` not found.

- [ ] **Step 3: Implement**

Append to `src/db/money.ts`:

```typescript
/** Format integer cents back to a 2dp decimal string ("87077n" -> "870.77"). Inverse of toCents. */
export function fromCents(cents: bigint): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}
```

Create `src/payroll/rates.ts`:

```typescript
/**
 * Integer math for payroll rates. Rates come from tax_rules as decimal strings and
 * are parsed with toCents into hundredths — for percentages that makes basis points:
 * '25.5' -> 2550n bp; for day counts: '1.67' -> 167n day-hundredths.
 * All amounts are non-negative integer cents; rounding is half-up.
 */

/** numerator/denominator with half-up rounding. Both must be >= 0, denominator > 0. */
export function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error(`divRound: denominator must be > 0, got ${denominator}`);
  return (2n * numerator + denominator) / (2n * denominator);
}

/** Apply a basis-point rate (2550n = 25.5%) to an amount in cents, half-up. */
export function applyBp(amountCents: bigint, rateBp: bigint): bigint {
  return divRound(amountCents * rateBp, 10000n);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/payroll/money-math.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/money.ts src/payroll/rates.ts tests/payroll/money-math.test.ts
git commit -m "feat(payroll): money helpers — fromCents, divRound, applyBp"
```

---

### Task 2: Payroll parameters — migration 023 + typed loader

National, date-versioned parameters go into the existing global `tax_rules` table (no tenant column, admin-written, app reads). `getTaxRate` already resolves "latest effective_from <= date".

**Files:**
- Create: `migrations/023_payroll_rules.sql`
- Create: `src/payroll/params.ts`
- Test: `tests/payroll/params.test.ts`

- [ ] **Step 1: Write the migration**

```sql
-- migrations/023_payroll_rules.sql
-- Latvian payroll parameters (regulation-as-code; extend with new dated rows on change).
-- Percent values are plain numbers ('25.5' = 25.5%); money values are EUR.
INSERT INTO tax_rules(rule_type, value, effective_from, note) VALUES
  ('payroll_iin_rate_basic', '25.5', '2025-01-01', 'IIN base rate'),
  ('payroll_iin_rate_top', '33', '2025-01-01', 'IIN rate above the annual threshold'),
  ('payroll_iin_threshold_annual', '105300', '2025-01-01', 'IIN progressive threshold EUR/year (monthly = /12)'),
  ('payroll_nontaxable_minimum_monthly', '510', '2025-01-01', 'Fixed non-taxable minimum EUR/month'),
  ('payroll_nontaxable_minimum_monthly', '550', '2026-01-01', 'Fixed non-taxable minimum EUR/month (2026)'),
  ('payroll_dependent_relief_monthly', '250', '2022-01-01', 'Relief per dependent EUR/month'),
  ('payroll_disability_relief_group12_monthly', '154', '2021-01-01', 'Disability group I/II relief EUR/month'),
  ('payroll_disability_relief_group3_monthly', '120', '2021-01-01', 'Disability group III relief EUR/month'),
  ('payroll_vsaoi_rate_employee', '10.5', '2021-01-01', 'VSAOI employee share %'),
  ('payroll_vsaoi_rate_employer', '23.59', '2021-01-01', 'VSAOI employer share %'),
  ('payroll_vsaoi_cap_annual', '105300', '2025-01-01', 'VSAOI object cap EUR/year (above: solidarity tax, same rates)'),
  ('payroll_min_wage_monthly', '740', '2025-01-01', 'Minimum monthly wage EUR'),
  ('payroll_min_wage_monthly', '780', '2026-01-01', 'Minimum monthly wage EUR (2026)'),
  ('payroll_risk_duty_monthly', '0.36', '2022-01-01', 'Business risk state duty EUR/employee/month'),
  ('payroll_premium_night_pct', '50', '2021-01-01', 'Night work premium, % of rate (DL 67)'),
  ('payroll_premium_overtime_pct', '100', '2021-01-01', 'Overtime premium, % of rate (DL 68; Saeima may lower)'),
  ('payroll_premium_holiday_pct', '100', '2021-01-01', 'Public-holiday work premium, % of rate'),
  ('payroll_sick_pay_day2_3_pct', '75', '2021-01-01', 'A-lapa: sick days 2-3, % of average earnings'),
  ('payroll_sick_pay_day4_9_pct', '80', '2021-01-01', 'A-lapa: sick days 4-9, % of average earnings'),
  ('payroll_vacation_days_per_month', '1.67', '2021-01-01', 'Vacation accrual, working days per month'),
  ('payroll_deduction_cap_pct', '20', '2021-01-01', 'Cap on other deductions, % of payable amount (DL 80)');
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/payroll/params.test.ts
import { afterAll, beforeAll, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { adminPool } from '../../src/db/pool.js';
import { loadPayrollParams } from '../../src/payroll/params.js';

beforeAll(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('loads the 2026 parameter set as cents/basis points', async () => {
  const client = await adminPool.connect();
  try {
    const p = await loadPayrollParams(client, '2026-07-01');
    expect(p.iinRateBasicBp).toBe(2550n);
    expect(p.iinRateTopBp).toBe(3300n);
    expect(p.iinThresholdMonthlyCents).toBe(877500n); // 105300/12 = 8775.00
    expect(p.nontaxableMinimumCents).toBe(55000n);    // 2026 row, not 2025
    expect(p.dependentReliefCents).toBe(25000n);
    expect(p.disabilityReliefGroup12Cents).toBe(15400n);
    expect(p.disabilityReliefGroup3Cents).toBe(12000n);
    expect(p.vsaoiEmployeeBp).toBe(1050n);
    expect(p.vsaoiEmployerBp).toBe(2359n);
    expect(p.vsaoiCapAnnualCents).toBe(10530000n);
    expect(p.minWageMonthlyCents).toBe(78000n);
    expect(p.riskDutyMonthlyCents).toBe(36n);
    expect(p.premiumNightBp).toBe(5000n);
    expect(p.premiumOvertimeBp).toBe(10000n);
    expect(p.premiumHolidayBp).toBe(10000n);
    expect(p.sickDay23Bp).toBe(7500n);
    expect(p.sickDay49Bp).toBe(8000n);
    expect(p.vacationDaysPerMonthHundredths).toBe(167n);
    expect(p.deductionCapBp).toBe(2000n);
  } finally { client.release(); }
});

test('date-versioning: 2025 values before 2026', async () => {
  const client = await adminPool.connect();
  try {
    const p = await loadPayrollParams(client, '2025-06-01');
    expect(p.nontaxableMinimumCents).toBe(51000n);
    expect(p.minWageMonthlyCents).toBe(74000n);
  } finally { client.release(); }
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/payroll/params.test.ts`
Expected: FAIL — module `src/payroll/params.ts` not found.

- [ ] **Step 4: Implement the loader**

Create `src/payroll/params.ts`:

```typescript
import type { PoolClient } from 'pg';
import { getTaxRate } from '../tax/rules.js';
import { toCents } from '../db/money.js';

/** All national payroll parameters effective on one date, pre-parsed for integer math.
 *  Money fields are cents; *Bp fields are basis points ('25.5' -> 2550n). */
export interface PayrollParams {
  iinRateBasicBp: bigint;
  iinRateTopBp: bigint;
  iinThresholdMonthlyCents: bigint;
  nontaxableMinimumCents: bigint;
  dependentReliefCents: bigint;
  disabilityReliefGroup12Cents: bigint;
  disabilityReliefGroup3Cents: bigint;
  vsaoiEmployeeBp: bigint;
  vsaoiEmployerBp: bigint;
  vsaoiCapAnnualCents: bigint;
  minWageMonthlyCents: bigint;
  riskDutyMonthlyCents: bigint;
  premiumNightBp: bigint;
  premiumOvertimeBp: bigint;
  premiumHolidayBp: bigint;
  sickDay23Bp: bigint;
  sickDay49Bp: bigint;
  vacationDaysPerMonthHundredths: bigint;
  deductionCapBp: bigint;
}

export async function loadPayrollParams(tx: PoolClient, onDate: string): Promise<PayrollParams> {
  const v = async (ruleType: string) => toCents((await getTaxRate(tx, ruleType, onDate)).value);
  return {
    iinRateBasicBp: await v('payroll_iin_rate_basic'),
    iinRateTopBp: await v('payroll_iin_rate_top'),
    iinThresholdMonthlyCents: (await v('payroll_iin_threshold_annual')) / 12n, // 10530000/12 = 877500 exact
    nontaxableMinimumCents: await v('payroll_nontaxable_minimum_monthly'),
    dependentReliefCents: await v('payroll_dependent_relief_monthly'),
    disabilityReliefGroup12Cents: await v('payroll_disability_relief_group12_monthly'),
    disabilityReliefGroup3Cents: await v('payroll_disability_relief_group3_monthly'),
    vsaoiEmployeeBp: await v('payroll_vsaoi_rate_employee'),
    vsaoiEmployerBp: await v('payroll_vsaoi_rate_employer'),
    vsaoiCapAnnualCents: await v('payroll_vsaoi_cap_annual'),
    minWageMonthlyCents: await v('payroll_min_wage_monthly'),
    riskDutyMonthlyCents: await v('payroll_risk_duty_monthly'),
    premiumNightBp: await v('payroll_premium_night_pct'),
    premiumOvertimeBp: await v('payroll_premium_overtime_pct'),
    premiumHolidayBp: await v('payroll_premium_holiday_pct'),
    sickDay23Bp: await v('payroll_sick_pay_day2_3_pct'),
    sickDay49Bp: await v('payroll_sick_pay_day4_9_pct'),
    vacationDaysPerMonthHundredths: await v('payroll_vacation_days_per_month'),
    deductionCapBp: await v('payroll_deduction_cap_pct'),
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/payroll/params.test.ts`
Expected: PASS (2 tests). (`resetDb` re-runs all migrations, picking up 023.)

- [ ] **Step 6: Commit**

```bash
git add migrations/023_payroll_rules.sql src/payroll/params.ts tests/payroll/params.test.ts
git commit -m "feat(payroll): 2025/2026 LV payroll parameters as versioned tax_rules + typed loader"
```

---

### Task 3: Payroll settings — migration 024 + account mapping

Per-client settings: the MUN flag and the account codes the posting scheme (doc 3.4/3.7) writes to, with standard LV chart defaults. `ensurePayrollAccounts` creates any missing accounts in the client's chart.

**Files:**
- Create: `migrations/024_payroll_settings.sql`
- Create: `src/payroll/settings.ts`
- Test: `tests/payroll/settings.test.ts`

- [ ] **Step 1: Write the migration**

```sql
-- migrations/024_payroll_settings.sql
CREATE TABLE payroll_settings (
  client_company_id uuid PRIMARY KEY REFERENCES client_companies(id),
  mun_regime boolean NOT NULL DEFAULT false,
  acc_wage_expense text NOT NULL DEFAULT '7210',
  acc_severance_expense text NOT NULL DEFAULT '7230',
  acc_employer_vsaoi_expense text NOT NULL DEFAULT '7310',
  acc_risk_duty_expense text NOT NULL DEFAULT '7330',
  acc_wages_payable text NOT NULL DEFAULT '5610',
  acc_iin_payable text NOT NULL DEFAULT '5720',
  acc_vsaoi_payable text NOT NULL DEFAULT '57221',
  acc_risk_duty_payable text NOT NULL DEFAULT '5723',
  acc_other_deductions_payable text NOT NULL DEFAULT '5620',
  acc_vacation_accrual_liability text NOT NULL DEFAULT '5411',
  acc_vacation_accrual_vsaoi_liability text NOT NULL DEFAULT '5412'
);

ALTER TABLE payroll_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY payroll_settings_tenant_isolation ON payroll_settings
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON payroll_settings TO bookkeeping_app;
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/payroll/settings.test.ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { getPayrollSettings, ensurePayrollAccounts } from '../../src/payroll/settings.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('getPayrollSettings creates a default row on first read', async () => {
  const t = ctx(await makeFirmAndClient());
  const s = await withTenant(t, (tx) => getPayrollSettings(tx, t));
  expect(s.munRegime).toBe(false);
  expect(s.accWageExpense).toBe('7210');
  expect(s.accWagesPayable).toBe('5610');
  expect(s.accVacationAccrualLiability).toBe('5411');
});

test('ensurePayrollAccounts creates missing accounts once, idempotently', async () => {
  const t = ctx(await makeFirmAndClient());
  await withTenant(t, async (tx) => {
    await ensurePayrollAccounts(tx, t);
    await ensurePayrollAccounts(tx, t); // second call must not throw
    const res = await tx.query(
      "SELECT code, type FROM accounts WHERE client_company_id = $1 ORDER BY code",
      [t.clientCompanyId],
    );
    const codes = res.rows.map((r: { code: string }) => r.code);
    for (const c of ['5411', '5412', '5610', '5620', '5720', '5723', '57221', '7210', '7230', '7310', '7330']) {
      expect(codes).toContain(c);
    }
    expect(res.rows.find((r: { code: string; type: string }) => r.code === '7210')!.type).toBe('expense');
    expect(res.rows.find((r: { code: string; type: string }) => r.code === '5610')!.type).toBe('liability');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/payroll/settings.test.ts`
Expected: FAIL — module `src/payroll/settings.ts` not found.

- [ ] **Step 4: Implement**

Create `src/payroll/settings.ts`:

```typescript
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export interface PayrollSettings {
  munRegime: boolean;
  accWageExpense: string;
  accSeveranceExpense: string;
  accEmployerVsaoiExpense: string;
  accRiskDutyExpense: string;
  accWagesPayable: string;
  accIinPayable: string;
  accVsaoiPayable: string;
  accRiskDutyPayable: string;
  accOtherDeductionsPayable: string;
  accVacationAccrualLiability: string;
  accVacationAccrualVsaoiLiability: string;
}

const SELECT_COLS = `mun_regime AS "munRegime",
  acc_wage_expense AS "accWageExpense", acc_severance_expense AS "accSeveranceExpense",
  acc_employer_vsaoi_expense AS "accEmployerVsaoiExpense", acc_risk_duty_expense AS "accRiskDutyExpense",
  acc_wages_payable AS "accWagesPayable", acc_iin_payable AS "accIinPayable",
  acc_vsaoi_payable AS "accVsaoiPayable", acc_risk_duty_payable AS "accRiskDutyPayable",
  acc_other_deductions_payable AS "accOtherDeductionsPayable",
  acc_vacation_accrual_liability AS "accVacationAccrualLiability",
  acc_vacation_accrual_vsaoi_liability AS "accVacationAccrualVsaoiLiability"`;

/** Read the client's payroll settings, creating the default row on first use. */
export async function getPayrollSettings(tx: PoolClient, ctx: TenantContext): Promise<PayrollSettings> {
  await tx.query(
    'INSERT INTO payroll_settings(client_company_id) VALUES ($1) ON CONFLICT (client_company_id) DO NOTHING',
    [ctx.clientCompanyId],
  );
  const res = await tx.query(
    `SELECT ${SELECT_COLS} FROM payroll_settings WHERE client_company_id = $1`,
    [ctx.clientCompanyId],
  );
  return res.rows[0];
}

/** Standard LV chart entries for every account the payroll posting scheme touches (doc 3.4/3.7). */
const PAYROLL_ACCOUNTS: { key: keyof PayrollSettings; name: string; type: 'expense' | 'liability' }[] = [
  { key: 'accWageExpense', name: 'Darba algas (Wages expense)', type: 'expense' },
  { key: 'accSeveranceExpense', name: 'Atlaišanas pabalsti (Severance)', type: 'expense' },
  { key: 'accEmployerVsaoiExpense', name: 'Darba devēja VSAOI izmaksas', type: 'expense' },
  { key: 'accRiskDutyExpense', name: 'Riska nodevas izmaksas', type: 'expense' },
  { key: 'accWagesPayable', name: 'Norēķini par darba algu', type: 'liability' },
  { key: 'accIinPayable', name: 'IIN saistības', type: 'liability' },
  { key: 'accVsaoiPayable', name: 'VSAOI saistības', type: 'liability' },
  { key: 'accRiskDutyPayable', name: 'Riska nodevas saistības', type: 'liability' },
  { key: 'accOtherDeductionsPayable', name: 'Citi ieturējumi (uzturlīdzekļi u.c.)', type: 'liability' },
  { key: 'accVacationAccrualLiability', name: 'Uzkrātās saistības — atvaļinājumi', type: 'liability' },
  { key: 'accVacationAccrualVsaoiLiability', name: 'Uzkrātās saistības — VSAOI par atvaļinājumiem', type: 'liability' },
];

/** Create any missing payroll accounts in the client's chart. Idempotent. */
export async function ensurePayrollAccounts(tx: PoolClient, ctx: TenantContext): Promise<void> {
  const s = await getPayrollSettings(tx, ctx);
  for (const a of PAYROLL_ACCOUNTS) {
    await tx.query(
      `INSERT INTO accounts(client_company_id, code, name, type) VALUES ($1,$2,$3,$4)
       ON CONFLICT (client_company_id, code) DO NOTHING`,
      [ctx.clientCompanyId, s[a.key], a.name, a.type],
    );
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/payroll/settings.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add migrations/024_payroll_settings.sql src/payroll/settings.ts tests/payroll/settings.test.ts
git commit -m "feat(payroll): per-client payroll settings + LV default account mapping"
```

---

### Task 4: Employees — migration 025 + employee card domain

Employee card (doc 2.1), monthly tax-book status (doc 2.2 — refreshed every month, entered manually in phase 1), and opening history for average earnings (doc 2.1 last bullet).

**Files:**
- Create: `migrations/025_employees.sql`
- Create: `src/payroll/employees.ts`
- Test: `tests/payroll/employees.test.ts`

- [ ] **Step 1: Write the migration**

```sql
-- migrations/025_employees.sql
CREATE TABLE employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  first_name text NOT NULL,
  last_name text NOT NULL,
  personal_code text NOT NULL,
  position text NOT NULL,
  contract_no text NOT NULL,
  contract_date date NOT NULL,
  contract_type text NOT NULL CHECK (contract_type IN ('indefinite','fixed_term')),
  wage_type text NOT NULL CHECK (wage_type IN ('monthly','hourly')),
  wage numeric(12,2) NOT NULL CHECK (wage > 0),
  hired_on date NOT NULL,
  terminated_on date,
  opening_vacation_days numeric(6,2) NOT NULL DEFAULT 0,
  opening_balance_date date NOT NULL,  -- the date the employee entered THIS system (doc 2.1)
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_company_id, personal_code)
);
CREATE INDEX employees_client_idx ON employees(client_company_id);

CREATE TABLE employee_tax_status (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  year int NOT NULL,
  month int NOT NULL CHECK (month BETWEEN 1 AND 12),
  tax_book_active boolean NOT NULL,
  dependents int NOT NULL DEFAULT 0 CHECK (dependents >= 0),
  disability_group int NOT NULL DEFAULT 0 CHECK (disability_group BETWEEN 0 AND 3),
  UNIQUE (employee_id, year, month)
);

CREATE TABLE employee_opening_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  year int NOT NULL,
  month int NOT NULL CHECK (month BETWEEN 1 AND 12),
  avg_base_gross numeric(12,2) NOT NULL CHECK (avg_base_gross >= 0),
  worked_days int NOT NULL CHECK (worked_days >= 0),
  UNIQUE (employee_id, year, month)
);

ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees FORCE ROW LEVEL SECURITY;
CREATE POLICY employees_tenant_isolation ON employees
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

ALTER TABLE employee_tax_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_tax_status FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_tax_status_tenant_isolation ON employee_tax_status
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

ALTER TABLE employee_opening_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_opening_history FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_opening_history_tenant_isolation ON employee_opening_history
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON employees TO bookkeeping_app;
GRANT SELECT, INSERT, UPDATE ON employee_tax_status TO bookkeeping_app;
GRANT SELECT, INSERT ON employee_opening_history TO bookkeeping_app;
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/payroll/employees.test.ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import {
  createEmployee, getEmployee, listEmployees, updateEmployee,
  setMonthlyTaxStatus, taxStatusFor, importOpeningHistory,
} from '../../src/payroll/employees.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

const EMP = {
  firstName: 'Anna', lastName: 'Ozola', personalCode: '010190-12345', position: 'Grāmatvede',
  contractNo: 'DL-1', contractDate: '2026-01-02', contractType: 'indefinite' as const,
  wageType: 'monthly' as const, wage: '1000.00',
  hiredOn: '2026-01-02', openingVacationDays: '0', openingBalanceDate: '2026-01-02',
};

test('create / get / list / update an employee (audited)', async () => {
  const t = ctx(await makeFirmAndClient());
  const { id } = await withTenant(t, (tx) => createEmployee(tx, t, EMP));
  const e = await withTenant(t, (tx) => getEmployee(tx, t, id));
  expect(e.firstName).toBe('Anna');
  expect(e.wage).toBe('1000.00');
  expect(e.terminatedOn).toBeNull();

  await withTenant(t, (tx) => updateEmployee(tx, t, id, { wage: '1200.00' }));
  const e2 = await withTenant(t, (tx) => getEmployee(tx, t, id));
  expect(e2.wage).toBe('1200.00');

  const all = await withTenant(t, (tx) => listEmployees(tx, t));
  expect(all).toHaveLength(1);
});

test('rejects duplicate personal code in the same company', async () => {
  const t = ctx(await makeFirmAndClient());
  await withTenant(t, (tx) => createEmployee(tx, t, EMP));
  await expect(withTenant(t, (tx) => createEmployee(tx, t, { ...EMP, contractNo: 'DL-2' })))
    .rejects.toThrow(/duplicate key/i);
});

test('monthly tax status: upsert, exact hit, stale fallback, missing', async () => {
  const t = ctx(await makeFirmAndClient());
  const { id } = await withTenant(t, (tx) => createEmployee(tx, t, EMP));

  await withTenant(t, (tx) => setMonthlyTaxStatus(tx, t, id, {
    year: 2026, month: 5, taxBookActive: true, dependents: 1, disabilityGroup: 0,
  }));
  // upsert same month
  await withTenant(t, (tx) => setMonthlyTaxStatus(tx, t, id, {
    year: 2026, month: 5, taxBookActive: true, dependents: 2, disabilityGroup: 0,
  }));

  const exact = await withTenant(t, (tx) => taxStatusFor(tx, t, id, 2026, 5));
  expect(exact).toEqual({ taxBookActive: true, dependents: 2, disabilityGroup: 0, stale: false });

  const stale = await withTenant(t, (tx) => taxStatusFor(tx, t, id, 2026, 7));
  expect(stale).toEqual({ taxBookActive: true, dependents: 2, disabilityGroup: 0, stale: true });

  const missing = await withTenant(t, (tx) => taxStatusFor(tx, t, id, 2026, 4));
  expect(missing).toBeNull();
});

test('opening history import', async () => {
  const t = ctx(await makeFirmAndClient());
  const { id } = await withTenant(t, (tx) => createEmployee(tx, t, EMP));
  await withTenant(t, (tx) => importOpeningHistory(tx, t, id, [
    { year: 2025, month: 11, avgBaseGross: '950.00', workedDays: 20 },
    { year: 2025, month: 12, avgBaseGross: '950.00', workedDays: 21 },
  ]));
  const rows = await withTenant(t, (tx) =>
    tx.query('SELECT count(*)::int AS n FROM employee_opening_history WHERE employee_id = $1', [id]));
  expect(rows.rows[0].n).toBe(2);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/payroll/employees.test.ts`
Expected: FAIL — module `src/payroll/employees.ts` not found.

- [ ] **Step 4: Implement**

Create `src/payroll/employees.ts`:

```typescript
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appendAudit } from '../audit/audit.js';

export type ContractType = 'indefinite' | 'fixed_term';
export type WageType = 'monthly' | 'hourly';

export interface EmployeeRow {
  id: string; firstName: string; lastName: string; personalCode: string; position: string;
  contractNo: string; contractDate: string; contractType: ContractType;
  wageType: WageType; wage: string;
  hiredOn: string; terminatedOn: string | null;
  openingVacationDays: string; openingBalanceDate: string;
}

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const moneyStr = z.string().regex(/^\d+(\.\d{1,2})?$/);

const newEmployeeSchema = z.object({
  firstName: z.string().min(1), lastName: z.string().min(1),
  personalCode: z.string().regex(/^\d{6}-?\d{5}$/),
  position: z.string().min(1),
  contractNo: z.string().min(1), contractDate: dateStr,
  contractType: z.enum(['indefinite', 'fixed_term']),
  wageType: z.enum(['monthly', 'hourly']),
  wage: moneyStr,
  hiredOn: dateStr,
  openingVacationDays: z.string().regex(/^-?\d+(\.\d{1,2})?$/).default('0'),
  openingBalanceDate: dateStr,
});
export type NewEmployee = z.input<typeof newEmployeeSchema>;

const SELECT_COLS = `id, first_name AS "firstName", last_name AS "lastName",
  personal_code AS "personalCode", position, contract_no AS "contractNo",
  to_char(contract_date,'YYYY-MM-DD') AS "contractDate", contract_type AS "contractType",
  wage_type AS "wageType", wage::text AS wage,
  to_char(hired_on,'YYYY-MM-DD') AS "hiredOn",
  to_char(terminated_on,'YYYY-MM-DD') AS "terminatedOn",
  opening_vacation_days::text AS "openingVacationDays",
  to_char(opening_balance_date,'YYYY-MM-DD') AS "openingBalanceDate"`;

export async function createEmployee(tx: PoolClient, ctx: TenantContext, input: NewEmployee): Promise<{ id: string }> {
  const e = newEmployeeSchema.parse(input);
  const res = await tx.query(
    `INSERT INTO employees(client_company_id, first_name, last_name, personal_code, position,
       contract_no, contract_date, contract_type, wage_type, wage, hired_on,
       opening_vacation_days, opening_balance_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [ctx.clientCompanyId, e.firstName, e.lastName, e.personalCode, e.position,
     e.contractNo, e.contractDate, e.contractType, e.wageType, e.wage, e.hiredOn,
     e.openingVacationDays, e.openingBalanceDate],
  );
  const id = res.rows[0].id as string;
  await appendAudit(tx, ctx, { action: 'create', entityType: 'employee', entityId: id, before: null, after: e });
  return { id };
}

export async function getEmployee(tx: PoolClient, ctx: TenantContext, id: string): Promise<EmployeeRow> {
  const res = await tx.query(
    `SELECT ${SELECT_COLS} FROM employees WHERE id = $1 AND client_company_id = $2`,
    [id, ctx.clientCompanyId],
  );
  if (!res.rowCount) throw new Error(`Employee not found: ${id}`);
  return res.rows[0];
}

export async function listEmployees(tx: PoolClient, ctx: TenantContext): Promise<EmployeeRow[]> {
  const res = await tx.query(
    `SELECT ${SELECT_COLS} FROM employees WHERE client_company_id = $1 ORDER BY last_name, first_name`,
    [ctx.clientCompanyId],
  );
  return res.rows;
}

/** Employees employed at any point inside (year, month). */
export async function activeEmployeesFor(tx: PoolClient, ctx: TenantContext, year: number, month: number): Promise<EmployeeRow[]> {
  const first = `${year}-${String(month).padStart(2, '0')}-01`;
  const res = await tx.query(
    `SELECT ${SELECT_COLS} FROM employees
     WHERE client_company_id = $1
       AND hired_on <= (date_trunc('month', $2::date) + interval '1 month' - interval '1 day')::date
       AND (terminated_on IS NULL OR terminated_on >= $2::date)
     ORDER BY last_name, first_name`,
    [ctx.clientCompanyId, first],
  );
  return res.rows;
}

export async function updateEmployee(
  tx: PoolClient, ctx: TenantContext, id: string,
  patch: { wage?: string; position?: string; terminatedOn?: string | null },
): Promise<void> {
  const before = await getEmployee(tx, ctx, id);
  const merged = {
    wage: patch.wage !== undefined ? moneyStr.parse(patch.wage) : before.wage,
    position: patch.position ?? before.position,
    terminatedOn: patch.terminatedOn !== undefined ? patch.terminatedOn : before.terminatedOn,
  };
  await tx.query(
    `UPDATE employees SET wage=$1, position=$2, terminated_on=$3 WHERE id=$4 AND client_company_id=$5`,
    [merged.wage, merged.position, merged.terminatedOn, id, ctx.clientCompanyId],
  );
  await appendAudit(tx, ctx, { action: 'update', entityType: 'employee', entityId: id, before, after: merged });
}

export interface MonthlyTaxStatus { taxBookActive: boolean; dependents: number; disabilityGroup: number; }

/** Upsert the month's tax-book data (doc 2.2 — refreshed every month; manual in phase 1). */
export async function setMonthlyTaxStatus(
  tx: PoolClient, ctx: TenantContext, employeeId: string,
  s: { year: number; month: number } & MonthlyTaxStatus,
): Promise<void> {
  await tx.query(
    `INSERT INTO employee_tax_status(client_company_id, employee_id, year, month, tax_book_active, dependents, disability_group)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (employee_id, year, month)
     DO UPDATE SET tax_book_active = EXCLUDED.tax_book_active,
                   dependents = EXCLUDED.dependents,
                   disability_group = EXCLUDED.disability_group`,
    [ctx.clientCompanyId, employeeId, s.year, s.month, s.taxBookActive, s.dependents, s.disabilityGroup],
  );
  await appendAudit(tx, ctx, {
    action: 'update', entityType: 'employee_tax_status', entityId: employeeId,
    before: null, after: s,
  });
}

/**
 * Tax status for the month. Exact row -> stale:false. No exact row -> most recent
 * EARLIER month (stale:true — the run must warn per doc 2.2). Nothing at all -> null
 * (the run treats the tax book as inactive and warns).
 */
export async function taxStatusFor(
  tx: PoolClient, ctx: TenantContext, employeeId: string, year: number, month: number,
): Promise<(MonthlyTaxStatus & { stale: boolean }) | null> {
  const res = await tx.query(
    `SELECT year, month, tax_book_active AS "taxBookActive", dependents, disability_group AS "disabilityGroup"
     FROM employee_tax_status
     WHERE employee_id = $1 AND client_company_id = $2 AND (year*12 + month) <= $3
     ORDER BY year DESC, month DESC LIMIT 1`,
    [employeeId, ctx.clientCompanyId, year * 12 + month],
  );
  if (!res.rowCount) return null;
  const r = res.rows[0];
  return {
    taxBookActive: r.taxBookActive, dependents: r.dependents, disabilityGroup: r.disabilityGroup,
    stale: !(r.year === year && r.month === month),
  };
}

/** Import pre-system months for average-earnings (doc 2.1: last 6 months before entry). */
export async function importOpeningHistory(
  tx: PoolClient, ctx: TenantContext, employeeId: string,
  rows: { year: number; month: number; avgBaseGross: string; workedDays: number }[],
): Promise<void> {
  for (const r of rows) {
    await tx.query(
      `INSERT INTO employee_opening_history(client_company_id, employee_id, year, month, avg_base_gross, worked_days)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [ctx.clientCompanyId, employeeId, r.year, r.month, moneyStr.parse(r.avgBaseGross), r.workedDays],
    );
  }
  await appendAudit(tx, ctx, {
    action: 'create', entityType: 'employee_opening_history', entityId: employeeId,
    before: null, after: { rows },
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/payroll/employees.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add migrations/025_employees.sql src/payroll/employees.ts tests/payroll/employees.test.ts
git commit -m "feat(payroll): employee card, monthly tax status, opening history (migration 025)"
```

---

### Task 5: Workday calendar helpers

Pure date math, Mon–Fri only. **Known gap, documented on purpose:** LR public holidays are not subtracted — the same deferral as `addWorkingDays` in `src/einvoice/vid.ts` (HANDOFF #2). When the holiday calendar lands there, wire it here too.

**Files:**
- Create: `src/payroll/workdays.ts`
- Test: `tests/payroll/workdays.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/payroll/workdays.test.ts
import { expect, test } from 'vitest';
import { isWorkDay, workDaysInMonth, workDaysOverlap, lastDayOfMonth, calendarDays } from '../../src/payroll/workdays.js';

test('isWorkDay: Mon-Fri true, weekend false', () => {
  expect(isWorkDay('2026-07-06')).toBe(true);  // Monday
  expect(isWorkDay('2026-07-10')).toBe(true);  // Friday
  expect(isWorkDay('2026-07-11')).toBe(false); // Saturday
  expect(isWorkDay('2026-07-12')).toBe(false); // Sunday
});

test('workDaysInMonth', () => {
  expect(workDaysInMonth(2026, 7)).toBe(23);  // July 2026
  expect(workDaysInMonth(2026, 2)).toBe(20);  // Feb 2026
});

test('lastDayOfMonth', () => {
  expect(lastDayOfMonth(2026, 7)).toBe('2026-07-31');
  expect(lastDayOfMonth(2028, 2)).toBe('2028-02-29'); // leap year
});

test('workDaysOverlap clamps a range to one month and counts workdays', () => {
  // Vacation 2026-07-13 (Mon) .. 2026-07-24 (Fri) = 10 workdays, all in July
  expect(workDaysOverlap('2026-07-13', '2026-07-24', 2026, 7)).toBe(10);
  // Range spanning June->July counts only July days
  expect(workDaysOverlap('2026-06-29', '2026-07-03', 2026, 7)).toBe(3); // Jul 1,2,3
  // Disjoint range
  expect(workDaysOverlap('2026-05-01', '2026-05-10', 2026, 7)).toBe(0);
});

test('calendarDays iterates inclusive ISO dates', () => {
  expect([...calendarDays('2026-07-30', '2026-08-02')]).toEqual(
    ['2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/payroll/workdays.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/payroll/workdays.ts`:

```typescript
/**
 * Workday calendar, Mon-Fri. LR public holidays are NOT yet subtracted — same
 * documented deferral as addWorkingDays() in src/einvoice/vid.ts (HANDOFF #2).
 * All dates are ISO 'YYYY-MM-DD' strings, handled in UTC.
 */

const DAY_MS = 86_400_000;

function toUtc(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}
function toIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function isWorkDay(iso: string): boolean {
  const dow = new Date(toUtc(iso)).getUTCDay();
  return dow !== 0 && dow !== 6;
}

export function lastDayOfMonth(year: number, month: number): string {
  return toIso(Date.UTC(year, month, 0)); // day 0 of next month
}

export function firstDayOfMonth(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

/** Inclusive ISO date iterator. */
export function* calendarDays(fromIso: string, toIsoDate: string): Generator<string> {
  for (let t = toUtc(fromIso); t <= toUtc(toIsoDate); t += DAY_MS) yield toIso(t);
}

export function workDaysInMonth(year: number, month: number): number {
  return workDaysOverlap(firstDayOfMonth(year, month), lastDayOfMonth(year, month), year, month);
}

/** Workdays of [fromIso, toIso] that fall inside (year, month). */
export function workDaysOverlap(fromIso: string, toIsoDate: string, year: number, month: number): number {
  const lo = Math.max(toUtc(fromIso), toUtc(firstDayOfMonth(year, month)));
  const hi = Math.min(toUtc(toIsoDate), toUtc(lastDayOfMonth(year, month)));
  let n = 0;
  for (let t = lo; t <= hi; t += DAY_MS) if (isWorkDay(toIso(t))) n++;
  return n;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/payroll/workdays.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/payroll/workdays.ts tests/payroll/workdays.test.ts
git commit -m "feat(payroll): Mon-Fri workday calendar helpers"
```

---

### Task 6: The strict calculation core — `computePayroll` (pure, doc 3.1)

The fixed bruto→neto sequence as one pure function: no DB, no side effects, fully repeatable, with an explanation trail (doc section 6: AI never computes the number). The caller assembles the inputs; this function only runs the law.

**Files:**
- Create: `src/payroll/calc.ts`
- Test: `tests/payroll/calc.test.ts`

- [ ] **Step 1: Write the failing test**

Hand-verified against the 2026 rules (also cross-checks public 2026 salary calculators):

```typescript
// tests/payroll/calc.test.ts
import { expect, test } from 'vitest';
import { computePayroll, type PayrollCalcInput } from '../../src/payroll/calc.js';
import type { PayrollParams } from '../../src/payroll/params.js';

// Frozen 2026 parameter set (same values migration 023 seeds).
const P: PayrollParams = {
  iinRateBasicBp: 2550n, iinRateTopBp: 3300n, iinThresholdMonthlyCents: 877500n,
  nontaxableMinimumCents: 55000n, dependentReliefCents: 25000n,
  disabilityReliefGroup12Cents: 15400n, disabilityReliefGroup3Cents: 12000n,
  vsaoiEmployeeBp: 1050n, vsaoiEmployerBp: 2359n, vsaoiCapAnnualCents: 10530000n,
  minWageMonthlyCents: 78000n, riskDutyMonthlyCents: 36n,
  premiumNightBp: 5000n, premiumOvertimeBp: 10000n, premiumHolidayBp: 10000n,
  sickDay23Bp: 7500n, sickDay49Bp: 8000n,
  vacationDaysPerMonthHundredths: 167n, deductionCapBp: 2000n,
};

const BASE: PayrollCalcInput = {
  baseCents: 100000n, premiumCents: 0n, bonusCents: 0n, vacationPayCents: 0n,
  sickPayCents: 0n, otherTaxableCents: 0n, severanceExemptCents: 0n,
  taxBookActive: true, dependents: 0, disabilityGroup: 0,
  workedDays: 23, totalWorkDays: 23,
  requestedDeductionsCents: 0n, ytdVsaoiBaseCents: 0n,
};

test('standard month: 1000 EUR gross, tax book, 1 dependent -> net 870.77', () => {
  const r = computePayroll({ ...BASE, dependents: 1 }, P);
  expect(r.grossCents).toBe(100000n);
  expect(r.vsaoiEmployeeCents).toBe(10500n);     // 10.5%
  expect(r.nontaxableAppliedCents).toBe(55000n); // full month
  expect(r.dependentReliefCents).toBe(25000n);
  expect(r.iinBaseCents).toBe(9500n);            // 1000 - 105 - 550 - 250
  expect(r.iinCents).toBe(2423n);                // 25.5% of 95.00 = 24.225 -> 24.23
  expect(r.netCents).toBe(87077n);               // 870.77
  expect(r.payoutCents).toBe(87077n);
  expect(r.vsaoiEmployerCents).toBe(23590n);     // 23.59%
  expect(r.riskDutyCents).toBe(36n);
  expect(r.warnings).toEqual([]);
});

test('progressive IIN above the monthly threshold', () => {
  const r = computePayroll({ ...BASE, baseCents: 1100000n, dependents: 0 }, P);
  // VSAOI 1155.00; base 11000-1155-550 = 9295.00; 8775 @25.5% + 520 @33% = 2409.225 -> 2409.23
  expect(r.vsaoiEmployeeCents).toBe(115500n);
  expect(r.iinBaseCents).toBe(929500n);
  expect(r.iinCents).toBe(240923n);
});

test('no active tax book: no reliefs at all', () => {
  const r = computePayroll({ ...BASE, taxBookActive: false, dependents: 3, disabilityGroup: 2 }, P);
  expect(r.nontaxableAppliedCents).toBe(0n);
  expect(r.dependentReliefCents).toBe(0n);
  expect(r.disabilityReliefCents).toBe(0n);
  expect(r.iinBaseCents).toBe(89500n); // 1000 - 105
});

test('non-taxable minimum prorated for a partial month (doc 3.1 step 3)', () => {
  // Worked 10 of 22 workdays; base prorated by the caller to 454.55
  const r = computePayroll({ ...BASE, baseCents: 45455n, workedDays: 10, totalWorkDays: 22 }, P);
  expect(r.nontaxableAppliedCents).toBe(25000n); // 550 * 10/22 = 250.00
});

test('disability relief by group', () => {
  const g2 = computePayroll({ ...BASE, disabilityGroup: 2 }, P);
  expect(g2.disabilityReliefCents).toBe(15400n);
  const g3 = computePayroll({ ...BASE, disabilityGroup: 3 }, P);
  expect(g3.disabilityReliefCents).toBe(12000n);
});

test('IIN base never negative when reliefs exceed income', () => {
  const r = computePayroll({ ...BASE, baseCents: 40000n, dependents: 2 }, P);
  // 400 - 42 - 550 - 500 < 0 -> base 0, IIN 0
  expect(r.iinBaseCents).toBe(0n);
  expect(r.iinCents).toBe(0n);
});

test('other deductions capped at 20% of the payable amount (doc 3.1 step 6)', () => {
  const r = computePayroll({ ...BASE, requestedDeductionsCents: 50000n }, P);
  // payable before other deductions: 1000 - 105 - IIN(87.98) = 807.02; cap 20% = 161.40
  expect(r.iinCents).toBe(8798n); // (1000-105-550)*25.5% = 87.975 -> 87.98
  expect(r.deductionsAppliedCents).toBe(16140n);
  expect(r.netCents).toBe(80702n - 16140n);
  expect(r.warnings).toContain('deduction_capped');
});

test('statutory severance is paid out but never taxed (doc 3.8)', () => {
  const r = computePayroll({ ...BASE, severanceExemptCents: 100000n }, P);
  expect(r.grossCents).toBe(100000n);           // severance not in gross
  expect(r.payoutCents).toBe(r.netCents + 100000n);
});

test('below-minimum-wage warning for a full month', () => {
  const r = computePayroll({ ...BASE, baseCents: 70000n }, P);
  expect(r.warnings).toContain('below_minimum_wage');
  const partial = computePayroll({ ...BASE, baseCents: 70000n, workedDays: 15 }, P);
  expect(partial.warnings).not.toContain('below_minimum_wage');
});

test('VSAOI annual cap: warning only, withholding continues (solidarity tax)', () => {
  const r = computePayroll({ ...BASE, baseCents: 1000000n, ytdVsaoiBaseCents: 10000000n }, P);
  expect(r.vsaoiEmployeeCents).toBe(105000n); // still 10.5%
  expect(r.warnings).toContain('vsaoi_cap_reached');
});

test('every result carries a human-readable explanation trail', () => {
  const r = computePayroll({ ...BASE, dependents: 1 }, P);
  expect(r.explanation.length).toBeGreaterThanOrEqual(5);
  expect(r.explanation[0]!.step).toMatch(/bruto/i);
  for (const line of r.explanation) expect(line.amount).toMatch(/^-?\d+\.\d{2}$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/payroll/calc.test.ts`
Expected: FAIL — module `src/payroll/calc.ts` not found.

- [ ] **Step 3: Implement**

Create `src/payroll/calc.ts`:

```typescript
import { fromCents } from '../db/money.js';
import { applyBp, divRound } from './rates.js';
import type { PayrollParams } from './params.js';

/**
 * The strict calculation core (instruction doc 3.1 + section 6).
 * Pure and deterministic: same input -> same output, no DB, no AI.
 * The caller (run.ts) assembles the inputs; this function runs the fixed legal sequence.
 */

export interface PayrollCalcInput {
  baseCents: bigint;                // pay for time worked
  premiumCents: bigint;             // night/overtime/holiday supplements (doc 3.3)
  bonusCents: bigint;
  vacationPayCents: bigint;         // average-earnings based
  sickPayCents: bigint;             // employer A-lapa sick pay
  otherTaxableCents: bigint;
  severanceExemptCents: bigint;     // statutory severance: paid out, IIN- and VSAOI-exempt
  taxBookActive: boolean;
  dependents: number;
  disabilityGroup: 0 | 1 | 2 | 3;
  workedDays: number;               // prorates the non-taxable minimum
  totalWorkDays: number;
  requestedDeductionsCents: bigint; // maintenance / loans / union (doc 3.1 step 6)
  ytdVsaoiBaseCents: bigint;        // prior approved months' gross this calendar year
}

export interface ExplanationLine { step: string; amount: string; }

export interface PayrollCalcResult {
  grossCents: bigint;
  vsaoiEmployeeCents: bigint;
  nontaxableAppliedCents: bigint;
  dependentReliefCents: bigint;
  disabilityReliefCents: bigint;
  iinBaseCents: bigint;
  iinCents: bigint;
  deductionsAppliedCents: bigint;
  netCents: bigint;
  payoutCents: bigint;              // net + exempt severance
  vsaoiEmployerCents: bigint;
  riskDutyCents: bigint;
  warnings: string[];
  explanation: ExplanationLine[];
}

export function computePayroll(input: PayrollCalcInput, p: PayrollParams): PayrollCalcResult {
  const warnings: string[] = [];
  const explanation: ExplanationLine[] = [];
  const note = (step: string, cents: bigint) => explanation.push({ step, amount: fromCents(cents) });

  // 1. Gross = sum of taxable components (doc 3.1 step 1).
  const gross = input.baseCents + input.premiumCents + input.bonusCents
    + input.vacationPayCents + input.sickPayCents + input.otherTaxableCents;
  note('Bruto (pamatalga + piemaksas + prēmijas + atvaļinājums + slimības nauda + citi)', gross);

  // 2. Employee VSAOI (doc 3.1 step 2). Above the annual cap contributions continue
  //    at the same rates as solidarity tax, so withholding is unchanged — warn only.
  const vsaoiEmployee = applyBp(gross, p.vsaoiEmployeeBp);
  note('VSAOI darbinieka daļa', vsaoiEmployee);
  if (input.ytdVsaoiBaseCents + gross > p.vsaoiCapAnnualCents) warnings.push('vsaoi_cap_reached');

  // 3. Reliefs — only with an active tax book THIS month (doc 3.1 step 3).
  let nontaxable = 0n; let dependentRelief = 0n; let disabilityRelief = 0n;
  if (input.taxBookActive) {
    nontaxable = input.totalWorkDays > 0
      ? divRound(p.nontaxableMinimumCents * BigInt(input.workedDays), BigInt(input.totalWorkDays))
      : 0n;
    dependentRelief = p.dependentReliefCents * BigInt(input.dependents);
    disabilityRelief = input.disabilityGroup === 1 || input.disabilityGroup === 2
      ? p.disabilityReliefGroup12Cents
      : input.disabilityGroup === 3 ? p.disabilityReliefGroup3Cents : 0n;
    note('Neapliekamais minimums (proporcionāli nostrādātajam)', nontaxable);
    if (dependentRelief > 0n) note('Atvieglojums par apgādājamiem', dependentRelief);
    if (disabilityRelief > 0n) note('Invaliditātes atvieglojums', disabilityRelief);
  } else {
    note('Algas nodokļa grāmatiņa nav aktīva — atvieglojumi netiek piemēroti', 0n);
  }

  // 4. IIN base (doc 3.1 step 4), never negative.
  let iinBase = gross - vsaoiEmployee - nontaxable - dependentRelief - disabilityRelief;
  if (iinBase < 0n) iinBase = 0n;
  note('IIN bāze', iinBase);

  // 5. Progressive IIN (doc 3.1 step 5) — single half-up rounding across both bands.
  const below = iinBase < p.iinThresholdMonthlyCents ? iinBase : p.iinThresholdMonthlyCents;
  const above = iinBase - below;
  const iin = divRound(below * p.iinRateBasicBp + above * p.iinRateTopBp, 10000n);
  note('IIN (progresīvā skala)', iin);

  // 6. Other deductions capped at deduction_cap_pct of the payable amount (doc 3.1 step 6).
  const payableBeforeDeductions = gross - vsaoiEmployee - iin;
  const cap = applyBp(payableBeforeDeductions, p.deductionCapBp);
  let deductionsApplied = input.requestedDeductionsCents;
  if (deductionsApplied > cap) { deductionsApplied = cap; warnings.push('deduction_capped'); }
  if (deductionsApplied > 0n) note('Citi ieturējumi (ar griestiem)', deductionsApplied);

  // 7. Net + payout (doc 3.1 step 7). Statutory severance is exempt: payout only.
  const net = payableBeforeDeductions - deductionsApplied;
  const payout = net + input.severanceExemptCents;
  note('Neto', net);
  if (input.severanceExemptCents > 0n) note('Atlaišanas pabalsts (neapliekams)', input.severanceExemptCents);

  // 8. Employer-side costs (doc 3.1 last step) — never reduce the employee's net.
  const vsaoiEmployer = applyBp(gross, p.vsaoiEmployerBp);
  const riskDuty = p.riskDutyMonthlyCents;
  note('VSAOI darba devēja daļa', vsaoiEmployer);

  // Warnings.
  if (input.workedDays === input.totalWorkDays && input.totalWorkDays > 0
      && input.baseCents < p.minWageMonthlyCents) {
    warnings.push('below_minimum_wage');
  }

  return {
    grossCents: gross, vsaoiEmployeeCents: vsaoiEmployee,
    nontaxableAppliedCents: nontaxable, dependentReliefCents: dependentRelief, disabilityReliefCents: disabilityRelief,
    iinBaseCents: iinBase, iinCents: iin,
    deductionsAppliedCents: deductionsApplied, netCents: net, payoutCents: payout,
    vsaoiEmployerCents: vsaoiEmployer, riskDutyCents: riskDuty,
    warnings, explanation,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/payroll/calc.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/payroll/calc.ts tests/payroll/calc.test.ts
git commit -m "feat(payroll): deterministic bruto->neto calculation core with explanation trail"
```

---

### Task 7: Sick pay (A lapa) and vacation pay — pure helpers

A-lapa rules: sick day 1 unpaid, calendar days 2–3 at 75%, days 4–9 at 80% of average daily earnings — paid only for days the employee would have worked. Day 10+ is B lapa (state pays; type `sick_b`, zero employer pay). Day index runs over **calendar** days from the first sick day, and continues across month boundaries.

**Files:**
- Create: `src/payroll/absence-pay.ts`
- Test: `tests/payroll/absence-pay.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/payroll/absence-pay.test.ts
import { expect, test } from 'vitest';
import { computeSickPayA, computeVacationPay } from '../../src/payroll/absence-pay.js';

const P = { sickDay23Bp: 7500n, sickDay49Bp: 8000n };
const AVG = 5000n; // 50.00 EUR/day

test('Mon-Fri sick week: day1 0, days2-3 75%, days4-5 80%', () => {
  const r = computeSickPayA({ sickFrom: '2026-07-06', sickTo: '2026-07-10', year: 2026, month: 7, avgDailyCents: AVG, ...P });
  // Mon 0 + Tue 37.50 + Wed 37.50 + Thu 40.00 + Fri 40.00
  expect(r.totalCents).toBe(15500n);
  expect(r.days).toHaveLength(5);
  expect(r.days[0]).toEqual({ date: '2026-07-06', dayIndex: 1, cents: 0n });
  expect(r.days[1]).toEqual({ date: '2026-07-07', dayIndex: 2, cents: 3750n });
  expect(r.days[4]).toEqual({ date: '2026-07-10', dayIndex: 5, cents: 4000n });
});

test('weekend days advance the index but are not paid', () => {
  // Fri Jul 3 (idx1, 0) .. Wed Jul 8; Sat/Sun skipped; Mon=idx4 80%
  const r = computeSickPayA({ sickFrom: '2026-07-03', sickTo: '2026-07-08', year: 2026, month: 7, avgDailyCents: AVG, ...P });
  expect(r.days.map((d) => d.date)).toEqual(['2026-07-03', '2026-07-06', '2026-07-07', '2026-07-08']);
  expect(r.totalCents).toBe(0n + 4000n + 4000n + 4000n);
});

test('cross-month absence: only the requested month is paid, index continues', () => {
  // Sick Jun 29 (Mon, idx1) .. Jul 3; July sees idx3..idx5
  const r = computeSickPayA({ sickFrom: '2026-06-29', sickTo: '2026-07-03', year: 2026, month: 7, avgDailyCents: AVG, ...P });
  expect(r.days.map((d) => d.dayIndex)).toEqual([3, 4, 5]); // Jul 1 (Wed) = calendar day 3
  expect(r.totalCents).toBe(3750n + 4000n + 4000n);
});

test('days past 9 are never employer-paid', () => {
  const r = computeSickPayA({ sickFrom: '2026-07-01', sickTo: '2026-07-15', year: 2026, month: 7, avgDailyCents: AVG, ...P });
  expect(r.days.every((d) => d.dayIndex <= 9 || d.cents === 0n)).toBe(true);
});

test('vacation pay = overlapping workdays x average daily earnings (doc 3.2 step 5)', () => {
  expect(computeVacationPay({ from: '2026-07-13', to: '2026-07-24', year: 2026, month: 7, avgDailyCents: AVG }))
    .toBe(50000n); // 10 workdays x 50.00
  expect(computeVacationPay({ from: '2026-06-29', to: '2026-07-03', year: 2026, month: 7, avgDailyCents: AVG }))
    .toBe(15000n); // Jul 1-3
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/payroll/absence-pay.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/payroll/absence-pay.ts`:

```typescript
import { applyBp } from './rates.js';
import { calendarDays, isWorkDay, firstDayOfMonth, lastDayOfMonth } from './workdays.js';

/**
 * Employer-paid sick pay, A lapa (doc 3.1 step 1 component; researched rules):
 * calendar day 1 unpaid, days 2-3 >=75%, days 4-9 >=80% of average daily earnings,
 * paid only for would-be workdays. Day 10+ is B lapa (state), never employer-paid.
 */
export function computeSickPayA(args: {
  sickFrom: string; sickTo: string; year: number; month: number;
  avgDailyCents: bigint; sickDay23Bp: bigint; sickDay49Bp: bigint;
}): { totalCents: bigint; days: { date: string; dayIndex: number; cents: bigint }[] } {
  const monthFrom = firstDayOfMonth(args.year, args.month);
  const monthTo = lastDayOfMonth(args.year, args.month);
  const days: { date: string; dayIndex: number; cents: bigint }[] = [];
  let total = 0n;
  let idx = 0;
  for (const date of calendarDays(args.sickFrom, args.sickTo)) {
    idx++; // calendar-day index from the first sick day, across month boundaries
    if (date < monthFrom || date > monthTo) continue;
    if (!isWorkDay(date)) continue;
    const rateBp = idx === 1 ? 0n : idx <= 3 ? args.sickDay23Bp : idx <= 9 ? args.sickDay49Bp : 0n;
    const cents = applyBp(args.avgDailyCents, rateBp);
    days.push({ date, dayIndex: idx, cents });
    total += cents;
  }
  return { totalCents: total, days };
}

/** Vacation pay for the month = overlapping workdays x average daily earnings (doc 3.2 step 5). */
export function computeVacationPay(args: {
  from: string; to: string; year: number; month: number; avgDailyCents: bigint;
}): bigint {
  const monthFrom = firstDayOfMonth(args.year, args.month);
  const monthTo = lastDayOfMonth(args.year, args.month);
  let total = 0n;
  for (const date of calendarDays(args.from, args.to)) {
    if (date < monthFrom || date > monthTo) continue;
    if (isWorkDay(date)) total += args.avgDailyCents;
  }
  return total;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/payroll/absence-pay.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/payroll/absence-pay.ts tests/payroll/absence-pay.test.ts
git commit -m "feat(payroll): A-lapa sick pay and vacation pay helpers"
```

---

### Task 8: Absences and pay components — migration 026 + inputs domain

The month's variable inputs (doc 2.2 "events"): absences (vacation/sick/unpaid) and pay components (bonuses, premium hours, hourly-employee hours, extra deductions). Orders (Task 9) write into these; the run (Task 12) reads them.

**Files:**
- Create: `migrations/026_payroll_inputs.sql`
- Create: `src/payroll/inputs.ts`
- Test: `tests/payroll/inputs.test.ts`

- [ ] **Step 1: Write the migration**

```sql
-- migrations/026_payroll_inputs.sql
CREATE TABLE absences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  type text NOT NULL CHECK (type IN ('vacation','sick_a','sick_b','unpaid','other')),
  date_from date NOT NULL,
  date_to date NOT NULL,
  source_order_id uuid,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (date_to >= date_from)
);
CREATE INDEX absences_employee_idx ON absences(employee_id, date_from);

CREATE TABLE pay_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  year int NOT NULL,
  month int NOT NULL CHECK (month BETWEEN 1 AND 12),
  kind text NOT NULL CHECK (kind IN
    ('bonus','night_hours','overtime_hours','holiday_hours','hours_worked',
     'other_taxable','severance_exempt','deduction')),
  amount numeric(12,2),   -- money kinds
  quantity numeric(7,2),  -- hour kinds
  source_order_id uuid,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (kind IN ('night_hours','overtime_hours','holiday_hours','hours_worked')
       AND quantity IS NOT NULL AND quantity > 0 AND amount IS NULL)
    OR
    (kind IN ('bonus','other_taxable','severance_exempt','deduction')
       AND amount IS NOT NULL AND amount > 0 AND quantity IS NULL)
  )
);
CREATE INDEX pay_components_employee_month_idx ON pay_components(employee_id, year, month);

ALTER TABLE absences ENABLE ROW LEVEL SECURITY;
ALTER TABLE absences FORCE ROW LEVEL SECURITY;
CREATE POLICY absences_tenant_isolation ON absences
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

ALTER TABLE pay_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_components FORCE ROW LEVEL SECURITY;
CREATE POLICY pay_components_tenant_isolation ON pay_components
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

GRANT SELECT, INSERT ON absences TO bookkeeping_app;
GRANT SELECT, INSERT ON pay_components TO bookkeeping_app;
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/payroll/inputs.test.ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createEmployee } from '../../src/payroll/employees.js';
import { addAbsence, listAbsencesOverlapping, addPayComponent, listComponents } from '../../src/payroll/inputs.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function makeEmp() {
  const t = ctx(await makeFirmAndClient());
  const { id } = await withTenant(t, (tx) => createEmployee(tx, t, {
    firstName: 'Anna', lastName: 'Ozola', personalCode: '010190-12345', position: 'Grāmatvede',
    contractNo: 'DL-1', contractDate: '2026-01-02', contractType: 'indefinite',
    wageType: 'monthly', wage: '1000.00', hiredOn: '2026-01-02',
    openingVacationDays: '0', openingBalanceDate: '2026-01-02',
  }));
  return { t, id };
}

test('absences: add + list by month overlap', async () => {
  const { t, id } = await makeEmp();
  await withTenant(t, async (tx) => {
    await addAbsence(tx, t, { employeeId: id, type: 'vacation', dateFrom: '2026-07-13', dateTo: '2026-07-24' });
    await addAbsence(tx, t, { employeeId: id, type: 'sick_a', dateFrom: '2026-06-29', dateTo: '2026-07-03' });
    await addAbsence(tx, t, { employeeId: id, type: 'unpaid', dateFrom: '2026-05-04', dateTo: '2026-05-05' });
    const july = await listAbsencesOverlapping(tx, t, id, 2026, 7);
    expect(july).toHaveLength(2); // vacation + the sick spell spilling into July
    expect(july.map((a) => a.type).sort()).toEqual(['sick_a', 'vacation']);
  });
});

test('sick_a longer than 9 calendar days is rejected (split into A+B)', async () => {
  const { t, id } = await makeEmp();
  await expect(withTenant(t, (tx) =>
    addAbsence(tx, t, { employeeId: id, type: 'sick_a', dateFrom: '2026-07-01', dateTo: '2026-07-15' }),
  )).rejects.toThrow(/9 calendar days/);
});

test('pay components: add + list for a month; money vs hour kinds validated', async () => {
  const { t, id } = await makeEmp();
  await withTenant(t, async (tx) => {
    await addPayComponent(tx, t, { employeeId: id, year: 2026, month: 7, kind: 'bonus', amount: '300.00' });
    await addPayComponent(tx, t, { employeeId: id, year: 2026, month: 7, kind: 'overtime_hours', quantity: '8' });
    const rows = await listComponents(tx, t, id, 2026, 7);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.kind === 'bonus')!.amount).toBe('300.00');
    expect(rows.find((r) => r.kind === 'overtime_hours')!.quantity).toBe('8.00');
  });
  await expect(withTenant(t, (tx) =>
    addPayComponent(tx, t, { employeeId: id, year: 2026, month: 7, kind: 'bonus', quantity: '8' }),
  )).rejects.toThrow();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/payroll/inputs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Create `src/payroll/inputs.ts`:

```typescript
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appendAudit } from '../audit/audit.js';
import { firstDayOfMonth, lastDayOfMonth } from './workdays.js';

export type AbsenceType = 'vacation' | 'sick_a' | 'sick_b' | 'unpaid' | 'other';
export type ComponentKind =
  | 'bonus' | 'night_hours' | 'overtime_hours' | 'holiday_hours'
  | 'hours_worked' | 'other_taxable' | 'severance_exempt' | 'deduction';

const HOUR_KINDS: readonly ComponentKind[] = ['night_hours', 'overtime_hours', 'holiday_hours', 'hours_worked'];

export interface AbsenceRow {
  id: string; employeeId: string; type: AbsenceType;
  dateFrom: string; dateTo: string; sourceOrderId: string | null; note: string | null;
}
export interface ComponentRow {
  id: string; employeeId: string; kind: ComponentKind;
  amount: string | null; quantity: string | null; sourceOrderId: string | null; note: string | null;
}

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const absenceSchema = z.object({
  employeeId: z.string().uuid(),
  type: z.enum(['vacation', 'sick_a', 'sick_b', 'unpaid', 'other']),
  dateFrom: dateStr, dateTo: dateStr,
  sourceOrderId: z.string().uuid().nullable().optional(),
  note: z.string().nullable().optional(),
}).refine((a) => a.dateTo >= a.dateFrom, { message: 'dateTo must be >= dateFrom' });

export async function addAbsence(
  tx: PoolClient, ctx: TenantContext,
  input: z.input<typeof absenceSchema>,
): Promise<{ id: string }> {
  const a = absenceSchema.parse(input);
  if (a.type === 'sick_a') {
    const days = (Date.parse(`${a.dateTo}T00:00:00Z`) - Date.parse(`${a.dateFrom}T00:00:00Z`)) / 86_400_000 + 1;
    if (days > 9) throw new Error('sick_a may cover at most 9 calendar days — record day 10+ as sick_b (B lapa)');
  }
  const res = await tx.query(
    `INSERT INTO absences(client_company_id, employee_id, type, date_from, date_to, source_order_id, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [ctx.clientCompanyId, a.employeeId, a.type, a.dateFrom, a.dateTo, a.sourceOrderId ?? null, a.note ?? null],
  );
  const id = res.rows[0].id as string;
  await appendAudit(tx, ctx, { action: 'create', entityType: 'absence', entityId: id, before: null, after: a });
  return { id };
}

export async function listAbsencesOverlapping(
  tx: PoolClient, ctx: TenantContext, employeeId: string, year: number, month: number,
): Promise<AbsenceRow[]> {
  const res = await tx.query(
    `SELECT id, employee_id AS "employeeId", type,
            to_char(date_from,'YYYY-MM-DD') AS "dateFrom", to_char(date_to,'YYYY-MM-DD') AS "dateTo",
            source_order_id AS "sourceOrderId", note
     FROM absences
     WHERE employee_id = $1 AND client_company_id = $2 AND date_from <= $4 AND date_to >= $3
     ORDER BY date_from`,
    [employeeId, ctx.clientCompanyId, firstDayOfMonth(year, month), lastDayOfMonth(year, month)],
  );
  return res.rows;
}

const componentSchema = z.object({
  employeeId: z.string().uuid(),
  year: z.number().int(), month: z.number().int().min(1).max(12),
  kind: z.enum(['bonus', 'night_hours', 'overtime_hours', 'holiday_hours',
    'hours_worked', 'other_taxable', 'severance_exempt', 'deduction']),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  quantity: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  sourceOrderId: z.string().uuid().nullable().optional(),
  note: z.string().nullable().optional(),
}).refine((c) => HOUR_KINDS.includes(c.kind) ? c.quantity !== undefined && c.amount === undefined
                                             : c.amount !== undefined && c.quantity === undefined,
  { message: 'hour kinds take quantity; money kinds take amount' });

export async function addPayComponent(
  tx: PoolClient, ctx: TenantContext,
  input: z.input<typeof componentSchema>,
): Promise<{ id: string }> {
  const c = componentSchema.parse(input);
  const res = await tx.query(
    `INSERT INTO pay_components(client_company_id, employee_id, year, month, kind, amount, quantity, source_order_id, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [ctx.clientCompanyId, c.employeeId, c.year, c.month, c.kind,
     c.amount ?? null, c.quantity ?? null, c.sourceOrderId ?? null, c.note ?? null],
  );
  const id = res.rows[0].id as string;
  await appendAudit(tx, ctx, { action: 'create', entityType: 'pay_component', entityId: id, before: null, after: c });
  return { id };
}

export async function listComponents(
  tx: PoolClient, ctx: TenantContext, employeeId: string, year: number, month: number,
): Promise<ComponentRow[]> {
  const res = await tx.query(
    `SELECT id, employee_id AS "employeeId", kind, amount::text, quantity::text,
            source_order_id AS "sourceOrderId", note
     FROM pay_components
     WHERE employee_id = $1 AND client_company_id = $2 AND year = $3 AND month = $4
     ORDER BY created_at`,
    [employeeId, ctx.clientCompanyId, year, month],
  );
  return res.rows;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/payroll/inputs.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add migrations/026_payroll_inputs.sql src/payroll/inputs.ts tests/payroll/inputs.test.ts
git commit -m "feat(payroll): absences and pay components (migration 026)"
```

---

### Task 9: Orders (rīkojumi) — migration 027 + lifecycle

Doc section 4: every status/pay change is a document with a draft→approved lifecycle, immutable after approval, whose approval **creates** the payroll inputs. PDF rendering + eParaksts are deferred (see header); the mechanism, effects, immutability, and archive queries are built now. The `termination` effect branch throws until Task 14 replaces it.

**Files:**
- Create: `migrations/027_payroll_orders.sql`
- Create: `src/payroll/orders.ts`
- Test: `tests/payroll/orders.test.ts`

- [ ] **Step 1: Write the migration**

```sql
-- migrations/027_payroll_orders.sql
CREATE TABLE payroll_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  order_type text NOT NULL CHECK (order_type IN ('hire','termination','bonus','vacation','wage_change')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
  employee_ids uuid[] NOT NULL,
  amount numeric(12,2),
  date_from date,
  date_to date,
  effective_date date NOT NULL,
  reason text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_by text,
  approved_at timestamptz
);
CREATE INDEX payroll_orders_client_idx ON payroll_orders(client_company_id, order_type, created_at DESC);

ALTER TABLE payroll_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY payroll_orders_tenant_isolation ON payroll_orders
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON payroll_orders TO bookkeeping_app;
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/payroll/orders.test.ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createEmployee, getEmployee } from '../../src/payroll/employees.js';
import { listAbsencesOverlapping, listComponents } from '../../src/payroll/inputs.js';
import { createOrder, approveOrder, getOrder, listOrders } from '../../src/payroll/orders.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function makeTwoEmps() {
  const t = ctx(await makeFirmAndClient());
  const mk = (pc: string, cn: string) => withTenant(t, (tx) => createEmployee(tx, t, {
    firstName: 'A', lastName: pc, personalCode: pc, position: 'X',
    contractNo: cn, contractDate: '2026-01-02', contractType: 'indefinite',
    wageType: 'monthly', wage: '1000.00', hiredOn: '2026-01-02',
    openingVacationDays: '0', openingBalanceDate: '2026-01-02',
  }));
  const a = await mk('010190-11111', 'DL-1');
  const b = await mk('010190-22222', 'DL-2');
  return { t, a: a.id, b: b.id };
}

test('bonus order for two employees creates a component each on approval', async () => {
  const { t, a, b } = await makeTwoEmps();
  const { id } = await withTenant(t, (tx) => createOrder(tx, t, {
    orderType: 'bonus', employeeIds: [a, b], amount: '300.00',
    effectiveDate: '2026-07-15', reason: 'Jūlija prēmija nodaļai',
  }));
  await withTenant(t, (tx) => approveOrder(tx, t, id));
  await withTenant(t, async (tx) => {
    for (const emp of [a, b]) {
      const comps = await listComponents(tx, t, emp, 2026, 7);
      expect(comps).toHaveLength(1);
      expect(comps[0]!.kind).toBe('bonus');
      expect(comps[0]!.amount).toBe('300.00');
      expect(comps[0]!.sourceOrderId).toBe(id);
    }
  });
  const o = await withTenant(t, (tx) => getOrder(tx, t, id));
  expect(o.status).toBe('approved');
});

test('vacation order creates the absence on approval', async () => {
  const { t, a } = await makeTwoEmps();
  const { id } = await withTenant(t, (tx) => createOrder(tx, t, {
    orderType: 'vacation', employeeIds: [a], dateFrom: '2026-07-13', dateTo: '2026-07-24',
    effectiveDate: '2026-07-13', reason: 'Ikgadējais atvaļinājums',
  }));
  await withTenant(t, (tx) => approveOrder(tx, t, id));
  const abs = await withTenant(t, (tx) => listAbsencesOverlapping(tx, t, a, 2026, 7));
  expect(abs).toHaveLength(1);
  expect(abs[0]!.type).toBe('vacation');
  expect(abs[0]!.sourceOrderId).toBe(id);
});

test('wage_change order updates the employee wage on approval', async () => {
  const { t, a } = await makeTwoEmps();
  const { id } = await withTenant(t, (tx) => createOrder(tx, t, {
    orderType: 'wage_change', employeeIds: [a], amount: '1200.00',
    effectiveDate: '2026-08-01', reason: 'Algas paaugstinājums',
  }));
  await withTenant(t, (tx) => approveOrder(tx, t, id));
  const e = await withTenant(t, (tx) => getEmployee(tx, t, a));
  expect(e.wage).toBe('1200.00');
});

test('an approved order cannot be approved twice', async () => {
  const { t, a } = await makeTwoEmps();
  const { id } = await withTenant(t, (tx) => createOrder(tx, t, {
    orderType: 'bonus', employeeIds: [a], amount: '100.00',
    effectiveDate: '2026-07-15', reason: 'X',
  }));
  await withTenant(t, (tx) => approveOrder(tx, t, id));
  await expect(withTenant(t, (tx) => approveOrder(tx, t, id))).rejects.toThrow(/not a draft/);
});

test('order archive: list with type filter', async () => {
  const { t, a } = await makeTwoEmps();
  await withTenant(t, (tx) => createOrder(tx, t, {
    orderType: 'bonus', employeeIds: [a], amount: '100.00', effectiveDate: '2026-07-15', reason: 'X',
  }));
  await withTenant(t, (tx) => createOrder(tx, t, {
    orderType: 'vacation', employeeIds: [a], dateFrom: '2026-08-03', dateTo: '2026-08-07',
    effectiveDate: '2026-08-03', reason: 'Y',
  }));
  const bonuses = await withTenant(t, (tx) => listOrders(tx, t, { orderType: 'bonus' }));
  expect(bonuses).toHaveLength(1);
  const all = await withTenant(t, (tx) => listOrders(tx, t, {}));
  expect(all).toHaveLength(2);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/payroll/orders.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Create `src/payroll/orders.ts`:

```typescript
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appendAudit } from '../audit/audit.js';
import { updateEmployee } from './employees.js';
import { addAbsence, addPayComponent } from './inputs.js';

export type OrderType = 'hire' | 'termination' | 'bonus' | 'vacation' | 'wage_change';

export interface OrderRow {
  id: string; orderType: OrderType; status: 'draft' | 'approved';
  employeeIds: string[]; amount: string | null;
  dateFrom: string | null; dateTo: string | null; effectiveDate: string;
  reason: string; payload: Record<string, unknown>;
  createdBy: string; approvedBy: string | null; approvedAt: string | null;
}

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const moneyStr = z.string().regex(/^\d+(\.\d{1,2})?$/);

const newOrderSchema = z.object({
  orderType: z.enum(['hire', 'termination', 'bonus', 'vacation', 'wage_change']),
  employeeIds: z.array(z.string().uuid()).min(1),
  amount: moneyStr.optional(),
  dateFrom: dateStr.optional(),
  dateTo: dateStr.optional(),
  effectiveDate: dateStr,
  reason: z.string().min(1),
  payload: z.record(z.unknown()).default({}),
}).superRefine((o, issues) => {
  if ((o.orderType === 'bonus' || o.orderType === 'wage_change') && o.amount === undefined) {
    issues.addIssue({ code: z.ZodIssueCode.custom, message: `${o.orderType} order requires amount` });
  }
  if ((o.orderType === 'vacation' || o.orderType === 'termination') && (!o.dateFrom || !o.dateTo)) {
    issues.addIssue({ code: z.ZodIssueCode.custom, message: `${o.orderType} order requires dateFrom/dateTo` });
  }
  if (o.orderType !== 'bonus' && o.employeeIds.length > 1) {
    issues.addIssue({ code: z.ZodIssueCode.custom, message: 'only bonus orders may target multiple employees' });
  }
});
export type NewOrder = z.input<typeof newOrderSchema>;

const SELECT_COLS = `id, order_type AS "orderType", status, employee_ids AS "employeeIds",
  amount::text, to_char(date_from,'YYYY-MM-DD') AS "dateFrom", to_char(date_to,'YYYY-MM-DD') AS "dateTo",
  to_char(effective_date,'YYYY-MM-DD') AS "effectiveDate", reason, payload,
  created_by AS "createdBy", approved_by AS "approvedBy", approved_at::text AS "approvedAt"`;

export async function createOrder(tx: PoolClient, ctx: TenantContext, input: NewOrder): Promise<{ id: string }> {
  const o = newOrderSchema.parse(input);
  const res = await tx.query(
    `INSERT INTO payroll_orders(client_company_id, order_type, employee_ids, amount,
       date_from, date_to, effective_date, reason, payload, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [ctx.clientCompanyId, o.orderType, o.employeeIds, o.amount ?? null,
     o.dateFrom ?? null, o.dateTo ?? null, o.effectiveDate, o.reason, o.payload, ctx.actorId],
  );
  const id = res.rows[0].id as string;
  await appendAudit(tx, ctx, { action: 'create', entityType: 'payroll_order', entityId: id, before: null, after: o });
  return { id };
}

export async function getOrder(tx: PoolClient, ctx: TenantContext, id: string): Promise<OrderRow> {
  const res = await tx.query(
    `SELECT ${SELECT_COLS} FROM payroll_orders WHERE id = $1 AND client_company_id = $2`,
    [id, ctx.clientCompanyId],
  );
  if (!res.rowCount) throw new Error(`Order not found: ${id}`);
  return res.rows[0];
}

export async function listOrders(
  tx: PoolClient, ctx: TenantContext, filter: { orderType?: OrderType },
): Promise<OrderRow[]> {
  const res = await tx.query(
    `SELECT ${SELECT_COLS} FROM payroll_orders
     WHERE client_company_id = $1 AND ($2::text IS NULL OR order_type = $2)
     ORDER BY created_at DESC`,
    [ctx.clientCompanyId, filter.orderType ?? null],
  );
  return res.rows;
}

function ym(iso: string): { year: number; month: number } {
  return { year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)) };
}

/**
 * Approve a draft order and apply its effects (doc 4.2 step 4). After this the
 * order is immutable — there is no update function, and approval is one-way.
 */
export async function approveOrder(tx: PoolClient, ctx: TenantContext, id: string): Promise<void> {
  const before = await getOrder(tx, ctx, id);
  if (before.status !== 'draft') throw new Error(`Order ${id} is not a draft (status: ${before.status})`);

  switch (before.orderType) {
    case 'hire':
      break; // the employee card already exists; the order is the paper trail
    case 'bonus': {
      const { year, month } = ym(before.effectiveDate);
      for (const employeeId of before.employeeIds) {
        await addPayComponent(tx, ctx, {
          employeeId, year, month, kind: 'bonus', amount: before.amount!,
          sourceOrderId: id, note: before.reason,
        });
      }
      break;
    }
    case 'vacation':
      await addAbsence(tx, ctx, {
        employeeId: before.employeeIds[0]!, type: 'vacation',
        dateFrom: before.dateFrom!, dateTo: before.dateTo!,
        sourceOrderId: id, note: before.reason,
      });
      break;
    case 'wage_change':
      await updateEmployee(tx, ctx, before.employeeIds[0]!, { wage: before.amount! });
      break;
    case 'termination':
      // Replaced with the full final-settlement effect in Task 14.
      throw new Error('termination orders are not supported yet (Task 14)');
  }

  await tx.query(
    `UPDATE payroll_orders SET status = 'approved', approved_by = $1, approved_at = now()
     WHERE id = $2 AND client_company_id = $3`,
    [ctx.actorId, id, ctx.clientCompanyId],
  );
  await appendAudit(tx, ctx, {
    action: 'approve', entityType: 'payroll_order', entityId: id,
    before, after: { ...before, status: 'approved' },
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/payroll/orders.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add migrations/027_payroll_orders.sql src/payroll/orders.ts tests/payroll/orders.test.ts
git commit -m "feat(payroll): orders (rikojumi) with draft->approved lifecycle and effects (migration 027)"
```

---

### Task 10: Runs schema (migration 028) + average earnings (doc 3.2)

One shared average-earnings function — the doc explicitly warns this is the most common source of bugs when reimplemented per use-case. Sources: approved `payroll_items` (real history) merged over `employee_opening_history` (imported pre-system months; real months win on conflict). Window: 6 full calendar months before the event month; if the employee worked 0 days in that window, the window shifts back to end at the last month with worked days (doc 3.2 special case 2); fewer months than 6 since hire is fine (special case 1).

**Files:**
- Create: `migrations/028_payroll_runs.sql`
- Create: `src/payroll/average-earnings.ts`
- Test: `tests/payroll/average-earnings.test.ts`

- [ ] **Step 1: Write the migration**

```sql
-- migrations/028_payroll_runs.sql
CREATE TABLE payroll_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  year int NOT NULL,
  month int NOT NULL CHECK (month BETWEEN 1 AND 12),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','computed','approved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  UNIQUE (client_company_id, year, month)
);

CREATE TABLE payroll_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  run_id uuid NOT NULL REFERENCES payroll_runs(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  worked_days int NOT NULL,
  total_work_days int NOT NULL,
  base numeric(12,2) NOT NULL,
  premiums numeric(12,2) NOT NULL,
  bonus numeric(12,2) NOT NULL,
  vacation_pay numeric(12,2) NOT NULL,
  sick_pay numeric(12,2) NOT NULL,
  other_taxable numeric(12,2) NOT NULL,
  severance_exempt numeric(12,2) NOT NULL,
  gross numeric(12,2) NOT NULL,
  avg_base_gross numeric(12,2) NOT NULL,  -- base+premiums+bonus: the doc-3.2 earnings base for future averages
  avg_daily numeric(12,2) NOT NULL,       -- the average daily earnings used this month (accrual + audit trail)
  vsaoi_employee numeric(12,2) NOT NULL,
  iin numeric(12,2) NOT NULL,
  other_deductions numeric(12,2) NOT NULL,
  net numeric(12,2) NOT NULL,
  payout numeric(12,2) NOT NULL,
  vsaoi_employer numeric(12,2) NOT NULL,
  risk_duty numeric(12,2) NOT NULL,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  explanation jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (run_id, employee_id)
);
CREATE INDEX payroll_items_employee_idx ON payroll_items(employee_id);

CREATE TABLE vacation_accruals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  year int NOT NULL,
  month int NOT NULL CHECK (month BETWEEN 1 AND 12),
  balance_days numeric(7,2) NOT NULL,
  avg_daily numeric(12,2) NOT NULL,
  accrual numeric(14,2) NOT NULL,
  accrual_vsaoi numeric(14,2) NOT NULL,
  UNIQUE (employee_id, year, month)
);

ALTER TABLE payroll_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY payroll_runs_tenant_isolation ON payroll_runs
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

ALTER TABLE payroll_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_items FORCE ROW LEVEL SECURITY;
CREATE POLICY payroll_items_tenant_isolation ON payroll_items
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

ALTER TABLE vacation_accruals ENABLE ROW LEVEL SECURITY;
ALTER TABLE vacation_accruals FORCE ROW LEVEL SECURITY;
CREATE POLICY vacation_accruals_tenant_isolation ON vacation_accruals
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON payroll_runs TO bookkeeping_app;
GRANT SELECT, INSERT, DELETE ON payroll_items TO bookkeeping_app;  -- DELETE: recompute wipes draft items
GRANT SELECT, INSERT, UPDATE ON vacation_accruals TO bookkeeping_app;
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/payroll/average-earnings.test.ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createEmployee, importOpeningHistory } from '../../src/payroll/employees.js';
import { computeAverageEarnings } from '../../src/payroll/average-earnings.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function makeEmp(hiredOn = '2025-01-02') {
  const t = ctx(await makeFirmAndClient());
  const { id } = await withTenant(t, (tx) => createEmployee(tx, t, {
    firstName: 'Anna', lastName: 'Ozola', personalCode: '010190-12345', position: 'X',
    contractNo: 'DL-1', contractDate: hiredOn, contractType: 'indefinite',
    wageType: 'monthly', wage: '1000.00', hiredOn,
    openingVacationDays: '0', openingBalanceDate: '2026-01-01',
  }));
  return { t, id };
}

test('6 full months before the event, from opening history', async () => {
  const { t, id } = await makeEmp();
  await withTenant(t, (tx) => importOpeningHistory(tx, t, id, [
    { year: 2026, month: 1, avgBaseGross: '1000.00', workedDays: 21 },
    { year: 2026, month: 2, avgBaseGross: '1000.00', workedDays: 20 },
    { year: 2026, month: 3, avgBaseGross: '1000.00', workedDays: 22 },
    { year: 2026, month: 4, avgBaseGross: '1300.00', workedDays: 21 },
    { year: 2026, month: 5, avgBaseGross: '1000.00', workedDays: 20 },
    { year: 2026, month: 6, avgBaseGross: '1000.00', workedDays: 21 },
  ]));
  // Event mid-July: window = Jan..Jun (July itself excluded, doc 3.2 step 1)
  const r = await withTenant(t, (tx) => computeAverageEarnings(tx, t, id, '2026-07-15'));
  // 6300.00 / 125 days = 50.40/day
  expect(r.dailyCents).toBe(5040n);
  expect(r.from).toBe('2026-01');
  expect(r.to).toBe('2026-06');
  expect(r.shifted).toBe(false);
  expect(r.totalWorkedDays).toBe(125);
  expect(r.monthsUsed).toHaveLength(6);
  // monthly average = daily x (calendar workdays in window / 6); Jan..Jun 2026 = 22+20+22+22+21+22 = 129 workdays
  expect(r.monthlyCents).toBe(108360n); // divRound(5040 * 129, 6) = 650160/6
});

test('fewer than 6 months since hire uses the actual period (doc 3.2 case 1)', async () => {
  const { t, id } = await makeEmp('2026-04-01');
  await withTenant(t, (tx) => importOpeningHistory(tx, t, id, [
    { year: 2026, month: 4, avgBaseGross: '880.00', workedDays: 22 },
    { year: 2026, month: 5, avgBaseGross: '800.00', workedDays: 20 },
  ]));
  const r = await withTenant(t, (tx) => computeAverageEarnings(tx, t, id, '2026-06-10'));
  expect(r.totalWorkedDays).toBe(42);
  expect(r.dailyCents).toBe(4000n); // 1680.00/42
  expect(r.monthsUsed).toHaveLength(2);
});

test('zero worked days in the window shifts it back (doc 3.2 case 2)', async () => {
  const { t, id } = await makeEmp('2024-01-02');
  await withTenant(t, (tx) => importOpeningHistory(tx, t, id, [
    // worked normally through 2025-06, then long absence with 0-day months
    { year: 2025, month: 5, avgBaseGross: '1050.00', workedDays: 21 },
    { year: 2025, month: 6, avgBaseGross: '1000.00', workedDays: 21 },
    { year: 2025, month: 7, avgBaseGross: '0.00', workedDays: 0 },
    { year: 2025, month: 8, avgBaseGross: '0.00', workedDays: 0 },
    { year: 2025, month: 9, avgBaseGross: '0.00', workedDays: 0 },
    { year: 2025, month: 10, avgBaseGross: '0.00', workedDays: 0 },
    { year: 2025, month: 11, avgBaseGross: '0.00', workedDays: 0 },
    { year: 2025, month: 12, avgBaseGross: '0.00', workedDays: 0 },
    { year: 2026, month: 1, avgBaseGross: '0.00', workedDays: 0 },
    { year: 2026, month: 2, avgBaseGross: '0.00', workedDays: 0 },
  ]));
  const r = await withTenant(t, (tx) => computeAverageEarnings(tx, t, id, '2026-03-05'));
  expect(r.shifted).toBe(true);
  expect(r.to).toBe('2025-06'); // window ends at the last month with worked days
  expect(r.dailyCents).toBe(4881n); // 2050.00/42 = 48.8095 -> 48.81
});

test('no history at all: clear error naming the fix', async () => {
  const { t, id } = await makeEmp();
  await expect(withTenant(t, (tx) => computeAverageEarnings(tx, t, id, '2026-07-15')))
    .rejects.toThrow(/opening history/i);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/payroll/average-earnings.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Create `src/payroll/average-earnings.ts`:

```typescript
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { divRound } from './rates.js';
import { workDaysInMonth } from './workdays.js';

/**
 * THE shared average-earnings function (doc 3.2) — vacation pay, sick pay,
 * severance and termination compensation all call this; never reimplement it.
 *
 * Base = base pay + premiums + bonuses (avg_base_gross), EXCLUDING previous
 * average-pay payments (vacation/sick), so no "calculation from a calculation".
 */
export interface AverageEarningsResult {
  dailyCents: bigint;
  monthlyCents: bigint;  // daily x (calendar workdays in the window / 6) — used for severance
  from: string;          // 'YYYY-MM'
  to: string;            // 'YYYY-MM'
  shifted: boolean;      // window moved back past a long absence (doc 3.2 case 2)
  totalWorkedDays: number;
  monthsUsed: { year: number; month: number; grossCents: bigint; workedDays: number }[];
}

const key = (y: number, m: number) => y * 12 + (m - 1);
const fromKey = (k: number) => ({ year: Math.floor(k / 12), month: (k % 12) + 1 });
const label = (k: number) => { const { year, month } = fromKey(k); return `${year}-${String(month).padStart(2, '0')}`; };

export async function computeAverageEarnings(
  tx: PoolClient, ctx: TenantContext, employeeId: string, eventDate: string,
): Promise<AverageEarningsResult> {
  // Merge history: imported opening months first, real approved payroll months overwrite.
  const res = await tx.query(
    `SELECT year, month, (ROUND(avg_base_gross * 100))::bigint AS gross_cents, worked_days, 0 AS pri
       FROM employee_opening_history WHERE employee_id = $1 AND client_company_id = $2
     UNION ALL
     SELECT r.year, r.month, (ROUND(i.avg_base_gross * 100))::bigint, i.worked_days, 1 AS pri
       FROM payroll_items i JOIN payroll_runs r ON r.id = i.run_id
      WHERE i.employee_id = $1 AND i.client_company_id = $2 AND r.status = 'approved'
     ORDER BY pri`,
    [employeeId, ctx.clientCompanyId],
  );
  const byMonth = new Map<number, { grossCents: bigint; workedDays: number }>();
  for (const row of res.rows) {
    byMonth.set(key(row.year, row.month), { grossCents: BigInt(row.gross_cents), workedDays: row.worked_days });
  }
  if (byMonth.size === 0) {
    throw new Error(`No earnings history for employee ${employeeId} — import opening history (doc 2.1) or approve a payroll run first`);
  }

  const eventKey = key(Number(eventDate.slice(0, 4)), Number(eventDate.slice(5, 7)));
  let windowEnd = eventKey - 1; // last FULL month before the event month
  let shifted = false;

  const monthsIn = (endKey: number) => {
    const months: { year: number; month: number; grossCents: bigint; workedDays: number }[] = [];
    for (let k = endKey - 5; k <= endKey; k++) {
      const m = byMonth.get(k);
      if (m) months.push({ ...fromKey(k), ...m });
    }
    return months;
  };

  let months = monthsIn(windowEnd);
  if (months.reduce((s, m) => s + m.workedDays, 0) === 0) {
    // Long absence: shift the window to end at the latest earlier month with worked days.
    const candidates = [...byMonth.entries()]
      .filter(([k, m]) => k < windowEnd - 5 && m.workedDays > 0)
      .map(([k]) => k);
    if (candidates.length === 0) {
      throw new Error(`No worked days in any known month for employee ${employeeId} — check opening history (doc 2.1)`);
    }
    windowEnd = Math.max(...candidates);
    shifted = true;
    months = monthsIn(windowEnd);
  }

  const totalGross = months.reduce((s, m) => s + m.grossCents, 0n);
  const totalWorkedDays = months.reduce((s, m) => s + m.workedDays, 0);
  if (totalWorkedDays === 0) {
    throw new Error(`No worked days in the average-earnings window for employee ${employeeId}`);
  }
  const dailyCents = divRound(totalGross, BigInt(totalWorkedDays));

  // Monthly average (for severance, doc 3.8): daily x calendar workdays in the window / 6.
  let calendarWorkDays = 0;
  for (let k = windowEnd - 5; k <= windowEnd; k++) {
    const { year, month } = fromKey(k);
    calendarWorkDays += workDaysInMonth(year, month);
  }
  const monthlyCents = divRound(dailyCents * BigInt(calendarWorkDays), 6n);

  return {
    dailyCents, monthlyCents,
    from: label(windowEnd - 5), to: label(windowEnd),
    shifted, totalWorkedDays, monthsUsed: months,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/payroll/average-earnings.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add migrations/028_payroll_runs.sql src/payroll/average-earnings.ts tests/payroll/average-earnings.test.ts
git commit -m "feat(payroll): runs/items/accruals schema + the shared average-earnings function"
```

---

### Task 11: Vacation accrual — day balance and financial accrual (doc 3.6)

Two distinct concepts (doc 3.6 A vs B): the **day counter** (opening balance + 1.67/month − used workdays) and the **financial accrual** (balance × average daily earnings, plus employer VSAOI on top), recomputed each run with only the **delta** posted (doc 3.7). On termination the balance is settled via the final payout, so the accrual snapshot goes to zero and the released delta offsets the compensation expense — the net effect equals the doc's "pay from 5411, don't re-book expense" rule.

**Files:**
- Create: `src/payroll/accrual.ts`
- Test: `tests/payroll/accrual.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/payroll/accrual.test.ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createEmployee, updateEmployee } from '../../src/payroll/employees.js';
import { addAbsence } from '../../src/payroll/inputs.js';
import { vacationBalanceHundredths, recomputeAccrual } from '../../src/payroll/accrual.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function makeEmp(overrides: Record<string, string> = {}) {
  const t = ctx(await makeFirmAndClient());
  const { id } = await withTenant(t, (tx) => createEmployee(tx, t, {
    firstName: 'Anna', lastName: 'Ozola', personalCode: '010190-12345', position: 'X',
    contractNo: 'DL-1', contractDate: '2026-01-02', contractType: 'indefinite',
    wageType: 'monthly', wage: '1000.00', hiredOn: '2026-01-02',
    openingVacationDays: '5', openingBalanceDate: '2026-01-31', ...overrides,
  }));
  return { t, id };
}

test('day balance: opening + 1.67/month - used vacation workdays', async () => {
  const { t, id } = await makeEmp();
  // Feb..Jul 2026 = 6 accrual months after the opening month; one 5-workday vacation in June
  await withTenant(t, (tx) => addAbsence(tx, t, {
    employeeId: id, type: 'vacation', dateFrom: '2026-06-01', dateTo: '2026-06-05',
  }));
  const bal = await withTenant(t, (tx) => vacationBalanceHundredths(tx, t, id, 2026, 7));
  // 5.00 + 6x1.67 - 5 = 10.02 days
  expect(bal).toBe(1002n);
});

test('vacation used before the opening date does not double-count', async () => {
  const { t, id } = await makeEmp();
  await withTenant(t, (tx) => addAbsence(tx, t, {
    employeeId: id, type: 'vacation', dateFrom: '2026-01-05', dateTo: '2026-01-09',
  }));
  const bal = await withTenant(t, (tx) => vacationBalanceHundredths(tx, t, id, 2026, 2));
  // opening 5.00 already reflects January; +1.67 for Feb only
  expect(bal).toBe(667n);
});

test('financial accrual: balance x avg daily + employer VSAOI; delta vs previous snapshot', async () => {
  const { t, id } = await makeEmp();
  const first = await withTenant(t, (tx) => recomputeAccrual(tx, t, {
    employeeId: id, year: 2026, month: 2, avgDailyCents: 5000n, employerBp: 2359n,
  }));
  // balance Feb = 5 + 1.67 = 6.67 days -> 333.50; VSAOI 78.67 (23.59% of 333.50 = 78.6727 -> 78.67)
  expect(first.balanceHundredths).toBe(667n);
  expect(first.accrualCents).toBe(33350n);
  expect(first.vsaoiCents).toBe(7867n);
  expect(first.deltaCents).toBe(33350n);       // no previous snapshot
  expect(first.deltaVsaoiCents).toBe(7867n);

  const second = await withTenant(t, (tx) => recomputeAccrual(tx, t, {
    employeeId: id, year: 2026, month: 3, avgDailyCents: 5000n, employerBp: 2359n,
  }));
  // balance Mar = 5 + 2x1.67 = 8.34 -> 417.00; delta = 417.00-333.50 = 83.50
  expect(second.accrualCents).toBe(41700n);
  expect(second.deltaCents).toBe(8350n);
});

test('terminated employee: accrual snaps to zero, delta releases the liability', async () => {
  const { t, id } = await makeEmp();
  await withTenant(t, (tx) => recomputeAccrual(tx, t, {
    employeeId: id, year: 2026, month: 2, avgDailyCents: 5000n, employerBp: 2359n,
  }));
  await withTenant(t, (tx) => updateEmployee(tx, t, id, { terminatedOn: '2026-03-15' }));
  const final = await withTenant(t, (tx) => recomputeAccrual(tx, t, {
    employeeId: id, year: 2026, month: 3, avgDailyCents: 5000n, employerBp: 2359n,
  }));
  expect(final.accrualCents).toBe(0n);
  expect(final.deltaCents).toBe(-33350n); // release of the February accrual
});

test('negative balance (vacation taken in advance) accrues zero, not negative', async () => {
  const { t, id } = await makeEmp({ openingVacationDays: '0', openingBalanceDate: '2026-01-31' });
  await withTenant(t, (tx) => addAbsence(tx, t, {
    employeeId: id, type: 'vacation', dateFrom: '2026-02-02', dateTo: '2026-02-13',
  }));
  const r = await withTenant(t, (tx) => recomputeAccrual(tx, t, {
    employeeId: id, year: 2026, month: 2, avgDailyCents: 5000n, employerBp: 2359n,
  }));
  expect(r.balanceHundredths).toBe(167n - 1000n); // 1.67 - 10 used
  expect(r.accrualCents).toBe(0n);                // doc 3.6: no accrual for 0/negative
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/payroll/accrual.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/payroll/accrual.ts`:

```typescript
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { toCents, fromCents } from '../db/money.js';
import { applyBp, divRound } from './rates.js';
import { getEmployee } from './employees.js';
import { lastDayOfMonth, workDaysOverlap } from './workdays.js';

/** 1.67 accrued working days per employed month, in day-hundredths (doc 3.6 A). */
const ACCRUAL_PER_MONTH_HUNDREDTHS = 167n;

const key = (y: number, m: number) => y * 12 + (m - 1);

/**
 * Vacation day balance (doc 3.6 A), in day-hundredths as of the END of (year, month):
 * opening balance + 1.67 per month after the opening month - used vacation workdays
 * dated after the opening date. May be negative (vacation taken in advance).
 */
export async function vacationBalanceHundredths(
  tx: PoolClient, ctx: TenantContext, employeeId: string, year: number, month: number,
): Promise<bigint> {
  const emp = await getEmployee(tx, ctx, employeeId);
  const openingHundredths = toCents(emp.openingVacationDays); // '5' -> 500n day-hundredths
  const openingKey = key(Number(emp.openingBalanceDate.slice(0, 4)), Number(emp.openingBalanceDate.slice(5, 7)));

  // Accrue for each month AFTER the opening month, through the asked month,
  // but not past termination.
  let endKey = key(year, month);
  if (emp.terminatedOn) endKey = Math.min(endKey, key(Number(emp.terminatedOn.slice(0, 4)), Number(emp.terminatedOn.slice(5, 7))));
  const monthsAccrued = BigInt(Math.max(0, endKey - openingKey));

  // Used vacation workdays after the opening date, up to the end of the asked month.
  const res = await tx.query(
    `SELECT to_char(date_from,'YYYY-MM-DD') AS "dateFrom", to_char(date_to,'YYYY-MM-DD') AS "dateTo"
     FROM absences
     WHERE employee_id = $1 AND client_company_id = $2 AND type = 'vacation'
       AND date_from > $3 AND date_from <= $4`,
    [employeeId, ctx.clientCompanyId, emp.openingBalanceDate, lastDayOfMonth(year, month)],
  );
  let usedDays = 0;
  for (const a of res.rows) {
    // Count all workdays of the absence (clamped month-by-month up to the asked month).
    let y = Number(a.dateFrom.slice(0, 4)); let m = Number(a.dateFrom.slice(5, 7));
    const endY = Number(a.dateTo.slice(0, 4)); const endM = Number(a.dateTo.slice(5, 7));
    while (key(y, m) <= Math.min(key(endY, endM), key(year, month))) {
      usedDays += workDaysOverlap(a.dateFrom, a.dateTo, y, m);
      m++; if (m > 12) { m = 1; y++; }
    }
  }

  return openingHundredths + monthsAccrued * ACCRUAL_PER_MONTH_HUNDREDTHS - BigInt(usedDays) * 100n;
}

export interface AccrualResult {
  balanceHundredths: bigint;
  accrualCents: bigint;
  vsaoiCents: bigint;
  deltaCents: bigint;       // vs previous snapshot — post this (doc 3.7 row 1)
  deltaVsaoiCents: bigint;  // doc 3.7 row 2
}

/**
 * Recompute the financial accrual (doc 3.6 B) for (year, month) and store the
 * snapshot. Terminated employees snap to zero — the liability is settled through
 * the final payout, so the released delta offsets the compensation expense
 * (equivalent to the doc-3.7 "pay from 5411" rule at the entry level).
 */
export async function recomputeAccrual(
  tx: PoolClient, ctx: TenantContext,
  args: { employeeId: string; year: number; month: number; avgDailyCents: bigint; employerBp: bigint },
): Promise<AccrualResult> {
  const emp = await getEmployee(tx, ctx, args.employeeId);
  const terminated = emp.terminatedOn !== null
    && key(Number(emp.terminatedOn.slice(0, 4)), Number(emp.terminatedOn.slice(5, 7))) <= key(args.year, args.month);

  const balance = await vacationBalanceHundredths(tx, ctx, args.employeeId, args.year, args.month);
  const accrual = !terminated && balance > 0n ? divRound(balance * args.avgDailyCents, 100n) : 0n;
  const vsaoi = applyBp(accrual, args.employerBp);

  const prev = await tx.query(
    `SELECT (ROUND(accrual * 100))::bigint AS accrual_cents, (ROUND(accrual_vsaoi * 100))::bigint AS vsaoi_cents
     FROM vacation_accruals
     WHERE employee_id = $1 AND client_company_id = $2 AND (year*12 + month) < $3
     ORDER BY year DESC, month DESC LIMIT 1`,
    [args.employeeId, ctx.clientCompanyId, args.year * 12 + args.month],
  );
  const prevAccrual = prev.rowCount ? BigInt(prev.rows[0].accrual_cents) : 0n;
  const prevVsaoi = prev.rowCount ? BigInt(prev.rows[0].vsaoi_cents) : 0n;

  await tx.query(
    `INSERT INTO vacation_accruals(client_company_id, employee_id, year, month, balance_days, avg_daily, accrual, accrual_vsaoi)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (employee_id, year, month)
     DO UPDATE SET balance_days = EXCLUDED.balance_days, avg_daily = EXCLUDED.avg_daily,
                   accrual = EXCLUDED.accrual, accrual_vsaoi = EXCLUDED.accrual_vsaoi`,
    [ctx.clientCompanyId, args.employeeId, args.year, args.month,
     fromCents(balance), fromCents(args.avgDailyCents), fromCents(accrual), fromCents(vsaoi)],
  );

  return {
    balanceHundredths: balance, accrualCents: accrual, vsaoiCents: vsaoi,
    deltaCents: accrual - prevAccrual, deltaVsaoiCents: vsaoi - prevVsaoi,
  };
}
```

Note: `fromCents(balance)` reuses cent-formatting for day-hundredths ('1002n' → '10.02') — same fixed-point representation.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/payroll/accrual.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/payroll/accrual.ts tests/payroll/accrual.test.ts
git commit -m "feat(payroll): vacation day balance + monthly financial accrual with delta"
```

---

### Task 12: The monthly run — open + compute (doc 2.2 autopilot core)

`computeRun` assembles each employee's inputs (worked days from absences, components from orders, tax status, average earnings, YTD) and calls the pure `computePayroll`. Recompute is allowed while draft/computed (wipes and re-creates items); approved runs are locked.

**Files:**
- Create: `src/payroll/run.ts`
- Test: `tests/payroll/run-compute.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/payroll/run-compute.test.ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createEmployee, setMonthlyTaxStatus, importOpeningHistory } from '../../src/payroll/employees.js';
import { addAbsence, addPayComponent } from '../../src/payroll/inputs.js';
import { openRun, computeRun, getRunWithItems, listRuns } from '../../src/payroll/run.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

const EMP = {
  firstName: 'Anna', lastName: 'Ozola', personalCode: '010190-12345', position: 'X',
  contractNo: 'DL-1', contractDate: '2026-01-02', contractType: 'indefinite' as const,
  wageType: 'monthly' as const, wage: '1000.00', hiredOn: '2026-01-02',
  openingVacationDays: '0', openingBalanceDate: '2026-01-02',
};

test('monthly employee, full July 2026, 300 bonus: whole item verified', async () => {
  const t = ctx(await makeFirmAndClient());
  const { id: emp } = await withTenant(t, (tx) => createEmployee(tx, t, EMP));
  await withTenant(t, async (tx) => {
    await setMonthlyTaxStatus(tx, t, emp, { year: 2026, month: 7, taxBookActive: true, dependents: 0, disabilityGroup: 0 });
    await addPayComponent(tx, t, { employeeId: emp, year: 2026, month: 7, kind: 'bonus', amount: '300.00' });
  });
  const { id: runId } = await withTenant(t, (tx) => openRun(tx, t, { year: 2026, month: 7 }));
  await withTenant(t, (tx) => computeRun(tx, t, runId));
  const run = await withTenant(t, (tx) => getRunWithItems(tx, t, runId));
  expect(run.status).toBe('computed');
  expect(run.items).toHaveLength(1);
  const i = run.items[0]!;
  expect(i.workedDays).toBe(23);
  expect(i.totalWorkDays).toBe(23);
  expect(i.base).toBe('1000.00');
  expect(i.bonus).toBe('300.00');
  expect(i.gross).toBe('1300.00');
  expect(i.avgBaseGross).toBe('1300.00');
  expect(i.vsaoiEmployee).toBe('136.50');   // 10.5%
  expect(i.iin).toBe('156.44');             // (1300-136.50-550)*25.5% = 156.4425
  expect(i.net).toBe('1007.06');
  expect(i.vsaoiEmployer).toBe('306.67');   // 23.59% of 1300 = 306.67
  expect(i.riskDuty).toBe('0.36');
  expect(i.warnings).toContain('avg_earnings_fallback'); // no history yet
  expect(i.explanation.length).toBeGreaterThan(0);
});

test('hourly employee: base = hours x rate', async () => {
  const t = ctx(await makeFirmAndClient());
  const { id: emp } = await withTenant(t, (tx) => createEmployee(tx, t, {
    ...EMP, personalCode: '010190-22222', contractNo: 'DL-2', wageType: 'hourly', wage: '10.00',
  }));
  await withTenant(t, async (tx) => {
    await setMonthlyTaxStatus(tx, t, emp, { year: 2026, month: 7, taxBookActive: true, dependents: 0, disabilityGroup: 0 });
    await addPayComponent(tx, t, { employeeId: emp, year: 2026, month: 7, kind: 'hours_worked', quantity: '100' });
  });
  const { id: runId } = await withTenant(t, (tx) => openRun(tx, t, { year: 2026, month: 7 }));
  await withTenant(t, (tx) => computeRun(tx, t, runId));
  const run = await withTenant(t, (tx) => getRunWithItems(tx, t, runId));
  expect(run.items[0]!.base).toBe('1000.00');
});

test('overtime premium from hourly rate of a monthly wage (doc 3.3)', async () => {
  const t = ctx(await makeFirmAndClient());
  const { id: emp } = await withTenant(t, (tx) => createEmployee(tx, t, EMP));
  await withTenant(t, async (tx) => {
    await setMonthlyTaxStatus(tx, t, emp, { year: 2026, month: 7, taxBookActive: true, dependents: 0, disabilityGroup: 0 });
    await addPayComponent(tx, t, { employeeId: emp, year: 2026, month: 7, kind: 'overtime_hours', quantity: '8' });
  });
  const { id: runId } = await withTenant(t, (tx) => openRun(tx, t, { year: 2026, month: 7 }));
  await withTenant(t, (tx) => computeRun(tx, t, runId));
  const i = (await withTenant(t, (tx) => getRunWithItems(tx, t, runId))).items[0]!;
  // hourly rate = 1000.00 / (23x8) = 5.43 (half-up); overtime 100% -> 5.43/h; 8h = 43.44
  expect(i.premiums).toBe('43.44');
});

test('vacation mid-month uses the shared average earnings', async () => {
  const t = ctx(await makeFirmAndClient());
  const { id: emp } = await withTenant(t, (tx) => createEmployee(tx, t, EMP));
  await withTenant(t, async (tx) => {
    await setMonthlyTaxStatus(tx, t, emp, { year: 2026, month: 7, taxBookActive: true, dependents: 0, disabilityGroup: 0 });
    await importOpeningHistory(tx, t, emp, [1, 2, 3, 4, 5, 6].map((month) => ({
      year: 2026, month, avgBaseGross: '1000.00', workedDays: 21,
    })));
    await addAbsence(tx, t, { employeeId: emp, type: 'vacation', dateFrom: '2026-07-13', dateTo: '2026-07-24' });
  });
  const { id: runId } = await withTenant(t, (tx) => openRun(tx, t, { year: 2026, month: 7 }));
  await withTenant(t, (tx) => computeRun(tx, t, runId));
  const i = (await withTenant(t, (tx) => getRunWithItems(tx, t, runId))).items[0]!;
  // daily avg = 6000/126 = 47.62; vacation = 10 workdays x 47.62 = 476.20
  expect(i.avgDaily).toBe('47.62');
  expect(i.vacationPay).toBe('476.20');
  expect(i.workedDays).toBe(13); // 23 - 10
  expect(i.base).toBe('565.22'); // 1000 x 13/23
  expect(i.warnings).not.toContain('avg_earnings_fallback');
});

test('missing monthly tax status: computes with no reliefs + warning (doc 2.2)', async () => {
  const t = ctx(await makeFirmAndClient());
  await withTenant(t, (tx) => createEmployee(tx, t, EMP));
  const { id: runId } = await withTenant(t, (tx) => openRun(tx, t, { year: 2026, month: 7 }));
  await withTenant(t, (tx) => computeRun(tx, t, runId));
  const i = (await withTenant(t, (tx) => getRunWithItems(tx, t, runId))).items[0]!;
  expect(i.warnings).toContain('tax_status_missing');
  // no reliefs: IIN = (1000 - 105) * 25.5% = 228.23 (228.225 half-up)
  expect(i.iin).toBe('228.23');
});

test('recompute wipes and re-creates items; duplicate run for a month is rejected', async () => {
  const t = ctx(await makeFirmAndClient());
  const { id: emp } = await withTenant(t, (tx) => createEmployee(tx, t, EMP));
  const { id: runId } = await withTenant(t, (tx) => openRun(tx, t, { year: 2026, month: 7 }));
  await withTenant(t, (tx) => computeRun(tx, t, runId));
  await withTenant(t, (tx) => addPayComponent(tx, t, { employeeId: emp, year: 2026, month: 7, kind: 'bonus', amount: '50.00' }));
  await withTenant(t, (tx) => computeRun(tx, t, runId)); // recompute picks up the new bonus
  const run = await withTenant(t, (tx) => getRunWithItems(tx, t, runId));
  expect(run.items).toHaveLength(1);
  expect(run.items[0]!.bonus).toBe('50.00');
  await expect(withTenant(t, (tx) => openRun(tx, t, { year: 2026, month: 7 }))).rejects.toThrow(/duplicate key/i);
  expect(await withTenant(t, (tx) => listRuns(tx, t))).toHaveLength(1);
});

test('MUN-regime client is refused (phase 1 stores the flag only)', async () => {
  const t = ctx(await makeFirmAndClient());
  await withTenant(t, async (tx) => {
    await tx.query(
      `INSERT INTO payroll_settings(client_company_id, mun_regime) VALUES ($1, true)`,
      [t.clientCompanyId]);
  });
  await expect(withTenant(t, (tx) => openRun(tx, t, { year: 2026, month: 7 })))
    .rejects.toThrow(/MUN/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/payroll/run-compute.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/payroll/run.ts`:

```typescript
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { toCents, fromCents } from '../db/money.js';
import { appendAudit } from '../audit/audit.js';
import { applyBp, divRound } from './rates.js';
import { loadPayrollParams, type PayrollParams } from './params.js';
import { getPayrollSettings } from './settings.js';
import { activeEmployeesFor, taxStatusFor, type EmployeeRow } from './employees.js';
import { listAbsencesOverlapping, listComponents } from './inputs.js';
import { computePayroll } from './calc.js';
import { computeAverageEarnings } from './average-earnings.js';
import { computeSickPayA, computeVacationPay } from './absence-pay.js';
import { firstDayOfMonth, lastDayOfMonth, workDaysInMonth, workDaysOverlap } from './workdays.js';

export interface RunRow { id: string; year: number; month: number; status: 'draft' | 'computed' | 'approved'; }
export interface RunItemRow {
  employeeId: string; workedDays: number; totalWorkDays: number;
  base: string; premiums: string; bonus: string; vacationPay: string; sickPay: string;
  otherTaxable: string; severanceExempt: string; gross: string; avgBaseGross: string; avgDaily: string;
  vsaoiEmployee: string; iin: string; otherDeductions: string; net: string; payout: string;
  vsaoiEmployer: string; riskDuty: string; warnings: string[]; explanation: { step: string; amount: string }[];
}

export async function openRun(
  tx: PoolClient, ctx: TenantContext, p: { year: number; month: number },
): Promise<{ id: string }> {
  const settings = await getPayrollSettings(tx, ctx);
  if (settings.munRegime) {
    throw new Error('MUN-regime payroll is not supported in phase 1 — the flag is stored, the calculation is general-regime only');
  }
  const res = await tx.query(
    `INSERT INTO payroll_runs(client_company_id, year, month) VALUES ($1,$2,$3) RETURNING id`,
    [ctx.clientCompanyId, p.year, p.month],
  );
  const id = res.rows[0].id as string;
  await appendAudit(tx, ctx, { action: 'create', entityType: 'payroll_run', entityId: id, before: null, after: p });
  return { id };
}

export async function getRun(tx: PoolClient, ctx: TenantContext, runId: string): Promise<RunRow> {
  const res = await tx.query(
    `SELECT id, year, month, status FROM payroll_runs WHERE id = $1 AND client_company_id = $2`,
    [runId, ctx.clientCompanyId],
  );
  if (!res.rowCount) throw new Error(`Payroll run not found: ${runId}`);
  return res.rows[0];
}

export async function listRuns(tx: PoolClient, ctx: TenantContext): Promise<RunRow[]> {
  const res = await tx.query(
    `SELECT id, year, month, status FROM payroll_runs WHERE client_company_id = $1 ORDER BY year DESC, month DESC`,
    [ctx.clientCompanyId],
  );
  return res.rows;
}

export async function getRunWithItems(
  tx: PoolClient, ctx: TenantContext, runId: string,
): Promise<RunRow & { items: RunItemRow[] }> {
  const run = await getRun(tx, ctx, runId);
  const res = await tx.query(
    `SELECT employee_id AS "employeeId", worked_days AS "workedDays", total_work_days AS "totalWorkDays",
            base::text, premiums::text, bonus::text, vacation_pay::text AS "vacationPay",
            sick_pay::text AS "sickPay", other_taxable::text AS "otherTaxable",
            severance_exempt::text AS "severanceExempt", gross::text, avg_base_gross::text AS "avgBaseGross",
            avg_daily::text AS "avgDaily", vsaoi_employee::text AS "vsaoiEmployee", iin::text,
            other_deductions::text AS "otherDeductions", net::text, payout::text,
            vsaoi_employer::text AS "vsaoiEmployer", risk_duty::text AS "riskDuty", warnings, explanation
     FROM payroll_items WHERE run_id = $1 AND client_company_id = $2 ORDER BY employee_id`,
    [runId, ctx.clientCompanyId],
  );
  return { ...run, items: res.rows };
}

/** Hour-quantity string ('8' / '7.50') -> hour-hundredths (800n / 750n). */
const toHourHundredths = toCents;

async function computeEmployee(
  tx: PoolClient, ctx: TenantContext, emp: EmployeeRow,
  year: number, month: number, params: PayrollParams,
): Promise<Record<string, unknown>> {
  const warnings: string[] = [];
  const totalWorkDays = workDaysInMonth(year, month);
  const first = firstDayOfMonth(year, month);
  const last = lastDayOfMonth(year, month);

  // Employment window inside the month (mid-month hire/termination).
  const empFrom = emp.hiredOn > first ? emp.hiredOn : first;
  const empTo = emp.terminatedOn && emp.terminatedOn < last ? emp.terminatedOn : last;
  const employedWorkDays = workDaysOverlap(empFrom, empTo, year, month);

  // Absences -> absent workdays + pay inputs.
  const absences = await listAbsencesOverlapping(tx, ctx, emp.id, year, month);
  let absentDays = 0;
  for (const a of absences) absentDays += workDaysOverlap(a.dateFrom, a.dateTo, year, month);
  const workedDays = Math.max(0, employedWorkDays - absentDays);

  // Components.
  const comps = await listComponents(tx, ctx, emp.id, year, month);
  const sum = (kind: string) => comps.filter((c) => c.kind === kind)
    .reduce((s, c) => s + toCents(c.amount!), 0n);
  const hours = (kind: string) => comps.filter((c) => c.kind === kind)
    .reduce((s, c) => s + toHourHundredths(c.quantity!), 0n);

  // Base pay + hourly rate (doc 3.3 premium basis).
  const wageCents = toCents(emp.wage);
  let baseCents: bigint;
  let hourlyRateCents: bigint;
  if (emp.wageType === 'monthly') {
    baseCents = totalWorkDays > 0 ? divRound(wageCents * BigInt(workedDays), BigInt(totalWorkDays)) : 0n;
    hourlyRateCents = divRound(wageCents, BigInt(totalWorkDays * 8));
  } else {
    baseCents = divRound(wageCents * hours('hours_worked'), 100n);
    hourlyRateCents = wageCents;
  }

  // Premiums stack (doc 3.3): each is pct of the rate, per hour.
  const premium = (kind: string, bp: bigint) => divRound(applyBp(hourlyRateCents, bp) * hours(kind), 100n);
  const premiumCents = premium('night_hours', params.premiumNightBp)
    + premium('overtime_hours', params.premiumOvertimeBp)
    + premium('holiday_hours', params.premiumHolidayBp);

  // Average earnings — the one shared function; wage-derived fallback if no history yet.
  let avgDailyCents: bigint;
  try {
    const avg = await computeAverageEarnings(tx, ctx, emp.id, first);
    avgDailyCents = avg.dailyCents;
    if (avg.shifted) warnings.push('avg_earnings_window_shifted');
  } catch {
    avgDailyCents = emp.wageType === 'monthly'
      ? divRound(wageCents, BigInt(totalWorkDays))
      : wageCents * 8n;
    warnings.push('avg_earnings_fallback');
  }

  // Absence pay.
  let vacationPayCents = 0n;
  let sickPayCents = 0n;
  for (const a of absences) {
    if (a.type === 'vacation') {
      vacationPayCents += computeVacationPay({ from: a.dateFrom, to: a.dateTo, year, month, avgDailyCents });
    } else if (a.type === 'sick_a') {
      sickPayCents += computeSickPayA({
        sickFrom: a.dateFrom, sickTo: a.dateTo, year, month, avgDailyCents,
        sickDay23Bp: params.sickDay23Bp, sickDay49Bp: params.sickDay49Bp,
      }).totalCents;
    }
    // sick_b / unpaid / other: absence without employer pay
  }

  // Monthly tax-book data (doc 2.2 — must be fresh every month).
  const tax = await taxStatusFor(tx, ctx, emp.id, year, month);
  if (!tax) warnings.push('tax_status_missing');
  else if (tax.stale) warnings.push('tax_status_stale');

  // YTD VSAOI base from approved runs this calendar year.
  const ytd = await tx.query(
    `SELECT COALESCE(SUM(ROUND(i.gross * 100)), 0)::bigint AS cents
     FROM payroll_items i JOIN payroll_runs r ON r.id = i.run_id
     WHERE i.employee_id = $1 AND i.client_company_id = $2
       AND r.status = 'approved' AND r.year = $3 AND r.month < $4`,
    [emp.id, ctx.clientCompanyId, year, month],
  );

  const result = computePayroll({
    baseCents, premiumCents,
    bonusCents: sum('bonus'),
    vacationPayCents, sickPayCents,
    otherTaxableCents: sum('other_taxable'),
    severanceExemptCents: sum('severance_exempt'),
    taxBookActive: tax?.taxBookActive ?? false,
    dependents: tax?.dependents ?? 0,
    disabilityGroup: (tax?.disabilityGroup ?? 0) as 0 | 1 | 2 | 3,
    workedDays, totalWorkDays,
    requestedDeductionsCents: sum('deduction'),
    ytdVsaoiBaseCents: BigInt(ytd.rows[0].cents),
  }, params);

  return {
    employee_id: emp.id, worked_days: workedDays, total_work_days: totalWorkDays,
    base: fromCents(baseCents), premiums: fromCents(premiumCents), bonus: fromCents(sum('bonus')),
    vacation_pay: fromCents(vacationPayCents), sick_pay: fromCents(sickPayCents),
    other_taxable: fromCents(sum('other_taxable')), severance_exempt: fromCents(sum('severance_exempt')),
    gross: fromCents(result.grossCents),
    avg_base_gross: fromCents(baseCents + premiumCents + sum('bonus')),
    avg_daily: fromCents(avgDailyCents),
    vsaoi_employee: fromCents(result.vsaoiEmployeeCents), iin: fromCents(result.iinCents),
    other_deductions: fromCents(result.deductionsAppliedCents),
    net: fromCents(result.netCents), payout: fromCents(result.payoutCents),
    vsaoi_employer: fromCents(result.vsaoiEmployerCents), risk_duty: fromCents(result.riskDutyCents),
    warnings: JSON.stringify([...warnings, ...result.warnings]),
    explanation: JSON.stringify(result.explanation),
  };
}

/** Compute (or recompute) every active employee's item for the run's month. */
export async function computeRun(tx: PoolClient, ctx: TenantContext, runId: string): Promise<void> {
  const run = await getRun(tx, ctx, runId);
  if (run.status === 'approved') throw new Error(`Run ${runId} is approved and cannot be recomputed`);

  const params = await loadPayrollParams(tx, lastDayOfMonth(run.year, run.month));
  await tx.query('DELETE FROM payroll_items WHERE run_id = $1 AND client_company_id = $2', [runId, ctx.clientCompanyId]);

  const employees = await activeEmployeesFor(tx, ctx, run.year, run.month);
  for (const emp of employees) {
    const item = await computeEmployee(tx, ctx, emp, run.year, run.month, params);
    await tx.query(
      `INSERT INTO payroll_items(client_company_id, run_id, employee_id, worked_days, total_work_days,
         base, premiums, bonus, vacation_pay, sick_pay, other_taxable, severance_exempt,
         gross, avg_base_gross, avg_daily, vsaoi_employee, iin, other_deductions, net, payout,
         vsaoi_employer, risk_duty, warnings, explanation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [ctx.clientCompanyId, runId, item.employee_id, item.worked_days, item.total_work_days,
       item.base, item.premiums, item.bonus, item.vacation_pay, item.sick_pay,
       item.other_taxable, item.severance_exempt, item.gross, item.avg_base_gross, item.avg_daily,
       item.vsaoi_employee, item.iin, item.other_deductions, item.net, item.payout,
       item.vsaoi_employer, item.risk_duty, item.warnings, item.explanation],
    );
  }

  await tx.query(
    `UPDATE payroll_runs SET status = 'computed' WHERE id = $1 AND client_company_id = $2`,
    [runId, ctx.clientCompanyId],
  );
  await appendAudit(tx, ctx, {
    action: 'compute', entityType: 'payroll_run', entityId: runId,
    before: { status: run.status }, after: { status: 'computed', employees: employees.length },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/payroll/run-compute.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/payroll/run.ts tests/payroll/run-compute.test.ts
git commit -m "feat(payroll): monthly run — open + compute over the pure calc core"
```

---

### Task 13: Run approval — journal postings (doc 3.4 rows 1–8 + 3.7)

Approval posts, per employee, one balanced wage entry (accrual rows 1–8: expense↔payable pairs; the payment rows 9–12 stay separate per the doc — payment execution is the bank module's job) and one accrual-delta entry. Posting date = last day of the month; the existing `postEntry` enforces the open accounting period and append-only rules.

**Files:**
- Modify: `src/payroll/run.ts` (add `approveRun`)
- Test: `tests/payroll/run-approve.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/payroll/run-approve.test.ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { createEmployee, setMonthlyTaxStatus } from '../../src/payroll/employees.js';
import { openRun, computeRun, approveRun, getRun } from '../../src/payroll/run.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function setup() {
  const t = ctx(await makeFirmAndClient());
  const { id: emp } = await withTenant(t, (tx) => createEmployee(tx, t, {
    firstName: 'Anna', lastName: 'Ozola', personalCode: '010190-12345', position: 'X',
    contractNo: 'DL-1', contractDate: '2026-01-02', contractType: 'indefinite',
    wageType: 'monthly', wage: '1000.00', hiredOn: '2026-01-02',
    openingVacationDays: '0', openingBalanceDate: '2026-06-30',
  }));
  await withTenant(t, async (tx) => {
    await openPeriod(tx, t, { year: 2026, month: 7 });
    await setMonthlyTaxStatus(tx, t, emp, { year: 2026, month: 7, taxBookActive: true, dependents: 0, disabilityGroup: 0 });
  });
  const { id: runId } = await withTenant(t, (tx) => openRun(tx, t, { year: 2026, month: 7 }));
  await withTenant(t, (tx) => computeRun(tx, t, runId));
  return { t, emp, runId };
}

test('approval posts the doc-3.4 wage entry and the doc-3.7 accrual entry', async () => {
  const { t, runId } = await setup();
  await withTenant(t, (tx) => approveRun(tx, t, runId));

  const run = await withTenant(t, (tx) => getRun(tx, t, runId));
  expect(run.status).toBe('approved');

  await withTenant(t, async (tx) => {
    // ORDER BY memo, not created_at: both entries share the transaction's now().
    // 'Alga ...' sorts before 'Atvaļinājuma uzkrājums ...'.
    const entries = await tx.query(
      `SELECT je.id, je.memo FROM journal_entries je WHERE je.client_company_id = $1 ORDER BY je.memo`,
      [t.clientCompanyId]);
    expect(entries.rows).toHaveLength(2); // wage entry + accrual entry
    expect(entries.rows[0].memo).toMatch(/Alga 2026-07/);
    expect(entries.rows[1].memo).toMatch(/uzkrājums/i);

    // Wage entry: 1000 gross, tax status active, 0 dependents:
    // VSAOI emp 105.00, IIN (1000-105-550)*25.5% = 87.98, employer VSAOI 235.90, risk duty 0.36
    const lines = await tx.query(
      `SELECT a.code, jl.debit::text, jl.credit::text
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE jl.entry_id = $1 ORDER BY a.code, jl.debit DESC`,
      [entries.rows[0].id]);
    const find = (code: string, side: 'debit' | 'credit') =>
      lines.rows.filter((l: { code: string; debit: string; credit: string }) => l.code === code && l[side] !== '0.00');
    expect(find('7210', 'debit')[0].debit).toBe('1000.00');
    expect(find('5610', 'credit')[0].credit).toBe('1000.00');
    expect(find('7310', 'debit')[0].debit).toBe('235.90');
    expect(find('57221', 'credit').map((l: { credit: string }) => l.credit).sort()).toEqual(['105.00', '235.90']);
    expect(find('7330', 'debit')[0].debit).toBe('0.36');
    expect(find('5723', 'credit')[0].credit).toBe('0.36');
    expect(find('5720', 'credit')[0].credit).toBe('87.98');
    expect(find('5610', 'debit').map((l: { debit: string }) => l.debit).sort()).toEqual(['105.00', '87.98']);

    // Accrual entry: July balance = 1.67 days x avg daily (fallback 1000/23 = 43.48) = 72.61;
    // VSAOI 23.59% = 17.13
    const acc = await tx.query(
      `SELECT a.code, jl.debit::text, jl.credit::text
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE jl.entry_id = $1`, [entries.rows[1].id]);
    const accBy = (code: string) => acc.rows.find((l: { code: string }) => l.code === code)!;
    expect(accBy('5411').credit).toBe('72.61');
    expect(accBy('5412').credit).toBe('17.13');
  });
});

test('approve requires computed status; double approve and recompute-after-approve fail', async () => {
  const { t, runId } = await setup();
  await withTenant(t, (tx) => approveRun(tx, t, runId));
  await expect(withTenant(t, (tx) => approveRun(tx, t, runId))).rejects.toThrow(/not computed/);
  await expect(withTenant(t, (tx) => computeRun(tx, t, runId))).rejects.toThrow(/approved/);
});

test('approval fails when the accounting period is closed (postEntry guard)', async () => {
  const { t, runId } = await setup();
  await withTenant(t, async (tx) => {
    await tx.query(`UPDATE accounting_periods SET status='closed' WHERE client_company_id=$1`, [t.clientCompanyId]);
  });
  await expect(withTenant(t, (tx) => approveRun(tx, t, runId))).rejects.toThrow(/closed period/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/payroll/run-approve.test.ts`
Expected: FAIL — `approveRun` is not exported.

- [ ] **Step 3: Implement `approveRun`**

Add to `src/payroll/run.ts` (new imports at the top, function at the bottom):

```typescript
// add to imports:
import { postEntry, type NewJournalLine } from '../ledger/posting.js';
import { ensurePayrollAccounts, type PayrollSettings } from './settings.js';
import { recomputeAccrual } from './accrual.js';
```

```typescript
/** A balanced debit/credit pair; skipped when the amount is zero. */
function pair(debitAcc: string, creditAcc: string, cents: bigint, description: string): NewJournalLine[] {
  if (cents === 0n) return [];
  return [
    { accountCode: debitAcc, debit: fromCents(cents), credit: '0', description },
    { accountCode: creditAcc, debit: '0', credit: fromCents(cents), description },
  ];
}

/**
 * Approve a computed run: post the doc-3.4 accrual rows (1-8) per employee, then
 * the doc-3.7 vacation-accrual delta. Payment rows (9-12) happen in the bank module
 * when money actually moves — the doc requires the two steps stay separate.
 */
export async function approveRun(tx: PoolClient, ctx: TenantContext, runId: string): Promise<void> {
  const run = await getRun(tx, ctx, runId);
  if (run.status !== 'computed') throw new Error(`Run ${runId} is not computed (status: ${run.status})`);

  const s: PayrollSettings = await getPayrollSettings(tx, ctx);
  await ensurePayrollAccounts(tx, ctx);
  const params = await loadPayrollParams(tx, lastDayOfMonth(run.year, run.month));
  const entryDate = lastDayOfMonth(run.year, run.month);
  const label = `${run.year}-${String(run.month).padStart(2, '0')}`;

  const items = await tx.query(
    `SELECT i.employee_id, e.first_name, e.last_name,
            (ROUND(i.gross*100))::bigint AS gross, (ROUND(i.severance_exempt*100))::bigint AS severance,
            (ROUND(i.vsaoi_employee*100))::bigint AS vsaoi_emp, (ROUND(i.iin*100))::bigint AS iin,
            (ROUND(i.other_deductions*100))::bigint AS deductions,
            (ROUND(i.vsaoi_employer*100))::bigint AS vsaoi_er, (ROUND(i.risk_duty*100))::bigint AS risk,
            (ROUND(i.avg_daily*100))::bigint AS avg_daily
     FROM payroll_items i JOIN employees e ON e.id = i.employee_id
     WHERE i.run_id = $1 AND i.client_company_id = $2 ORDER BY e.last_name, e.first_name`,
    [runId, ctx.clientCompanyId],
  );

  for (const r of items.rows) {
    const name = `${r.last_name} ${r.first_name}`;
    // Doc 3.4 rows 1-8 as one balanced entry (each pair is one row of the scheme).
    const lines: NewJournalLine[] = [
      ...pair(s.accWageExpense, s.accWagesPayable, BigInt(r.gross), 'Bruto alga (3.4 r.1-2)'),
      ...pair(s.accSeveranceExpense, s.accWagesPayable, BigInt(r.severance), 'Atlaišanas pabalsts (3.4 r.3)'),
      ...pair(s.accEmployerVsaoiExpense, s.accVsaoiPayable, BigInt(r.vsaoi_er), 'Darba devēja VSAOI (3.4 r.4)'),
      ...pair(s.accRiskDutyExpense, s.accRiskDutyPayable, BigInt(r.risk), 'Riska nodeva (3.4 r.5)'),
      ...pair(s.accWagesPayable, s.accIinPayable, BigInt(r.iin), 'IIN ieturējums (3.4 r.6)'),
      ...pair(s.accWagesPayable, s.accVsaoiPayable, BigInt(r.vsaoi_emp), 'VSAOI darbinieka daļa (3.4 r.7)'),
      ...pair(s.accWagesPayable, s.accOtherDeductionsPayable, BigInt(r.deductions), 'Citi ieturējumi (3.4 r.8)'),
    ];
    if (lines.length > 0) {
      await postEntry(tx, ctx, { date: entryDate, memo: `Alga ${label} — ${name}`, currency: 'EUR', lines });
    }

    // Doc 3.7: vacation-accrual delta (positive = build up, negative = release).
    const acc = await recomputeAccrual(tx, ctx, {
      employeeId: r.employee_id, year: run.year, month: run.month,
      avgDailyCents: BigInt(r.avg_daily), employerBp: params.vsaoiEmployerBp,
    });
    const accLines: NewJournalLine[] = [
      ...(acc.deltaCents >= 0n
        ? pair(s.accWageExpense, s.accVacationAccrualLiability, acc.deltaCents, 'Atvaļinājuma uzkrājums (3.7)')
        : pair(s.accVacationAccrualLiability, s.accWageExpense, -acc.deltaCents, 'Atvaļinājuma uzkrājuma samazinājums (3.7)')),
      ...(acc.deltaVsaoiCents >= 0n
        ? pair(s.accEmployerVsaoiExpense, s.accVacationAccrualVsaoiLiability, acc.deltaVsaoiCents, 'VSAOI par uzkrājumu (3.7)')
        : pair(s.accVacationAccrualVsaoiLiability, s.accEmployerVsaoiExpense, -acc.deltaVsaoiCents, 'VSAOI uzkrājuma samazinājums (3.7)')),
    ];
    if (accLines.length > 0) {
      await postEntry(tx, ctx, { date: entryDate, memo: `Atvaļinājuma uzkrājums ${label} — ${name}`, currency: 'EUR', lines: accLines });
    }
  }

  await tx.query(
    `UPDATE payroll_runs SET status = 'approved', approved_at = now() WHERE id = $1 AND client_company_id = $2`,
    [runId, ctx.clientCompanyId],
  );
  await appendAudit(tx, ctx, {
    action: 'approve', entityType: 'payroll_run', entityId: runId,
    before: { status: 'computed' }, after: { status: 'approved', employees: items.rowCount },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/payroll/run-approve.test.ts`
Expected: PASS (3 tests). Also re-run `npx vitest run tests/payroll/` — all payroll tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/payroll/run.ts tests/payroll/run-approve.test.ts
git commit -m "feat(payroll): run approval posts doc-3.4 wage entries + doc-3.7 accrual deltas"
```

---

### Task 14: Termination — final settlement (doc 3.8)

One termination order produces the whole final settlement: last-month wage comes from the normal run; approval of the order sets `terminated_on` and creates the vacation-compensation component (taxable) and the severance component (statutory amount — IIN- and VSAOI-exempt) so the final run's item is the single combined document the doc demands.

**Files:**
- Create: `src/payroll/termination.ts`
- Modify: `src/payroll/orders.ts` (replace the `termination` branch)
- Test: `tests/payroll/termination.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/payroll/termination.test.ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createEmployee, getEmployee, setMonthlyTaxStatus, importOpeningHistory } from '../../src/payroll/employees.js';
import { listComponents } from '../../src/payroll/inputs.js';
import { createOrder, approveOrder } from '../../src/payroll/orders.js';
import { severanceMonthsFor } from '../../src/payroll/termination.js';
import { openRun, computeRun, getRunWithItems } from '../../src/payroll/run.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('severance months by tenure (doc 3.8 table)', () => {
  expect(severanceMonthsFor('2023-01-02', '2026-07-31')).toBe(1); // 3 years
  expect(severanceMonthsFor('2020-03-01', '2026-07-31')).toBe(2); // 6 years
  expect(severanceMonthsFor('2012-07-31', '2026-07-31')).toBe(3); // exactly 14 years
  expect(severanceMonthsFor('2004-01-02', '2026-07-31')).toBe(4); // 22 years
  expect(severanceMonthsFor('2021-08-01', '2026-07-31')).toBe(1); // 4y 364d -> under 5
});

async function setup() {
  const t = ctx(await makeFirmAndClient());
  const { id: emp } = await withTenant(t, (tx) => createEmployee(tx, t, {
    firstName: 'Anna', lastName: 'Ozola', personalCode: '010190-12345', position: 'X',
    contractNo: 'DL-1', contractDate: '2020-03-01', contractType: 'indefinite',
    wageType: 'monthly', wage: '1000.00', hiredOn: '2020-03-01',
    openingVacationDays: '10', openingBalanceDate: '2026-06-30',
  }));
  await withTenant(t, async (tx) => {
    await setMonthlyTaxStatus(tx, t, emp, { year: 2026, month: 7, taxBookActive: true, dependents: 0, disabilityGroup: 0 });
    await importOpeningHistory(tx, t, emp, [1, 2, 3, 4, 5, 6].map((month) => ({
      year: 2026, month, avgBaseGross: '1000.00', workedDays: 21,
    })));
  });
  return { t, emp };
}

test('termination order approval: sets terminated_on, creates compensation + severance', async () => {
  const { t, emp } = await setup();
  const { id } = await withTenant(t, (tx) => createOrder(tx, t, {
    orderType: 'termination', employeeIds: [emp],
    dateFrom: '2026-07-31', dateTo: '2026-07-31', effectiveDate: '2026-07-31',
    reason: 'Darbinieka uzteikums (DL 100)', payload: { severance: true },
  }));
  await withTenant(t, (tx) => approveOrder(tx, t, id));

  const e = await withTenant(t, (tx) => getEmployee(tx, t, emp));
  expect(e.terminatedOn).toBe('2026-07-31');

  const comps = await withTenant(t, (tx) => listComponents(tx, t, emp, 2026, 7));
  const byKind = (k: string) => comps.find((c) => c.kind === k)!;
  // daily avg 6000/126 = 47.62; balance = 10 + 1.67 = 11.67 days -> 555.73
  expect(byKind('other_taxable').amount).toBe('555.73');
  // monthly avg = 47.62 x (129 window workdays / 6) = 1023.83; 6y tenure -> 2 months = 2047.66
  expect(byKind('severance_exempt').amount).toBe('2047.66');
});

test('the final run combines wage + compensation + exempt severance in one item', async () => {
  const { t, emp } = await setup();
  const { id } = await withTenant(t, (tx) => createOrder(tx, t, {
    orderType: 'termination', employeeIds: [emp],
    dateFrom: '2026-07-31', dateTo: '2026-07-31', effectiveDate: '2026-07-31',
    reason: 'X', payload: { severance: true },
  }));
  await withTenant(t, (tx) => approveOrder(tx, t, id));
  const { id: runId } = await withTenant(t, (tx) => openRun(tx, t, { year: 2026, month: 7 }));
  await withTenant(t, (tx) => computeRun(tx, t, runId));
  const i = (await withTenant(t, (tx) => getRunWithItems(tx, t, runId))).items[0]!;
  expect(i.base).toBe('1000.00');            // worked through 2026-07-31
  expect(i.otherTaxable).toBe('555.73');     // vacation compensation — taxed
  expect(i.severanceExempt).toBe('2047.66'); // severance — payout only
  expect(i.gross).toBe('1555.73');           // severance NOT in gross
  const netCents = BigInt(i.net.replace('.', ''));
  expect(BigInt(i.payout.replace('.', ''))).toBe(netCents + 204766n);
});

test('termination without severance entitlement creates no severance component', async () => {
  const { t, emp } = await setup();
  const { id } = await withTenant(t, (tx) => createOrder(tx, t, {
    orderType: 'termination', employeeIds: [emp],
    dateFrom: '2026-07-31', dateTo: '2026-07-31', effectiveDate: '2026-07-31',
    reason: 'X', payload: { severance: false },
  }));
  await withTenant(t, (tx) => approveOrder(tx, t, id));
  const comps = await withTenant(t, (tx) => listComponents(tx, t, emp, 2026, 7));
  expect(comps.find((c) => c.kind === 'severance_exempt')).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/payroll/termination.test.ts`
Expected: FAIL — module `src/payroll/termination.ts` not found.

- [ ] **Step 3: Implement**

Create `src/payroll/termination.ts`:

```typescript
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { fromCents } from '../db/money.js';
import { divRound } from './rates.js';
import { getEmployee, updateEmployee } from './employees.js';
import { addPayComponent } from './inputs.js';
import { computeAverageEarnings } from './average-earnings.js';
import { vacationBalanceHundredths } from './accrual.js';

/** Severance by unbroken tenure with this employer (doc 3.8 table). */
export function severanceMonthsFor(hiredOn: string, lastDay: string): number {
  const h = new Date(`${hiredOn}T00:00:00Z`);
  const l = new Date(`${lastDay}T00:00:00Z`);
  let years = l.getUTCFullYear() - h.getUTCFullYear();
  const beforeAnniversary = l.getUTCMonth() < h.getUTCMonth()
    || (l.getUTCMonth() === h.getUTCMonth() && l.getUTCDate() < h.getUTCDate());
  if (beforeAnniversary) years--;
  return years < 5 ? 1 : years < 10 ? 2 : years < 20 ? 3 : 4;
}

/**
 * Apply a termination (called by approveOrder): set terminated_on, then create the
 * final-settlement components so the normal run produces ONE combined item (doc 3.8):
 *  - vacation compensation = remaining day balance x average daily earnings (taxable);
 *  - statutory severance = months-by-tenure x average monthly earnings (IIN/VSAOI-exempt).
 * The last month's wage itself comes from the regular run proration.
 */
export async function applyTermination(
  tx: PoolClient, ctx: TenantContext,
  args: { orderId: string; employeeId: string; lastDay: string; severance: boolean },
): Promise<void> {
  const emp = await getEmployee(tx, ctx, args.employeeId);
  const year = Number(args.lastDay.slice(0, 4));
  const month = Number(args.lastDay.slice(5, 7));

  // Set terminated_on FIRST so the balance stops accruing past the final month.
  await updateEmployee(tx, ctx, args.employeeId, { terminatedOn: args.lastDay });

  const avg = await computeAverageEarnings(tx, ctx, args.employeeId, args.lastDay);

  const balance = await vacationBalanceHundredths(tx, ctx, args.employeeId, year, month);
  if (balance > 0n) {
    await addPayComponent(tx, ctx, {
      employeeId: args.employeeId, year, month, kind: 'other_taxable',
      amount: fromCents(divRound(balance * avg.dailyCents, 100n)),
      sourceOrderId: args.orderId, note: 'Kompensācija par neizmantoto atvaļinājumu (3.8)',
    });
  }

  if (args.severance) {
    const months = severanceMonthsFor(emp.hiredOn, args.lastDay);
    await addPayComponent(tx, ctx, {
      employeeId: args.employeeId, year, month, kind: 'severance_exempt',
      amount: fromCents(BigInt(months) * avg.monthlyCents),
      sourceOrderId: args.orderId, note: `Atlaišanas pabalsts — ${months} mēn. vidējā izpeļņa (3.8)`,
    });
  }
}
```

In `src/payroll/orders.ts`, add the import and replace the `termination` branch:

```typescript
// add to imports:
import { applyTermination } from './termination.js';
```

Replace:

```typescript
    case 'termination':
      // Replaced with the full final-settlement effect in Task 14.
      throw new Error('termination orders are not supported yet (Task 14)');
```

with:

```typescript
    case 'termination':
      await applyTermination(tx, ctx, {
        orderId: id, employeeId: before.employeeIds[0]!, lastDay: before.dateTo!,
        severance: before.payload['severance'] === true,
      });
      break;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/payroll/termination.test.ts tests/payroll/orders.test.ts`
Expected: PASS — new tests green, orders tests unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/payroll/termination.ts src/payroll/orders.ts tests/payroll/termination.test.ts
git commit -m "feat(payroll): termination final settlement — compensation + tenure severance (doc 3.8)"
```

---

### Task 15: Authz operation + API routes

New `payroll.write` operation (firm-side only — payroll is firm-controlled accounting, like periods). Routes follow the exact `parties` pattern: `getSessionToken()` → `resolveTenantContext` → `assertRoleAllowed` (mutations) → domain call inside `withTenant` → `errorToStatus`.

**Files:**
- Modify: `src/authz/policy.ts`
- Create: `web/app/api/payroll/employees/route.ts`
- Create: `web/app/api/payroll/employees/[id]/route.ts`
- Create: `web/app/api/payroll/employees/[id]/tax-status/route.ts`
- Create: `web/app/api/payroll/orders/route.ts`
- Create: `web/app/api/payroll/orders/[id]/approve/route.ts`
- Create: `web/app/api/payroll/runs/route.ts`
- Create: `web/app/api/payroll/runs/[id]/route.ts`
- Create: `web/app/api/payroll/runs/[id]/compute/route.ts`
- Create: `web/app/api/payroll/runs/[id]/approve/route.ts`

- [ ] **Step 1: Add the operation to the policy**

In `src/authz/policy.ts`, extend the union:

```typescript
export type Operation =
  | 'periods.write' // open/close accounting periods
  | 'autonomy.write' // set agent autonomy policy
  | 'einvoice.issue' // issue an outbound invoice
  | 'bank.write' // import statements / build payment orders
  | 'parties.write' // create/update customers & vendors
  | 'payroll.write'; // employees, orders, runs — firm-side only
```

and the matrix:

```typescript
const OPERATION_ROLES: Record<Operation, readonly UserRole[]> = {
  'periods.write': ['firm_admin', 'accountant'],
  'autonomy.write': ['firm_admin', 'accountant'],
  'einvoice.issue': ['firm_admin', 'accountant', 'owner', 'employee'],
  'bank.write': ['firm_admin', 'accountant'],
  'parties.write': ['firm_admin', 'accountant', 'employee'],
  'payroll.write': ['firm_admin', 'accountant'],
};
```

- [ ] **Step 2: Employees routes**

`web/app/api/payroll/employees/route.ts`:

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { listEmployees, createEmployee, type NewEmployee } from '@domain/payroll/employees.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const employees = await withTenant(ctx, (tx) => listEmployees(tx, ctx));
    return NextResponse.json({ employees }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string; employee?: NewEmployee };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.employee) return NextResponse.json({ error: 'missing employee' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'payroll.write');
    const result = await withTenant(ctx, (tx) => createEmployee(tx, ctx, body.employee!));
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
```

`web/app/api/payroll/employees/[id]/route.ts`:

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { updateEmployee } from '@domain/payroll/employees.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    clientCompanyId?: string; wage?: string; position?: string; terminatedOn?: string | null;
  };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  try {
    const tctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(tctx.actorRole, 'payroll.write');
    await withTenant(tctx, (tx) => updateEmployee(tx, tctx, id, {
      ...(body.wage !== undefined && { wage: body.wage }),
      ...(body.position !== undefined && { position: body.position }),
      ...(body.terminatedOn !== undefined && { terminatedOn: body.terminatedOn }),
    }));
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
```

`web/app/api/payroll/employees/[id]/tax-status/route.ts`:

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { setMonthlyTaxStatus } from '@domain/payroll/employees.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    clientCompanyId?: string; year?: number; month?: number;
    taxBookActive?: boolean; dependents?: number; disabilityGroup?: number;
  };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (body.year === undefined || body.month === undefined || body.taxBookActive === undefined) {
    return NextResponse.json({ error: 'missing year/month/taxBookActive' }, { status: 400 });
  }
  try {
    const tctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(tctx.actorRole, 'payroll.write');
    await withTenant(tctx, (tx) => setMonthlyTaxStatus(tx, tctx, id, {
      year: body.year!, month: body.month!, taxBookActive: body.taxBookActive!,
      dependents: body.dependents ?? 0, disabilityGroup: body.disabilityGroup ?? 0,
    }));
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
```

- [ ] **Step 3: Orders routes**

`web/app/api/payroll/orders/route.ts`:

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { listOrders, createOrder, type NewOrder, type OrderType } from '@domain/payroll/orders.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

const ORDER_TYPES: readonly OrderType[] = ['hire', 'termination', 'bonus', 'vacation', 'wage_change'];
const isOrderType = (v: unknown): v is OrderType => ORDER_TYPES.includes(v as OrderType);

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const typeParam = req.nextUrl.searchParams.get('orderType');
  if (typeParam !== null && !isOrderType(typeParam)) {
    return NextResponse.json({ error: 'invalid orderType' }, { status: 400 });
  }
  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const orders = await withTenant(ctx, (tx) => listOrders(tx, ctx, typeParam ? { orderType: typeParam } : {}));
    return NextResponse.json({ orders }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string; order?: NewOrder };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.order) return NextResponse.json({ error: 'missing order' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'payroll.write');
    const result = await withTenant(ctx, (tx) => createOrder(tx, ctx, body.order!));
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
```

`web/app/api/payroll/orders/[id]/approve/route.ts`:

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { approveOrder } from '@domain/payroll/orders.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  try {
    const tctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(tctx.actorRole, 'payroll.write');
    await withTenant(tctx, (tx) => approveOrder(tx, tctx, id));
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
```

- [ ] **Step 4: Runs routes**

`web/app/api/payroll/runs/route.ts`:

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { listRuns, openRun } from '@domain/payroll/run.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const runs = await withTenant(ctx, (tx) => listRuns(tx, ctx));
    return NextResponse.json({ runs }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string; year?: number; month?: number };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (body.year === undefined || body.month === undefined) {
    return NextResponse.json({ error: 'missing year/month' }, { status: 400 });
  }
  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'payroll.write');
    const result = await withTenant(ctx, (tx) => openRun(tx, ctx, { year: body.year!, month: body.month! }));
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
```

`web/app/api/payroll/runs/[id]/route.ts`:

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { getRunWithItems } from '@domain/payroll/run.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { errorToStatus } from '@/app/lib/authz';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const { id } = await ctx.params;
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  try {
    const tctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const run = await withTenant(tctx, (tx) => getRunWithItems(tx, tctx, id));
    return NextResponse.json({ run }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
```

`web/app/api/payroll/runs/[id]/compute/route.ts`:

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { computeRun } from '@domain/payroll/run.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  try {
    const tctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(tctx.actorRole, 'payroll.write');
    await withTenant(tctx, (tx) => computeRun(tx, tctx, id));
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
```

`web/app/api/payroll/runs/[id]/approve/route.ts`:

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { approveRun } from '@domain/payroll/run.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  try {
    const tctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(tctx.actorRole, 'payroll.write');
    await withTenant(tctx, (tx) => approveRun(tx, tctx, id));
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit` (repo root) — expect no errors.
Run: `cd web; npx tsc --noEmit` — expect no errors. (Note web/AGENTS.md: if the route signature differs in this Next version, check `web/node_modules/next/dist/docs/` and match the existing routes — the code above mirrors `web/app/api/parties/[id]/route.ts` exactly.)
Run: `npx vitest run tests/authz/` (root) — existing policy tests must still pass; if a test enumerates all operations, add `payroll.write` there.

- [ ] **Step 6: Commit**

```bash
git add src/authz/policy.ts web/app/api/payroll
git commit -m "feat(payroll): payroll.write authz operation + API routes for employees/orders/runs"
```

---

### Task 16: Full verification + HANDOFF update

- [ ] **Step 1: Run everything**

Run from repo root:

```bash
npm test
npx tsc --noEmit
cd web; npx tsc --noEmit
```

Expected: all tests pass (146 pre-existing + ~45 new payroll tests), both typechecks clean. Fix anything that fails before continuing.

- [ ] **Step 2: Update HANDOFF.md**

In `HANDOFF.md` section 5, replace the payroll bullet:

```markdown
- **Payroll & HR (§6.3)** — salary, VSAOI + IIN (the 15th-of-month filing),
  sick leave, vacation, advances; employee self-service portal.
```

with:

```markdown
- **Payroll & HR (§6.3)** — ✅ phase-1 calculation core shipped (see
  `docs/superpowers/plans/2026-07-09-payroll-phase1-core.md`): employee card,
  monthly tax-status data, orders (rīkojumi), deterministic bruto→neto engine
  (IIN/VSAOI 2026, versioned in `tax_rules`), shared average earnings, A-lapa
  sick pay, vacation accrual + postings, termination settlement, API routes.
  Still open: VID EDS payroll reports (instr. 3.5 — deliberately last), order
  PDF + eParaksts, payroll UI pages, employee self-service portal, MUN-regime
  calc (flag stored), advances, LR public-holiday calendar (shared gap with
  `vid.ts`), EDS tax-book/sick-leave auto-import (manual monthly entry today).
```

- [ ] **Step 3: Commit**

```bash
git add HANDOFF.md
git commit -m "docs: mark payroll phase-1 calculation core shipped in HANDOFF"
```

---

## Execution notes

- Every task's tests hit the real Postgres from `docker-compose.yml` (`resetDb()` wipes and re-migrates) — have it running: `docker compose up -d`.
- Migrations must stay strictly ordered 023–028 as written; `resetDb()` applies them automatically.
- Do not push to the remote — the user must approve any push explicitly.
- The `payroll_items.avg_daily` column (added in Task 10's migration) is load-bearing for Task 13 (accrual at approval) — don't drop it if slimming the schema.
- Follow-up plans after this one: payroll UI pages over these routes, VID EDS payroll report export (instr. 3.5), order PDF + e-signature.





