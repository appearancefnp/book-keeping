# Authz + error-handling hardening batch — design

Date: 2026-07-19. Status: approved for planning.

## Goal

Close the security/consistency debt HANDOFF accumulated: route-level role
gating for the remaining ungated mutations (G1), full adoption of the shared
`errorToStatus` mapping (G2), and every confirmed hobby-release follow-up.

## Inventory (verified against the tree on this date)

- **Ungated mutating routes:** `tasks` POST, `tasks/[id]/resolve` POST,
  `tasks/[id]/comments` POST, `documents/capture` POST. (Proposals
  approve/reject ARE gated via `proposals.decide` in `src/api/handlers.ts`;
  `/api/periods` and `/api/autonomy` got gated since HANDOFF was written.)
- **Inline-gated admin routes** (work, but bypass the central matrix):
  `admin/clients`, `admin/tariffs`, `admin/templates` — `session.role !==`
  checks in-route.
- **Old error mapping** (`/session/i ? 401 : 403`) in 12 routes: `vat-rate`,
  `tasks`, `tasks/[id]/comments`, `tasks/[id]/resolve`, `overview`,
  `vid/deadlines`, `bank/transactions`, `notifications`,
  `notifications/read-all`, `notifications/[id]/read`, `audit`, `journal`.
- **Follow-ups confirmed live:** unbounded `login_attempts` growth; no
  expired-session sweep; `admin/users` returns raw `String(e)` (leaks
  constraint names); invite route trusts `clientCompanyIds` without firm
  scoping (inert — `resolveTenantContext` re-filters — but cheap
  defense-in-depth); no startup/health signal for `VERCEL_ENV` set without
  `BLOB_READ_WRITE_TOKEN`; `ip:unknown` shared limiter bucket for headerless
  clients; no index on `user_invites(user_id)`; missing tests (limiter 900s
  boundary, combined identifiers, bootstrap `VERCEL_ENV` guard); cosmetics
  (hardcoded busy-ellipsis glyph, `admin.onb.error` key reuse, invite
  GET/POST try-catch asymmetry, and the misleading "Fail open" comment at
  `web/app/api/auth/login/route.ts:52` — it cites the fail-CLOSED guard
  above as its rationale; reword to say recording is best-effort).

## Decisions (made during brainstorming)

- **Cleanup mechanism: opportunistic pruning** (approach A). `recordFailure`
  prunes `login_attempts` rows older than 24 h; successful login prunes
  expired `sessions` rows. No cron, no new infra. Rejected: a maintenance
  cron route (more moving parts, prod-only) and pg_cron (not reliable on
  Neon pooled).
- **Notifications read/read-all and assistant stay ungated** — self-scoped
  per-user mutations; documented with an in-route comment, not a matrix op.
- **Admin GET checks stay inline** — the `Operation` matrix is documented as
  mutation-only; only the three admin POSTs migrate to matrix ops.
- **Out of scope:** audit-log hash chain, GDPR export/erasure, password-reset
  self-service (each its own feature).

## 1. Authz — `src/authz/policy.ts` + routes

New `Operation` entries:

| op | roles | applied in |
|---|---|---|
| `tasks.write` | `firm_admin, accountant, owner, employee` | `tasks` POST, `tasks/[id]/resolve` POST, `tasks/[id]/comments` POST |
| `documents.capture` | `firm_admin, accountant, owner, employee` | `documents/capture` POST |
| `clients.write` | `firm_admin` | `admin/clients` POST (replaces inline check) |
| `tariffs.write` | `firm_admin` | `admin/tariffs` POST (replaces inline check) |
| `templates.write` | `firm_admin` | `admin/templates` POST (replaces inline check) |

All-roles entries look permissive but are deliberate: they make the policy
explicit in one auditable place and deny unrecognized roles (`isRoleAllowed`
already denies unknowns). Gating follows the house pattern — immediately
after `resolveTenantContext` (or, in the admin routes, after the session
lookup that currently feeds the inline check), before any work.

## 2. Error-mapping sweep

