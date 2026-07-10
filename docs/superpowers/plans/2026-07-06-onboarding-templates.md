# Onboarding Templates + Add-Client (G4 Slice 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the firm administrator snapshot an existing client's setup (chart of accounts + autonomy policies + tariff) into a reusable named template, and add a new client that is seeded from a chosen template on creation.

**Architecture:** A firm-scoped `onboarding_templates` table (no RLS, `jsonb` body). A `src/onboarding/templates.ts` domain: `snapshotClientAsTemplate` (reads a client's setup inside `withTenant`, stores the body, audited), firm-scoped `listTemplatesForFirm`/`getTemplateBody`, and `createClientFromTemplate` (creates the client, auto-assigns the creator, applies the body inside `withTenant`). Admin routes `POST /api/admin/clients` and `GET/POST /api/admin/templates`. Admin UI: an Add-client form + a Templates section.

**Tech Stack:** TypeScript (NodeNext), Postgres via `pg` (jsonb), Vitest (real Postgres), Next.js 16 (App Router, `--webpack`), React 19, CSS modules.

## Global Constraints

- **Money** as integer-cents strings inside the JSON body; never floats.
- **Domain** in `src/<module>/`; per-client mutations take `(tx, ctx, …)` and call `appendAudit`. Firm-scoped reads/writes use `appPool` directly (like `listClientCompaniesForFirm`) — no `ctx`, no RLS.
- **`onboarding_templates` has NO RLS** by design (firm-admin cross-client data); correctness relies on the `firm_id` filter in every path. Grants `SELECT, INSERT` (no UPDATE/DELETE). App DB role `bookkeeping_app`.
- **Admin API pattern** (mirror `web/app/api/admin/tariffs/route.ts` from slice 1): `getSessionToken()` → `validateSession(token, nowUnix())` → role gate → firm-scoped domain call. Map caught errors with `errorToStatus` from `@/app/lib/authz` (401 no-token first). NOT the per-client `resolveTenantContext` pattern.
- **Authorization:** reads = `accountant` OR `firm_admin`; writes (create client, save template) = `firm_admin` only.
- **i18n:** every user-facing string in EN AND LV AND RU in `web/app/lib/i18n.ts` (typed `Record<keyof typeof EN>` — missing key fails the build). No tracked-uppercase labels.
- **Tests:** Vitest against real Postgres (`docker compose up -d` first). ⚠️ **Never run two vitest processes at once** — the suite DROPs/recreates the shared schema; concurrent runs corrupt each other.
- **Verify gates:** `npm test` (root) + `npx tsc --noEmit` in root AND `web/` + `npm run build` in `web/`.
- **Commit trailer:** end each commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Branch:** work in-place on `main` (user-authorized for this repo).

## Reused signatures (already in the codebase — do not redefine)

- `createClientCompany(firmId, { name, regNo, baseCurrency? }): Promise<ClientCompany>` — `src/tenancy/firms.js` (`appPool`). `ClientCompany = { id, firmId, name, regNo, baseCurrency }`.
- `assignUserToClient(userId, clientCompanyId): Promise<void>` — `src/auth/context.js` (`appPool`).
- `listAccounts(tx, ctx): Promise<AccountRow[]>` / `createAccount(tx, ctx, { code, name, type }): Promise<AccountRow>` — `src/ledger/accounts.js`. `AccountRow = { id, code, name, type }`, `type ∈ 'asset'|'liability'|'equity'|'income'|'expense'`.
- `listAutonomyPolicies(tx, ctx): Promise<AutonomyPolicyRow[]>` / `setAutonomy(tx, ctx, { operationType, mode, materialThresholdCents? })` — `src/autonomy/autonomy.js`. `AutonomyPolicyRow = { operationType, mode, materialThresholdCents /* string */ }`, `mode ∈ 'auto'|'approval'`.
- `getCurrentTariff(tx, ctx, asOf): Promise<TariffRow | null>` / `setTariff(tx, ctx, { monthlyAmountCents /* bigint */, currency, vatRate, effectiveFrom })` — `src/tariffs/tariffs.js`. `TariffRow = { id, clientCompanyId, monthlyAmountCents /* string */, currency, vatRate, effectiveFrom }`.
- `appendAudit(tx, ctx, { action, entityType, entityId, before, after })` — `src/audit/audit.js`.
- `withTenant(ctx, fn)` / `appPool` — `src/db/pool.js`.

---

### Task 1: Migration + domain + tests

**Files:**
- Create: `migrations/024_onboarding_templates.sql`
- Create: `src/onboarding/templates.ts`
- Test: `tests/onboarding/templates.test.ts`

**Interfaces:**
- Produces:
  - types `TemplateBody`, `TemplateSummary`.
  - `snapshotClientAsTemplate(tx, ctx, name: string): Promise<{ id: string }>`
  - `listTemplatesForFirm(firmId: string): Promise<TemplateSummary[]>`
  - `getTemplateBody(firmId: string, id: string): Promise<TemplateBody | null>`
  - `createClientFromTemplate(firmId: string, input: { name: string; regNo: string; baseCurrency?: string }, templateId: string | null, actorId: string): Promise<ClientCompany>`

- [ ] **Step 1: Write the migration**

Create `migrations/024_onboarding_templates.sql`:

```sql
-- Client-onboarding templates (G4 slice 2). Firm-admin managed, cross-client:
-- NO row-level security — every access path filters by firm_id.
CREATE TABLE onboarding_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id     uuid NOT NULL REFERENCES firms(id),
  name        text NOT NULL,
  body        jsonb NOT NULL,   -- { accounts:[{code,name,type}], autonomy:[{operationType,mode,materialThresholdCents}], tariff:{monthlyAmountCents,currency,vatRate}|null }
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  UNIQUE (firm_id, name)
);
CREATE INDEX onboarding_templates_firm_idx ON onboarding_templates(firm_id);

GRANT SELECT, INSERT ON onboarding_templates TO bookkeeping_app;
```

- [ ] **Step 2: Write the failing test**

Create `tests/onboarding/templates.test.ts`:

```ts
import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { setAutonomy } from '../../src/autonomy/autonomy.js';
import { setTariff } from '../../src/tariffs/tariffs.js';
import { listAccounts } from '../../src/ledger/accounts.js';
import { listAutonomyPolicies } from '../../src/autonomy/autonomy.js';
import { getCurrentTariff } from '../../src/tariffs/tariffs.js';
import {
  snapshotClientAsTemplate, listTemplatesForFirm, getTemplateBody, createClientFromTemplate,
} from '../../src/onboarding/templates.js';
import { appPool } from '../../src/db/pool.js';
import { randomUUID } from 'node:crypto';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

// Seed a source client with 2 accounts, 1 autonomy policy, 1 tariff.
async function seedSource(t: { firmId: string; clientCompanyId: string }) {
  const c = ctx(t);
  await withTenant(c, async (tx) => {
    await createAccount(tx, c, { code: '2310', name: 'Payables', type: 'liability' });
    await createAccount(tx, c, { code: '6110', name: 'Purchases', type: 'expense' });
    await setAutonomy(tx, c, { operationType: 'posting', mode: 'approval', materialThresholdCents: 100000n });
    await setTariff(tx, c, { monthlyAmountCents: 150000n, currency: 'EUR', vatRate: '21', effectiveFrom: '2026-01-01' });
  });
  return c;
}

test('snapshotClientAsTemplate captures accounts + autonomy + tariff into the body', async () => {
  const t = await makeFirmAndClient();
  const c = await seedSource(t);
  const { id } = await withTenant(c, (tx) => snapshotClientAsTemplate(tx, c, 'Standard SIA'));
  expect(id).toBeTruthy();
  const body = await getTemplateBody(t.firmId, id);
  expect(body!.accounts.length).toBe(2);
  expect(body!.accounts.map((a) => a.code).sort()).toEqual(['2310', '6110']);
  expect(body!.autonomy.length).toBe(1);
  expect(body!.autonomy[0]!.operationType).toBe('posting');
  expect(body!.tariff?.monthlyAmountCents).toBe('150000');
});

test('createClientFromTemplate seeds the new client and assigns the creator', async () => {
  const t = await makeFirmAndClient();
  const c = await seedSource(t);
  const { id: templateId } = await withTenant(c, (tx) => snapshotClientAsTemplate(tx, c, 'Standard SIA'));
  const actorId = randomUUID();
  const created = await createClientFromTemplate(
    t.firmId, { name: 'New SIA', regNo: '40199999999', baseCurrency: 'EUR' }, templateId, actorId,
  );
  const nctx = { firmId: t.firmId, clientCompanyId: created.id, actorId, actorRole: 'firm_admin' };
  const accounts = await withTenant(nctx, (tx) => listAccounts(tx, nctx));
  expect(accounts.map((a) => a.code).sort()).toEqual(['2310', '6110']);
  const pol = await withTenant(nctx, (tx) => listAutonomyPolicies(tx, nctx));
  expect(pol.length).toBe(1);
  const tar = await withTenant(nctx, (tx) => getCurrentTariff(tx, nctx, '2026-07-01'));
  expect(tar?.monthlyAmountCents).toBe('150000');
  const assigned = await appPool.query(
    'SELECT 1 FROM user_client_assignments WHERE user_id = $1 AND client_company_id = $2',
    [actorId, created.id],
  );
  expect(assigned.rowCount).toBe(1);
});

test('createClientFromTemplate with null template makes a bare client (creator assigned, no accounts)', async () => {
  const t = await makeFirmAndClient();
  const actorId = randomUUID();
  const created = await createClientFromTemplate(
    t.firmId, { name: 'Bare SIA', regNo: '40188888888' }, null, actorId,
  );
  const nctx = { firmId: t.firmId, clientCompanyId: created.id, actorId, actorRole: 'firm_admin' };
  const accounts = await withTenant(nctx, (tx) => listAccounts(tx, nctx));
  expect(accounts.length).toBe(0);
  const assigned = await appPool.query(
    'SELECT 1 FROM user_client_assignments WHERE user_id = $1 AND client_company_id = $2',
    [actorId, created.id],
  );
  expect(assigned.rowCount).toBe(1);
});

test('getTemplateBody / listTemplatesForFirm are firm-scoped', async () => {
  const a = await makeFirmAndClient('A client');
  const b = await makeFirmAndClient('B client'); // different firm
  const ca = await seedSource(a);
  const { id } = await withTenant(ca, (tx) => snapshotClientAsTemplate(tx, ca, 'A template'));
  // firm B cannot read firm A's template
  expect(await getTemplateBody(b.firmId, id)).toBeNull();
  expect((await listTemplatesForFirm(b.firmId)).length).toBe(0);
  const listA = await listTemplatesForFirm(a.firmId);
  expect(listA.length).toBe(1);
  expect(listA[0]!.accountCount).toBe(2);
  expect(listA[0]!.hasTariff).toBe(true);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/onboarding/templates.test.ts`
Expected: FAIL — cannot resolve `../../src/onboarding/templates.js`.

- [ ] **Step 4: Write the implementation**

Create `src/onboarding/templates.ts`:

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appPool, withTenant } from '../db/pool.js';
import { appendAudit } from '../audit/audit.js';
import { createClientCompany, type ClientCompany } from '../tenancy/firms.js';
import { assignUserToClient } from '../auth/context.js';
import { listAccounts, createAccount, type AccountType } from '../ledger/accounts.js';
import { listAutonomyPolicies, setAutonomy, type AutonomyMode } from '../autonomy/autonomy.js';
import { getCurrentTariff, setTariff } from '../tariffs/tariffs.js';

