# Production-Readiness Audit — Vercel + free-tier stack, real users

Date: 2026-07-18. Target deployment: `web/` on **Vercel** (Hobby/free), a **free
managed Postgres**, real interactive users. Every finding below was verified in
code with file:line evidence (read-only scout pass; nothing speculated).

> ## ⚠️ Status as of 2026-07-31 — read this first
>
> **This audit's findings are all closed or superseded, and its recommended stack
> is no longer the plan.** It is retained as the record of what was true on
> 2026-07-18 and why. For how this app is actually deployed, see
> `docs/RUNNING.md` §4 and `docs/superpowers/specs/2026-07-31-hetzner-pilot-deployment-design.md`.
>
> **The deployment target changed from Vercel to a single Hetzner CX22 VPS.**
> Vercel Hobby is not usable for this application: its
> [fair-use guidelines](https://vercel.com/docs/limits/fair-use-guidelines) define
> commercial usage as *"any Deployment that is used for the purpose of financial
> gain of **anyone** involved in **any part of the production** of the project,
> including a paid employee or consultant writing the code"* and restrict Hobby to
> non-commercial personal use. Independently of the licence, three Hobby limits
> break this app: crons run **at most once per day with ±59 min jitter**, so
> `/api/cron/jobs-drain`'s `drainOnce({ limit: 20 })` would cap the entire job
> queue at ~20 jobs/day; runtime logs are retained **one hour**; and Neon's free
> tier keeps **6 hours** of point-in-time restore, which is not a backup story for
> records carrying multi-year retention obligations. Exceeding Vercel Blob's Hobby
> allowance locks Blob for 30 days, which would make uploaded source documents
> unreadable.
>
> **Status of this audit's nine findings:** 1–7 closed 2026-07-19; 8 partially
> closed; 9 closed 2026-07-31. **P2 items 8 and 10 of the work plan are closed by
> the Hetzner deployment work.** Per-item detail is annotated inline below.
>
> **What is still genuinely open** (carried into `docs/RUNNING.md` §4.9): no
> observability or error tracking, no disk encryption at rest, no GDPR data
> export/erasure, no audit-log tamper detection (hash chain), no self-service
> password reset, no email delivery of any kind, and Peppol/VID remain stubs.

## Verdict

> **Superseded 2026-07-31.** The three blockers below were closed on 2026-07-19,
> and the app has since been deployed-ready against a VPS rather than Vercel. The
> original verdict is kept verbatim as the record.

**Not deployable for real users today.** The app is architecturally ready for
Vercel (clean two-role DB model, env-guarded dev route, short pooler-safe
transactions, no Edge-incompatible code paths), but three hard blockers mean a
real user literally cannot exist, log in, or keep their uploads:

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | No user provisioning over HTTP — `createUser` (`src/auth/users.ts:17`) is reachable only from `npm run seed` and the dev bootstrap route; `web/app/api/admin/users/route.ts` is GET-only | **BLOCKER** | **CLOSED 2026-07-19** — `src/auth/invites.ts`, `migrations/033_user_invites.sql`, `POST /api/admin/users` |
| 2 | No 2FA enrolment — `totpUri()` (`src/auth/totp.ts:46`) is only printed by the seeder; login requires TOTP (`src/auth/sessions.ts:12`), so any non-seed user is hard locked out | **BLOCKER** | **CLOSED 2026-07-19** — `/invite/[token]` page enrols TOTP via QR before activation |
| 3 | Blob storage is local-disk only — `LocalBlobStore` (`src/blob/blob-store.ts:10`) is the sole `BlobStore` impl, used by document capture, logo upload, and invoice render. Vercel's filesystem is ephemeral: **uploads are lost between invocations** | **BLOCKER** | **CLOSED 2026-07-19** — `src/blob/vercel-blob-store.ts`. Note: on the VPS target this is moot — a persistent filesystem makes `LocalBlobStore` correct, and `makeBlobStore()` selects it whenever `BLOB_READ_WRITE_TOKEN` is unset |
| 4 | Session cookie missing `secure: true` (`web/app/api/auth/login/route.ts:19-24`) | GAP | **CLOSED 2026-07-19** — `secure: process.env.NODE_ENV === 'production'` |
| 5 | No login rate limiting / lockout anywhere | GAP | **CLOSED 2026-07-19** — `src/auth/rate-limit.ts`, 5 failures / 15 min per email *and* per IP, fail-closed |
| 6 | No password reset or change-password flow | GAP | **STILL OPEN** — an admin re-invite via Admin → Users resets credentials + 2FA; there is no self-service "forgot password" |
| 7 | Pool config has no `max`/timeouts/`ssl` (`src/db/pool.ts:4-5`) | GAP | **CLOSED 2026-07-19** — `max: 5` with `connectionTimeoutMillis`/`idleTimeoutMillis`. On the VPS, Postgres is unpublished on the Compose network, so no TLS is needed on those DSNs |
| 8 | No observability: zero logging in `web/app`, no error reporting, no health-check route | GAP | **PARTIAL** — `GET /api/health` shipped 2026-07-19 (`SELECT 1` + blob config status). Structured logging and error reporting are **still open**; there is no Sentry or equivalent anywhere |
| 9 | No backup/tenant-export story (reports export ≠ backup); you'd rely wholly on the DB provider's snapshots | GAP | **BACKUP CLOSED 2026-07-31** — `scripts/backup.sh` (Postgres dump + blob tarball → offsite via restic) and `scripts/restore-drill.sh`, driven by `deploy/bookkeeping-backup.{service,timer}`. **Tenant export for GDPR is still open** |

**Already OK for prod:** `/api/dev/bootstrap` self-guards on
`NODE_ENV === 'production'` and is the only unauthenticated route besides login;
migrations run out-of-band as admin while the app runs entirely as
`bookkeeping_app`; `withTenant` uses transaction-local `set_config` — compatible
with a transaction-mode pooler; no LISTEN/NOTIFY, advisory locks, or long
transactions; config surface is small and mostly optional.

> **Corrected 2026-07-31.** The dev-bootstrap claim above is no longer accurate,
> and it understated the risk. `devBootstrapAllowed` (`src/dev/guard.ts`) now
> requires a **positive opt-in**, `DEV_ROUTES_ENABLED=1`, and only then applies
> `NODE_ENV`/`VERCEL_ENV` as vetoes. The old predicate had no opt-in, so off
> Vercel it rested entirely on `NODE_ENV` being set correctly — and this route is
> unauthenticated, runs `runMigrations()`, seeds demo data, and signs the caller
> in as a known demo user. On Vercel the always-present `VERCEL_ENV` masked that;
> a VPS removes the mask. See P2 item 10 below.

## Recommended free stack

> **⚠️ Superseded 2026-07-31 — do not follow this table.** It recommends Vercel
> Hobby, which forbids commercial use of this application (see the status note at
> the top). Kept as the record of the 2026-07-18 recommendation. The current stack
> is below it.

| Need | Pick | Why / notes |
|------|------|-------------|
| Hosting | ~~**Vercel Hobby**~~ | ~~Free; note Hobby ToS is non-commercial — fine for pilot, plan Pro before charging clients.~~ **Wrong:** the non-commercial restriction is not a footnote, it is disqualifying. |
| Postgres | ~~**Neon free tier**~~ | ~~Real Postgres 16+, allows `CREATE ROLE`…~~ Superseded; 6-hour PITR is insufficient. |
| File uploads | ~~**Vercel Blob**~~ | Implemented (`src/blob/vercel-blob-store.ts`) and retained for the Vercel path, but unused on the VPS. |
| AI extraction/assistant | **`GEMINI_API_KEY` free tier** | Still accurate, and the retention caveat still stands: free Gemini is not zero-retention — do not feed real client invoices through it. Note that as of 2026-07-31 running with **no** AI key now fails closed rather than silently fabricating a stub extraction. |
| Error tracking | ~~Vercel runtime logs~~ | Superseded; on a VPS this is container logs. Still an open gap either way. |
| Backups | ~~Neon PITR~~ | Superseded by `scripts/backup.sh` + `scripts/restore-drill.sh`. |

### Current stack (2026-07-31)

| Need | Pick | Notes |
|------|------|-------|
| Hosting | **Hetzner CX22** (2 vCPU / 4 GB / 40 GB, ~€3.79/mo, Nuremberg or Helsinki) | EU-resident processor, so GDPR paperwork is a single Hetzner DPA rather than Vercel + Neon + Blob sub-processors. No plan restriction on commercial use. |
| Runtime | **Docker Compose + Caddy** | `caddy` holds the only public ports; `db` publishes none. `docker-compose.prod.yml`, `deploy/Caddyfile`. |
| Postgres | **`postgres:16` in Compose**, named volume | Two-role model unchanged. Role passwords are rotated off the migrations' defaults by `scripts/rotate-db-passwords.sh`. |
| File uploads | **`LocalBlobStore`** on a named volume | Correct again on a persistent filesystem; selected automatically when `BLOB_READ_WRITE_TOKEN` is unset. |
| Job queue | **`npm run worker`** as a long-lived loop | Replaces `/api/cron/jobs-drain`. Bank-feed sync is **not** covered by the worker and runs from `deploy/bookkeeping-banksync.{service,timer}`. |
| Backups | **`scripts/backup.sh`** nightly via systemd → restic offsite | Dumps Postgres **and** the blob volume — a Postgres-only backup cannot reconstruct an audit trail. `RESTIC_REPOSITORY` is mandatory: the script exits non-zero without it, because local dumps are pruned at 8 days. |
| CI | **GitHub Actions** (`.github/workflows/ci.yml`) | The repo's first CI. Green at 171 files / 750 tests. |

## Go-live work plan (ordered)

> **All items below are closed except P1 item 5 (password reset).** Annotated
> inline; the original ordering is kept as the record.

**P0 — blockers (must ship before any real user):**
1. ~~**Invite-based user provisioning + 2FA enrolment**~~ **CLOSED 2026-07-19.**
2. ~~**`VercelBlobStore`**~~ **CLOSED 2026-07-19.**

**P1 — before real traffic:**
3. ~~`secure: true` (production) on the session cookie~~ **CLOSED 2026-07-19.**
4. ~~Login rate limiting~~ **CLOSED 2026-07-19** (`src/auth/rate-limit.ts`).
5. **Password reset — STILL OPEN.** Admin re-invite is the only path today. The
   original note ("email can wait — the accountant is the admin in the pilot")
   still holds, and there is still no email delivery of any kind.
6. ~~Pool tuning for serverless~~ **CLOSED 2026-07-19** (`max: 5` + timeouts).
7. ~~`/api/health` route~~ **CLOSED 2026-07-19.** The log-drain/Sentry half of
   this item is **still open** — see finding 8.

**P2 — shortly after:**
8. ~~Scheduled `pg_dump` backup + documented restore drill~~ **CLOSED 2026-07-31.**
   `scripts/backup.sh` + `scripts/restore-drill.sh` + the systemd unit/timer pair.
   The drill is deliberately able to *fail*: it restores the newest dump into a
   throwaway container and asserts `journal_entries` is populated, exiting
   non-zero otherwise. `docs/RUNNING.md` §4.6 requires running it before the
   accountant logs in.
9. ~~Expired-session cleanup job~~ **CLOSED 2026-07-19** — opportunistic sweep on
   login (`src/auth/sessions.ts:16-17`), best-effort so a sweep failure cannot
   block a valid login.
10. ~~Preview-deploy hygiene: gate `/api/dev/bootstrap` on `VERCEL_ENV` too~~
    **CLOSED 2026-07-31, and done more strongly than proposed.** Rather than
    adding a second veto, the guard was inverted to a positive opt-in
    (`DEV_ROUTES_ENABLED=1`, `src/dev/guard.ts`), so the route is closed by
    default and a misconfigured `NODE_ENV` cannot open it.

~~**Deploy sequence** (per `docs/RUNNING.md` §3)~~ — superseded. The current
sequence is `docs/RUNNING.md` §4: provision the CX22 → write `.env` → `pull` →
`npm run migrate` → `scripts/rotate-db-passwords.sh` → `up -d --force-recreate` →
`npm run provision-admin` → install the backup and bank-sync timers → run the
restore drill → smoke-test on the real host. §3 is retained as the Vercel option.

## Relationship to the other plans

P1 items 3–4 overlap the security-hardening bucket from `docs/AUDIT-PLAN.md`
Phase 4 — doing them here satisfies that phase's top two items. The
`fix/known-issues` branch (in flight at the time) is independent and merged first.

> **Added 2026-07-31.** This audit asked "can the app be deployed?" and answered
> in terms of features a user needs. The Hetzner work asked the complementary
> question — "can it be *operated*?" — and found a class this audit did not look
> for: **guards that fail open when an optional credential is absent.** Three
> instances existed, each substituting fabricated data for real:
> the auto-linking stub bank feed (`src/bankfeed/factory.ts`), the dev-bootstrap
> route (`src/dev/guard.ts`), and the stub document extractor
> (`selectExtractor()` in the capture and expense-upload routes, which persisted a
> canned invoice into an immutable `document_versions` row). All three now require
> an explicit `=1` opt-in and throw otherwise. Worth carrying into future audits:
> grep for `process.env.X ? real : stub` and ask what happens in production.
