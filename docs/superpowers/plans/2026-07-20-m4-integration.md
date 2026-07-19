# M4 Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the three unmerged M4 branches (AR money-in loop, settle UI, dunning + job-queue infra) onto main, reconciled with what main gained since the fork (M7 credit notes, M14 reports, M3 bank feeds, hardening).

**Architecture:** Sequential merges of `origin/m4a-ar-money-in-loop` → `origin/m4a-ui-settle` → `origin/m4b-dunning` into a local `m4-integration` branch off main, resolving conflicts once per slice; then four reconciliation tasks (credit-note application, AR-aging netting, authz operations, Vercel cron for the job queue); then docs, gates, final review, merge to main + push.

**Tech Stack:** TypeScript, Postgres 16 (RLS, filename-ordered SQL migrations), Next.js 16 (`web/`), vitest.

**Spec:** `docs/superpowers/specs/2026-07-19-m4-integration-design.md`

## Global Constraints

- Never run two vitest suites concurrently — `resetDb` drops the schema; run `npm test` alone, sequentially.
- Gates for every task: `npm test` (repo root, requires `docker compose up -d db` + `npm run migrate`), `npx tsc --noEmit` (root), `cd web && npx tsc --noEmit`.
- Money is integer cents (`bigint` in SQL, `BigInt`/`src/db/money.ts` in TS). Never floats.
- Every user-facing string exists in all three catalogs (LV/RU/EN) in `web/app/lib/i18n.ts` — the typed record fails `tsc` if a key is missing in any language.
- Migration filenames: never reuse a number; this plan renumbers branch migrations to `037`–`041` (byte-identical content) and adds `042`. `tests/db/migration-numbering.test.ts` enforces no collisions.
- Every domain mutation runs inside `withTenant(ctx, ...)` and calls `appendAudit(...)`.
- `web/` runs a modified Next.js — copy existing route/page patterns; do not introduce new Next.js APIs without reading `web/node_modules/next/dist/docs/`.
- Merge conflicts: both parents are always available as `HEAD` (ours) and `MERGE_HEAD` (theirs) — when unsure, `git show HEAD:<file>` / `git show MERGE_HEAD:<file>` and reconstruct the union by hand.
- End commit messages with the trailer:
  `Claude-Session: https://claude.ai/code/session_01KSc2FBU6R8j58wcNaikqwB`

---

### Task 1: Merge slice A (`m4a-ar-money-in-loop`) + renumber its migration

**Files:**
- Modify (conflict resolution): `docs/ROADMAP-market-gaps.md`, `web/app/(cabinet)/invoices/new/page.tsx`, `web/app/(cabinet)/reports/page.tsx`, `web/app/lib/i18n.ts`
- Rename: `migrations/032_receivables.sql` → `migrations/037_receivables.sql`
- Everything else on the branch auto-merges (receivables module, `src/einvoice/outbound.ts`, banking matcher, routes, tests).

**Interfaces:**
- Produces (used by Tasks 2–5): `src/receivables/receivables.ts` (`getReceivable`, `listReceivables`, `voidReceivable`, `ReceivableRow` with `outstandingCents: string`), `src/receivables/settlement.ts` (`settleReceivable`), `src/receivables/aging.ts` (`arAging`), einvoices columns `customer_party_id`, `due_date`, `amount_paid_cents`, `status`, table `invoice_payments`.

- [ ] **Step 1: Create the integration branch and start the merge**

```bash
git checkout -b m4-integration main
git merge --no-commit origin/m4a-ar-money-in-loop
```

