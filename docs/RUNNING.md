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
(2 purchase-posting proposals + 1 bank-match + 1 VAT-declaration), plus a task and a notification.

It prints login credentials at the end:
- `accountant@demo.lv` / `owner@demo.lv`, password **`password123`**
- a **TOTP secret** + a **current 6-digit 2FA code** + an `otpauth://` URI. Add the secret to any
  authenticator app (or use the printed code within its 30s window). 2FA is mandatory.

---

## 2. Local — web cabinet (`web/`)

> The `web/` Next.js app is being built now (approval-queue screen + API routes + a dev bootstrap).
> Once it lands, this is the flow (reconcile against `web/README.md` if it differs):

```bash
docker compose up -d db              # from repo root — same Postgres
npm run seed                         # from repo root — seed the demo dataset (recommended)
cd web
npm install
cp .env.local.example .env.local 2>/dev/null || echo "DATABASE_URL=postgres://bookkeeping_app:app_pw@localhost:5433/bookkeeping" > .env.local
npm run dev                          # http://localhost:3000
```

Then either:
- **log in** at the app with `accountant@demo.lv` / `password123` + a 2FA code from `npm run seed`, or
- hit **`http://localhost:3000/api/dev/bootstrap`** once — a dev-only route that ensures migrations,
  seeds a minimal firm/accountant/client, signs you in (sets the session cookie), and redirects to `/`.

The web route handlers import the backend domain directly and talk to the **same** Postgres, so the
seeded data shows up in the cabinet immediately.

### OCR / extraction for the POC

The pipeline runs with a **StubExtractor by default — no LLM, no key needed** (the demo works as-is).
For *real* extraction, pick a free option and wire it at the capture-handler factory (details +
trade-offs in [`docs/oss-poc-options.md`](./oss-poc-options.md)):
- **Local, free, private (recommended):** `ollama serve` + `ollama pull qwen2.5vl`, use `OllamaExtractor`.
- **Hosted free tier (zero setup):** set `GEMINI_API_KEY`, use `GeminiExtractor` (not zero-retention).
- **Paid, zero-retention:** set `ANTHROPIC_API_KEY`, use `AnthropicExtractor`.

---

## 3. Deploying on Vercel

The `web/` Next.js app deploys to Vercel; the backend domain ships with it (route handlers run as
**Node.js** serverless functions — `pg` needs the Node runtime, not Edge).

1. **Managed Postgres.** Add one from the Vercel Marketplace (Neon or Supabase) or bring your own.
   You need two connection strings / roles:
   - an **admin/owner** connection to run migrations (`ADMIN_DATABASE_URL`),
   - the **runtime app role** `bookkeeping_app` (`DATABASE_URL`).
   On a managed DB, create the `bookkeeping_app` role + grants once — `migrations/000_bootstrap.sql`
   does this when migrations run as the admin/owner. If the provider won't let you create roles, you
   can point both URLs at the same role for a quick POC, but you lose the DB-enforced role separation
   (append-only + RLS still work via `FORCE ROW LEVEL SECURITY`; ownership-level protections relax).
2. **Env vars** (Vercel Project → Settings → Environment Variables): `DATABASE_URL`,
   `ADMIN_DATABASE_URL`, and — for real extraction — `GEMINI_API_KEY` or `ANTHROPIC_API_KEY`.
   (Ollama is local-only; it won't run on Vercel — use a hosted model there.)
3. **Run migrations against the hosted DB** once before/at first deploy: `npm run migrate` locally
   with `.env` pointing at the hosted `ADMIN_DATABASE_URL`, or as a one-off deploy step.
4. **Root Directory** = `web` in the Vercel project settings (the deployable app). Framework preset:
   Next.js. Build command / output are auto-detected.
5. Disable or guard the **`/api/dev/bootstrap`** route in production — it is dev-only (it self-guards
   on `NODE_ENV !== 'production'`, but confirm before shipping publicly).
6. Consider **Vercel AI Gateway** to front the LLM provider with fallbacks (optional; see oss-poc-options.md).

> Optional: front the whole thing with a `vercel.ts` config (`@vercel/config`) if you need custom
> rewrites/headers/crons later. Not required for the POC.

---

## Handy commands

| Command (repo root) | What |
|---|---|
| `docker compose up -d db` | start local Postgres (5433) |
| `npm run migrate` | apply migrations |
| `npm run seed` | **wipe** + seed demo data (prints logins + 2FA) |
| `npm test` | full backend suite |
| `npm run typecheck` | type-check backend |
| `cd web && npm run dev` | run the cabinet UI (once `web/` is built) |
| `cd web && npm run build` | production build of the UI |
