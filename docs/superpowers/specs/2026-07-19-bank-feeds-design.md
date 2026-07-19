# Live bank feeds (M3) — design

Date: 2026-07-19. Status: approved for planning.
Roadmap ref: `docs/ROADMAP-market-gaps.md` M3 (Tier 1). Closes the last Tier-1 gap
not already in flight (M4 is on the `m4a-*`/`m4b-*` branches).

## Goal

Pull bank transactions automatically via open banking (PSD2) instead of manual
camt.053 upload, and feed them through the **existing, unchanged** import +
matching pipeline (`importStatement` → `proposeMatches`/`proposeApMatches`).
The camt.053 upload path stays as the fallback for uncovered banks.

## Decisions (made during brainstorming)

- **Provider: GoCardless Bank Account Data** (ex-Nordigen). Free tier, covers the
  major LV banks (Swedbank, SEB, Citadele, Luminor), simple REST + consent flow,
  sandbox institution (`SANDBOXFINANCE_SFIN0000`) for dev/acceptance.
- **Sync triggers: manual "Sync now" + daily Vercel cron.** No dependency on the
  jobs/reaper infra on the unmerged `m4b-dunning` branch; can fold into it later.
- **Scope: transactions only.** No balance display, no formal statement
  reconciliation (M21), consent-expiry visibility included.
- **Architecture: thin provider seam** (approach A) — interface + stub + env
  factory, mirroring `AccessPoint`/`StubAccessPoint` and `makeBlobStore()`.
  Rejected: unifying upload+feed under a generic source abstraction (refactors
  tested code for no user value); webhook/push ingestion (GoCardless BAD is
  poll-based; webhooks cover consent lifecycle only).

## Data model — migration `035_bank_feed_connections.sql`

Two tables, standard tenant RLS (`USING`/`WITH CHECK` on
`app.current_client_id`) + `FORCE ROW LEVEL SECURITY`, grants to
`bookkeeping_app` (SELECT/INSERT/UPDATE/DELETE — connections are deletable,
unlike the ledger).

**`bank_feed_connections`** — one row per bank consent:

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `client_company_id` | uuid NOT NULL → `client_companies` | |
| `provider` | text NOT NULL DEFAULT `'gocardless'` | |
| `provider_requisition_id` | text NOT NULL | UNIQUE with `client_company_id` |
| `institution_id` | text NOT NULL | |
| `institution_name` | text NOT NULL DEFAULT `''` | |
| `status` | text CHECK | `pending` → `linked` → `expired` \| `revoked` (sync failures go to `last_error`, not a status) |
| `consent_expires_at` | timestamptz NULL | from the provider EUA |
| `last_error` | text NOT NULL DEFAULT `''` | last sync failure; cleared on success |
| `created_at` / `updated_at` | timestamptz | |

**`bank_feed_accounts`** — accounts a consent exposes (a requisition can return
several):

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `connection_id` | uuid NOT NULL → `bank_feed_connections` ON DELETE CASCADE | |
| `client_company_id` | uuid NOT NULL | denormalized for RLS |
| `provider_account_id` | text NOT NULL | UNIQUE with `connection_id` |
| `iban` | text NOT NULL DEFAULT `''` | becomes `bank_transactions.account` |
| `currency` | char(3) NOT NULL DEFAULT `'EUR'` | |
| `last_synced_date` | date NULL | sync cursor (booking date) |

`bank_transactions` is **not modified**.

## Provider seam — `src/bankfeed/`

