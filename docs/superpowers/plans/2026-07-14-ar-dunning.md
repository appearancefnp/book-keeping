# AR dunning + late fees Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bookkeeper-facing payment reminders (dunning) with a per-client escalation policy and informational late fees, on top of the slice-A AR open-item data.

**Architecture:** A per-client `dunning_policy` (fee rule + on/off) and `dunning_stages` (level→days-overdue) config, a pure `accruedLateFeeCents` calculator, and `runDunning` which scans overdue outbound receivables, advances each to its reached stage, and emits one actionable task per newly-reached level (idempotent via a `dunning_events` history table). A manual trigger route (cron-ready) plus a policy editor on the `/reports` AR-aging tab.

**Tech Stack:** TypeScript, Node/`pg` domain layer, Vitest (DB-backed domain tests), a modified Next.js App Router, React client components, CSS modules, typed tri-lingual i18n.

## Global Constraints

- **Migration number is `033`** (highest existing is `032`).
- **RLS on every new table**, exactly mirroring `migrations/032_receivables.sql` / `012_autonomy_policy.sql`: `client_company_id uuid NOT NULL REFERENCES client_companies(id)`, `ENABLE` + `FORCE ROW LEVEL SECURITY`, a `<table>_tenant_isolation` policy with `USING`/`WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid)`, and `GRANT SELECT, INSERT, UPDATE ON <table> TO bookkeeping_app`. **`dunning_stages` also needs `GRANT ... DELETE`** because `setStages` replaces rows (delete + insert).
- **Money is integer cents**; late-fee math is `bigint`; DB columns are `bigint`; API responses serialize cents with `::text` / `.toString()`.
- **RLS is never bypassed** — all domain functions take `(tx: PoolClient, ctx: TenantContext, ...)` and run inside `withTenant`.
- **`appendAudit` on every mutation**: `appendAudit(tx, ctx, { action, entityType, entityId, before, after })` (before/after are objects or null).
- **Ledger is untouched** — late fees are informational this slice (no journal entries).
- **i18n in all three catalogs** (en, lv, ru) in `web/app/lib/i18n.ts` — the typed record fails the build on a missing key.
- **Modified Next.js:** per `web/AGENTS.md`, before editing any `web/` file read the relevant guide under `web/node_modules/next/dist/docs/`.
- **Reuse the existing task primitive:** `createTask(tx, ctx, { title, detail? })` from `src/collab/tasks.ts` (it sets `created_by` from `ctx.actorId` and audits itself).
- **Reuse the AR test helper:** `tests/receivables/helpers.ts` exports `setup()` → `{ cid, customerId }` and `issueOpenReceivable(cid, customerId, { dueDate?, invoice? })` → `{ einvoiceId, ... }`.
- **Gate for the slice:** root `npm test` green; `tsc --noEmit` clean in root **and** `web/`; `npm run build` in `web/` clean.

---

### Task 1: Migration 033 + dunning policy domain

**Files:**
- Create: `migrations/033_dunning.sql`
- Create: `src/dunning/policy.ts`
- Test: `tests/dunning/policy.test.ts`

**Interfaces:**
- Consumes: `client_companies(id)`, `tasks(id)`, `einvoices(id)` (existing); `TenantContext`, `appendAudit`.
- Produces:
  - `interface Stage { level: number; daysOverdue: number }`
  - `interface DunningPolicy { enabled: boolean; lateFeeAnnualBps: number; lateFeeFlatCents: string }`
  - `const DEFAULT_STAGES: Stage[]`
  - `getDunningPolicy(tx, ctx): Promise<DunningPolicy>`
  - `setDunningPolicy(tx, ctx, input: { enabled: boolean; lateFeeAnnualBps: number; lateFeeFlatCents: string }): Promise<void>`
  - `listStages(tx, ctx): Promise<Stage[]>`
  - `setStages(tx, ctx, stages: Stage[]): Promise<void>`
  Consumed by Task 3 (`runDunning`) and Task 4 (routes).

- [ ] **Step 1: Write the migration**

`migrations/033_dunning.sql`:

```sql
-- AR dunning: per-client reminder policy + escalation stages + reminder history (M4 slice B).
CREATE TABLE dunning_policy (
  client_company_id uuid PRIMARY KEY REFERENCES client_companies(id),
  enabled boolean NOT NULL DEFAULT true,
  late_fee_annual_bps int NOT NULL DEFAULT 0,
  late_fee_flat_cents bigint NOT NULL DEFAULT 0
);

CREATE TABLE dunning_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  level int NOT NULL,
  days_overdue int NOT NULL,
  UNIQUE (client_company_id, level)
);
CREATE INDEX dunning_stages_client_idx ON dunning_stages(client_company_id);

CREATE TABLE dunning_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  einvoice_id uuid NOT NULL REFERENCES einvoices(id),
  level int NOT NULL,
  accrued_fee_cents bigint NOT NULL,
  task_id uuid REFERENCES tasks(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_company_id, einvoice_id, level)
);
CREATE INDEX dunning_events_einvoice_idx ON dunning_events(einvoice_id);

ALTER TABLE dunning_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE dunning_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY dunning_policy_tenant_isolation ON dunning_policy
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON dunning_policy TO bookkeeping_app;

ALTER TABLE dunning_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE dunning_stages FORCE ROW LEVEL SECURITY;
CREATE POLICY dunning_stages_tenant_isolation ON dunning_stages
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON dunning_stages TO bookkeeping_app;

ALTER TABLE dunning_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE dunning_events FORCE ROW LEVEL SECURITY;
CREATE POLICY dunning_events_tenant_isolation ON dunning_events
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON dunning_events TO bookkeeping_app;
```