The 12 listed routes replace their `catch` mapping with the shared
`errorToStatus(msg)` from `@/app/lib/authz` (401 session / 403 forbidden /
409 duplicate / 400 default). Mechanical; the only behavior change is
correctly-labeled 4xx codes where 403 was returned for non-authz failures.

## 3. Follow-ups

- **`login_attempts` pruning** (`src/auth/rate-limit.ts`): `recordFailure`
  additionally runs `DELETE FROM login_attempts WHERE attempted_at < now() -
  interval '24 hours'` (24 h keeps a short forensic window; the limiter only
  reads 15 min). Fail-closed behavior of the limiter itself is unchanged.
- **Expired-session sweep** (`src/auth/sessions.ts`): successful session
  creation additionally runs
  `DELETE FROM sessions WHERE expires_at < now()` (`expires_at` per
  `migrations/017_users_sessions.sql`).
- **`admin/users` error hygiene**: unique-violation (pg code `23505` or
  message matching the shared duplicate patterns) → 409 with stable body
  `{ error: 'email already in use' }`; any other error → 400/`could not
  create user` (no raw `String(e)` pass-through). The email-existence oracle
  this implies is inherent to unique emails and stays **accepted** (as
  triaged in the hobby-release review).
- **Firm-scoped invite `clientCompanyIds`**: before persisting assignments,
  the admin-users route filters the provided ids to those whose
  `client_companies.firm_id` matches the acting admin's firm. Currently
  inert (`resolveTenantContext` re-filters at use time) — defense-in-depth.
- **Blob misconfiguration signal**: a pure helper `blobConfigStatus(env):
  'ok' | 'misconfigured'` (misconfigured ⇔ `VERCEL_ENV` set and
  `BLOB_READ_WRITE_TOKEN` absent) surfaced as a `blob` field on
  `GET /api/health` (HTTP status stays 200 — it is a signal, not an outage)
  and logged once via `console.warn` from the blob factory.
- **Limiter IP scoping**: the login route's client-IP resolution returns
  `null` when no forwarding header is present (off-Vercel dev); the limiter
  then uses only the email identifier instead of a shared `ip:unknown`
  bucket. On Vercel the header is always present, so production behavior is
  unchanged.
- **Migration `036_user_invites_user_id_idx.sql`**:
  `CREATE INDEX user_invites_user_id_idx ON user_invites(user_id);`
- **Cosmetics**: busy-ellipsis glyph replaced with the i18n-safe pattern used
  elsewhere; the invite/onboarding error that reuses `admin.onb.error` gets
  its own key (all three catalogs); invite `GET` handler gains the same
  try/catch shape as its `POST`.

## 4. Testing

- **Policy**: matrix assertions for the five new ops (allowed + denied roles,
  unknown role denied) alongside the existing policy tests.
- **Rate limiter**: 900-second-exact boundary (attempt at exactly the window
  edge), combined email+IP identifier isolation (lockout on one email does
  not lock another; IP bucket skipped when IP is null), prune removes >24 h
  rows and keeps fresh ones.
- **Sessions**: sweep removes expired rows, keeps live ones.
- **Bootstrap**: `VERCEL_ENV` guard test (dev bootstrap refuses to run on
  Vercel).
- **Blob signal**: `blobConfigStatus` truth table (pure, no env juggling).
- **Error mapping**: `errorToStatus` already has coverage; the sweep itself
  is verified by typecheck + the acceptance pass below.

## Acceptance

1. A client-assigned `employee` calling `POST /api/admin/clients` (or
   tariffs/templates) gets 403; a `firm_admin` still succeeds; task/comment/
   capture flows still work for all four roles.
2. A duplicate-email `POST /api/admin/users` returns 409 with
   `email already in use` — no constraint names in any error body.
3. `login_attempts` and `sessions` tables no longer grow monotonically under
   repeated failures/logins (prune assertions in tests).
4. `GET /api/health` reports `blob: 'misconfigured'` when `VERCEL_ENV` is
   set without a blob token, `ok` otherwise.
5. `npm test` (root), `npx tsc --noEmit` root and `web/`, `npm run build`
   (web — i18n keys change) all clean.
