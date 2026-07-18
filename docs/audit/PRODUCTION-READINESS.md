# Production-Readiness Audit — Vercel + free-tier stack, real users

Date: 2026-07-18. Target deployment: `web/` on **Vercel** (Hobby/free), a **free
managed Postgres**, real interactive users. Every finding below was verified in
code with file:line evidence (read-only scout pass; nothing speculated).

## Verdict

**Not deployable for real users today.** The app is architecturally ready for
Vercel (clean two-role DB model, env-guarded dev route, short pooler-safe
transactions, no Edge-incompatible code paths), but three hard blockers mean a
real user literally cannot exist, log in, or keep their uploads:

| # | Finding | Severity |
|---|---------|----------|
| 1 | No user provisioning over HTTP — `createUser` (`src/auth/users.ts:17`) is reachable only from `npm run seed` and the dev bootstrap route; `web/app/api/admin/users/route.ts` is GET-only | **BLOCKER** |
| 2 | No 2FA enrolment — `totpUri()` (`src/auth/totp.ts:46`) is only printed by the seeder; login requires TOTP (`src/auth/sessions.ts:12`), so any non-seed user is hard locked out | **BLOCKER** |
| 3 | Blob storage is local-disk only — `LocalBlobStore` (`src/blob/blob-store.ts:10`) is the sole `BlobStore` impl, used by document capture, logo upload, and invoice render (`web/app/api/documents/capture/route.ts:36` etc.). Vercel's filesystem is ephemeral: **uploads are lost between invocations** | **BLOCKER** |
| 4 | Session cookie missing `secure: true` (`web/app/api/auth/login/route.ts:19-24`; otherwise solid: httpOnly, sameSite lax, 12 h server-side expiry, real logout invalidation, 32-byte random tokens) | GAP |
| 5 | No login rate limiting / lockout anywhere | GAP |
| 6 | No password reset or change-password flow | GAP |
| 7 | Pool config has no `max`/timeouts/`ssl` (`src/db/pool.ts:4-5`) — pg default `max:10` per serverless instance will exhaust a free-tier Postgres unless the **pooled** connection endpoint is used | GAP |
| 8 | No observability: zero logging in `web/app`, no error reporting, no health-check route | GAP |
| 9 | No backup/tenant-export story (reports export ≠ backup); you'd rely wholly on the DB provider's snapshots | GAP |

**Already OK for prod:** `/api/dev/bootstrap` self-guards on
`NODE_ENV === 'production'` (`web/app/api/dev/bootstrap/route.ts:24-26`) and is
the only unauthenticated route besides login; migrations run out-of-band as
admin while the app runs entirely as `bookkeeping_app`; `withTenant` uses
transaction-local `set_config` — compatible with a transaction-mode pooler; no
LISTEN/NOTIFY, advisory locks, or long transactions; config surface is small
and mostly optional (full env-var inventory in the scout notes, §10).

## Recommended free stack

| Need | Pick | Why / notes |
|------|------|-------------|
| Hosting | **Vercel Hobby** | Free; note Hobby ToS is non-commercial — fine for pilot, plan Pro before charging clients. |
| Postgres | **Neon free tier** (via Vercel Marketplace) | Real Postgres 16+, allows `CREATE ROLE` so the two-role design survives (`migrations/000_bootstrap.sql` creates `bookkeeping_app`). Use the **pooled** endpoint for `DATABASE_URL`, the **direct** endpoint for `ADMIN_DATABASE_URL` (migrations). TLS via `?sslmode=require` works with the current `pg` setup. |
| File uploads | **Vercel Blob** (free allowance on Hobby) | Implement a `VercelBlobStore` behind the existing `BlobStore` interface (`put`/`get`) — the seam is already there; ~40 lines + env switch. Alternative: Cloudflare R2 (10 GB free, S3 API) if you outgrow the allowance. |
| AI extraction/assistant | **`GEMINI_API_KEY` free tier** (already wired, `src/intake/gemini-extractor.ts`) | Zero code. Caveat: free Gemini is not zero-retention — don't feed real client invoices until you're on a paid/zero-retention tier; Stub mode is the honest default meanwhile. |
| Error tracking | Vercel runtime logs (built-in) + optional Sentry free tier | Add a `/api/health` route either way. |
| Backups | Neon's point-in-time restore (free tier: limited history) | Sufficient for a pilot; add a scheduled `pg_dump` before real client data. |

## Go-live work plan (ordered)

**P0 — blockers (must ship before any real user):**
1. **Invite-based user provisioning + 2FA enrolment** (one feature, closes #1+#2):
   `POST /api/admin/users` (role-gated `firm_admin`) creating the user + an
   invite token; an `/invite/[token]` page where the user sets their password
   and enrols TOTP (show `totpUri()` as QR + manual secret, confirm with one
   valid code before activating). Follows the existing route/domain/test
   pattern; also gives you TOTP reset for locked-out users.
2. **`VercelBlobStore`** implementing `BlobStore`, selected by env
   (`BLOB_STORE=vercel` or presence of `BLOB_READ_WRITE_TOKEN`), keeping
   `LocalBlobStore` for dev/tests. Touch the three instantiation sites.

**P1 — before real traffic:**
3. `secure: true` (production) on the session cookie — one-line×2.
4. Login rate limiting: DB-backed attempt counter per email+IP with lockout
   window (no new infra; a `login_attempts` table + check in `login()`).
5. Password reset: admin-triggered reset link (email can wait — the accountant
   is the admin in the pilot; a copyable reset URL from the admin screen is
   enough for now).
6. Pool tuning for serverless: `max: 5`, `connectionTimeoutMillis`,
   `idleTimeoutMillis` in `src/db/pool.ts`; document pooled-vs-direct URLs in
   `.env.example`.
7. `/api/health` route (DB `SELECT 1`) + enable Vercel log drains or Sentry.

**P2 — shortly after:**
8. Scheduled `pg_dump` backup + documented restore drill.
9. Expired-session cleanup job (rows accumulate; correctness unaffected).
10. Preview-deploy hygiene: gate `/api/dev/bootstrap` on `VERCEL_ENV` too, so
    a preview deployment with unusual env config can never expose it.

**Deploy sequence** (per `docs/RUNNING.md` §3): create Neon DB → run
`npm run migrate` locally against the hosted `ADMIN_DATABASE_URL` → set Vercel
project Root Directory to `web`, add `DATABASE_URL` (pooled) +
`ADMIN_DATABASE_URL` + blob token → deploy → smoke-test login with a seeded
account → then P0 features let you onboard the first real user without seed
access.

## Relationship to the other plans

P1 items 3–4 overlap the security-hardening bucket from `docs/AUDIT-PLAN.md`
Phase 4 — doing them here satisfies that phase's top two items. The
`fix/known-issues` branch (in flight) is independent and should merge first.
