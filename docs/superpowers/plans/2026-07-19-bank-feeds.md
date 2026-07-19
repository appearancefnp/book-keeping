# Live Bank Feeds (M3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pull bank transactions automatically via GoCardless Bank Account Data (PSD2) behind a `BankFeedProvider` interface+stub seam, feeding the existing unchanged import + matching pipeline.

**Architecture:** New `src/bankfeed/` domain module (provider seam, connection lifecycle, sync engine, cron sweep) + migration 035 (two RLS'd tables) + seven API routes + a "Bank feeds" section on `/bank`. Feed transactions normalize into the existing `BankStatement` shape and go through `importStatement` → `proposeMatches`/`proposeApMatches` untouched.

**Tech Stack:** TypeScript ESM (`.js` import suffixes in `src/`), Postgres 16 + RLS, vitest against the real DB, Next.js 16 App Router (`web/`), GoCardless Bank Account Data REST API v2 (native `fetch`).

**Spec:** `docs/superpowers/specs/2026-07-19-bank-feeds-design.md` — read it first.

## Global Constraints

- Money is **integer cents** via `src/db/money.ts` (`toCents`); never floats.
- Every domain mutation runs inside `withTenant(ctx, ...)` and calls `appendAudit(...)`.
- Migration number is **035** (take max+1 across ALL files; two 023/024/025/026 collisions are historical — never reuse).
- `src/` imports use `.js` suffixes (ESM); web imports domain via `@domain/*`.
- API route pattern: `getSessionToken()` → `resolveTenantContext(token, clientCompanyId, nowUnix())` → domain call in `withTenant`; mutations `assertRoleAllowed(ctx.actorRole, 'bank.write')`; catch → `errorToStatus(msg)`, except provider failures (message prefix `bank feed provider`) → **502**.
- Every user-facing string in all three catalogs (LV/RU/EN) in `web/app/lib/i18n.ts`; the typed record fails the build on a missing key.
- `web/` is a Next.js version with breaking changes — read `web/node_modules/next/dist/docs/` before writing Next.js code; route handlers are Node runtime (`export const runtime = 'nodejs'`).
- Icons: inline stroked SVG, `currentColor`, ~1.5px; no emoji.
- Before declaring done: `npm test` (root), `npx tsc --noEmit` (root), `cd web && npx tsc --noEmit`.
- Tests must not touch the network: `StubBankFeedProvider` everywhere; GoCardless mapping tested against inline JSON fixtures.

---

### Task 1: Migration 035 + provider seam types, normalization, stub provider

**Files:**
- Create: `migrations/035_bank_feed_connections.sql`
- Create: `src/bankfeed/provider.ts`
- Create: `src/bankfeed/normalize.ts`
- Create: `src/bankfeed/stub.ts`
- Test: `tests/bankfeed/normalize.test.ts`, `tests/bankfeed/stub.test.ts`

**Interfaces:**
- Consumes: `BankTxn` from `src/banking/types.js`, `toCents` from `src/db/money.js`.
- Produces: `BankFeedProvider`, `FeedTxn`, `Institution`, `RequisitionState` (provider.ts); `feedTxnToBankTxn(f: FeedTxn): BankTxn` (normalize.ts); `StubBankFeedProvider` with test helpers `linkRequisition(requisitionId, accounts, consentExpiresAt)`, `transactionsByAccount: Map<string, FeedTxn[]>`, `fetchErrors: Map<string, string>`, `deleted: string[]`, constructor option `{ autoLink?: boolean }` (stub.ts). Later tasks rely on these exact names.

- [ ] **Step 1: Write the migration**

`migrations/035_bank_feed_connections.sql`:

```sql
CREATE TABLE bank_feed_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  provider text NOT NULL DEFAULT 'gocardless',
  provider_requisition_id text NOT NULL,
  institution_id text NOT NULL,
  institution_name text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','linked','expired','revoked')),
  consent_expires_at timestamptz,
  last_error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_company_id, provider_requisition_id)
);
CREATE INDEX bank_feed_connections_client_status_idx ON bank_feed_connections(client_company_id, status);

CREATE TABLE bank_feed_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES bank_feed_connections(id) ON DELETE CASCADE,
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  provider_account_id text NOT NULL,
  iban text NOT NULL DEFAULT '',
  currency char(3) NOT NULL DEFAULT 'EUR',
  last_synced_date date,
  UNIQUE (connection_id, provider_account_id)
);
CREATE INDEX bank_feed_accounts_client_idx ON bank_feed_accounts(client_company_id);

ALTER TABLE bank_feed_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_feed_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY bank_feed_connections_tenant_isolation ON bank_feed_connections
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

ALTER TABLE bank_feed_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_feed_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY bank_feed_accounts_tenant_isolation ON bank_feed_accounts
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON bank_feed_connections TO bookkeeping_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON bank_feed_accounts TO bookkeeping_app;
```

(Deletes are granted deliberately — connections are removable consents, unlike the append-only ledger.)

- [ ] **Step 2: Write the provider seam types**

`src/bankfeed/provider.ts`:

```ts
export interface Institution { id: string; name: string; logoUrl?: string }

/** One bank transaction as the feed provider reports it, before normalization. */
export interface FeedTxn {
  bookingDate: string;   // ISO date
  amount: string;        // SIGNED decimal string, e.g. "-12.50" (negative = money out)
  currency: string;
  reference: string;
  counterparty: string;
  endToEndId: string;    // '' when the bank omits it
  providerTxId: string;  // provider-stable id, always present
}

export type FeedConnectionStatus = 'pending' | 'linked' | 'expired' | 'revoked';

export interface RequisitionState {
  status: FeedConnectionStatus;
  consentExpiresAt: string | null; // ISO timestamp
  accounts: { providerAccountId: string; iban: string; currency: string }[];
}

/**
 * Open-banking feed provider seam (mirrors AccessPoint / VidClient).
 * Real impl: GoCardlessProvider. Tests/dev: StubBankFeedProvider.
 */
export interface BankFeedProvider {
  readonly name: string; // 'gocardless' | 'stub' — stored on the connection row
  listInstitutions(country: string): Promise<Institution[]>;
  startConsent(institutionId: string, redirectUrl: string, reference: string): Promise<{ requisitionId: string; consentUrl: string }>;
  getRequisition(requisitionId: string): Promise<RequisitionState>;
  fetchTransactions(providerAccountId: string, fromDate: string): Promise<FeedTxn[]>;
  deleteRequisition(requisitionId: string): Promise<void>; // best-effort cleanup
}
```

- [ ] **Step 3: Write the failing normalization test**

`tests/bankfeed/normalize.test.ts`:

```ts
import { expect, test } from 'vitest';
import { feedTxnToBankTxn } from '../../src/bankfeed/normalize.js';
import type { FeedTxn } from '../../src/bankfeed/provider.js';

const base: FeedTxn = {
  bookingDate: '2026-07-01', amount: '-12.50', currency: 'EUR',
  reference: 'INV-9', counterparty: 'SIA Piegādātājs', endToEndId: 'E2E-1', providerTxId: 'gc-tx-1',
};

test('negative amount becomes an absolute-value debit', () => {
  const t = feedTxnToBankTxn(base);
  expect(t.side).toBe('debit');
  expect(t.amountCents).toBe('1250');
});

test('positive amount becomes a credit', () => {
  const t = feedTxnToBankTxn({ ...base, amount: '100.05' });
  expect(t.side).toBe('credit');
  expect(t.amountCents).toBe('10005');
});

test('endToEndId falls back to providerTxId when the bank omits it', () => {
  expect(feedTxnToBankTxn({ ...base, endToEndId: '' }).endToEndId).toBe('gc-tx-1');
  expect(feedTxnToBankTxn(base).endToEndId).toBe('E2E-1');
});

test('invalid decimal (3 dp) throws', () => {
  expect(() => feedTxnToBankTxn({ ...base, amount: '1.005' })).toThrow(/Invalid money value/);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run tests/bankfeed/normalize.test.ts`
Expected: FAIL — cannot resolve `src/bankfeed/normalize.js`.

- [ ] **Step 5: Implement normalization**

`src/bankfeed/normalize.ts`:

```ts
import { toCents } from '../db/money.js';
import type { BankTxn } from '../banking/types.js';
import type { FeedTxn } from './provider.js';

/** Feed transaction → the shape importStatement stores. Sign decides side; amount stored absolute. */
export function feedTxnToBankTxn(f: FeedTxn): BankTxn {
  const cents = toCents(f.amount);
  const abs = cents < 0n ? -cents : cents;
  return {
    bookingDate: f.bookingDate,
    amountCents: abs.toString(),
    currency: f.currency,
    side: cents < 0n ? 'debit' : 'credit',
    reference: f.reference,
    counterparty: f.counterparty,
    // Dedup rides the (client, account, end_to_end_id, amount, date) unique key;
    // fall back to the provider-stable id so re-syncs always dedup against themselves.
    endToEndId: f.endToEndId || f.providerTxId,
  };
}
```

- [ ] **Step 6: Write the failing stub test**

`tests/bankfeed/stub.test.ts`:

```ts
import { expect, test } from 'vitest';
import { StubBankFeedProvider } from '../../src/bankfeed/stub.js';

test('consent lifecycle: pending until linked via test helper', async () => {
  const p = new StubBankFeedProvider();
  const { requisitionId, consentUrl } = await p.startConsent('STUB_BANK', 'http://x/cb', 'ref-1');
  expect(consentUrl).toContain(requisitionId);
  expect((await p.getRequisition(requisitionId)).status).toBe('pending');
  p.linkRequisition(requisitionId, [{ providerAccountId: 'acc-1', iban: 'LV11TEST0000000000001', currency: 'EUR' }], '2026-10-01T00:00:00Z');
  const req = await p.getRequisition(requisitionId);
  expect(req.status).toBe('linked');
  expect(req.accounts).toHaveLength(1);
});

test('fetchTransactions filters by fromDate and can be forced to fail', async () => {
  const p = new StubBankFeedProvider();
  p.transactionsByAccount.set('acc-1', [
    { bookingDate: '2026-06-01', amount: '5.00', currency: 'EUR', reference: '', counterparty: '', endToEndId: '', providerTxId: 'a' },
    { bookingDate: '2026-07-01', amount: '6.00', currency: 'EUR', reference: '', counterparty: '', endToEndId: '', providerTxId: 'b' },
  ]);
  expect(await p.fetchTransactions('acc-1', '2026-06-15')).toHaveLength(1);
  p.fetchErrors.set('acc-1', 'rate limited');
  await expect(p.fetchTransactions('acc-1', '2026-01-01')).rejects.toThrow('rate limited');
});

test('autoLink mode links on first getRequisition with a demo account', async () => {
  const p = new StubBankFeedProvider({ autoLink: true });
  const { requisitionId } = await p.startConsent('STUB_BANK', 'http://x/cb', 'ref-1');
  const req = await p.getRequisition(requisitionId);
  expect(req.status).toBe('linked');
  expect(req.accounts.length).toBeGreaterThan(0);
});

test('deleteRequisition records the id', async () => {
  const p = new StubBankFeedProvider();
  const { requisitionId } = await p.startConsent('STUB_BANK', 'http://x/cb', 'r');
  await p.deleteRequisition(requisitionId);
  expect(p.deleted).toContain(requisitionId);
});

test('unknown requisition throws', async () => {
  const p = new StubBankFeedProvider();
  await expect(p.getRequisition('nope')).rejects.toThrow(/not found/);
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run tests/bankfeed/stub.test.ts`
Expected: FAIL — cannot resolve `src/bankfeed/stub.js`.

- [ ] **Step 8: Implement the stub provider**

`src/bankfeed/stub.ts`:

```ts
import type { BankFeedProvider, FeedTxn, Institution, RequisitionState } from './provider.js';

interface StubRequisition { state: RequisitionState }

/**
 * In-memory feed provider for tests and keyless dev.
 * autoLink: getRequisition links a pending requisition with one demo account +
 * a few demo transactions, so the dev connect flow works end-to-end without keys.
 */
export class StubBankFeedProvider implements BankFeedProvider {
  readonly name = 'stub';
  institutions: Institution[] = [{ id: 'STUB_BANK', name: 'Stub Bank (demo)' }];
  transactionsByAccount = new Map<string, FeedTxn[]>();
  fetchErrors = new Map<string, string>();
  deleted: string[] = [];
  private requisitions = new Map<string, StubRequisition>();
  private seq = 0;
  private autoLink: boolean;

  constructor(opts: { autoLink?: boolean } = {}) { this.autoLink = opts.autoLink ?? false; }

  async listInstitutions(_country: string): Promise<Institution[]> { return this.institutions; }

  async startConsent(_institutionId: string, redirectUrl: string, _reference: string) {
    const requisitionId = `stub-req-${++this.seq}`;
    this.requisitions.set(requisitionId, { state: { status: 'pending', consentExpiresAt: null, accounts: [] } });
    return { requisitionId, consentUrl: `${redirectUrl}${redirectUrl.includes('?') ? '&' : '?'}stub=${requisitionId}` };
  }

  /** Test helper: flip a requisition to linked with the given accounts. */
  linkRequisition(requisitionId: string, accounts: RequisitionState['accounts'], consentExpiresAt: string | null): void {
    const r = this.mustGet(requisitionId);
    r.state = { status: 'linked', consentExpiresAt, accounts };
  }

  /** Test helper: force a status (e.g. 'expired'). */
  setStatus(requisitionId: string, status: RequisitionState['status']): void {
    this.mustGet(requisitionId).state.status = status;
  }

  async getRequisition(requisitionId: string): Promise<RequisitionState> {
    const r = this.mustGet(requisitionId);
    if (this.autoLink && r.state.status === 'pending') {
      const acc = `stub-acc-${requisitionId}`;
      this.linkRequisition(requisitionId, [{ providerAccountId: acc, iban: 'LV97STUB0000000000001', currency: 'EUR' }], '2026-10-17T00:00:00Z');
      this.transactionsByAccount.set(acc, [
        { bookingDate: '2026-07-10', amount: '121.00', currency: 'EUR', reference: 'INV-2026-001', counterparty: 'SIA Klients', endToEndId: 'INV-2026-001', providerTxId: `${acc}-1` },
        { bookingDate: '2026-07-12', amount: '-60.50', currency: 'EUR', reference: 'PO-77', counterparty: 'SIA Piegādātājs', endToEndId: '', providerTxId: `${acc}-2` },
      ]);
    }
    return this.mustGet(requisitionId).state;
  }

  async fetchTransactions(providerAccountId: string, fromDate: string): Promise<FeedTxn[]> {
    const err = this.fetchErrors.get(providerAccountId);
    if (err) throw new Error(err);
    return (this.transactionsByAccount.get(providerAccountId) ?? []).filter((t) => t.bookingDate >= fromDate);
  }

  async deleteRequisition(requisitionId: string): Promise<void> { this.deleted.push(requisitionId); }

  private mustGet(requisitionId: string): StubRequisition {
    const r = this.requisitions.get(requisitionId);
    if (!r) throw new Error(`stub requisition not found: ${requisitionId}`);
    return r;
  }
}
```

- [ ] **Step 9: Run both tests + full suite to verify pass and no migration fallout**

Run: `npx vitest run tests/bankfeed/ && npm test`
Expected: PASS (migration 035 applies cleanly under every test's `resetDb()`).

- [ ] **Step 10: Commit**

```bash
git add migrations/035_bank_feed_connections.sql src/bankfeed/ tests/bankfeed/
git commit -m "feat(bankfeed): migration 035, provider seam, normalization, stub provider"
```

---

### Task 2: Connection lifecycle domain (`src/bankfeed/connections.ts`)

**Files:**
- Create: `src/bankfeed/connections.ts`
- Test: `tests/bankfeed/connections.test.ts`

**Interfaces:**
- Consumes: `BankFeedProvider`, `RequisitionState` (Task 1); `appendAudit` from `src/audit/audit.js`; `TenantContext` from `src/tenancy/context.js`.
- Produces (exact signatures later tasks use):

```ts
export interface FeedAccountRow { id: string; providerAccountId: string; iban: string; currency: string; lastSyncedDate: string | null }
export interface FeedConnectionRow {
  id: string; provider: string; providerRequisitionId: string; institutionId: string; institutionName: string;
  status: string; consentExpiresAt: string | null; lastError: string; createdAt: string; accounts: FeedAccountRow[];
}
createConnection(tx, ctx, provider, input: { connectionId: string; institutionId: string; institutionName: string; redirectUrl: string }): Promise<{ connectionId: string; consentUrl: string }>
finalizeConnection(tx, ctx, provider, connectionId: string): Promise<FeedConnectionRow>
listConnections(tx, ctx): Promise<FeedConnectionRow[]>
getConnection(tx, ctx, connectionId: string): Promise<FeedConnectionRow>   // throws 'bank feed connection not found'
deleteConnection(tx, ctx, provider, connectionId: string): Promise<void>
```

(`connectionId` is generated by the caller — the API route needs it inside the redirect URL before the consent starts.)

- [ ] **Step 1: Write the failing test**

`tests/bankfeed/connections.test.ts`:

```ts
import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { randomUUID } from 'node:crypto';
import { StubBankFeedProvider } from '../../src/bankfeed/stub.js';
import { createConnection, finalizeConnection, listConnections, deleteConnection } from '../../src/bankfeed/connections.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('create → pending row with consent url; finalize stores accounts and links', async () => {
  const t = await makeFirmAndClient();
  const p = new StubBankFeedProvider();
  const connectionId = randomUUID();
  const created = await withTenant(ctx(t), (tx) =>
    createConnection(tx, ctx(t), p, { connectionId, institutionId: 'STUB_BANK', institutionName: 'Stub Bank', redirectUrl: 'http://x/bank/callback?cid=' + connectionId }));
  expect(created.consentUrl).toContain('stub-req-1');

  let list = await withTenant(ctx(t), (tx) => listConnections(tx, ctx(t)));
  expect(list).toHaveLength(1);
  expect(list[0]!.status).toBe('pending');

  // finalize while provider still pending → stays pending, no accounts
  let fin = await withTenant(ctx(t), (tx) => finalizeConnection(tx, ctx(t), p, connectionId));
  expect(fin.status).toBe('pending');
  expect(fin.accounts).toHaveLength(0);

  p.linkRequisition('stub-req-1', [{ providerAccountId: 'acc-1', iban: 'LV11TEST0000000000001', currency: 'EUR' }], '2026-10-01T00:00:00Z');
  fin = await withTenant(ctx(t), (tx) => finalizeConnection(tx, ctx(t), p, connectionId));
  expect(fin.status).toBe('linked');
  expect(fin.accounts.map((a) => a.iban)).toEqual(['LV11TEST0000000000001']);
  expect(fin.consentExpiresAt).not.toBeNull();

  // finalize is idempotent on accounts
  fin = await withTenant(ctx(t), (tx) => finalizeConnection(tx, ctx(t), p, connectionId));
  expect(fin.accounts).toHaveLength(1);
});

test('RLS: another client sees no connections', async () => {
  const a = await makeFirmAndClient('SIA A');
  const b = await makeFirmAndClient('SIA B');
  const p = new StubBankFeedProvider();
  await withTenant(ctx(a), (tx) =>
    createConnection(tx, ctx(a), p, { connectionId: randomUUID(), institutionId: 'STUB_BANK', institutionName: 'Stub', redirectUrl: 'http://x' }));
  expect(await withTenant(ctx(b), (tx) => listConnections(tx, ctx(b)))).toHaveLength(0);
});

test('delete removes rows and best-effort deletes the requisition', async () => {
  const t = await makeFirmAndClient();
  const p = new StubBankFeedProvider();
  const connectionId = randomUUID();
  await withTenant(ctx(t), (tx) =>
    createConnection(tx, ctx(t), p, { connectionId, institutionId: 'STUB_BANK', institutionName: 'Stub', redirectUrl: 'http://x' }));
  await withTenant(ctx(t), (tx) => deleteConnection(tx, ctx(t), p, connectionId));
  expect(p.deleted).toContain('stub-req-1');
  expect(await withTenant(ctx(t), (tx) => listConnections(tx, ctx(t)))).toHaveLength(0);
});

test('unknown connection throws not found', async () => {
  const t = await makeFirmAndClient();
  const p = new StubBankFeedProvider();
  await expect(withTenant(ctx(t), (tx) => finalizeConnection(tx, ctx(t), p, randomUUID())))
    .rejects.toThrow(/not found/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/bankfeed/connections.test.ts`
Expected: FAIL — cannot resolve `src/bankfeed/connections.js`.

- [ ] **Step 3: Implement**

`src/bankfeed/connections.ts`:

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import type { BankFeedProvider } from './provider.js';
import { appendAudit } from '../audit/audit.js';

export interface FeedAccountRow { id: string; providerAccountId: string; iban: string; currency: string; lastSyncedDate: string | null }
export interface FeedConnectionRow {
  id: string; provider: string; providerRequisitionId: string; institutionId: string; institutionName: string;
  status: string; consentExpiresAt: string | null; lastError: string; createdAt: string; accounts: FeedAccountRow[];
}

const CONN_COLS = `id, provider, provider_requisition_id AS "providerRequisitionId",
  institution_id AS "institutionId", institution_name AS "institutionName", status,
  consent_expires_at::text AS "consentExpiresAt", last_error AS "lastError", created_at::text AS "createdAt"`;

async function accountsFor(tx: PoolClient, ctx: TenantContext, connectionIds: string[]): Promise<Map<string, FeedAccountRow[]>> {
  const map = new Map<string, FeedAccountRow[]>();
  if (!connectionIds.length) return map;
  const res = await tx.query(
    `SELECT connection_id AS "connectionId", id, provider_account_id AS "providerAccountId",
            iban, trim(currency) AS currency, last_synced_date::text AS "lastSyncedDate"
     FROM bank_feed_accounts
     WHERE client_company_id = $1 AND connection_id = ANY($2::uuid[])
     ORDER BY iban`,
    [ctx.clientCompanyId, connectionIds],
  );
  for (const r of res.rows) {
    const list = map.get(r.connectionId) ?? [];
    list.push({ id: r.id, providerAccountId: r.providerAccountId, iban: r.iban, currency: r.currency, lastSyncedDate: r.lastSyncedDate });
    map.set(r.connectionId, list);
  }
  return map;
}

export async function getConnection(tx: PoolClient, ctx: TenantContext, connectionId: string): Promise<FeedConnectionRow> {
  const res = await tx.query(
    `SELECT ${CONN_COLS} FROM bank_feed_connections WHERE id = $1 AND client_company_id = $2`,
    [connectionId, ctx.clientCompanyId],
  );
  if (!res.rowCount) throw new Error('bank feed connection not found');
  const accounts = await accountsFor(tx, ctx, [connectionId]);
  return { ...res.rows[0], accounts: accounts.get(connectionId) ?? [] } as FeedConnectionRow;
}

export async function listConnections(tx: PoolClient, ctx: TenantContext): Promise<FeedConnectionRow[]> {
  const res = await tx.query(
    `SELECT ${CONN_COLS} FROM bank_feed_connections WHERE client_company_id = $1 ORDER BY created_at DESC`,
    [ctx.clientCompanyId],
  );
  const accounts = await accountsFor(tx, ctx, res.rows.map((r) => r.id));
  return res.rows.map((r) => ({ ...r, accounts: accounts.get(r.id) ?? [] })) as FeedConnectionRow[];
}

export async function createConnection(
  tx: PoolClient, ctx: TenantContext, provider: BankFeedProvider,
  input: { connectionId: string; institutionId: string; institutionName: string; redirectUrl: string },
): Promise<{ connectionId: string; consentUrl: string }> {
  const { requisitionId, consentUrl } = await provider.startConsent(input.institutionId, input.redirectUrl, input.connectionId);
  await tx.query(
    `INSERT INTO bank_feed_connections (id, client_company_id, provider, provider_requisition_id, institution_id, institution_name)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [input.connectionId, ctx.clientCompanyId, provider.name, requisitionId, input.institutionId, input.institutionName],
  );
  await appendAudit(tx, ctx, {
    action: 'create', entityType: 'bank_feed_connection', entityId: input.connectionId,
    before: null, after: { institutionId: input.institutionId, requisitionId },
  });
  return { connectionId: input.connectionId, consentUrl };
}

/** After the bank redirect: pull requisition state, store accounts, update status. Idempotent. */
export async function finalizeConnection(
  tx: PoolClient, ctx: TenantContext, provider: BankFeedProvider, connectionId: string,
): Promise<FeedConnectionRow> {
  const before = await getConnection(tx, ctx, connectionId);
  const req = await provider.getRequisition(before.providerRequisitionId);
  await tx.query(
    `UPDATE bank_feed_connections SET status = $1, consent_expires_at = $2, updated_at = now()
     WHERE id = $3 AND client_company_id = $4`,
    [req.status, req.consentExpiresAt, connectionId, ctx.clientCompanyId],
  );
  for (const a of req.accounts) {
    await tx.query(
      `INSERT INTO bank_feed_accounts (connection_id, client_company_id, provider_account_id, iban, currency)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (connection_id, provider_account_id) DO NOTHING`,
      [connectionId, ctx.clientCompanyId, a.providerAccountId, a.iban, a.currency],
    );
  }
  await appendAudit(tx, ctx, {
    action: 'finalize', entityType: 'bank_feed_connection', entityId: connectionId,
    before: { status: before.status }, after: { status: req.status, accounts: req.accounts.length },
  });
  return getConnection(tx, ctx, connectionId);
}

export async function deleteConnection(
  tx: PoolClient, ctx: TenantContext, provider: BankFeedProvider, connectionId: string,
): Promise<void> {
  const row = await getConnection(tx, ctx, connectionId);
  try { await provider.deleteRequisition(row.providerRequisitionId); } catch { /* best-effort: local removal must not depend on the provider */ }
  await tx.query(`DELETE FROM bank_feed_connections WHERE id = $1 AND client_company_id = $2`, [connectionId, ctx.clientCompanyId]);
  await appendAudit(tx, ctx, {
    action: 'delete', entityType: 'bank_feed_connection', entityId: connectionId,
    before: { requisitionId: row.providerRequisitionId, status: row.status }, after: null,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/bankfeed/connections.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bankfeed/connections.ts tests/bankfeed/connections.test.ts
git commit -m "feat(bankfeed): connection lifecycle (create/finalize/list/delete) with audit + RLS"
```

---

### Task 3: Sync engine (`src/bankfeed/sync.ts`)

**Files:**
- Create: `src/bankfeed/sync.ts`
- Test: `tests/bankfeed/sync.test.ts`

**Interfaces:**
- Consumes: Task 1–2 exports; `importStatement` from `src/banking/import.js`; `proposeMatches`, `proposeApMatches` from `src/banking/match.js`; `BankStatement` from `src/banking/camt-parser.js`.
- Produces:

```ts
export const FIRST_SYNC_DAYS = 90;
export const OVERLAP_DAYS = 7;
export function isoAddDays(iso: string, days: number): string
export interface AccountSyncResult { iban: string; imported: number; skipped: number; error: string | null }
export interface SyncResult { connectionId: string; status: string; accounts: AccountSyncResult[]; proposals: number }
export async function syncConnection(tx, ctx, provider, connectionId: string, todayIso: string): Promise<SyncResult>
```

`todayIso` is always passed by the caller (routes use `new Date().toISOString().slice(0, 10)`) so tests are deterministic.

- [ ] **Step 1: Write the failing test**

`tests/bankfeed/sync.test.ts`:

```ts
import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { randomUUID } from 'node:crypto';
import { StubBankFeedProvider } from '../../src/bankfeed/stub.js';
import { createConnection, finalizeConnection, getConnection } from '../../src/bankfeed/connections.js';
import { syncConnection, isoAddDays, FIRST_SYNC_DAYS, OVERLAP_DAYS } from '../../src/bankfeed/sync.js';
import type { FeedTxn } from '../../src/bankfeed/provider.js';

const TODAY = '2026-07-19';

function txn(over: Partial<FeedTxn>): FeedTxn {
  return { bookingDate: '2026-07-10', amount: '121.00', currency: 'EUR', reference: 'INV-1',
    counterparty: 'SIA Klients', endToEndId: 'INV-2026-001', providerTxId: 'gc-1', ...over };
}

async function linkedConnection(t: { firmId: string; clientCompanyId: string }, p: StubBankFeedProvider,
  accounts = [{ providerAccountId: 'acc-1', iban: 'LV11TEST0000000000001', currency: 'EUR' }]) {
  const connectionId = randomUUID();
  await withTenant(ctx(t), (tx) =>
    createConnection(tx, ctx(t), p, { connectionId, institutionId: 'STUB_BANK', institutionName: 'Stub', redirectUrl: 'http://x' }));
  p.linkRequisition('stub-req-1', accounts, '2026-10-01T00:00:00Z');
  await withTenant(ctx(t), (tx) => finalizeConnection(tx, ctx(t), p, connectionId));
  return connectionId;
}

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('isoAddDays', () => {
  expect(isoAddDays('2026-07-19', -7)).toBe('2026-07-12');
  expect(isoAddDays('2026-01-01', -1)).toBe('2025-12-31');
});

test('first sync imports the 90-day window and advances the cursor', async () => {
  const t = await makeFirmAndClient();
  const p = new StubBankFeedProvider();
  const id = await linkedConnection(t, p);
  p.transactionsByAccount.set('acc-1', [
    txn({}),
    txn({ bookingDate: isoAddDays(TODAY, -FIRST_SYNC_DAYS - 1), providerTxId: 'too-old', endToEndId: 'too-old' }),
  ]);
  const r = await withTenant(ctx(t), (tx) => syncConnection(tx, ctx(t), p, id, TODAY));
  expect(r.status).toBe('linked');
  expect(r.accounts[0]!.imported).toBe(1); // the too-old txn is outside the window
  const conn = await withTenant(ctx(t), (tx) => getConnection(tx, ctx(t), id));
  expect(conn.accounts[0]!.lastSyncedDate).toBe(TODAY);
});

test('re-sync with overlap imports nothing new', async () => {
  const t = await makeFirmAndClient();
  const p = new StubBankFeedProvider();
  const id = await linkedConnection(t, p);
  p.transactionsByAccount.set('acc-1', [txn({})]);
  await withTenant(ctx(t), (tx) => syncConnection(tx, ctx(t), p, id, '2026-07-12'));
  // next-day sync re-fetches from 2026-07-05 (cursor − OVERLAP_DAYS) and dedups
  const again = await withTenant(ctx(t), (tx) => syncConnection(tx, ctx(t), p, id, '2026-07-13'));
  expect(again.accounts[0]!.imported).toBe(0);
  expect(again.accounts[0]!.skipped).toBe(1);
  const n = await withTenant(ctx(t), async (tx) => (await tx.query('SELECT count(*)::int AS n FROM bank_transactions')).rows[0].n);
  expect(n).toBe(1);
});

test('feed transactions produce match proposals (credit → receivable)', async () => {
  // Mirror tests/banking/match.test.ts: post a 121.00 receivable on 2310, then sync a 121.00 credit.
  // Copy the ledger-seeding helper from that file verbatim.
  const t = await makeFirmAndClient();
  const p = new StubBankFeedProvider();
  const id = await linkedConnection(t, p);
  p.transactionsByAccount.set('acc-1', [txn({ amount: '121.00' })]);
  // <seed a 12100-cent debit on account 2310 exactly as tests/banking/match.test.ts does>
  const r = await withTenant(ctx(t), (tx) => syncConnection(tx, ctx(t), p, id, TODAY));
  expect(r.proposals).toBeGreaterThanOrEqual(1);
});

test('expired consent flips status and imports nothing', async () => {
  const t = await makeFirmAndClient();
  const p = new StubBankFeedProvider();
  const id = await linkedConnection(t, p);
  p.setStatus('stub-req-1', 'expired');
  const r = await withTenant(ctx(t), (tx) => syncConnection(tx, ctx(t), p, id, TODAY));
  expect(r.status).toBe('expired');
  expect(r.accounts).toHaveLength(0);
  const conn = await withTenant(ctx(t), (tx) => getConnection(tx, ctx(t), id));
  expect(conn.status).toBe('expired');
});

test('per-account failure records last_error, sibling account still imports, success clears', async () => {
  const t = await makeFirmAndClient();
  const p = new StubBankFeedProvider();
  const id = await linkedConnection(t, p, [
    { providerAccountId: 'acc-1', iban: 'LV11TEST0000000000001', currency: 'EUR' },
    { providerAccountId: 'acc-2', iban: 'LV22TEST0000000000002', currency: 'EUR' },
  ]);
  p.transactionsByAccount.set('acc-2', [txn({ providerTxId: 'x2', endToEndId: '' })]);
  p.fetchErrors.set('acc-1', 'rate limited');
  const r = await withTenant(ctx(t), (tx) => syncConnection(tx, ctx(t), p, id, TODAY));
  const byIban = Object.fromEntries(r.accounts.map((a) => [a.iban, a]));
  expect(byIban['LV11TEST0000000000001']!.error).toMatch(/rate limited/);
  expect(byIban['LV22TEST0000000000002']!.imported).toBe(1);
  let conn = await withTenant(ctx(t), (tx) => getConnection(tx, ctx(t), id));
  expect(conn.lastError).toMatch(/rate limited/);
  // failed account's cursor did NOT advance; successful one did
  const cursors = Object.fromEntries(conn.accounts.map((a) => [a.iban, a.lastSyncedDate]));
  expect(cursors['LV11TEST0000000000001']).toBeNull();
  expect(cursors['LV22TEST0000000000002']).toBe(TODAY);

  p.fetchErrors.delete('acc-1');
  await withTenant(ctx(t), (tx) => syncConnection(tx, ctx(t), p, id, TODAY));
  conn = await withTenant(ctx(t), (tx) => getConnection(tx, ctx(t), id));
  expect(conn.lastError).toBe('');
});
```

Note for the proposals test: open `tests/banking/match.test.ts`, copy its ledger-seeding (accounts + `postEntry` of a 12100-cent debit on `2310`) exactly — do not invent a new seeding path.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/bankfeed/sync.test.ts`
Expected: FAIL — cannot resolve `src/bankfeed/sync.js`.

- [ ] **Step 3: Implement**

`src/bankfeed/sync.ts`:

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import type { BankFeedProvider } from './provider.js';
import type { BankStatement } from '../banking/camt-parser.js';
import { importStatement } from '../banking/import.js';
import { proposeMatches, proposeApMatches } from '../banking/match.js';
import { feedTxnToBankTxn } from './normalize.js';
import { appendAudit } from '../audit/audit.js';

// Same hard-coded LR chart defaults as the camt.053 import route and src/dev/seed.ts
// (documented account-mapping debt — see HANDOFF.md).
const AR_MATCH = { receivablesAccount: '2310', bankAccount: '2620' };
const AP_MATCH = { payablesAccount: '5310', bankAccount: '2620', bankClearingAccount: '2699' };

export const FIRST_SYNC_DAYS = 90; // GoCardless EUA default history window
export const OVERLAP_DAYS = 7;     // late-booked transactions; import is idempotent so overlap is safe

export function isoAddDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface AccountSyncResult { iban: string; imported: number; skipped: number; error: string | null }
export interface SyncResult { connectionId: string; status: string; accounts: AccountSyncResult[]; proposals: number }

/**
 * Refresh requisition state, pull new transactions per account through the
 * existing import + matching pipeline, advance per-account cursors.
 * Provider (JS-side) failures are caught per account and recorded in last_error;
 * SQL failures abort the surrounding transaction as usual.
 */
export async function syncConnection(
  tx: PoolClient, ctx: TenantContext, provider: BankFeedProvider, connectionId: string, todayIso: string,
): Promise<SyncResult> {
  const conn = await tx.query(
    `SELECT provider_requisition_id AS "requisitionId" FROM bank_feed_connections
     WHERE id = $1 AND client_company_id = $2 FOR UPDATE`,
    [connectionId, ctx.clientCompanyId],
  );
  if (!conn.rowCount) throw new Error('bank feed connection not found');

  const req = await provider.getRequisition(conn.rows[0].requisitionId as string);
  await tx.query(
    `UPDATE bank_feed_connections SET status = $1, consent_expires_at = $2, updated_at = now()
     WHERE id = $3 AND client_company_id = $4`,
    [req.status, req.consentExpiresAt, connectionId, ctx.clientCompanyId],
  );
  if (req.status !== 'linked') {
    await appendAudit(tx, ctx, {
      action: 'sync', entityType: 'bank_feed_connection', entityId: connectionId,
      before: null, after: { status: req.status, accounts: [] },
    });
    return { connectionId, status: req.status, accounts: [], proposals: 0 };
  }

  const accounts = await tx.query(
    `SELECT id, provider_account_id AS "providerAccountId", iban, last_synced_date::text AS "lastSyncedDate"
     FROM bank_feed_accounts WHERE connection_id = $1 AND client_company_id = $2 ORDER BY iban`,
    [connectionId, ctx.clientCompanyId],
  );

  const results: AccountSyncResult[] = [];
  let lastError = '';
  for (const a of accounts.rows) {
    const from = a.lastSyncedDate
      ? isoAddDays(a.lastSyncedDate as string, -OVERLAP_DAYS)
      : isoAddDays(todayIso, -FIRST_SYNC_DAYS);
    try {
      const feed = await provider.fetchTransactions(a.providerAccountId as string, from);
      const stmt: BankStatement = { account: a.iban as string, transactions: feed.map(feedTxnToBankTxn) };
      const r = await importStatement(tx, ctx, stmt);
      await tx.query(`UPDATE bank_feed_accounts SET last_synced_date = $1 WHERE id = $2 AND client_company_id = $3`,
        [todayIso, a.id, ctx.clientCompanyId]);
      results.push({ iban: a.iban as string, imported: r.imported, skipped: r.skipped, error: null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastError = lastError || `${a.iban}: ${msg}`;
      results.push({ iban: a.iban as string, imported: 0, skipped: 0, error: msg });
    }
  }

  const ar = await proposeMatches(tx, ctx, AR_MATCH);
  const ap = await proposeApMatches(tx, ctx, AP_MATCH);
  await tx.query(
    `UPDATE bank_feed_connections SET last_error = $1, updated_at = now() WHERE id = $2 AND client_company_id = $3`,
    [lastError, connectionId, ctx.clientCompanyId],
  );
  const proposals = ar.proposalIds.length + ap.proposalIds.length;
  await appendAudit(tx, ctx, {
    action: 'sync', entityType: 'bank_feed_connection', entityId: connectionId,
    before: null, after: { status: 'linked', accounts: results, proposals },
  });
  return { connectionId, status: 'linked', accounts: results, proposals };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/bankfeed/sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full backend suite**

Run: `npm test`
Expected: all green (no regressions in banking/proposals).

- [ ] **Step 6: Commit**

```bash
git add src/bankfeed/sync.ts tests/bankfeed/sync.test.ts
git commit -m "feat(bankfeed): sync engine — cursors, overlap dedup, per-account errors, auto-matching"
```

---

### Task 4: GoCardless provider + factory + manual sandbox script

**Files:**
- Create: `src/bankfeed/gocardless.ts`
- Create: `src/bankfeed/factory.ts`
- Create: `scripts/bankfeed-sandbox.ts`
- Test: `tests/bankfeed/gocardless.test.ts`

**Interfaces:**
- Consumes: `BankFeedProvider`, `FeedTxn`, `Institution`, `RequisitionState` (Task 1).
- Produces: `GoCardlessProvider` (class, `new GoCardlessProvider(secretId, secretKey)`); pure mappers `mapRequisitionStatus(gc: string)`, `mapBookedTransaction(json: GcBookedTransaction): FeedTxn`, `consentExpiry(accepted: string | null, accessValidForDays: number | null): string | null`; `makeBankFeedProvider(): BankFeedProvider` (factory.ts, module-level singleton).

- [ ] **Step 1: Write the failing mapper test**

`tests/bankfeed/gocardless.test.ts`:

```ts
import { expect, test } from 'vitest';
import { mapRequisitionStatus, mapBookedTransaction, consentExpiry } from '../../src/bankfeed/gocardless.js';

test('requisition status mapping', () => {
  expect(mapRequisitionStatus('LN')).toBe('linked');
  expect(mapRequisitionStatus('EX')).toBe('expired');
  expect(mapRequisitionStatus('RJ')).toBe('revoked');
  expect(mapRequisitionStatus('SU')).toBe('revoked');
  for (const s of ['CR', 'GC', 'UA', 'GA', 'SA', '??']) expect(mapRequisitionStatus(s)).toBe('pending');
});

test('booked transaction mapping — debit takes creditorName, remittance array joined', () => {
  const f = mapBookedTransaction({
    transactionId: 'gc-tx-9',
    bookingDate: '2026-07-15',
    transactionAmount: { amount: '-60.50', currency: 'EUR' },
    remittanceInformationUnstructuredArray: ['PO-77', 'part 2'],
    creditorName: 'SIA Piegādātājs',
  });
  expect(f).toEqual({
    bookingDate: '2026-07-15', amount: '-60.50', currency: 'EUR',
    reference: 'PO-77 part 2', counterparty: 'SIA Piegādātājs',
    endToEndId: '', providerTxId: 'gc-tx-9',
  });
});

test('booked transaction mapping — credit takes debtorName, endToEndId kept, internal id fallback', () => {
  const f = mapBookedTransaction({
    internalTransactionId: 'int-1',
    bookingDate: '2026-07-15',
    transactionAmount: { amount: '121.00', currency: 'EUR' },
    remittanceInformationUnstructured: 'INV-2026-001',
    debtorName: 'SIA Klients',
    endToEndId: 'INV-2026-001',
  });
  expect(f.counterparty).toBe('SIA Klients');
  expect(f.endToEndId).toBe('INV-2026-001');
  expect(f.providerTxId).toBe('int-1');
  expect(f.amount).toBe('121.00');
});

test('consent expiry = accepted + access_valid_for_days', () => {
  expect(consentExpiry('2026-07-19T10:00:00Z', 90)).toBe('2026-10-17T10:00:00.000Z');
  expect(consentExpiry(null, 90)).toBeNull();
  expect(consentExpiry('2026-07-19T10:00:00Z', null)).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/bankfeed/gocardless.test.ts`
Expected: FAIL — cannot resolve `src/bankfeed/gocardless.js`.

- [ ] **Step 3: Implement the provider**

`src/bankfeed/gocardless.ts`:

```ts
import type { BankFeedProvider, FeedTxn, Institution, RequisitionState, FeedConnectionStatus } from './provider.js';

const BASE = 'https://bankaccountdata.gocardless.com/api/v2';

// GoCardless requisition statuses: CR created, GC giving consent, UA undergoing
// authentication, GA granting access, SA selecting accounts, LN linked,
// EX expired, RJ rejected, SU suspended.
export function mapRequisitionStatus(gc: string): FeedConnectionStatus {
  if (gc === 'LN') return 'linked';
  if (gc === 'EX') return 'expired';
  if (gc === 'RJ' || gc === 'SU') return 'revoked';
  return 'pending';
}

export interface GcBookedTransaction {
  transactionId?: string;
  internalTransactionId?: string;
  bookingDate?: string;
  transactionAmount?: { amount?: string; currency?: string };
  remittanceInformationUnstructured?: string;
  remittanceInformationUnstructuredArray?: string[];
  endToEndId?: string;
  debtorName?: string;
  creditorName?: string;
}

export function mapBookedTransaction(t: GcBookedTransaction): FeedTxn {
  const amount = t.transactionAmount?.amount ?? '0';
  const debit = amount.startsWith('-');
  return {
    bookingDate: t.bookingDate ?? '',
    amount,
    currency: t.transactionAmount?.currency ?? 'EUR',
    reference: t.remittanceInformationUnstructured ?? (t.remittanceInformationUnstructuredArray ?? []).join(' '),
    counterparty: (debit ? t.creditorName : t.debtorName) ?? '',
    endToEndId: t.endToEndId ?? '',
    providerTxId: t.transactionId ?? t.internalTransactionId ?? '',
  };
}

export function consentExpiry(accepted: string | null, accessValidForDays: number | null): string | null {
  if (!accepted || !accessValidForDays) return null;
  const d = new Date(accepted);
  d.setUTCDate(d.getUTCDate() + accessValidForDays);
  return d.toISOString();
}

/** All failures throw Errors prefixed `bank feed provider` — the routes map that prefix to HTTP 502. */
export class GoCardlessProvider implements BankFeedProvider {
  readonly name = 'gocardless';
  private token: { access: string; expiresAt: number } | null = null;
  constructor(private secretId: string, private secretKey: string) {}

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.access;
    const res = await fetch(`${BASE}/token/new/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret_id: this.secretId, secret_key: this.secretKey }),
    });
    if (!res.ok) throw new Error(`bank feed provider: token request failed (${res.status})`);
    const body = (await res.json()) as { access: string; access_expires: number };
    this.token = { access: body.access, expiresAt: Date.now() + (body.access_expires - 60) * 1000 };
    return this.token.access;
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await this.accessToken();
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`bank feed provider: ${init?.method ?? 'GET'} ${path} failed (${res.status}) ${detail.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  async listInstitutions(country: string): Promise<Institution[]> {
    const list = await this.api<{ id: string; name: string; logo?: string }[]>(`/institutions/?country=${encodeURIComponent(country)}`);
    return list.map((i) => ({ id: i.id, name: i.name, logoUrl: i.logo }));
  }

  async startConsent(institutionId: string, redirectUrl: string, reference: string) {
    const req = await this.api<{ id: string; link: string }>('/requisitions/', {
      method: 'POST',
      body: JSON.stringify({ institution_id: institutionId, redirect: redirectUrl, reference }),
    });
    return { requisitionId: req.id, consentUrl: req.link };
  }

  async getRequisition(requisitionId: string): Promise<RequisitionState> {
    const req = await this.api<{ status: string; accounts: string[]; agreement?: string }>(`/requisitions/${requisitionId}/`);
    const status = mapRequisitionStatus(req.status);
    let consentExpiresAt: string | null = null;
    if (req.agreement) {
      const agr = await this.api<{ accepted?: string | null; access_valid_for_days?: number }>(`/agreements/enduser/${req.agreement}/`);
      consentExpiresAt = consentExpiry(agr.accepted ?? null, agr.access_valid_for_days ?? null);
    }
    const accounts: RequisitionState['accounts'] = [];
    if (status === 'linked') {
      for (const accountId of req.accounts) {
        const det = await this.api<{ account?: { iban?: string; currency?: string } }>(`/accounts/${accountId}/details/`);
        accounts.push({ providerAccountId: accountId, iban: det.account?.iban ?? '', currency: det.account?.currency ?? 'EUR' });
      }
    }
    return { status, consentExpiresAt, accounts };
  }

  async fetchTransactions(providerAccountId: string, fromDate: string): Promise<FeedTxn[]> {
    const body = await this.api<{ transactions?: { booked?: GcBookedTransaction[] } }>(
      `/accounts/${providerAccountId}/transactions/?date_from=${encodeURIComponent(fromDate)}`);
    return (body.transactions?.booked ?? []).map(mapBookedTransaction);
  }

  async deleteRequisition(requisitionId: string): Promise<void> {
    await this.api(`/requisitions/${requisitionId}/`, { method: 'DELETE' });
  }
}
```

- [ ] **Step 4: Implement the factory**

`src/bankfeed/factory.ts`:

```ts
import type { BankFeedProvider } from './provider.js';
import { GoCardlessProvider } from './gocardless.js';
import { StubBankFeedProvider } from './stub.js';

let instance: BankFeedProvider | null = null;

/**
 * GoCardless when credentials are present, auto-linking stub otherwise (keyless dev).
 * Singleton so the stub's in-memory requisitions survive across route invocations
 * within one dev server process. Tests construct StubBankFeedProvider directly.
 */
export function makeBankFeedProvider(): BankFeedProvider {
  if (!instance) {
    const id = process.env.GOCARDLESS_SECRET_ID;
    const key = process.env.GOCARDLESS_SECRET_KEY;
    instance = id && key ? new GoCardlessProvider(id, key) : new StubBankFeedProvider({ autoLink: true });
  }
  return instance;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/bankfeed/gocardless.test.ts && npx tsc --noEmit`
Expected: PASS, typecheck clean.

- [ ] **Step 6: Write the manual sandbox script (not part of the test suite)**

`scripts/bankfeed-sandbox.ts` — run with `GOCARDLESS_SECRET_ID=... GOCARDLESS_SECRET_KEY=... npx tsx scripts/bankfeed-sandbox.ts [requisitionId]`:

```ts
/**
 * Manual end-to-end check against the GoCardless sandbox (SANDBOXFINANCE_SFIN0000).
 * Pass 1 (no arg): creates a requisition, prints the consent URL — open it, approve.
 * Pass 2 (requisition id as arg): prints linked accounts + a page of transactions.
 * Never run by the test suite.
 */
import { GoCardlessProvider } from '../src/bankfeed/gocardless.js';

const provider = new GoCardlessProvider(process.env.GOCARDLESS_SECRET_ID!, process.env.GOCARDLESS_SECRET_KEY!);
const requisitionId = process.argv[2];

if (!requisitionId) {
  const { requisitionId: id, consentUrl } = await provider.startConsent(
    'SANDBOXFINANCE_SFIN0000', 'http://localhost:3000/bank/callback', `sandbox-${Math.floor(Math.random() * 1e9)}`);
  console.log(`requisition: ${id}\nopen and approve: ${consentUrl}\nthen: npx tsx scripts/bankfeed-sandbox.ts ${id}`);
} else {
  const req = await provider.getRequisition(requisitionId);
  console.log('status:', req.status, 'consentExpiresAt:', req.consentExpiresAt);
  for (const a of req.accounts) {
    console.log(`account ${a.iban} (${a.providerAccountId})`);
    const txns = await provider.fetchTransactions(a.providerAccountId, '2026-01-01');
    console.log(JSON.stringify(txns.slice(0, 5), null, 2));
  }
}
```

- [ ] **Step 7: Commit**

```bash
git add src/bankfeed/gocardless.ts src/bankfeed/factory.ts scripts/bankfeed-sandbox.ts tests/bankfeed/gocardless.test.ts
git commit -m "feat(bankfeed): GoCardless provider, env factory, manual sandbox script"
```

---

### Task 5: Cron sweep (`src/bankfeed/cron.ts`)

**Files:**
- Create: `src/bankfeed/cron.ts`
- Test: `tests/bankfeed/cron.test.ts`

**Interfaces:**
- Consumes: `syncConnection` (Task 3); `appPool`, `withTenant` from `src/db/pool.js`.
- Produces:

```ts
export function systemContext(firmId: string, clientCompanyId: string): TenantContext  // actorId 'system:bank-sync', actorRole 'agent'
export async function syncAllClients(provider: BankFeedProvider, todayIso: string): Promise<{ synced: number; failed: number }>
```

- [ ] **Step 1: Write the failing test**

`tests/bankfeed/cron.test.ts`:

```ts
import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { randomUUID } from 'node:crypto';
import { StubBankFeedProvider } from '../../src/bankfeed/stub.js';
import { createConnection, finalizeConnection, listConnections } from '../../src/bankfeed/connections.js';
import { syncAllClients } from '../../src/bankfeed/cron.js';
import type { FeedTxn } from '../../src/bankfeed/provider.js';

const TODAY = '2026-07-19';
const txn = (id: string): FeedTxn => ({ bookingDate: '2026-07-10', amount: '10.00', currency: 'EUR',
  reference: '', counterparty: '', endToEndId: '', providerTxId: id });

async function linked(t: { firmId: string; clientCompanyId: string }, p: StubBankFeedProvider, acc: string) {
  const connectionId = randomUUID();
  await withTenant(ctx(t), (tx) =>
    createConnection(tx, ctx(t), p, { connectionId, institutionId: 'STUB_BANK', institutionName: 'Stub', redirectUrl: 'http://x' }));
  const reqId = (await withTenant(ctx(t), (tx) => listConnections(tx, ctx(t))))[0]!.providerRequisitionId;
  p.linkRequisition(reqId, [{ providerAccountId: acc, iban: `LV${acc.padStart(19, '0')}`, currency: 'EUR' }], null);
  await withTenant(ctx(t), (tx) => finalizeConnection(tx, ctx(t), p, connectionId));
  return connectionId;
}

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('syncs linked connections across two clients with a system context', async () => {
  const a = await makeFirmAndClient('SIA A');
  const b = await makeFirmAndClient('SIA B');
  const p = new StubBankFeedProvider();
  await linked(a, p, '1');
  await linked(b, p, '2');
  p.transactionsByAccount.set('1', [txn('a1')]);
  p.transactionsByAccount.set('2', [txn('b1')]);

  const r = await syncAllClients(p, TODAY);
  expect(r).toEqual({ synced: 2, failed: 0 });
  for (const t of [a, b]) {
    const n = await withTenant(ctx(t), async (tx) => (await tx.query('SELECT count(*)::int AS n FROM bank_transactions')).rows[0].n);
    expect(n).toBe(1);
  }
  // audit attributed to the system actor
  const actor = await withTenant(ctx(a), async (tx) =>
    (await tx.query(`SELECT actor_id FROM audit_log WHERE action = 'sync' LIMIT 1`)).rows[0].actor_id);
  expect(actor).toBe('system:bank-sync');
});

test('one failing connection does not block the other client', async () => {
  const a = await makeFirmAndClient('SIA A');
  const b = await makeFirmAndClient('SIA B');
  const p = new StubBankFeedProvider();
  await linked(a, p, '1');
  await linked(b, p, '2');
  p.transactionsByAccount.set('2', [txn('b1')]);
  // getRequisition failure = connection-level failure (not per-account)
  const reqA = (await withTenant(ctx(a), (tx) => listConnections(tx, ctx(a))))[0]!;
  p.setStatus(reqA.providerRequisitionId, 'pending');
  const orig = p.getRequisition.bind(p);
  p.getRequisition = async (id: string) => {
    if (id === reqA.providerRequisitionId) throw new Error('provider down');
    return orig(id);
  };

  const r = await syncAllClients(p, TODAY);
  expect(r).toEqual({ synced: 1, failed: 1 });
  const connA = (await withTenant(ctx(a), (tx) => listConnections(tx, ctx(a))))[0]!;
  expect(connA.lastError).toMatch(/provider down/);
  const nB = await withTenant(ctx(b), async (tx) => (await tx.query('SELECT count(*)::int AS n FROM bank_transactions')).rows[0].n);
  expect(nB).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/bankfeed/cron.test.ts`
Expected: FAIL — cannot resolve `src/bankfeed/cron.js`.

- [ ] **Step 3: Implement**

`src/bankfeed/cron.ts`:

```ts
import { appPool, withTenant } from '../db/pool.js';
import type { TenantContext } from '../tenancy/context.js';
import type { BankFeedProvider } from './provider.js';
import { syncConnection } from './sync.js';

/** Cron has no session — a system actor so audit rows are honestly attributed. */
export function systemContext(firmId: string, clientCompanyId: string): TenantContext {
  return { firmId, clientCompanyId, actorId: 'system:bank-sync', actorRole: 'agent' };
}

/**
 * Daily sweep: sync every linked connection of every client. client_companies has
 * no RLS; each connection syncs in its own withTenant transaction so one failure
 * (recorded on the connection) never rolls back or blocks the others.
 */
export async function syncAllClients(provider: BankFeedProvider, todayIso: string): Promise<{ synced: number; failed: number }> {
  const clients = await appPool.query(`SELECT id, firm_id AS "firmId" FROM client_companies ORDER BY created_at`);
  let synced = 0; let failed = 0;
  for (const c of clients.rows) {
    const ctx = systemContext(c.firmId as string, c.id as string);
    const conns = await withTenant(ctx, async (tx) =>
      (await tx.query(`SELECT id FROM bank_feed_connections WHERE status = 'linked' ORDER BY created_at`)).rows as { id: string }[]);
    for (const conn of conns) {
      try {
        await withTenant(ctx, (tx) => syncConnection(tx, ctx, provider, conn.id, todayIso));
        synced++;
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        await withTenant(ctx, (tx) =>
          tx.query(`UPDATE bank_feed_connections SET last_error = $1, updated_at = now() WHERE id = $2`, [msg, conn.id]),
        ).catch(() => { /* recording the error must not kill the sweep */ });
      }
    }
  }
  return { synced, failed };
}
```

Note: if `client_companies` has no `created_at` column, drop the `ORDER BY created_at` from the clients query (check `migrations/001_firms_clients.sql`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/bankfeed/cron.test.ts && npm test`
Expected: PASS, full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/bankfeed/cron.ts tests/bankfeed/cron.test.ts
git commit -m "feat(bankfeed): cross-tenant cron sweep with system actor and failure isolation"
```

---

### Task 6: API routes

**Files:**
- Create: `web/app/api/bank/institutions/route.ts`
- Create: `web/app/api/bank/connections/route.ts` (GET list, POST create)
- Create: `web/app/api/bank/connections/[id]/route.ts` (DELETE)
- Create: `web/app/api/bank/connections/[id]/finalize/route.ts` (POST)
- Create: `web/app/api/bank/connections/[id]/sync/route.ts` (POST)
- Create: `web/app/api/cron/bank-sync/route.ts` (GET)

**Interfaces:**
- Consumes: everything from Tasks 2–5 via `@domain/bankfeed/*.js`; `getSessionToken`, `nowUnix` from `@/app/lib/session`; `assertRoleAllowed`, `errorToStatus` from `@/app/lib/authz`.
- Produces (the UI task consumes these JSON shapes):
  - `GET /api/bank/institutions?clientCompanyId&country=lv` → `{ institutions: Institution[] }`
  - `GET /api/bank/connections?clientCompanyId` → `{ connections: FeedConnectionRow[] }`
  - `POST /api/bank/connections` `{ clientCompanyId, institutionId, institutionName }` → `{ connectionId, consentUrl }`
  - `POST /api/bank/connections/:id/finalize` `{ clientCompanyId }` → `{ connection: FeedConnectionRow, sync: SyncResult | null }`
  - `POST /api/bank/connections/:id/sync` `{ clientCompanyId }` → `SyncResult`
  - `DELETE /api/bank/connections/:id?clientCompanyId` → `{ ok: true }`
  - `GET /api/cron/bank-sync` (Bearer `CRON_SECRET`) → `{ synced, failed }`

There are no route-level tests in this repo (domain tests cover logic); verification is `npx tsc --noEmit` in `web/` plus the manual acceptance pass in Task 8. Before writing, skim `web/app/api/bank/import/route.ts` (flat route) and `web/app/api/parties/[id]/route.ts` (dynamic `await ctx.params` pattern) — copy their structure exactly.

- [ ] **Step 1: Shared error mapping for provider failures**

Every route in this task maps errors like this (provider prefix → 502):

```ts
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  const status = /bank feed provider/.test(msg) ? 502 : errorToStatus(msg);
  return NextResponse.json({ error: msg }, { status });
}
```

- [ ] **Step 2: Implement `web/app/api/bank/institutions/route.ts`**

```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { makeBankFeedProvider } from '@domain/bankfeed/factory.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { errorToStatus } from '@/app/lib/authz';

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const country = req.nextUrl.searchParams.get('country') ?? 'lv';
  try {
    await resolveTenantContext(token, clientCompanyId, nowUnix());
    const institutions = await makeBankFeedProvider().listInstitutions(country);
    return NextResponse.json({ institutions }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = /bank feed provider/.test(msg) ? 502 : errorToStatus(msg);
    return NextResponse.json({ error: msg }, { status });
  }
}
```

- [ ] **Step 3: Implement `web/app/api/bank/connections/route.ts`**

```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { createConnection, listConnections } from '@domain/bankfeed/connections.js';
import { makeBankFeedProvider } from '@domain/bankfeed/factory.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

function fail(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  const status = /bank feed provider/.test(msg) ? 502 : errorToStatus(msg);
  return NextResponse.json({ error: msg }, { status });
}

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const connections = await withTenant(ctx, (tx) => listConnections(tx, ctx));
    return NextResponse.json({ connections }, { status: 200 });
  } catch (err) { return fail(err); }
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string; institutionId?: string; institutionName?: string };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.institutionId) return NextResponse.json({ error: 'missing institutionId' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'bank.write');
    const connectionId = randomUUID();
    const redirectUrl = `${req.nextUrl.origin}/bank/callback?cid=${connectionId}&client=${encodeURIComponent(body.clientCompanyId)}`;
    const result = await withTenant(ctx, (tx) =>
      createConnection(tx, ctx, makeBankFeedProvider(), {
        connectionId, institutionId: body.institutionId!,
        institutionName: body.institutionName ?? body.institutionId!, redirectUrl,
      }));
    return NextResponse.json(result, { status: 200 });
  } catch (err) { return fail(err); }
}
```

- [ ] **Step 4: Implement the three dynamic routes**

`web/app/api/bank/connections/[id]/finalize/route.ts` (finalize + first sync inline when linked):

```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { finalizeConnection } from '@domain/bankfeed/connections.js';
import { syncConnection, type SyncResult } from '@domain/bankfeed/sync.js';
import { makeBankFeedProvider } from '@domain/bankfeed/factory.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

export async function POST(req: NextRequest, routeCtx: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const { id } = await routeCtx.params;
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'bank.write');
    const provider = makeBankFeedProvider();
    const todayIso = new Date().toISOString().slice(0, 10);
    const result = await withTenant(ctx, async (tx) => {
      const connection = await finalizeConnection(tx, ctx, provider, id);
      let sync: SyncResult | null = null;
      if (connection.status === 'linked') sync = await syncConnection(tx, ctx, provider, id, todayIso);
      return { connection, sync };
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = /bank feed provider/.test(msg) ? 502 : errorToStatus(msg);
    return NextResponse.json({ error: msg }, { status });
  }
}
```

`web/app/api/bank/connections/[id]/sync/route.ts` — identical skeleton; body of the try block:

```ts
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'bank.write');
    const todayIso = new Date().toISOString().slice(0, 10);
    const result = await withTenant(ctx, (tx) => syncConnection(tx, ctx, makeBankFeedProvider(), id, todayIso));
    return NextResponse.json(result, { status: 200 });
```

`web/app/api/bank/connections/[id]/route.ts` — DELETE; `clientCompanyId` comes from the query string (DELETE bodies are unreliable):

```ts
export async function DELETE(req: NextRequest, routeCtx: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const { id } = await routeCtx.params;
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'bank.write');
    await withTenant(ctx, (tx) => deleteConnection(tx, ctx, makeBankFeedProvider(), id));
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = /bank feed provider/.test(msg) ? 502 : errorToStatus(msg);
    return NextResponse.json({ error: msg }, { status });
  }
}
```

- [ ] **Step 5: Implement `web/app/api/cron/bank-sync/route.ts`**

```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { syncAllClients } from '@domain/bankfeed/cron.js';
import { makeBankFeedProvider } from '@domain/bankfeed/factory.js';

/** Vercel cron entrypoint. Fail closed: no CRON_SECRET configured → always 401. */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const result = await syncAllClients(makeBankFeedProvider(), new Date().toISOString().slice(0, 10));
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
```

- [ ] **Step 6: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: clean. (Root too: `npx tsc --noEmit`.)

- [ ] **Step 7: Commit**

```bash
git add web/app/api/bank/institutions web/app/api/bank/connections web/app/api/cron
git commit -m "feat(bankfeed): API routes — institutions, connections CRUD, finalize, sync, cron"
```

---

### Task 7: UI — Bank feeds section, callback page, i18n

**Files:**
- Create: `web/app/(cabinet)/bank/FeedsSection.tsx`
- Create: `web/app/(cabinet)/bank/callback/page.tsx`
- Modify: `web/app/(cabinet)/bank/page.tsx` (render `<FeedsSection clientCompanyId={...} />` as the FIRST section inside `<main>`, above the upload card)
- Modify: `web/app/lib/i18n.ts` (all three catalogs)

**Interfaces:**
- Consumes: Task 6 route JSON shapes; `useMessages` from `@/app/lib/i18n-context`; `LOCALE_FOR`, `MsgKey` from `@/app/lib/i18n`; css classes from `bank/page.module.css` (`card`, `sectionHeading`, `hint`, `primaryBtn`, `ghostBtn`, `okMsg`, `formError`, `tableWrapper`, `table`, `field`, `formActions`).
- Produces: nothing downstream.

- [ ] **Step 1: Add i18n keys**

Add to `EN` in `web/app/lib/i18n.ts` (then mirror in `LV` and `RU` — the typed record fails the build if any key is missing):

```ts
'bankfeed.title': 'Bank feeds',
'bankfeed.hint': 'Connected banks import transactions automatically every day. Uploads below remain available for other banks.',
'bankfeed.connect': 'Connect a bank',
'bankfeed.institution': 'Bank',
'bankfeed.choosePrompt': 'Choose your bank…',
'bankfeed.start': 'Continue to the bank',
'bankfeed.cancel': 'Cancel',
'bankfeed.syncNow': 'Sync now',
'bankfeed.reconnect': 'Reconnect',
'bankfeed.remove': 'Remove',
'bankfeed.status.pending': 'Awaiting consent',
'bankfeed.status.linked': 'Connected',
'bankfeed.status.expired': 'Consent expired',
'bankfeed.status.revoked': 'Consent revoked',
'bankfeed.lastSynced': 'Last synced {date}',
'bankfeed.neverSynced': 'Not synced yet',
'bankfeed.expires': 'Consent valid until {date}',
'bankfeed.expiresSoon': 'Consent expires {date} — reconnect soon',
'bankfeed.synced': 'Imported {imported}, already known {skipped}, proposals {proposals}',
'bankfeed.empty': 'No banks connected',
'bankfeed.emptyDetail': 'Connect a bank to import transactions automatically, or upload camt.053 files below.',
'bankfeed.accounts': 'Accounts',
'bankfeedcb.title': 'Finishing bank connection…',
'bankfeedcb.working': 'Confirming consent with the bank…',
'bankfeedcb.done': 'Bank connected. First import finished.',
'bankfeedcb.fail': 'Could not finish the connection',
'bankfeedcb.back': 'Back to Bank',
```

LV translations:

```ts
'bankfeed.title': 'Bankas plūsmas',
'bankfeed.hint': 'Pievienotās bankas ik dienu automātiski importē darījumus. Pārējām bankām joprojām pieejama failu augšupielāde zemāk.',
'bankfeed.connect': 'Pievienot banku',
'bankfeed.institution': 'Banka',
'bankfeed.choosePrompt': 'Izvēlieties banku…',
'bankfeed.start': 'Turpināt uz banku',
'bankfeed.cancel': 'Atcelt',
'bankfeed.syncNow': 'Sinhronizēt tūlīt',
'bankfeed.reconnect': 'Pievienot no jauna',
'bankfeed.remove': 'Noņemt',
'bankfeed.status.pending': 'Gaida piekrišanu',
'bankfeed.status.linked': 'Pievienota',
'bankfeed.status.expired': 'Piekrišanas termiņš beidzies',
'bankfeed.status.revoked': 'Piekrišana atsaukta',
'bankfeed.lastSynced': 'Pēdējā sinhronizācija {date}',
'bankfeed.neverSynced': 'Vēl nav sinhronizēta',
'bankfeed.expires': 'Piekrišana derīga līdz {date}',
'bankfeed.expiresSoon': 'Piekrišana beidzas {date} — pievienojiet no jauna',
'bankfeed.synced': 'Importēti {imported}, jau zināmi {skipped}, priekšlikumi {proposals}',
'bankfeed.empty': 'Nav pievienotu banku',
'bankfeed.emptyDetail': 'Pievienojiet banku, lai darījumi importētos automātiski, vai augšupielādējiet camt.053 failus zemāk.',
'bankfeed.accounts': 'Konti',
'bankfeedcb.title': 'Pabeidz bankas pievienošanu…',
'bankfeedcb.working': 'Apstiprina piekrišanu ar banku…',
'bankfeedcb.done': 'Banka pievienota. Pirmais imports pabeigts.',
'bankfeedcb.fail': 'Neizdevās pabeigt pievienošanu',
'bankfeedcb.back': 'Atpakaļ uz Banku',
```

RU translations:

```ts
'bankfeed.title': 'Банковские каналы',
'bankfeed.hint': 'Подключённые банки ежедневно импортируют операции автоматически. Для остальных банков доступна загрузка файлов ниже.',
'bankfeed.connect': 'Подключить банк',
'bankfeed.institution': 'Банк',
'bankfeed.choosePrompt': 'Выберите банк…',
'bankfeed.start': 'Перейти в банк',
'bankfeed.cancel': 'Отмена',
'bankfeed.syncNow': 'Синхронизировать',
'bankfeed.reconnect': 'Подключить заново',
'bankfeed.remove': 'Удалить',
'bankfeed.status.pending': 'Ожидает согласия',
'bankfeed.status.linked': 'Подключён',
'bankfeed.status.expired': 'Срок согласия истёк',
'bankfeed.status.revoked': 'Согласие отозвано',
'bankfeed.lastSynced': 'Последняя синхронизация {date}',
'bankfeed.neverSynced': 'Ещё не синхронизирован',
'bankfeed.expires': 'Согласие действует до {date}',
'bankfeed.expiresSoon': 'Согласие истекает {date} — подключите заново',
'bankfeed.synced': 'Импортировано {imported}, уже известно {skipped}, предложений {proposals}',
'bankfeed.empty': 'Нет подключённых банков',
'bankfeed.emptyDetail': 'Подключите банк для автоматического импорта операций или загрузите файлы camt.053 ниже.',
'bankfeed.accounts': 'Счета',
'bankfeedcb.title': 'Завершение подключения банка…',
'bankfeedcb.working': 'Подтверждаем согласие с банком…',
'bankfeedcb.done': 'Банк подключён. Первый импорт завершён.',
'bankfeedcb.fail': 'Не удалось завершить подключение',
'bankfeedcb.back': 'Назад к банку',
```

- [ ] **Step 2: Implement `FeedsSection.tsx`**

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useMessages } from '@/app/lib/i18n-context';
import type { MsgKey } from '@/app/lib/i18n';
import { LOCALE_FOR } from '@/app/lib/i18n';
import { EmptyState } from '@/app/components/EmptyState';
import styles from './page.module.css';

interface FeedAccountRow { id: string; providerAccountId: string; iban: string; currency: string; lastSyncedDate: string | null }
interface FeedConnectionRow {
  id: string; provider: string; providerRequisitionId: string; institutionId: string; institutionName: string;
  status: string; consentExpiresAt: string | null; lastError: string; createdAt: string; accounts: FeedAccountRow[];
}
interface Institution { id: string; name: string; logoUrl?: string }

const EXPIRY_WARN_DAYS = 14;

export function FeedsSection({ clientCompanyId }: { clientCompanyId: string }) {
  const { t, lang } = useMessages();
  const [connections, setConnections] = useState<FeedConnectionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // connection id or 'connect'
  const [picking, setPicking] = useState(false);
  const [institutions, setInstitutions] = useState<Institution[] | null>(null);
  const [chosen, setChosen] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/bank/connections?clientCompanyId=${encodeURIComponent(clientCompanyId)}`, { cache: 'no-store' });
      const body = (await res.json().catch(() => ({}))) as { connections?: FeedConnectionRow[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setConnections(body.connections ?? []);
    } catch (err) { setError((err as Error).message); }
  }, [clientCompanyId]);

  useEffect(() => { load(); }, [load]);

  async function openPicker() {
    setPicking(true);
    if (institutions) return;
    try {
      const res = await fetch(`/api/bank/institutions?clientCompanyId=${encodeURIComponent(clientCompanyId)}`, { cache: 'no-store' });
      const body = (await res.json().catch(() => ({}))) as { institutions?: Institution[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setInstitutions(body.institutions ?? []);
    } catch (err) { setError((err as Error).message); setPicking(false); }
  }

  async function connect() {
    if (!chosen) return;
    setBusy('connect');
    setError(null);
    try {
      const inst = institutions?.find((i) => i.id === chosen);
      const res = await fetch('/api/bank/connections', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientCompanyId, institutionId: chosen, institutionName: inst?.name ?? chosen }),
      });
      const body = (await res.json().catch(() => ({}))) as { consentUrl?: string; error?: string };
      if (!res.ok || !body.consentUrl) throw new Error(body.error ?? `HTTP ${res.status}`);
      window.location.href = body.consentUrl;
    } catch (err) { setError((err as Error).message); setBusy(null); }
  }

  async function syncNow(id: string) {
    setBusy(id); setError(null); setMsg(null);
    try {
      const res = await fetch(`/api/bank/connections/${id}/sync`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientCompanyId }),
      });
      const body = (await res.json().catch(() => ({}))) as
        { accounts?: { imported: number; skipped: number }[]; proposals?: number; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      const imported = (body.accounts ?? []).reduce((n, a) => n + a.imported, 0);
      const skipped = (body.accounts ?? []).reduce((n, a) => n + a.skipped, 0);
      setMsg(t('bankfeed.synced')
        .replace('{imported}', String(imported)).replace('{skipped}', String(skipped))
        .replace('{proposals}', String(body.proposals ?? 0)));
      await load();
    } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }

  async function remove(id: string) {
    setBusy(id); setError(null);
    try {
      const res = await fetch(`/api/bank/connections/${id}?clientCompanyId=${encodeURIComponent(clientCompanyId)}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      await load();
    } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }

  const fmtDate = (iso: string) =>
    new Intl.DateTimeFormat(LOCALE_FOR[lang], { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
  const statusLabel = (s: string) => {
    const key = `bankfeed.status.${s}` as MsgKey;
    const label = t(key);
    return label === key ? s : label;
  };
  const expiresSoon = (c: FeedConnectionRow) =>
    c.consentExpiresAt !== null &&
    new Date(c.consentExpiresAt).getTime() - Date.now() < EXPIRY_WARN_DAYS * 86_400_000;

  return (
    <section className={styles.card} aria-labelledby="feeds-heading">
      <h2 id="feeds-heading" className={styles.sectionHeading}>{t('bankfeed.title')}</h2>
      <p className={styles.hint}>{t('bankfeed.hint')}</p>
      {error && <p className={styles.formError} role="alert">{error}</p>}
      {msg && <p className={styles.okMsg} role="status">{msg}</p>}

      {connections && connections.length === 0 && !picking && (
        <EmptyState message={t('bankfeed.empty')} detail={t('bankfeed.emptyDetail')} />
      )}

      {connections?.map((c) => (
        <div key={c.id} className={styles.paymentRow}>
          <div>
            <strong>{c.institutionName}</strong> — {statusLabel(c.status)}
            {c.accounts.map((a) => (
              <div key={a.id} className={styles.hint}>
                {a.iban} · {a.lastSyncedDate
                  ? t('bankfeed.lastSynced').replace('{date}', fmtDate(a.lastSyncedDate))
                  : t('bankfeed.neverSynced')}
              </div>
            ))}
            {c.consentExpiresAt && c.status === 'linked' && (
              <div className={styles.hint}>
                {(expiresSoon(c) ? t('bankfeed.expiresSoon') : t('bankfeed.expires'))
                  .replace('{date}', fmtDate(c.consentExpiresAt))}
              </div>
            )}
            {c.lastError && <p className={styles.formError} role="alert">{c.lastError}</p>}
          </div>
          <div className={styles.formActions}>
            {c.status === 'linked' && (
              <button type="button" className={styles.primaryBtn} onClick={() => syncNow(c.id)} disabled={busy !== null}>
                {busy === c.id ? t('state.loading') : t('bankfeed.syncNow')}
              </button>
            )}
            {(c.status === 'expired' || c.status === 'revoked') && (
              <button type="button" className={styles.primaryBtn} onClick={openPicker} disabled={busy !== null}>
                {t('bankfeed.reconnect')}
              </button>
            )}
            <button type="button" className={styles.ghostBtn} onClick={() => remove(c.id)} disabled={busy !== null}>
              {t('bankfeed.remove')}
            </button>
          </div>
        </div>
      ))}

      {picking ? (
        <div className={styles.formActions}>
          <label className={styles.field}>
            <span>{t('bankfeed.institution')}</span>
            <select value={chosen} onChange={(e) => setChosen(e.target.value)}>
              <option value="">{t('bankfeed.choosePrompt')}</option>
              {(institutions ?? []).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          </label>
          <button type="button" className={styles.primaryBtn} onClick={connect} disabled={!chosen || busy === 'connect'}>
            {busy === 'connect' ? t('state.loading') : t('bankfeed.start')}
          </button>
          <button type="button" className={styles.ghostBtn} onClick={() => setPicking(false)} disabled={busy === 'connect'}>
            {t('bankfeed.cancel')}
          </button>
        </div>
      ) : (
        <div className={styles.formActions}>
          <button type="button" className={styles.primaryBtn} onClick={openPicker}>{t('bankfeed.connect')}</button>
        </div>
      )}
    </section>
  );
}
```

(Check `page.module.css` for the exact class names used above — `paymentRow`, `field`, `formActions` exist for the payment-order form; if a name differs, follow the css file, not this listing.)

- [ ] **Step 3: Mount it in `bank/page.tsx`**

In `BankInner`, immediately after `<h1 …>{t('bankpage.title')}</h1>`, add:

```tsx
{clientCompanyId && <FeedsSection clientCompanyId={clientCompanyId} />}
```

with `import { FeedsSection } from './FeedsSection';` at the top.

- [ ] **Step 4: Implement `web/app/(cabinet)/bank/callback/page.tsx`**

```tsx
'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import styles from '../page.module.css';

function CallbackInner() {
  const { t } = useMessages();
  const router = useRouter();
  const searchParams = useSearchParams();
  const cid = searchParams.get('cid');
  const client = searchParams.get('client');
  const [state, setState] = useState<'working' | 'done' | 'fail'>('working');
  const [detail, setDetail] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current || !cid || !client) return;
    ran.current = true;
    (async () => {
      try {
        const res = await fetch(`/api/bank/connections/${cid}/finalize`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientCompanyId: client }),
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setState('done');
        setTimeout(() => router.replace(`/bank?client=${encodeURIComponent(client)}`), 1200);
      } catch (err) {
        setDetail((err as Error).message);
        setState('fail');
      }
    })();
  }, [cid, client, router]);

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <h1 className={styles.pageHeading}>{t('bankfeedcb.title')}</h1>
        <section className={styles.card}>
          {state === 'working' && <p className={styles.hint} role="status">{t('bankfeedcb.working')}</p>}
          {state === 'done' && <p className={styles.okMsg} role="status">{t('bankfeedcb.done')}</p>}
          {state === 'fail' && (
            <>
              <p className={styles.formError} role="alert">{t('bankfeedcb.fail')}{detail ? ` — ${detail}` : ''}</p>
              <a className={styles.primaryBtn} href={client ? `/bank?client=${encodeURIComponent(client)}` : '/bank'}>
                {t('bankfeedcb.back')}
              </a>
            </>
          )}
        </section>
      </main>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={null}><CallbackInner /></Suspense>;
}
```

- [ ] **Step 5: Typecheck + build**

Run: `cd web && npx tsc --noEmit && npm run build`
Expected: clean — a missing i18n key in any catalog fails here by design.

- [ ] **Step 6: Commit**

```bash
git add web/app/\(cabinet\)/bank web/app/lib/i18n.ts
git commit -m "feat(bankfeed): /bank feeds section, consent callback page, LV/RU/EN strings"
```

---

### Task 8: Cron registration, docs, final verification

**Files:**
- Create: `web/vercel.json`
- Modify: `docs/RUNNING.md` (env-vars section), `HANDOFF.md` (M3 progress note), `docs/ROADMAP-market-gaps.md` (M3 row), `CLAUDE.md` (only if an existing statement became wrong — likely nothing)

**Interfaces:** none (docs + config).

- [ ] **Step 1: Register the cron**

`web/vercel.json` (plain vercel.json — no new dependency; `vercel.ts` would pull in `@vercel/config` for a single static entry):

```json
{
  "crons": [{ "path": "/api/cron/bank-sync", "schedule": "0 5 * * *" }]
}
```

Daily at 05:00 UTC — after banks post the previous day's bookings, within GoCardless's per-account daily rate budget.

- [ ] **Step 2: Document env vars + sandbox flow**

In `docs/RUNNING.md`, add to the environment table/section: `GOCARDLESS_SECRET_ID`, `GOCARDLESS_SECRET_KEY` (bank feeds; absent ⇒ auto-linking stub provider for keyless dev), `CRON_SECRET` (authorizes `/api/cron/bank-sync`; Vercel sends it automatically for registered crons). Mention `scripts/bankfeed-sandbox.ts` and the `SANDBOXFINANCE_SFIN0000` sandbox institution.

- [ ] **Step 3: Update HANDOFF.md and the roadmap**

- `HANDOFF.md`: in the "Progress" block of the roadmap call-out, add: M3 (live bank feeds) — shipped 2026-07-19 — `src/bankfeed/` (GoCardless BAD behind `BankFeedProvider` + stub), connections/consent UI on `/bank`, daily cron + manual sync into the existing matching pipeline. Note the accepted cross-source dedup limitation and that account-mapping debt now also covers `src/bankfeed/sync.ts` constants.
- `docs/ROADMAP-market-gaps.md`: M3 row → ✅ with the same one-line summary and spec link `docs/superpowers/specs/2026-07-19-bank-feeds-design.md`.

- [ ] **Step 4: Full verification (all three gates)**

```bash
npm test && npx tsc --noEmit && (cd web && npx tsc --noEmit && npm run build)
```

Expected: full suite green (all pre-existing + ~5 new bankfeed test files), both typechecks clean, web build clean.

- [ ] **Step 5: Manual acceptance (keyless dev, stub provider)**

`GET /api/dev/bootstrap`, open `/bank` → Connect a bank → Stub Bank → consent URL bounces straight back to `/bank/callback` → connection shows **Connected** with the demo IBAN, transactions appear in the imported list, and the demo credit shows a proposal in the approval queue. "Sync now" reports 0 imported / N skipped.

- [ ] **Step 6: Commit**

```bash
git add web/vercel.json docs/RUNNING.md HANDOFF.md docs/ROADMAP-market-gaps.md
git commit -m "docs(bankfeed): cron registration, env docs, M3 shipped in HANDOFF + roadmap"
```

---

## Self-Review Notes (already applied)

- Spec coverage: data model → T1; seam+stub → T1; normalization/dedup → T1/T3; connections lifecycle → T2; sync engine + cursors + errors → T3; GoCardless + factory + sandbox script → T4; cron sweep + system context → T5; all 7 routes → T6; UI + callback + i18n → T7; vercel cron + docs + acceptance → T8.
- The sync test's proposals case defers ledger seeding to `tests/banking/match.test.ts`'s existing helper by instruction (copy verbatim) rather than inventing a new path — deliberate, not a placeholder.
- Type consistency: `FeedConnectionRow`/`FeedAccountRow`/`SyncResult`/`RequisitionState` names match across T2/T3/T6/T7; `providerTxId` fallback lives in `normalize.ts` only.