export interface TemplateAccount { code: string; name: string; type: AccountType }
export interface TemplateAutonomy { operationType: string; mode: AutonomyMode; materialThresholdCents: string }
export interface TemplateTariff { monthlyAmountCents: string; currency: string; vatRate: string }
export interface TemplateBody {
  accounts: TemplateAccount[];
  autonomy: TemplateAutonomy[];
  tariff: TemplateTariff | null;
}
export interface TemplateSummary {
  id: string; name: string; accountCount: number; policyCount: number; hasTariff: boolean;
}

const SNAPSHOT_ASOF = '9999-12-31'; // reading: capture the client's latest current tariff
// applying: date the seeded tariff far in the past so it is immediately "current" for the new client.
const ONBOARDING_TARIFF_EFFECTIVE_FROM = '2000-01-01';

/** Capture a client's accounts + autonomy + current tariff into a named firm template. Audited. */
export async function snapshotClientAsTemplate(
  tx: PoolClient, ctx: TenantContext, name: string,
): Promise<{ id: string }> {
  const accounts = (await listAccounts(tx, ctx)).map((a) => ({ code: a.code, name: a.name, type: a.type }));
  const autonomy = (await listAutonomyPolicies(tx, ctx)).map((p) => ({
    operationType: p.operationType, mode: p.mode, materialThresholdCents: p.materialThresholdCents,
  }));
  const t = await getCurrentTariff(tx, ctx, SNAPSHOT_ASOF);
  const tariff: TemplateTariff | null = t
    ? { monthlyAmountCents: t.monthlyAmountCents, currency: t.currency, vatRate: t.vatRate }
    : null;
  const body: TemplateBody = { accounts, autonomy, tariff };

  const res = await tx.query(
    `INSERT INTO onboarding_templates(firm_id, name, body, created_by)
     VALUES ($1,$2,$3::jsonb,$4) RETURNING id`,
    [ctx.firmId, name, JSON.stringify(body), ctx.actorId],
  );
  const id = res.rows[0].id as string;
  await appendAudit(tx, ctx, {
    action: 'snapshot', entityType: 'onboarding_template', entityId: id,
    before: null, after: { name, accounts: accounts.length, autonomy: autonomy.length, hasTariff: tariff !== null },
  });
  return { id };
}

