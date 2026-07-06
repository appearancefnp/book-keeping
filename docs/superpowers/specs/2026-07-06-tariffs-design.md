# G4 Slice 1 — Per-client tariffs: design

Date: 2026-07-06. Addresses the first slice of gap **G4** (spec §5 — the firm
administrator manages *tariffs*, permissions, templates). Today nothing tariff-related
exists (backend or UI) and `/admin` is read-only (clients / users / audit).

**G4 is decomposed into four independent slices** — this spec covers **Slice 1
(tariffs)** only. Later slices (their own spec → plan → build): (2) client-onboarding
templates, (3) invoice/document templates, (4) notification/email templates.

## Decisions (from the brainstorm)

- **Monetisation model:** per-client **monthly retainer** (a rate the firm charges each
  client company).
- **Depth: store-rate-only.** The admin records the retainer; it is displayed/reported.
  **No** automatic invoice, posting, or billing run is generated. Billing can be a later
  slice.
- **Tariff fields:** effective-dating + VAT rate on the fee + currency. (No free-text
  service-scope note — deferred.)
- **Location:** extend the existing firm-level `/admin` surface.
- **RLS posture:** the tariff table has **no row-level security** — it is firm-admin
  cross-client data, and every query filters by `firm_id` through a join to
  `client_companies`. This matches the established `/admin` posture (`tax_rules` is
  app-read/no-RLS; `listClientCompaniesForFirm` is firm-scoped via `appPool`), rather
  than the per-client tenant-RLS posture used elsewhere.
- **Write authorization:** setting a tariff is **`firm_admin` only** (spec §5 attributes
  tariff management to the administrator). Viewing is `accountant` **or** `firm_admin`,
  matching the rest of `/admin`.

## Data model

New migration `migrations/023_client_tariffs.sql`:

```sql
CREATE TABLE client_tariffs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id     uuid NOT NULL REFERENCES client_companies(id),
  monthly_amount_cents  bigint NOT NULL CHECK (monthly_amount_cents >= 0),
  currency              char(3) NOT NULL DEFAULT 'EUR',
  vat_rate              text NOT NULL,          -- decimal string percent, e.g. '21'
  effective_from        date NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,                    -- actor user id (session.userId)
  UNIQUE (client_company_id, effective_from)
);
CREATE INDEX client_tariffs_lookup_idx
  ON client_tariffs(client_company_id, effective_from DESC);
```

- **Effective-dating:** a rate change is a new row, never an update. The *current*
  tariff for a client is the row with the greatest `effective_from ≤ asOf` (today).
  Mirrors `tax_rules` (`UNIQUE(rule_type, effective_from)`, DESC lookup index).
- **No RLS** (see Decisions). The table is not tenant-scoped; correctness relies on the
  firm-scoping join in every read/write path.
