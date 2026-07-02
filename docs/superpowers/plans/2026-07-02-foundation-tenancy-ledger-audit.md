# Foundation: Tenancy, Ledger Core & Audit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the deterministic, multi-tenant, append-only double-entry accounting core that every other module posts through.

**Architecture:** A TypeScript/Node modular monolith over PostgreSQL. Multi-tenancy is enforced in the database with row-level security (RLS) keyed on `client_company_id`; the application connects as a non-superuser role with `FORCE ROW LEVEL SECURITY` so RLS cannot be bypassed. All ledger writes go through a single `postEntry` API that validates double-entry balance and period status. The journal is append-only — corrections are reversing entries. Every mutation writes an audit record in the same transaction.

**Tech Stack:** Node 24 + TypeScript, PostgreSQL 16, `pg` (node-postgres), `zod` (validation), `vitest` (tests), raw SQL migrations run by a small in-repo runner, Docker Compose for a local/test Postgres.

## Global Constraints

- **Append-only journal:** no `UPDATE`/`DELETE` on `journal_entries` or `journal_lines`. Corrections are reversing entries only. Enforced by a DB rule/trigger and never violated in code.
- **Every entry balances:** `Σ debit = Σ credit` per entry; rejected otherwise.
- **All tenant data is RLS-scoped** on `client_company_id`; the app connects as non-superuser role `bookkeeping_app` with `FORCE ROW LEVEL SECURITY` on every tenant table.
- **Money is `NUMERIC(18,2)`**, never floating point. Amounts are compared as integer cents in code.
- **Every mutation appends an audit row** (`who / what / when / before / after`) in the same transaction as the change.
- **Every DB access happens inside `withTenant(ctx, fn)`** which opens a transaction and sets the tenant session variable; no ad-hoc pool queries for tenant tables.
- **Node 24, TypeScript strict mode**, ESM modules.

---

## File structure

```
package.json                         # deps + scripts
tsconfig.json                        # strict, ESM, NodeNext
vitest.config.ts                     # test config, single-fork for DB tests
docker-compose.yml                   # postgres:16 for local + test
.env.example                         # ADMIN_DATABASE_URL, DATABASE_URL
migrations/
  000_bootstrap.sql                  # (run as admin) role + extensions
  001_firms_clients.sql              # firms, client_companies
  002_rls.sql                        # enable + force RLS, policies
  003_chart_of_accounts.sql          # accounts
  004_periods.sql                    # accounting_periods
  005_journal.sql                    # journal_entries, journal_lines, append-only guard
  006_audit_log.sql                  # audit_log
src/
  db/
    pool.ts        # admin + app pools, withTenant() transaction helper
    migrate.ts     # migration runner (tracks applied files)
    money.ts       # toCents(), sumCents() decimal helpers
  tenancy/
    context.ts     # TenantContext type
    firms.ts       # createFirm(), createClientCompany()
  ledger/
    accounts.ts    # createAccount(), listAccounts()
    periods.ts     # openPeriod(), closePeriod(), periodStatusFor()
    posting.ts     # postEntry(), reverseEntry(), getEntry()
    balances.ts    # trialBalance()
  audit/
    audit.ts       # appendAudit()
tests/
  helpers/db.ts    # resetDb(), makeFirmAndClient(), ctx()
  db/migrate.test.ts
  tenancy/firms.test.ts
  tenancy/rls.test.ts
  ledger/accounts.test.ts
  ledger/periods.test.ts
  ledger/posting.test.ts
  ledger/reversing.test.ts
  ledger/balances.test.ts
  audit/audit.test.ts
```

**Interfaces produced by this plan** (later plans consume these):

```ts
// src/tenancy/context.ts
export interface TenantContext {
  firmId: string;
  clientCompanyId: string;
  actorId: string;              // user or 'agent'
  actorRole: string;            // 'accountant' | 'owner' | 'employee' | 'admin' | 'agent'
}

// src/db/pool.ts
export function withTenant<T>(
  ctx: TenantContext,
  fn: (tx: import('pg').PoolClient) => Promise<T>,
): Promise<T>;

// src/ledger/posting.ts
export interface NewJournalLine {
  accountCode: string;
  debit: string;   // decimal string, e.g. "100.00"; exactly one of debit/credit is non-zero
  credit: string;
  description?: string;
}
export interface NewJournalEntry {
  date: string;               // 'YYYY-MM-DD'
  memo: string;
  currency: string;           // ISO 4217, e.g. 'EUR'
  lines: NewJournalLine[];
  sourceDocumentId?: string | null;
}
export function postEntry(tx: import('pg').PoolClient, ctx: TenantContext, entry: NewJournalEntry): Promise<{ entryId: string }>;
export function reverseEntry(tx: import('pg').PoolClient, ctx: TenantContext, entryId: string, memo: string): Promise<{ entryId: string }>;
export function getEntry(tx: import('pg').PoolClient, ctx: TenantContext, entryId: string): Promise<JournalEntryRow>;
```

---

## Task 1: Project scaffolding + Postgres + migration runner

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `docker-compose.yml`, `.env.example`, `.gitignore`
- Create: `migrations/000_bootstrap.sql`
- Create: `src/db/pool.ts`, `src/db/migrate.ts`
- Test: `tests/helpers/db.ts`, `tests/db/migrate.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `adminPool`, `appPool` (pg `Pool`s), `runMigrations(pool)`, and the `bookkeeping_app` DB role that RLS applies to.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "bookkeeping",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "migrate": "tsx src/db/migrate.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "pg": "^8.13.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "@types/pg": "^8.11.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noUncheckedIndexedAccess": true,
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`** (DB tests must not run in parallel across files — they share one database)

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    hookTimeout: 30000,
    testTimeout: 30000,
  },
});
```

- [ ] **Step 4: Create `docker-compose.yml`**

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: admin
      POSTGRES_PASSWORD: admin
      POSTGRES_DB: bookkeeping
    ports:
      - "5433:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U admin -d bookkeeping"]
      interval: 2s
      timeout: 5s
      retries: 15
```