```ts
export interface Institution { id: string; name: string; logoUrl?: string }

export interface FeedTxn {
  bookingDate: string;        // ISO date
  amount: string;             // signed decimal string, e.g. "-12.50"
  currency: string;
  reference: string;
  counterparty: string;
  endToEndId: string;         // '' when bank omits it
  providerTxId: string;       // provider-stable id, always present
}

export interface BankFeedProvider {
  listInstitutions(country: string): Promise<Institution[]>;
  startConsent(institutionId: string, redirectUrl: string, reference: string):
    Promise<{ requisitionId: string; consentUrl: string }>;
  getRequisition(requisitionId: string): Promise<{
    status: 'pending' | 'linked' | 'expired' | 'revoked';
    consentExpiresAt: string | null;
    accounts: { providerAccountId: string; iban: string; currency: string }[];
  }>;
  fetchTransactions(providerAccountId: string, fromDate: string): Promise<FeedTxn[]>;
  deleteRequisition(requisitionId: string): Promise<void>; // best-effort cleanup
}
```

- `StubBankFeedProvider` — in-memory, test-seedable (institutions, requisition
  states, per-account transactions), records calls. Default in dev/tests.
- `GoCardlessProvider` — secret id/key → access token →
  `https://bankaccountdata.gocardless.com/api/v2`. Maps requisition/EUA state and
  transaction JSON to the interface. Pure response-mapping functions are exported
  separately so they are testable against fixtures without network.
- `makeBankFeedProvider()` — GoCardless when `GOCARDLESS_SECRET_ID` +
  `GOCARDLESS_SECRET_KEY` are set, stub otherwise (mirrors `makeBlobStore()`).

Normalization (`FeedTxn` → `BankTxn`): amount decimal string → integer cents via
`src/db/money.ts`; sign → `side` (`negative = debit`), absolute value stored;
`end_to_end_id` := `endToEndId` when non-empty, else `providerTxId`.

## Sync — `src/bankfeed/sync.ts`

`syncConnection(tx, ctx, provider, connectionId)`:

1. `getRequisition` → update connection `status`/`consent_expires_at`. Expiry and
   revocation are detected here, on every sync. Non-`linked` → stop.
2. Per account: `fetchTransactions(providerAccountId, from)` where `from` =
   `last_synced_date − 7 days` (overlap for late-booked transactions; safe
   because import is idempotent). First sync (`last_synced_date IS NULL`):
   90 days back (the GoCardless EUA default history window).
3. Normalize to the existing `BankStatement` shape (`account` = IBAN) and call
   `importStatement`, then `proposeMatches` + `proposeApMatches` with the same
   account constants as `web/app/api/bank/import/route.ts`
   (`5310`/`2620`/`2699` — shares the existing "account-mapping is hard-coded"
   debt noted in `HANDOFF.md`; a mapping settings screen remains out of scope).
4. Advance `last_synced_date` to today — per account, only when that account's
   fetch + import succeeded; `appendAudit` with imported/skipped counts per
   account.
5. A per-account failure records the message in `last_error` and continues with
   the remaining accounts; success clears `last_error`. Progress already
   committed (earlier accounts, cursor advances) is never rolled back.

**Dedup.** Rides the existing unique key
`(client_company_id, account, end_to_end_id, amount_cents, booking_date)` with
`ON CONFLICT DO NOTHING`. Re-syncs and the 7-day overlap dedup exactly against
themselves (provider tx id is stable). Cross-source dedup vs a camt.053 upload
of the same account works when the bank populates the end-to-end id in both
sources (normal for SEPA); when it omits it in one, a duplicate can slip
through — **accepted, documented limitation** (mixing upload + feed on one
account is an edge case; unmatched duplicates surface visibly in the queue).

**Rate limits.** GoCardless enforces bank-imposed limits (~4 calls/day per
account endpoint). Daily cron + occasional manual syncs fit. HTTP 429 is treated
as a per-account failure (lands in `last_error`), not retried in-process.

## Consent lifecycle

- `POST /api/bank/connections` creates the requisition (`pending`) and returns
  the provider's `consentUrl`; the browser navigates there.
- The bank redirects back to `/bank/callback?cid=<connectionId>` (redirect URL
  derived from the request origin — no new base-URL env). That page calls
  finalize, which reads the requisition, stores the accounts, marks the
  connection `linked`, and runs the first sync inline.