/** One summary row per template in the firm. Firm-scoped, no RLS. */
export async function listTemplatesForFirm(firmId: string): Promise<TemplateSummary[]> {
  const res = await appPool.query(
    `SELECT id, name,
            COALESCE(jsonb_array_length(body->'accounts'), 0) AS "accountCount",
            COALESCE(jsonb_array_length(body->'autonomy'), 0) AS "policyCount",
            (body->'tariff') IS NOT NULL AND (body->'tariff') <> 'null'::jsonb AS "hasTariff"
     FROM onboarding_templates WHERE firm_id = $1 ORDER BY name ASC`,
    [firmId],
  );
  return res.rows.map((r) => ({
    id: r.id, name: r.name,
    accountCount: Number(r.accountCount), policyCount: Number(r.policyCount), hasTariff: r.hasTariff,
  }));
}

/** Fetch one template's body, firm-scoped. Null if absent or in another firm. */
export async function getTemplateBody(firmId: string, id: string): Promise<TemplateBody | null> {
  const res = await appPool.query(
    `SELECT body FROM onboarding_templates WHERE id = $1 AND firm_id = $2`,
    [id, firmId],
  );
  return res.rows[0] ? (res.rows[0].body as TemplateBody) : null;
}

/**
 * Create a client, assign the creator, and (if a template is given) seed the new
 * client's accounts + autonomy + tariff from the template body. Audited.
 * Throws 'unknown template' if templateId is given but not found in the firm.
 */