Expected: 4 content conflicts — exactly the files listed above. `src/einvoice/outbound.ts` auto-merges (main changed the VAT-line conditional + appended `sendCreditNote`; the branch changed `sendInvoice`'s signature and INSERT — disjoint regions).

- [ ] **Step 2: Resolve each conflict as a union of both sides**

- `web/app/lib/i18n.ts` — keep **both** sides' new keys in **all three** catalogs (main added report-export/GL/TB and credit-note keys; the branch added AR-aging/receivable keys). The typed `Record<keyof typeof EN, string>` catches any miss at `tsc` time.
- `web/app/(cabinet)/reports/page.tsx` — keep main's tabs (General Ledger, Trial Balance, export buttons) **and** the branch's aged-receivables tab alongside the existing aged-payables tab. Both sides added to the same tab list/switch — union them.
- `web/app/(cabinet)/invoices/new/page.tsx` — keep main's credit-note composer mode (doc-type toggle, `correctedInvoiceNumber` field, `/api/credit-notes` submission) **and** the branch's customer/due-date persistence (payment-terms-derived due date sent to `/api/einvoices`).
- `docs/ROADMAP-market-gaps.md` — take the branch's M4/M5 row updates and main's updates to every other row. (Task 8 does a final consistency pass; just make it coherent.)

- [ ] **Step 3: Verify the semantic auto-merge of `src/einvoice/outbound.ts`**

Open the merged file and confirm `sendInvoice` has ALL of: main's conditional VAT line (`if (invVat > 0n) invLines.push(...)`), the branch's extra args `customerPartyId?: string | null; dueDate?: string | null`, and the branch's INSERT ending in `customer_party_id, due_date, status ... 'open'` with values `args.customerPartyId ?? null, args.dueDate ?? inv.dueDate ?? null`. Confirm `sendCreditNote` (from main) is still present and unchanged.

- [ ] **Step 4: Renumber the migration before committing**

```bash
git mv migrations/032_receivables.sql migrations/037_receivables.sql
grep -rn "032_receivables" --include="*.ts" --include="*.md" src tests docs migrations || echo "no stale references"
```

Fix any references found (docs mentioning the old filename may stay historical in specs/plans under `docs/superpowers/` — only fix code/tests/README-style docs).

- [ ] **Step 5: Run gates**

```bash
docker compose up -d db && npm run migrate
npm test
npx tsc --noEmit
cd web && npx tsc --noEmit && cd ..
```

Expected: all pass. If `tests/db/migration-numbering.test.ts` fails, a rename was missed.

- [ ] **Step 6: Commit the merge**

```bash
git add -A
git commit -m "Merge m4a-ar-money-in-loop: AR money-in loop (M4 slice A), receivables migration renumbered to 037"
```

(Use a `-m` second paragraph for the session trailer.)

---

### Task 2: Merge slice A-UI (`m4a-ui-settle`)

**Files:**
- Modify (conflict resolution): `src/einvoice/query.ts`, `web/app/(cabinet)/invoices/page.tsx`, `web/app/lib/i18n.ts`

**Interfaces:**
- Consumes: Task 1's merge commit.
- Produces: `/invoices` outbox with payment-status columns + settle/void drawer over `POST /api/receivables/[id]`.

- [ ] **Step 1: Merge**

```bash
git merge --no-commit origin/m4a-ui-settle
```

Expected: 3 content conflicts (files above).

- [ ] **Step 2: Resolve as unions**

- `src/einvoice/query.ts` — main's `listEinvoices` added `doc_type`/`corrected_invoice_number` selection; the branch added `status`/`amount_paid_cents`/`due_date`. Keep both column sets in the SELECT and in the returned row type.
- `web/app/(cabinet)/invoices/page.tsx` — keep main's doc-type column (invoice vs credit note) **and** the branch's payment-status columns + settle/void drawer.
- `web/app/lib/i18n.ts` — union of keys, all three catalogs.

- [ ] **Step 3: Run gates** (same commands as Task 1 Step 5). Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "Merge m4a-ui-settle: AR settle/void drawer + payment columns (M4 slice A-UI)"
```

---

### Task 3: Merge slice B (`m4b-dunning` + jobs infra) + renumber its migrations

**Files:**
- Modify (conflict resolution): `.env.example`, `package.json`, `src/db/pool.ts`, `web/app/(cabinet)/reports/page.tsx`, `web/app/lib/i18n.ts`, `docs/ROADMAP-market-gaps.md`
- Rename: `migrations/033_dunning.sql` → `038_dunning.sql`, `034_jobs.sql` → `039_jobs.sql`, `035_dunning_jobs_backfill.sql` → `040_dunning_jobs_backfill.sql`, `036_supervisor_role.sql` → `041_supervisor_role.sql`

**Interfaces:**
- Produces (used by Tasks 4, 6, 7): `src/dunning/` (`runDunning`, policy CRUD, `reapDunning`), `src/jobs/` (`drainOnce(args: { now: Date; leaseTimeoutMs: number; limit: number })` in `worker.ts`, `reapOnce(args: { now: Date })` in `reapers.ts`, side-effect handler registration in `register.ts`), `workerPool`/`supervisorPool` + `withWorker` in `src/db/pool.ts`, routes `web/app/api/receivables/dunning/{policy,run}/route.ts`.

- [ ] **Step 1: Merge**

```bash
git merge --no-commit origin/m4b-dunning
```

Expected: 6 content conflicts (files above).

- [ ] **Step 2: Resolve — exact resolutions for the three mechanical files**

`.env.example` — keep main's block (Production/Vercel notes, GoCardless, `CRON_SECRET`) **and append** the branch's two lines:

```bash
# Worker connection — least-privilege role, claims jobs across tenants (control plane only)
WORKER_DATABASE_URL=postgres://bookkeeping_worker:worker_pw@localhost:5433/bookkeeping
# Supervisor connection — least-privilege role that runs the chain reaper sweep (control plane only)
SUPERVISOR_DATABASE_URL=postgres://bookkeeping_supervisor:supervisor_pw@localhost:5433/bookkeeping
```

`package.json` (root) — keep both scripts:

```json
    "provision-admin": "node --env-file=.env --import tsx src/dev/provision-admin.ts",
    "worker": "node --env-file=.env --import tsx src/jobs/worker.ts"
```

`src/db/pool.ts` — keep main's `poolConfig` caps and apply them to ALL four pools:

```ts
const poolConfig = { max: 5, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 };
export const adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL, ...poolConfig });
export const appPool = new Pool({ connectionString: process.env.DATABASE_URL, ...poolConfig });
export const workerPool = new Pool({ connectionString: process.env.WORKER_DATABASE_URL, ...poolConfig });
export const supervisorPool = new Pool({ connectionString: process.env.SUPERVISOR_DATABASE_URL, ...poolConfig });
```

Keep the branch's `withWorker`/`withSupervisor` helpers and main's comments intact.

- [ ] **Step 3: Resolve the remaining three as unions**

- `web/app/(cabinet)/reports/page.tsx` — the file after Task 1 has main's tabs + the AR-aging tab; the branch adds the dunning policy editor + run action **inside the AR-aging tab**. Keep all.
- `web/app/lib/i18n.ts` — union, all three catalogs (branch adds dunning keys).
- `docs/ROADMAP-market-gaps.md` — branch's M4 row notes slice B shipped; merge with the Task 1 resolution (Task 8 finalizes).

- [ ] **Step 4: Renumber the four migrations**

```bash
git mv migrations/033_dunning.sql migrations/038_dunning.sql
git mv migrations/034_jobs.sql migrations/039_jobs.sql
git mv migrations/035_dunning_jobs_backfill.sql migrations/040_dunning_jobs_backfill.sql
git mv migrations/036_supervisor_role.sql migrations/041_supervisor_role.sql
grep -rn -e "033_dunning" -e "034_jobs" -e "035_dunning" -e "036_supervisor" --include="*.ts" src tests migrations || echo "no stale references"
```

- [ ] **Step 5: Run gates** (Task 1 Step 5 commands; `npm run migrate` must apply 037–041 cleanly). The worker tests need `WORKER_DATABASE_URL`/`SUPERVISOR_DATABASE_URL` in `.env` — copy the two lines from `.env.example` into `.env` if absent. Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Merge m4b-dunning: dunning + late fees (M4 slice B) and job-queue infra; migrations renumbered to 038-041"
```

