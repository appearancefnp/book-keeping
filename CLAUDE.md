# AI Bookkeeping Platform (Latvian SME)

Cloud AI-native bookkeeping for Latvian SMEs: tested TypeScript domain backend at the
repo root (`src/`), Next.js 16 cabinet UI in `web/`. Peppol + VID integrations are
deliberately stubbed behind interfaces until real network connectivity lands.

## Commands

```bash
# Backend (repo root)
docker compose up -d db     # Postgres 16 on localhost:5433
npm run migrate             # apply SQL migrations (idempotent; runs as admin role)
npm test                    # full backend suite against the real DB
npm run typecheck           # tsc --noEmit
npm run seed                # WIPES the DB, re-seeds demo data, prints logins + TOTP 2FA code

# Web cabinet
cd web && npm run dev       # http://localhost:3000 (login: accountant@demo.lv / password123 + seeded 2FA)
cd web && npm run build     # production build
cd web && npx tsc --noEmit  # type-check web separately
```

Always run `npm test` (root) **and** `npx tsc --noEmit` in both root and `web/` before
declaring work done. Quick dev login: `GET /api/dev/bootstrap` (migrates, seeds, signs in).
Requires `DEV_ROUTES_ENABLED=1` in `web/.env.local` — the route is a positive opt-in and is
closed by default, because it is unauthenticated and signs the caller in as a demo user.

## Architecture

- `src/<module>/` — domain logic: ledger, tax (VAT), banking, einvoice (UBL/Peppol/VID),
  intake (AI/OCR), payables, payroll, reports, proposals, autonomy, collab, tenancy,
  auth/authz, assistant. Pure functions taking `(tx, ctx, ...)`.
- `web/app/api/*/route.ts` — HTTP layer over the domain (imported via `@domain/*` alias).
- `web/app/(cabinet)/*` — the UI pages; shared components in `web/app/components/`.
- `migrations/*.sql` — applied in filename order. ⚠️ Numbers collide (two 023/024/025/026
  files) — never reuse an existing number; take max+1 across ALL files.
- `tests/<module>/` mirrors `src/<module>/`.
- External integrations stay behind an interface with a stub for tests: `AccessPoint`/
  `StubAccessPoint`, `VidClient`, `DocumentExtractor`, `ChatModel`, `BlobStore`. Mirror
  this pattern for any new integration.

## Conventions (non-negotiable)

- **Ledger is append-only** (DB triggers). Corrections are reversals, never edits.
- **Money is integer cents** via `src/db/money.ts`. Never floats.
- **Tenancy/RLS**: every domain call runs inside `withTenant(ctx, ...)` — never bypass;
  every mutation calls `appendAudit(...)`.
- **Two DB roles by design**: migrations run as `admin` (`ADMIN_DATABASE_URL`); the app
  connects as non-owner `bookkeeping_app` (`DATABASE_URL`) so append-only + RLS are
  DB-enforced. Keep both env vars distinct.
- **API route pattern** (copy an existing route): `getSessionToken()` →
  `resolveTenantContext(token, clientCompanyId, nowUnix())` → domain call inside
  `withTenant`; map errors via the shared 401/403 convention.
- **i18n**: every user-facing string goes in all three catalogs (LV/RU/EN) in
  `web/app/lib/i18n.ts` — the typed `Record<keyof typeof EN, string>` fails the build if
  a language misses a key. Dates via `LOCALE_FOR[lang]`.
- **Icons**: inline stroked SVG, `currentColor`, ~1.5px — see
  `web/app/components/NavIcon.tsx`. No emoji, no icon fonts.
- **New feature order**: migration → domain (`src/`) → tests → API route → page.

## Gotchas

- `web/` runs a Next.js version with breaking changes vs training data — read
  `web/node_modules/next/dist/docs/` before writing Next.js code (see `web/CLAUDE.md`);
  dev/build use the `--webpack` flag on purpose.
- `pg` requires the Node runtime — route handlers must not run on Edge.
- 2FA is mandatory even locally; `npm run seed` prints a fresh TOTP code (30s window).
- AI extraction/assistant default to Stub mode with no key; `ANTHROPIC_API_KEY` >
  `GEMINI_API_KEY` > `OLLAMA_HOST` precedence when set.
- VAT declaration XML is a representative mock (real EDS schema pending); VID/Peppol
  sends don't leave the building yet.

## Key docs

- `HANDOFF.md` — current status, known debt, priority order (Peppol → VID → modules).
- `docs/RUNNING.md` — full setup, seeding, Vercel deploy.
- `docs/AUDIT-PLAN.md` — audit phases (architecture, quality, UX).
- `docs/ROADMAP-market-gaps.md` — feature gaps vs commercial competitors (M1–M14).
- `docs/superpowers/plans/` + `specs/` — per-feature plans and design specs.