- [ ] **Step 5: Create `.env.example` and `.gitignore`**

`.env.example`:
```
# Admin connection (superuser) — runs bootstrap + migrations
ADMIN_DATABASE_URL=postgres://admin:admin@localhost:5433/bookkeeping
# Application connection — non-superuser, RLS applies
DATABASE_URL=postgres://bookkeeping_app:app_pw@localhost:5433/bookkeeping
```

`.gitignore`:
```
node_modules
dist
.env
```

- [ ] **Step 6: Create `migrations/000_bootstrap.sql`** (idempotent; run as admin, creates the RLS-subject role)

```sql
-- Runs as admin. Creates the non-superuser app role that RLS applies to.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bookkeeping_app') THEN
    CREATE ROLE bookkeeping_app LOGIN PASSWORD 'app_pw';
  END IF;
END $$;

GRANT ALL ON SCHEMA public TO bookkeeping_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO bookkeeping_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO bookkeeping_app;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- gen_random_uuid()
```

- [ ] **Step 7: Create `src/db/pool.ts`**

```ts
import { Pool, type PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export const adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
export const appPool = new Pool({ connectionString: process.env.DATABASE_URL });

/**
 * Runs `fn` inside a transaction on the APP pool with the tenant session var set,
 * so RLS restricts every statement to ctx.clientCompanyId. Rolls back on throw.
 */
export async function withTenant<T>(
  ctx: TenantContext,
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const tx = await appPool.connect();
  try {
    await tx.query('BEGIN');
    // set_config(..., true) = local to this transaction. Parameterized to avoid injection.
    await tx.query("SELECT set_config('app.current_client_id', $1, true)", [ctx.clientCompanyId]);
    const result = await fn(tx);
    await tx.query('COMMIT');
    return result;
  } catch (err) {
    await tx.query('ROLLBACK');
    throw err;
  } finally {
    tx.release();
  }
}
```

- [ ] **Step 8: Create `src/db/migrate.ts`** (tracks applied files; `000_bootstrap.sql` runs on admin pool, the rest on app pool as owner)

