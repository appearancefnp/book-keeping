# Hetzner Pilot Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make this app safely operable on a single Hetzner CX22 for a pilot with one real accountant — close two fail-open guards, containerise it, add CI, and add backups with a tested restore.

**Architecture:** Four Docker Compose services on one box (`caddy` → `web`, plus `worker` and `db`). The image is built in GitHub Actions and pulled by the VPS, because a `next build` on 2 vCPU / 4 GB alongside a live Postgres risks OOM. `LocalBlobStore` and the long-running `npm run worker` loop both become correct on a persistent filesystem, so no storage or queue code changes. Migrations stay out-of-band as `admin`; the app keeps connecting as non-owner `bookkeeping_app`.

**Tech Stack:** Node 24, Next.js 16.2.10 (webpack, not Turbopack), Postgres 16, Docker Compose, Caddy 2, GitHub Actions, restic, vitest.

Spec: `docs/superpowers/specs/2026-07-31-hetzner-pilot-deployment-design.md`

## Global Constraints

- **Node 24.** Root `package.json` declares `engines: {"node": ">=24"}`. Every image and CI job pins Node 24. The dev machine currently runs Node 22 — do not "fix" the engines field to match it.
- **Next.js builds with webpack, deliberately.** `web/package.json` uses `next build --webpack` and `next dev --webpack`. Never remove the flag.
- **`web/AGENTS.md` applies:** this Next.js version has breaking changes vs. training data. Read `web/node_modules/next/dist/docs/` before writing any Next.js config or API code.
- **Two DB roles by design.** `ADMIN_DATABASE_URL` (owner) runs migrations only; `DATABASE_URL` connects as non-owner `bookkeeping_app` so append-only triggers and RLS are DB-enforced. Never collapse them.
- **Money is integer cents** via `src/db/money.ts`. Never floats. (No task here touches money, but do not introduce any.)
- **Ledger is append-only** (DB triggers). Corrections are reversals, never edits.
- **Never reuse a migration number.** Take max+1 across ALL files in `migrations/` — numbers already collide (two each of 023/024/025/026). `tests/db/migration-numbering.test.ts` enforces this; the four historical pairs are grandfathered.
- **Run `npm test` (root) and `npx tsc --noEmit` in BOTH root and `web/`** before declaring any task done.
- **Never run two vitest suites concurrently.** `tests/helpers/db.ts:11` does `DROP SCHEMA public CASCADE`, so a second suite destroys the first. `vitest.config.ts` already sets `pool: 'forks'`, `singleFork: true`, `fileParallelism: false`. If tests fail with `relation "schema_migrations" does not exist` or `tuple concurrently updated`, check for another process on `localhost:5433` with:
  `docker exec book-keeping-db-1 psql -U admin -d bookkeeping -c "select pid, usename, state, left(query,60) from pg_stat_activity where datname='bookkeeping' and pid<>pg_backend_pid();"`
- **Pure-predicate pattern for env decisions.** Follow `src/blob/config-status.ts`: the decision is a pure function over a narrow env-shaped object, unit-tested without touching `process.env`. Callers destructure the vars they need rather than passing `process.env` wholesale — passing it whole trips TS2559 under `web/`'s tsconfig, where Next.js augments `NodeJS.ProcessEnv` (see the comment in `src/blob/factory.ts:5-9`).
- **Local Postgres for tests** is `docker compose up -d db` → `localhost:5433`, user `admin`, password `admin`, database `bookkeeping`.

---

## File Structure

**New files:**

| Path | Responsibility |
|---|---|
| `src/bankfeed/stub-allowed.ts` | Pure predicate: may the auto-linking stub bank feed serve this environment? |
| `tests/bankfeed/stub-allowed.test.ts` | Unit tests for that predicate |
| `Dockerfile` | Multi-stage build producing one image that runs `next start`, `npm run worker`, and `npm run migrate` |
| `.dockerignore` | Keeps `node_modules`, `.next`, secrets, and dev artifacts out of the build context |
| `docker-compose.prod.yml` | The four production services |
| `deploy/Caddyfile` | TLS termination + reverse proxy to `web:3000` |
| `deploy/bookkeeping-backup.service` | systemd unit invoking the backup script |
| `deploy/bookkeeping-backup.timer` | Daily timer for the above |
| `scripts/backup.sh` | `pg_dump -Fc` + blob tarball → local `/backups`, then restic to offsite |
| `scripts/restore-drill.sh` | Restores the newest dump into a throwaway container and asserts it is usable |
| `scripts/rotate-db-passwords.sh` | Rotates the three non-owner role passwords off their in-git defaults |
| `.github/workflows/ci.yml` | `test` job (suite + typechecks + build) and `image` job (build + push to GHCR) |

**Modified files:**

| Path | Change |
|---|---|
| `src/bankfeed/factory.ts:14-21` | Throw instead of silently returning the auto-linking stub in production |
| `tests/bankfeed/factory.test.ts` | Add production cases; manage `NODE_ENV` / `BANKFEED_ALLOW_STUB` in setup |
| `src/dev/guard.ts:2-4` | Require a positive `DEV_ROUTES_ENABLED=1` opt-in |
| `tests/dev/guard.test.ts` | Cover the new predicate |
| `web/next.config.ts` | Add `outputFileTracingRoot` |
| `.env.example` | VPS section; label the existing Vercel guidance as such |
| `docs/RUNNING.md` | New §4 for the VPS path; relabel §3 as the Vercel option |
| `CLAUDE.md` | Dev-login line must mention the new opt-in env var |
| `HANDOFF.md` | Status entry for this work |

Tasks 1 and 2 are the P0 behaviour changes and are independent of each other and of everything else. Tasks 3–4 build the runtime. Task 5 is CI. Tasks 6–7 are operations. Task 8 is documentation, last because it describes what the earlier tasks actually built.

---

### Task 1: Fail closed on the auto-linking stub bank feed (P0)

`src/bankfeed/factory.ts:18` currently reads
`id && key ? new GoCardlessProvider(id, key) : new StubBankFeedProvider({ autoLink: true })`.
With GoCardless credentials absent — the default — the stub auto-links a fake account and can inject demo transactions into real client books. On a real-data pilot that is a silent data-integrity failure, so the stub must require an explicit opt-in in production.

**Files:**
- Create: `src/bankfeed/stub-allowed.ts`
- Create: `tests/bankfeed/stub-allowed.test.ts`
- Modify: `src/bankfeed/factory.ts:14-21`
- Modify: `tests/bankfeed/factory.test.ts`

**Interfaces:**
- Consumes: `BankFeedProvider` (`src/bankfeed/provider.ts`), `GoCardlessProvider` (`src/bankfeed/gocardless.ts`), `StubBankFeedProvider` (`src/bankfeed/stub.ts`) — all already imported by the factory.
- Produces: `bankFeedStubAllowed(env: { NODE_ENV?: string; BANKFEED_ALLOW_STUB?: string }): boolean`. `makeBankFeedProvider(): BankFeedProvider` keeps its signature but now throws.

- [ ] **Step 1: Write the failing predicate test**

Create `tests/bankfeed/stub-allowed.test.ts`:

```ts
import { expect, test } from 'vitest';
import { bankFeedStubAllowed } from '../../src/bankfeed/stub-allowed.js';

test('stub allowed outside production, and inside only with an explicit opt-in', () => {
  expect(bankFeedStubAllowed({})).toBe(true);
  expect(bankFeedStubAllowed({ NODE_ENV: 'development' })).toBe(true);
  expect(bankFeedStubAllowed({ NODE_ENV: 'test' })).toBe(true);
  expect(bankFeedStubAllowed({ NODE_ENV: 'production' })).toBe(false);
  expect(bankFeedStubAllowed({ NODE_ENV: 'production', BANKFEED_ALLOW_STUB: '1' })).toBe(true);
});

test('only the exact string "1" opts in — no truthy-string surprises', () => {
  expect(bankFeedStubAllowed({ NODE_ENV: 'production', BANKFEED_ALLOW_STUB: 'true' })).toBe(false);
  expect(bankFeedStubAllowed({ NODE_ENV: 'production', BANKFEED_ALLOW_STUB: 'yes' })).toBe(false);
  expect(bankFeedStubAllowed({ NODE_ENV: 'production', BANKFEED_ALLOW_STUB: '0' })).toBe(false);
  expect(bankFeedStubAllowed({ NODE_ENV: 'production', BANKFEED_ALLOW_STUB: '' })).toBe(false);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/bankfeed/stub-allowed.test.ts`
Expected: FAIL — cannot resolve `../../src/bankfeed/stub-allowed.js`.

- [ ] **Step 3: Write the predicate**

Create `src/bankfeed/stub-allowed.ts`:

```ts
/**
 * The auto-linking stub bank feed must never serve a production deployment: it links a
 * fake account and can inject demo transactions into real books. Opting in is positive
 * and explicit — a merely-truthy value is not enough — so that a misconfigured
 * environment fails closed rather than quietly booting the stub.
 */
export function bankFeedStubAllowed(
  env: { NODE_ENV?: string; BANKFEED_ALLOW_STUB?: string },
): boolean {
  if (env.NODE_ENV !== 'production') return true;
  return env.BANKFEED_ALLOW_STUB === '1';
}
```

- [ ] **Step 4: Run it to make sure it passes**

Run: `npx vitest run tests/bankfeed/stub-allowed.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Write the failing factory tests**

Replace the setup block and append two tests in `tests/bankfeed/factory.test.ts`. The existing `beforeEach`/`afterEach` save and restore the two GoCardless vars; they must now also cover `NODE_ENV` and `BANKFEED_ALLOW_STUB`, because a leaked `NODE_ENV=production` would break every later test file in the run. The file becomes:

```ts
import { afterEach, beforeEach, expect, test } from 'vitest';
import { makeBankFeedProvider } from '../../src/bankfeed/factory.js';
import { StubBankFeedProvider } from '../../src/bankfeed/stub.js';

const SAVED = {
  GOCARDLESS_SECRET_ID: process.env.GOCARDLESS_SECRET_ID,
  GOCARDLESS_SECRET_KEY: process.env.GOCARDLESS_SECRET_KEY,
  NODE_ENV: process.env.NODE_ENV,
  BANKFEED_ALLOW_STUB: process.env.BANKFEED_ALLOW_STUB,
};

beforeEach(() => {
  delete (globalThis as any).__bankFeedProvider;
  for (const key of Object.keys(SAVED)) delete process.env[key];
});