---

### Task 4: Credit-note application against receivables (migration 042 + domain hook)

Main's `sendCreditNote` (M7) credits the GL receivable but the AR open-item model doesn't know about it — a credited invoice stays "open" and dunning keeps chasing it. Fix: a referenced credit note applies against its invoice like a payment.

**Files:**
- Create: `migrations/042_credit_note_applications.sql`
- Create: `src/receivables/apply-credit-note.ts`
- Modify: `src/einvoice/outbound.ts` (hook at the end of `sendCreditNote`)
- Test: `tests/receivables/apply-credit-note.test.ts`

**Interfaces:**
- Consumes: `invoice_payments` table (Task 1), `sendCreditNote` args `{ creditNote: ECreditNote; ... }` where `ECreditNote.correctedInvoiceNumber?: string`, `postEntry` already ran and produced `entryId`, einvoice INSERT produced `einvoiceId`.
- Produces (used by Task 5): `invoice_payments.credit_note_einvoice_id uuid` column; rows with `method='credit_note'`; function `applyCreditNoteToInvoice(tx, ctx, args: { creditNoteEinvoiceId: string; correctedInvoiceNumber: string; creditNoteGrandCents: bigint; currency: string; issueDate: string; journalEntryId: string }): Promise<{ appliedCents: bigint; invoiceId: string | null }>`.

- [ ] **Step 1: Write the migration**

