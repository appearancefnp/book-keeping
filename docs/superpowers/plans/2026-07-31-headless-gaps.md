# Headless-Backend Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the shipped-but-unreachable recurring-invoice engine work end to end and give users a UI for it, and give accountants a path to a prepared filing's XML.

**Architecture:** Three defects sharing one shape — backend shipped, no user path. Fix the correctness hole first (approving a `recurring_invoice` proposal currently issues nothing), then layer UI over it. Two small seams (`getAccessPoint()`, `outboundInvoiceAccounts()`) exist because `src/api/handlers.ts` is shared with the mobile surface and cannot import from `web/app/lib/`. No migration.

**Tech Stack:** TypeScript, Postgres (`pg`), vitest, Next.js App Router (`web/`), zod.

**Spec:** `docs/superpowers/specs/2026-07-31-headless-gaps-design.md`

## Global Constraints

- **Ledger is append-only** (DB triggers). Corrections are reversals, never edits.
- **Money is integer cents** via `src/db/money.ts`. Never floats.
- Every domain call runs inside `withTenant(ctx, ...)`; every mutation calls `appendAudit(...)`.
- **API route pattern:** `getSessionToken()` → `resolveTenantContext(token, clientCompanyId, nowUnix())` → domain call inside `withTenant`; map errors via `errorToStatus`.
- **i18n:** every user-facing string goes in all three catalogs (EN/LV/RU) in `web/app/lib/i18n.ts`. The typed `Record<keyof typeof EN, string>` fails the build if a language misses a key. EN block starts near line 591 (`'filings.title'`), LV near 1219, RU near 1847.
- **Icons:** inline stroked SVG, `currentColor`, ~1.5px. No emoji, no icon fonts.
- **`web/` runs a Next.js version with breaking changes vs training data.** Before writing any Next.js route handler or page code, read the relevant guide under `web/node_modules/next/dist/docs/01-app/`. This is mandated by `web/AGENTS.md`.
- `pg` requires the Node runtime — every route handler keeps `export const runtime = 'nodejs'`.
- **Never run two vitest suites concurrently.** `resetDb()` drops the schema; concurrent runs against the shared database collide. Run `npm test` serially.
- Migration numbers collide historically — but this plan adds **no migration**. If you think you need one, stop and re-read the spec.

---

### Task 1: Access Point factory and shared outbound accounts

Two seams so the approve path (which lives in `src/`, shared with mobile) can issue an invoice. Also converges three duplicate definitions that exist today.

**Files:**
- Create: `src/einvoice/access-point-factory.ts`
- Create: `src/einvoice/accounts.ts`
- Create: `tests/einvoice/accounts.test.ts`
- Modify: `web/app/lib/access-point.ts` (whole file, 6 lines)
- Modify: `web/app/api/einvoices/route.ts:15-17` (the three account consts)
- Modify: `src/jobs/register.ts:23-29` (`recurringAccessPoint` + `recurringAccounts`)

**Interfaces:**
- Consumes: `AccessPoint`, `StubAccessPoint` from `src/einvoice/access-point.ts`
- Produces:
  - `getAccessPoint(): AccessPoint` — module-level singleton
  - `outboundInvoiceAccounts(): { receivable: string; sales: string; vat: string }`

- [ ] **Step 1: Write the failing test**

Create `tests/einvoice/accounts.test.ts`:

```ts
import { afterEach, expect, test } from 'vitest';
import { outboundInvoiceAccounts } from '../../src/einvoice/accounts.js';
import { getAccessPoint } from '../../src/einvoice/access-point-factory.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';

const ENV_KEYS = ['EINVOICE_RECEIVABLE_ACCOUNT', 'EINVOICE_SALES_ACCOUNT', 'EINVOICE_VAT_ACCOUNT'] as const;

afterEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });

test('outboundInvoiceAccounts falls back to the LR chart defaults', () => {
  expect(outboundInvoiceAccounts()).toEqual({ receivable: '2310', sales: '6110', vat: '5721' });
});

test('outboundInvoiceAccounts honours env overrides', () => {
  process.env.EINVOICE_RECEIVABLE_ACCOUNT = '1234';
  process.env.EINVOICE_SALES_ACCOUNT = '5678';
  process.env.EINVOICE_VAT_ACCOUNT = '9012';
  expect(outboundInvoiceAccounts()).toEqual({ receivable: '1234', sales: '5678', vat: '9012' });
});

test('getAccessPoint returns a stable singleton', () => {
  const a = getAccessPoint();
  const b = getAccessPoint();
  expect(a).toBe(b);
  expect(a).toBeInstanceOf(StubAccessPoint);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/einvoice/accounts.test.ts`
Expected: FAIL — cannot resolve `../../src/einvoice/accounts.js` / `access-point-factory.js`.

- [ ] **Step 3: Create the accounts resolver**

Create `src/einvoice/accounts.ts`:

```ts
/**
 * Outbound sales-invoice account codes: receivable / sales / output VAT.
 *
 * Read per call rather than captured at module load so tests and per-deployment env changes take
 * effect without a reload. Defaults are the LR chart codes used across the app; overriding them by
 * env is the same stopgap the bills and pay-run routes use, and does NOT resolve the per-client
 * account-mapping debt (see the M2 follow-ups in HANDOFF.md).
 */
export function outboundInvoiceAccounts(): { receivable: string; sales: string; vat: string } {
  return {
    receivable: process.env.EINVOICE_RECEIVABLE_ACCOUNT ?? '2310',
    sales: process.env.EINVOICE_SALES_ACCOUNT ?? '6110',
    vat: process.env.EINVOICE_VAT_ACCOUNT ?? '5721',
  };
}
```

- [ ] **Step 4: Create the Access Point factory**

Create `src/einvoice/access-point-factory.ts`:

```ts
import { type AccessPoint, StubAccessPoint } from './access-point.js';

// Mirrors makeBlobStore() in src/blob/factory.ts: one place that decides which implementation the
// process uses. Swap the constructor here when the real provider lands (HANDOFF.md #1) — the
// AccessPoint interface and every call site stay unchanged.
//
// Singleton rather than new-per-call: a real Access Point holds a connection and client
// certificate, so one instance per process is correct. StubAccessPoint's in-memory `sent` array is
// read only by tests, which construct their own instance directly.
let instance: AccessPoint | null = null;

export function getAccessPoint(): AccessPoint {
  if (!instance) instance = new StubAccessPoint();
  return instance;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/einvoice/accounts.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Point the web Access Point at the factory**

Replace the whole of `web/app/lib/access-point.ts`:

```ts
import { getAccessPoint } from '@domain/einvoice/access-point-factory.js';

// Single Access Point used by the einvoice routes, resolved through the shared factory so the
// web routes, the job worker, and the proposal-approval path all issue through one instance.
// Swap the implementation in src/einvoice/access-point-factory.ts when HANDOFF.md #1 lands.
export const accessPoint = getAccessPoint();
```

- [ ] **Step 7: Use the shared accounts in the einvoices route**

In `web/app/api/einvoices/route.ts`, delete these three lines (currently 15-17) and their preceding comment:

```ts
// Default LV chart-of-accounts codes; override per deployment via env.
const RECEIVABLE_ACCOUNT = process.env.EINVOICE_RECEIVABLE_ACCOUNT ?? '2310';
const SALES_ACCOUNT = process.env.EINVOICE_SALES_ACCOUNT ?? '6110';
const VAT_ACCOUNT = process.env.EINVOICE_VAT_ACCOUNT ?? '5721';
```

Add to the imports:

```ts
import { outboundInvoiceAccounts } from '@domain/einvoice/accounts.js';
```

In the `POST` body, replace the three `sendInvoice` account arguments:

```ts
      const accounts = outboundInvoiceAccounts();
      return sendInvoice(tx, ctx, {
        invoice: body.invoice!,
        recipientPeppolId: body.recipientPeppolId!,
        ap: accessPoint,
        receivableAccount: accounts.receivable,
        salesAccount: accounts.sales,
        vatAccount: accounts.vat,
        customerPartyId: body.customerPartyId ?? null,
        dueDate,
      });
