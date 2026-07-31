# Running the AI Bookkeeping platform

Two pieces: the **backend** (tested TypeScript domain — ledger, AI/OCR intake, VAT, banking,
Peppol/VID, auth, API handlers) at the repo root, and the **`web/` app** (Next.js cabinet UI).

---

## Prerequisites

- **Node 24+** (repo tested on Node 26)
- **Docker** (for local Postgres). On macOS without Docker Desktop, [Colima](https://github.com/abiosoft/colima) works: `brew install colima docker docker-compose && colima start`.
- Postgres 16 is provided by `docker-compose.yml` (host port **5433**).

---

## 1. Local — backend

```bash
# from repo root
npm install
cp .env.example .env                 # DATABASE_URL + ADMIN_DATABASE_URL (defaults match docker-compose)
docker compose up -d db              # Postgres 16 on localhost:5433
npm run migrate                      # apply SQL migrations (idempotent)
npm test                             # full suite (132 tests) against the real DB
npm run typecheck                    # tsc --noEmit
```

`.env` (see `.env.example`) needs:
```
ADMIN_DATABASE_URL=postgres://admin:admin@localhost:5433/bookkeeping   # runs migrations; owns tables
DATABASE_URL=postgres://bookkeeping_app:app_pw@localhost:5433/bookkeeping  # runtime app role (non-owner, RLS-bound)
```
Two roles by design: migrations run as `admin`; the app connects as the non-superuser
`bookkeeping_app` so append-only + row-level-security are enforced by the database, not by convention.

### Seed demo data

```bash
npm run seed
```

**This WIPES the database**, re-migrates, and inserts a rich known dataset so every screen is
non-empty: firm **Demo Grāmatvedības Birojs**, two clients (**SIA Ziemeļvējs**, **SIA Baltic
Coffee**), an **accountant** (sees both) and an **owner** (sees the first), a Latvian chart of
accounts, open Feb/Mar 2026 periods, parties, documents, and a full **approval queue** per client
(2 purchase-posting proposals + 1 bank-match + 1 VAT-declaration), plus two tasks (one open with
a comment, one resolved) and two notifications for the accountant.

It prints login credentials at the end:
- `accountant@demo.lv` / `owner@demo.lv`, password **`password123`**
- a **TOTP secret** + a **current 6-digit 2FA code** + an `otpauth://` URI. Add the secret to any
  authenticator app (or use the printed code within its 30s window). 2FA is mandatory.

---

## 2. Local — web cabinet (`web/`)

```bash
docker compose up -d db              # from repo root — same Postgres
npm run seed                         # from repo root — seed the demo dataset (recommended)
cd web
npm install
cp .env.local.example .env.local 2>/dev/null || echo "DATABASE_URL=postgres://bookkeeping_app:app_pw@localhost:5433/bookkeeping" > .env.local
npm run dev                          # http://localhost:3000
```

### Logging in

Go to **`http://localhost:3000/login`** and enter:

| Field | Value |
|---|---|
| Email | `accountant@demo.lv` (sees both clients) or `owner@demo.lv` (sees the first) |
| Password | `password123` |
| 2FA code | printed by `npm run seed` — a 6-digit TOTP code (30s window) |

2FA is mandatory. If the printed code expires before you log in, re-run `npm run seed` (it prints a fresh code) or add the `otpauth://` URI to an authenticator app (e.g. Google Authenticator, Aegis) and use that going forward.

Alternatively, set `DEV_ROUTES_ENABLED=1` in `web/.env.local` and hit
**`http://localhost:3000/api/dev/bootstrap`** once — a dev-only route that migrates, seeds a
minimal dataset, signs you in automatically, and redirects to `/`. The route is a positive
opt-in and 403s without that flag (`src/dev/guard.ts`), because it is unauthenticated and
signs the caller in as a demo user. Handy for quick iteration; leave the flag unset in
production.

### Cabinet navigation

After login the cabinet shows a client-switcher (accountant only) and a sidebar with:

| Screen | What it shows |
|---|---|
| **Queue** | Approval queue — pending posting, bank-match, and VAT-declaration proposals |
| **Documents** | Uploaded documents; upload new ones for OCR extraction |
| **Overview** | Trial balance, VAT summary, open receivables |
| **Tasks** | Task list with open/resolved filter; click a task to read/add comments |
| **Notifications** | Inbox — mark individual or all notifications read |
| **Admin** | Firm clients, users, and the audit log (accountant role only) |
| **Ask** (slide-over) | AI assistant chat — summarises the client's financial data on demand |

A **language switcher** (LV / EN) is in the top bar. The UI and all labels flip between
Latvian and English; data (account names, memos) stays as seeded.

### AI assistant and OCR extraction

Both default to **Stub mode — no LLM or API key required**; the demo is fully functional without one.

For real responses, set one of these env vars in `web/.env.local`:

| Env var | Provider | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic Claude | Paid; zero-retention tier available |
| `GEMINI_API_KEY` | Google Gemini | Free tier; not zero-retention |
| `OLLAMA_HOST` | Local Ollama | Free + private; run `ollama serve` locally |

The assistant and the document extractor each pick up whichever key is set (Anthropic takes
precedence, then Gemini, then Ollama, else Stub).

### Bank feeds (GoCardless Bank Account Data)

Defaults to a **Stub provider with auto-linking** — no API keys required; connecting a bank on
`/bank` links a fake account and consent instantly for local/demo use.

For a real feed, set these env vars in `web/.env.local` (and, in production, on the Vercel
project — see §3.3):

| Env var | Effect |
|---|---|
| `GOCARDLESS_SECRET_ID` / `GOCARDLESS_SECRET_KEY` | GoCardless Bank Account Data API credentials; both must be set to use the real provider (`src/bankfeed/factory.ts`) — absent ⇒ falls back to the keyless stub provider *outside* production. With `NODE_ENV === 'production'` and no keys, the factory throws instead of falling back, unless `BANKFEED_ALLOW_STUB=1` is set explicitly (`src/bankfeed/stub-allowed.ts`) — the stub auto-links a fake account, which must never happen against real books. |
| `CRON_SECRET` | Bearer token for `GET /api/cron/bank-sync`. The operator chooses a value and sets it as a project environment variable in Vercel (and locally when testing); Vercel then automatically attaches it as `Authorization: Bearer <CRON_SECRET>` on requests to cron routes. The route fails closed (always 401) when unset. |

To exercise the real GoCardless sandbox end-to-end outside the test suite, run
`npx tsx scripts/bankfeed-sandbox.ts` (needs `GOCARDLESS_SECRET_ID`/`GOCARDLESS_SECRET_KEY` set) —
it creates a requisition against the `SANDBOXFINANCE_SFIN0000` sandbox institution and prints a
consent URL; open and approve it, then re-run the script with the printed requisition id to list
the linked sandbox account(s) and a page of transactions.

---

## 3. Deploying on Vercel (Neon + Vercel Blob) — the hosted option

The `web/` Next.js app deploys to Vercel; the backend domain ships with it (route handlers run as
**Node.js** serverless functions — `pg` needs the Node runtime, not Edge). This is the concrete,
copy-paste sequence used for the hobby release; the only things you fill in are your own
`<your-deployment>` hostname and secrets.

### 3.1 Create the Neon project

1. [console.neon.tech](https://console.neon.tech) → **New project** (free tier is fine).
2. Neon gives you a **pooled** connection string (host contains `-pooler`) and a **direct** one
   (same host without `-pooler`). You need both, each with `?sslmode=require` appended:
   - **pooled** → `DATABASE_URL` (the app's runtime role, `bookkeeping_app`; every route handler
     runs as a short-lived serverless invocation, so this must go through Neon's pooler)
   - **direct** → `ADMIN_DATABASE_URL` (migrations + `provision-admin`; infrequent, needs a plain
     session-mode connection, not the transaction pooler)
   - Both roles matter because `src/db/pool.ts` caps each pool at **`max: 5`** connections
     (`connectionTimeoutMillis: 10_000`, `idleTimeoutMillis: 30_000`) — sized to survive many
     concurrent serverless invocations against a free-tier Postgres without exhausting it.
3. On a fresh Neon DB, connect **as the Neon-created owner role** for `ADMIN_DATABASE_URL` —
   `migrations/000_bootstrap.sql` creates the non-owner `bookkeeping_app` role (and its grants +
   `FORCE ROW LEVEL SECURITY` policies) the first time migrations run, so `DATABASE_URL` only
   works *after* step 3.2.

### 3.2 Run migrations against the hosted DB (from your machine, once)

```bash
# repo root — point .env at the Neon DB for this one run
ADMIN_DATABASE_URL="postgres://<owner>:<pw>@<direct-host>/<db>?sslmode=require" \
DATABASE_URL="postgres://<owner>:<pw>@<pooled-host>/<db>?sslmode=require" \
npm run migrate
```

`npm run migrate` is idempotent (`node --env-file-if-exists=.env --import tsx src/db/migrate.ts`,
`package.json`) — safe to re-run after every subsequent deploy that adds migrations.

### 3.3 Create the Vercel project

1. Import the repo → **Root Directory** = `web` (the deployable app; Framework preset Next.js,
   build/output auto-detected — `next build --webpack`, per `web/package.json`).
2. **Storage → Blob** in the Vercel dashboard → create a store, **private** access. Linking it to
   the project auto-injects `BLOB_READ_WRITE_TOKEN`; if you created the store separately, copy its
   read-write token into the env var by hand.
3. **Project → Settings → Environment Variables**, set for Production (and Preview if you use it):

   | Var | Value |
   |---|---|
   | `DATABASE_URL` | Neon **pooled** string + `?sslmode=require` |
   | `ADMIN_DATABASE_URL` | Neon **direct** string + `?sslmode=require` |
   | `WORKER_DATABASE_URL` | Neon **pooled** string + `?sslmode=require`, connecting as `bookkeeping_worker` (role created by migration `039`). Required at runtime by `GET /api/cron/jobs-drain` (`src/db/pool.ts`'s `workerPool`) — the route 500s without it. |
   | `SUPERVISOR_DATABASE_URL` | Neon **pooled** string + `?sslmode=require`, connecting as `bookkeeping_supervisor` (role created by migration `041`). Also required by `GET /api/cron/jobs-drain` (`supervisorPool`) for the reap step. |
   | `BLOB_READ_WRITE_TOKEN` | from the Blob store (auto-set if linked) — enables `VercelBlobStore` (`src/blob/factory.ts` picks it over `LocalBlobStore` whenever this var is present) |
   | `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` | real AI extraction/assistant. Gemini's free tier is **not zero-retention** — don't feed real client documents through it until you're on a paid/zero-retention tier or have switched to `ANTHROPIC_API_KEY` (it takes precedence when both are set). Ollama is local-only; it does not run on Vercel. |
   | `GOCARDLESS_SECRET_ID` / `GOCARDLESS_SECRET_KEY` | real GoCardless Bank Account Data provider for `/bank` feeds. Leaving both unset on a **Production** Vercel deployment (where `NODE_ENV === 'production'`) now makes `makeBankFeedProvider()` throw rather than silently auto-link a fake account — set `BANKFEED_ALLOW_STUB=1` too if this is deliberately a seeded-demo deployment, never for real books |
   | `CRON_SECRET` | required once `web/vercel.json`'s crons are live. The operator chooses a value and sets it as a project environment variable in Vercel; Vercel automatically attaches it as `Authorization: Bearer <CRON_SECRET>` on cron-triggered requests to `GET /api/cron/bank-sync` and `GET /api/cron/jobs-drain` (both checked via the shared `cronAuthorized` helper, `web/app/lib/cron-auth.ts`, timing-safe). Unset ⇒ cron requests fail 401. |

   Full var reference: `.env.example` (repo root) — it documents the Neon pooled/direct split and
   the Blob/Gemini notes inline; don't duplicate it here.

   Two crons run daily (`web/vercel.json`, both UTC) and need no setup beyond the repo containing
   the file — Vercel registers them from the deployed project automatically:
   - `0 5 * * *` — bank-sync (`/api/cron/bank-sync`)
   - `0 6 * * *` — jobs-drain (`/api/cron/jobs-drain`; after bank-sync so the day's payments settle
     receivables before dunning runs). This is the Vercel entrypoint for the job queue that
     `src/jobs/worker.ts` otherwise drains via a standalone `npm run worker` loop — self-hosted
     (non-Vercel) deployments that don't want a cron-triggered HTTP endpoint can run that loop
     instead and skip `WORKER_DATABASE_URL`/`SUPERVISOR_DATABASE_URL` provisioning here (the worker
     process picks up the same env vars from its own environment).
4. Deploy. `/api/dev/bootstrap` is dead in this environment on purpose — `devBootstrapAllowed`
   (`src/dev/guard.ts`) requires the positive opt-in `DEV_ROUTES_ENABLED=1` first, then vetoes
   if `NODE_ENV === 'production'` or `VERCEL_ENV` is set. Nobody sets `DEV_ROUTES_ENABLED` on
   Vercel, and Vercel always sets `VERCEL_ENV` regardless, so it 403s on every Vercel
   deployment, preview or production, for two independent reasons.

Security posture that ships without any extra config: `web/next.config.ts` sends
`Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and
`Referrer-Policy: strict-origin-when-cross-origin` on every response; the session cookie sets
`secure: true` whenever `NODE_ENV === 'production'` (`web/app/api/auth/login/route.ts`); and login
is rate-limited to **5 failures / 15 minutes**, tracked per email *and* per IP
(`src/auth/rate-limit.ts`, wired into `POST /api/auth/login` and the invite-accept route).

### 3.4 Provision the first admin user

There is no seed data in a hosted DB — `npm run provision-admin` creates (or re-invites) exactly
one firm + `firm_admin` user and prints a single-use invite link. It's idempotent on email: run it
again for the same email and it re-invites; run it for an email that already belongs to a
*different* firm and it aborts without changing anything (`src/dev/provision-admin.ts`).

```bash
# repo root — same hosted connection strings as step 3.2
ADMIN_DATABASE_URL="postgres://<owner>:<pw>@<direct-host>/<db>?sslmode=require" \
DATABASE_URL="postgres://<owner>:<pw>@<pooled-host>/<db>?sslmode=require" \
PROVISION_FIRM="My Firm" PROVISION_EMAIL="me@myfirm.lv" \
npm run provision-admin
```

It prints:

```
Invite path (valid until <ISO timestamp>, single use):
  /invite/<token>

Open it as https://<your-deployment>/invite/<token>
```

The invite is valid **72 hours** and single-use (`src/auth/invites.ts` — `INVITE_TTL_SECONDS`).
Open `https://<your-deployment>/invite/<token>` in a browser: the page (`web/app/invite/[token]/`)
lets you set a password and shows a QR code (+ manual secret) to enrol TOTP 2FA in an
authenticator app before the account activates. Once activated, invite more users the same way
from **Admin → Users** in the cabinet (`POST /api/admin/users`, role-gated `users.write`) instead
of re-running the CLI script — the CLI is only for the very first admin.

### 3.5 Smoke-test checklist

Run through all of these against the live deployment before calling it launched:

- [ ] `GET https://<your-deployment>/api/health` → `{"ok":true}` (200; checks `SELECT 1` against
      `DATABASE_URL` — `web/app/api/health/route.ts`).
- [ ] Log in as the provisioned admin: email + password + current TOTP code.
- [ ] Upload a document (Documents screen) and confirm OCR/extraction runs (Stub unless an AI key
      is set).
- [ ] Issue an invoice (Invoices → New) and confirm it posts and appears in the outbox.
- [ ] **Blob cache-bypass check:** re-upload the invoice logo (Settings), then *immediately* open
      an invoice document view — the **new** logo must render, not a stale cached one. This
      exercises `VercelBlobStore.get`'s `useCache: false` read (`src/blob/vercel-blob-store.ts`),
      which exists precisely because the logo key is overwritten in place
      (`allowOverwrite: true`) rather than given a fresh key per upload.
- [ ] Confirm `/api/dev/bootstrap` returns 403 on the deployed URL (it should — the route
      requires the positive opt-in `DEV_ROUTES_ENABLED=1`, which nobody sets on Vercel, and
      `VERCEL_ENV` is always set there too, so both independent guards hold).

### 3.6 Backups

Neon's free tier includes point-in-time-restore (PITR) with a limited retention window — fine for
a pilot, but add a scheduled `pg_dump` (e.g. a cron hitting a small script, or a manual habit)
against `ADMIN_DATABASE_URL` **before** real client data volume grows, since free-tier PITR history
is short.

---

## 4. Deploying on a VPS (Hetzner + Docker Compose)

Full design rationale: `docs/superpowers/specs/2026-07-31-hetzner-pilot-deployment-design.md`.
This section is the concrete, copy-paste sequence that follows from it — **this is the
primary path for the pilot**, not a fallback.

### 4.1 Why this is the primary path

Vercel's Hobby tier is contractually restricted to non-commercial personal use — its
fair-use terms treat any deployment as commercial the moment anyone involved in building it
is paid, which this app is on its face. Hobby's crons also run at most once a day with up to
±59 minutes of jitter, which caps the job queue (`GET /api/cron/jobs-drain`, `drainOnce({
limit: 20 })`) at roughly 20 jobs/day for dunning, recurring invoices, and chain reapers.
Neon's free tier keeps only a 6-hour point-in-time-restore window. None of these are workable
for a pilot holding real client books, so this deployment runs on a Hetzner VPS instead — see
the design doc's §1.2 for the full accounting. §3 above remains the record of the Vercel path
and stays viable as a **seeded-demo-only** URL; it must never hold real books.

### 4.2 Provision

- Create a **Hetzner CX22** (2 vCPU / 4 GB RAM / 40 GB disk / 20 TB traffic, €3.79/mo),
  Nuremberg or Helsinki.
- Harden SSH: key-only auth, a non-root sudo user, `ufw` allowing only 22/80/443.
- Install Docker and clone the repo:

```bash
# on the box, as a sudo-capable user
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"          # log out and back in for this to take effect
sudo mkdir -p /opt/bookkeeping && sudo chown "$USER" /opt/bookkeeping
git clone https://github.com/<owner>/<repo>.git /opt/bookkeeping
cd /opt/bookkeeping
```

### 4.3 Configure

`.env.example` mixes all three deployment targets (local, Vercel, VPS) in one file for
reference — for the VPS, write only the VPS-relevant lines into `/opt/bookkeeping/.env`:

```bash
# /opt/bookkeeping/.env
APP_IMAGE=ghcr.io/<owner>/<repo>:latest
SITE_ADDRESS=books.example.lv
POSTGRES_USER=bookkeeping_owner
POSTGRES_PASSWORD=<generate>
POSTGRES_DB=bookkeeping

ADMIN_DATABASE_URL=postgres://bookkeeping_owner:<same password as POSTGRES_PASSWORD>@db:5432/bookkeeping
DATABASE_URL=postgres://bookkeeping_app:app_pw@db:5432/bookkeeping
WORKER_DATABASE_URL=postgres://bookkeeping_worker:worker_pw@db:5432/bookkeeping
SUPERVISOR_DATABASE_URL=postgres://bookkeeping_supervisor:supervisor_pw@db:5432/bookkeeping
```

The host is the Compose service name `db`, not `localhost`/`127.0.0.1` — Postgres publishes
no port to the host at all (`docker-compose.prod.yml`), so every connection string is
container-local. The three app-role passwords (`app_pw`/`worker_pw`/`supervisor_pw`) are the
defaults baked into `migrations/000_bootstrap.sql`, `039_jobs.sql`, and
`041_supervisor_role.sql` — they exist here only so the very first migrate/up succeeds; §4.4
overwrites all three before go-live. `GOCARDLESS_SECRET_ID`/`GOCARDLESS_SECRET_KEY`,
`ANTHROPIC_API_KEY`, and `GEMINI_API_KEY` are optional, same meaning as in §3.3.

```bash
chmod 600 .env
```

**`DEV_ROUTES_ENABLED` and `BANKFEED_ALLOW_STUB` stay unset** — leave them out of `.env`
entirely (both commented out in `.env.example`). §4.8's smoke checklist verifies this by
hitting the routes, not by reading the file back.

Root `package.json`'s `migrate`/`seed`/`provision-admin`/`worker` scripts run under
`node --env-file-if-exists=.env` (not the old `--env-file=.env`). This matters here because
none of the three CLI entrypoints run with a `/opt/bookkeeping/.env` file inside the
*container* — Compose supplies every variable via its own `environment:` block, and the
`.env` on the host is only ever read by `docker compose --env-file .env` on the host side, to
fill in `${APP_IMAGE}`/`${DATABASE_URL}`/etc. inside `docker-compose.prod.yml`. With the old
`--env-file=.env`, a missing file inside the container was a hard, fatal error
(`node: .env: not found`) before Node ever looked at a single environment variable — which
would have broken every one of these commands unconditionally, since `.env` is deliberately
excluded from the image by `.dockerignore`. With `--env-file-if-exists`, a missing file
degrades to an informational `.env not found. Continuing without it.` line and the process
proceeds using whatever the container's real environment already has — verified directly
(Tasks 4 and 5): `npm run migrate` with no `.env` present exits 0 given valid connection
strings, and fails only on an actual connection error, never on the missing file itself.

### 4.4 First deploy

```bash
docker compose -f docker-compose.prod.yml --env-file .env pull
```

If the GHCR package is private, `docker login ghcr.io -u <owner> --password-stdin` first with
a PAT that has `read:packages`.

```bash
docker compose -f docker-compose.prod.yml --env-file .env up -d db
docker compose -f docker-compose.prod.yml --env-file .env run --rm web npm run migrate
```

`npm run migrate` applies all 49 files under `migrations/` in filename order — 48 tracked
rows land in `schema_migrations`, plus `000_bootstrap.sql`, which is idempotent and re-runs
on every invocation by design (it creates the app roles if they don't already exist).

Then rotate the three app-role passwords off the migration defaults:

```bash
./scripts/rotate-db-passwords.sh
```

It prints fresh `DATABASE_URL` / `WORKER_DATABASE_URL` / `SUPERVISOR_DATABASE_URL` lines —
paste them into `.env`, replacing the `app_pw`/`worker_pw`/`supervisor_pw` placeholders from
§4.3. (The script's own defaults — `COMPOSE_FILE=/opt/bookkeeping/docker-compose.prod.yml`,
`ENV_FILE=/opt/bookkeeping/.env` — already match this layout, so no env overrides are needed
when run from `/opt/bookkeeping`.)

**To confirm a rotation actually took effect, never check it via `-h 127.0.0.1` from inside
the `db` container.** Stock Postgres ships a `pg_hba.conf` with `local all all trust` and
`host all all 127.0.0.1/32 trust` ahead of the `scram-sha-256` rule, so a loopback connection
succeeds with any password — including one that was never valid — and "confirms" a rotation
that never happened. `web` and `worker` never connect over loopback; they connect via the
`db` hostname over the Compose network, which is the path that actually hits
`scram-sha-256`. If you want to verify by hand, do it the same way they do, e.g. from a
throwaway client on the same network:
```bash
docker run --rm --network <project>_default -e PGPASSWORD=<new password> postgres:16 \
  psql -U bookkeeping_app -d bookkeeping -h db -p 5432 -c "select 1"
```
A failed old password and a working new one over this path are the only trustworthy proof.

Then bring everything up on the rotated credentials:

```bash
docker compose -f docker-compose.prod.yml --env-file .env up -d --force-recreate
```

`caddy` has `depends_on: web` with no healthcheck, so it starts before `web`'s Next.js server
is actually listening — expect a handful of transient 502s in the first few seconds after
`up`. That is normal startup behaviour, not a failed deploy; give it under a minute and retry.

### 4.5 First admin

Same script and idempotency guarantee as §3.4 — `npm run provision-admin` creates (or
re-invites) exactly one firm + `firm_admin` user and prints a single-use invite link:

```bash
docker compose -f docker-compose.prod.yml --env-file .env run --rm \
  -e PROVISION_FIRM="My Firm" -e PROVISION_EMAIL="me@myfirm.lv" \
  web npm run provision-admin
```

Open the printed `https://<your-domain>/invite/<token>` (72h TTL, single use — §3.4), set a
password, and enrol TOTP before the account activates.

### 4.6 Bank-feed sync

`npm run worker` (the `worker` service) only drains the job queue — dunning, recurring
invoices, chain reapers. It does **not** call `syncAllClients` (`src/bankfeed/cron.ts`),
which has exactly one caller: `GET /api/cron/bank-sync`, still guarded by `CRON_SECRET`
(`web/app/lib/cron-auth.ts`) exactly as it was on Vercel. Nothing schedules that route on
the VPS unless you install this timer — without it, linked bank connections silently stop
gaining new transactions (and `src/bankfeed/sync.ts`'s cursor still advances to "today" on
every attempted sync, so a long-enough gap permanently loses whatever fell outside the
provider's history window, with no error anywhere).

```bash
sudo cp deploy/bookkeeping-banksync.service deploy/bookkeeping-banksync.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bookkeeping-banksync.timer
```

The service's `EnvironmentFile=` points at `/opt/bookkeeping/.env` — the same file from
§4.3 — since `CRON_SECRET` and `SITE_ADDRESS` already live there; there's no separate
`banksync.env`. `scripts/bank-sync.sh` `curl`s
`https://$SITE_ADDRESS/api/cron/bank-sync` with `Authorization: Bearer $CRON_SECRET` and
`--fail`, so a 401 (missing/wrong secret) or 5xx makes the unit show `failed`, not
`active (exited)` — a bad config is visible in `systemctl status
bookkeeping-banksync.service` instead of silently doing nothing.

Runs daily at 01:30 (`deploy/bookkeeping-banksync.timer`), deliberately **before** the
02:30 backup (§4.7) so the day's freshly-synced transactions land in that night's dump
rather than waiting for the next one — mirroring the old Vercel ordering where bank-sync
(05:00) ran ahead of jobs-drain (06:00).

**Verify it actually works, not just that the unit is enabled** — a unit can be
`enabled`/`active` while the route still 401s on a stale or missing secret:

```bash
sudo systemctl start bookkeeping-banksync.service   # run it once, on demand
sudo systemctl status bookkeeping-banksync.service  # expect "Active: inactive (dead)" — a
                                                      #   oneshot that succeeded, not "failed"
# Or call the route directly and check the status code yourself:
curl -i -H "Authorization: Bearer $CRON_SECRET" "https://$SITE_ADDRESS/api/cron/bank-sync"
# Expect HTTP/1.1 200 and a JSON body ({"synced":N,"failed":N}) — not 401.
```

### 4.7 Backups

```bash
sudo cp deploy/bookkeeping-backup.service deploy/bookkeeping-backup.timer /etc/systemd/system/
sudo mkdir -p /backups
```

Write `/opt/bookkeeping/backup.env` (referenced by the service unit's
`EnvironmentFile=`):

```bash
# /opt/bookkeeping/backup.env
COMPOSE_FILE=/opt/bookkeeping/docker-compose.prod.yml
ENV_FILE=/opt/bookkeeping/.env
BACKUP_DIR=/backups
RESTIC_REPOSITORY=s3:https://<account-id>.r2.cloudflarestorage.com/<bucket>
RESTIC_PASSWORD=<generate — encrypts the offsite repo>
AWS_ACCESS_KEY_ID=<R2 access key>
AWS_SECRET_ACCESS_KEY=<R2 secret key>
```

**`RESTIC_REPOSITORY` is not optional — treat it as a required field, not a nice-to-have.**
`scripts/backup.sh` prunes local dumps older than 8 days regardless of whether an offsite
copy exists. If `RESTIC_REPOSITORY` is left unset (or the timer silently stops), backups look
fine locally for over a week, then quietly age out, and a single disk failure on this one box
is total, unrecoverable data loss. When it *is* unset, `backup.sh` does print
`[backup] RESTIC_REPOSITORY unset — LOCAL ONLY, no offsite copy` — but to stderr, from a
systemd oneshot unit that nobody watches interactively, which is exactly the kind of warning
that goes unread. Do not go live without a working offsite repository. Note also that this
restic/R2 configuration was not exercised by any task in this plan — Task 6 verified only the
"local only" branch (`RESTIC_REPOSITORY` unset); confirm the exact env-var names against
restic's own S3-compatible-backend documentation and prove one real offsite push-and-pull
before relying on it.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bookkeeping-backup.timer
```

Runs nightly at 02:30, up to 15 minutes late (`deploy/bookkeeping-backup.timer`,
`RandomizedDelaySec=15m` only delays a run, never moves it earlier), on the host —
deliberately not in a container, so it survives an application failure. The unit doesn't pin
a timezone, so that's 02:30 in whatever timezone the box's clock is set to — check with
`timedatectl` if it matters when the dump lands relative to daytime usage.

**Run the restore drill before the accountant logs in, then quarterly:**

```bash
BACKUP_DIR=/backups ./scripts/restore-drill.sh
```

It restores the newest dump into a throwaway `postgres:16` container and asserts
`journal_entries` has a non-zero row count — the ledger, which is the one table that proves
the backup is both restorable and populated. (`einvoices` is deliberately *not* checked: the
Peppol/VID stubs mean that table can legitimately stay empty for an extended stretch in real
operation, and asserting on it would fail every drill regardless of backup soundness.) It
honours a `READY_TIMEOUT_SECS` override (default 60s) if the throwaway container needs longer
to come up on a slower box.

The drill cannot verify one thing on its own: that the restored dump's schema is current with
`migrations/`. Do that manually, once, alongside the drill: point a throwaway
`ADMIN_DATABASE_URL` at the restored container and confirm `npm run migrate` applies nothing
(an empty `Applied: []` — anything else means the dump predates a migration that's since
landed).

### 4.8 Smoke checklist

Do this against the real, DNS-pointed domain, not `SITE_ADDRESS=localhost`. Every task in
this plan tested Caddy with `SITE_ADDRESS=localhost`, which routes to Caddy's *internal* CA
instead of Let's Encrypt — so ACME/TLS issuance against a real public hostname has never been
exercised before this exact moment. This checklist **is** that first exercise, not a
formality after the fact:

- [ ] `GET https://<host>/api/health` → `{"ok":true}` (confirms TLS issuance succeeded, DNS
      is correct, and `web` can reach `db`)
- [ ] Log in as the provisioned admin: email + password + current TOTP code
- [ ] Upload a document with no AI key configured and confirm it **fails closed** (500, not
      a fabricated extraction) — with `INTAKE_ALLOW_STUB_EXTRACTOR` unset, `/api/documents/capture`
      and `/api/expenses/upload` refuse to fall back to the canned-invoice stub in production
- [ ] Issue an invoice and confirm it posts and appears in the outbox
- [ ] `GET /api/dev/bootstrap` → **403**, with `DEV_ROUTES_ENABLED` unset. Verify by hitting
      the URL, not by reading `.env` back — this route migrates, seeds, and signs the caller
      in as `accountant@demo.lv` with a known password, so a false negative here is
      unrecoverable. (If `DEV_ROUTES_ENABLED` were ever set, the route redirects with
      **307**, not 200 — it ends in `NextResponse.redirect`. 403 is the only answer that
      belongs in production.)
- [ ] Confirm the bank-feed provider refuses to auto-link with `BANKFEED_ALLOW_STUB` unset
      and no GoCardless keys set — connecting a bank on `/bank` should fail, not silently
      link a fake account into real books
- [ ] The §3.5 Blob cache-bypass check does **not** apply here — `LocalBlobStore` has no CDN
      in front of it, so there is no cache to bypass

### 4.9 Deploy and roll back

```bash
# set APP_IMAGE in .env to the new tag first if pinning a specific sha rather than :latest
docker compose -f docker-compose.prod.yml --env-file .env pull
docker compose -f docker-compose.prod.yml --env-file .env run --rm web npm run migrate
docker compose -f docker-compose.prod.yml --env-file .env up -d
```

Rollback is the same three commands with the previous tag in `APP_IMAGE`. Migrations are
forward-only by design — the ledger is append-only, corrections are reversals — so rolling
back application code never implies rolling back the schema.

### 4.10 Known limitations

Named so they stay visible rather than forgotten, not because they block this pilot:

- **No observability** — no structured logging in `web/app`, no error tracking, no uptime
  monitor. There is no platform to page; the restore drill in §4.7 is the main safety net.
- **No disk encryption at rest** (payroll data includes `personas kods`).
- **No GDPR data export/erasure workflow.** With one pilot client an Art. 15/17 request is
  answerable by hand; document that in whatever is signed with the accountant.
- **No audit-log tamper detection** (hash chain).
- **No email delivery of any kind.** Invites and credential resets are copy-paste URLs
  (§4.5); dunning creates internal tasks, not emails; there is no self-service password
  reset — an admin re-invite resets credentials and 2FA.
- **Peppol `AccessPoint` and VID `VidClient` remain stubs.** Latvia's B2B e-invoicing mandate
  is **2028-01-01** (voluntary from 2026-03-30), so this is not a legal blocker for a B2B
  pilot on its own. Mandatory e-invoice data reporting to VID for **B2G/G2G** has been in
  force since **2026-01-01** — that blocks only clients who invoice budget institutions.
  Confirm which of the accountant's clients do before onboarding them.

---

## Handy commands

| Command (repo root) | What |
|---|---|
| `docker compose up -d db` | start local Postgres (5433) |
| `npm run migrate` | apply migrations |
| `npm run seed` | **wipe** + seed demo data (prints logins + 2FA) |
| `PROVISION_FIRM=... PROVISION_EMAIL=... npm run provision-admin` | create/re-invite one firm_admin against a **hosted** DB; prints a single-use `/invite/<token>` link (72h TTL) |
| `npm test` | full backend suite |
| `npm run typecheck` | type-check backend |
| `cd web && npm run dev` | run the cabinet UI at http://localhost:3000 |
| `cd web && npm run build` | production build of the UI |