```sql
-- Credit-note application (M4 integration): a referenced AR credit note settles its
-- invoice like a payment. No GL posting here — sendCreditNote already reversed the
-- receivable; this records the application so open-item status and dunning agree with GL.
ALTER TABLE invoice_payments DROP CONSTRAINT invoice_payments_method_check;
ALTER TABLE invoice_payments ADD CONSTRAINT invoice_payments_method_check
  CHECK (method IN ('bank_match','manual','credit_note'));
ALTER TABLE invoice_payments ADD COLUMN credit_note_einvoice_id uuid REFERENCES einvoices(id);
-- One application per credit note.
CREATE UNIQUE INDEX invoice_payments_credit_note_uidx
  ON invoice_payments(credit_note_einvoice_id) WHERE credit_note_einvoice_id IS NOT NULL;
```

Run `npm run migrate`; if the DROP fails because the constraint name differs, find it with `SELECT conname FROM pg_constraint WHERE conrelid = 'invoice_payments'::regclass AND contype = 'c';` and use the actual name.

- [ ] **Step 2: Write the failing tests**

In `tests/receivables/apply-credit-note.test.ts` — copy the fixture setup style from the existing `tests/receivables/` files (they create a client company, party, and issue invoices via `sendInvoice` with `StubAccessPoint`). Cases:

```ts
it('a referenced credit note reduces the invoice outstanding and advances status', async () => {
  // issue invoice INV-1 grand 100.00 (open, outstanding 10000)
  // sendCreditNote { correctedInvoiceNumber: 'INV-1', grandTotal: '40.00', ... }
  // expect getReceivable(inv).amountPaidCents === '4000', status 'partially_paid'
  // expect an invoice_payments row: method 'credit_note', credit_note_einvoice_id = CN id,
  //   journal_entry_id = the CN's reversal entry, amount_cents 4000
});
it('a fully-covering referenced credit note marks the invoice paid and dunning stops chasing it', async () => {
  // invoice INV-2 grand 50.00 past due; CN for 50.00 referencing INV-2
  // expect status 'paid'; runDunning({ asOf: <past-due date> }) creates no task for INV-2
});
it('a credit note larger than the outstanding applies only the outstanding', async () => {
  // invoice 30.00, CN 100.00 → amountPaidCents 3000, status 'paid', payment row amount 3000
});
it('an unresolvable or unreferenced credit note applies nothing', async () => {
  // CN with correctedInvoiceNumber 'NOPE' and CN with no reference → no payment row, invoice untouched
});
it('a credit note in a different currency does not apply', async () => {
  // invoice EUR, CN USD referencing it → no application
});
```

Each assertion concrete — read back via `getReceivable` and a direct `SELECT` on `invoice_payments`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/receivables/apply-credit-note.test.ts`
Expected: FAIL (`applyCreditNoteToInvoice` does not exist / no application recorded).

- [ ] **Step 4: Implement `src/receivables/apply-credit-note.ts`**

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appendAudit } from '../audit/audit.js';

/**
 * Apply an issued AR credit note against the invoice it corrects (EN 16931
 * BillingReference). Settlement-like: caps at the invoice outstanding, records an
 * invoice_payments row (method 'credit_note'), advances amount_paid/status. No GL
 * posting — sendCreditNote already posted the receivable reversal (journalEntryId).
 * Unresolvable reference, currency mismatch, or non-open invoice → applies nothing.
 */
export async function applyCreditNoteToInvoice(
  tx: PoolClient, ctx: TenantContext,
  args: {
    creditNoteEinvoiceId: string; correctedInvoiceNumber: string;
    creditNoteGrandCents: bigint; currency: string; issueDate: string; journalEntryId: string;
  },
): Promise<{ appliedCents: bigint; invoiceId: string | null }> {
  const inv = await tx.query(
    `SELECT id, grand_total_cents, amount_paid_cents, invoice_number
     FROM einvoices
     WHERE client_company_id = $1 AND direction = 'outbound' AND doc_type = 'invoice'
       AND invoice_number = $2 AND currency = $3 AND status IN ('open','partially_paid')
     ORDER BY created_at DESC LIMIT 1`,
    [ctx.clientCompanyId, args.correctedInvoiceNumber, args.currency],
  );
  if (!inv.rowCount) return { appliedCents: 0n, invoiceId: null };
  const row = inv.rows[0];
  const outstanding = BigInt(row.grand_total_cents) - BigInt(row.amount_paid_cents);
  const applied = args.creditNoteGrandCents < outstanding ? args.creditNoteGrandCents : outstanding;
  if (applied <= 0n) return { appliedCents: 0n, invoiceId: null };

  await tx.query(
    `INSERT INTO invoice_payments(client_company_id, einvoice_id, amount_cents, paid_date, method, journal_entry_id, credit_note_einvoice_id)
     VALUES ($1,$2,$3,$4,'credit_note',$5,$6)`,
    [ctx.clientCompanyId, row.id, applied.toString(), args.issueDate, args.journalEntryId, args.creditNoteEinvoiceId],
  );
  const newPaid = BigInt(row.amount_paid_cents) + applied;
  const status = newPaid >= BigInt(row.grand_total_cents) ? 'paid' : 'partially_paid';
  await tx.query(
    `UPDATE einvoices SET amount_paid_cents = $1, status = $2 WHERE id = $3 AND client_company_id = $4`,
    [newPaid.toString(), status, row.id, ctx.clientCompanyId],
  );
  await appendAudit(tx, ctx, {
    action: 'apply_credit_note', entityType: 'receivable', entityId: row.id,
    before: { amountPaidCents: row.amount_paid_cents },
    after: { amountPaidCents: newPaid.toString(), status, creditNoteEinvoiceId: args.creditNoteEinvoiceId, appliedCents: applied.toString() },
  });
  return { appliedCents: applied, invoiceId: row.id };
}
```