afterEach(() => {
  delete (globalThis as any).__bankFeedProvider;
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('returns a StubBankFeedProvider without GoCardless credentials', () => {
  expect(makeBankFeedProvider()).toBeInstanceOf(StubBankFeedProvider);
});

test('repeated calls return the same instance', () => {
  const first = makeBankFeedProvider();
  const second = makeBankFeedProvider();
  expect(second).toBe(first);
});

test('the singleton is stashed on globalThis under __bankFeedProvider', () => {
  const instance = makeBankFeedProvider();
  expect((globalThis as any).__bankFeedProvider).toBe(instance);
});

test('throws in production when GoCardless credentials are missing', () => {
  process.env.NODE_ENV = 'production';
  expect(() => makeBankFeedProvider()).toThrow(/GOCARDLESS_SECRET_ID/);
});

test('caches nothing when it throws, so a later fixed env still works', () => {
  process.env.NODE_ENV = 'production';
  expect(() => makeBankFeedProvider()).toThrow();
  expect((globalThis as any).__bankFeedProvider).toBeUndefined();
  process.env.BANKFEED_ALLOW_STUB = '1';
  expect(makeBankFeedProvider()).toBeInstanceOf(StubBankFeedProvider);
});
```

- [ ] **Step 6: Run them to make sure the two new ones fail**

Run: `npx vitest run tests/bankfeed/factory.test.ts`
Expected: 3 PASS, 2 FAIL — the production cases return a `StubBankFeedProvider` instead of throwing.

- [ ] **Step 7: Make the factory fail closed**

Replace `makeBankFeedProvider` in `src/bankfeed/factory.ts`. Add the import, and note the destructuring: this module is imported from `web/` route handlers, so passing `process.env` wholesale would trip TS2559 (see `src/blob/factory.ts:5-9`).

```ts
import { bankFeedStubAllowed } from './stub-allowed.js';
```

```ts
/**
 * GoCardless when credentials are present. Otherwise the auto-linking stub — but only
 * where that is safe: in production it would inject demo transactions into real books,
 * so it requires BANKFEED_ALLOW_STUB=1. Tests construct StubBankFeedProvider directly.
 */
export function makeBankFeedProvider(): BankFeedProvider {
  if (!g.__bankFeedProvider) {
    const id = process.env.GOCARDLESS_SECRET_ID;
    const key = process.env.GOCARDLESS_SECRET_KEY;
    if (id && key) {
      g.__bankFeedProvider = new GoCardlessProvider(id, key);
    } else {
      const { NODE_ENV, BANKFEED_ALLOW_STUB } = process.env;
      if (!bankFeedStubAllowed({ NODE_ENV, BANKFEED_ALLOW_STUB })) {
        throw new Error(
          'bank feed: GOCARDLESS_SECRET_ID and GOCARDLESS_SECRET_KEY are required in ' +
          'production. The auto-linking stub would inject demo transactions into real ' +
          'books. Set BANKFEED_ALLOW_STUB=1 only for a deployment with seeded data.',
        );
      }
      g.__bankFeedProvider = new StubBankFeedProvider({ autoLink: true });
    }
  }
  return g.__bankFeedProvider;
}
```

- [ ] **Step 8: Run the factory tests to verify they pass**

Run: `npx vitest run tests/bankfeed/factory.test.ts tests/bankfeed/stub-allowed.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 9: Full gates**

Run, in order and never concurrently:
```bash
npm test
npx tsc --noEmit
cd web && npx tsc --noEmit && cd ..
```
Expected: suite green, both typechecks report no errors. If the suite reports `relation "schema_migrations" does not exist`, another process is on the test DB — see Global Constraints.

- [ ] **Step 10: Commit**

```bash
git add src/bankfeed/stub-allowed.ts src/bankfeed/factory.ts tests/bankfeed/stub-allowed.test.ts tests/bankfeed/factory.test.ts
git commit -m "fix(bankfeed): refuse the auto-linking stub provider in production

Without GoCardless credentials the factory silently returned
StubBankFeedProvider({ autoLink: true }), which links a fake account and can
inject demo transactions into real client books. Production now requires real
credentials, or an explicit BANKFEED_ALLOW_STUB=1 for seeded demo deployments."
```

---

### Task 2: Require a positive opt-in for the dev bootstrap route (P0)

`devBootstrapAllowed` (`src/dev/guard.ts:3`) is `NODE_ENV !== 'production' && !VERCEL_ENV`. On Vercel the `VERCEL_ENV` half always held, so `/api/dev/bootstrap` was dead there regardless of `NODE_ENV` — meaning nothing has ever depended on the `NODE_ENV` half being right. On a VPS `VERCEL_ENV` is absent and that is the only remaining guard. If it is wrong, an **unauthenticated** `GET /api/dev/bootstrap` runs `runMigrations()`, seeds demo data, and signs the caller in as `accountant@demo.lv` / `password123` (`web/app/api/dev/bootstrap/route.ts:21-29`) against real books.

**Files:**
- Modify: `src/dev/guard.ts`
- Modify: `tests/dev/guard.test.ts`
- Modify: `CLAUDE.md` (the dev-login line)
- Local only, not committed: `web/.env.local`

**Interfaces:**
- Consumes: nothing.
- Produces: `devBootstrapAllowed(env: { NODE_ENV?: string; VERCEL_ENV?: string; DEV_ROUTES_ENABLED?: string }): boolean`. The only caller is `web/app/api/dev/bootstrap/route.ts:25`, which passes `process.env` wholesale; that keeps compiling because the param type still includes `NODE_ENV`, which `NodeJS.ProcessEnv` has. Do not change the call site.

- [ ] **Step 1: Write the failing test**

Replace the body of `tests/dev/guard.test.ts`:

```ts
import { expect, test } from 'vitest';
import { devBootstrapAllowed } from '../../src/dev/guard.js';

test('the opt-in is required, not merely permitted', () => {
  expect(devBootstrapAllowed({})).toBe(false);
  expect(devBootstrapAllowed({ NODE_ENV: 'development' })).toBe(false);
  expect(devBootstrapAllowed({ DEV_ROUTES_ENABLED: '1' })).toBe(true);
  expect(devBootstrapAllowed({ NODE_ENV: 'development', DEV_ROUTES_ENABLED: '1' })).toBe(true);
});

test('only the exact string "1" opts in', () => {
  expect(devBootstrapAllowed({ DEV_ROUTES_ENABLED: 'true' })).toBe(false);
  expect(devBootstrapAllowed({ DEV_ROUTES_ENABLED: '' })).toBe(false);
  expect(devBootstrapAllowed({ DEV_ROUTES_ENABLED: '0' })).toBe(false);
});

test('production and Vercel still veto, even with the opt-in set', () => {
  expect(devBootstrapAllowed({ NODE_ENV: 'production', DEV_ROUTES_ENABLED: '1' })).toBe(false);
  expect(devBootstrapAllowed({ VERCEL_ENV: 'preview', DEV_ROUTES_ENABLED: '1' })).toBe(false);
  expect(devBootstrapAllowed({ NODE_ENV: 'test', VERCEL_ENV: 'production', DEV_ROUTES_ENABLED: '1' })).toBe(false);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/dev/guard.test.ts`
Expected: FAIL — `devBootstrapAllowed({})` returns `true`, expected `false`.

- [ ] **Step 3: Invert the guard**

Replace `src/dev/guard.ts` entirely:

```ts
/**
 * Dev bootstrap (migrate + seed + sign-in) must never run against real data. The route
 * is unauthenticated and signs the caller in as a known demo user, so the guard is a
 * positive opt-in: DEV_ROUTES_ENABLED=1 is required, and production or any Vercel
 * environment still vetoes. Off Vercel, NODE_ENV was previously the only signal — a
 * container missing NODE_ENV=production would have opened the route on real books.
 */
export function devBootstrapAllowed(
  env: { NODE_ENV?: string; VERCEL_ENV?: string; DEV_ROUTES_ENABLED?: string },
): boolean {
  if (env.DEV_ROUTES_ENABLED !== '1') return false;
  return env.NODE_ENV !== 'production' && !env.VERCEL_ENV;
}
```

- [ ] **Step 4: Run it to make sure it passes**

Run: `npx vitest run tests/dev/guard.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Restore the local dev flow**

`GET /api/dev/bootstrap` is the documented quick dev login and it is now closed by default. Append to `web/.env.local` (gitignored — a local-machine change, not a commit):

```
DEV_ROUTES_ENABLED=1
```

- [ ] **Step 6: Verify the dev route still works locally, and is closed without the flag**

```bash
docker compose up -d db
cd web && npm run dev
```
In another shell:
```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/dev/bootstrap
```
Expected: `200`. Then comment the line out of `web/.env.local`, restart `npm run dev`, and repeat: expected `403`. Restore the line and stop the dev server.

- [ ] **Step 7: Update the CLAUDE.md dev-login line**

In `CLAUDE.md`, the Commands section currently ends with: `Quick dev login: `GET /api/dev/bootstrap` (dev-only; migrates, seeds, signs in).` Replace with:

```markdown
Quick dev login: `GET /api/dev/bootstrap` (migrates, seeds, signs in). Requires
`DEV_ROUTES_ENABLED=1` in `web/.env.local` — the route is a positive opt-in and is
closed by default, because it is unauthenticated and signs the caller in as a demo user.
```

- [ ] **Step 8: Full gates**

```bash
npm test
npx tsc --noEmit
cd web && npx tsc --noEmit && cd ..
```
Expected: suite green, both typechecks clean.

- [ ] **Step 9: Commit**

```bash
git add src/dev/guard.ts tests/dev/guard.test.ts CLAUDE.md
git commit -m "fix(dev): make the bootstrap route a positive opt-in

devBootstrapAllowed was NODE_ENV !== 'production' && !VERCEL_ENV. On Vercel the
VERCEL_ENV half always held, so nothing depended on NODE_ENV being right; off
Vercel it is the only guard, and an unauthenticated GET would migrate, seed, and
sign the caller in as accountant@demo.lv against real books. DEV_ROUTES_ENABLED=1
is now required."
```

---

### Task 3: Dockerfile producing one image for web, worker, and migrations

One image runs all three entrypoints, which keeps `tsx` (a root devDependency) available to `npm run migrate` and `npm run provision-admin`. Deliberately **not** `output: 'standalone'`: `web/next.config.ts` sets `experimental.externalDir` to import the domain from `../src` and the repo has two lockfiles, which is exactly where output-file tracing silently omits `src/` — a runtime failure, not a build failure. `outputFileTracingRoot` is set anyway to resolve the workspace-root ambiguity the build currently warns about.

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Modify: `web/next.config.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a local image tag `bookkeeping:test`. Its default command serves HTTP on container port 3000. `docker run … <image> npm run migrate` and `docker run … <image> npm run worker` both work. Task 4 depends on all three.

- [ ] **Step 1: Add `outputFileTracingRoot`**

The installed docs (`web/node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/output.md:69-78`) show `outputFileTracingRoot: path.join(__dirname, '../../')` in a CJS `next.config.js`. Ours is `next.config.ts`. Add to `web/next.config.ts` — the import goes at the top, the key inside `nextConfig` alongside `experimental`:

```ts
import path from 'node:path';
```

```ts
  // The domain lives at ../src via experimental.externalDir, and the repo has two
  // lockfiles, so Next cannot infer the workspace root. Say it explicitly.
  outputFileTracingRoot: path.join(__dirname, '..'),
```

- [ ] **Step 2: Verify the build accepts it and the warning is gone**

Run: `cd web && npm run build 2>&1 | tail -20`

Expected: build succeeds **and** the `⚠ Warning: Next.js inferred your workspace root` / `We detected multiple lockfiles` lines no longer appear.

If instead it fails with `__dirname is not defined`, this config is being loaded as ESM. Replace the value with `path.dirname(fileURLToPath(import.meta.url)) + '/..'` using `import { fileURLToPath } from 'node:url';`, and re-run this step. Do not proceed until the build is clean and the warning is gone.

- [ ] **Step 3: Write `.dockerignore`**

Create `.dockerignore`. `migrations/` must NOT be listed — `npm run migrate` reads it at runtime.

```
.git
.gitignore
node_modules
web/node_modules
web/.next
web/.blob-store
.blob-store
.env
.env.local
web/.env.local
docs
tests
graphify-out
.superpowers
.playwright-mcp
*.png
*.log
web/tsconfig.tsbuildinfo
```

- [ ] **Step 4: Write the Dockerfile**

Create `Dockerfile`. `NODE_ENV` is deliberately unset in the dependency stages so `npm ci` installs devDependencies (`tsx` is needed at runtime by the migrate and worker entrypoints); it is set to `production` only in the runtime stage.

```dockerfile
# syntax=docker/dockerfile:1

# --- deps: root and web dependency trees, including devDeps (tsx) ---
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci

# --- build: compile the Next.js app ---
FROM node:24-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/web/node_modules ./web/node_modules
COPY . .
RUN npm --prefix web run build

# --- runtime: one image, three entrypoints ---
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app ./
EXPOSE 3000
# Overridden by compose for the worker, and by `docker run … npm run migrate`.
CMD ["npm", "--prefix", "web", "run", "start"]
```

- [ ] **Step 5: Build the image**

Run: `docker build -t bookkeeping:test .`
Expected: succeeds. Note the reported image size; ~1 GB is expected and acceptable per the design.

- [ ] **Step 6: Verify all three entrypoints are viable in the image**

```bash
docker run --rm bookkeeping:test node --version
docker run --rm bookkeeping:test sh -c 'ls migrations | wc -l'
docker run --rm bookkeeping:test node --import tsx -e "console.log('tsx ok')"
docker run --rm bookkeeping:test sh -c 'test -d web/.next && echo build-present'
```
Expected: `v24.*`; `50`; `tsx ok`; `build-present`. The third proves migrations and the worker can run; the fourth proves the Next build was carried into the runtime stage.

- [ ] **Step 7: Verify it serves HTTP**

```bash
docker run --rm -d --name bk-smoke -p 3001:3000 -e DATABASE_URL=postgres://nobody@127.0.0.1:1/none bookkeeping:test
sleep 5
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3001/login
docker logs bk-smoke | tail -20
docker rm -f bk-smoke
```
Expected: `200` for `/login` — it is the one static page and needs no database. A non-200 means the server did not start; read the logs before continuing.

- [ ] **Step 8: Typecheck gate**

Step 1 edited `web/next.config.ts`, which is TypeScript, so the Global Constraints gate applies:

```bash
cd web && npx tsc --noEmit && cd ..
npx tsc --noEmit
```
Expected: both report no errors. `npm test` is not required here — no file under `src/` or `tests/` changed.

- [ ] **Step 9: Commit**

```bash
git add Dockerfile .dockerignore web/next.config.ts
git commit -m "build: containerise the app as one image for web, worker, and migrations

Multi-stage build on Node 24. Deliberately not output:'standalone' — externalDir
plus two lockfiles is precisely where output-file tracing drops ../src silently,
so the repo ships whole and next start runs it. outputFileTracingRoot is set to
resolve the workspace-root ambiguity the build was warning about."
```

---

### Task 4: Production Compose stack with Caddy

**Files:**
- Create: `docker-compose.prod.yml`
- Create: `deploy/Caddyfile`
- Modify: `package.json` (the four `--env-file=.env` scripts — see Step 0)

**Interfaces:**
- Consumes: the image from Task 3 (built locally as `bookkeeping:test`, published by Task 5 as `ghcr.io/<owner>/bookkeeping:<sha>`).
- Produces: a `docker compose -f docker-compose.prod.yml` stack with services named `db`, `web`, `worker`, `caddy`, a named volume `pgdata`, and a named volume `blobdata` mounted at `/app/.blob-store` in `web`. Task 6's backup script depends on those exact service and volume names.

- [ ] **Step 0: Stop requiring an on-disk `.env` (carried forward from Task 3)**

Task 3's implementer and reviewer both reproduced this: root `package.json`'s `migrate`, `worker`, `provision-admin`, and `seed` scripts all run `node --env-file=.env …`, and Node treats a **missing** `.env` as fatal — `docker run … npm run migrate` dies with `node: .env: not found` before it ever reads `DATABASE_URL`. `.dockerignore` correctly excludes `.env`, so the image has none. Compose's `environment:` sets process variables but does **not** put a file at `/app/.env`, so the stack would fail on its first migrate.

Fix it at the source rather than shipping a secrets file into the image or bind-mounting one. Node 24 supports `--env-file-if-exists`, which loads the file when present and is a no-op when absent. In root `package.json`, change all four scripts from `--env-file=.env` to `--env-file-if-exists=.env`:

```json
    "migrate": "node --env-file-if-exists=.env --import tsx src/db/migrate.ts",
    "seed": "node --env-file-if-exists=.env --import tsx src/dev/seed.ts",
    "provision-admin": "node --env-file-if-exists=.env --import tsx src/dev/provision-admin.ts",
    "worker": "node --env-file-if-exists=.env --import tsx src/jobs/worker.ts"
```

Local development is unaffected — `.env` still exists and is still loaded. This also unblocks Task 5, where CI has no `.env` at all.

Verify both directions before moving on:

```bash
npm run migrate                        # still works locally, .env present
mv .env .env.bak && npm run migrate ; echo "exit=$?" ; mv .env.bak .env
```

Expected: the first succeeds. The second must fail on a *connection* error (no `DATABASE_URL` set), **not** on `node: .env: not found` — that distinction is the whole point. Restore `.env` either way; it holds this worktree's private-DB credentials on port 5434.

- [ ] **Step 1: Write the Caddyfile**

Create `deploy/Caddyfile`. Caddy must not add security headers — `web/next.config.ts` already sends HSTS, `X-Content-Type-Options`, `X-Frame-Options: DENY`, and `Referrer-Policy` on every response, and duplicating them produces two header values.

```
{$SITE_ADDRESS} {
	encode zstd gzip
	reverse_proxy web:3000
}
```

- [ ] **Step 2: Write the Compose file**

Create `docker-compose.prod.yml`. `db` publishes no ports: it is reachable only on the Compose network, which is why the role passwords need no TLS. `BLOB_DIR` matches `src/blob/factory.ts:19`'s `process.env.BLOB_DIR ?? '.blob-store'`; `BLOB_READ_WRITE_TOKEN` is deliberately unset so `makeBlobStore()` selects `LocalBlobStore`.

```yaml
services:
  db:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
      interval: 5s
      timeout: 5s
      retries: 20

  web:
    image: ${APP_IMAGE}
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    environment:
      NODE_ENV: production
      DATABASE_URL: ${DATABASE_URL}
      ADMIN_DATABASE_URL: ${ADMIN_DATABASE_URL}
      WORKER_DATABASE_URL: ${WORKER_DATABASE_URL}
      SUPERVISOR_DATABASE_URL: ${SUPERVISOR_DATABASE_URL}
      BLOB_DIR: /app/.blob-store
      GOCARDLESS_SECRET_ID: ${GOCARDLESS_SECRET_ID:-}
      GOCARDLESS_SECRET_KEY: ${GOCARDLESS_SECRET_KEY:-}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
      GEMINI_API_KEY: ${GEMINI_API_KEY:-}
    volumes:
      - blobdata:/app/.blob-store

  worker:
    image: ${APP_IMAGE}
    restart: unless-stopped
    command: ["npm", "run", "worker"]
    depends_on:
      db:
        condition: service_healthy
    environment:
      NODE_ENV: production
      DATABASE_URL: ${DATABASE_URL}
      WORKER_DATABASE_URL: ${WORKER_DATABASE_URL}
      SUPERVISOR_DATABASE_URL: ${SUPERVISOR_DATABASE_URL}
      BLOB_DIR: /app/.blob-store
    volumes:
      - blobdata:/app/.blob-store

  caddy:
    image: caddy:2
    restart: unless-stopped
    depends_on:
      - web
    environment:
      SITE_ADDRESS: ${SITE_ADDRESS}
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./deploy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddydata:/data
      - caddyconfig:/config

volumes:
  pgdata:
  blobdata:
  caddydata:
  caddyconfig:
```

Note: the `worker` service runs `npm run worker`, and there is no `.env` in the image. Step 0 already resolved that — `--env-file-if-exists` makes the missing file a no-op, so every value above arrives purely through the container environment. No `.env` is bind-mounted and no empty placeholder file is created.

- [ ] **Step 3: Validate the Compose file parses**

```bash
cd /home/karlis/git/book-keeping
SITE_ADDRESS=localhost APP_IMAGE=bookkeeping:test \
POSTGRES_USER=admin POSTGRES_PASSWORD=admin POSTGRES_DB=bookkeeping \
DATABASE_URL=postgres://bookkeeping_app:app_pw@db:5432/bookkeeping \
ADMIN_DATABASE_URL=postgres://admin:admin@db:5432/bookkeeping \
WORKER_DATABASE_URL=postgres://bookkeeping_worker:worker_pw@db:5432/bookkeeping \
SUPERVISOR_DATABASE_URL=postgres://bookkeeping_supervisor:supervisor_pw@db:5432/bookkeeping \
docker compose -f docker-compose.prod.yml config >/dev/null && echo compose-ok
```
Expected: `compose-ok`.

- [ ] **Step 4: Bring the stack up locally and prove it end to end**

Write those same variables into a local `.env.prod.local` (add that filename to `.gitignore` in this step), set `SITE_ADDRESS=localhost`, then:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod.local up -d db
docker compose -f docker-compose.prod.yml --env-file .env.prod.local run --rm web npm run migrate
docker compose -f docker-compose.prod.yml --env-file .env.prod.local up -d
sleep 10
docker compose -f docker-compose.prod.yml --env-file .env.prod.local ps
curl -sk https://localhost/api/health
docker compose -f docker-compose.prod.yml --env-file .env.prod.local logs worker | tail -20
```

Expected: `migrate` prints `Applied: [ … ]` with all 50 files; all four services `running`; health returns `{"ok":true,"blob":"ok"}`; worker logs show `[worker] started`. Caddy on `localhost` issues an internal self-signed certificate, hence `curl -k`.

If the worker exits complaining about `--env-file`, apply the `RUN touch .env` fix from Step 2, rebuild, and repeat.

- [ ] **Step 5: Verify the bank-feed guard fires in the running container**

This is Task 1's fix observed in situ, with `NODE_ENV=production` and no GoCardless credentials:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod.local exec web \
  node --import tsx -e "import('/app/src/bankfeed/factory.js').then(m => { try { m.makeBankFeedProvider(); console.log('UNEXPECTED: stub was allowed'); } catch (e) { console.log('OK:', e.message.slice(0, 60)); } })"
```
Expected: `OK: bank feed: GOCARDLESS_SECRET_ID and GOCARDLESS_SECRET_KEY are…`

- [ ] **Step 6: Verify the dev route is closed in the running container**

```bash
curl -sk -o /dev/null -w '%{http_code}\n' https://localhost/api/dev/bootstrap
```
Expected: `403`. This is Task 2's fix, and it is the single most important check in the stack — a `200` here means an unauthenticated caller can seed the database.

- [ ] **Step 7: Tear down**

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod.local down
```
Leave the volumes in place; Task 6 uses this stack again.

- [ ] **Step 8: Commit**

```bash
git add docker-compose.prod.yml deploy/Caddyfile package.json .gitignore
git commit -m "build: production compose stack with Caddy

Four services on one Compose network: caddy holds the only public ports, db
publishes none. LocalBlobStore is selected by leaving BLOB_READ_WRITE_TOKEN
unset, backed by a named volume, and the worker runs as a real long-lived loop
rather than a once-daily cron. Caddy adds no security headers — next.config.ts
already sends them and duplicates would ship two values."
```

---

### Task 5: GitHub Actions CI

Two jobs. `test` is the thing that makes the 693-test suite authoritative for the first time — it gets a dedicated Postgres, so the shared-DB contention that makes local runs unreliable cannot happen.

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the `Dockerfile` from Task 3.
- Produces: `ghcr.io/${{ github.repository }}:${{ github.sha }}` and `:latest` on pushes to `main`. Task 8's runbook references those tags.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/ci.yml`. The migrate step is redundant with `resetDb()` but fails fast with a readable error when a migration is broken, instead of surfacing as 100+ opaque test failures. Everything in `test` is one serial job on purpose — see Global Constraints.

```yaml
name: CI

on:
  push:
    branches: ['**']
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      db:
        image: postgres:16
        env:
          POSTGRES_USER: admin
          POSTGRES_PASSWORD: admin
          POSTGRES_DB: bookkeeping
        ports: ['5433:5432']
        options: >-
          --health-cmd "pg_isready -U admin -d bookkeeping"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 20
    env:
      ADMIN_DATABASE_URL: postgres://admin:admin@localhost:5433/bookkeeping
      DATABASE_URL: postgres://bookkeeping_app:app_pw@localhost:5433/bookkeeping
      WORKER_DATABASE_URL: postgres://bookkeeping_worker:worker_pw@localhost:5433/bookkeeping
      SUPERVISOR_DATABASE_URL: postgres://bookkeeping_supervisor:supervisor_pw@localhost:5433/bookkeeping
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
          cache-dependency-path: |
            package-lock.json
            web/package-lock.json
      - run: npm ci
      - run: npm --prefix web ci
      - name: Apply migrations (fail fast on a broken migration)
        run: npm run migrate
      - name: Domain test suite
        run: npm test
      - name: Typecheck root
        run: npx tsc --noEmit
      - name: Typecheck web
        run: npm --prefix web exec tsc -- --noEmit
      - name: Build web
        run: npm --prefix web run build

  image:
    needs: test
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: |
            ghcr.io/${{ github.repository }}:${{ github.sha }}
            ghcr.io/${{ github.repository }}:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

Note `npm run migrate` and `npm run seed` use `node --env-file=.env`, and CI has no `.env`. Step 2 establishes whether that is fatal.

- [ ] **Step 2: Reproduce the CI sequence locally, without a `.env` file**

The workflow's correctness hinges on `--env-file=.env` tolerating a missing file, so prove it before pushing:

```bash
cd /home/karlis/git/book-keeping
docker compose up -d db
mv .env .env.bak
ADMIN_DATABASE_URL=postgres://admin:admin@localhost:5433/bookkeeping \
DATABASE_URL=postgres://bookkeeping_app:app_pw@localhost:5433/bookkeeping \
WORKER_DATABASE_URL=postgres://bookkeeping_worker:worker_pw@localhost:5433/bookkeeping \
SUPERVISOR_DATABASE_URL=postgres://bookkeeping_supervisor:supervisor_pw@localhost:5433/bookkeeping \
npm run migrate; echo "migrate exit=$?"
mv .env.bak .env
```

Expected: exits 0. If it fails with an env-file error, change both `package.json` scripts to `node --env-file-if-exists=.env …` (Node 20.12+) and re-run. Record which outcome occurred — Task 8 documents it.

- [ ] **Step 3: Validate the workflow YAML**

Run: `npx --yes actionlint .github/workflows/ci.yml || npx --yes yaml-lint .github/workflows/ci.yml`
Expected: no errors. If neither tool is installable offline, verify with `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))" && echo yaml-ok`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run the domain suite, both typechecks, and the web build