```ts
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Pool } from 'pg';
import { adminPool, appPool } from './pool.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

export async function runMigrations(): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];

  // Bootstrap (admin) must run first and is idempotent.
  const bootstrap = files.find((f) => f.startsWith('000_'));
  if (bootstrap) {
    await adminPool.query(await readFile(join(MIGRATIONS_DIR, bootstrap), 'utf8'));
    applied.push(bootstrap);
  }

  await appPool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  for (const file of files) {
    if (file.startsWith('000_')) continue;
    const done = await appPool.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
    if (done.rowCount) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  return applied;
}

// Allow `npm run migrate`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrations()
    .then((a) => { console.log('Applied:', a); return Promise.all([adminPool.end(), appPool.end()]); })
    .catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 9: Create `tests/helpers/db.ts`** (test DB reset — drops all app objects then re-migrates)

```ts
import { adminPool, appPool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';

/** Wipe the public schema (as admin, to also drop the migrations table cleanly) and re-run migrations. */
export async function resetDb(): Promise<void> {
  await adminPool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations();
}

export async function closeDb(): Promise<void> {
  await Promise.all([adminPool.end(), appPool.end()]);
}
```

- [ ] **Step 10: Write the failing test — `tests/db/migrate.test.ts`**

```ts
import { afterAll, beforeAll, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { appPool } from '../../src/db/pool.js';

beforeAll(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('migrations create the schema_migrations bookkeeping table', async () => {
  const res = await appPool.query(
    "SELECT filename FROM schema_migrations ORDER BY filename",
  );
  expect(res.rows.map((r) => r.filename)).toContain('001_firms_clients.sql');
});

test('app role is not a superuser (so RLS applies)', async () => {
  const res = await appPool.query(
    "SELECT rolsuper FROM pg_roles WHERE rolname = current_user",
  );
  expect(res.rows[0].rolsuper).toBe(false);
});
```

- [ ] **Step 11: Run the test to verify it fails**

Run: `docker compose up -d db && npm install && npx vitest run tests/db/migrate.test.ts`
Expected: FAIL — `001_firms_clients.sql` does not exist yet, so `resetDb()`/queries error. (This proves the harness runs and the migration is genuinely missing.)

- [ ] **Step 12: Create the minimal `migrations/001_firms_clients.sql` to make migration run succeed** (schema fleshed out in Task 2; a valid file is enough here)

```sql
CREATE TABLE firms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 13: Run the test to verify it passes**

Run: `npx vitest run tests/db/migrate.test.ts`
Expected: PASS (both tests green).

- [ ] **Step 14: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts docker-compose.yml .env.example .gitignore migrations/000_bootstrap.sql migrations/001_firms_clients.sql src/db tests/helpers tests/db
git commit -m "feat: project scaffolding, postgres, and migration runner"
```

---

## Task 2: Firms & Client Companies

**Files:**
- Modify: `migrations/001_firms_clients.sql`
- Create: `src/tenancy/context.ts`, `src/tenancy/firms.ts`
- Test: `tests/tenancy/firms.test.ts`

**Interfaces:**
- Consumes: `adminPool`/`appPool` (Task 1).
- Produces: `TenantContext`, `createFirm(name)`, `createClientCompany(firmId, {name, regNo})`.

- [ ] **Step 1: Flesh out `migrations/001_firms_clients.sql`**

```sql
CREATE TABLE firms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE client_companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  name text NOT NULL,
  reg_no text NOT NULL,
  base_currency char(3) NOT NULL DEFAULT 'EUR',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX client_companies_firm_id_idx ON client_companies(firm_id);
```

- [ ] **Step 2: Create `src/tenancy/context.ts`**

```ts
export interface TenantContext {
  firmId: string;
  clientCompanyId: string;
  actorId: string;   // user id, or 'agent'
  actorRole: string; // 'accountant' | 'owner' | 'employee' | 'admin' | 'agent'
}
```

- [ ] **Step 3: Write the failing test — `tests/tenancy/firms.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { createFirm, createClientCompany } from '../../src/tenancy/firms.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('creates a firm and returns its id', async () => {
  const firm = await createFirm('Acme Bookkeeping');
  expect(firm.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(firm.name).toBe('Acme Bookkeeping');
});

test('creates a client company under a firm', async () => {
  const firm = await createFirm('Acme Bookkeeping');
  const client = await createClientCompany(firm.id, { name: 'SIA Klients', regNo: '40000000000' });
  expect(client.firmId).toBe(firm.id);
  expect(client.regNo).toBe('40000000000');
  expect(client.baseCurrency).toBe('EUR');
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run tests/tenancy/firms.test.ts`
Expected: FAIL — `src/tenancy/firms.js` cannot be resolved.

- [ ] **Step 5: Create `src/tenancy/firms.ts`** (firms/clients are top-level org data — administered on the app pool, not tenant-scoped)

```ts
import { z } from 'zod';
import { appPool } from '../db/pool.js';

export interface Firm { id: string; name: string; }
export interface ClientCompany {
  id: string; firmId: string; name: string; regNo: string; baseCurrency: string;
}

const newClientSchema = z.object({
  name: z.string().min(1),
  regNo: z.string().min(1),
  baseCurrency: z.string().length(3).default('EUR'),
});

export async function createFirm(name: string): Promise<Firm> {
  const res = await appPool.query('INSERT INTO firms(name) VALUES ($1) RETURNING id, name', [name]);
  return res.rows[0];
}

export async function createClientCompany(
  firmId: string,
  input: { name: string; regNo: string; baseCurrency?: string },
): Promise<ClientCompany> {
  const parsed = newClientSchema.parse(input);
  const res = await appPool.query(
    `INSERT INTO client_companies(firm_id, name, reg_no, base_currency)
     VALUES ($1, $2, $3, $4)
     RETURNING id, firm_id AS "firmId", name, reg_no AS "regNo", base_currency AS "baseCurrency"`,
    [firmId, parsed.name, parsed.regNo, parsed.baseCurrency],
  );
  return res.rows[0];
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/tenancy/firms.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add migrations/001_firms_clients.sql src/tenancy tests/tenancy/firms.test.ts
git commit -m "feat: firms and client companies"
```

---

## Task 3: Row-level security & tenant isolation

**Files:**
- Create: `migrations/002_rls.sql`, `migrations/003_chart_of_accounts.sql`
- Test: `tests/tenancy/rls.test.ts`
- Test helper: modify `tests/helpers/db.ts` (add `makeFirmAndClient`, `ctx`)

**Interfaces:**
- Consumes: `withTenant` (Task 1), `createFirm`/`createClientCompany` (Task 2).
- Produces: RLS-protected `accounts` table; test helpers `makeFirmAndClient()`, `ctx(clientId)`.

> We introduce the `accounts` table here (not just in Task 4) because RLS needs a real tenant table to prove isolation against. Task 4 builds the account *API* on top of it.

- [ ] **Step 1: Create `migrations/003_chart_of_accounts.sql`**

```sql
CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  code text NOT NULL,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_company_id, code)
);
```

- [ ] **Step 2: Create `migrations/002_rls.sql`** (runs before 003? No — file order matters; see note)

> **Ordering note:** migrations run in filename order, so `002_rls.sql` runs before `003`. Put the *enable/force + policy* statements in a file that runs AFTER the table exists. Rename: make RLS its own migration `004_rls.sql` applied after account/period/journal tables, OR enable RLS per-table inside each table's own migration. **We choose per-table RLS inside each table migration** — it keeps each table's security next to its definition and avoids ordering bugs. Delete the standalone `002_rls.sql` plan; instead append the block below to `003_chart_of_accounts.sql`.

Append to `migrations/003_chart_of_accounts.sql`:

```sql
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;

CREATE POLICY accounts_tenant_isolation ON accounts
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
```

> Remove `migrations/002_rls.sql` from the file list; renumber is unnecessary since we inline RLS. (If already created empty in a prior step, delete it.)

- [ ] **Step 3: Add helpers to `tests/helpers/db.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { createFirm, createClientCompany } from '../../src/tenancy/firms.js';
import type { TenantContext } from '../../src/tenancy/context.js';

export async function makeFirmAndClient(clientName = 'SIA Test'): Promise<{ firmId: string; clientCompanyId: string }> {
  const firm = await createFirm('Test Firm');
  const client = await createClientCompany(firm.id, { name: clientName, regNo: '40000000000' });
  return { firmId: firm.id, clientCompanyId: client.id };
}

export function ctx(t: { firmId: string; clientCompanyId: string }): TenantContext {
  return { firmId: t.firmId, clientCompanyId: t.clientCompanyId, actorId: randomUUID(), actorRole: 'accountant' };
}
```

- [ ] **Step 4: Write the failing test — `tests/tenancy/rls.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('a tenant cannot read another tenant rows via RLS', async () => {
  const a = await makeFirmAndClient('Client A');
  const b = await makeFirmAndClient('Client B');

  await withTenant(ctx(a), async (tx) => {
    await tx.query(
      "INSERT INTO accounts(client_company_id, code, name, type) VALUES ($1,'1000','Cash','asset')",
      [a.clientCompanyId],
    );
  });

  const seenByB = await withTenant(ctx(b), async (tx) => {
    const r = await tx.query('SELECT code FROM accounts');
    return r.rows;
  });
  expect(seenByB).toHaveLength(0);

  const seenByA = await withTenant(ctx(a), async (tx) => {
    const r = await tx.query('SELECT code FROM accounts');
    return r.rows.map((row) => row.code);
  });
  expect(seenByA).toEqual(['1000']);
});

test('WITH CHECK blocks inserting a row for another tenant', async () => {
  const a = await makeFirmAndClient('Client A');
  const b = await makeFirmAndClient('Client B');
  await expect(
    withTenant(ctx(a), async (tx) => {
      await tx.query(
        "INSERT INTO accounts(client_company_id, code, name, type) VALUES ($1,'2000','Sneaky','asset')",
        [b.clientCompanyId], // trying to write into B while scoped to A
      );
    }),
  ).rejects.toThrow();
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npx vitest run tests/tenancy/rls.test.ts`
Expected: FAIL — RLS policy not created yet (rows leak), or `accounts` missing.

- [ ] **Step 6: Ensure `003_chart_of_accounts.sql` contains the RLS block from Step 2, then re-run**

Run: `npx vitest run tests/tenancy/rls.test.ts`
Expected: PASS (isolation holds, cross-tenant insert rejected).

- [ ] **Step 7: Commit**

```bash
git add migrations/003_chart_of_accounts.sql tests/helpers/db.ts tests/tenancy/rls.test.ts
git commit -m "feat: row-level security tenant isolation"
```

---

## Task 4: Chart of Accounts API

**Files:**
- Create: `src/ledger/accounts.ts`
- Test: `tests/ledger/accounts.test.ts`

**Interfaces:**
- Consumes: `withTenant`, `TenantContext`, RLS `accounts` table.
- Produces: `createAccount(tx, ctx, {code,name,type})`, `listAccounts(tx, ctx)`, `AccountRow`, type `AccountType`.

- [ ] **Step 1: Write the failing test — `tests/ledger/accounts.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount, listAccounts } from '../../src/ledger/accounts.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('creates accounts and lists them ordered by code', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '1000', name: 'Fixed assets', type: 'asset' });
  });
  const rows = await withTenant(ctx(t), (tx) => listAccounts(tx, ctx(t)));
  expect(rows.map((r) => r.code)).toEqual(['1000', '2310']);
});