- [ ] **Step 5: Hook it into `sendCreditNote`**

In `src/einvoice/outbound.ts`, after the einvoice INSERT + `appendAudit` in `sendCreditNote`, before the `return`:

```ts
if (cn.correctedInvoiceNumber) {
  await applyCreditNoteToInvoice(tx, ctx, {
    creditNoteEinvoiceId: einvoiceId,
    correctedInvoiceNumber: cn.correctedInvoiceNumber,
    creditNoteGrandCents: toCents(cn.grandTotal),
    currency: cn.currency,
    issueDate: cn.issueDate,
    journalEntryId: entryId,
  });
}
```

Import: `import { applyCreditNoteToInvoice } from '../receivables/apply-credit-note.js';`

- [ ] **Step 6: Run the new tests, then the full gates**

Run: `npx vitest run tests/receivables/apply-credit-note.test.ts` → PASS, then Task 1 Step 5 gate commands (full suite — pre-existing credit-note tests in `tests/einvoice/` must still pass: CNs without a reference are unaffected).

- [ ] **Step 7: Commit**

```bash
git add migrations/042_credit_note_applications.sql src/receivables/apply-credit-note.ts src/einvoice/outbound.ts tests/receivables/apply-credit-note.test.ts
git commit -m "feat(receivables): referenced credit notes apply against their invoice (migration 042)"
```

---

### Task 5: Net unapplied credit notes into AR aging

**Files:**
- Modify: `src/receivables/aging.ts`
- Test: `tests/receivables/aging-credit-notes.test.ts` (new; existing aging tests live in `tests/receivables/`)

**Interfaces:**
- Consumes: `invoice_payments.credit_note_einvoice_id` (Task 4), `arAging(tx, ctx, { asOf })` (Task 1).
- Produces: unchanged `ArAging` shape; buckets now net of unapplied credit-note remainders.

- [ ] **Step 1: Write the failing tests**

```ts
it('an unreferenced credit note nets AR aging by its issue-date age', async () => {
  // invoice 100.00 due 40 days ago → d31_60 bucket
  // unreferenced CN 20.00 issued 10 days ago → subtracts 20.00 from d1_30
  // expect: d31_60 '100.00', d1_30 '-20.00', total '80.00'
});
it('a fully applied credit note does not double-count in aging', async () => {
  // invoice 100.00; referenced CN 40.00 (applies via Task 4)
  // expect: single bucket outstanding '60.00', no separate CN line-effect, total '60.00'
});
it('an oversized credit note nets only its unapplied remainder', async () => {
  // invoice 30.00; referenced CN 100.00 → 30.00 applied, remainder 70.00 nets by CN issue date
  // expect total: 0 (invoice paid) - 70.00 = '-70.00'
});
it('AR aging total ties to the GL receivable balance', async () => {
  // invoice 100.00; manual settlement 30.00; referenced CN 20.00; unreferenced CN 10.00
  // aging total must equal the 2310 balance from trialBalance()/accountBalances (40.00)
});
```

