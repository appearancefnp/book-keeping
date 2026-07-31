# Pilot deployment on Hetzner — design

Date: 2026-07-31. Target: a **free pilot with one real accountant** — real Latvian
client books, no charging yet. Supersedes `docs/RUNNING.md` §3 (Vercel + Neon) as the
*primary* deployment path; §3 stays as the record of the Vercel option.

Companion audit: `docs/audit/PRODUCTION-READINESS.md` (2026-07-18) — all nine of its
findings are closed; this document covers what that audit did not: operating the thing.

---

## 1. Verdict

**Deployable, not yet safely operable.** Every gate about the *code* is green; the
gates about *running* it are missing.

| Gate | Result | Evidence |
|---|---|---|
| `npx tsc --noEmit` (root) | ✅ clean | run 2026-07-31 |
| `npx tsc --noEmit` (web) | ✅ clean | run 2026-07-31 |
| `cd web && npm run build` | ✅ succeeds | 82 API routes + ~30 pages; only `/login` is static |
| 2026-07-18 blocker list | ✅ all 9 closed | invites+TOTP enrolment, `VercelBlobStore`, rate limiting, secure cookie, security headers, `/api/health`, pool caps |
| Deploy runbook | ✅ exists | `docs/RUNNING.md` §3 — but Vercel/Neon-shaped |
| `npm test` | ⚠️ **unverified** | see §1.1 |
| Backups | ❌ none | no `pg_dump`, no offsite copy, no restore drill |
| CI | ❌ none | no `.github/`; Vercel builds only `web/` |
| Bank-feed provider in prod | ❌ fails open | `src/bankfeed/factory.ts:18` |
| Dev-bootstrap guard off Vercel | ❌ fails open | `src/dev/guard.ts:3` — loses its `VERCEL_ENV` belt on a VPS |

### 1.1 Why the test suite is unverified

Repeated attempts at `npm test` on 2026-07-31 failed with
`relation "schema_migrations" does not exist` and `tuple concurrently updated`.
Root cause established, not guessed: `pg_stat_activity` on `localhost:5433` showed a
steady 3–5 live sessions from a process outside the session's visibility, continuously
re-running migrations. Every `resetDb()` (`DROP SCHEMA public CASCADE` —
`tests/helpers/db.ts:11`) drops the schema out from under the concurrent run. The same
sequence executed by hand in `psql` succeeds, and a single isolated test file still
fails while the other process is live, so **the failures are environmental, not code**.

This is the argument for §6: with no CI, "is the suite green?" has no authoritative
answer. CI's isolated database is what makes the 693 tests trustworthy for the first
time.

### 1.2 Why not Vercel's free tier

Recorded because the question was asked directly, and because the answer is a hard
constraint rather than a preference.