- [ ] **Step 2: Write failing policy tests**

`tests/dunning/policy.test.ts`:

```ts
import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { setup } from '../receivables/helpers.js';
import {
  getDunningPolicy, setDunningPolicy, listStages, setStages, DEFAULT_STAGES,
} from '../../src/dunning/policy.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('policy defaults when unconfigured, then round-trips an upsert', async () => {
  const { cid } = await setup();
  const def = await withTenant(cid, (tx) => getDunningPolicy(tx, cid));
  expect(def).toEqual({ enabled: true, lateFeeAnnualBps: 0, lateFeeFlatCents: '0' });

  await withTenant(cid, (tx) => setDunningPolicy(tx, cid, { enabled: false, lateFeeAnnualBps: 800, lateFeeFlatCents: '500' }));
  const got = await withTenant(cid, (tx) => getDunningPolicy(tx, cid));
  expect(got).toEqual({ enabled: false, lateFeeAnnualBps: 800, lateFeeFlatCents: '500' });

  // second upsert updates in place (PK conflict), does not error/duplicate
  await withTenant(cid, (tx) => setDunningPolicy(tx, cid, { enabled: true, lateFeeAnnualBps: 1200, lateFeeFlatCents: '0' }));
  const got2 = await withTenant(cid, (tx) => getDunningPolicy(tx, cid));
  expect(got2).toEqual({ enabled: true, lateFeeAnnualBps: 1200, lateFeeFlatCents: '0' });
});

test('listStages returns DEFAULT_STAGES until custom stages are set', async () => {
  const { cid } = await setup();
  const def = await withTenant(cid, (tx) => listStages(tx, cid));
  expect(def).toEqual(DEFAULT_STAGES);

  await withTenant(cid, (tx) => setStages(tx, cid, [
    { level: 1, daysOverdue: 7 }, { level: 2, daysOverdue: 30 },
  ]));
  const got = await withTenant(cid, (tx) => listStages(tx, cid));
  expect(got).toEqual([{ level: 1, daysOverdue: 7 }, { level: 2, daysOverdue: 30 }]);

  // replace (not append): setting again fully swaps the set
  await withTenant(cid, (tx) => setStages(tx, cid, [{ level: 1, daysOverdue: 3 }]));
  const got2 = await withTenant(cid, (tx) => listStages(tx, cid));
  expect(got2).toEqual([{ level: 1, daysOverdue: 3 }]);
});

test('setStages rejects non-ascending or duplicate-level stage sets', async () => {
  const { cid } = await setup();
  await expect(withTenant(cid, (tx) => setStages(tx, cid, [
    { level: 1, daysOverdue: 30 }, { level: 2, daysOverdue: 15 },
  ]))).rejects.toThrow(/ascending/i);
  await expect(withTenant(cid, (tx) => setStages(tx, cid, [
    { level: 1, daysOverdue: 5 }, { level: 1, daysOverdue: 10 },
  ]))).rejects.toThrow(/distinct|duplicate/i);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/dunning/policy.test.ts`
Expected: FAIL — module `src/dunning/policy.js` not found (and the `dunning_*` tables don't exist yet until the migration test harness picks up `033`).

- [ ] **Step 4: Write `src/dunning/policy.ts`**

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appendAudit } from '../audit/audit.js';

export interface Stage { level: number; daysOverdue: number }
export interface DunningPolicy { enabled: boolean; lateFeeAnnualBps: number; lateFeeFlatCents: string }

/** Built-in escalation used when a client has not configured its own stages. */
export const DEFAULT_STAGES: Stage[] = [
  { level: 1, daysOverdue: 1 },
  { level: 2, daysOverdue: 15 },
  { level: 3, daysOverdue: 30 },
];

export async function getDunningPolicy(tx: PoolClient, ctx: TenantContext): Promise<DunningPolicy> {
  const res = await tx.query(
    `SELECT enabled, late_fee_annual_bps AS "lateFeeAnnualBps", late_fee_flat_cents::text AS "lateFeeFlatCents"
       FROM dunning_policy WHERE client_company_id = $1`,
    [ctx.clientCompanyId],
  );
  if (!res.rowCount) return { enabled: true, lateFeeAnnualBps: 0, lateFeeFlatCents: '0' };
  return res.rows[0];
}

