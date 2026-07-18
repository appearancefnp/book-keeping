# Hobby Release — Secure Vercel Deployment for the Internal-Bookkeeper MVP

Date: 2026-07-18. Status: approved (brainstorm 2026-07-18).
Basis: `docs/audit/PRODUCTION-READINESS.md` (3 blockers, 6 gaps, all file:line-verified).

## Goal

Deploy `web/` to Vercel on free tiers (Vercel Hobby + Neon free + Vercel Blob free
allowance) so a real internal bookkeeper plus 1–3 client owners/employees can use
the app with real data — hosted securely, encrypted in transit and at rest,
protected against the obvious attack surface (credential handling, brute force,
lost uploads).

Decisions taken with the user:
- **Users:** bookkeeper + a couple of owners. Provisioning via admin-generated
  one-time invite links, delivered manually (no email infrastructure).
- **Encryption:** provider-managed at-rest (Neon, Vercel Blob are AES-256) + TLS
  everywhere + app hardening. NO app-level field encryption (breaks SQL
  aggregation; rejected for MVP).
- **AI extraction:** free `GEMINI_API_KEY` for the pilot, accepted trade-off:
  free-tier Gemini may retain/train on submitted data. Documented caveat; the
  provider switch stays env-based (set `ANTHROPIC_API_KEY` to upgrade the privacy
  boundary later — precedence already implemented).
- **Blob storage:** Vercel Blob (native integration) over Cloudflare R2.

## Architecture

Four work packages, all following the repo's established seams. No new
architectural concepts — the `BlobStore` interface, the `Operation` role matrix,
the migration/domain/tests/route/page feature order, and the trilingual i18n
catalogs all already exist.

### 1. Invite-based provisioning + 2FA enrolment (closes blockers #1 and #2)

**Data.** Migration `033_user_invites.sql` (numbering: max+1 across ALL files;
030–032 exist):

```sql
ALTER TABLE users ADD COLUMN status text NOT NULL DEFAULT 'active'
  CHECK (status IN ('invited', 'active'));

CREATE TABLE user_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,        -- sha256 hex of the raw token; raw token never stored
  expires_at timestamptz NOT NULL,        -- 72h from creation
  used_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
```

No RLS: invites are firm-administration data, same posture as `users` itself.

**Domain** (`src/auth/invites.ts`):
- `createInvite(userId, createdBy)` → `{ token }` (raw, 32 random bytes
  hex; only the sha256 goes to the DB). Invalidates prior unused invites for the
  user. For a NEW user, the caller first uses existing `createUser(...)` then
  flips `status='invited'`; for an EXISTING user (password/2FA reset), the
  accept step re-generates the TOTP secret and password.
- `previewInvite(token)` → `{ email, firmName }` for the invite page header;
  validates hash/expiry/unused without consuming.
- `acceptInvite(token, { password, totpCode })` → activates: validates token
  (hash match, unexpired, unused), sets the new password hash, verifies
  `totpCode` against the invite's freshly issued TOTP secret **before**
  activation (proves the authenticator is enrolled), marks invite used,
  `status='active'`. No client-scoped `appendAudit` entry — `audit_log` is
  client-company-scoped and the auth module (createUser/login) writes none;
  invites follow the same firm-level pattern.
- TOTP secret for enrolment: generated at invite creation, stored on the user
  row as today; `previewInvite` returns the `totpUri()` so the page can render
  the QR. A user who never accepts keeps `status='invited'` and cannot log in.
- `login()` (`src/auth/sessions.ts`) additionally rejects `status='invited'`.

**Authz.** New `Operation` `'users.write'` → `['firm_admin']` only.

**Routes.**
- `POST /api/admin/users` (role-gated `users.write`): body `{ email, role,
  clientCompanyIds }` → creates user (`createUser`) + assignments + invite;
  returns the one-time invite URL. Also accepts `{ userId }` alone to re-invite
  (credential reset).
- `GET /api/auth/invite/[token]` (public): `previewInvite` — email, firm, otpauth
  URI. `POST /api/auth/invite/[token]` (public): `acceptInvite`. Both routes are
  rate-limited by the same limiter as login (token guessing).
- Admin page gains a "Users" tab action: create/re-invite, showing the copyable
  link exactly once.