One serial job with a dedicated postgres:16 service. The suite drops and
recreates the schema per test file (tests/helpers/db.ts), so it cannot share a
database with anything else — which is why local runs have been unreliable and
why CI is the first authoritative answer on whether the 693 tests pass. A second
job publishes the image to GHCR from main."
```

- [ ] **Step 5: Push and read the result**

```bash
git push -u origin worktree-deploy-hetzner-pilot
gh run watch
```

Expected: the `test` job completes. **If the suite reports real failures, stop and report them — do not proceed to Task 6.** This is the first trustworthy signal about the suite's state, and the design's §9 says the cutover waits on it.

---

### Task 6: Backups and a restore drill that actually runs

**Files:**
- Create: `scripts/backup.sh`
- Create: `scripts/restore-drill.sh`
- Create: `deploy/bookkeeping-backup.service`
- Create: `deploy/bookkeeping-backup.timer`

**Interfaces:**
- Consumes: the service names `db`, `web` and the volume `blobdata` from Task 4.
- Produces: `scripts/backup.sh` writes `${BACKUP_DIR}/db-<UTC ISO>.dump` and `${BACKUP_DIR}/blobs-<UTC ISO>.tar.gz`. `scripts/restore-drill.sh` exits 0 only if the newest dump restores and contains data.

- [ ] **Step 1: Write the backup script**

Create `scripts/backup.sh`, `chmod +x`. Both halves matter: the ledger is in Postgres, the source documents are on the filesystem, and a Postgres-only backup cannot reconstruct an audit trail.

```bash
#!/usr/bin/env bash
# Nightly backup: Postgres custom-format dump + the blob volume, then offsite via restic.
# Runs on the host (not in a container) so it survives an application failure.
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-/opt/bookkeeping/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-/opt/bookkeeping/.env}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

