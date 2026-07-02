# Bookkeeping Cabinet — Web (Approval Queue)

The presentation layer over the tested backend monolith in `../src`. A Next.js
App Router app implementing the **Approval Queue** screen per the "Quiet Ledger"
design system (see `../DESIGN.md`, `../PRODUCT.md`).

Its route handlers (`app/api/**/route.ts`, all `runtime = 'nodejs'` +
`dynamic = 'force-dynamic'`) import the existing domain from `../src/**` and call
the Plan 7 API handlers directly. One Postgres, the same `DATABASE_URL` as the
backend.

## Prerequisites

- Node >= 24 (repo is developed on Node 26)
- Docker (for local Postgres), or a Postgres reachable at the `DATABASE_URL` below

## Run it end-to-end

From the **repo root**:

```bash
# 1. Start Postgres (Postgres 16 on host port 5433)
docker compose up -d db

# 2. Install + run the web app
cd web
npm install
npm run dev
```

Then, **once**, visit:

```
http://localhost:3000/api/dev/bootstrap
```

This dev-only route (guarded to non-production) will:

1. Run `runMigrations()` (idempotent).
2. Create a demo firm, an **accountant** user, and two client companies.
3. Assign the accountant to both clients.
4. Seed a chart-of-accounts (2310, 6110), open the current period, and create a
   couple of `pending_approval` posting proposals so the queue is non-empty.
5. `login()` the accountant and set an httpOnly `bk_session` cookie.
6. Redirect you to `/`.

You'll land on the **Approval Queue** at `/`, signed in, with a non-empty queue.
It is idempotent: revisiting `/api/dev/bootstrap` just re-logs-in the existing
demo user (it does not re-seed).

Demo credentials (seeded by bootstrap):

- email: `accountant@demo.lv`
- password: `demo-password-123`

## Environment

`web/.env.local` (git-ignored) must set the same DB as the backend:

```
DATABASE_URL=postgres://bookkeeping_app:app_pw@localhost:5433/bookkeeping
ADMIN_DATABASE_URL=postgres://admin:admin@localhost:5433/bookkeeping
```

- `DATABASE_URL` — the RLS-scoped application role, used by all normal reads and
  writes through `withTenant`.
- `ADMIN_DATABASE_URL` — the superuser role, used only by `runMigrations()` in the
  dev bootstrap route.

## Routes

Screen:

- `GET /` — the Approval Queue. Header (app name, client switcher, role +
  language), a vertical list of proposal cards with inline AI rationale, and
  approve/reject actions. Selected client persists in the URL (`?client=<id>`).

API (Node runtime, dynamic):

- `GET  /api/clients` — the signed-in user's assigned client companies + role.
- `GET  /api/proposals?clientCompanyId=…` — `pending_approval` proposals for a client.
- `POST /api/proposals/[id]/approve` — body `{ clientCompanyId }`.
- `POST /api/proposals/[id]/reject`  — body `{ clientCompanyId, reason }`.
- `GET  /api/dev/bootstrap` — dev-only seed + sign-in (see above).

## Build / typecheck

```bash
cd web
npm run build      # next build (webpack) — typechecks + compiles
```

`npm run build` runs `next build --webpack`. **The `--webpack` flag is
required**: Next.js 16 defaults to Turbopack, which does not implement
`experimental.extensionAlias`. That alias (in `next.config.ts`) is what lets the
backend's NodeNext `.js` import specifiers resolve to the actual `.ts` source in
`../src`. `npm run dev` carries the same flag.

## Integration notes

- `next.config.ts` sets `experimental.externalDir: true` (import files outside
  `web/`) and `resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] }` (so the
  domain's explicit `.js` extensions resolve to `.ts`).
- `tsconfig.json` maps `@domain/*` → `../src/*`; route handlers import the domain
  as e.g. `@domain/api/handlers.js`.
- The backend `src/`, `tests/`, and root config are **untouched**; `web/` is purely
  additive.