For the GL tie, use the balance helper in `src/ledger/balances.ts` (`trialBalance` or `accountBalances` — check the export) filtered to account `2310`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/receivables/aging-credit-notes.test.ts`
Expected: FAIL (aging ignores credit notes).

- [ ] **Step 3: Extend `arAging`**

After the existing invoice-bucket loop in `src/receivables/aging.ts`, mirror `apAging`'s vendor-credit-note netting (see `src/payables/aging.ts:31-47`), but net only the **unapplied remainder** per credit note:

```ts
// Outbound credit notes net down the receivable. A referenced CN's applied portion
// already reduced its invoice's outstanding above — net only the unapplied remainder,
// aged by the CN's own issue date (mirror of apAging's vendor-credit-note netting).
const creditRes = await tx.query(
  `SELECT ($2::date - e.issue_date) AS days,
          (e.grand_total_cents - COALESCE(SUM(p.amount_cents), 0)) AS remainder
   FROM einvoices e
   LEFT JOIN invoice_payments p ON p.credit_note_einvoice_id = e.id
   WHERE e.client_company_id = $1 AND e.direction = 'outbound' AND e.doc_type = 'credit_note'
   GROUP BY e.id, e.issue_date, e.grand_total_cents
   HAVING (e.grand_total_cents - COALESCE(SUM(p.amount_cents), 0)) > 0`,
  [ctx.clientCompanyId, opts.asOf],
);
for (const r of creditRes.rows) {
  const days = Number(r.days);
  const amt = BigInt(r.remainder);
  if (days <= 0) current -= amt;
  else if (days <= 30) d1_30 -= amt;
  else if (days <= 60) d31_60 -= amt;
  else if (days <= 90) d61_90 -= amt;
  else d90plus -= amt;
}
```

- [ ] **Step 4: Run the new tests, then full gates** (Task 1 Step 5 commands). Expected: PASS; the branch's existing `arAging` tests still pass (no credit notes in their fixtures).

- [ ] **Step 5: Commit**

```bash
git add src/receivables/aging.ts tests/receivables/aging-credit-notes.test.ts
git commit -m "feat(receivables): net unapplied credit notes into AR aging (GL tie)"
```

---

### Task 6: Dedicated authz operations for settle/void and dunning

The merged routes gate on `einvoice.issue`, which includes client `owner`+`employee`. Settling receivables (posts bank receipts) and dunning are firm-side actions.

**Files:**
- Modify: `src/authz/policy.ts`
- Modify: `web/app/api/receivables/[id]/route.ts`, `web/app/api/receivables/dunning/policy/route.ts`, `web/app/api/receivables/dunning/run/route.ts`
- Test: extend the existing authz test (find it: `grep -rl "isRoleAllowed\|OPERATION_ROLES" tests/`)

**Interfaces:**
- Consumes: `Operation` union + `OPERATION_ROLES` + `isRoleAllowed` in `src/authz/policy.ts`; `assertRoleAllowed(role, op)` in `web/app/lib/authz.ts`.
- Produces: operations `'receivables.settle'`, `'dunning.write'`, `'dunning.run'`, each `['firm_admin', 'accountant']`.

- [ ] **Step 1: Write the failing test**

In the existing authz test file, add:

```ts
it('receivables settle and dunning are firm-side only', () => {
  for (const op of ['receivables.settle', 'dunning.write', 'dunning.run'] as const) {
    expect(isRoleAllowed('firm_admin', op)).toBe(true);
    expect(isRoleAllowed('accountant', op)).toBe(true);
    expect(isRoleAllowed('owner', op)).toBe(false);
    expect(isRoleAllowed('employee', op)).toBe(false);
  }
});
```

- [ ] **Step 2: Run it to verify it fails** (TS error: not in the `Operation` union). `npx vitest run <that file>`.

- [ ] **Step 3: Extend the matrix**

In `src/authz/policy.ts`, add to the `Operation` union:

```ts
  | 'receivables.settle' // settle or void an AR receivable
  | 'dunning.write' // edit the dunning policy
  | 'dunning.run' // trigger a dunning run
```

and to `OPERATION_ROLES`:

```ts
  'receivables.settle': ['firm_admin', 'accountant'],
  'dunning.write': ['firm_admin', 'accountant'],
  'dunning.run': ['firm_admin', 'accountant'],
```

- [ ] **Step 4: Switch the three routes**

- `web/app/api/receivables/[id]/route.ts` POST: `assertRoleAllowed(ctx.actorRole, 'receivables.settle')` (replaces `'einvoice.issue'`).
- `web/app/api/receivables/dunning/policy/route.ts`: mutating verb(s) (PUT/POST) → `'dunning.write'`; leave GET ungated if currently ungated (read-only, matches other report reads).
- `web/app/api/receivables/dunning/run/route.ts` POST: `'dunning.run'`.

While in these files, confirm every merged receivables/dunning route (including `web/app/api/reports/ar-aging/route.ts`) maps errors via the shared `errorToStatus` from `@/app/lib/authz` — the branches already do this; just verify none regressed in the merge.

- [ ] **Step 5: Run gates** (Task 1 Step 5 commands). Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/authz/policy.ts web/app/api/receivables tests/
git commit -m "feat(authz): firm-side operations for receivable settlement and dunning"
```