export async function createClientFromTemplate(
  firmId: string,
  input: { name: string; regNo: string; baseCurrency?: string },
  templateId: string | null,
  actorId: string,
): Promise<ClientCompany> {
  const body = templateId ? await getTemplateBody(firmId, templateId) : null;
  if (templateId && !body) throw new Error('unknown template');

  const client = await createClientCompany(firmId, input);
  await assignUserToClient(actorId, client.id);

  if (body) {
    const ctx: TenantContext = { firmId, clientCompanyId: client.id, actorId, actorRole: 'firm_admin' };
    await withTenant(ctx, async (tx) => {
      for (const a of body.accounts) await createAccount(tx, ctx, a);
      for (const p of body.autonomy) {
        await setAutonomy(tx, ctx, {
          operationType: p.operationType, mode: p.mode, materialThresholdCents: BigInt(p.materialThresholdCents),
        });
      }
      if (body.tariff) {
        await setTariff(tx, ctx, {
          monthlyAmountCents: BigInt(body.tariff.monthlyAmountCents),
          currency: body.tariff.currency, vatRate: body.tariff.vatRate,
          effectiveFrom: ONBOARDING_TARIFF_EFFECTIVE_FROM,
        });
      }
      await appendAudit(tx, ctx, {
        action: 'create_from_template', entityType: 'client_company', entityId: client.id,
        before: null, after: { templateId },
      });
    });
  }
  return client;
}
```

Note: the seeded tariff's `effective_from` is the fixed early constant `ONBOARDING_TARIFF_EFFECTIVE_FROM` (`2000-01-01`) so the applied tariff is immediately "current" for the new client at any `asOf` (and the test is deterministic — no wall clock). Accounts are created fresh on an empty client, so no conflict handling is needed.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/onboarding/templates.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add migrations/024_onboarding_templates.sql src/onboarding/templates.ts tests/onboarding/templates.test.ts
git commit -m "feat: onboarding_templates table + snapshot/apply domain (G4 slice 2)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Templates API routes

**Files:**
- Create: `web/app/api/admin/templates/route.ts`

**Interfaces:**
- Consumes: `validateSession` (`@domain/auth/sessions.js`); `listTemplatesForFirm`, `snapshotClientAsTemplate` (`@domain/onboarding/templates.js`); `withTenant`, `appPool` (`@domain/db/pool.js`); `getSessionToken`, `nowUnix` (`@/app/lib/session`); `errorToStatus` (`@/app/lib/authz`); `TenantContext` (`@domain/tenancy/context.js`).
- Produces: `GET /api/admin/templates` → `{ templates, role }`; `POST /api/admin/templates` → `{ id }` (201).

- [ ] **Step 1: Create the route**

Create `web/app/api/admin/templates/route.ts`:

```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { validateSession } from '@domain/auth/sessions.js';
import { listTemplatesForFirm, snapshotClientAsTemplate } from '@domain/onboarding/templates.js';
import { withTenant, appPool } from '@domain/db/pool.js';
import type { TenantContext } from '@domain/tenancy/context.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { errorToStatus } from '@/app/lib/authz';