test('rejects a duplicate account code for the same client', async () => {
  const t = await makeFirmAndClient();
  await expect(
    withTenant(ctx(t), async (tx) => {
      await createAccount(tx, ctx(t), { code: '2310', name: 'Bank', type: 'asset' });
      await createAccount(tx, ctx(t), { code: '2310', name: 'Dup', type: 'asset' });
    }),
  ).rejects.toThrow();
});

test('rejects an invalid account type', async () => {
  const t = await makeFirmAndClient();
  await expect(
    withTenant(ctx(t), (tx) => createAccount(tx, ctx(t), { code: '9', name: 'X', type: 'bogus' as never })),
  ).rejects.toThrow();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/ledger/accounts.test.ts`
Expected: FAIL — `src/ledger/accounts.js` missing.

- [ ] **Step 3: Create `src/ledger/accounts.ts`**

```ts
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
export interface AccountRow { id: string; code: string; name: string; type: AccountType; }

const newAccountSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(['asset', 'liability', 'equity', 'income', 'expense']),
});

export async function createAccount(
  tx: PoolClient,
  ctx: TenantContext,
  input: { code: string; name: string; type: AccountType },
): Promise<AccountRow> {
  const p = newAccountSchema.parse(input);
  const res = await tx.query(
    `INSERT INTO accounts(client_company_id, code, name, type)
     VALUES ($1,$2,$3,$4) RETURNING id, code, name, type`,
    [ctx.clientCompanyId, p.code, p.name, p.type],
  );
  return res.rows[0];
}

export async function listAccounts(tx: PoolClient, _ctx: TenantContext): Promise<AccountRow[]> {
  const res = await tx.query('SELECT id, code, name, type FROM accounts ORDER BY code');
  return res.rows;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/ledger/accounts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ledger/accounts.ts tests/ledger/accounts.test.ts
git commit -m "feat: chart of accounts API"
```

---

## Task 5: Accounting periods

**Files:**
- Create: `migrations/004_periods.sql`
- Create: `src/ledger/periods.ts`
- Test: `tests/ledger/periods.test.ts`

**Interfaces:**
- Consumes: `withTenant`, RLS pattern.
- Produces: `openPeriod(tx,ctx,{year,month})`, `closePeriod(tx,ctx,{year,month})`, `periodStatusFor(tx,ctx,date)` → `'open'|'closed'|'none'`.

- [ ] **Step 1: Create `migrations/004_periods.sql`**

```sql
CREATE TABLE accounting_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  year int NOT NULL,
  month int NOT NULL CHECK (month BETWEEN 1 AND 12),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  UNIQUE (client_company_id, year, month)
);

ALTER TABLE accounting_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_periods FORCE ROW LEVEL SECURITY;
CREATE POLICY periods_tenant_isolation ON accounting_periods
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
```

- [ ] **Step 2: Write the failing test — `tests/ledger/periods.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { openPeriod, closePeriod, periodStatusFor } from '../../src/ledger/periods.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('an unopened period reports status "none"', async () => {
  const t = await makeFirmAndClient();
  const status = await withTenant(ctx(t), (tx) => periodStatusFor(tx, ctx(t), '2026-03-15'));
  expect(status).toBe('none');
});

