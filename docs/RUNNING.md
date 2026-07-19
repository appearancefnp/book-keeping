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

Alternatively, hit **`http://localhost:3000/api/dev/bootstrap`** once — a dev-only route that
migrates, seeds a minimal dataset, signs you in automatically, and redirects to `/`. Handy for
quick iteration; skip this in production.

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
| `GOCARDLESS_SECRET_ID` / `GOCARDLESS_SECRET_KEY` | GoCardless Bank Account Data API credentials; both must be set to use the real provider (`src/bankfeed/factory.ts`) — absent ⇒ falls back to the keyless stub provider |
| `CRON_SECRET` | Bearer token required by `GET /api/cron/bank-sync`; Vercel sends it automatically as the `Authorization` header for crons it triggers (`web/vercel.json`) — set it manually only when calling the route yourself (e.g. local testing) |

To exercise the real GoCardless sandbox end-to-end outside the test suite, run
`npx tsx scripts/bankfeed-sandbox.ts` (needs `GOCARDLESS_SECRET_ID`/`GOCARDLESS_SECRET_KEY` set) —
it creates a requisition against the `SANDBOXFINANCE_SFIN0000` sandbox institution and prints a
consent URL; open and approve it, then re-run the script with the printed requisition id to list
the linked sandbox account(s) and a page of transactions.

---

## 3. Deploying on Vercel (Neon + Vercel Blob)

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

`npm run migrate` is idempotent (`node --env-file=.env --import tsx src/db/migrate.ts`,
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
   | `BLOB_READ_WRITE_TOKEN` | from the Blob store (auto-set if linked) — enables `VercelBlobStore` (`src/blob/factory.ts` picks it over `LocalBlobStore` whenever this var is present) |
   | `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` | real AI extraction/assistant. Gemini's free tier is **not zero-retention** — don't feed real client documents through it until you're on a paid/zero-retention tier or have switched to `ANTHROPIC_API_KEY` (it takes precedence when both are set). Ollama is local-only; it does not run on Vercel. |
   | `GOCARDLESS_SECRET_ID` / `GOCARDLESS_SECRET_KEY` | real GoCardless Bank Account Data provider for `/bank` feeds; leave unset to keep the keyless stub provider (auto-links a fake account, fine for a demo deployment) |
   | `CRON_SECRET` | required once `web/vercel.json`'s cron is live — Vercel generates and injects it automatically for cron-triggered requests to `GET /api/cron/bank-sync`; no manual value needed unless you call the route yourself |

   Full var reference: `.env.example` (repo root) — it documents the Neon pooled/direct split and
   the Blob/Gemini notes inline; don't duplicate it here.

   The daily bank-sync cron (`web/vercel.json`, `0 5 * * *` UTC) requires no setup beyond the repo
   containing the file — Vercel registers it from the deployed project automatically.
4. Deploy. `/api/dev/bootstrap` is dead in this environment on purpose — it self-guards on
   `NODE_ENV === 'production' || process.env.VERCEL_ENV` (`web/app/api/dev/bootstrap/route.ts`),
   and Vercel always sets `VERCEL_ENV`, so it 403s on every Vercel deployment, preview or
   production.

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
- [ ] Confirm `/api/dev/bootstrap` returns 403 on the deployed URL (it should — `VERCEL_ENV` is
      always set on Vercel).

### 3.6 Backups

Neon's free tier includes point-in-time-restore (PITR) with a limited retention window — fine for
a pilot, but add a scheduled `pg_dump` (e.g. a cron hitting a small script, or a manual habit)
against `ADMIN_DATABASE_URL` **before** real client data volume grows, since free-tier PITR history
is short.

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