export async function GET() {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const session = await validateSession(token, nowUnix());
  if (!session) return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
  if (session.role !== 'accountant' && session.role !== 'firm_admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const templates = await listTemplatesForFirm(session.firmId);
  return NextResponse.json({ templates, role: session.role }, { status: 200 });
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const session = await validateSession(token, nowUnix());
  if (!session) return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
  if (session.role !== 'firm_admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string; name?: string };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.name?.trim()) return NextResponse.json({ error: 'missing name' }, { status: 400 });

  try {
    const check = await appPool.query(
      `SELECT 1 FROM client_companies WHERE id = $1 AND firm_id = $2`,
      [body.clientCompanyId, session.firmId],
    );
    if (!check.rowCount) return NextResponse.json({ error: 'client not in firm' }, { status: 403 });

    const ctx: TenantContext = {
      firmId: session.firmId, clientCompanyId: body.clientCompanyId,
      actorId: session.userId, actorRole: session.role,
    };
    const result = await withTenant(ctx, (tx) => snapshotClientAsTemplate(tx, ctx, body.name!.trim()));
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: HTTP smoke (accountant side + no-cookie; dev server on :3000)**

```bash
J=/Users/karlis/.claude/jobs/5ea66caa/tmp
AT=$(curl -s -c - "http://localhost:3000/api/dev/bootstrap" -o /dev/null | grep bk_session | awk '{print $7}')
CID=$(curl -s -b "bk_session=$AT" "http://localhost:3000/api/admin/clients" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).clients[0].id))")
curl -s -o /dev/null -w "accountant GET templates: %{http_code}\n" -b "bk_session=$AT" "http://localhost:3000/api/admin/templates"     # expect 200
curl -s -o /dev/null -w "accountant POST template: %{http_code}\n" -b "bk_session=$AT" -X POST "http://localhost:3000/api/admin/templates" -H 'content-type: application/json' -d "{\"clientCompanyId\":\"$CID\",\"name\":\"X\"}"  # expect 403
curl -s -o /dev/null -w "no-cookie GET: %{http_code}\n" "http://localhost:3000/api/admin/templates"   # expect 401
```
(The firm_admin 201 snapshot path is exercised by the controller in Task 5 with a minted firm_admin.)

- [ ] **Step 4: Commit**

```bash
git add web/app/api/admin/templates/route.ts
git commit -m "feat(web): GET/POST /api/admin/templates (G4 slice 2)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Add-client route (POST /api/admin/clients)

**Files:**
- Modify: `web/app/api/admin/clients/route.ts` (add a `POST` handler alongside the existing `GET`)

**Interfaces:**
- Consumes: `createClientFromTemplate` (`@domain/onboarding/templates.js`); existing imports in the file; `errorToStatus` (`@/app/lib/authz`); `NextRequest`.
- Produces: `POST /api/admin/clients` → `{ client }` (201).

- [ ] **Step 1: Add the POST handler**

Read `web/app/api/admin/clients/route.ts` first (it currently exports only `GET` using `validateSession`). Add these imports at the top (keep existing ones):

```ts
import { NextRequest } from 'next/server';
import { createClientFromTemplate } from '@domain/onboarding/templates.js';
import { errorToStatus } from '@/app/lib/authz';
```

Then add this `POST` handler after the existing `GET`:

```ts
export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const session = await validateSession(token, nowUnix());
  if (!session) return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
  if (session.role !== 'firm_admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    name?: string; regNo?: string; baseCurrency?: string; templateId?: string | null;
  };
  if (!body.name?.trim()) return NextResponse.json({ error: 'missing name' }, { status: 400 });
  if (!body.regNo?.trim()) return NextResponse.json({ error: 'missing regNo' }, { status: 400 });
  const currency = (body.baseCurrency ?? 'EUR').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return NextResponse.json({ error: 'invalid baseCurrency' }, { status: 400 });

  try {
    const client = await createClientFromTemplate(
      session.firmId,
      { name: body.name.trim(), regNo: body.regNo.trim(), baseCurrency: currency },
      body.templateId ?? null,
      session.userId,
    );
    return NextResponse.json({ client }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
```

(If `NextResponse`/`getSessionToken`/`validateSession`/`nowUnix` are already imported for the `GET`, do not duplicate them — only add what's missing: `NextRequest`, `createClientFromTemplate`, `errorToStatus`.)

- [ ] **Step 2: Verify typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: HTTP smoke (accountant + no-cookie)**

```bash
J=/Users/karlis/.claude/jobs/5ea66caa/tmp
AT=$(curl -s -c - "http://localhost:3000/api/dev/bootstrap" -o /dev/null | grep bk_session | awk '{print $7}')
curl -s -o /dev/null -w "accountant POST client: %{http_code}\n" -b "bk_session=$AT" -X POST "http://localhost:3000/api/admin/clients" -H 'content-type: application/json' -d "{\"name\":\"Smoke SIA\",\"regNo\":\"40177777777\"}"  # expect 403
curl -s -o /dev/null -w "no-cookie POST: %{http_code}\n" -X POST "http://localhost:3000/api/admin/clients" -H 'content-type: application/json' -d "{\"name\":\"X\",\"regNo\":\"1\"}"  # expect 401
```
(firm_admin 201 create + create-with-template verified by the controller in Task 5.)

- [ ] **Step 4: Commit**

```bash
git add web/app/api/admin/clients/route.ts
git commit -m "feat(web): POST /api/admin/clients — create client, optional template (G4 slice 2)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Admin UI — Add-client form + Templates section

**Files:**
- Create: `web/app/components/OnboardingPanel.tsx`
- Create: `web/app/components/OnboardingPanel.module.css`
- Modify: `web/app/(cabinet)/admin/page.tsx` (fetch templates; render `OnboardingPanel`)
- Modify: `web/app/lib/i18n.ts` (admin.onb.* strings in all three catalogs)

**Interfaces:**
- Consumes: `GET /api/admin/templates` (`{ templates, role }`), `POST /api/admin/clients`, `POST /api/admin/templates`; the admin page's existing `clients` list (for the client `<select>`s); `useMessages`.
- Produces: `export function OnboardingPanel({ clients, templates, role, onChanged }: { clients: {id:string;name:string}[]; templates: TemplateSummary[]; role: string; onChanged: () => void })` where `TemplateSummary = { id, name, accountCount, policyCount, hasTariff }`.

- [ ] **Step 1: Add i18n strings**

In `web/app/lib/i18n.ts`, add to **EN** (and LV/RU below), grouped `admin.onb.*`:

EN:
```ts
  'admin.onb.addClient': 'Add client',
  'admin.onb.name': 'Name',
  'admin.onb.regNo': 'Registration no.',
  'admin.onb.currency': 'Currency',
  'admin.onb.template': 'Template',
  'admin.onb.noTemplate': 'None (blank client)',
  'admin.onb.create': 'Create client',
  'admin.onb.templates': 'Onboarding templates',
  'admin.onb.saveAsTemplate': 'Save as template',
  'admin.onb.sourceClient': 'Client to snapshot',
  'admin.onb.templateName': 'Template name',
  'admin.onb.save': 'Save',
  'admin.onb.summary': '{a} accounts · {p} policies · tariff {t}',
  'admin.onb.empty': 'No templates yet.',
  'admin.onb.error': 'Could not complete that action.',
```

LV:
```ts
  'admin.onb.addClient': 'Pievienot klientu',
  'admin.onb.name': 'Nosaukums',
  'admin.onb.regNo': 'Reģ. nr.',
  'admin.onb.currency': 'Valūta',
  'admin.onb.template': 'Veidne',
  'admin.onb.noTemplate': 'Nav (tukšs klients)',
  'admin.onb.create': 'Izveidot klientu',
  'admin.onb.templates': 'Uzsākšanas veidnes',
  'admin.onb.saveAsTemplate': 'Saglabāt kā veidni',
  'admin.onb.sourceClient': 'Klients momentuzņēmumam',
  'admin.onb.templateName': 'Veidnes nosaukums',
  'admin.onb.save': 'Saglabāt',
  'admin.onb.summary': '{a} konti · {p} politikas · tarifs {t}',
  'admin.onb.empty': 'Vēl nav veidņu.',
  'admin.onb.error': 'Neizdevās pabeigt darbību.',
```

RU:
```ts
  'admin.onb.addClient': 'Добавить клиента',
  'admin.onb.name': 'Название',
  'admin.onb.regNo': 'Рег. номер',
  'admin.onb.currency': 'Валюта',
  'admin.onb.template': 'Шаблон',
  'admin.onb.noTemplate': 'Нет (пустой клиент)',
  'admin.onb.create': 'Создать клиента',
  'admin.onb.templates': 'Шаблоны онбординга',
  'admin.onb.saveAsTemplate': 'Сохранить как шаблон',
  'admin.onb.sourceClient': 'Клиент для снимка',
  'admin.onb.templateName': 'Название шаблона',
  'admin.onb.save': 'Сохранить',
  'admin.onb.summary': '{a} счетов · {p} политик · тариф {t}',
  'admin.onb.empty': 'Шаблонов пока нет.',
  'admin.onb.error': 'Не удалось выполнить действие.',
```

- [ ] **Step 2: Create OnboardingPanel.module.css**

Create `web/app/components/OnboardingPanel.module.css`:

```css
.section { margin-top: var(--space-6); }
.heading { font-size: 1rem; font-weight: 600; margin: 0 0 var(--space-3); }
.form { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: end; margin-bottom: var(--space-4); }
.field { display: flex; flex-direction: column; gap: var(--space-1); font-size: 0.8rem; }
.field input, .field select { padding: var(--space-1) var(--space-2); border: 1px solid var(--border); border-radius: var(--radius-sm); }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.item { display: flex; justify-content: space-between; gap: var(--space-3); padding: var(--space-2) 0; border-bottom: 1px solid var(--border); }
.muted { color: var(--ink-soft); font-size: 0.85rem; }
.error { color: var(--danger); font-size: 0.8rem; margin: var(--space-2) 0 0; }
```

- [ ] **Step 3: Create OnboardingPanel.tsx**

Create `web/app/components/OnboardingPanel.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useMessages } from '@/app/lib/i18n-context';
import styles from './OnboardingPanel.module.css';

export interface TemplateSummary {
  id: string; name: string; accountCount: number; policyCount: number; hasTariff: boolean;
}

interface OnboardingPanelProps {
  clients: { id: string; name: string }[];
  templates: TemplateSummary[];
  role: string;
  onChanged: () => void;
}

export function OnboardingPanel({ clients, templates, role, onChanged }: OnboardingPanelProps) {
  const { t } = useMessages();
  if (role !== 'firm_admin') {
    // Accountant: read-only template list only.
    return <TemplatesList templates={templates} />;
  }
  return (
    <>
      <AddClientForm templates={templates} onChanged={onChanged} />
      <SaveTemplateForm clients={clients} onChanged={onChanged} />
      <TemplatesList templates={templates} />
    </>
  );
}

function TemplatesList({ templates }: { templates: TemplateSummary[] }) {
  const { t } = useMessages();
  return (
    <section className={styles.section} aria-labelledby="onb-templates-heading">
      <h2 id="onb-templates-heading" className={styles.heading}>{t('admin.onb.templates')}</h2>
      {templates.length === 0 ? (
        <p className={styles.muted}>{t('admin.onb.empty')}</p>
      ) : (
        <ul className={styles.list}>
          {templates.map((tpl) => (
            <li key={tpl.id} className={styles.item}>
              <span>{tpl.name}</span>
              <span className={styles.muted}>
                {t('admin.onb.summary')
                  .replace('{a}', String(tpl.accountCount))
                  .replace('{p}', String(tpl.policyCount))
                  .replace('{t}', tpl.hasTariff ? '✓' : '–')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AddClientForm({ templates, onChanged }: { templates: TemplateSummary[]; onChanged: () => void }) {
  const { t } = useMessages();
  const [name, setName] = useState('');
  const [regNo, setRegNo] = useState('');
  const [currency, setCurrency] = useState('EUR');
  const [templateId, setTemplateId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function submit() {
    if (!name.trim() || !regNo.trim()) { setError(true); return; }
    setBusy(true); setError(false);
    try {
      const res = await fetch('/api/admin/clients', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, regNo, baseCurrency: currency, templateId: templateId || null }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setName(''); setRegNo(''); setTemplateId('');
      onChanged();
    } catch { setError(true); } finally { setBusy(false); }
  }

  return (
    <section className={styles.section} aria-labelledby="onb-add-heading">
      <h2 id="onb-add-heading" className={styles.heading}>{t('admin.onb.addClient')}</h2>
      <div className={styles.form}>
        <label className={styles.field}>{t('admin.onb.name')}
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className={styles.field}>{t('admin.onb.regNo')}
          <input value={regNo} onChange={(e) => setRegNo(e.target.value)} />
        </label>
        <label className={styles.field}>{t('admin.onb.currency')}
          <input value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
        </label>
        <label className={styles.field}>{t('admin.onb.template')}
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            <option value="">{t('admin.onb.noTemplate')}</option>
            {templates.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name}</option>)}
          </select>
        </label>
        <button type="button" onClick={submit} disabled={busy}>{t('admin.onb.create')}</button>
      </div>
      {error && <p className={styles.error} role="alert">{t('admin.onb.error')}</p>}
    </section>
  );
}

function SaveTemplateForm({ clients, onChanged }: { clients: { id: string; name: string }[]; onChanged: () => void }) {
  const { t } = useMessages();
  const [clientCompanyId, setClientCompanyId] = useState(clients[0]?.id ?? '');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function submit() {
    if (!clientCompanyId || !name.trim()) { setError(true); return; }
    setBusy(true); setError(false);
    try {
      const res = await fetch('/api/admin/templates', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientCompanyId, name }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setName('');
      onChanged();
    } catch { setError(true); } finally { setBusy(false); }
  }

  return (
    <section className={styles.section} aria-labelledby="onb-save-heading">
      <h2 id="onb-save-heading" className={styles.heading}>{t('admin.onb.saveAsTemplate')}</h2>
      <div className={styles.form}>
        <label className={styles.field}>{t('admin.onb.sourceClient')}
          <select value={clientCompanyId} onChange={(e) => setClientCompanyId(e.target.value)}>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className={styles.field}>{t('admin.onb.templateName')}
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button type="button" onClick={submit} disabled={busy}>{t('admin.onb.save')}</button>
      </div>
      {error && <p className={styles.error} role="alert">{t('admin.onb.error')}</p>}
    </section>
  );
}
```

(Token names verified in `web/app/globals.css`: `--space-1..8`, `--border`, `--ink-soft`, `--radius-sm`, `--danger`.)

- [ ] **Step 4: Wire into the admin page**

In `web/app/(cabinet)/admin/page.tsx` (read it first; it already fetches clients/users/audit/**tariffs** and gates on 403):
1. Import: `import { OnboardingPanel, type TemplateSummary } from '@/app/components/OnboardingPanel';`
2. Extend `AdminData` with `templates: TemplateSummary[];` (it already has `tariffs`, `role`).
3. Add `fetch('/api/admin/templates')` to the `Promise.all`; fold its 403 into the existing forbidden gate; on non-403 non-ok, throw like the sibling fetches; parse `{ templates }` and include `templates: templatesBody.templates` in `setData`.
4. Render after the tariff table (and inside the `!forbidden && !error && !loading && data` branch):
   ```tsx
   <OnboardingPanel
     clients={data.clients.map((c) => ({ id: c.id, name: c.name }))}
     templates={data.templates}
     role={data.role}
     onChanged={load}
   />
   ```

- [ ] **Step 5: Verify typecheck + build**

Run: `cd web && npx tsc --noEmit && npm run build`
Expected: no errors; build succeeds; `/api/admin/templates` present in the route list.

- [ ] **Step 6: Commit**

```bash
git add web/app/components/OnboardingPanel.tsx web/app/components/OnboardingPanel.module.css web/app/\(cabinet\)/admin/page.tsx web/app/lib/i18n.ts
git commit -m "feat(web): onboarding panel — add-client + save-as-template on /admin (G4 slice 2)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Final verification gates

**Files:** none (verification only).

- [ ] **Step 1: Full backend suite (single vitest process)**

Run: `npm test`
Expected: all green (193 existing + 4 new from Task 1 = 197).

- [ ] **Step 2: Typechecks**

Run: `npx tsc --noEmit` (root) and `cd web && npx tsc --noEmit`
Expected: both clean.

- [ ] **Step 3: Web build**

Run: `cd web && npm run build`
Expected: succeeds; `/api/admin/templates` present.

- [ ] **Step 4: Per-role HTTP smoke (controller mints a firm_admin)**

Confirm (record exact codes): `firm_admin` POST /api/admin/templates (snapshot a seeded client) → 201; `firm_admin` POST /api/admin/clients with that `templateId` → 201, then confirm the new client has the template's accounts (open its cabinet data or query); `firm_admin` POST /api/admin/clients with a bogus `templateId` → 400 `unknown template`; `accountant` POST either → 403; `GET /api/admin/templates` as accountant → 200; cross-firm `clientCompanyId` on snapshot → 403; no cookie → 401.

- [ ] **Step 5: Update the audit-fixes handoff**

In `docs/HANDOFF-audit-fixes.md`, note **G4 slice 2 (onboarding templates + add-client)** shipped; slices 3–4 (invoice/document, notification templates) remain.

- [ ] **Step 6: Commit**

```bash
git add docs/HANDOFF-audit-fixes.md
git commit -m "docs: mark G4 slice 2 (onboarding templates) shipped

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage:** table + jsonb body (Task 1 migration); snapshot captures accounts+autonomy+tariff + audits (Task 1 domain/test); firm-scoped list/get with isolation guard (Task 1 test); create-from-template seeds + auto-assigns creator (Task 1 domain/test); bare-client path (Task 1 test); templates routes read/write role split + firm-scoping (Task 2); add-client route firm_admin-only + unknown-template 400 (Task 3); admin UI add-client + save-as-template + list, firm_admin-gated (Task 4); i18n parity (Task 4). All covered.
- **Types:** `TemplateSummary` re-declared in the web component (Task 4) to match the domain's shape (Task 1) — intentional (web can't import server `pg` types), fields must match. `TemplateBody` only used server-side. `createClientFromTemplate` signature (Task 1) ↔ Task 3 call consistent. `snapshotClientAsTemplate` (Task 1) ↔ Task 2 call consistent.
- **Money:** cents as bigint at the domain edges (`setTariff`/`setAutonomy` take bigint; body stores cents strings; converted via `BigInt(...)` on apply). No floats.
- **No-RLS decision** guarded by the cross-firm `getTemplateBody`/`listTemplatesForFirm` isolation assertions in Task 1's test.
- **`SNAPSHOT_ASOF` (`9999-12-31`) vs seeded `effective_from` (`2000-01-01`):** snapshot reads the client's *latest* current tariff (asOf far future); the applied tariff is dated far past so it's immediately current for the new client. Two distinct constants, intentional.