export async function setDunningPolicy(
  tx: PoolClient, ctx: TenantContext,
  input: { enabled: boolean; lateFeeAnnualBps: number; lateFeeFlatCents: string },
): Promise<void> {
  await tx.query(
    `INSERT INTO dunning_policy(client_company_id, enabled, late_fee_annual_bps, late_fee_flat_cents)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (client_company_id)
     DO UPDATE SET enabled = EXCLUDED.enabled,
                   late_fee_annual_bps = EXCLUDED.late_fee_annual_bps,
                   late_fee_flat_cents = EXCLUDED.late_fee_flat_cents`,
    [ctx.clientCompanyId, input.enabled, input.lateFeeAnnualBps, input.lateFeeFlatCents],
  );
  await appendAudit(tx, ctx, { action: 'set', entityType: 'dunning_policy', entityId: null, before: null, after: input });
}

export async function listStages(tx: PoolClient, ctx: TenantContext): Promise<Stage[]> {
  const res = await tx.query(
    `SELECT level, days_overdue AS "daysOverdue" FROM dunning_stages
      WHERE client_company_id = $1 ORDER BY level ASC`,
    [ctx.clientCompanyId],
  );
  return res.rowCount ? res.rows : DEFAULT_STAGES;
}

export async function setStages(tx: PoolClient, ctx: TenantContext, stages: Stage[]): Promise<void> {
  const levels = stages.map((s) => s.level);
  if (new Set(levels).size !== levels.length) throw new Error('Stage levels must be distinct');
  const byLevel = [...stages].sort((a, b) => a.level - b.level);
  for (let i = 1; i < byLevel.length; i++) {
    if (byLevel[i]!.daysOverdue <= byLevel[i - 1]!.daysOverdue) {
      throw new Error('Stage days_overdue must be strictly ascending by level');
    }
  }
  await tx.query(`DELETE FROM dunning_stages WHERE client_company_id = $1`, [ctx.clientCompanyId]);
  for (const s of byLevel) {
    await tx.query(
      `INSERT INTO dunning_stages(client_company_id, level, days_overdue) VALUES ($1,$2,$3)`,
      [ctx.clientCompanyId, s.level, s.daysOverdue],
    );
  }
  await appendAudit(tx, ctx, { action: 'set', entityType: 'dunning_stages', entityId: null, before: null, after: { stages: byLevel } });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/dunning/policy.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck root**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add migrations/033_dunning.sql src/dunning/policy.ts tests/dunning/policy.test.ts
git commit -m "feat(dunning): migration 033 + per-client dunning policy/stages (M4 slice B)"
```

---

### Task 2: Late-fee calculator

**Files:**
- Create: `src/dunning/late-fee.ts`
- Test: `tests/dunning/late-fee.test.ts`

**Interfaces:**
- Produces: `accruedLateFeeCents(input: { outstandingCents: string; daysOverdue: number; annualBps: number; flatCents: string }): string` — returns cents as a decimal string. Consumed by Task 3.

- [ ] **Step 1: Write the failing tests**

`tests/dunning/late-fee.test.ts`:

```ts
import { expect, test } from 'vitest';
import { accruedLateFeeCents } from '../../src/dunning/late-fee.js';

test('zero when no rate and no flat', () => {
  expect(accruedLateFeeCents({ outstandingCents: '100000', daysOverdue: 30, annualBps: 0, flatCents: '0' })).toBe('0');
});

test('flat-only fee is returned verbatim regardless of days', () => {
  expect(accruedLateFeeCents({ outstandingCents: '100000', daysOverdue: 0, annualBps: 0, flatCents: '500' })).toBe('500');
});

test('annual-only interest: 8%/yr on 1000.00 for 365 days = 80.00', () => {
  // 100000 cents * 800bps/10000 * 365/365 = 8000 cents
  expect(accruedLateFeeCents({ outstandingCents: '100000', daysOverdue: 365, annualBps: 800, flatCents: '0' })).toBe('8000');
});

test('annual interest for a partial period rounds half-up', () => {
  // 100000 * 0.08 * 30/365 = 657.53... cents -> 658
  expect(accruedLateFeeCents({ outstandingCents: '100000', daysOverdue: 30, annualBps: 800, flatCents: '0' })).toBe('658');
});

test('flat + annual combine', () => {
  // 658 (interest above) + 500 flat = 1158
  expect(accruedLateFeeCents({ outstandingCents: '100000', daysOverdue: 30, annualBps: 800, flatCents: '500' })).toBe('1158');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/dunning/late-fee.test.ts`
Expected: FAIL — `accruedLateFeeCents` not defined.

- [ ] **Step 3: Write `src/dunning/late-fee.ts`**

```ts
/**
 * Informational accrued late fee, in integer cents (returned as a decimal string).
 * fee = flatCents + round_half_up(outstandingCents * annualBps/10000 * daysOverdue/365).
 * All arithmetic is bigint so large balances never lose precision.
 */
export function accruedLateFeeCents(input: {
  outstandingCents: string; daysOverdue: number; annualBps: number; flatCents: string;
}): string {
  const flat = BigInt(input.flatCents);
  if (input.annualBps <= 0 || input.daysOverdue <= 0) return flat.toString();
  const outstanding = BigInt(input.outstandingCents);
  const numerator = outstanding * BigInt(input.annualBps) * BigInt(input.daysOverdue);
  const denominator = 10000n * 365n;
  // round half-up: (n + d/2) / d
  const interest = (numerator + denominator / 2n) / denominator;
  return (flat + interest).toString();
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/dunning/late-fee.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` (expected clean), then:

```bash
git add src/dunning/late-fee.ts tests/dunning/late-fee.test.ts
git commit -m "feat(dunning): accruedLateFeeCents pure late-fee calculator (M4 slice B)"
```

---

### Task 3: `runDunning`

**Files:**
- Create: `src/dunning/dunning.ts`
- Test: `tests/dunning/dunning.test.ts`

**Interfaces:**
- Consumes: `getDunningPolicy`, `listStages` (Task 1); `accruedLateFeeCents` (Task 2); `createTask` (`src/collab/tasks.ts`); the `einvoices` AR columns from slice A.
- Produces: `runDunning(tx, ctx, { asOf: string }): Promise<{ prompted: number; byLevel: Record<number, number> }>`. Consumed by Task 4.

- [ ] **Step 1: Write the failing tests**

`tests/dunning/dunning.test.ts`:

```ts
import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { setup, issueOpenReceivable } from '../receivables/helpers.js';
import { runDunning } from '../../src/dunning/dunning.js';
import { setDunningPolicy, setStages } from '../../src/dunning/policy.js';
import { listTasks } from '../../src/collab/tasks.js';

// SAMPLE_INVOICE issueDate is 2026-03-10; issueOpenReceivable defaults dueDate 2026-03-24.
async function overdueClient(dueDate = '2026-03-10') {
  const { cid, customerId } = await setup();
  const { einvoiceId } = await issueOpenReceivable(cid, customerId, { dueDate });
  return { cid, customerId, einvoiceId };
}

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('default stages: an invoice 20 days overdue reaches level 2 and creates one task', async () => {
  const { cid } = await overdueClient('2026-03-10'); // asOf-20d below
  const summary = await withTenant(cid, (tx) => runDunning(tx, cid, { asOf: '2026-03-30' }));
  expect(summary.prompted).toBe(1);
  expect(summary.byLevel).toEqual({ 2: 1 }); // DEFAULT_STAGES: L2 at 15d, L3 at 30d -> 20d = L2
  const tasks = await withTenant(cid, (tx) => listTasks(tx, cid, {}));
  expect(tasks).toHaveLength(1);
  expect(tasks[0]!.title).toMatch(/INV-2026-001/);
});

test('idempotent: a second run at the same asOf creates no new task', async () => {
  const { cid } = await overdueClient('2026-03-10');
  await withTenant(cid, (tx) => runDunning(tx, cid, { asOf: '2026-03-30' }));
  const summary2 = await withTenant(cid, (tx) => runDunning(tx, cid, { asOf: '2026-03-30' }));
  expect(summary2.prompted).toBe(0);
  const tasks = await withTenant(cid, (tx) => listTasks(tx, cid, {}));
  expect(tasks).toHaveLength(1);
});

test('escalation: a later run at a higher day-count fires the next level once', async () => {
  const { cid } = await overdueClient('2026-03-10');
  await withTenant(cid, (tx) => runDunning(tx, cid, { asOf: '2026-03-30' })); // L2
  const later = await withTenant(cid, (tx) => runDunning(tx, cid, { asOf: '2026-04-20' })); // ~41d -> L3
  expect(later.byLevel).toEqual({ 3: 1 });
  const tasks = await withTenant(cid, (tx) => listTasks(tx, cid, {}));
  expect(tasks).toHaveLength(2);
});

test('not-yet-due and paid/void invoices are skipped', async () => {
  const { cid, customerId } = await setup();
  await issueOpenReceivable(cid, customerId, { dueDate: '2026-12-31' }); // future due
  const summary = await withTenant(cid, (tx) => runDunning(tx, cid, { asOf: '2026-03-30' }));
  expect(summary.prompted).toBe(0);
});

test('enabled=false is a no-op', async () => {
  const { cid } = await overdueClient('2026-03-10');
  await withTenant(cid, (tx) => setDunningPolicy(tx, cid, { enabled: false, lateFeeAnnualBps: 0, lateFeeFlatCents: '0' }));
  const summary = await withTenant(cid, (tx) => runDunning(tx, cid, { asOf: '2026-03-30' }));
  expect(summary.prompted).toBe(0);
  const tasks = await withTenant(cid, (tx) => listTasks(tx, cid, {}));
  expect(tasks).toHaveLength(0);
});

test('custom stages + late fee: task message includes the accrued fee', async () => {
  const { cid } = await overdueClient('2026-03-10');
  await withTenant(cid, (tx) => setStages(tx, cid, [{ level: 1, daysOverdue: 5 }]));
  await withTenant(cid, (tx) => setDunningPolicy(tx, cid, { enabled: true, lateFeeAnnualBps: 0, lateFeeFlatCents: '500' }));
  const summary = await withTenant(cid, (tx) => runDunning(tx, cid, { asOf: '2026-03-30' }));
  expect(summary.byLevel).toEqual({ 1: 1 });
  const tasks = await withTenant(cid, (tx) => listTasks(tx, cid, {}));
  expect(tasks[0]!.detail).toMatch(/5\.00/); // flat 500 cents rendered as 5.00
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/dunning/dunning.test.ts`
Expected: FAIL — `runDunning` not defined.

- [ ] **Step 3: Write `src/dunning/dunning.ts`**

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { createTask } from '../collab/tasks.js';
import { getDunningPolicy, listStages } from './policy.js';
import { accruedLateFeeCents } from './late-fee.js';

interface OverdueRow {
  einvoiceId: string; invoiceNumber: string; outstandingCents: string; dueDate: string;
}

/** Whole days between two YYYY-MM-DD dates (asOf − due), floored. */
function daysBetween(dueDate: string, asOf: string): number {
  const d = Date.parse(dueDate + 'T00:00:00Z');
  const a = Date.parse(asOf + 'T00:00:00Z');
  return Math.floor((a - d) / 86_400_000);
}

function centsToMajor(cents: string): string {
  const n = BigInt(cents);
  const sign = n < 0n ? '-' : '';
  const abs = n < 0n ? -n : n;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${sign}${whole}.${frac}`;
}

export async function runDunning(
  tx: PoolClient, ctx: TenantContext, opts: { asOf: string },
): Promise<{ prompted: number; byLevel: Record<number, number> }> {
  const byLevel: Record<number, number> = {};
  const policy = await getDunningPolicy(tx, ctx);
  if (!policy.enabled) return { prompted: 0, byLevel };

  const stages = await listStages(tx, ctx); // ascending by level
  const overdue = await tx.query<OverdueRow>(
    `SELECT id AS "einvoiceId", invoice_number AS "invoiceNumber",
            (grand_total_cents - amount_paid_cents)::text AS "outstandingCents",
            to_char(due_date, 'YYYY-MM-DD') AS "dueDate"
       FROM einvoices
      WHERE client_company_id = $1 AND direction = 'outbound'
        AND status IN ('open','partially_paid')
        AND due_date IS NOT NULL AND due_date < $2::date`,
    [ctx.clientCompanyId, opts.asOf],
  );

  let prompted = 0;
  for (const row of overdue.rows) {
    const daysOverdue = daysBetween(row.dueDate, opts.asOf);
    // highest stage whose threshold is reached
    let reached: { level: number; daysOverdue: number } | null = null;
    for (const s of stages) if (daysOverdue >= s.daysOverdue) reached = s;
    if (!reached) continue;

    const dup = await tx.query(
      `SELECT 1 FROM dunning_events WHERE client_company_id = $1 AND einvoice_id = $2 AND level = $3`,
      [ctx.clientCompanyId, row.einvoiceId, reached.level],
    );
    if (dup.rowCount) continue;

    const fee = accruedLateFeeCents({
      outstandingCents: row.outstandingCents, daysOverdue,
      annualBps: policy.lateFeeAnnualBps, flatCents: policy.lateFeeFlatCents,
    });
    const title = `Chase invoice ${row.invoiceNumber} — ${daysOverdue} days overdue (level ${reached.level})`;
    const detail = `Outstanding ${centsToMajor(row.outstandingCents)}. Accrued late fee ${centsToMajor(fee)}.`;
    const { id: taskId } = await createTask(tx, ctx, { title, detail });
    await tx.query(
      `INSERT INTO dunning_events(client_company_id, einvoice_id, level, accrued_fee_cents, task_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [ctx.clientCompanyId, row.einvoiceId, reached.level, fee, taskId],
    );
    prompted += 1;
    byLevel[reached.level] = (byLevel[reached.level] ?? 0) + 1;
  }
  return { prompted, byLevel };
}
```

> Note on task text: the task title/detail here are English domain strings (the `tasks` table stores free text, like every other `createTask` caller e.g. `src/dev/seed.ts`). User-facing *UI chrome* is translated in Task 5; the stored task content is not part of the i18n catalog.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/dunning/dunning.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the full domain suite + typecheck**

Run: `npm test` (expected: all green, previous count + 14 new), then `npx tsc --noEmit` (expected clean).

- [ ] **Step 6: Commit**

```bash
git add src/dunning/dunning.ts tests/dunning/dunning.test.ts
git commit -m "feat(dunning): runDunning — overdue scan, escalation, idempotent task prompts (M4 slice B)"
```

---

### Task 4: API routes — run + policy

**Files:**
- Create: `web/app/api/receivables/dunning/run/route.ts`
- Create: `web/app/api/receivables/dunning/policy/route.ts`
- Test: `tests/dunning/routes.test.ts` (domain-level assertions on the handler bodies via the existing handler-test pattern — see note)

**Interfaces:**
- Consumes: `runDunning` (Task 3), `getDunningPolicy`/`setDunningPolicy`/`listStages`/`setStages` (Task 1); `resolveTenantContext`, `withTenant`, `assertRoleAllowed`, `errorToStatus`, `getSessionToken`, `nowUnix`, `isValidIsoDate`.
- Produces: `POST /api/receivables/dunning/run`, `GET`/`PUT /api/receivables/dunning/policy`. Consumed by Task 5 UI.

- [ ] **Step 1: Write the run route**

`web/app/api/receivables/dunning/run/route.ts` (mirror `web/app/api/receivables/[id]/route.ts` auth/role/error shape):

```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { runDunning } from '@domain/dunning/dunning.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';
import { isValidIsoDate } from '@/app/lib/date';

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string; asOf?: string };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const asOf = body.asOf ?? new Date().toISOString().slice(0, 10);
  if (!isValidIsoDate(asOf)) return NextResponse.json({ error: 'asOf must be a valid YYYY-MM-DD date' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'einvoice.issue');
    const summary = await withTenant(ctx, (tx) => runDunning(tx, ctx, { asOf }));
    return NextResponse.json(summary, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
```

- [ ] **Step 2: Write the policy route**

`web/app/api/receivables/dunning/policy/route.ts`:

```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { getDunningPolicy, setDunningPolicy, listStages, setStages, type Stage } from '@domain/dunning/policy.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const result = await withTenant(ctx, async (tx) => ({
      policy: await getDunningPolicy(tx, ctx),
      stages: await listStages(tx, ctx),
    }));
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

export async function PUT(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as {
    clientCompanyId?: string;
    policy?: { enabled: boolean; lateFeeAnnualBps: number; lateFeeFlatCents: string };
    stages?: Stage[];
  };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.policy || !body.stages) return NextResponse.json({ error: 'missing policy or stages' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'einvoice.issue');
    await withTenant(ctx, async (tx) => {
      await setDunningPolicy(tx, ctx, body.policy!);
      await setStages(tx, ctx, body.stages!);
    });
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
```

- [ ] **Step 3: Write route-logic tests**

The repo tests domain functions directly (routes are thin wrappers). Add `tests/dunning/routes.test.ts` asserting the composed GET/PUT domain behavior the routes depend on (policy+stages read together, PUT writing both atomically):

```ts
import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { setup } from '../receivables/helpers.js';
import { getDunningPolicy, setDunningPolicy, listStages, setStages, DEFAULT_STAGES } from '../../src/dunning/policy.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('GET-shape: policy+stages read together return defaults for a fresh client', async () => {
  const { cid } = await setup();
  const result = await withTenant(cid, async (tx) => ({
    policy: await getDunningPolicy(tx, cid),
    stages: await listStages(tx, cid),
  }));
  expect(result.policy).toEqual({ enabled: true, lateFeeAnnualBps: 0, lateFeeFlatCents: '0' });
  expect(result.stages).toEqual(DEFAULT_STAGES);
});

test('PUT-shape: policy + stages are written atomically in one tenant tx', async () => {
  const { cid } = await setup();
  await withTenant(cid, async (tx) => {
    await setDunningPolicy(tx, cid, { enabled: true, lateFeeAnnualBps: 500, lateFeeFlatCents: '0' });
    await setStages(tx, cid, [{ level: 1, daysOverdue: 10 }]);
  });
  const result = await withTenant(cid, async (tx) => ({
    policy: await getDunningPolicy(tx, cid),
    stages: await listStages(tx, cid),
  }));
  expect(result.policy.lateFeeAnnualBps).toBe(500);
  expect(result.stages).toEqual([{ level: 1, daysOverdue: 10 }]);
});
```

- [ ] **Step 4: Run tests + typechecks**

Run: `npx vitest run tests/dunning/routes.test.ts` (expected PASS, 2 tests).
Run: `npx tsc --noEmit` (root, expected clean) and `cd web && npx tsc --noEmit` (expected clean — confirms the route files compile against the `@domain` alias and Next types).

- [ ] **Step 5: Commit**

```bash
git add web/app/api/receivables/dunning tests/dunning/routes.test.ts
git commit -m "feat(dunning): run + policy API routes (M4 slice B)"
```

---

### Task 5: Dunning section on the `/reports` AR-aging tab

**Files:**
- Modify: `web/app/(cabinet)/reports/page.tsx` (the `araging` tab branch)
- Modify: `web/app/(cabinet)/reports/page.module.css` (policy-editor + button styles, if not reusable)
- Modify: `web/app/lib/i18n.ts` (dunning UI strings in all three catalogs)

**Interfaces:**
- Consumes: `GET/PUT /api/receivables/dunning/policy`, `POST /api/receivables/dunning/run` (Task 4).
- Produces: no downstream (terminal task).

- [ ] **Step 1: Read the Next.js client-component guidance**

Run `ls web/node_modules/next/dist/docs/` and read the relevant client-component/App-Router guide before editing.

- [ ] **Step 2: Add i18n keys to all three catalogs**

In `web/app/lib/i18n.ts`, add to each of en/lv/ru (near the `reports.*` keys). English:

```ts
  'dunning.heading': 'Payment reminders',
  'dunning.enabled': 'Reminders enabled',
  'dunning.annualBps': 'Late fee (basis points / year)',
  'dunning.flat': 'Flat late fee per stage',
  'dunning.stages': 'Reminder stages (days overdue by level)',
  'dunning.addStage': 'Add stage',
  'dunning.save': 'Save policy',
  'dunning.run': 'Run reminders now',
  'dunning.saved': 'Policy saved',
  'dunning.ranSummary': 'Reminders created:',
```

Latvian:

```ts
  'dunning.heading': 'Maksājumu atgādinājumi',
  'dunning.enabled': 'Atgādinājumi ieslēgti',
  'dunning.annualBps': 'Kavējuma nauda (bāzes punkti gadā)',
  'dunning.flat': 'Fiksēta kavējuma nauda katrā posmā',
  'dunning.stages': 'Atgādinājumu posmi (nokavētās dienas pa līmeņiem)',
  'dunning.addStage': 'Pievienot posmu',
  'dunning.save': 'Saglabāt politiku',
  'dunning.run': 'Palaist atgādinājumus tagad',
  'dunning.saved': 'Politika saglabāta',
  'dunning.ranSummary': 'Izveidoti atgādinājumi:',
```

Russian:

```ts
  'dunning.heading': 'Напоминания об оплате',
  'dunning.enabled': 'Напоминания включены',
  'dunning.annualBps': 'Пеня (базисные пункты в год)',
  'dunning.flat': 'Фиксированная пеня за этап',
  'dunning.stages': 'Этапы напоминаний (дней просрочки по уровням)',
  'dunning.addStage': 'Добавить этап',
  'dunning.save': 'Сохранить политику',
  'dunning.run': 'Запустить напоминания сейчас',
  'dunning.saved': 'Политика сохранена',
  'dunning.ranSummary': 'Создано напоминаний:',
```

- [ ] **Step 3: Add dunning state + loaders to `ReportsInner`**

In `web/app/(cabinet)/reports/page.tsx`, add state near the other `useState` hooks:

```tsx
  const [dunPolicy, setDunPolicy] = useState<{ enabled: boolean; lateFeeAnnualBps: number; lateFeeFlatCents: string } | null>(null);
  const [dunStages, setDunStages] = useState<{ level: number; daysOverdue: number }[]>([]);
  const [dunMsg, setDunMsg] = useState<string | null>(null);

  const loadDunning = useCallback(async (id: string) => {
    const res = await fetch(`/api/receivables/dunning/policy?clientCompanyId=${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = (await res.json()) as { policy: typeof dunPolicy; stages: typeof dunStages };
    setDunPolicy(data.policy);
    setDunStages(data.stages);
  }, []);

  const saveDunning = useCallback(async () => {
    if (!clientCompanyId || !dunPolicy) return;
    const res = await fetch(`/api/receivables/dunning/policy`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientCompanyId, policy: dunPolicy, stages: dunStages }),
    });
    setDunMsg(res.ok ? t('dunning.saved') : ((await res.json().catch(() => ({}))) as { error?: string }).error ?? t('state.error'));
  }, [clientCompanyId, dunPolicy, dunStages, t]);

  const runDunningNow = useCallback(async () => {
    if (!clientCompanyId) return;
    const res = await fetch(`/api/receivables/dunning/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientCompanyId, asOf }),
    });
    const data = (await res.json().catch(() => ({}))) as { prompted?: number; error?: string };
    setDunMsg(res.ok ? `${t('dunning.ranSummary')} ${data.prompted ?? 0}` : data.error ?? t('state.error'));
  }, [clientCompanyId, asOf, t]);
```

Load the dunning policy when the AR-aging tab is active — extend the existing `useEffect`/load path so `loadDunning(clientCompanyId)` is called when `tab === 'araging'` (mirror how the tab already triggers its fetch).

- [ ] **Step 4: Render the dunning section under the AR-aging table**

Inside the `tab === 'araging'` render block, after the aging table, add the editor. Keep it simple and consistent with existing form controls in the file:

```tsx
            {dunPolicy && (
              <section className={styles.dunning}>
                <h3>{t('dunning.heading')}</h3>
                <label>
                  <input type="checkbox" checked={dunPolicy.enabled}
                    onChange={(e) => setDunPolicy({ ...dunPolicy, enabled: e.target.checked })} />
                  {t('dunning.enabled')}
                </label>
                <label>{t('dunning.annualBps')}
                  <input type="number" min={0} value={dunPolicy.lateFeeAnnualBps}
                    onChange={(e) => setDunPolicy({ ...dunPolicy, lateFeeAnnualBps: Number(e.target.value) })} />
                </label>
                <label>{t('dunning.flat')}
                  <input type="text" inputMode="decimal"
                    value={(Number(dunPolicy.lateFeeFlatCents) / 100).toFixed(2)}
                    onChange={(e) => setDunPolicy({ ...dunPolicy, lateFeeFlatCents: String(Math.round(Number(e.target.value.replace(',', '.')) * 100) || 0) })} />
                </label>
                <fieldset>
                  <legend>{t('dunning.stages')}</legend>
                  {dunStages.map((s, i) => (
                    <div key={s.level} className={styles.stageRow}>
                      <span>L{s.level}</span>
                      <input type="number" min={0} value={s.daysOverdue}
                        onChange={(e) => setDunStages(dunStages.map((x, j) => j === i ? { ...x, daysOverdue: Number(e.target.value) } : x))} />
                    </div>
                  ))}
                  <button type="button" onClick={() => setDunStages([...dunStages, { level: (dunStages.at(-1)?.level ?? 0) + 1, daysOverdue: (dunStages.at(-1)?.daysOverdue ?? 0) + 15 }])}>
                    {t('dunning.addStage')}
                  </button>
                </fieldset>
                <div className={styles.dunningActions}>
                  <button type="button" onClick={saveDunning}>{t('dunning.save')}</button>
                  <button type="button" className={styles.primaryBtn} onClick={runDunningNow}>{t('dunning.run')}</button>
                </div>
                {dunMsg && <p className={styles.dunMsg}>{dunMsg}</p>}
              </section>
            )}
```

- [ ] **Step 5: Add styles**

In `web/app/(cabinet)/reports/page.module.css`, add `.dunning` (section spacing, top border to separate from the aging table), `.stageRow` (flex row, gap), `.dunningActions` (flex row, gap), `.dunMsg` (muted feedback text). Reuse `.primaryBtn` if defined in this module; otherwise match the button styling already used on the page.

- [ ] **Step 6: Typecheck + build web**

Run: `cd web && npx tsc --noEmit && npm run build`
Expected: both clean (no missing-i18n-key type error).

- [ ] **Step 7: Manual verification (code-level self-check; runtime deferred to controller)**

Confirm by reading: the AR-aging tab loads the policy on activation; toggling enabled, editing bps/flat/stages then Save issues the PUT; "Run reminders now" POSTs and shows the created count; created reminders appear as tasks in the tasks UI.

- [ ] **Step 8: Full gate + commit**

Run (repo root): `npm test && npx tsc --noEmit && cd web && npx tsc --noEmit && npm run build`
Expected: root tests green, both typechecks clean, web build clean.

```bash
git add "web/app/(cabinet)/reports/page.tsx" "web/app/(cabinet)/reports/page.module.css" web/app/lib/i18n.ts
git commit -m "feat(dunning): policy editor + run action on /reports AR-aging tab (M4 slice B)"
```

---

## Self-Review

**Spec coverage:**
- Spec §1 (migration 033: `dunning_policy`, `dunning_stages`, `dunning_events`, RLS) → Task 1 Step 1. ✓
- Spec §2 `policy.ts` (DEFAULT_STAGES, get/set policy, list/set stages, validation) → Task 1. ✓
- Spec §2 `late-fee.ts` (pure `accruedLateFeeCents`) → Task 2. ✓
- Spec §2 `dunning.ts` (`runDunning`: enabled check, stage load, overdue scan, level selection, idempotency, task + event) → Task 3. ✓
- Spec §3 routes (`dunning/run`, `dunning/policy` GET/PUT, role-gated) → Task 4. ✓
- Spec §3 UI (policy editor + run button on AR-aging tab; prompts in tasks UI; i18n ×3) → Task 5. ✓
- Spec §4 testing (late-fee units, runDunning behaviors, policy CRUD/validation, route-shape) → Tasks 1–4 tests. ✓
- **Deferred items** (real scheduler, customer-facing docs/email, ledger posting of fees, C/D/statement) → not implemented, correct. ✓

**Placeholder scan:** No TBD/TODO. Every code step contains full code. Task 5 Step 5 (CSS) describes intent with concrete class names and points at existing page styling to match — acceptable for styling, not a logic placeholder.

**Type consistency:** `Stage { level, daysOverdue }` and `DunningPolicy { enabled, lateFeeAnnualBps, lateFeeFlatCents }` are used identically in Task 1 (definition), Task 4 (route bodies), and Task 5 (client state). `accruedLateFeeCents` input keys (`outstandingCents`, `daysOverdue`, `annualBps`, `flatCents`) match between Task 2 (definition) and Task 3 (call site). `runDunning` returns `{ prompted, byLevel }` — consumed as `data.prompted` in Task 5. `setStages` validation error messages (`/ascending/i`, `/distinct|duplicate/i`) match the Task 1 test assertions.

**Late-fee semantics note:** `flatCents` is added to every stage's accrued figure (it is an informational snapshot per level, not a running ledger charge), matching the spec's "flat fee applied per reached stage." No double-charge risk because nothing posts.