test('opening then closing a period changes its status', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
  });
  expect(await withTenant(ctx(t), (tx) => periodStatusFor(tx, ctx(t), '2026-03-15'))).toBe('open');

  await withTenant(ctx(t), (tx) => closePeriod(tx, ctx(t), { year: 2026, month: 3 }));
  expect(await withTenant(ctx(t), (tx) => periodStatusFor(tx, ctx(t), '2026-03-15'))).toBe('closed');
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/ledger/periods.test.ts`
Expected: FAIL — `src/ledger/periods.js` missing.

- [ ] **Step 4: Create `src/ledger/periods.ts`**

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export type PeriodStatus = 'open' | 'closed' | 'none';

export async function openPeriod(
  tx: PoolClient, ctx: TenantContext, p: { year: number; month: number },
): Promise<void> {
  await tx.query(
    `INSERT INTO accounting_periods(client_company_id, year, month, status)
     VALUES ($1,$2,$3,'open')
     ON CONFLICT (client_company_id, year, month) DO UPDATE SET status = 'open'`,
    [ctx.clientCompanyId, p.year, p.month],
  );
}

export async function closePeriod(
  tx: PoolClient, ctx: TenantContext, p: { year: number; month: number },
): Promise<void> {
  await tx.query(
    `UPDATE accounting_periods SET status = 'closed'
     WHERE client_company_id = $1 AND year = $2 AND month = $3`,
    [ctx.clientCompanyId, p.year, p.month],
  );
}

/** date is 'YYYY-MM-DD'. */
export async function periodStatusFor(
  tx: PoolClient, _ctx: TenantContext, date: string,
): Promise<PeriodStatus> {
  const [y, m] = date.split('-').map(Number);
  const res = await tx.query(
    'SELECT status FROM accounting_periods WHERE year = $1 AND month = $2',
    [y, m],
  );
  return (res.rows[0]?.status as PeriodStatus) ?? 'none';
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/ledger/periods.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add migrations/004_periods.sql src/ledger/periods.ts tests/ledger/periods.test.ts
git commit -m "feat: accounting periods with open/close"
```

---

## Task 6: Money helper

**Files:**
- Create: `src/db/money.ts`
- Test: `tests/db/money.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `toCents(s: string): bigint`, `sumCents(values: string[]): bigint`, `centsEqual(a,b): boolean`.

- [ ] **Step 1: Write the failing test — `tests/db/money.test.ts`**

```ts
import { expect, test } from 'vitest';
import { toCents, sumCents } from '../../src/db/money.js';

test('toCents parses decimal strings without float error', () => {
  expect(toCents('100.00')).toBe(10000n);
  expect(toCents('0.1')).toBe(10n);
  expect(toCents('1234567.89')).toBe(123456789n);
});

test('toCents rejects more than two decimal places', () => {
  expect(() => toCents('1.234')).toThrow();
});