- `/bank` warns when `consent_expires_at` is within 14 days and shows expired/
  revoked state with **Reconnect** — which starts a fresh consent (new
  connection row; the old one is deletable). Dedup makes the historical
  re-import overlap harmless, so no cursor handover is needed.

## API routes

House pattern throughout: `getSessionToken()` → `resolveTenantContext` → domain
call in `withTenant`; mutations gated `assertRoleAllowed(ctx.actorRole,
'bank.write')`; errors via the shared `errorToStatus`; provider-side failures
map explicitly to **502**.

| route | purpose |
|---|---|
| `GET /api/bank/institutions` | LV institution list for the picker |
| `GET /api/bank/connections` | connections + accounts + status/expiry/last-synced/last-error |
| `POST /api/bank/connections` | `{ institutionId }` → start consent → `pending` row → `{ consentUrl }` |
| `POST /api/bank/connections/:id/finalize` | after redirect: store accounts, mark `linked`, first sync |
| `POST /api/bank/connections/:id/sync` | manual "Sync now" |
| `DELETE /api/bank/connections/:id` | remove locally + best-effort provider requisition delete |
| `GET /api/cron/bank-sync` | daily cron: sync all `linked` connections across tenants |

**Cron.** Guarded by `CRON_SECRET` (Bearer header, Vercel cron convention),
registered in the Vercel cron config, daily. Enumerates `client_companies` (no
RLS on that table), and per client enters `withTenant` with a **system tenant
context** — a small helper constructing a `TenantContext` with a system actor so
`appendAudit` attributes cron imports honestly — then syncs each `linked`
connection. Per-connection failures are recorded and don't abort the run.

## UI

A "Bank feeds" section on the existing `/bank` page:

- Connection cards: institution name, IBANs, status chip, consent expiry
  (≤14-day warning), last synced, last error.
- Actions: **Connect bank** (institution picker), **Sync now**, **Reconnect**
  (expired/revoked), **Remove**.
- `/bank/callback` — minimal page: calls finalize, then redirects to `/bank`.
- All user-facing strings in all three i18n catalogs (LV/RU/EN); icons as inline
  stroked SVG per `NavIcon` conventions.

## Config

| env | effect |
|---|---|
| `GOCARDLESS_SECRET_ID` / `GOCARDLESS_SECRET_KEY` | real provider; absent ⇒ stub |
| `CRON_SECRET` | authorizes `/api/cron/bank-sync` |

## Testing (`tests/bankfeed/`, real DB, house style)

- **Consent flow:** create → finalize transitions; accounts stored; RLS
  isolation between clients.
- **Sync:** stub-fed transactions import and produce match proposals; re-sync +
  7-day overlap import zero new rows; cursor advances; expired/revoked
  requisition flips status; per-account failure records `last_error` without
  aborting sibling accounts; success clears it.
- **Normalization:** decimal string → integer cents, sign → side, negative
  amounts stored as absolute debit, endToEndId/providerTxId fallback.
- **GoCardlessProvider:** response mapping against JSON fixtures — no live
  network in tests. A manual sandbox script (`SANDBOXFINANCE_SFIN0000`) verifies
  end-to-end outside the suite.
- **Cron:** the sync-all domain function over two seeded clients using the
  system context.

## Acceptance

1. From `/bank`, connect the GoCardless sandbox institution; transactions appear
   in the imported list and generate match proposals through the approval queue.
2. Re-running sync imports nothing new (dedup).
3. `GET /api/cron/bank-sync` with the secret syncs all tenants' connections.
4. An expired consent surfaces on `/bank` with a working Reconnect flow.
5. `npm test` (root) and `npx tsc --noEmit` in root **and** `web/` are clean;
   `StubBankFeedProvider` keeps the suite network-free.

## Out of scope (explicit)

Balances display, formal statement reconciliation (M21), per-client ledger
account mapping (existing debt), webhook-based consent notifications, retrying
429s in-process, multi-provider support beyond the seam itself.