mkdir -p "$BACKUP_DIR"

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

compose exec -T db pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  > "$BACKUP_DIR/db-$STAMP.dump"

compose exec -T web tar -czf - -C /app/.blob-store . \
  > "$BACKUP_DIR/blobs-$STAMP.tar.gz"

echo "[backup] wrote db-$STAMP.dump ($(du -h "$BACKUP_DIR/db-$STAMP.dump" | cut -f1)) and blobs-$STAMP.tar.gz ($(du -h "$BACKUP_DIR/blobs-$STAMP.tar.gz" | cut -f1))"

# Local retention: 8 days of dailies on disk; restic holds the long tail offsite.
find "$BACKUP_DIR" -maxdepth 1 -name 'db-*.dump' -mtime +8 -delete
find "$BACKUP_DIR" -maxdepth 1 -name 'blobs-*.tar.gz' -mtime +8 -delete

if [ -n "${RESTIC_REPOSITORY:-}" ]; then
  restic backup --tag bookkeeping "$BACKUP_DIR"
  restic forget --tag bookkeeping --keep-daily 7 --keep-weekly 4 --prune
  echo "[backup] pushed offsite to $RESTIC_REPOSITORY"
else
  echo "[backup] RESTIC_REPOSITORY unset — LOCAL ONLY, no offsite copy" >&2