test('sumCents adds a list of decimal strings exactly', () => {
  expect(sumCents(['0.10', '0.20'])).toBe(30n); // the classic 0.1 + 0.2 float trap
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/db/money.test.ts`
Expected: FAIL — `src/db/money.js` missing.

- [ ] **Step 3: Create `src/db/money.ts`**

```ts
/** Parse a decimal money string ("100.00", "-5.5") into integer cents. Max 2 dp. */
export function toCents(s: string): bigint {
  if (!/^-?\d+(\.\d{1,2})?$/.test(s.trim())) {
    throw new Error(`Invalid money value: "${s}" (max 2 decimal places)`);
  }
  const neg = s.trim().startsWith('-');
  const [whole, frac = ''] = s.trim().replace('-', '').split('.');
  const cents = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
  return neg ? -cents : cents;
}

export function sumCents(values: string[]): bigint {
  return values.reduce<bigint>((acc, v) => acc + toCents(v), 0n);
}

export function centsEqual(a: bigint, b: bigint): boolean {
  return a === b;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/db/money.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/money.ts tests/db/money.test.ts
git commit -m "feat: exact money-to-cents helper"
```

---

## Task 7: Audit log

**Files:**
- Create: `migrations/006_audit_log.sql`
- Create: `src/audit/audit.ts`
- Test: `tests/audit/audit.test.ts`

**Interfaces:**
- Consumes: `withTenant`, `TenantContext`.
- Produces: `appendAudit(tx, ctx, {action, entityType, entityId, before, after})`.

> Migration is numbered `006_` (Task 8's journal is `005_`); build order in this plan is audit-code first, but file order in `migrations/` is journal (005) then audit (006). The runner applies by filename, so create `005_journal.sql` (Task 8) and `006_audit_log.sql` regardless of task order; neither references the other's tables.

- [ ] **Step 1: Create `migrations/006_audit_log.sql`**

```sql
CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  actor_id text NOT NULL,
  actor_role text NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  before jsonb,
  after jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_tenant_isolation ON audit_log
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
```

- [ ] **Step 2: Write the failing test — `tests/audit/audit.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { appendAudit } from '../../src/audit/audit.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('appends an audit row scoped to the tenant', async () => {
  const t = await makeFirmAndClient();
  const rows = await withTenant(ctx(t), async (tx) => {
    await appendAudit(tx, ctx(t), {
      action: 'create', entityType: 'account', entityId: null,
      before: null, after: { code: '2310' },
    });
    const r = await tx.query('SELECT action, entity_type, after FROM audit_log');
    return r.rows;
  });
  expect(rows).toHaveLength(1);
  expect(rows[0].action).toBe('create');
  expect(rows[0].after).toEqual({ code: '2310' });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/audit/audit.test.ts`
Expected: FAIL — `src/audit/audit.js` missing.

- [ ] **Step 4: Create `src/audit/audit.ts`**

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export interface AuditInput {
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown | null;
  after: unknown | null;
}

export async function appendAudit(tx: PoolClient, ctx: TenantContext, a: AuditInput): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log(client_company_id, actor_id, actor_role, action, entity_type, entity_id, before, after)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      ctx.clientCompanyId, ctx.actorId, ctx.actorRole, a.action, a.entityType, a.entityId,
      a.before === null ? null : JSON.stringify(a.before),
      a.after === null ? null : JSON.stringify(a.after),
    ],
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/audit/audit.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add migrations/006_audit_log.sql src/audit/audit.ts tests/audit/audit.test.ts
git commit -m "feat: append-only audit log"
```

---

## Task 8: Journal & the posting API (the heart)

**Files:**
- Create: `migrations/005_journal.sql`
- Create: `src/ledger/posting.ts`
- Test: `tests/ledger/posting.test.ts`

**Interfaces:**
- Consumes: `withTenant`, `TenantContext`, `toCents`/`sumCents` (Task 6), `periodStatusFor` (Task 5), `appendAudit` (Task 7), `accounts` (Task 4).
- Produces: `NewJournalEntry`, `NewJournalLine`, `postEntry(tx,ctx,entry)`, `getEntry(tx,ctx,id)`, `JournalEntryRow`.

- [ ] **Step 1: Create `migrations/005_journal.sql`** (append-only enforced by triggers blocking UPDATE/DELETE)

```sql
CREATE TABLE journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  entry_date date NOT NULL,
  memo text NOT NULL,
  currency char(3) NOT NULL,
  source_document_id uuid,
  reverses_entry_id uuid REFERENCES journal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE journal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  entry_id uuid NOT NULL REFERENCES journal_entries(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  debit numeric(18,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit numeric(18,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  description text,
  CHECK (NOT (debit > 0 AND credit > 0))
);
CREATE INDEX journal_lines_entry_idx ON journal_lines(entry_id);
CREATE INDEX journal_lines_account_idx ON journal_lines(account_id);

-- Append-only guard: forbid UPDATE/DELETE on both tables.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'journal is append-only: % on % is not allowed', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_entries_append_only
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journal_lines_append_only
  BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- RLS
ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY je_tenant_isolation ON journal_entries
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

ALTER TABLE journal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY jl_tenant_isolation ON journal_lines
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
```

- [ ] **Step 2: Write the failing test — `tests/ledger/posting.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod, closePeriod } from '../../src/ledger/periods.js';
import { postEntry, getEntry } from '../../src/ledger/posting.js';

async function seed(t: { firmId: string; clientCompanyId: string }) {
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
  });
}

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('posts a balanced two-line entry and reads it back', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  const { entryId } = await withTenant(ctx(t), (tx) => postEntry(tx, ctx(t), {
    date: '2026-03-10', memo: 'Sale', currency: 'EUR',
    lines: [
      { accountCode: '2310', debit: '121.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '121.00' },
    ],
  }));
  const entry = await withTenant(ctx(t), (tx) => getEntry(tx, ctx(t), entryId));
  expect(entry.lines).toHaveLength(2);
  expect(entry.memo).toBe('Sale');
});

test('rejects an unbalanced entry', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  await expect(withTenant(ctx(t), (tx) => postEntry(tx, ctx(t), {
    date: '2026-03-10', memo: 'Bad', currency: 'EUR',
    lines: [
      { accountCode: '2310', debit: '100.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '90.00' },
    ],
  }))).rejects.toThrow(/balance/i);
});

test('rejects posting into a closed period', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  await withTenant(ctx(t), (tx) => closePeriod(tx, ctx(t), { year: 2026, month: 3 }));
  await expect(withTenant(ctx(t), (tx) => postEntry(tx, ctx(t), {
    date: '2026-03-10', memo: 'Late', currency: 'EUR',
    lines: [
      { accountCode: '2310', debit: '10.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '10.00' },
    ],
  }))).rejects.toThrow(/closed|period/i);
});

test('journal is append-only: UPDATE on journal_entries is blocked', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  const { entryId } = await withTenant(ctx(t), (tx) => postEntry(tx, ctx(t), {
    date: '2026-03-10', memo: 'Sale', currency: 'EUR',
    lines: [
      { accountCode: '2310', debit: '5.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '5.00' },
    ],
  }));
  await expect(withTenant(ctx(t), (tx) =>
    tx.query("UPDATE journal_entries SET memo = 'x' WHERE id = $1", [entryId]),
  )).rejects.toThrow(/append-only/i);
});

test('writes an audit row when an entry is posted', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  const audits = await withTenant(ctx(t), async (tx) => {
    await postEntry(tx, ctx(t), {
      date: '2026-03-10', memo: 'Sale', currency: 'EUR',
      lines: [
        { accountCode: '2310', debit: '5.00', credit: '0' },
        { accountCode: '6110', debit: '0', credit: '5.00' },
      ],
    });
    const r = await tx.query("SELECT action, entity_type FROM audit_log WHERE entity_type = 'journal_entry'");
    return r.rows;
  });
  expect(audits).toHaveLength(1);
  expect(audits[0].action).toBe('post');
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/ledger/posting.test.ts`
Expected: FAIL — `src/ledger/posting.js` missing.

- [ ] **Step 4: Create `src/ledger/posting.ts`**

```ts
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { sumCents } from '../db/money.js';
import { periodStatusFor } from './periods.js';
import { appendAudit } from '../audit/audit.js';

const lineSchema = z.object({
  accountCode: z.string().min(1),
  debit: z.string(),
  credit: z.string(),
  description: z.string().optional(),
});
const entrySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  memo: z.string().min(1),
  currency: z.string().length(3),
  lines: z.array(lineSchema).min(2),
  sourceDocumentId: z.string().uuid().nullable().optional(),
});

export interface NewJournalLine { accountCode: string; debit: string; credit: string; description?: string; }
export interface NewJournalEntry {
  date: string; memo: string; currency: string; lines: NewJournalLine[]; sourceDocumentId?: string | null;
}
export interface JournalEntryRow {
  id: string; entryDate: string; memo: string; currency: string;
  lines: { accountId: string; debit: string; credit: string; description: string | null }[];
}

export async function postEntry(
  tx: PoolClient, ctx: TenantContext, input: NewJournalEntry,
): Promise<{ entryId: string }> {
  const entry = entrySchema.parse(input);

  // 1. Balance check (integer cents).
  const debits = sumCents(entry.lines.map((l) => l.debit));
  const credits = sumCents(entry.lines.map((l) => l.credit));
  if (debits !== credits) {
    throw new Error(`Entry does not balance: debits ${debits} != credits ${credits}`);
  }

  // 2. Period must be open.
  const status = await periodStatusFor(tx, ctx, entry.date);
  if (status !== 'open') {
    throw new Error(`Cannot post into a ${status} period for date ${entry.date}`);
  }

  // 3. Resolve account codes to ids (RLS scopes to this tenant).
  const codes = [...new Set(entry.lines.map((l) => l.accountCode))];
  const accRes = await tx.query('SELECT id, code FROM accounts WHERE code = ANY($1)', [codes]);
  const idByCode = new Map<string, string>(accRes.rows.map((r) => [r.code, r.id]));
  for (const code of codes) {
    if (!idByCode.has(code)) throw new Error(`Unknown account code: ${code}`);
  }

  // 4. Insert entry + lines.
  const entryRes = await tx.query(
    `INSERT INTO journal_entries(client_company_id, entry_date, memo, currency, source_document_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [ctx.clientCompanyId, entry.date, entry.memo, entry.currency, entry.sourceDocumentId ?? null],
  );
  const entryId = entryRes.rows[0].id as string;

  for (const l of entry.lines) {
    await tx.query(
      `INSERT INTO journal_lines(client_company_id, entry_id, account_id, debit, credit, description)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [ctx.clientCompanyId, entryId, idByCode.get(l.accountCode), l.debit, l.credit, l.description ?? null],
    );
  }

  // 5. Audit.
  await appendAudit(tx, ctx, {
    action: 'post', entityType: 'journal_entry', entityId: entryId,
    before: null, after: { memo: entry.memo, date: entry.date, lines: entry.lines },
  });

  return { entryId };
}

export async function getEntry(
  tx: PoolClient, _ctx: TenantContext, entryId: string,
): Promise<JournalEntryRow> {
  const e = await tx.query(
    'SELECT id, entry_date, memo, currency FROM journal_entries WHERE id = $1', [entryId],
  );
  if (!e.rowCount) throw new Error(`Entry not found: ${entryId}`);
  const lines = await tx.query(
    'SELECT account_id, debit::text, credit::text, description FROM journal_lines WHERE entry_id = $1 ORDER BY id',
    [entryId],
  );
  const row = e.rows[0];
  return {
    id: row.id,
    entryDate: row.entry_date.toISOString().slice(0, 10),
    memo: row.memo,
    currency: row.currency,
    lines: lines.rows.map((l) => ({ accountId: l.account_id, debit: l.debit, credit: l.credit, description: l.description })),
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/ledger/posting.test.ts`
Expected: PASS (all five tests).

- [ ] **Step 6: Commit**

```bash
git add migrations/005_journal.sql src/ledger/posting.ts tests/ledger/posting.test.ts
git commit -m "feat: append-only double-entry posting API"
```

---

## Task 9: Reversing entries (corrections)

**Files:**
- Modify: `src/ledger/posting.ts` (add `reverseEntry`)
- Test: `tests/ledger/reversing.test.ts`

**Interfaces:**
- Consumes: `postEntry`, `getEntry`, `journal_entries.reverses_entry_id`.
- Produces: `reverseEntry(tx, ctx, entryId, memo)` → `{ entryId }` (a new entry with debits/credits swapped, linked via `reverses_entry_id`).

- [ ] **Step 1: Write the failing test — `tests/ledger/reversing.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry, reverseEntry, getEntry } from '../../src/ledger/posting.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('reversing an entry swaps debits and credits', async () => {
  const t = await makeFirmAndClient();
  const original = await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    return postEntry(tx, ctx(t), {
      date: '2026-03-10', memo: 'Sale', currency: 'EUR',
      lines: [
        { accountCode: '2310', debit: '121.00', credit: '0' },
        { accountCode: '6110', debit: '0', credit: '121.00' },
      ],
    });
  });

  const reversal = await withTenant(ctx(t), (tx) =>
    reverseEntry(tx, ctx(t), original.entryId, 'Reverse sale'));

  const rev = await withTenant(ctx(t), (tx) => getEntry(tx, ctx(t), reversal.entryId));
  // Line that was a 121.00 debit is now a 121.00 credit.
  const debitLine = rev.lines.find((l) => l.credit === '121.00');
  expect(debitLine).toBeDefined();
  expect(rev.lines.every((l) => (l.debit === '0.00') !== (l.credit === '0.00'))).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/ledger/reversing.test.ts`
Expected: FAIL — `reverseEntry` is not exported.

- [ ] **Step 3: Add `reverseEntry` to `src/ledger/posting.ts`**

Add these imports/uses (append to the file):

```ts
export async function reverseEntry(
  tx: PoolClient, ctx: TenantContext, entryId: string, memo: string,
): Promise<{ entryId: string }> {
  // Read the original entry + its lines (with account codes).
  const orig = await tx.query(
    'SELECT entry_date, currency FROM journal_entries WHERE id = $1', [entryId],
  );
  if (!orig.rowCount) throw new Error(`Entry not found: ${entryId}`);
  const lines = await tx.query(
    `SELECT a.code AS "accountCode", jl.debit::text AS debit, jl.credit::text AS credit, jl.description
     FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
     WHERE jl.entry_id = $1 ORDER BY jl.id`,
    [entryId],
  );

  // Build a swapped entry and post it via the same validated path.
  const swapped: NewJournalEntry = {
    date: orig.rows[0].entry_date.toISOString().slice(0, 10),
    memo,
    currency: orig.rows[0].currency,
    lines: lines.rows.map((l) => ({
      accountCode: l.accountCode, debit: l.credit, credit: l.debit, description: l.description ?? undefined,
    })),
  };
  const posted = await postEntry(tx, ctx, swapped);

  // Link the reversal to the original.
  await tx.query('UPDATE journal_entries SET reverses_entry_id = $1 WHERE id = $2', [entryId, posted.entryId]);
  return posted;
}
```

> Note: the `UPDATE` above sets `reverses_entry_id` on the *newly created* reversal row. The append-only trigger forbids UPDATE on `journal_entries`. To allow this one controlled field to be set at creation, pass `reverses_entry_id` into the INSERT instead. **Correct approach:** add an optional `reversesEntryId` to `postEntry`'s insert rather than a post-hoc UPDATE. See Step 4.

- [ ] **Step 4: Fix `postEntry` to accept `reversesEntryId` at insert time (avoids the append-only trigger)**

In `src/ledger/posting.ts`, extend `NewJournalEntry` and the INSERT:

```ts
// add to NewJournalEntry interface:
//   reversesEntryId?: string | null;

// in entrySchema add:
//   reversesEntryId: z.string().uuid().nullable().optional(),

// change the journal_entries INSERT to:
const entryRes = await tx.query(
  `INSERT INTO journal_entries(client_company_id, entry_date, memo, currency, source_document_id, reverses_entry_id)
   VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
  [ctx.clientCompanyId, entry.date, entry.memo, entry.currency, entry.sourceDocumentId ?? null, entry.reversesEntryId ?? null],
);
```

Then simplify `reverseEntry` to pass `reversesEntryId` into `postEntry` and drop the post-hoc UPDATE:

```ts
const posted = await postEntry(tx, ctx, { ...swapped, reversesEntryId: entryId });
return posted;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/ledger/reversing.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite to confirm nothing regressed**

Run: `npx vitest run`
Expected: PASS (all files).

- [ ] **Step 7: Commit**

```bash
git add src/ledger/posting.ts tests/ledger/reversing.test.ts
git commit -m "feat: reversing entries for corrections"
```

---

## Task 10: Trial balance

**Files:**
- Create: `src/ledger/balances.ts`
- Test: `tests/ledger/balances.test.ts`

**Interfaces:**
- Consumes: `journal_lines`, `accounts`, `withTenant`.
- Produces: `trialBalance(tx, ctx)` → `{ code, name, debit, credit, balance }[]`.

- [ ] **Step 1: Write the failing test — `tests/ledger/balances.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { trialBalance } from '../../src/ledger/balances.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('trial balance aggregates debits and credits per account and totals net to zero', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    await postEntry(tx, ctx(t), {
      date: '2026-03-10', memo: 'Sale', currency: 'EUR',
      lines: [
        { accountCode: '2310', debit: '121.00', credit: '0' },
        { accountCode: '6110', debit: '0', credit: '121.00' },
      ],
    });
  });

  const tb = await withTenant(ctx(t), (tx) => trialBalance(tx, ctx(t)));
  const bank = tb.find((r) => r.code === '2310')!;
  const sales = tb.find((r) => r.code === '6110')!;
  expect(bank.debit).toBe('121.00');
  expect(sales.credit).toBe('121.00');
  const totalDebit = tb.reduce((a, r) => a + Number(r.debit), 0);
  const totalCredit = tb.reduce((a, r) => a + Number(r.credit), 0);
  expect(totalDebit).toBe(totalCredit);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/ledger/balances.test.ts`
Expected: FAIL — `src/ledger/balances.js` missing.

- [ ] **Step 3: Create `src/ledger/balances.ts`**

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export interface TrialBalanceRow { code: string; name: string; debit: string; credit: string; balance: string; }

export async function trialBalance(tx: PoolClient, _ctx: TenantContext): Promise<TrialBalanceRow[]> {
  const res = await tx.query(`
    SELECT a.code, a.name,
           COALESCE(SUM(jl.debit), 0)::text  AS debit,
           COALESCE(SUM(jl.credit), 0)::text AS credit,
           (COALESCE(SUM(jl.debit),0) - COALESCE(SUM(jl.credit),0))::text AS balance
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl.account_id = a.id
    GROUP BY a.code, a.name
    ORDER BY a.code
  `);
  return res.rows;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/ledger/balances.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/ledger/balances.ts tests/ledger/balances.test.ts
git commit -m "feat: trial balance report"
```

---

## Self-review

**Spec coverage (against the MVP design §2, §3, §7):**
- Multi-tenancy (Firm→Client, RLS) → Tasks 2, 3. ✓
- Chart of Accounts (Latvian, per-client) → Task 4 (the Latvian default *seed data* is a later data task, noted below). ✓ structure
- Double-entry journal + posting API, balance enforced → Task 8. ✓
- Append-only journal, corrections as reversing entries → Tasks 8 (trigger) + 9. ✓
- Accounting periods / period close → Task 5. ✓
- Multi-currency → journal carries `currency`; FX-difference *postings* are a later tax/ledger task (not MVP-foundation). ✓ structure
- Audit log over every mutation → Task 7 + wired into Task 8. ✓
- Money as NUMERIC/cents, never float → Task 6 + `numeric(18,2)` columns. ✓

**Deliberately deferred (belong to later plans, not this foundation):** the seeded Latvian standard chart of accounts (data, needs the accountant input from spec §10), FX revaluation postings, and the domain event/notification hooks other modules will subscribe to. These do not block the foundation and are called out here so they aren't mistaken for gaps.

**Placeholder scan:** no TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `TenantContext`, `withTenant`, `postEntry`/`reverseEntry`/`getEntry`, `NewJournalEntry`/`NewJournalLine`, `toCents`/`sumCents`, `appendAudit`, `periodStatusFor` are used with identical signatures across tasks. `postEntry` gains `reversesEntryId` in Task 9 as an optional field (backward compatible with Task 8 callers). ✓

**Note on migration numbering:** journal is `005_`, audit is `006_`; the runner applies by filename order, and neither migration references the other's tables, so build/task order (audit before journal) is independent of file order. ✓