```

- [ ] **Step 8: Use the shared factory + accounts in the job registry**

In `src/jobs/register.ts`, replace the block currently at lines 23-29:

```ts
// Worker-side Access Point + AR account codes for generated recurring invoices.
const recurringAccessPoint = new StubAccessPoint();
const recurringAccounts = {
  receivable: process.env.EINVOICE_RECEIVABLE_ACCOUNT ?? '2310',
  sales: process.env.EINVOICE_SALES_ACCOUNT ?? '6110',
  vat: process.env.EINVOICE_VAT_ACCOUNT ?? '5721',
};
```

with nothing — then change the `generateDueRecurring` call inside the `recurring_generate` handler to resolve both from the shared helpers:

```ts
  const { active } = await generateDueRecurring(tx, ctx, {
    templateId, now, ap: getAccessPoint(), accounts: outboundInvoiceAccounts(),
  });
```

Update the imports at the top of the file: remove `import { StubAccessPoint } from '../einvoice/access-point.js';` and add

```ts
import { getAccessPoint } from '../einvoice/access-point-factory.js';
import { outboundInvoiceAccounts } from '../einvoice/accounts.js';
```

- [ ] **Step 9: Run the full suite and both typechecks**

Run: `npm test`
Expected: PASS — no regressions. The einvoice, recurring, and jobs suites all exercise the changed call sites.

Run: `npx tsc --noEmit`
Run: `cd web && npx tsc --noEmit`
Expected: both clean.

- [ ] **Step 10: Commit**

```bash
git add src/einvoice/access-point-factory.ts src/einvoice/accounts.ts tests/einvoice/accounts.test.ts \
        web/app/lib/access-point.ts web/app/api/einvoices/route.ts src/jobs/register.ts
git commit -m "refactor(einvoice): shared Access Point factory and outbound account codes

src/api/handlers.ts is shared with the mobile surface and cannot import from
web/app/lib/, so the approval path needs a domain-side way to reach both. Also
converges the three independent StubAccessPoint instances and the two copies of
the receivable/sales/VAT env triple onto one definition each."
```

---

### Task 2: `postApprovedRecurringInvoice`

The correctness fix. Approving a `recurring_invoice` proposal must actually issue the invoice.

**Files:**
- Create: `src/recurring/post-approved.ts`
- Create: `tests/recurring/post-approved.test.ts`

**Interfaces:**
- Consumes: `outboundInvoiceAccounts()`, `getAccessPoint()` (Task 1); `getProposal` from `src/proposals/proposals.ts`; `sendInvoice` from `src/einvoice/outbound.ts`
- Produces: `postApprovedRecurringInvoice(tx: PoolClient, ctx: TenantContext, proposalId: string, opts?: { ap?: AccessPoint }): Promise<{ entryId: string }>`
  - `opts.ap` exists so tests can inject a `StubAccessPoint` they hold a reference to and assert on. Production callers omit it and get the factory singleton.

- [ ] **Step 1: Write the failing test**

Create `tests/recurring/post-approved.test.ts`:

```ts
import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod, closePeriod } from '../../src/ledger/periods.js';
import { createParty } from '../../src/parties/parties.js';
import { listProposals, getProposal } from '../../src/proposals/proposals.js';
import { approveProposal, rejectProposal } from '../../src/proposals/lifecycle.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { createTemplate } from '../../src/recurring/recurring.js';
import type { RecurringInvoicePayload } from '../../src/recurring/recurring.js';
import { generateDueRecurring } from '../../src/recurring/generate.js';
import { postApprovedRecurringInvoice } from '../../src/recurring/post-approved.js';

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