---

### Task 7: Jobs-drain cron route (Vercel) + timing-safe cron auth

The job queue drains via a standalone worker (`npm run worker`) that never runs on Vercel. Add a cron entrypoint; fix the known non-timing-safe secret compare in the bank-sync cron while here.

**Files:**
- Create: `web/app/lib/cron-auth.ts`
- Create: `web/app/api/cron/jobs-drain/route.ts`
- Modify: `web/app/api/cron/bank-sync/route.ts`, `web/vercel.json`, `docs/RUNNING.md`

**Interfaces:**
- Consumes: `drainOnce(args: { now: Date; leaseTimeoutMs: number; limit: number }): Promise<{ ran: number; failed: number }>` from `@domain/jobs/worker.js`; `reapOnce(args: { now: Date }): Promise<{ seeded: number }>` from `@domain/jobs/reapers.js`; handler registration side-effect module `@domain/jobs/register.js`.
- Produces: `GET /api/cron/jobs-drain`; `cronAuthorized(authHeader: string | null): boolean`.

- [ ] **Step 1: Write the shared auth helper** (`web/app/lib/cron-auth.ts`)

```ts
import { timingSafeEqual } from 'node:crypto';

/** Constant-time check of a cron route's Authorization header. Fail closed: no CRON_SECRET → false. */
export function cronAuthorized(authHeader: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || !authHeader) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const got = Buffer.from(authHeader);
  return got.length === expected.length && timingSafeEqual(got, expected);
}
```

- [ ] **Step 2: Write the drain route** (`web/app/api/cron/jobs-drain/route.ts`)

```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

import { NextRequest, NextResponse } from 'next/server';
import '@domain/jobs/register.js'; // side-effect: registers job handlers (dunning_run, ...)
import { drainOnce } from '@domain/jobs/worker.js';
import { reapOnce } from '@domain/jobs/reapers.js';
import { cronAuthorized } from '@/app/lib/cron-auth';

/** Vercel cron entrypoint for the job queue: reap (seed recovery jobs), then drain. */
export async function GET(req: NextRequest) {
  if (!cronAuthorized(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const now = new Date();
    const { seeded } = await reapOnce({ now });
    const { ran, failed } = await drainOnce({ now, leaseTimeoutMs: 5 * 60 * 1000, limit: 20 });
    return NextResponse.json({ seeded, ran, failed }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
```

(Constants mirror `src/jobs/worker.ts` — confirm names/values there at build time.)

- [ ] **Step 3: Fix bank-sync route + schedule both crons**

- In `web/app/api/cron/bank-sync/route.ts`: replace the inline `!secret || req.headers.get('authorization') !== ...` check with `cronAuthorized(req.headers.get('authorization'))`, and add `export const maxDuration = 300;`.
- `web/vercel.json`:

```json
{
  "crons": [
    { "path": "/api/cron/bank-sync", "schedule": "0 5 * * *" },
    { "path": "/api/cron/jobs-drain", "schedule": "0 6 * * *" }
  ]
}
```