**Vercel Hobby forbids this application.** Per the
[fair-use guidelines](https://vercel.com/docs/limits/fair-use-guidelines):
*"Commercial usage is defined as any Deployment that is used for the purpose of
financial gain of **anyone** involved in **any part of the production** of the project,
including a paid employee or consultant writing the code."* A bookkeeping SaaS is
commercial on its face, and the clause catches an unpaid pilot if anyone is paid to
build it. Hobby is restricted to non-commercial personal use only.

Three further free-tier facts bite this specific app, independent of the licence:

- **Hobby crons: minimum interval once per day, ±59 min jitter**
  ([docs](https://vercel.com/docs/cron-jobs/usage-and-pricing)). `/api/cron/jobs-drain`
  calls `drainOnce({ limit: 20 })`, so the entire job queue — dunning, recurring
  invoices, chain reapers — processes **≤20 jobs/day** at an unpredictable hour.
- **Runtime logs retained 1 hour on Hobby**, no log drains. A system whose selling
  point is an audit trail would have effectively unobservable runtime errors.
- **Neon free: 6-hour PITR window**, 0.5 GB/project, mandatory scale-to-zero after
  5 min. Exceeding Vercel Blob's Hobby allowance **locks Blob for 30 days** — uploaded
  source documents become unreadable, which is a functional failure, not a billing one.

Options considered and rejected: Vercel Pro + Neon free + DIY backups (~$20/mo);
Vercel Pro + Neon Launch (~$39/mo); the free Vercel Pro trial (hard cliff mid-pilot
with real client data on it). Hetzner won on cost, on being an EU-resident processor,
and on removing plan restrictions entirely.

A $0 Vercel Hobby deployment with **seeded data only** remains legitimate as a demo
URL. It must never hold real books.

---

## 2. Topology

**Hetzner CX22** — 2 vCPU / 4 GB RAM / 40 GB disk / 20 TB traffic, **€3.79/mo**, IPv4
included, Nuremberg or Helsinki. EU-resident processor, so GDPR paperwork is a single
Hetzner DPA rather than Vercel + Neon + Blob sub-processors.

Four containers on one Compose network:

| Service | Image | Role |
|---|---|---|
| `caddy` | `caddy:2` | the only public ports (80/443); auto-TLS; reverse-proxy to `web` |
| `web` | app image | `next start`; `DATABASE_URL` → `bookkeeping_app` |
| `worker` | app image | `npm run worker` — the real loop |
| `db` | `postgres:16` | named volume; **no published port** |

What the VPS changes in the app's favour, with no code written:

- **`LocalBlobStore` becomes correct again.** A VPS filesystem is persistent, so
  `makeBlobStore()` (`src/blob/factory.ts`) selects it automatically whenever
  `BLOB_READ_WRITE_TOKEN` is unset. No Blob quota, no 30-day lockout, no R2 adapter to
  write. Documents land on a bind-mounted volume.
- **`npm run worker` (`src/jobs/worker.ts`) becomes a long-running loop** instead of a
  once-daily HTTP cron. The 20-jobs/day ceiling and the ±59 min jitter both disappear.
  `web/vercel.json`'s crons and `/api/cron/*` routes stay in the repo, unused on this
  target, so the Vercel path remains viable.

The two-role DB model survives unchanged: `ADMIN_DATABASE_URL` → the container's
superuser for migrations and `provision-admin`; `DATABASE_URL` → non-owner
`bookkeeping_app` so append-only triggers and RLS stay DB-enforced.
`WORKER_DATABASE_URL` and `SUPERVISOR_DATABASE_URL` point at their own least-privilege
roles as today. Because Postgres is on the Compose network and not published, all four
connection strings are container-local and need no TLS.

4 GB is enough to **run** this and not enough to **build** it, which drives §3.

---

## 3. Build & deploy

### Decision: build in CI, ship an image

GitHub Actions builds one image and pushes it to GHCR; the VPS pulls it. Rationale:

- A webpack `next build` on 2 vCPU / 4 GB alongside a live Postgres risks OOM.
- Deploys become atomic with instant rollback — `docker compose up -d` on the previous
  image tag.
- It reuses the CI in §6 rather than adding a second build path.

Rejected: `git pull && docker compose up --build` on the box. Fewer moving parts, but
it takes the site down for the duration of every build and offers no rollback.

### Decision: plain `next start`, not `output: 'standalone'`

`web/next.config.ts` sets `experimental.externalDir` to import the domain from
`../src`, and the repo has two lockfiles. The build already warns:

> Next.js inferred your workspace root, but it may not be correct. We detected multiple
> lockfiles and selected the directory of `/home/karlis/git/book-keeping/package-lock.json`.

That is exactly the configuration where output-file tracing silently omits `src/` from
the traced bundle — a failure that appears at runtime, not build time. Shipping the
repo and running `next start` costs roughly 1 GB of image and buys certainty. Standalone
is a later optimisation, deliberately not a launch risk.

One image serves all three commands — `next start`, `npm run worker`, `npm run migrate`
— which keeps `tsx` (a root devDependency) available to the migration and
`provision-admin` scripts. Node pinned to **24**, matching `engines: {"node": ">=24"}`;
note the current dev machine runs Node 22.

### Deploy sequence

1. CI builds and pushes `ghcr.io/<owner>/bookkeeping:<sha>` on `main`.
2. On the box: pull the tag.
3. `docker compose run --rm web npm run migrate` — idempotent, safe to re-run.
4. `docker compose up -d` — recreates `web` and `worker` on the new image.

Rollback is step 2–4 with the previous tag; migrations are forward-only by design
(the ledger is append-only; corrections are reversals), so a rollback of application
code does not imply a schema rollback.

---

## 4. Code changes

Contained. Two are behaviour changes, and both are the same bug class: a guard that
fails open because it was written when Vercel's `VERCEL_ENV` provided a second belt.

1. **`src/bankfeed/factory.ts` — fail closed. P0.** Line 18 currently reads
   `id && key ? new GoCardlessProvider(id, key) : new StubBankFeedProvider({ autoLink: true })`.
   With GoCardless keys unset the stub auto-links a fake account and can inject demo
   transactions into real books. It must throw when `NODE_ENV === 'production'` and
   GoCardless keys are absent, unless `BANKFEED_ALLOW_STUB=1` is set explicitly (so the
   seeded demo deployment can still use the stub). `HANDOFF.md` flagged the cutover
   risk; the code still fails open. Needs a test per the existing convention, mirroring
   `src/dev/guard.ts`'s pure-predicate shape so the decision is unit-testable without
   touching `process.env`.
2. **`src/dev/guard.ts` — require a positive opt-in. P0.** `devBootstrapAllowed` is
   `NODE_ENV !== 'production' && !VERCEL_ENV` (line 3). On Vercel the `VERCEL_ENV` half
   always held, so the route was dead there regardless of `NODE_ENV`. On a VPS that half
   is gone and the guard rests entirely on `NODE_ENV=production` being set correctly in
   the container. If it is not, an **unauthenticated** `GET /api/dev/bootstrap` runs
   `runMigrations()`, seeds demo data, and signs the caller in as `accountant@demo.lv`
   with a known password (`web/app/api/dev/bootstrap/route.ts:21-29`) — against real
   books. Invert it to a positive opt-in (`DEV_ROUTES_ENABLED=1`) so the default is
   closed and a misconfigured `NODE_ENV` cannot open it. The existing guard test extends
   to cover the new predicate.
3. **`Dockerfile`** — multi-stage: install root + web deps, `next build`, then a
   `node:24-slim` runtime stage carrying `src/`, `migrations/`, `web/`, and
   `node_modules`.
4. **`docker-compose.prod.yml`** — the four services in §2, named volume for Postgres,
   bind mount for the blob store, `restart: unless-stopped`.
5. **`Caddyfile`** — one site block, auto-TLS, reverse-proxy to `web:3000`. HSTS and
   the other security headers already ship from `web/next.config.ts`; Caddy must not
   duplicate them.
6. **`web/next.config.ts`** — set `outputFileTracingRoot` to the repo root to resolve
   the workspace-root ambiguity even though standalone is off.
7. **`.env.example`** — add a VPS section (including `DEV_ROUTES_ENABLED` and
   `BANKFEED_ALLOW_STUB`, both documented as *leave unset in production*); move the
   Vercel/Neon guidance under its own labelled heading rather than deleting it.
8. **`docs/RUNNING.md`** — new §4 "Deploying on a VPS (Hetzner + Docker Compose)".
   §3 is retained and relabelled as the Vercel option.

---

## 5. Backups + restore

A host-level systemd timer, deliberately **not** a container, so it survives app
failure:

- `pg_dump -Fc` executed against the `db` container → `/backups` on the host.
  Retention: 7 daily + 4 weekly.
- `restic` pushes `/backups` **and** the blob volume offsite to
  **Cloudflare R2** (10 GB free, no egress fees), using R2's S3-compatible endpoint.
  Chosen over `rclone` for deduplication and native retention pruning
  (`restic forget --keep-daily 7 --keep-weekly 4`). Swap to a Hetzner Storage Box
  (€3.20/mo, 1 TB) when documents outgrow 10 GB.
- Both halves matter: the ledger is in Postgres, the source documents are on the
  filesystem. A Postgres-only backup cannot reconstruct an audit trail.

### The restore drill

A documented checklist that is actually executed once before real data lands, then
quarterly:

1. Restore the newest dump into a throwaway `postgres:16` container.
2. Run `npm run migrate` against it — must apply nothing (proves the dump is current
   with `migrations/`).
3. Assert non-zero row counts on `journal_entries` and `einvoices`.
4. Restore the blob archive and open one document through the app against the restored
   DB.

Encryption at rest is **out of scope** by explicit decision (§8) and will be recorded
in the runbook as an accepted risk, not silently dropped.

---

## 6. CI

`.github/workflows/ci.yml`, two jobs.

**Job `test`** — on every push and PR. A `postgres:16` service container, Node 24, then
strictly serially:

1. `npm ci` (root) and `npm ci` (web)
2. `npm run migrate` — redundant with `resetDb()` but fails fast with a readable error
   when a new migration is broken, instead of surfacing as 100+ opaque test failures
3. `npm test`
4. `npx tsc --noEmit` (root)
5. `cd web && npx tsc --noEmit`
6. `cd web && npm run build`

Single job, serial by design: `vitest.config.ts` already sets `pool: 'forks'`,
`singleFork: true`, `fileParallelism: false` because `resetDb()` drops the schema. Two
concurrent suites against one database destroy each other — the failure diagnosed in
§1.1. CI's dedicated database is what makes the suite authoritative.

This also puts `tests/db/migration-numbering.test.ts` on the critical path, guarding the
known migration-number collisions (the four historical 023–026 pairs are grandfathered;
new collisions fail).

**Job `image`** — `main` only, `needs: test`. Builds and pushes
`ghcr.io/<owner>/bookkeeping:<sha>` plus `:latest`.

---

## 7. Cutover runbook

Largely `docs/RUNNING.md` §3.4–§3.5 with the hosting steps swapped:

1. Provision the CX22 (Nuremberg or Helsinki), harden SSH, install Docker.
2. Write `.env` on the host, `chmod 600`. Four distinct connection strings; the app
   role is not the owner.
3. Point DNS at the box; Caddy obtains certificates on first boot.
4. `docker compose run --rm web npm run migrate`.
5. `PROVISION_FIRM="…" PROVISION_EMAIL="…" docker compose run --rm web npm run provision-admin`
   → open the printed `/invite/<token>` (72 h, single use), set a password, enrol TOTP.
6. Install the backup timer (§5) and **run the restore drill before the accountant
   logs in**.

### Smoke checklist

Inherited from §3.5, with three changes (the last three items):

- [ ] `GET https://<host>/api/health` → `{"ok":true}` (200)
- [ ] Log in as the provisioned admin: email + password + TOTP
- [ ] Upload a document; confirm extraction runs (Stub unless an AI key is set)
- [ ] Issue an invoice; confirm it posts and appears in the outbox
- [ ] `GET /api/dev/bootstrap` → 403, with `DEV_ROUTES_ENABLED` unset (§4.2). Verify by
      hitting the URL, not by inspecting env: this route migrates and seeds the database
      and signs the caller in, so a false negative here is unrecoverable
- [ ] **New:** confirm the bank-feed provider refuses to auto-link a stub account
      (the §4.1 fix)
- [ ] Blob cache-bypass check from §3.5 is **not applicable** — `LocalBlobStore` has no
      CDN in front of it

---

## 8. Out of scope

Named so they are visibly deferred rather than forgotten:

- Observability — no structured logging in `web/app`, no error tracking, no uptime
  monitor. **Revisit before real data lands**; it is the highest-value deferred item
  now that there is no platform to page.
- Disk encryption at rest (payroll stores `personas kods`).
- GDPR data export and erasure — absent. With one pilot client an Art. 15/17 request is
  answerable by hand; it belongs in writing in whatever is signed with the accountant.
- Audit-log tamper detection (hash chain).
- Email delivery of any kind: invites and credential resets stay copy-paste URLs,
  dunning creates internal tasks only, there is no self-service password reset (an
  admin re-invite resets credentials + 2FA).
- Peppol `AccessPoint` and VID `VidClient` remain stubs. Latvia's **B2B** e-invoicing
  mandate was postponed to **2028-01-01** (voluntary from 2026-03-30), so this is not a
  legal blocker for a B2B pilot. Mandatory e-invoice data reporting to VID for
  **B2G/G2G** has been in force since 2026-01-01 — blocking only if the accountant's
  clients invoice budget institutions. Confirm which before onboarding.

---

## 9. Risks

- **The suite's true state is unknown.** If CI surfaces real failures, §6 becomes the
  first task rather than the last, and the cutover waits.
- **40 GB disk** holds Postgres, scanned documents, and local backups. Adequate for one
  client; add a Storage Box before the second.
- **Single box, no redundancy.** Restore-from-backup is the entire recovery story, which
  is why §5's drill is non-negotiable.
- **You are the ops team.** No platform to page. §5 plus the deferred uptime monitor are
  the mitigation.
- **Root Directory divergence.** The Vercel path builds only `web/`; this path builds
  the whole repo. Keeping `docs/RUNNING.md` §3 alive means two deployment paths to keep
  honest — acceptable while the demo URL is wanted, worth deleting once it is not.