fi
```

- [ ] **Step 2: Write the restore drill**

Create `scripts/restore-drill.sh`, `chmod +x`. Step 3 of the design's drill asserts non-zero rows in `journal_entries` and `einvoices`; the migrate check that the dump is schema-current is a manual follow-up documented in Task 8, because it needs the app image and a writable target.

```bash
#!/usr/bin/env bash
# Restores the newest dump into a throwaway container and asserts it is usable.
# Exits non-zero if the backup is not restorable — the only test that matters.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
DUMP="$(ls -1t "$BACKUP_DIR"/db-*.dump 2>/dev/null | head -1)"
[ -n "$DUMP" ] || { echo "no dump found in $BACKUP_DIR" >&2; exit 1; }
echo "[drill] restoring $DUMP"

CONTAINER="bk-restore-drill-$$"
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$CONTAINER" \
  -e POSTGRES_USER=admin -e POSTGRES_PASSWORD=admin -e POSTGRES_DB=bookkeeping \
  postgres:16 >/dev/null

until docker exec "$CONTAINER" pg_isready -U admin -d bookkeeping >/dev/null 2>&1; do
  sleep 1
done

docker exec -i "$CONTAINER" pg_restore -U admin -d bookkeeping --no-owner < "$DUMP"

for table in journal_entries einvoices; do
  count="$(docker exec "$CONTAINER" psql -U admin -d bookkeeping -tAc "select count(*) from $table")"
  echo "[drill] $table: $count rows"
  [ "$count" -gt 0 ] || { echo "[drill] FAIL: $table is empty" >&2; exit 1; }
done

echo "[drill] PASS — $DUMP is restorable and populated"
```

- [ ] **Step 3: Write the systemd unit and timer**

Create `deploy/bookkeeping-backup.service`:

```ini
[Unit]
Description=Bookkeeping nightly backup
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
EnvironmentFile=/opt/bookkeeping/backup.env
ExecStart=/opt/bookkeeping/scripts/backup.sh
```

Create `deploy/bookkeeping-backup.timer`:

```ini
[Unit]
Description=Run the bookkeeping backup nightly

[Timer]
OnCalendar=*-*-* 02:30:00
Persistent=true
RandomizedDelaySec=15m

[Install]
WantedBy=timers.target
```

- [ ] **Step 4: Prove the backup script works against the local stack**

Bring Task 4's stack up, put a row in the ledger so the drill has something to assert, then run both scripts with paths pointed at the working tree:

```bash
cd /home/karlis/git/book-keeping
docker compose -f docker-compose.prod.yml --env-file .env.prod.local up -d
sleep 10
COMPOSE_FILE=./docker-compose.prod.yml ENV_FILE=./.env.prod.local BACKUP_DIR=/tmp/bk-backups \
  ./scripts/backup.sh