(jobs-drain after bank-sync so the day's payments settle receivables before dunning runs.)

- [ ] **Step 4: Document the env requirement**

In `docs/RUNNING.md`, in the Vercel/Neon deploy env-var list, add `WORKER_DATABASE_URL` and `SUPERVISOR_DATABASE_URL` (roles `bookkeeping_worker`/`bookkeeping_supervisor` are created by migrations `039`/`041`; use the Neon pooled endpoint + `?sslmode=require` like `DATABASE_URL`). Note that `/api/cron/jobs-drain` fails at runtime without them, and that self-hosted deployments may run `npm run worker` instead.

- [ ] **Step 5: Run gates + build**

Task 1 Step 5 commands, plus `cd web && npm run build`. Expected: clean build (the cron route compiles; no Edge runtime complaints since `runtime = 'nodejs'`).

- [ ] **Step 6: Commit**

```bash
git add web/app/lib/cron-auth.ts web/app/api/cron web/vercel.json docs/RUNNING.md
git commit -m "feat(jobs): Vercel cron drain route for the job queue; timing-safe cron auth on both cron routes"
```

---

### Task 8: Documentation consistency pass

**Files:**
- Modify: `HANDOFF.md`, `docs/ROADMAP-market-gaps.md`, `docs/superpowers/handoffs/2026-07-14-slice-c-recurring-invoices.md`

- [ ] **Step 1: `docs/ROADMAP-market-gaps.md`**

Reconcile the M4/M5 rows into final form:
- M4 → 🔶 with: slices A (money-in loop), A-UI (settle drawer), B (dunning + late fees) shipped 2026-07-14, **merged to main 2026-07-20** together with the job-queue/worker/reaper infra (C-infra); credit notes now apply against receivables and net AR aging (integration reconciliation, migration 042). Remaining: C-recurring (recurring invoices — see the slice-C handoff doc), D (quotes→invoice, customer statements).
- M5 → ✅ shipped 2026-07-14 / merged 2026-07-20 (AR + AP aged reports on `/reports`).
- Check the "Suggested sequencing" section still reads correctly.

- [ ] **Step 2: `HANDOFF.md`**

In the progress block near the top (after the M3 entry), add an M4/M5 entry in the established style: what shipped (slices A/A-UI/B + jobs infra, the four integration reconciliations: migration renumbering to 037–042, credit-note application, AR-aging netting, firm-side authz ops, jobs-drain cron), what remains (C-recurring, slice D, per-client account-mapping debt unchanged), and that the bank-sync cron secret compare is now timing-safe (removes item 3's first cosmetic from the M3 pre-cutover list — update that list item).

- [ ] **Step 3: Slice-C handoff doc**

In `docs/superpowers/handoffs/2026-07-14-slice-c-recurring-invoices.md` (arrives via the merges — it's on the m4b/docs branches; if absent, `git checkout origin/docs/slice-c-recurring-handoff -- docs/superpowers/handoffs/2026-07-14-slice-c-recurring-invoices.md`):
- Branching note: slice C now branches off `main` (PR #2 merged).
- Migration sketch: next free number is `043` (not `034`).
- Scheduler decision: **resolved** — the durable job queue (option 2) was built (C-infra, on main under `src/jobs/`), and `GET /api/cron/jobs-drain` is the Vercel entrypoint; recurring generation becomes a `recurring_generate` job handler registered in `src/jobs/register.ts`.
- Migration numbers cited for slices A/B: now 037–041 on main.

- [ ] **Step 4: Commit**

```bash
git add HANDOFF.md docs/ROADMAP-market-gaps.md docs/superpowers/handoffs/2026-07-14-slice-c-recurring-invoices.md
git commit -m "docs: M4 integration — HANDOFF + roadmap + slice-C handoff updated (M4 partial, M5 done)"
```

---

### Task 9: Final gates + whole-branch review

- [ ] **Step 1: Full gates from a clean slate**

```bash
docker compose up -d db && npm run migrate
npm test
npx tsc --noEmit
cd web && npx tsc --noEmit && npm run build && cd ..
```

Expected: full suite green (≈390+ tests: main's 351 + the branches' + new), both typechecks clean, web build clean.

- [ ] **Step 2: Final whole-branch review**

Run the code-review pipeline at high effort over `git diff main...m4-integration` (the established final-review gate). Fix confirmed correctness findings on-branch, re-running gates after each fix; record deferred/cosmetic findings for the summary.

- [ ] **Step 3: Commit any review fixes** (one commit per finding or one batch commit, matching prior sessions' style).

---

### Task 10: Merge to main, push, PR hygiene

- [ ] **Step 1: Retarget the stacked PRs BEFORE pushing main** (so GitHub marks them merged when their commits land on their base):

```bash
gh pr edit 3 --base main
gh pr edit 4 --base main
```

- [ ] **Step 2: Merge and push**

```bash
git checkout main
git merge --no-ff m4-integration -m "Merge M4 integration: AR money-in loop, settle UI, dunning + jobs infra (slices A/A-UI/B)"
git push origin main
```

(Include the session trailer in the merge commit body.)

- [ ] **Step 3: Verify PR states and close the docs PR**

```bash
gh pr list --state all --limit 6
gh pr close 5 --comment "Handoff doc landed (updated) via the M4 integration merge — see docs/superpowers/handoffs/2026-07-14-slice-c-recurring-invoices.md on main."
```

Expected: #2, #3, #4 show MERGED (if any shows OPEN, comment-and-close it with a pointer to the merge commit — do not force anything). Leave the remote branches in place.

- [ ] **Step 4: Confirm main is green post-merge**

```bash
npm test
```

Expected: PASS. Done.