/** Tenant + accounts + open 2026-05 period + customer party. */
async function setup() {
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

/**
 * Runs a due template with NO autonomy policy set. resolveAutonomy is default-closed, so this is
 * the approval branch — the one every client gets out of the box — and yields a pending proposal.
 */
async function generatePendingProposal(t: ReturnType<typeof ctx>, customerPartyId: string) {
  const { id } = await withTenant(t, (tx) => createTemplate(tx, t, {
    customerPartyId, recipientPeppolId: '0088:test', invoicePayload: PAYLOAD,
    anchorDay: 10, intervalMonths: 1, firstRunDate: '2026-05-10',
  }));
  await withTenant(t, (tx) => generateDueRecurring(tx, t, {
    templateId: id, now: new Date('2026-05-10T09:00:00Z'), ap: new StubAccessPoint(), accounts: ACCOUNTS,
  }));
  const [proposal] = await withTenant(t, (tx) => listProposals(tx, t, { status: 'pending_approval' }));
  expect(proposal.type).toBe('recurring_invoice');
  return { templateId: id, proposalId: proposal.id };
}

test('approving a recurring invoice issues it, posts the receivable, records the message id', async () => {
  const { t, customerPartyId } = await setup();
  const { proposalId } = await generatePendingProposal(t, customerPartyId);
  const ap = new StubAccessPoint();

  const { entryId } = await withTenant(t, async (tx) => {
    await approveProposal(tx, t, proposalId);
    return postApprovedRecurringInvoice(tx, t, proposalId, { ap });
  });

  expect(entryId).toBeTruthy();
  expect(ap.sent).toHaveLength(1);
  expect(ap.sent[0].recipient).toBe('0088:test');

  const inv = await withTenant(t, (tx) => tx.query(
    `SELECT invoice_number, status, peppol_message_id, journal_entry_id, due_date::text AS due
       FROM einvoices WHERE direction = 'outbound'`));
  expect(inv.rowCount).toBe(1);
  expect(inv.rows[0].invoice_number).toMatch(/^INV-2026-05-/);
  expect(inv.rows[0].status).toBe('open');
  expect(inv.rows[0].peppol_message_id).toBe('stub-msg-1');
  expect(inv.rows[0].journal_entry_id).toBe(entryId);
  expect(inv.rows[0].due).toBe('2026-05-24'); // issue 2026-05-10 + the party's 14-day terms

  const prop = await withTenant(t, (tx) => getProposal(tx, t, proposalId));
  expect(prop.status).toBe('posted');
  expect(prop.resolvedEntryId).toBe(entryId);
});

test('rejecting a recurring invoice issues nothing', async () => {
  const { t, customerPartyId } = await setup();
  const { proposalId } = await generatePendingProposal(t, customerPartyId);

  await withTenant(t, (tx) => rejectProposal(tx, t, proposalId, 'customer cancelled'));

  const inv = await withTenant(t, (tx) => tx.query(
    `SELECT id FROM einvoices WHERE direction = 'outbound'`));
  expect(inv.rowCount).toBe(0);
});

test('posting a proposal that is not approved throws', async () => {
  const { t, customerPartyId } = await setup();
  const { proposalId } = await generatePendingProposal(t, customerPartyId);

  await expect(withTenant(t, (tx) =>
    postApprovedRecurringInvoice(tx, t, proposalId, { ap: new StubAccessPoint() }),
  )).rejects.toThrow(/must be approved/);
});

test('posting a proposal of the wrong type throws', async () => {
  const { t } = await setup();
  const { createProposal } = await import('../../src/proposals/proposals.js');
  const { id } = await withTenant(t, (tx) => createProposal(tx, t, {
    type: 'task', payload: {}, rationale: {}, status: 'pending_approval',
  }));
  await withTenant(t, (tx) => approveProposal(tx, t, id));

  await expect(withTenant(t, (tx) =>
    postApprovedRecurringInvoice(tx, t, id, { ap: new StubAccessPoint() }),
  )).rejects.toThrow(/not a recurring invoice proposal/);
});

test('a failed issue rolls the approval back, leaving the proposal retryable', async () => {
  const { t, customerPartyId } = await setup();
  const { proposalId } = await generatePendingProposal(t, customerPartyId);
  // Close the period the invoice would post into: postEntry rejects a closed period.
  await withTenant(t, (tx) => closePeriod(tx, t, { year: 2026, month: 5 }));

  await expect(withTenant(t, async (tx) => {
    await approveProposal(tx, t, proposalId);
    return postApprovedRecurringInvoice(tx, t, proposalId, { ap: new StubAccessPoint() });
  })).rejects.toThrow();

  // withTenant wraps one transaction, so the approve transition rolled back with the failure.
  const prop = await withTenant(t, (tx) => getProposal(tx, t, proposalId));
  expect(prop.status).toBe('pending_approval');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/recurring/post-approved.test.ts`
Expected: FAIL — cannot resolve `../../src/recurring/post-approved.js`.

If `closePeriod` is not exported from `src/ledger/periods.ts` under that name, check the module's exports and use the actual close function; do not change the test's intent (the period must be closed so `postEntry` throws).

- [ ] **Step 3: Write the implementation**

Create `src/recurring/post-approved.ts`:

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import type { AccessPoint } from '../einvoice/access-point.js';
import type { EInvoice } from '../einvoice/ubl.js';
import { getProposal } from '../proposals/proposals.js';
import { sendInvoice } from '../einvoice/outbound.js';
import { getAccessPoint } from '../einvoice/access-point-factory.js';
import { outboundInvoiceAccounts } from '../einvoice/accounts.js';
import { appendAudit } from '../audit/audit.js';

interface RecurringInvoiceProposalPayload {
  invoice: EInvoice;
  recipientPeppolId: string;
  customerPartyId: string | null;
  dueDate: string | null;
}

/**
 * Issue the invoice held by an approved `recurring_invoice` proposal.
 *
 * generateDueRecurring gates on autonomy: 'auto' sends inline, anything else parks the invoice in
 * a pending_approval proposal. resolveAutonomy is default-closed, so the approval branch is what a
 * client gets with no policy row — this function is that branch's terminus.
 *
 * Caller contract mirrors postApprovedPosting / postApprovedBankMatch: approveProposal runs first,
 * in the same transaction. A throw here rolls the approval back with it, leaving the proposal
 * pending_approval and retryable rather than approved-but-unissued.
 */
export async function postApprovedRecurringInvoice(
  tx: PoolClient, ctx: TenantContext, proposalId: string,
  opts: { ap?: AccessPoint } = {},
): Promise<{ entryId: string }> {
  const prop = await getProposal(tx, ctx, proposalId);
  if (prop.type !== 'recurring_invoice') {
    throw new Error(`Proposal ${proposalId} is not a recurring invoice proposal (type=${prop.type})`);
  }
  if (prop.status !== 'approved') {
    throw new Error(`Proposal ${proposalId} must be approved before issuing (status=${prop.status})`);
  }

  const payload = prop.payload as RecurringInvoiceProposalPayload;
  const accounts = outboundInvoiceAccounts();
  const { einvoiceId, entryId, messageId } = await sendInvoice(tx, ctx, {
    invoice: payload.invoice,
    recipientPeppolId: payload.recipientPeppolId,
    ap: opts.ap ?? getAccessPoint(),
    receivableAccount: accounts.receivable,
    salesAccount: accounts.sales,
    vatAccount: accounts.vat,
    customerPartyId: payload.customerPartyId ?? null,
    dueDate: payload.dueDate ?? null,
  });

  // Lifecycle fields only — core proposal fields stay immutable, same as postApprovedPosting.
  await tx.query(
    `UPDATE proposals SET status = 'posted', resolved_entry_id = $1, resolved_by = $2, resolved_at = now()
     WHERE id = $3 AND client_company_id = $4`,
    [entryId, ctx.actorId, proposalId, ctx.clientCompanyId],
  );

  await appendAudit(tx, ctx, {
    action: 'posted', entityType: 'proposal', entityId: proposalId,
    before: { status: 'approved' }, after: { status: 'posted', entryId, einvoiceId, messageId },
  });
  return { entryId };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/recurring/post-approved.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/recurring/post-approved.ts tests/recurring/post-approved.test.ts
git commit -m "feat(recurring): postApprovedRecurringInvoice issues an approved recurring invoice

generateDueRecurring parks non-auto occurrences in a recurring_invoice proposal,
but nothing ever issued them. resolveAutonomy is default-closed, so that was the
default path: approve, and no receivable posted and nothing reached the Access
Point. A throw rolls the approval back so the proposal stays retryable."
```

---

### Task 3: Dispatch `recurring_invoice` in the approve handler

Wires Task 2 into the shared approve handler used by both the web and mobile surfaces.

**Files:**
- Modify: `src/api/handlers.ts:6-9` (imports) and `:50-55` (the dispatch block)
- Modify: `tests/api/handlers.test.ts` (add one test)

**Interfaces:**
- Consumes: `postApprovedRecurringInvoice` (Task 2)
- Produces: `approveHandler` returns `{ entryId }` for `recurring_invoice` proposals instead of `{ entryId: null }`

- [ ] **Step 1: Write the failing test**

Read `tests/api/handlers.test.ts` first to reuse its existing setup helper (it builds a firm, client, user, session token, accounts, and open period). Append a test in that file's style:

```ts
test('approving a recurring_invoice proposal issues the invoice', async () => {
  const { token, clientCompanyId, t } = await setup();

  // Park an invoice in a pending_approval recurring_invoice proposal, the same shape
  // generateDueRecurring writes when autonomy is not 'auto'.
  const { createProposal } = await import('../../src/proposals/proposals.js');
  const invoice = {
    invoiceNumber: 'INV-2026-05-abcdef12', issueDate: '2026-05-10', currency: 'EUR',
    supplier: { name: 'SIA Pārdevējs', regNo: '40100000000', vatNo: 'LV40100000000' },
    customer: { name: 'SIA Klients', regNo: '40200000000', vatNo: 'LV40200000000' },
    lines: [{ description: 'Abonēšana', net: '100.00', vatRate: 21, vat: '21.00' }],
    netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
  };
  const { id } = await withTenant(t, (tx) => createProposal(tx, t, {
    type: 'recurring_invoice',
    payload: { invoice, recipientPeppolId: '0088:test', customerPartyId: null, dueDate: null },
    rationale: { computation: 'recurring invoice for 2026-05' },
    status: 'pending_approval',
  }));

  const res = await approveHandler({
    token, clientCompanyId, params: { id }, atUnixSeconds: NOW,
  });

  expect(res.status).toBe(200);
  expect((res.body as { entryId: string | null }).entryId).toBeTruthy();

  const inv = await withTenant(t, (tx) => tx.query(
    `SELECT invoice_number FROM einvoices WHERE direction = 'outbound'`));
  expect(inv.rows[0].invoice_number).toBe('INV-2026-05-abcdef12');
});
```

Adapt the names of the setup helper's return values and the `NOW` constant to whatever that file already uses — do not introduce a second setup helper. The test needs accounts `2310`/`6110`/`5721` and an open 2026-05 period; if the file's helper does not create them, create them inside this test via `createAccount` / `openPeriod` before calling `approveHandler`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/handlers.test.ts`
Expected: FAIL — `entryId` is `null` and no einvoice row exists, because the dispatch falls through.

- [ ] **Step 3: Add the dispatch**

In `src/api/handlers.ts`, add to the imports beside the other two post functions:

```ts
import { postApprovedRecurringInvoice } from '../recurring/post-approved.js';
```

Then in `approveHandler`, replace the dispatch block:

```ts
      // Dispatch to the correct post function by type.
      if (prop.type === 'posting') return postApprovedPosting(tx, ctx, id);
      if (prop.type === 'bank_match') return postApprovedBankMatch(tx, ctx, id);
      return { entryId: null }; // declaration/task: approval only, no ledger post here
```

with:

```ts
      // Dispatch to the correct post function by type.
      if (prop.type === 'posting') return postApprovedPosting(tx, ctx, id);
      if (prop.type === 'bank_match') return postApprovedBankMatch(tx, ctx, id);
      if (prop.type === 'recurring_invoice') return postApprovedRecurringInvoice(tx, ctx, id);
      // declaration / ecsl / task terminate at approval by design: a filing must never
      // auto-submit (HANDOFF.md M9 known-debt 1), and a task has no ledger effect.
      return { entryId: null };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/api/handlers.test.ts`
Expected: PASS — the whole file, including the pre-existing tests.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/api/handlers.ts tests/api/handlers.test.ts
git commit -m "fix(api): issue recurring invoices on approval instead of dropping them

approveHandler dispatched only posting and bank_match; a recurring_invoice
proposal fell through to { entryId: null }, so approving it posted no receivable
and sent nothing. advanceSchedule had already committed, so the occurrence was
lost silently. Also corrects the fallthrough comment, which named declaration and
task but not ecsl or recurring_invoice."
```

---

### Task 4: Recurring templates tab on `/invoices`

**Files:**
- Modify: `web/app/(cabinet)/invoices/page.tsx` (add tablist + templates table)
- Modify: `web/app/(cabinet)/invoices/page.module.css` (tab styles)
- Modify: `web/app/lib/i18n.ts` (EN ~line 591 region, LV ~1219, RU ~1847)

**Interfaces:**
- Consumes: `GET /api/recurring?clientCompanyId=…` → `{ templates: RecurringTemplateRow[] }`; `DELETE /api/recurring/[id]?clientCompanyId=…` → `{ ok: true }`
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Read the Next.js docs and the tab pattern**

Read `web/node_modules/next/dist/docs/01-app/` for current client-component and routing conventions before editing.

Read the `role="tablist"` markup in `web/app/(cabinet)/filings/page.tsx` (search for `role="tablist"`) and its `styles.tab` / `styles.tabActive` classes in `filings/page.module.css`. Copy that pattern rather than inventing one.

- [ ] **Step 2: Add the i18n keys**

Add to the EN catalog in `web/app/lib/i18n.ts`, next to the existing `einv.*` keys:

```ts
  'einv.tab.outbox': 'Outbox',
  'einv.tab.recurring': 'Recurring',
  'einv.rec.customer': 'Customer',
  'einv.rec.cadence': 'Cadence',
  'einv.rec.nextRun': 'Next invoice',
  'einv.rec.state': 'State',
  'einv.rec.active': 'Active',
  'einv.rec.paused': 'Paused',
  'einv.rec.pause': 'Pause',
  'einv.rec.pauseConfirm': 'Pause this template? No further invoices will be generated.',
  'einv.rec.monthly': 'Monthly on day {day}',
  'einv.rec.everyNMonths': 'Every {n} months on day {day}',
  'einv.rec.ends': 'Ends {date}',
  'einv.rec.endsAfter': '{n} invoice(s) left',
  'einv.rec.empty': 'No recurring invoices yet',
  'einv.rec.emptyDetail': 'Create one from the invoice composer by switching the document type to Recurring.',
  'einv.rec.new': 'New recurring invoice',
```

Add the same keys with Latvian values to the LV catalog and Russian values to the RU catalog. The typed `Record<keyof typeof EN, string>` fails the build if any key is missing from a language — run `cd web && npx tsc --noEmit` to confirm.

Latvian values:

```ts
  'einv.tab.outbox': 'Izejošie',
  'einv.tab.recurring': 'Regulārie',
  'einv.rec.customer': 'Klients',
  'einv.rec.cadence': 'Biežums',
  'einv.rec.nextRun': 'Nākamais rēķins',
  'einv.rec.state': 'Statuss',
  'einv.rec.active': 'Aktīvs',
  'einv.rec.paused': 'Apturēts',
  'einv.rec.pause': 'Apturēt',
  'einv.rec.pauseConfirm': 'Apturēt šo veidni? Jauni rēķini vairs netiks veidoti.',
  'einv.rec.monthly': 'Katru mēnesi {day}. datumā',
  'einv.rec.everyNMonths': 'Reizi {n} mēnešos {day}. datumā',
  'einv.rec.ends': 'Beidzas {date}',
  'einv.rec.endsAfter': 'Atlikuši {n} rēķini',
  'einv.rec.empty': 'Nav neviena regulārā rēķina',
  'einv.rec.emptyDetail': 'Izveidojiet to rēķinu sagatavē, nomainot dokumenta veidu uz “Regulārs”.',
  'einv.rec.new': 'Jauns regulārais rēķins',
```

Russian values:

```ts
  'einv.tab.outbox': 'Исходящие',
  'einv.tab.recurring': 'Регулярные',
  'einv.rec.customer': 'Клиент',
  'einv.rec.cadence': 'Периодичность',
  'einv.rec.nextRun': 'Следующий счёт',
  'einv.rec.state': 'Статус',
  'einv.rec.active': 'Активен',
  'einv.rec.paused': 'Приостановлен',
  'einv.rec.pause': 'Приостановить',
  'einv.rec.pauseConfirm': 'Приостановить этот шаблон? Новые счета создаваться не будут.',
  'einv.rec.monthly': 'Ежемесячно {day}-го числа',
  'einv.rec.everyNMonths': 'Раз в {n} мес. {day}-го числа',
  'einv.rec.ends': 'Заканчивается {date}',
  'einv.rec.endsAfter': 'Осталось счетов: {n}',
  'einv.rec.empty': 'Регулярных счетов пока нет',
  'einv.rec.emptyDetail': 'Создайте его в форме счёта, переключив тип документа на «Регулярный».',
  'einv.rec.new': 'Новый регулярный счёт',
```

- [ ] **Step 3: Add the tab state and the templates fetch**

In `web/app/(cabinet)/invoices/page.tsx`, inside `InvoicesInner`, add the row type and state next to the existing `rows` state:

```ts
interface RecurringRow {
  id: string; customerPartyId: string; recipientPeppolId: string;
  anchorDay: number; intervalMonths: number; nextRunDate: string;
  paymentTermsDays: number | null; endDate: string | null;
  occurrencesRemaining: number | null; active: boolean;
  invoicePayload: { customer: { name: string }; grandTotal: string; currency: string };
}
```

```ts
  const [tab, setTab] = useState<'outbox' | 'recurring'>('outbox');
  const [templates, setTemplates] = useState<RecurringRow[] | null>(null);
  const [recError, setRecError] = useState<string | null>(null);

  const loadTemplates = useCallback(async (id: string) => {
    setRecError(null);
    try {
      const res = await fetch(`/api/recurring?clientCompanyId=${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { templates: RecurringRow[] };
      setTemplates(body.templates);
    } catch (err) {
      setRecError((err as Error).message ?? t('state.error'));
    }
  }, [t]);

  useEffect(() => {
    if (clientCompanyId && tab === 'recurring' && templates === null) loadTemplates(clientCompanyId);
  }, [clientCompanyId, tab, templates, loadTemplates]);

  const pauseTemplate = async (id: string) => {
    if (!clientCompanyId) return;
    if (!confirm(t('einv.rec.pauseConfirm'))) return;
    setRecError(null);
    try {
      const res = await fetch(`/api/recurring/${id}?clientCompanyId=${encodeURIComponent(clientCompanyId)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setTemplates(null); // force a refetch through the effect above
    } catch (err) {
      setRecError((err as Error).message ?? t('state.error'));
    }
  };

  const cadenceLabel = (r: RecurringRow) =>
    r.intervalMonths === 1
      ? t('einv.rec.monthly').replace('{day}', String(r.anchorDay))
      : t('einv.rec.everyNMonths').replace('{n}', String(r.intervalMonths)).replace('{day}', String(r.anchorDay));
```

- [ ] **Step 4: Add the tablist and the templates table to the JSX**

Insert the tablist directly under the `<h1>` heading (currently line 126), and wrap the existing outbox markup so it only renders on the outbox tab:

```tsx
        <div className={styles.tabs} role="tablist">
          <button role="tab" aria-selected={tab === 'outbox'}
                  className={tab === 'outbox' ? styles.tabActive : styles.tab}
                  onClick={() => setTab('outbox')}>
            {t('einv.tab.outbox')}
          </button>
          <button role="tab" aria-selected={tab === 'recurring'}
                  className={tab === 'recurring' ? styles.tabActive : styles.tab}
                  onClick={() => setTab('recurring')}>
            {t('einv.tab.recurring')}
          </button>
        </div>
```

Then add the recurring panel after the existing outbox block:

```tsx
        {tab === 'recurring' && (
          <>
            {recError && <ErrorState message={recError} />}
            {!recError && templates === null && <SkeletonCard />}
            {!recError && templates?.length === 0 && (
              <EmptyState message={t('einv.rec.empty')} detail={t('einv.rec.emptyDetail')} />
            )}
            {!recError && templates && templates.length > 0 && (
              <div className={styles.tableWrapper}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">{t('einv.rec.customer')}</th>
                      <th scope="col">{t('einv.rec.cadence')}</th>
                      <th scope="col">{t('einv.rec.nextRun')}</th>
                      <th scope="col" className={styles.amount}>{t('reports.col.amount')}</th>
                      <th scope="col">{t('einv.rec.state')}</th>
                      <th scope="col"><span className="sr-only">{t('einv.rec.pause')}</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {templates.map((r) => (
                      <tr key={r.id}>
                        <td>{r.invoicePayload.customer.name}</td>
                        <td>{cadenceLabel(r)}</td>
                        <td>{r.active ? fmtDate(r.nextRunDate) : '—'}</td>
                        <td className={styles.amount}>{r.invoicePayload.grandTotal} {r.invoicePayload.currency}</td>
                        <td>{t(r.active ? 'einv.rec.active' : 'einv.rec.paused')}</td>
                        <td>
                          {r.active && (
                            <button type="button" onClick={() => pauseTemplate(r.id)}>
                              {t('einv.rec.pause')}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
```

If the file has no `fmtDate` helper, add one matching the pattern in `filings/page.tsx`:

```ts
  const fmtDate = (iso: string) =>
    new Intl.DateTimeFormat(LOCALE_FOR[lang], { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
```

If `sr-only` is not an existing global class in this codebase, drop that `<span>` and leave the header cell empty instead — do not invent a new utility class.

- [ ] **Step 5: Add the tab styles**

Copy the `.tabs`, `.tab`, and `.tabActive` rules from `web/app/(cabinet)/filings/page.module.css` into `web/app/(cabinet)/invoices/page.module.css` verbatim, so the two pages look identical.

- [ ] **Step 6: Typecheck and build**

Run: `cd web && npx tsc --noEmit`
Expected: clean. A missing i18n key in LV or RU fails here — that is the intended guard.

Run: `cd web && npm run build`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add "web/app/(cabinet)/invoices/page.tsx" "web/app/(cabinet)/invoices/page.module.css" web/app/lib/i18n.ts
git commit -m "feat(web): recurring-invoice templates tab on /invoices

The templates backend, its API routes, and its job handler all shipped with no
page behind them. Adds the tablist pattern already used on /reports and /filings,
with the existing outbox as the default tab."
```

---

### Task 5: Recurring mode in the invoice composer

**Files:**
- Modify: `web/app/(cabinet)/invoices/new/page.tsx` (`docType` union at line 48, the select at 210-214, the submit path at 151-161, the disabled-guard at 125)
- Modify: `web/app/lib/i18n.ts` (three catalogs)

**Interfaces:**
- Consumes: `POST /api/recurring` with body `{ clientCompanyId, template: { customerPartyId, recipientPeppolId, invoicePayload, anchorDay, intervalMonths, firstRunDate, paymentTermsDays?, endDate?, occurrencesRemaining? } }` → `201 { id }`
- `invoicePayload` is the `EInvoice` shape **minus** `invoiceNumber`, `issueDate`, and `dueDate` — i.e. `{ currency, supplier, customer, lines, netTotal, vatTotal, grandTotal, note?, paymentTerms? }`.

- [ ] **Step 1: Add the i18n keys**

Add to the EN catalog beside the existing `einv.mode.*` keys:

```ts
  'einv.mode.recurring': 'Recurring',
  'einv.rec.anchorDay': 'Day of month',
  'einv.rec.intervalMonths': 'Every N months',
  'einv.rec.firstRunDate': 'First invoice date',
  'einv.rec.paymentTermsDays': 'Payment terms (days)',
  'einv.rec.endDate': 'End date (optional)',
  'einv.rec.occurrences': 'Number of invoices (optional)',
  'einv.rec.create': 'Create template',
  'einv.rec.created': 'Recurring invoice template created',
  'einv.rec.autoNote': 'Invoices from this template will be issued automatically.',
  'einv.rec.approvalNote': 'Invoices from this template will be held in the approval queue.',
```

LV:

```ts
  'einv.mode.recurring': 'Regulārs',
  'einv.rec.anchorDay': 'Mēneša diena',
  'einv.rec.intervalMonths': 'Reizi N mēnešos',
  'einv.rec.firstRunDate': 'Pirmā rēķina datums',
  'einv.rec.paymentTermsDays': 'Apmaksas termiņš (dienas)',
  'einv.rec.endDate': 'Beigu datums (neobligāts)',
  'einv.rec.occurrences': 'Rēķinu skaits (neobligāts)',
  'einv.rec.create': 'Izveidot veidni',
  'einv.rec.created': 'Regulārā rēķina veidne izveidota',
  'einv.rec.autoNote': 'Rēķini pēc šīs veidnes tiks izrakstīti automātiski.',
  'einv.rec.approvalNote': 'Rēķini pēc šīs veidnes nonāks apstiprināšanas rindā.',
```

RU:

```ts
  'einv.mode.recurring': 'Регулярный',
  'einv.rec.anchorDay': 'День месяца',
  'einv.rec.intervalMonths': 'Раз в N месяцев',
  'einv.rec.firstRunDate': 'Дата первого счёта',
  'einv.rec.paymentTermsDays': 'Срок оплаты (дней)',
  'einv.rec.endDate': 'Дата окончания (необязательно)',
  'einv.rec.occurrences': 'Количество счетов (необязательно)',
  'einv.rec.create': 'Создать шаблон',
  'einv.rec.created': 'Шаблон регулярного счёта создан',
  'einv.rec.autoNote': 'Счета по этому шаблону будут выставляться автоматически.',
  'einv.rec.approvalNote': 'Счета по этому шаблону попадут в очередь на утверждение.',
```

- [ ] **Step 2: Widen the docType union and add cadence state**

At line 48, change:

```ts
const [docType, setDocType] = useState<'invoice' | 'credit_note'>('invoice');
```

to:

```ts
const [docType, setDocType] = useState<'invoice' | 'credit_note' | 'recurring'>('invoice');
```

Add cadence state beside it:

```ts
  const [anchorDay, setAnchorDay] = useState('1');
  const [intervalMonths, setIntervalMonths] = useState('1');
  const [firstRunDate, setFirstRunDate] = useState('');
  const [recTermsDays, setRecTermsDays] = useState('');
  const [recEndDate, setRecEndDate] = useState('');
  const [recOccurrences, setRecOccurrences] = useState('');
```

- [ ] **Step 3: Add the third option to the document-type select**

At lines 211-214, add the option:

```tsx
                <option value="recurring">{t('einv.mode.recurring')}</option>
```

- [ ] **Step 4: Hide the per-document fields and show cadence fields in recurring mode**

A template carries no invoice number and no issue date — those are computed per occurrence by `buildRecurringInvoiceNumber` and the schedule. Wrap the invoice-number and issue-date inputs so they render only when `docType !== 'recurring'`, and add the cadence block that renders only when `docType === 'recurring'`:

```tsx
        {docType === 'recurring' && (
          <>
            <label>
              <span>{t('einv.rec.firstRunDate')}</span>
              <input type="date" value={firstRunDate} required
                     onChange={(e) => setFirstRunDate(e.target.value)} />
            </label>
            <label>
              <span>{t('einv.rec.anchorDay')}</span>
              <input type="number" inputMode="numeric" min={1} max={31} value={anchorDay} required
                     onChange={(e) => setAnchorDay(e.target.value)} />
            </label>
            <label>
              <span>{t('einv.rec.intervalMonths')}</span>
              <input type="number" inputMode="numeric" min={1} value={intervalMonths} required
                     onChange={(e) => setIntervalMonths(e.target.value)} />
            </label>
            <label>
              <span>{t('einv.rec.paymentTermsDays')}</span>
              <input type="number" inputMode="numeric" min={0} max={365} value={recTermsDays}
                     onChange={(e) => setRecTermsDays(e.target.value)} />
            </label>
            <label>
              <span>{t('einv.rec.endDate')}</span>
              <input type="date" value={recEndDate} onChange={(e) => setRecEndDate(e.target.value)} />
            </label>
            <label>
              <span>{t('einv.rec.occurrences')}</span>
              <input type="number" inputMode="numeric" min={1} value={recOccurrences}
                     onChange={(e) => setRecOccurrences(e.target.value)} />
            </label>
            {/* resolveAutonomy is default-closed, so with no autonomy policy set these queue for
                approval. Stating it here means the accountant is not surprised by queue items. */}
            <p>{t(autonomyMode === 'auto' ? 'einv.rec.autoNote' : 'einv.rec.approvalNote')}</p>
          </>
        )}
```

For `autonomyMode`, fetch the client's policy once via the existing autonomy route (`GET /api/autonomy?clientCompanyId=…`, which returns `{ policies: AutonomyPolicyRow[] }`) and derive:

```ts
  const [autonomyMode, setAutonomyMode] = useState<'auto' | 'approval'>('approval');

  useEffect(() => {
    if (!clientCompanyId) return;
    fetch(`/api/autonomy?clientCompanyId=${encodeURIComponent(clientCompanyId)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { policies?: { operationType: string; mode: 'auto' | 'approval' }[] } | null) => {
        const p = b?.policies?.find((x) => x.operationType === 'recurring_invoice');
        setAutonomyMode(p?.mode === 'auto' ? 'auto' : 'approval'); // default-closed
      })
      .catch(() => setAutonomyMode('approval'));
  }, [clientCompanyId]);
```

`web/app/api/autonomy/route.ts:22` returns `{ policies }` and `listAutonomyPolicies` yields `{ operationType, mode, materialThresholdCents }[]`, so the destructuring above is correct as written.

- [ ] **Step 5: Branch the submit path**

The existing submit builds an `invoice` object and POSTs to `/api/einvoices` or `/api/credit-notes` (lines 151-161). Add a third branch that strips the per-document fields and POSTs the template:

```ts
    if (docType === 'recurring') {
      const { invoiceNumber: _n, issueDate: _d, dueDate: _due, ...invoicePayload } = invoice;
      const res = await fetch('/api/recurring', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientCompanyId,
          template: {
            customerPartyId: customer.id,
            recipientPeppolId: peppolId.trim(),
            invoicePayload,
            anchorDay: Number(anchorDay),
            intervalMonths: Number(intervalMonths),
            firstRunDate,
            ...(recTermsDays !== '' ? { paymentTermsDays: Number(recTermsDays) } : {}),
            ...(recEndDate !== '' ? { endDate: recEndDate } : {}),
            ...(recOccurrences !== '' ? { occurrencesRemaining: Number(recOccurrences) } : {}),
          },
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      router.push(`/invoices?client=${encodeURIComponent(clientCompanyId)}`);
      return;
    }
```

Adapt the variable names (`customer`, `peppolId`, `invoice`, `router`) to whatever the file already uses — read the existing submit handler first and match it.

- [ ] **Step 6: Relax the submit guard for recurring mode**

The guard at line 125 requires `invoiceNumber`, which a template does not have. Change it so that in recurring mode it requires `firstRunDate` instead:

```ts
    !!clientCompanyId && !!company && !!customer && !!peppolId.trim() &&
    (docType === 'recurring' ? !!firstRunDate : !!invoiceNumber.trim())
```

Keep every other condition in the existing expression untouched — read it in full before editing.

- [ ] **Step 7: Typecheck and build**

Run: `cd web && npx tsc --noEmit`
Run: `cd web && npm run build`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add "web/app/(cabinet)/invoices/new/page.tsx" web/app/lib/i18n.ts
git commit -m "feat(web): recurring mode in the invoice composer

Third docType alongside invoice and credit note. Reuses the customer picker,
Peppol-ID derivation, line editor, and VAT auto-compute unchanged; swaps the
invoice number and issue date for cadence fields and POSTs /api/recurring.
Surfaces the autonomy consequence, which is default-closed and otherwise
invisible until invoices start appearing in the approval queue."
```

---

### Task 6: Look up the filing proposal for a period

`/filings` currently holds `body.proposalId` in ephemeral React state, so a reload forgets that a filing was prepared. The page needs a lookup keyed by the period it is already displaying.

**Files:**
- Create: `src/tax/filing-lookup.ts`
- Create: `tests/tax/filing-lookup.test.ts`
- Modify: `web/app/api/filings/vat-return/route.ts` (GET response)
- Modify: `web/app/api/filings/ecsl/route.ts` (GET response)

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `findFilingProposal(tx, ctx, args: { type: 'declaration' | 'ecsl'; fromDate: string; toDate: string }): Promise<{ id: string; status: string } | null>`
- Both filing GET routes gain a `filing: { id, status } | null` key in their JSON response.

Both proposal creators store the period on the rationale: `createVatDeclarationProposal` writes `sourceRefs: { period: declaration.period, rule }` and `createEcslProposal` writes `sourceRefs: { period: list.period, rows, issues }`, where `period` is `{ fromDate, toDate }`. The lookup keys off that.

- [ ] **Step 1: Write the failing test**

Create `tests/tax/filing-lookup.test.ts`:

```ts
import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createProposal } from '../../src/proposals/proposals.js';
import { approveProposal } from '../../src/proposals/lifecycle.js';
import { findFilingProposal } from '../../src/tax/filing-lookup.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

const PERIOD = { fromDate: '2026-03-01', toDate: '2026-03-31' };

async function makeFiling(t: ReturnType<typeof ctx>, type: 'declaration' | 'ecsl', period = PERIOD) {
  return withTenant(t, (tx) => createProposal(tx, t, {
    type, payload: {}, status: 'pending_approval',
    rationale: { computation: 'x', sourceRefs: { period }, xml: '<Doc/>' },
  }));
}

test('finds a prepared filing for its period and type', async () => {
  const t = ctx(await makeFirmAndClient());
  const { id } = await makeFiling(t, 'declaration');

  const found = await withTenant(t, (tx) => findFilingProposal(tx, t, { type: 'declaration', ...PERIOD }));
  expect(found).toEqual({ id, status: 'pending_approval' });
});

test('reflects the approved status', async () => {
  const t = ctx(await makeFirmAndClient());
  const { id } = await makeFiling(t, 'ecsl');
  await withTenant(t, (tx) => approveProposal(tx, t, id));

  const found = await withTenant(t, (tx) => findFilingProposal(tx, t, { type: 'ecsl', ...PERIOD }));
  expect(found?.status).toBe('approved');
});

test('does not confuse the two filing types or other periods', async () => {
  const t = ctx(await makeFirmAndClient());
  await makeFiling(t, 'declaration');

  expect(await withTenant(t, (tx) => findFilingProposal(tx, t, { type: 'ecsl', ...PERIOD }))).toBeNull();
  expect(await withTenant(t, (tx) => findFilingProposal(tx, t, {
    type: 'declaration', fromDate: '2026-04-01', toDate: '2026-04-30',
  }))).toBeNull();
});

test('returns the newest filing when a period was prepared twice', async () => {
  const t = ctx(await makeFirmAndClient());
  await makeFiling(t, 'declaration');
  const { id: second } = await makeFiling(t, 'declaration');

  const found = await withTenant(t, (tx) => findFilingProposal(tx, t, { type: 'declaration', ...PERIOD }));
  expect(found?.id).toBe(second);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tax/filing-lookup.test.ts`
Expected: FAIL — cannot resolve `../../src/tax/filing-lookup.js`.

- [ ] **Step 3: Write the implementation**

Create `src/tax/filing-lookup.ts`:

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

/**
 * The prepared filing for a period, or null if none was prepared.
 *
 * Both filing proposal creators (createVatDeclarationProposal, createEcslProposal) record the
 * period on rationale.sourceRefs.period as { fromDate, toDate }; this reads it back so /filings can
 * show prepared/approved state across a page reload instead of relying on the POST response it
 * happens to still hold in memory.
 *
 * Newest wins: preparing the same period twice is allowed (nothing constrains it), and the latest
 * attempt is the one an accountant means. Ordered by created_at then id so the result is
 * deterministic when two rows share a timestamp.
 */
export async function findFilingProposal(
  tx: PoolClient, ctx: TenantContext,
  args: { type: 'declaration' | 'ecsl'; fromDate: string; toDate: string },
): Promise<{ id: string; status: string } | null> {
  const res = await tx.query(
    `SELECT id, status FROM proposals
      WHERE client_company_id = $1
        AND type = $2
        AND rationale -> 'sourceRefs' -> 'period' ->> 'fromDate' = $3
        AND rationale -> 'sourceRefs' -> 'period' ->> 'toDate' = $4
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [ctx.clientCompanyId, args.type, args.fromDate, args.toDate],
  );
  return res.rowCount ? { id: res.rows[0].id, status: res.rows[0].status } : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tax/filing-lookup.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Return the filing from both GET routes**

In `web/app/api/filings/vat-return/route.ts`, import the lookup:

```ts
import { findFilingProposal } from '@domain/tax/filing-lookup.js';
```

and extend the `GET` handler's `withTenant` block to fetch it alongside the declaration, returning it in the response:

```ts
    const { period, declaration, filing } = await withTenant(ctx, async (tx) => {
      const period = await resolvePeriod(tx, ctx, label);
      const declaration = await assembleVatDeclaration(tx, ctx, {
        fromDate: period.fromDate, toDate: period.toDate, config: VAT_CONFIG,
      });
      const filing = await findFilingProposal(tx, ctx, {
        type: 'declaration', fromDate: period.fromDate, toDate: period.toDate,
      });
      return { period, declaration, filing };
    });
    return NextResponse.json({ period, declaration, filing }, { status: 200 });
```

Make the equivalent change in `web/app/api/filings/ecsl/route.ts`, passing `type: 'ecsl'` and keeping that route's existing response keys intact — read the file first and add `filing` beside what it already returns.

- [ ] **Step 6: Run the suite and typechecks**

Run: `npm test`
Run: `cd web && npx tsc --noEmit`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add src/tax/filing-lookup.ts tests/tax/filing-lookup.test.ts \
        web/app/api/filings/vat-return/route.ts web/app/api/filings/ecsl/route.ts
git commit -m "feat(tax): look up the prepared filing for a period

/filings held the prepared proposal id only in React state, so a reload forgot a
filing had ever been prepared. Reads it back from rationale.sourceRefs.period,
which both filing proposal creators already record."
```

---

### Task 7: Filing XML download route

**Files:**
- Create: `web/app/api/filings/[id]/route.ts`

**Interfaces:**
- Consumes: `getProposal` from `src/proposals/proposals.ts`
- Produces:
  - `GET /api/filings/<proposalId>?clientCompanyId=…` → `200 { id, type, status, xml }`
  - `GET /api/filings/<proposalId>?clientCompanyId=…&download=1` → `200` with `Content-Type: application/xml` and `Content-Disposition: attachment; filename="…"`

- [ ] **Step 1: Read the Next.js route-handler docs**

Read `web/node_modules/next/dist/docs/01-app/` for the current route-handler and dynamic-segment conventions (`params` is a Promise in this version — see the existing `web/app/api/recurring/[id]/route.ts`). Do not write this from memory.

- [ ] **Step 2: Write the route**

Create `web/app/api/filings/[id]/route.ts`:

```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { getProposal } from '@domain/proposals/proposals.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { errorToStatus } from '@/app/lib/authz';

// A filing's generated XML lives on the proposal rationale (createVatDeclarationProposal /
// createEcslProposal both set it), not on the payload.
interface FilingRationale { xml?: string }

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const { id } = await context.params;

  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const prop = await withTenant(ctx, (tx) => getProposal(tx, ctx, id));
    if (prop.type !== 'declaration' && prop.type !== 'ecsl') {
      return NextResponse.json({ error: 'not a filing proposal' }, { status: 400 });
    }
    const xml = (prop.rationale as FilingRationale).xml ?? null;

    if (req.nextUrl.searchParams.get('download') === '1') {
      if (!xml) return NextResponse.json({ error: 'filing has no XML' }, { status: 404 });
      const name = prop.type === 'ecsl' ? 'pvn2' : 'pvn-declaration';
      return new NextResponse(xml, {
        status: 200,
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          'Content-Disposition': `attachment; filename="${name}-${id.slice(0, 8)}.xml"`,
        },
      });
    }

    return NextResponse.json({ id: prop.id, type: prop.type, status: prop.status, xml }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
```

Note there is no `assertRoleAllowed` call: this is a read of a proposal the caller's tenant context already scopes, matching the other filing GET routes, which are also ungated (only the POST prepare path calls `filings.prepare`).

- [ ] **Step 3: Typecheck and build**

Run: `cd web && npx tsc --noEmit`
Run: `cd web && npm run build`
Expected: both clean.

- [ ] **Step 4: Verify by hand against a seeded database**

Run: `npm run seed` (WIPES the DB; prints logins and a fresh TOTP code)
Run: `cd web && npm run dev`

Sign in, open `/filings`, click "Prepare for approval", then find the proposal id in the network response and request
`/api/filings/<id>?clientCompanyId=<client>&download=1` in the browser.
Expected: the browser downloads an `.xml` file whose contents match the `toEdsXml` output.

- [ ] **Step 5: Commit**

```bash
git add "web/app/api/filings/[id]/route.ts"
git commit -m "feat(web): filing XML download route

The generated VAT-return and PVN 2 XML was reachable only from the raw
/api/proposals JSON or the database. RationaleBlock never rendered it, so an
accountant could not get a filing out of the product by hand (M9 known debt 2)."
```

---

### Task 8: Prepared/approved state and download button on `/filings`

**Files:**
- Modify: `web/app/(cabinet)/filings/page.tsx` (the `prepared` state, the fetch that loads each tab, and both `styles.actions` blocks at ~369-373 and ~429-433)

**Interfaces:**
- Consumes: the `filing` key added to both filing GET routes (Task 6); `GET /api/filings/[id]?download=1` (Task 7)
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Replace the ephemeral `prepared` state with the fetched filing**

The page currently tracks `prepared` as a map of tab → proposal id set only by the POST response. Replace it with the `filing` object each GET now returns, so the state survives a reload. Add to the response types the page already declares for the two tabs:

```ts
  filing: { id: string; status: string } | null;
```

and store it alongside `vatReturnData` / `ecslData` (it arrives in the same response, so no extra state or fetch is needed — read `filing` off those objects directly).

Delete the `prepared` state variable and its `setPrepared` call in `prepare()`. Instead, re-run the tab's existing load function after a successful prepare so the new filing is picked up:

```ts
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      await load(); // refetch so `filing` reflects the proposal just created
```

Match `load`'s actual name and signature in the file — read it before editing.

- [ ] **Step 2: Render the status and the download button**

Replace the actions block for the VAT-return tab (currently lines 368-373):

```tsx
            <div className={styles.actions}>
              <button type="button" onClick={prepare} disabled={busy}>{t('filings.prepare')}</button>
              {vatReturnData.filing && (
                <>
                  <p className={styles.preparedMsg}>
                    {t(vatReturnData.filing.status === 'approved' ? 'filings.approved' : 'filings.prepared')}
                    {' — '}<Link href={`/${q}`}>{t('nav.queue')}</Link>
                  </p>
                  <a href={`/api/filings/${vatReturnData.filing.id}?clientCompanyId=${encodeURIComponent(clientCompanyId ?? '')}&download=1`}>
                    {t('filings.downloadXml')}
                  </a>
                </>
              )}
            </div>
```

Make the same change to the ECSL tab's actions block (currently around lines 429-433), reading `ecslData.filing` instead.

This wires the two i18n keys `filings.approved` and `filings.downloadXml`, which have existed unused since the M9 wave.

- [ ] **Step 3: Typecheck and build**

Run: `cd web && npx tsc --noEmit`
Run: `cd web && npm run build`
Expected: both clean.

- [ ] **Step 4: Verify by hand**

With the dev server running and the DB seeded from Task 7, open `/filings`:
- Prepare a filing → the page shows "Prepared — awaiting approval" and a "Download XML" link.
- Reload the page → **the state is still shown** (this is the fix; it was lost before).
- Approve the proposal from the approval queue, return to `/filings`, reload → the page shows "Approved — ready to file".
- Click "Download XML" → an `.xml` file downloads.

- [ ] **Step 5: Commit**

```bash
git add "web/app/(cabinet)/filings/page.tsx"
git commit -m "feat(web): filing status and XML download on /filings

Reads the prepared filing back from the GET response instead of the ephemeral
POST result, so the state survives a reload, and wires filings.approved and
filings.downloadXml — both added in the M9 wave and unused since."
```

---

### Task 9: Render object-valued `sourceRefs` in `RationaleBlock`

`humanizeSourceRefs` skips every object-valued entry, so the ECSL approval card's sources section renders empty.

**Files:**
- Modify: `web/app/components/RationaleBlock.tsx` (the `typeof raw === 'object'` branch in `humanizeSourceRefs`)

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Replace the drop-objects branch with a shallow flatten**

In `humanizeSourceRefs`, replace:

```ts
    if (typeof raw === 'object') continue; // nested rule/period objects live in the payload
```

with:

```ts
    // Flatten one level so period/rule objects render as rows instead of vanishing: the ECSL
    // card's sourceRefs is entirely object-valued, so it previously showed nothing at all.
    // Arrays and deeper nesting stay dropped — a rows[] dump is not what this panel is for.
    if (typeof raw === 'object') {
      if (Array.isArray(raw)) continue;
      for (const [subKey, subRaw] of Object.entries(raw as Record<string, unknown>)) {
        if (subRaw === null || subRaw === undefined || subRaw === '') continue;
        if (typeof subRaw === 'object') continue;
        if (/id$/i.test(subKey)) continue;
        rows.push({
          label: `${humanizeLabel(key, t)} — ${humanizeLabel(subKey, t)}`,
          value: String(subRaw),
        });
      }
      continue;
    }
```

- [ ] **Step 2: Typecheck and build**

Run: `cd web && npx tsc --noEmit`
Run: `cd web && npm run build`
Expected: both clean.

- [ ] **Step 3: Verify by hand**

With the dev server running, prepare an EC Sales List on `/filings`, then open the approval queue and find the `ecsl` card.
Expected: its Sources section now shows the period rows (e.g. "Period — From date  2026-03-01"), where it previously rendered nothing.

- [ ] **Step 4: Commit**

```bash
git add web/app/components/RationaleBlock.tsx
git commit -m "fix(web): render object-valued sourceRefs one level deep

humanizeSourceRefs dropped every object-valued entry, so the ECSL card's
sources section — which is entirely object-valued — rendered empty. Arrays and
deeper nesting stay dropped."
```

---

### Task 10: Correct the stale docs and run full verification

`docs/ROADMAP-market-gaps.md` and `HANDOFF.md` both record M4 C-recurring as "feature itself not started", which has been wrong since the `src/recurring/` commits landed.

**Files:**
- Modify: `docs/ROADMAP-market-gaps.md` (M4 row and the "Suggested sequencing" section)
- Modify: `HANDOFF.md` (the M4 entry)

**Interfaces:**
- Consumes: everything above
- Produces: nothing

- [ ] **Step 1: Correct the M4 row in the roadmap**

In `docs/ROADMAP-market-gaps.md`, the M4 row currently ends:

> **Still ⛔: recurring/subscription invoices (C-recurring — scheduler now resolved, feature itself not started), quotes→invoice (D), customer statement view.**

Replace that sentence with an accurate account: C-recurring's backend (`src/recurring/`, migrations 043/044, `/api/recurring` routes, the `recurring_generate` job handler and reaper, six test files) shipped earlier; this wave added the approval-dispatch fix, the template UI, and the composer mode. State what remains: quotes→invoice (slice D) and the customer statement view.

Update the "Suggested sequencing" paragraph the same way — it currently says "M4 (AR lifecycle, 🔶) rounds out invoicing — C-recurring and slice D (quotes→invoice, customer statements) remain."

- [ ] **Step 2: Add a HANDOFF entry**

In `HANDOFF.md`, correct the M4 entry's closing "Still open: **C-recurring** …" sentence, and add an entry in the same style as the M6 and M9 entries recording:
- the approval-dispatch bug and why it mattered (`resolveAutonomy` is default-closed, so it was the default path; `advanceSchedule` had already committed, so occurrences were lost silently);
- `getAccessPoint()` / `outboundInvoiceAccounts()` and the three-instance convergence;
- the composer mode and the `/invoices` Recurring tab;
- the filing lookup, XML download route, and the `RationaleBlock` fix — and note that M9 known-debt items 2 is now closed;
- known debt this wave does **not** close: reject-skips-the-period is deliberate (documented in the spec), the per-client account-mapping screen is still absent, and M9 items 1, 3, 4, 5, 6, 7, 9, 10, 11 stand.

- [ ] **Step 3: Full verification**

Run: `npm test`
Expected: PASS, with the new tests from Tasks 1, 2, 3, and 6 included. Do not run suites concurrently.

Run: `npx tsc --noEmit`
Run: `cd web && npx tsc --noEmit`
Run: `cd web && npm run build`
Expected: all clean.

- [ ] **Step 4: Browser walk**

`HANDOFF.md` M9 known-debt item 8 records that the previous wave's interactive browser walk was deferred and never performed. Perform this one and report what was seen.

Run: `npm run seed` (prints logins and a fresh TOTP code, 30s window)
Run: `cd web && npm run dev`

Walk, in order:
1. `/invoices` → the Outbox tab renders as before; switch to Recurring → empty state.
2. `/invoices/new` → set document type to Recurring; the invoice-number and issue-date fields disappear and the cadence fields appear; the autonomy note reads "held in the approval queue" (no policy is seeded).
3. Fill in a customer, one line, and a first run date; create the template.
4. `/invoices` → Recurring tab lists it with cadence, next run date, and Active.
5. Pause it → confirm dialog → the row shows Paused and the Pause button is gone.
6. `/filings` → prepare a VAT return → prepared message + Download XML link appear; reload the page and confirm both survive; download the XML.
7. Approval queue → the `ecsl` card (prepare an EC Sales List first) shows period rows in Sources.

- [ ] **Step 5: Commit**

```bash
git add docs/ROADMAP-market-gaps.md HANDOFF.md
git commit -m "docs: correct the stale M4 C-recurring status, record this wave

The roadmap and HANDOFF both said C-recurring was not started; its backend,
routes, job handler, and six test files had shipped. Records what this wave
added and what is still open."
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| A2 — two seams (`getAccessPoint`, `outboundInvoiceAccounts`) | 1 |
| A2 — `postApprovedRecurringInvoice` | 2 |
| A2 — dispatch + corrected fallthrough comment | 3 |
| A1 — list as a tab on `/invoices` | 4 |
| A1 — composer third mode + autonomy surfacing | 5 |
| B — period lookup (state survives reload) | 6 |
| B — XML download route | 7 |
| B — approved indicator + download button, dead i18n keys wired | 8 |
| B — `RationaleBlock` object-valued `sourceRefs` | 9 |
| Edge semantics — reject skips period, failed issue rolls back, double-approve guarded | 2 (tests), 10 (documented) |
| Testing — new suites, both typechecks, browser walk | 1, 2, 3, 6, 10 |
| Documentation to correct | 10 |

No spec requirement is unassigned.

**Type consistency:** `postApprovedRecurringInvoice(tx, ctx, proposalId, opts?)` returns `{ entryId: string }` in Task 2 and is consumed that way in Task 3. `findFilingProposal` returns `{ id, status } | null` in Task 6 and is read as `filing.id` / `filing.status` in Task 8. `outboundInvoiceAccounts()` returns `{ receivable, sales, vat }` in Task 1, spread into `sendInvoice`'s `receivableAccount` / `salesAccount` / `vatAccount` in Tasks 1 and 2. `getAccessPoint()` returns `AccessPoint` throughout.

**Known adaptation points** (flagged in-task rather than left as placeholders, because the exact local names must be read from the files): the setup-helper names in `tests/api/handlers.test.ts` (Task 3 Step 1), the autonomy route's response key (Task 5 Step 4), the composer's existing variable names in the submit handler and guard (Task 5 Steps 5-6), and `/filings`'s load-function name (Task 8 Step 1).