ls -la /tmp/bk-backups
```
Expected: one `db-*.dump` and one `blobs-*.tar.gz`, both non-zero, plus the `RESTIC_REPOSITORY unset — LOCAL ONLY` warning on stderr.

- [ ] **Step 5: Prove the restore drill catches an empty database**

The stack was migrated but never used, so `journal_entries` is empty and the drill must **fail**. That is the test of the test:

```bash
BACKUP_DIR=/tmp/bk-backups ./scripts/restore-drill.sh; echo "drill exit=$?"
```
Expected: `[drill] FAIL: journal_entries is empty` and a non-zero exit. A passing drill here would mean the assertions do not work.

- [ ] **Step 6: Prove the restore drill passes on real data**

Seed the stack, back it up again, and re-run:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod.local run --rm \
  -e DEV_ROUTES_ENABLED=1 -e NODE_ENV=development web npm run seed
COMPOSE_FILE=./docker-compose.prod.yml ENV_FILE=./.env.prod.local BACKUP_DIR=/tmp/bk-backups \
  ./scripts/backup.sh
BACKUP_DIR=/tmp/bk-backups ./scripts/restore-drill.sh; echo "drill exit=$?"
```
Expected: `[drill] PASS`, exit 0, with non-zero counts for both tables. If `npm run seed` refuses because of `NODE_ENV`, seed against the dev DB on `localhost:5433` instead and dump that — the point is a populated dump, not the route it took.

- [ ] **Step 7: Tear down**

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod.local down -v
rm -rf /tmp/bk-backups
```

- [ ] **Step 8: Commit**

```bash
git add scripts/backup.sh scripts/restore-drill.sh deploy/bookkeeping-backup.service deploy/bookkeeping-backup.timer
git commit -m "ops: nightly backup and a restore drill that can fail

Dumps Postgres and the blob volume — a Postgres-only backup cannot reconstruct
an audit trail, since the ledger and its source documents live in different
places. The drill restores the newest dump into a throwaway container and
asserts journal_entries and einvoices are populated, so an unrestorable backup
is a non-zero exit rather than a discovery made during an incident."
```

---

### Task 7: Rotate the in-git role passwords

`migrations/000_bootstrap.sql:5`, `039_jobs.sql:9`, and `041_supervisor_role.sql:10` create `bookkeeping_app`, `bookkeeping_worker`, and `bookkeeping_supervisor` with the literal passwords `app_pw`, `worker_pw`, `supervisor_pw`. Those are the app's runtime credentials, in version control. The migrations must keep those defaults so dev and CI work unchanged; production rotates them after migrating.

**Files:**
- Create: `scripts/rotate-db-passwords.sh`

**Interfaces:**
- Consumes: `ADMIN_DATABASE_URL` from the environment; the `db` service from Task 4.
- Produces: an executable that prints three `postgres://…` connection strings for `.env`. Task 8's runbook calls it between migrate and first boot.

- [ ] **Step 1: Write the script**

Create `scripts/rotate-db-passwords.sh`, `chmod +x`. It prints connection strings rather than editing `.env`, so the operator stays in control of the secret file.

```bash
#!/usr/bin/env bash
# Rotates the three non-owner role passwords off the defaults baked into
# migrations/000_bootstrap.sql, 039_jobs.sql and 041_supervisor_role.sql.
# Prints the connection strings to paste into .env. Idempotent: re-run any time.
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-/opt/bookkeeping/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-/opt/bookkeeping/.env}"
DB_HOST="${DB_HOST:-db}"

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

gen() { LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 32; }

echo "# Paste these into $ENV_FILE, then: docker compose ... up -d --force-recreate"
for role in app worker supervisor; do
  pw="$(gen)"
  compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
    -c "ALTER ROLE bookkeeping_$role PASSWORD '$pw';" >/dev/null
  case "$role" in
    app)        var=DATABASE_URL ;;
    worker)     var=WORKER_DATABASE_URL ;;
    supervisor) var=SUPERVISOR_DATABASE_URL ;;
  esac
  echo "$var=postgres://bookkeeping_$role:$pw@$DB_HOST:5432/$POSTGRES_DB"
done
echo "# ADMIN_DATABASE_URL is unchanged — it uses the POSTGRES_USER superuser."
```

- [ ] **Step 2: Verify it rotates and that the old password stops working**

```bash
cd /home/karlis/git/book-keeping
docker compose -f docker-compose.prod.yml --env-file .env.prod.local up -d db
sleep 8
docker compose -f docker-compose.prod.yml --env-file .env.prod.local run --rm web npm run migrate
COMPOSE_FILE=./docker-compose.prod.yml ENV_FILE=./.env.prod.local DB_HOST=db \
  ./scripts/rotate-db-passwords.sh | tee /tmp/rotated.txt
```
Expected: three lines, each with a fresh 32-character password.

Then prove the default is dead — connect as `bookkeeping_app` with `app_pw` from inside the db container:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod.local exec db \
  sh -c 'PGPASSWORD=app_pw psql -U bookkeeping_app -d bookkeeping -h 127.0.0.1 -c "select 1"' \
  ; echo "old-password exit=$?"
```
Expected: authentication failure, non-zero exit.

- [ ] **Step 3: Verify a rotated string works**

```bash
grep '^DATABASE_URL=' /tmp/rotated.txt
```
Take the password from that line and:
```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod.local exec db \
  sh -c 'PGPASSWORD=<paste> psql -U bookkeeping_app -d bookkeeping -h 127.0.0.1 -c "select 1"'
```
Expected: `1` and exit 0.

- [ ] **Step 4: Tear down**

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod.local down -v
rm -f /tmp/rotated.txt
```

- [ ] **Step 5: Commit**

```bash
git add scripts/rotate-db-passwords.sh
git commit -m "ops: rotate the role passwords baked into migrations

bookkeeping_app, _worker and _supervisor are created with app_pw/worker_pw/
supervisor_pw in migrations, which is fine for dev and CI and not fine on a box
holding real books. The migrations keep their defaults so nothing else changes;
production rotates after migrating and pastes the printed strings into .env."
```

---

### Task 8: Runbook, env reference, and handoff

**Files:**
- Modify: `.env.example`
- Modify: `docs/RUNNING.md`
- Modify: `HANDOFF.md`

**Interfaces:**
- Consumes: everything from Tasks 1–7, by exact filename and command.
- Produces: no code.

- [ ] **Step 1: Extend `.env.example`**

Add a labelled VPS section and label the existing production block as the Vercel option. Append:

```bash
# --- VPS deployment (Hetzner + Docker Compose; see docs/RUNNING.md §4) ---
# Passed to docker-compose.prod.yml, which reads them via --env-file.
APP_IMAGE=ghcr.io/<owner>/<repo>:latest
SITE_ADDRESS=books.example.lv
POSTGRES_USER=bookkeeping_owner
POSTGRES_PASSWORD=          # generate; this is ADMIN_DATABASE_URL's password too
POSTGRES_DB=bookkeeping
# The three app-role strings come from scripts/rotate-db-passwords.sh — never
# ship the app_pw/worker_pw/supervisor_pw defaults baked into the migrations.

# Positive opt-ins. LEAVE BOTH UNSET IN PRODUCTION.
# DEV_ROUTES_ENABLED=1   # unlocks GET /api/dev/bootstrap (migrates, seeds, signs in
#                        #   as accountant@demo.lv — unauthenticated). Dev only.
# BANKFEED_ALLOW_STUB=1  # allows the auto-linking stub bank feed in production.
#                        #   Only for a deployment with seeded, non-real data.
```

Also change the existing `# Production (Vercel + Neon):` comment to `# Production option A — Vercel + Neon (see docs/RUNNING.md §3):`.

- [ ] **Step 2: Write `docs/RUNNING.md` §4**

Insert a new `## 4. Deploying on a VPS (Hetzner + Docker Compose)` section after §3, and retitle §3 from `## 3. Deploying on Vercel (Neon + Vercel Blob)` to `## 3. Deploying on Vercel (Neon + Vercel Blob) — the hosted option`. §4 covers, in this order:

1. **Why this is the primary path** — one paragraph, pointing at the spec: Vercel Hobby is restricted to non-commercial personal use, its crons cap the queue at ≤20 jobs/day, and Neon free retains six hours of PITR. Link `docs/superpowers/specs/2026-07-31-hetzner-pilot-deployment-design.md`.
2. **Provision** — Hetzner CX22 (2 vCPU / 4 GB / 40 GB, €3.79/mo) in Nuremberg or Helsinki, harden SSH, install Docker, `git clone` to `/opt/bookkeeping`.
3. **Configure** — write `/opt/bookkeeping/.env` from `.env.example`'s VPS section, `chmod 600`. State explicitly that `DEV_ROUTES_ENABLED` and `BANKFEED_ALLOW_STUB` stay unset.
4. **First deploy** — `docker compose -f docker-compose.prod.yml --env-file .env pull`, then `run --rm web npm run migrate`, then `scripts/rotate-db-passwords.sh` and paste its output into `.env`, then `up -d --force-recreate`.
5. **First admin** — `docker compose … run --rm web npm run provision-admin` with `PROVISION_FIRM` and `PROVISION_EMAIL`; open the printed `/invite/<token>` (72 h, single use), set a password, enrol TOTP. Cross-reference §3.4, which already documents idempotency.
6. **Backups** — copy `deploy/bookkeeping-backup.{service,timer}` to `/etc/systemd/system/`, write `/opt/bookkeeping/backup.env` with `BACKUP_DIR`, `COMPOSE_FILE`, `ENV_FILE` and the restic variables, `systemctl enable --now bookkeeping-backup.timer`. State that **the restore drill runs before the accountant logs in**: `scripts/restore-drill.sh`, then quarterly. Add the manual schema-currency check the drill cannot do: point a throwaway `ADMIN_DATABASE_URL` at the restored container and confirm `npm run migrate` applies nothing.
7. **Smoke checklist** — reproduce the design's §7 list as checkboxes: `/api/health` → `{"ok":true}`; log in with email + password + TOTP; upload a document; issue an invoice; `GET /api/dev/bootstrap` → **403**; confirm the bank feed refuses to auto-link. Note that §3.5's Blob cache-bypass check does not apply, because `LocalBlobStore` has no CDN in front of it.
8. **Deploy and roll back** — pull a new tag, `run --rm web npm run migrate`, `up -d`. Rollback is the same three commands with the previous tag; migrations are forward-only because the ledger is append-only.
9. **Known limitations** — no observability or error tracking, no disk encryption, no GDPR export/erasure, no email of any kind (invites and credential resets are copy-paste URLs, dunning creates internal tasks), Peppol and VID remain stubs. Note that Latvia's B2B e-invoicing mandate is 2028-01-01, so the stubs block only clients invoicing budget institutions, for whom VID reporting has been mandatory since 2026-01-01.

Record the Step-2 finding from Task 5 here: whether `npm run migrate` tolerates a missing `.env`, and if the scripts were changed to `--env-file-if-exists`, say so.

- [ ] **Step 3: Verify every command in §4 is copy-pasteable**

Read §4 and check each fenced command against what Tasks 3–7 actually verified. Specifically confirm the service name is `web` (not `app`), the compose file is `docker-compose.prod.yml`, and the script paths are `scripts/backup.sh`, `scripts/restore-drill.sh`, `scripts/rotate-db-passwords.sh`. Fix any drift.

- [ ] **Step 4: Add the HANDOFF.md entry**

Under `## Cross-cutting, before or alongside the above`, add a blockquote in the style of the existing 2026-07-19 entry: what shipped (the two fail-open guard fixes, the container stack, CI, backups + drill, password rotation), and what remains open from the design's §8 — observability, disk encryption, GDPR export/erasure, audit-log hash chain, email, Peppol/VID.

- [ ] **Step 5: Full gates**

```bash
npm test
npx tsc --noEmit
cd web && npx tsc --noEmit && cd ..
```
Expected: green. Documentation-only, but the suite must still pass before the branch is called done.

- [ ] **Step 6: Commit**

```bash
git add .env.example docs/RUNNING.md HANDOFF.md
git commit -m "docs(deploy): VPS runbook, env reference, and handoff entry

RUNNING.md gains a §4 for the Hetzner + Compose path and §3 is relabelled as the
hosted Vercel option. .env.example documents the two new positive opt-ins with
an explicit leave-unset-in-production warning, and points at
rotate-db-passwords.sh instead of the defaults baked into the migrations."
```

---

## Self-Review

**Spec coverage.** §1 verdict → Task 5 (CI is what makes the suite authoritative) and Task 8 step 4. §2 topology → Task 4. §3 build/deploy → Task 3 (image, `next start`, `outputFileTracingRoot`) and Task 5's `image` job. §4 code changes: item 1 → Task 1; item 2 → Task 2; items 3–5 → Tasks 3 and 4; item 6 → Task 3 step 1; items 7–8 → Task 8. §5 backups + drill → Task 6. §6 CI → Task 5. §7 cutover + smoke checklist → Task 8 step 2, with the two guard checks additionally executed live in Task 4 steps 5–6. §8 out-of-scope → Task 8 step 2 item 9 and step 4. §9 risks → Task 5 step 5 gates the cutover on the suite.

One item is in the plan but not the spec: **Task 7, password rotation.** It was found while writing the plan (`migrations/000_bootstrap.sql:5` and friends hardcode the runtime credentials) and is security-relevant on a box holding real books, so it is included rather than deferred.

One spec item is deliberately unimplemented: §5's "run `npm run migrate` against the restored dump, must apply nothing." `scripts/restore-drill.sh` cannot do it without the app image and a writable target, so Task 8 step 2 item 6 documents it as a manual check alongside the automated drill. Flagged rather than silently dropped.

**Placeholder scan.** No TBD/TODO. Angle-bracket values that remain are genuine per-operator substitutions, each with a resolution path: `<owner>`/`<repo>` in `.env.example` (Task 5 produces the real value), `<paste>` in Task 7 step 3 (from the preceding command's output), `books.example.lv` as an illustrative hostname. Two steps have explicitly branched outcomes rather than assumed ones — Task 3 step 2 (`__dirname` under a TS config) and Task 5 step 2 (`--env-file` with no file) — because neither could be verified without running it; both state the fallback and forbid proceeding until clean.

**Type consistency.** `bankFeedStubAllowed(env: { NODE_ENV?, BANKFEED_ALLOW_STUB? })` is defined in Task 1 step 3 and called in step 7 with exactly that destructured shape. `devBootstrapAllowed(env: { NODE_ENV?, VERCEL_ENV?, DEV_ROUTES_ENABLED? })` is defined in Task 2 step 3; its sole caller passes `process.env` and is explicitly left alone. Service names `db`/`web`/`worker`/`caddy` and volumes `pgdata`/`blobdata`/`caddydata`/`caddyconfig` are declared in Task 4 step 2 and used with those names in Tasks 4, 6, and 7. `BLOB_DIR=/app/.blob-store` in Task 4 matches `src/blob/factory.ts:19` and the `tar -C /app/.blob-store` path in Task 6. `BACKUP_DIR`, `COMPOSE_FILE`, and `ENV_FILE` are the same three variables across Tasks 6, 7, and 8.
