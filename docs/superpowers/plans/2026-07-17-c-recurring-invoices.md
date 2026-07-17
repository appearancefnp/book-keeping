# C-recurring: Recurring / Subscription Invoices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A recurring-invoice template, generated on schedule by the durable job queue, that reuses `sendInvoice` so generated invoices are born as `open` receivables and flow into AR aging + dunning automatically — gated by the existing autonomy/proposals trust model and made self-healing by the chain reaper.

**Architecture:** A new `recurring_invoice_templates` table (full RLS) holds an invoice payload + an anchor-day/interval-months cadence + end conditions. A `recurring_generate` job handler (mirroring `dunning_run`) bills the latest scheduled occurrence on/before today (skip-to-current), gates issue via `resolveAutonomy('recurring_invoice')` (auto → `sendInvoice`; approval → a `pending_approval` proposal), advances `next_run_date`, and self-perpetuates only while active. A `reapRecurring` reaper (parallel to `reapDunning`) guarantees every active due template has a live job.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), node-postgres (`pg`), Vitest, raw SQL migrations run as admin.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-17-c-recurring-invoices-design.md`.
- Branch: `m4b-dunning` (do NOT branch; commit directly here).
- Migrations run as admin, one file per transaction. Next free migration number is **037**.
- RLS via role policies, never bypassed; the supervisor `USING(true)` read policy is a documented control-plane carve-out (like `dunning_policy_supervisor_read` in `036_supervisor_role.sql`).
- At-least-once queue → handlers and reapers MUST be idempotent. Recurring idempotency is achieved by advancing `next_run_date` inside the same transaction as the send (a redelivered job then finds nothing due). This inherits `sendInvoice`'s documented non-transactional-`ap.send` limitation; no separate change.
- Integer cents; import specifiers end in `.js`; tests are Vitest and run serially (`singleFork`).
- All dates are UTC `YYYY-MM-DD` strings; `DATE` columns are always selected `::text` to avoid node-postgres timezone coercion.
- Verify each task with `npm run typecheck` and the task's tests; the full suite (`npm test`) must stay green.
- **Scope:** domain + reaper + tested API routes only. The management **UI screen is deferred** to the impeccable-init UI track (matches the dunning slice, which shipped API-only). Do NOT build a page in `web/app/(cabinet)/`.

---

### Task 1: Migration 037 — templates table, supervisor access, `recurring_invoice` proposal type

**Files:**
- Create: `migrations/037_recurring_invoices.sql`
- Modify: `src/proposals/proposals.ts` (add `'recurring_invoice'` to `ProposalType` + the zod enum)
- Test: `tests/recurring/rls.test.ts`

**Interfaces:**
- Produces: table `recurring_invoice_templates`; supervisor `SELECT` + read policy on it; `proposals.type` now accepts `'recurring_invoice'`.
- Consumes: `makeFirmAndClient`, `ctx`, `resetDb`, `closeDb` from `tests/helpers/db.js`; `withTenant`, `withSupervisor` from `src/db/pool.js`; `createParty` from `src/parties/parties.js`; `createProposal`, `listProposals` from `src/proposals/proposals.js`.

- [ ] **Step 1: Write the migration**

Create `migrations/037_recurring_invoices.sql`:

```sql
-- Recurring / subscription invoices (M4 slice C-recurring). A template holds the invoice payload
-- plus an anchor-day/interval-months cadence and end conditions; the recurring_generate job bills
-- the latest occurrence on/before today and self-perpetuates while active.

CREATE TABLE recurring_invoice_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  customer_party_id uuid NOT NULL REFERENCES parties(id),
  recipient_peppol_id text NOT NULL,          -- parties store no Peppol endpoint; sendInvoice needs it
  invoice_payload jsonb NOT NULL,             -- EInvoice minus invoiceNumber/issueDate/dueDate
  anchor_day int NOT NULL CHECK (anchor_day BETWEEN 1 AND 31),
  interval_months int NOT NULL CHECK (interval_months > 0),
  next_run_date date NOT NULL,
  payment_terms_days int,                     -- null → fall back to the customer party's terms
  end_date date,
  occurrences_remaining int,                  -- null → unlimited
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recurring_templates_due_idx
  ON recurring_invoice_templates(client_company_id, active, next_run_date);

ALTER TABLE recurring_invoice_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_invoice_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY recurring_templates_tenant_isolation ON recurring_invoice_templates
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON recurring_invoice_templates TO bookkeeping_app;

-- Control-plane read for the chain reaper (mirrors dunning_policy_supervisor_read). Permissive
-- policies are OR-combined, so this re-opens cross-tenant read for the supervisor role only.
GRANT SELECT ON recurring_invoice_templates TO bookkeeping_supervisor;
CREATE POLICY recurring_templates_supervisor_read ON recurring_invoice_templates
  TO bookkeeping_supervisor USING (true);

-- Extend the proposals type CHECK so an approval-gated recurring invoice can be held for review.
ALTER TABLE proposals DROP CONSTRAINT proposals_type_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_type_check
  CHECK (type IN ('posting','bank_match','declaration','task','recurring_invoice'));
```

- [ ] **Step 2: Extend `ProposalType` + zod enum in `src/proposals/proposals.ts`**

Change the `ProposalType` union and the `newProposalSchema` enum (both currently `posting`/`bank_match`/`declaration`/`task`) to add `recurring_invoice`:

```typescript
export type ProposalType = 'posting' | 'bank_match' | 'declaration' | 'task' | 'recurring_invoice';
```

```typescript
  type: z.enum(['posting', 'bank_match', 'declaration', 'task', 'recurring_invoice']),
```

- [ ] **Step 3: Write the failing RLS test**

Create `tests/recurring/rls.test.ts`:

```typescript
import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant, withSupervisor } from '../../src/db/pool.js';
import { createParty } from '../../src/parties/parties.js';
import { createProposal, listProposals } from '../../src/proposals/proposals.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function seedTemplate(t: ReturnType<typeof ctx>) {
  await withTenant(t, async (tx) => {
    const { id: partyId } = await createParty(tx, t, { kind: 'customer', name: 'SIA Klients' });
    await tx.query(
      `INSERT INTO recurring_invoice_templates
         (client_company_id, customer_party_id, recipient_peppol_id, invoice_payload,
          anchor_day, interval_months, next_run_date)
       VALUES ($1,$2,'0088:x','{}'::jsonb,1,1,'2026-06-01')`,
      [t.clientCompanyId, partyId],
    );
  });
}

test('supervisor reads recurring templates across tenants; app sees only its own', async () => {
  const a = ctx(await makeFirmAndClient('SIA A'));
  const b = ctx(await makeFirmAndClient('SIA B'));
  await seedTemplate(a);
  await seedTemplate(b);

  const own = await withTenant(a, (tx) => tx.query(`SELECT id FROM recurring_invoice_templates`));
  expect(own.rowCount).toBe(1); // tenant isolation

  const all = await withSupervisor((tx) => tx.query(`SELECT client_company_id FROM recurring_invoice_templates`));
  expect(all.rowCount).toBe(2); // control-plane cross-tenant read
});

