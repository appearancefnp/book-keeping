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
| `cd web && npm run dev` | run the cabinet UI at http://localhost:3000 |
| `cd web && npm run build` | production build of the UI |