**Page.** `/invite/[token]` (public, outside `(cabinet)`): shows email + firm,
password field (min 12 chars), QR code (otpauth URI rendered client-side via the
`qrcode` npm package as an SVG data-URI — no external chart service; the secret
is also shown as text for manual authenticator entry), TOTP confirm field, Activate
button → redirects to `/login`. Trilingual (all strings in LV/RU/EN catalogs).

### 2. Durable uploads — `VercelBlobStore` (closes blocker #3)

`src/blob/vercel-blob-store.ts`: implements `BlobStore` (`put`, `get`) over
`@vercel/blob` (new dependency in `web/`), `access: 'private'`. Keys map 1:1 to
the current `LocalBlobStore` keys, so existing DB references keep working.

`src/blob/factory.ts` — `makeBlobStore(): BlobStore`: returns `VercelBlobStore`
when `BLOB_READ_WRITE_TOKEN` is set, else `LocalBlobStore(BLOB_DIR ?? '.blob-store')`.
The three instantiation sites (`documents/capture` route, `invoice-profile/logo`
route, `invoice-document/[id]` page) switch to the factory. Tests keep using
`LocalBlobStore` directly; the factory's selection logic gets its own unit test.
The Vercel implementation is verified manually on a preview deployment (no
network in CI by repo convention — same posture as `StubAccessPoint`).

### 3. Security hardening (gaps #4, #5, #7, #8 + headers)

- **Cookies:** `secure: process.env.NODE_ENV === 'production'` on the session
  cookie in login (and the dev bootstrap route for symmetry).
- **Login rate limiting:** migration adds `login_attempts (identifier text,
  window_start timestamptz, fail_count int)`; `src/auth/rate-limit.ts` —
  `checkAndRecordFailure(identifier)` / `clearFailures(identifier)`; wired into
  `login()` keyed on lowercase email AND caller IP (two identifiers), 5 failures
  per 15-minute window → locked out for the window remainder → login returns the
  same generic error (no user enumeration). Applied to the invite-token routes
  keyed on IP.
- **Security headers:** `web/next.config.*` `headers()`: HSTS
  (`max-age=63072000; includeSubDomains`), `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`.
- **Pool tuning:** `src/db/pool.ts`: `max: 5`, `connectionTimeoutMillis: 10000`,
  `idleTimeoutMillis: 30000` on both pools. Prod URLs must carry
  `?sslmode=require` (documented in `.env.example`); Neon **pooled** endpoint for
  `DATABASE_URL`, **direct** for `ADMIN_DATABASE_URL`.
- **Bootstrap guard:** `/api/dev/bootstrap` additionally returns 403 when
  `process.env.VERCEL_ENV` is set (any Vercel deployment, including previews).
- **Health:** `GET /api/health` → `SELECT 1` via app pool → `{ ok: true }` /
  503. No auth, returns no data beyond status.

### 4. Deploy runbook (docs only)

`docs/RUNNING.md` §3 grows a concrete Neon + Blob walkthrough: create Neon
project → `npm run migrate` against the direct/admin URL (bootstrap creates
`bookkeeping_app`) → Vercel project (root `web/`) → env vars (`DATABASE_URL`
pooled + sslmode, `ADMIN_DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`,
`GEMINI_API_KEY` + retention caveat) → deploy → seed is NOT run in prod; instead
the first `firm_admin` is provisioned by a one-off script
(`src/dev/provision-admin.ts`, prints an invite URL, run locally against the
prod admin URL) → smoke-test checklist (login, upload, invoice, health). Backup
note: Neon PITR covers the pilot; scheduled `pg_dump` before data volume grows.

## Error handling

Invite errors are indistinguishable to the caller (invalid = expired = used →
one generic message, 404-shaped) to prevent token probing. Rate-limit lockout
returns the same generic login failure. `acceptInvite` runs inside one
transaction — a failed TOTP confirmation leaves the invite unused and the user
inactive.

## Testing

TDD throughout, mirroring `tests/<module>/`: invites domain (happy path, expiry,
reuse, wrong TOTP, re-invite resets credentials, invited-user login rejection),
rate limiter (lockout boundary at 5, window expiry, success clears), authz
matrix addition, blob factory selection, health route handler, migration
numbering already guarded. Full suite + both typechecks must stay green.

## Out of scope

Email sending, GDPR export/erasure, audit hash-chain, session-row cleanup job,
app-level field encryption, Peppol/VID wiring, session cookie rotation.