- **Grants:** `GRANT SELECT, INSERT ON client_tariffs TO bookkeeping_app;` (the app role;
  no UPDATE/DELETE — the table is append-only like the ledger's dated-row pattern).
- **Money** as integer cents (`monthly_amount_cents bigint`), never floats. **VAT rate**
  stored as a decimal string percent (same representation as `tax_rules.value`).

## Domain — `src/tariffs/tariffs.ts`

Two function shapes, each matching an existing convention:

1. **Per-client, audited, run inside `withTenant(ctx, …)`** (same `(tx, ctx, …)` shape as
   the rest of the domain):
   - `setTariff(tx, ctx, input: { monthlyAmountCents: bigint; currency: string; vatRate: string; effectiveFrom: string }): Promise<{ id: string }>`
     — inserts a dated row for `ctx.clientCompanyId` (with `created_by = ctx.actorId`),
     then `appendAudit(tx, ctx, { action: 'set', entityType: 'tariff', entityId: id, before: null, after: input })`.
   - `getCurrentTariff(tx, ctx, asOf: string): Promise<TariffRow | null>`
     — the row with the greatest `effective_from ≤ asOf` for `ctx.clientCompanyId`.
2. **Firm-scoped** (plain `appPool` query, like `listClientCompaniesForFirm` in
   `src/tenancy/firms.ts` — no `ctx`, no RLS):
   - `listCurrentTariffsForFirm(firmId: string, asOf: string): Promise<FirmTariffRow[]>`
     — one *current* tariff per client company in the firm (LEFT JOIN so clients with no
     tariff yet appear with a null tariff), filtered by `client_companies.firm_id = firmId`.

Types:
```ts
export interface TariffRow {
  id: string; clientCompanyId: string; monthlyAmountCents: string; // bigint as string
  currency: string; vatRate: string; effectiveFrom: string;
}
export interface FirmTariffRow {
  clientCompanyId: string; clientName: string;
  monthlyAmountCents: string | null; currency: string | null;
  vatRate: string | null; effectiveFrom: string | null;
}
```

## API — extend `web/app/api/admin/`

Both routes follow the **admin route pattern** (`validateSession`, firm-scoped, role
gate — see `web/app/api/admin/clients/route.ts`), not the per-client tenant pattern.

- **`GET /api/admin/tariffs`** — `getSessionToken` → `validateSession` → role read gate
  (`accountant` **or** `firm_admin`, else 403) → `listCurrentTariffsForFirm(session.firmId, today)` →
  `{ tariffs: FirmTariffRow[] }`. `today` = current date `YYYY-MM-DD`.
- **`POST /api/admin/tariffs`** — `validateSession` → **write gate: `firm_admin` only**
  (else 403) → parse/validate body `{ clientCompanyId, monthlyAmountCents, currency, vatRate, effectiveFrom }`
  (amount a non-negative integer; currency 3 letters; vatRate a decimal string;
  effectiveFrom `YYYY-MM-DD`) → **verify the client belongs to `session.firmId`**
  (a firm-scoped `SELECT 1 FROM client_companies WHERE id=$1 AND firm_id=$2`; if no row,
  respond **403 `client not in firm`** — do not leak whether the id exists in another
  firm) → construct `ctx = { firmId: session.firmId, clientCompanyId, actorId: session.userId, actorRole: session.role }`
  → `withTenant(ctx, tx => setTariff(tx, ctx, …))` → `{ id }`, 201.
- Errors mapped with `errorToStatus` from `@/app/lib/authz` (401 no-token first, added in G2).

## UI — extend `/admin` (`web/app/(cabinet)/admin/page.tsx`)

Add a **Tariffs** table below the existing admin tables: one row per firm client showing
current **monthly retainer** (formatted via `formatCents`), **currency**, **VAT %**, and
**effective-from** (clients with no tariff show a "—" / "not set" state). For
`firm_admin`, an **Edit** action reveals a small inline form (amount, currency, VAT %,
effective-from) that `POST`s a new dated rate and refreshes the table. The form
pre-fills VAT % with the current standard rate (`21`) and currency with `EUR` as
sensible defaults, both overridable. `accountant` sees
the table read-only (no Edit action). Fetches `GET /api/admin/tariffs`. New user-facing
strings added to EN, LV, RU in `web/app/lib/i18n.ts` (typed `Record<keyof typeof EN>` —
a missing key fails the build). No tracked-uppercase labels; tabular numerals for money.

The current admin page already handles a firm-level 403 (`forbidden` notice) for the
clients/users endpoints; the tariff fetch reuses that gate. The Edit action is hidden for
non-`firm_admin` roles in the UI, and the `POST` route enforces it server-side regardless.

## Data flow

```
firm_admin /admin
  → GET /api/admin/tariffs        (firm-scoped list: current tariff per client)
  → Edit → POST /api/admin/tariffs (new dated row; audited via constructed ctx + withTenant)
  → refetch list
accountant /admin → GET only (Edit hidden; POST would 403)
```

No posting, no invoice, no billing run. The only new tables/queries are `client_tariffs`
and its two access paths.

## Testing

- **Domain** (`tests/tariffs/tariffs.test.ts`, Vitest vs real Postgres):
  - `setTariff` inserts a row and writes an audit entry.
  - `getCurrentTariff` returns the row with the greatest `effective_from ≤ asOf` when two
    dated rows exist; returns `null` when none precede `asOf`.
  - `listCurrentTariffsForFirm` returns exactly one current row per client, includes a
    client with no tariff (null fields), and does **not** return another firm's tariffs
    (create two firms; assert isolation) — this guards the no-RLS decision.
- **HTTP smoke** (per-role, against the running dev server — the path that has caught
  prior route bugs): `firm_admin` GET → 200 and POST → 201; `accountant` GET → 200 but
  POST → 403; `owner`/`employee` → 403 on both. Then GET reflects the posted rate.
- **Gates:** full backend suite green (single vitest process — never concurrent), root +
  web `tsc --noEmit` clean, web `npm run build` clean.

## Out of scope

- Fee generation, invoicing, billing runs, payment tracking (store-rate-only decision).
- G4 template slices (onboarding, invoice/document, notification).
- Free-text service-scope note on the tariff (deferred; trivial to add as a nullable
  column later).
- Editing/deleting historical tariff rows (append-only; corrections are new dated rows).

## Follow-ups (noted, not built)

1. Billing: generate the monthly retainer as a draft proposal/invoice the accountant
   approves — a natural Slice 1b once store-only is in.
2. If VAT handling ever needs to drive a posting, resolve the rate from `tax_rules`
   at fee time rather than trusting the stored `vat_rate` snapshot.