test('proposals accept the recurring_invoice type', async () => {
  const t = ctx(await makeFirmAndClient());
  await withTenant(t, (tx) => createProposal(tx, t, {
    type: 'recurring_invoice', payload: { hello: 'world' }, rationale: {}, status: 'pending_approval',
  }));
  const held = await withTenant(t, (tx) => listProposals(tx, t, { status: 'pending_approval' }));
  expect(held.map((p) => p.type)).toEqual(['recurring_invoice']);
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test -- tests/recurring/rls.test.ts`
Expected: FAIL — `recurring_invoice_templates` does not exist (migration not applied) / `recurring_invoice` rejected by the old CHECK. (Migrations are applied by `resetDb`; the new file must exist for the table to appear.)

- [ ] **Step 5: Run the test to verify it passes**

After Steps 1–2, run: `npm test -- tests/recurring/rls.test.ts`
Expected: PASS (2 tests). Then `npm run typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add migrations/037_recurring_invoices.sql src/proposals/proposals.ts tests/recurring/rls.test.ts
git commit -m "feat(recurring): migration 037 templates table, supervisor read, recurring_invoice proposal type

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Cadence schedule helpers — `src/recurring/schedule.ts`

**Files:**
- Create: `src/recurring/schedule.ts`
- Test: `tests/recurring/schedule.test.ts`

**Interfaces:**
- Produces:
  - `clampToMonth(year: number, month: number, anchorDay: number): string` — `month` is 1–12; returns `YYYY-MM-DD` with the day clamped to the month's last day.
  - `advanceRunDate(isoDate: string, intervalMonths: number, anchorDay: number): string` — next occurrence (UTC), day taken from `anchorDay`.
  - `periodKey(isoDate: string): string` — `YYYY-MM`.
  - `buildRecurringInvoiceNumber(prefix: string | null, isoDate: string, templateId: string): string`.
  - `enqueueRecurringGenerate(tx: PoolClient, ctx: TenantContext, args: { templateId: string; period: string; runAt: Date; asOf?: string }): Promise<{ jobId: string } | { deduped: true }>` — dedup key `recurring:<templateId>:<period>`. Optional `asOf` (YYYY-MM-DD) is threaded into the payload so the handler can run deterministically in tests; omitted in production (the handler defaults to the real current date).
- Consumes: `enqueue` from `src/jobs/queue.js`; `TenantContext` from `src/tenancy/context.js`.

- [ ] **Step 1: Write the failing test**

Create `tests/recurring/schedule.test.ts`:

```typescript
import { expect, test } from 'vitest';
import { clampToMonth, advanceRunDate, periodKey, buildRecurringInvoiceNumber } from '../../src/recurring/schedule.js';

test('clampToMonth clamps an out-of-range anchor to the last day', () => {
  expect(clampToMonth(2026, 2, 31)).toBe('2026-02-28'); // Feb, non-leap
  expect(clampToMonth(2024, 2, 31)).toBe('2024-02-29'); // Feb, leap
  expect(clampToMonth(2026, 4, 31)).toBe('2026-04-30'); // 30-day month
  expect(clampToMonth(2026, 1, 15)).toBe('2026-01-15'); // in range, untouched
});

test('advanceRunDate steps by interval months, day from anchor', () => {
  expect(advanceRunDate('2026-01-15', 1, 15)).toBe('2026-02-15');  // monthly
  expect(advanceRunDate('2026-01-31', 1, 31)).toBe('2026-02-28');  // clamp on step
  expect(advanceRunDate('2026-11-15', 3, 15)).toBe('2027-02-15');  // quarterly, year rollover
  expect(advanceRunDate('2026-05-01', 12, 1)).toBe('2027-05-01');  // annual
});

test('periodKey and buildRecurringInvoiceNumber', () => {
  expect(periodKey('2026-05-15')).toBe('2026-05');
  expect(buildRecurringInvoiceNumber('REC', '2026-05-15', 'a1b2c3d4-0000-0000-0000-000000000000'))
    .toBe('REC-2026-05-a1b2c3d4');
  expect(buildRecurringInvoiceNumber(null, '2026-05-15', 'a1b2c3d4-0000-0000-0000-000000000000'))
    .toBe('INV-2026-05-a1b2c3d4');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/recurring/schedule.test.ts`
Expected: FAIL — cannot import from `../../src/recurring/schedule.js`.

- [ ] **Step 3: Implement `src/recurring/schedule.ts`**

```typescript
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { enqueue } from '../jobs/queue.js';

/** YYYY-MM-DD for (year, month 1-12), with anchorDay clamped to the month's last day (UTC). */
export function clampToMonth(year: number, month: number, anchorDay: number): string {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate(); // day 0 of next month = last day of this
  const day = Math.min(anchorDay, lastDay);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The next occurrence after isoDate: add intervalMonths, take the day from anchorDay (clamped). */
export function advanceRunDate(isoDate: string, intervalMonths: number, anchorDay: number): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  const total = d.getUTCMonth() + intervalMonths; // getUTCMonth is 0-11
  const year = d.getUTCFullYear() + Math.floor(total / 12);
  const month = (total % 12) + 1; // back to 1-12
  return clampToMonth(year, month, anchorDay);
}

/** The YYYY-MM period key of a run date (unique per occurrence for interval >= 1 month). */
export function periodKey(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** Deterministic per-occurrence invoice number: PREFIX-YYYY-MM-<first 8 of templateId>. */
export function buildRecurringInvoiceNumber(prefix: string | null, isoDate: string, templateId: string): string {
  return `${prefix ?? 'INV'}-${periodKey(isoDate)}-${templateId.slice(0, 8)}`;
}

/**
 * Enqueue a recurring_generate for a template's period, deduped on recurring:<templateId>:<period>.
 * Optional asOf (YYYY-MM-DD) is threaded into the payload for deterministic tests; in production it
 * is omitted and the handler bills against the real current date.
 */
export async function enqueueRecurringGenerate(
  tx: PoolClient, ctx: TenantContext,
  args: { templateId: string; period: string; runAt: Date; asOf?: string },
): Promise<{ jobId: string } | { deduped: true }> {
  return enqueue(tx, ctx, {
    type: 'recurring_generate',
    runAt: args.runAt,
    payload: { templateId: args.templateId, period: args.period, ...(args.asOf ? { asOf: args.asOf } : {}) },
    dedupKey: `recurring:${args.templateId}:${args.period}`,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/recurring/schedule.test.ts`
Expected: PASS (3 tests). Then `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/recurring/schedule.ts tests/recurring/schedule.test.ts
git commit -m "feat(recurring): cadence schedule helpers (clamp, advance, period, dedup enqueue)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Template CRUD — `src/recurring/recurring.ts`

**Files:**
- Create: `src/recurring/recurring.ts`
- Test: `tests/recurring/recurring.test.ts`

**Interfaces:**
- Produces:
  - `type RecurringInvoicePayload = Omit<EInvoice, 'invoiceNumber' | 'issueDate' | 'dueDate'>`.
  - `interface RecurringTemplateRow { id, clientCompanyId, customerPartyId, recipientPeppolId, invoicePayload: RecurringInvoicePayload, anchorDay, intervalMonths, nextRunDate: string, paymentTermsDays: number | null, endDate: string | null, occurrencesRemaining: number | null, active: boolean }`.
  - `createTemplate(tx, ctx, input): Promise<{ id: string }>` — `input`: `{ customerPartyId, recipientPeppolId, invoicePayload, anchorDay, intervalMonths, firstRunDate, paymentTermsDays?, endDate?, occurrencesRemaining? }`. Stores `firstRunDate` as `next_run_date`.
  - `getTemplate(tx, ctx, id): Promise<RecurringTemplateRow>` (throws if not found).
  - `listTemplates(tx, ctx, filter?: { active?: boolean }): Promise<RecurringTemplateRow[]>`.
  - `updateTemplate(tx, ctx, id, patch): Promise<void>` — future-runs-only fields: `invoicePayload?, recipientPeppolId?, anchorDay?, intervalMonths?, nextRunDate?, paymentTermsDays?, endDate?, occurrencesRemaining?`.
  - `deactivateTemplate(tx, ctx, id): Promise<void>` (sets `active=false`).
  - `advanceSchedule(tx, ctx, id, next: { nextRunDate: string; occurrencesRemaining: number | null; active: boolean }): Promise<void>` — used by generate.
- Consumes: `appendAudit` from `src/audit/audit.js`; `EInvoice` from `src/einvoice/ubl.js`; `TenantContext`.

- [ ] **Step 1: Write the failing test**

Create `tests/recurring/recurring.test.ts`:

```typescript
import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createParty } from '../../src/parties/parties.js';
import { createTemplate, getTemplate, listTemplates, updateTemplate, deactivateTemplate } from '../../src/recurring/recurring.js';
import type { RecurringInvoicePayload } from '../../src/recurring/recurring.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

const PAYLOAD: RecurringInvoicePayload = {
  currency: 'EUR',
  supplier: { name: 'SIA Pārdevējs', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'SIA Klients', regNo: '40200000000', vatNo: 'LV40200000000' },
  lines: [{ description: 'Abonēšana', net: '100.00', vatRate: 21, vat: '21.00' }],
  netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
};

async function make(t: ReturnType<typeof ctx>, over: Partial<Parameters<typeof createTemplate>[2]> = {}) {
  return withTenant(t, async (tx) => {
    const { id: customerPartyId } = await createParty(tx, t, { kind: 'customer', name: 'SIA Klients' });
    return createTemplate(tx, t, {
      customerPartyId, recipientPeppolId: '0088:test', invoicePayload: PAYLOAD,
      anchorDay: 1, intervalMonths: 1, firstRunDate: '2026-06-01', ...over,
    });
  });
}

test('createTemplate + getTemplate round-trips fields', async () => {
  const t = ctx(await makeFirmAndClient());
  const { id } = await make(t);
  const row = await withTenant(t, (tx) => getTemplate(tx, t, id));
  expect(row.nextRunDate).toBe('2026-06-01');
  expect(row.intervalMonths).toBe(1);
  expect(row.active).toBe(true);
  expect(row.invoicePayload.grandTotal).toBe('121.00');
  expect(row.occurrencesRemaining).toBeNull();
});

test('listTemplates filters by active', async () => {
  const t = ctx(await makeFirmAndClient());
  const { id } = await make(t);
  await make(t);
  await withTenant(t, (tx) => deactivateTemplate(tx, t, id));
  const active = await withTenant(t, (tx) => listTemplates(tx, t, { active: true }));
  expect(active).toHaveLength(1);
  const all = await withTenant(t, (tx) => listTemplates(tx, t));
  expect(all).toHaveLength(2);
});

test('updateTemplate changes future-run fields', async () => {
  const t = ctx(await makeFirmAndClient());
  const { id } = await make(t);
  await withTenant(t, (tx) => updateTemplate(tx, t, id, { intervalMonths: 3, endDate: '2027-06-01' }));
  const row = await withTenant(t, (tx) => getTemplate(tx, t, id));
  expect(row.intervalMonths).toBe(3);
  expect(row.endDate).toBe('2027-06-01');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/recurring/recurring.test.ts`
Expected: FAIL — cannot import from `../../src/recurring/recurring.js`.

- [ ] **Step 3: Implement `src/recurring/recurring.ts`**

```typescript
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import type { EInvoice } from '../einvoice/ubl.js';
import { appendAudit } from '../audit/audit.js';

export type RecurringInvoicePayload = Omit<EInvoice, 'invoiceNumber' | 'issueDate' | 'dueDate'>;

export interface RecurringTemplateRow {
  id: string;
  clientCompanyId: string;
  customerPartyId: string;
  recipientPeppolId: string;
  invoicePayload: RecurringInvoicePayload;
  anchorDay: number;
  intervalMonths: number;
  nextRunDate: string;
  paymentTermsDays: number | null;
  endDate: string | null;
  occurrencesRemaining: number | null;
  active: boolean;
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const createSchema = z.object({
  customerPartyId: z.string().uuid(),
  recipientPeppolId: z.string().min(1),
  invoicePayload: z.record(z.unknown()),
  anchorDay: z.number().int().min(1).max(31),
  intervalMonths: z.number().int().min(1),
  firstRunDate: isoDate,
  paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
  endDate: isoDate.nullable().optional(),
  occurrencesRemaining: z.number().int().min(1).nullable().optional(),
});

const SELECT_COLS = `id, client_company_id AS "clientCompanyId", customer_party_id AS "customerPartyId",
  recipient_peppol_id AS "recipientPeppolId", invoice_payload AS "invoicePayload",
  anchor_day AS "anchorDay", interval_months AS "intervalMonths", next_run_date::text AS "nextRunDate",
  payment_terms_days AS "paymentTermsDays", end_date::text AS "endDate",
  occurrences_remaining AS "occurrencesRemaining", active`;

export async function createTemplate(
  tx: PoolClient, ctx: TenantContext, input: z.input<typeof createSchema>,
): Promise<{ id: string }> {
  const p = createSchema.parse(input);
  const res = await tx.query(
    `INSERT INTO recurring_invoice_templates
       (client_company_id, customer_party_id, recipient_peppol_id, invoice_payload,
        anchor_day, interval_months, next_run_date, payment_terms_days, end_date, occurrences_remaining)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [ctx.clientCompanyId, p.customerPartyId, p.recipientPeppolId, JSON.stringify(p.invoicePayload),
     p.anchorDay, p.intervalMonths, p.firstRunDate, p.paymentTermsDays ?? null,
     p.endDate ?? null, p.occurrencesRemaining ?? null],
  );
  const id = res.rows[0].id as string;
  await appendAudit(tx, ctx, { action: 'create', entityType: 'recurring_template', entityId: id, before: null, after: { customerPartyId: p.customerPartyId, intervalMonths: p.intervalMonths } });
  return { id };
}

export async function getTemplate(tx: PoolClient, ctx: TenantContext, id: string): Promise<RecurringTemplateRow> {
  const res = await tx.query(
    `SELECT ${SELECT_COLS} FROM recurring_invoice_templates WHERE id = $1 AND client_company_id = $2`,
    [id, ctx.clientCompanyId],
  );
  if (!res.rowCount) throw new Error(`Recurring template not found: ${id}`);
  return res.rows[0];
}

export async function listTemplates(
  tx: PoolClient, ctx: TenantContext, filter: { active?: boolean } = {},
): Promise<RecurringTemplateRow[]> {
  const res = await tx.query(
    `SELECT ${SELECT_COLS} FROM recurring_invoice_templates
     WHERE client_company_id = $1 AND ($2::boolean IS NULL OR active = $2)
     ORDER BY next_run_date ASC`,
    [ctx.clientCompanyId, filter.active ?? null],
  );
  return res.rows;
}

const patchSchema = z.object({
  invoicePayload: z.record(z.unknown()).optional(),
  recipientPeppolId: z.string().min(1).optional(),
  anchorDay: z.number().int().min(1).max(31).optional(),
  intervalMonths: z.number().int().min(1).optional(),
  nextRunDate: isoDate.optional(),
  paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
  endDate: isoDate.nullable().optional(),
  occurrencesRemaining: z.number().int().min(1).nullable().optional(),
});

export async function updateTemplate(
  tx: PoolClient, ctx: TenantContext, id: string, patch: z.input<typeof patchSchema>,
): Promise<void> {
  const p = patchSchema.parse(patch);
  const before = await getTemplate(tx, ctx, id);
  const merged = {
    invoicePayload: p.invoicePayload ?? before.invoicePayload,
    recipientPeppolId: p.recipientPeppolId ?? before.recipientPeppolId,
    anchorDay: p.anchorDay ?? before.anchorDay,
    intervalMonths: p.intervalMonths ?? before.intervalMonths,
    nextRunDate: p.nextRunDate ?? before.nextRunDate,
    paymentTermsDays: p.paymentTermsDays !== undefined ? p.paymentTermsDays : before.paymentTermsDays,
    endDate: p.endDate !== undefined ? p.endDate : before.endDate,
    occurrencesRemaining: p.occurrencesRemaining !== undefined ? p.occurrencesRemaining : before.occurrencesRemaining,
  };
  await tx.query(
    `UPDATE recurring_invoice_templates SET invoice_payload = $1::jsonb, recipient_peppol_id = $2,
       anchor_day = $3, interval_months = $4, next_run_date = $5, payment_terms_days = $6,
       end_date = $7, occurrences_remaining = $8, updated_at = now()
     WHERE id = $9 AND client_company_id = $10`,
    [JSON.stringify(merged.invoicePayload), merged.recipientPeppolId, merged.anchorDay,
     merged.intervalMonths, merged.nextRunDate, merged.paymentTermsDays, merged.endDate,
     merged.occurrencesRemaining, id, ctx.clientCompanyId],
  );
  await appendAudit(tx, ctx, { action: 'update', entityType: 'recurring_template', entityId: id, before, after: merged });
}

export async function deactivateTemplate(tx: PoolClient, ctx: TenantContext, id: string): Promise<void> {
  await tx.query(
    `UPDATE recurring_invoice_templates SET active = false, updated_at = now()
     WHERE id = $1 AND client_company_id = $2`,
    [id, ctx.clientCompanyId],
  );
  await appendAudit(tx, ctx, { action: 'deactivate', entityType: 'recurring_template', entityId: id, before: null, after: { active: false } });
}

/** Persist a schedule advance (used by generateDueRecurring). */
export async function advanceSchedule(
  tx: PoolClient, ctx: TenantContext, id: string,
  next: { nextRunDate: string; occurrencesRemaining: number | null; active: boolean },
): Promise<void> {
  await tx.query(
    `UPDATE recurring_invoice_templates SET next_run_date = $1, occurrences_remaining = $2,
       active = $3, updated_at = now()
     WHERE id = $4 AND client_company_id = $5`,
    [next.nextRunDate, next.occurrencesRemaining, next.active, id, ctx.clientCompanyId],
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/recurring/recurring.test.ts`
Expected: PASS (3 tests). Then `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/recurring/recurring.ts tests/recurring/recurring.test.ts
git commit -m "feat(recurring): template CRUD (create/get/list/update/deactivate)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `generateDueRecurring` — autonomy-gated issue, skip-to-current, end conditions

**Files:**
- Create: `src/recurring/generate.ts`
- Test: `tests/recurring/generate.test.ts`

**Interfaces:**
- Produces: `generateDueRecurring(tx, ctx, args: { templateId: string; now: Date; ap: AccessPoint; accounts: { receivable: string; sales: string; vat: string } }): Promise<{ generated: boolean; active: boolean }>`.
- Consumes: `getTemplate`, `advanceSchedule`, `deactivateTemplate` from `src/recurring/recurring.js`; `advanceRunDate`, `periodKey`, `buildRecurringInvoiceNumber` from `src/recurring/schedule.js`; `resolveAutonomy` from `src/autonomy/autonomy.js`; `createProposal` from `src/proposals/proposals.js`; `sendInvoice` from `src/einvoice/outbound.js`; `getInvoiceProfile` from `src/einvoice/invoice-profile.js`; `getParty`, `dueDateFromTerms` from `src/parties/parties.js`; `toCents` from `src/db/money.js`; `AccessPoint` from `src/einvoice/access-point.js`; `EInvoice` from `src/einvoice/ubl.js`.

- [ ] **Step 1: Write the failing test**

Create `tests/recurring/generate.test.ts`:

```typescript
import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { createParty } from '../../src/parties/parties.js';
import { setAutonomy } from '../../src/autonomy/autonomy.js';
import { listProposals } from '../../src/proposals/proposals.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { createTemplate, getTemplate } from '../../src/recurring/recurring.js';
import type { RecurringInvoicePayload } from '../../src/recurring/recurring.js';
import { generateDueRecurring } from '../../src/recurring/generate.js';

const ACCOUNTS = { receivable: '2310', sales: '6110', vat: '5721' };
const PAYLOAD: RecurringInvoicePayload = {
  currency: 'EUR',
  supplier: { name: 'SIA Pārdevējs', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'SIA Klients', regNo: '40200000000', vatNo: 'LV40200000000' },
  lines: [{ description: 'Abonēšana', net: '100.00', vatRate: 21, vat: '21.00' }],
  netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
};

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

/** Tenant + accounts + open 2026-05 period + customer party; returns ctx + customerPartyId. */
async function setup(): Promise<{ t: ReturnType<typeof ctx>; customerPartyId: string }> {
  const t = ctx(await makeFirmAndClient());
  const customerPartyId = await withTenant(t, async (tx) => {
    await createAccount(tx, t, { code: '2310', name: 'Debtors', type: 'asset' });
    await createAccount(tx, t, { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, t, { code: '5721', name: 'Output VAT', type: 'liability' });
    await openPeriod(tx, t, { year: 2026, month: 5 });
    const { id } = await createParty(tx, t, { kind: 'customer', name: 'SIA Klients', paymentTermsDays: 14 });
    return id;
  });
  return { t, customerPartyId };
}

async function makeTemplate(t: ReturnType<typeof ctx>, customerPartyId: string, over = {}) {
  return withTenant(t, (tx) => createTemplate(tx, t, {
    customerPartyId, recipientPeppolId: '0088:test', invoicePayload: PAYLOAD,
    anchorDay: 10, intervalMonths: 1, firstRunDate: '2026-05-10', ...over,
  }));
}

test('auto autonomy issues an open receivable and advances next_run_date', async () => {
  const { t, customerPartyId } = await setup();
  await withTenant(t, (tx) => setAutonomy(tx, t, { operationType: 'recurring_invoice', mode: 'auto' }));
  const { id } = await makeTemplate(t, customerPartyId);

  const r = await withTenant(t, (tx) => generateDueRecurring(tx, t, {
    templateId: id, now: new Date('2026-05-10T09:00:00Z'), ap: new StubAccessPoint(), accounts: ACCOUNTS,
  }));
  expect(r).toEqual({ generated: true, active: true });

  const inv = await withTenant(t, (tx) => tx.query(
    `SELECT invoice_number, status, due_date::text AS due FROM einvoices WHERE direction='outbound'`));
  expect(inv.rows[0].status).toBe('open');
  expect(inv.rows[0].invoice_number).toMatch(/^INV-2026-05-/);
  expect(inv.rows[0].due).toBe('2026-05-24'); // issue 05-10 + 14 terms
  const row = await withTenant(t, (tx) => getTemplate(tx, t, id));
  expect(row.nextRunDate).toBe('2026-06-10');
});

test('approval autonomy creates a pending_approval proposal and NO einvoice', async () => {
  const { t, customerPartyId } = await setup();
  // no autonomy policy → default-closed → approval
  const { id } = await makeTemplate(t, customerPartyId);
  const r = await withTenant(t, (tx) => generateDueRecurring(tx, t, {
    templateId: id, now: new Date('2026-05-10T09:00:00Z'), ap: new StubAccessPoint(), accounts: ACCOUNTS,
  }));
  expect(r.generated).toBe(true);
  const held = await withTenant(t, (tx) => listProposals(tx, t, { status: 'pending_approval' }));
  expect(held.map((p) => p.type)).toEqual(['recurring_invoice']);
  const inv = await withTenant(t, (tx) => tx.query(`SELECT count(*)::int AS n FROM einvoices`));
  expect(inv.rows[0].n).toBe(0);
});

test('skip-to-current: a back-dated template bills the latest occurrence once', async () => {
  const { t, customerPartyId } = await setup();
  await withTenant(t, (tx) => setAutonomy(tx, t, { operationType: 'recurring_invoice', mode: 'auto' }));
  await withTenant(t, async (tx) => { await openPeriod(tx, t, { year: 2026, month: 1 }); });
  const { id } = await makeTemplate(t, customerPartyId, { firstRunDate: '2026-01-10' });

  const r = await withTenant(t, (tx) => generateDueRecurring(tx, t, {
    templateId: id, now: new Date('2026-05-15T09:00:00Z'), ap: new StubAccessPoint(), accounts: ACCOUNTS,
  }));
  expect(r.generated).toBe(true);
  const inv = await withTenant(t, (tx) => tx.query(`SELECT invoice_number, count(*) OVER () AS n FROM einvoices`));
  expect(inv.rowCount).toBe(1);                       // exactly one invoice, not five
  expect(inv.rows[0].invoice_number).toMatch(/^INV-2026-05-/); // current period, not January
  const row = await withTenant(t, (tx) => getTemplate(tx, t, id));
  expect(row.nextRunDate).toBe('2026-06-10');
});

test('not-yet-due template is a no-op that stays active', async () => {
  const { t, customerPartyId } = await setup();
  await withTenant(t, (tx) => setAutonomy(tx, t, { operationType: 'recurring_invoice', mode: 'auto' }));
  const { id } = await makeTemplate(t, customerPartyId, { firstRunDate: '2026-07-10' });
  const r = await withTenant(t, (tx) => generateDueRecurring(tx, t, {
    templateId: id, now: new Date('2026-05-10T09:00:00Z'), ap: new StubAccessPoint(), accounts: ACCOUNTS,
  }));
  expect(r).toEqual({ generated: false, active: true });
  const inv = await withTenant(t, (tx) => tx.query(`SELECT count(*)::int AS n FROM einvoices`));
  expect(inv.rows[0].n).toBe(0);
});

test('occurrences_remaining=1 generates once then deactivates', async () => {
  const { t, customerPartyId } = await setup();
  await withTenant(t, (tx) => setAutonomy(tx, t, { operationType: 'recurring_invoice', mode: 'auto' }));
  const { id } = await makeTemplate(t, customerPartyId, { occurrencesRemaining: 1 });
  const r = await withTenant(t, (tx) => generateDueRecurring(tx, t, {
    templateId: id, now: new Date('2026-05-10T09:00:00Z'), ap: new StubAccessPoint(), accounts: ACCOUNTS,
  }));
  expect(r).toEqual({ generated: true, active: false });
  const row = await withTenant(t, (tx) => getTemplate(tx, t, id));
  expect(row.active).toBe(false);
  expect(row.occurrencesRemaining).toBe(0);
});

test('inactive template is a no-op', async () => {
  const { t, customerPartyId } = await setup();
  const { id } = await makeTemplate(t, customerPartyId);
  await withTenant(t, (tx) => tx.query(`UPDATE recurring_invoice_templates SET active=false WHERE id=$1`, [id]));
  const r = await withTenant(t, (tx) => generateDueRecurring(tx, t, {
    templateId: id, now: new Date('2026-05-10T09:00:00Z'), ap: new StubAccessPoint(), accounts: ACCOUNTS,
  }));
  expect(r).toEqual({ generated: false, active: false });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/recurring/generate.test.ts`
Expected: FAIL — cannot import from `../../src/recurring/generate.js`.

- [ ] **Step 3: Implement `src/recurring/generate.ts`**

```typescript
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import type { AccessPoint } from '../einvoice/access-point.js';
import type { EInvoice } from '../einvoice/ubl.js';
import { getTemplate, advanceSchedule, deactivateTemplate } from './recurring.js';
import { advanceRunDate, periodKey, buildRecurringInvoiceNumber } from './schedule.js';
import { resolveAutonomy } from '../autonomy/autonomy.js';
import { createProposal } from '../proposals/proposals.js';
import { sendInvoice } from '../einvoice/outbound.js';
import { getInvoiceProfile } from '../einvoice/invoice-profile.js';
import { getParty, dueDateFromTerms } from '../parties/parties.js';
import { toCents } from '../db/money.js';

/**
 * Bill the latest scheduled occurrence on/before today (skip-to-current), gate issue via autonomy
 * (auto → sendInvoice; approval → a pending_approval proposal), then advance next_run_date and
 * apply end conditions. Idempotent: the advance commits in the same tx as the send, so a redelivered
 * job finds nothing due. Returns { generated, active } where active drives handler self-perpetuation.
 */
export async function generateDueRecurring(
  tx: PoolClient, ctx: TenantContext,
  args: { templateId: string; now: Date; ap: AccessPoint; accounts: { receivable: string; sales: string; vat: string } },
): Promise<{ generated: boolean; active: boolean }> {
  const today = args.now.toISOString().slice(0, 10);
  const t = await getTemplate(tx, ctx, args.templateId);
  if (!t.active) return { generated: false, active: false };

  // Skip-to-current: walk forward to the latest occurrence on/before today.
  let billDate = t.nextRunDate;
  while (advanceRunDate(billDate, t.intervalMonths, t.anchorDay) <= today) {
    billDate = advanceRunDate(billDate, t.intervalMonths, t.anchorDay);
  }
  if (billDate > today) return { generated: false, active: true }; // not yet due

  // End conditions evaluated against the date we would bill.
  if (t.endDate && billDate > t.endDate) { await deactivateTemplate(tx, ctx, t.id); return { generated: false, active: false }; }
  if (t.occurrencesRemaining !== null && t.occurrencesRemaining <= 0) { await deactivateTemplate(tx, ctx, t.id); return { generated: false, active: false }; }

  // Build the invoice from the template payload + per-run fields.
  const profile = await getInvoiceProfile(tx, ctx);
  const invoiceNumber = buildRecurringInvoiceNumber(profile?.numberPrefix ?? null, billDate, t.id);
  let termsDays = t.paymentTermsDays;
  if (termsDays == null) {
    const party = await getParty(tx, ctx, t.customerPartyId);
    termsDays = party.paymentTermsDays;
  }
  const dueDate = termsDays != null ? dueDateFromTerms(billDate, termsDays) : null;
  const invoice: EInvoice = { ...t.invoicePayload, invoiceNumber, issueDate: billDate, ...(dueDate ? { dueDate } : {}) };

  // Autonomy gate.
  const mode = await resolveAutonomy(tx, ctx, 'recurring_invoice', { amountCents: toCents(invoice.grandTotal) });
  if (mode === 'auto') {
    await sendInvoice(tx, ctx, {
      invoice, recipientPeppolId: t.recipientPeppolId, ap: args.ap,
      receivableAccount: args.accounts.receivable, salesAccount: args.accounts.sales, vatAccount: args.accounts.vat,
      customerPartyId: t.customerPartyId, dueDate,
    });
  } else {
    await createProposal(tx, ctx, {
      type: 'recurring_invoice', status: 'pending_approval',
      payload: { invoice, recipientPeppolId: t.recipientPeppolId, customerPartyId: t.customerPartyId, dueDate },
      rationale: { computation: `recurring invoice for ${periodKey(billDate)}`, sourceRefs: { templateId: t.id, period: periodKey(billDate) } },
    });
  }

  // Advance schedule + apply end conditions for the NEXT run.
  const nextRunDate = advanceRunDate(billDate, t.intervalMonths, t.anchorDay);
  const occurrencesRemaining = t.occurrencesRemaining === null ? null : Math.max(0, t.occurrencesRemaining - 1);
  const active = !(t.endDate != null && nextRunDate > t.endDate) && !(occurrencesRemaining !== null && occurrencesRemaining <= 0);
  await advanceSchedule(tx, ctx, t.id, { nextRunDate, occurrencesRemaining, active });
  return { generated: true, active };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/recurring/generate.test.ts`
Expected: PASS (6 tests). Then `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/recurring/generate.ts tests/recurring/generate.test.ts
git commit -m "feat(recurring): generateDueRecurring — autonomy-gated issue, skip-to-current, end conditions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `recurring_generate` handler + `reapRecurring` reaper

**Files:**
- Create: `src/recurring/reap.ts`
- Modify: `src/jobs/register.ts` (register the handler + reaper)
- Test: `tests/recurring/reap.test.ts`, `tests/jobs/recurring-job.test.ts`

**Interfaces:**
- Produces: `reapRecurring(tx: PoolClient, args: { now: Date }): Promise<{ seeded: number }>` (a `Reaper`); handler registration for `'recurring_generate'`.
- Consumes: `registerHandler` from `src/jobs/handlers.js`; `registerReaper` from `src/jobs/reapers.js`; `generateDueRecurring` from `src/recurring/generate.js`; `getTemplate` from `src/recurring/recurring.js`; `enqueueRecurringGenerate`, `periodKey` from `src/recurring/schedule.js`; `utcMidnight` from `src/dunning/schedule.js`; `StubAccessPoint` from `src/einvoice/access-point.js`; `drainOnce` from `src/jobs/worker.js`; `arAging` from `src/receivables/aging.js`.

- [ ] **Step 1: Write the failing reaper test**

Create `tests/recurring/reap.test.ts`:

```typescript
import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant, withWorker, withSupervisor } from '../../src/db/pool.js';
import { createParty } from '../../src/parties/parties.js';
import { createTemplate } from '../../src/recurring/recurring.js';
import type { RecurringInvoicePayload } from '../../src/recurring/recurring.js';
import { reapRecurring } from '../../src/recurring/reap.js';

const PAYLOAD: RecurringInvoicePayload = {
  currency: 'EUR', supplier: { name: 'S' }, customer: { name: 'C' },
  lines: [{ description: 'x', net: '100.00', vatRate: 21, vat: '21.00' }],
  netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
};
const NOW = new Date('2026-05-10T09:00:00Z');

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function makeDueTemplate(t: ReturnType<typeof ctx>, over = {}) {
  return withTenant(t, async (tx) => {
    const { id: customerPartyId } = await createParty(tx, t, { kind: 'customer', name: 'C' });
    return createTemplate(tx, t, {
      customerPartyId, recipientPeppolId: '0088:test', invoicePayload: PAYLOAD,
      anchorDay: 5, intervalMonths: 1, firstRunDate: '2026-05-05', ...over,
    });
  });
}

test('seeds a recurring_generate for an active due template with no live job', async () => {
  const t = ctx(await makeFirmAndClient());
  await makeDueTemplate(t);
  const { seeded } = await withSupervisor((tx) => reapRecurring(tx, { now: NOW }));
  expect(seeded).toBe(1);
  const jobs = await withWorker((tx) => tx.query(`SELECT type, status FROM jobs`));
  expect(jobs.rows).toEqual([{ type: 'recurring_generate', status: 'pending' }]);
});

test('no-op when a live job already exists', async () => {
  const t = ctx(await makeFirmAndClient());
  await makeDueTemplate(t);
  await withSupervisor((tx) => reapRecurring(tx, { now: NOW }));
  const { seeded } = await withSupervisor((tx) => reapRecurring(tx, { now: NOW }));
  expect(seeded).toBe(0);
});

test('no-op for an inactive template', async () => {
  const t = ctx(await makeFirmAndClient());
  const { id } = await makeDueTemplate(t);
  await withTenant(t, (tx) => tx.query(`UPDATE recurring_invoice_templates SET active=false WHERE id=$1`, [id]));
  const { seeded } = await withSupervisor((tx) => reapRecurring(tx, { now: NOW }));
  expect(seeded).toBe(0);
});

test('revives a dead chain: only a past failed job exists', async () => {
  const t = ctx(await makeFirmAndClient());
  await makeDueTemplate(t);
  await withSupervisor((tx) => reapRecurring(tx, { now: NOW }));
  await withWorker((tx) => tx.query(`UPDATE jobs SET status='failed'`));
  const { seeded } = await withSupervisor((tx) => reapRecurring(tx, { now: NOW }));
  expect(seeded).toBe(1);
});

test('no-op when the template is not yet due', async () => {
  const t = ctx(await makeFirmAndClient());
  await makeDueTemplate(t, { firstRunDate: '2026-07-05' });
  const { seeded } = await withSupervisor((tx) => reapRecurring(tx, { now: NOW }));
  expect(seeded).toBe(0);
});
```

- [ ] **Step 2: Run the reaper test to verify it fails**

Run: `npm test -- tests/recurring/reap.test.ts`
Expected: FAIL — cannot import `reapRecurring` from `../../src/recurring/reap.js`.

- [ ] **Step 3: Implement `src/recurring/reap.ts`**

```typescript
import type { PoolClient } from 'pg';

/**
 * Chain reaper for recurring invoices (runs on a withSupervisor tx). Seeds a recurring_generate for
 * every ACTIVE template that is due (next_run_date <= today) and has no live (pending/running)
 * recurring_generate job — recovering never-seeded, terminal-failed, and re-activated chains.
 * Idempotent via the recurring:<templateId>:<period> dedup key + the NOT EXISTS(live job) guard.
 */
export async function reapRecurring(tx: PoolClient, args: { now: Date }): Promise<{ seeded: number }> {
  const today = args.now.toISOString().slice(0, 10);
  const res = await tx.query(
    `INSERT INTO jobs (client_company_id, firm_id, type, run_at, payload, dedup_key)
     SELECT t.client_company_id, c.firm_id, 'recurring_generate', $1::timestamptz,
            jsonb_build_object('templateId', t.id::text, 'period', to_char(t.next_run_date, 'YYYY-MM')),
            'recurring:' || t.id::text || ':' || to_char(t.next_run_date, 'YYYY-MM')
       FROM recurring_invoice_templates t
       JOIN client_companies c ON c.id = t.client_company_id
      WHERE t.active = true
        AND t.next_run_date <= $2::date
        AND NOT EXISTS (
          SELECT 1 FROM jobs j
           WHERE j.client_company_id = t.client_company_id AND j.type = 'recurring_generate'
             AND j.payload->>'templateId' = t.id::text
             AND j.status IN ('pending','running'))
     ON CONFLICT (client_company_id, type, dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [args.now.toISOString(), today],
  );
  return { seeded: res.rowCount ?? 0 };
}
```

- [ ] **Step 4: Register the handler + reaper in `src/jobs/register.ts`**

Add these imports alongside the existing ones:

```typescript
import { generateDueRecurring } from '../recurring/generate.js';
import { getTemplate } from '../recurring/recurring.js';
import { enqueueRecurringGenerate, periodKey } from '../recurring/schedule.js';
import { utcMidnight } from '../dunning/schedule.js';
import { reapRecurring } from '../recurring/reap.js';
import { StubAccessPoint } from '../einvoice/access-point.js';
```

Add a module-level Access Point + accounts (mirrors `web/app/lib/access-point.ts` — swap for the real provider when it lands), then register the handler and reaper:

```typescript
// Worker-side Access Point + AR account codes for generated recurring invoices.
const recurringAccessPoint = new StubAccessPoint();
const recurringAccounts = {
  receivable: process.env.EINVOICE_RECEIVABLE_ACCOUNT ?? '2310',
  sales: process.env.EINVOICE_SALES_ACCOUNT ?? '6110',
  vat: process.env.EINVOICE_VAT_ACCOUNT ?? '5721',
};

registerHandler('recurring_generate', async (tx, ctx, payload) => {
  const templateId = payload.templateId as string;
  // asOf lets tests run deterministically; production omits it and bills against the real date.
  const asOf = payload.asOf as string | undefined;
  const now = asOf ? new Date(asOf + 'T00:00:00Z') : new Date();
  const { active } = await generateDueRecurring(tx, ctx, {
    templateId, now, ap: recurringAccessPoint, accounts: recurringAccounts,
  });
  // Self-perpetuate only while active (else jobs would grow one row/template/period).
  if (active) {
    const t = await getTemplate(tx, ctx, templateId);
    await enqueueRecurringGenerate(tx, ctx, {
      templateId, period: periodKey(t.nextRunDate), runAt: utcMidnight(t.nextRunDate),
    });
  }
});

registerReaper(reapRecurring);
```

- [ ] **Step 5: Run the reaper test to verify it passes**

Run: `npm test -- tests/recurring/reap.test.ts`
Expected: PASS (5 tests). Then `npm run typecheck` → clean.

- [ ] **Step 6: Write the failing handler/integration test**

Create `tests/jobs/recurring-job.test.ts`:

```typescript
import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant, withWorker } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { createParty } from '../../src/parties/parties.js';
import { setAutonomy } from '../../src/autonomy/autonomy.js';
import { arAging } from '../../src/receivables/aging.js';
import { createTemplate, getTemplate } from '../../src/recurring/recurring.js';
import type { RecurringInvoicePayload } from '../../src/recurring/recurring.js';
import { enqueueRecurringGenerate, periodKey } from '../../src/recurring/schedule.js';
import { utcMidnight } from '../../src/dunning/schedule.js';
import { drainOnce } from '../../src/jobs/worker.js';
import '../../src/jobs/register.js';

const PAYLOAD: RecurringInvoicePayload = {
  currency: 'EUR',
  supplier: { name: 'SIA Pārdevējs', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'SIA Klients', regNo: '40200000000', vatNo: 'LV40200000000' },
  lines: [{ description: 'Abonēšana', net: '100.00', vatRate: 21, vat: '21.00' }],
  netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
};

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function setup() {
  const t = ctx(await makeFirmAndClient());
  const customerPartyId = await withTenant(t, async (tx) => {
    await createAccount(tx, t, { code: '2310', name: 'Debtors', type: 'asset' });
    await createAccount(tx, t, { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, t, { code: '5721', name: 'Output VAT', type: 'liability' });
    await openPeriod(tx, t, { year: 2026, month: 5 });
    await setAutonomy(tx, t, { operationType: 'recurring_invoice', mode: 'auto' });
    const { id } = await createParty(tx, t, { kind: 'customer', name: 'SIA Klients', paymentTermsDays: 14 });
    return id;
  });
  const { id } = await withTenant(t, (tx) => createTemplate(tx, t, {
    customerPartyId, recipientPeppolId: '0088:test', invoicePayload: PAYLOAD,
    anchorDay: 10, intervalMonths: 1, firstRunDate: '2026-05-10',
  }));
  return { t, templateId: id };
}

test('draining a recurring_generate job creates an open receivable that ages, and perpetuates one successor', async () => {
  const { t, templateId } = await setup();
  await withTenant(t, (tx) => enqueueRecurringGenerate(tx, t, {
    templateId, period: '2026-05', runAt: utcMidnight('2026-05-10'), asOf: '2026-05-10',
  }));

  const { ran, failed } = await drainOnce({ now: new Date('2026-05-10T09:00:00Z'), leaseTimeoutMs: 5 * 60 * 1000, limit: 10 });
  expect({ ran, failed }).toEqual({ ran: 1, failed: 0 });

  const aging = await withTenant(t, (tx) => arAging(tx, t, { asOf: '2026-05-10' }));
  expect(aging.total).toBe('121.00'); // born open, flows into AR aging

  // Exactly one successor job for the advanced period.
  const row = await withTenant(t, (tx) => getTemplate(tx, t, templateId));
  expect(row.nextRunDate).toBe('2026-06-10');
  const pending = await withWorker((tx) => tx.query(`SELECT dedup_key FROM jobs WHERE status='pending'`));
  expect(pending.rows).toEqual([{ dedup_key: 'recurring:' + templateId + ':2026-06' }]);
});

test('an inactive template stops chain perpetuation (no successor)', async () => {
  const { t, templateId } = await setup();
  await withTenant(t, (tx) => tx.query(`UPDATE recurring_invoice_templates SET active=false WHERE id=$1`, [templateId]));
  await withTenant(t, (tx) => enqueueRecurringGenerate(tx, t, {
    templateId, period: '2026-05', runAt: utcMidnight('2026-05-10'), asOf: '2026-05-10',
  }));
  await drainOnce({ now: new Date('2026-05-10T09:00:00Z'), leaseTimeoutMs: 5 * 60 * 1000, limit: 10 });
  const pending = await withWorker((tx) => tx.query(`SELECT count(*)::int AS n FROM jobs WHERE status='pending'`));
  expect(pending.rows[0].n).toBe(0);
});
```

- [ ] **Step 7: Run the handler/integration test to verify it passes**

Run: `npm test -- tests/jobs/recurring-job.test.ts`
Expected: PASS (2 tests) — the handler is already registered from Step 4. Then `npm run typecheck` → clean.

- [ ] **Step 8: Commit**

```bash
git add src/recurring/reap.ts src/jobs/register.ts tests/recurring/reap.test.ts tests/jobs/recurring-job.test.ts
git commit -m "feat(recurring,jobs): recurring_generate handler + reapRecurring reaper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Template CRUD API routes + full verification

**Files:**
- Create: `web/app/api/recurring/route.ts` (GET list, POST create)
- Create: `web/app/api/recurring/[id]/route.ts` (PATCH update, DELETE deactivate)
- Test: `tests/recurring/api-shape.test.ts` (domain-level contract test for the create→enqueue path)

**Interfaces:**
- Consumes: `resolveTenantContext` from `@domain/auth/context.js`; `withTenant` from `@domain/db/pool.js`; `createTemplate`, `listTemplates`, `updateTemplate`, `deactivateTemplate` from `@domain/recurring/recurring.js`; `enqueueRecurringGenerate`, `periodKey` from `@domain/recurring/schedule.js`; `utcMidnight` from `@domain/dunning/schedule.js`; `getSessionToken`, `nowUnix` from `@/app/lib/session`; `assertRoleAllowed`, `errorToStatus` from `@/app/lib/authz`.
- Produces: REST endpoints; on POST create, the first `recurring_generate` job is enqueued in the same transaction.

**IMPORTANT:** This repo runs a modified Next.js. Before writing either route file, read `web/AGENTS.md` and the relevant guide under `web/node_modules/next/dist/docs/`. Mirror the structure of the existing `web/app/api/einvoices/route.ts` (route-handler shape, `runtime`/`dynamic` exports, error handling, `assertRoleAllowed`).

- [ ] **Step 1: Write the failing domain contract test**

Create `tests/recurring/api-shape.test.ts` (verifies the create-then-enqueue behavior the POST route relies on, without booting Next.js):

```typescript
import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant, withWorker } from '../../src/db/pool.js';
import { createParty } from '../../src/parties/parties.js';
import { createTemplate } from '../../src/recurring/recurring.js';
import type { RecurringInvoicePayload } from '../../src/recurring/recurring.js';
import { enqueueRecurringGenerate, periodKey } from '../../src/recurring/schedule.js';
import { utcMidnight } from '../../src/dunning/schedule.js';

const PAYLOAD: RecurringInvoicePayload = {
  currency: 'EUR', supplier: { name: 'S' }, customer: { name: 'C' },
  lines: [{ description: 'x', net: '100.00', vatRate: 21, vat: '21.00' }],
  netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
};

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('creating a template and enqueuing its first job (the POST route contract)', async () => {
  const t = ctx(await makeFirmAndClient());
  const { id } = await withTenant(t, async (tx) => {
    const { id: customerPartyId } = await createParty(tx, t, { kind: 'customer', name: 'C' });
    const created = await createTemplate(tx, t, {
      customerPartyId, recipientPeppolId: '0088:test', invoicePayload: PAYLOAD,
      anchorDay: 10, intervalMonths: 1, firstRunDate: '2026-06-10',
    });
    await enqueueRecurringGenerate(tx, t, { templateId: created.id, period: periodKey('2026-06-10'), runAt: utcMidnight('2026-06-10') });
    return created;
  });
  const jobs = await withWorker((tx) => tx.query(`SELECT type, dedup_key FROM jobs`));
  expect(jobs.rows).toEqual([{ type: 'recurring_generate', dedup_key: 'recurring:' + id + ':2026-06' }]);
});
```

- [ ] **Step 2: Run the test to verify it fails, then passes**

Run: `npm test -- tests/recurring/api-shape.test.ts`
Expected: FAIL first only if a dependency is missing; since Tasks 2–3 exist, this should PASS immediately (it exercises already-built domain code). If it passes on first run, that is the expected green — proceed. (This test guards the exact contract the POST route below implements.)

- [ ] **Step 3: Implement `web/app/api/recurring/route.ts`**

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { createTemplate, listTemplates } from '@domain/recurring/recurring.js';
import { enqueueRecurringGenerate, periodKey } from '@domain/recurring/schedule.js';
import { utcMidnight } from '@domain/dunning/schedule.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const activeParam = req.nextUrl.searchParams.get('active');
  const filter = activeParam == null ? {} : { active: activeParam === 'true' };
  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const templates = await withTenant(ctx, (tx) => listTemplates(tx, ctx, filter));
    return NextResponse.json({ templates }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string; template?: Record<string, unknown> };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.template) return NextResponse.json({ error: 'missing template' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'einvoice.issue');
    const result = await withTenant(ctx, async (tx) => {
      const created = await createTemplate(tx, ctx, body.template as Parameters<typeof createTemplate>[2]);
      const firstRunDate = (body.template as { firstRunDate: string }).firstRunDate;
      await enqueueRecurringGenerate(tx, ctx, { templateId: created.id, period: periodKey(firstRunDate), runAt: utcMidnight(firstRunDate) });
      return created;
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
```

- [ ] **Step 4: Implement `web/app/api/recurring/[id]/route.ts`**

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { updateTemplate, deactivateTemplate } from '@domain/recurring/recurring.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

async function resolve(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return null;
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) throw new Error('missing clientCompanyId');
  return resolveTenantContext(token, clientCompanyId, nowUnix());
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await resolve(req);
    if (!ctx) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
    assertRoleAllowed(ctx.actorRole, 'einvoice.issue');
    const { id } = await params;
    const patch = (await req.json().catch(() => ({}))) as Parameters<typeof updateTemplate>[3];
    await withTenant(ctx, (tx) => updateTemplate(tx, ctx, id, patch));
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await resolve(req);
    if (!ctx) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
    assertRoleAllowed(ctx.actorRole, 'einvoice.issue');
    const { id } = await params;
    await withTenant(ctx, (tx) => deactivateTemplate(tx, ctx, id));
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
```

> Note: the `params: Promise<{ id: string }>` shape matches this repo's modified Next.js — **confirm against an existing `[id]` route** (e.g. `web/app/(cabinet)/bills/[id]`) and the docs under `web/node_modules/next/dist/docs/` before finalizing; adjust if the local convention differs.

- [ ] **Step 5: Typecheck the web workspace**

Run: `npm run typecheck` (root) and, if the web workspace has its own, the web typecheck (check `web/package.json` scripts; e.g. `cd web && npm run typecheck`).
Expected: clean.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all green — the prior suite plus the new recurring domain/reaper/handler/RLS tests.

- [ ] **Step 7: Commit**

```bash
git add web/app/api/recurring tests/recurring/api-shape.test.ts
git commit -m "feat(recurring): template CRUD API routes (create enqueues first job); full suite green

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Data model / migration 037 (templates, RLS, supervisor read, proposals type) → Task 1. ✓
- Invoice numbering (deterministic) → Task 2 (`buildRecurringInvoiceNumber`) + used in Task 4. ✓
- Domain `recurring.ts` CRUD (future-runs-only, deactivate) → Task 3. ✓
- `schedule.ts` (clamp, advance, period, enqueue) → Task 2. ✓
- `generate.ts` (autonomy gate auto→send / approval→proposal, skip-to-current, end conditions) → Task 4. ✓
- Job wiring (`recurring_generate` handler + self-perpetuation gate, first-job enqueue, `reapRecurring`) → Task 5 (+ enqueue on create in Task 6). ✓
- API routes → Task 6. UI screen explicitly deferred (matches dunning precedent) — noted in Global Constraints. ✓
- Testing: cadence math, catch-up, end conditions, autonomy branches, idempotency, reaper cases, RLS, integration → Tasks 1–6. ✓
- Scope boundaries (no backfill, no cron, no gapless numbering, no price-versioning) → respected. ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `RecurringInvoicePayload` / `RecurringTemplateRow` consistent across Tasks 3–6; `generateDueRecurring(tx, ctx, {templateId, now, ap, accounts})` and its `{generated, active}` return used identically in Tasks 4–5; dedup key `recurring:<templateId>:<period>` identical across `enqueueRecurringGenerate` (Task 2), `reapRecurring` (Task 5), and the tests; `advanceSchedule` signature matches its Task-4 caller; autonomy op string `'recurring_invoice'` consistent across Task 1 (CHECK), Task 4 (gate), and tests. ✓

**One accepted deviation from the spec:** the spec's §5 mentioned a management screen; the plan defers the UI to the impeccable-init track and ships tested API routes only, matching the dunning slice. Flagged in Global Constraints.
