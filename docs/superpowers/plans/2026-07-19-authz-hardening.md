# Authz + Error-Handling Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route-level role gating for the remaining ungated mutations, full `errorToStatus` adoption, and every confirmed hobby-release follow-up.

**Architecture:** Five new entries in the central `Operation` matrix (`src/authz/policy.ts`) enforced at routes / shared handlers; a mechanical error-mapping sweep over 12 routes; opportunistic row pruning in the auth domain; small pure helpers (`blobConfigStatus`, `devBootstrapAllowed`) in `src/` so web-layer env logic is testable by the root suite.

**Tech Stack:** TypeScript ESM (`.js` suffixes in `src/`), Next.js 16 routes in `web/`, vitest against real Postgres.

**Spec:** `docs/superpowers/specs/2026-07-19-authz-hardening-design.md` — read it first.

## Global Constraints

- The `Operation` matrix stays mutation-only; admin GET checks stay inline.
- Notifications read/read-all and assistant POST stay ungated (self-scoped) — a one-line comment documents this where each resolves its session/context.
- Error bodies never contain raw `String(e)` from constraint violations; the email-existence oracle (409 on duplicate) is accepted by design.
- Migration number is **036** (current max is 035; never reuse).
- Every user-facing string in all three i18n catalogs (LV/RU/EN); typed record fails the web build on a missing key.
- Gates before done: `npm test` (root), `npx tsc --noEmit` (root), `cd web && npx tsc --noEmit && npm run build` (i18n changes).
- Web routes import domain via `@domain/*`; shared web helpers via `@/app/lib/*`.

---

### Task 1: Operation matrix entries + route/handler gating

**Files:**
- Modify: `src/authz/policy.ts`
- Modify: `src/api/capture-handler.ts` (gate after tenant-context resolution)
- Modify: `web/app/api/tasks/route.ts` (POST), `web/app/api/tasks/[id]/resolve/route.ts` (POST), `web/app/api/tasks/[id]/comments/route.ts` (POST)
- Modify: `web/app/api/admin/clients/route.ts`, `web/app/api/admin/tariffs/route.ts`, `web/app/api/admin/templates/route.ts` (POST inline checks → matrix)
- Modify: `web/app/api/notifications/read-all/route.ts`, `web/app/api/notifications/[id]/read/route.ts`, `web/app/api/assistant/route.ts` (comment only)
- Test: `tests/authz/policy.test.ts`

**Interfaces:**
- Produces: `Operation` union gains `'tasks.write' | 'documents.capture' | 'clients.write' | 'tariffs.write' | 'templates.write'`. Consumed only within this task.

- [ ] **Step 1: Write the failing policy tests**

Append to `tests/authz/policy.test.ts` (mirror its existing assertion style — read the file first):

```ts
test('tasks.write and documents.capture allow all four roles, deny unknown', () => {
  for (const op of ['tasks.write', 'documents.capture'] as const) {
    for (const role of ['firm_admin', 'accountant', 'owner', 'employee']) {
      expect(isRoleAllowed(role, op)).toBe(true);
    }
    expect(isRoleAllowed('agent', op)).toBe(false);
    expect(isRoleAllowed('nonsense', op)).toBe(false);
  }
});

test('admin write ops are firm_admin only', () => {
  for (const op of ['clients.write', 'tariffs.write', 'templates.write'] as const) {
    expect(isRoleAllowed('firm_admin', op)).toBe(true);
    for (const role of ['accountant', 'owner', 'employee', 'nonsense']) {
      expect(isRoleAllowed(role, op)).toBe(false);
    }
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/authz/policy.test.ts`
Expected: FAIL — TS/type errors on the unknown ops (or runtime lookup failure).

- [ ] **Step 3: Add the matrix entries**

In `src/authz/policy.ts`, extend the `Operation` union and `OPERATION_ROLES`:

```ts
  | 'tasks.write' // create/resolve/comment on collab tasks
  | 'documents.capture' // photograph/upload a document for AI intake
  | 'clients.write' // admin: create client companies
  | 'tariffs.write' // admin: manage tariffs
  | 'templates.write'; // admin: manage onboarding templates
```

```ts
  'tasks.write': ['firm_admin', 'accountant', 'owner', 'employee'],
  'documents.capture': ['firm_admin', 'accountant', 'owner', 'employee'],
  'clients.write': ['firm_admin'],
  'tariffs.write': ['firm_admin'],
  'templates.write': ['firm_admin'],
```

(All-roles entries are deliberate: policy explicit in one place; unknown roles denied.)

- [ ] **Step 4: Run policy tests to verify pass**

Run: `npx vitest run tests/authz/policy.test.ts` → PASS.

- [ ] **Step 5: Gate the tasks routes**

In each of `web/app/api/tasks/route.ts` (POST only), `web/app/api/tasks/[id]/resolve/route.ts`, `web/app/api/tasks/[id]/comments/route.ts` (POST only): add `import { assertRoleAllowed } from '@/app/lib/authz';` (merge with an existing authz import if Task 2 has already run — these files also appear there) and, immediately after `const ctx = await resolveTenantContext(...)`:

```ts
    assertRoleAllowed(ctx.actorRole, 'tasks.write');
```

The surrounding `try/catch` already exists in all three; the thrown `forbidden:` message maps to 403 (via Task 2's `errorToStatus`, or the old mapping until then — both yield 403).

- [ ] **Step 6: Gate the shared capture handler**

In `src/api/capture-handler.ts`: find where the handler resolves the tenant context (it mirrors `src/api/handlers.ts` — read both). Immediately after the context is resolved, following the exact pattern of `handlers.ts` lines ~46/64:

```ts
  try { assertRoleAllowed(ctx.actorRole, 'documents.capture'); }
  catch (e) { return { status: 403, body: { error: e instanceof Error ? e.message : 'forbidden' } }; }
```

Adapt the return shape to whatever `handlers.ts` uses for its 403 (copy it exactly — the shared handlers return plain objects, not NextResponse). Import: `import { assertRoleAllowed } from '../authz/policy.js';`

- [ ] **Step 7: Migrate the three admin POST checks to the matrix**

In `web/app/api/admin/clients/route.ts` POST, replace:

```ts
  if (session.role !== 'firm_admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
```

with:

```ts
  if (!isRoleAllowed(session.role, 'clients.write')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
```

and add `isRoleAllowed` to the route's authz import (`import { errorToStatus, isRoleAllowed } from '@/app/lib/authz';` — check `web/app/lib/authz.ts` re-exports `isRoleAllowed` from `@domain/authz/policy.js`; if it doesn't yet, add the re-export there). Apply the identical transform in `admin/tariffs/route.ts` (`'tariffs.write'`) and `admin/templates/route.ts` (`'templates.write'`) — first confirm their POST inline checks have the same `session.role !== 'firm_admin'` shape (they were built together; if one differs, STOP and report the difference). GET checks in all three stay untouched.

- [ ] **Step 8: Document the deliberately-ungated routes**

In `notifications/read-all/route.ts`, `notifications/[id]/read/route.ts`, and `assistant/route.ts`, one comment above the context/session resolution:

```ts
  // Deliberately not role-gated: self-scoped mutation (affects only the caller's own rows).
```

(For assistant: `// Deliberately not role-gated: per-user conversational surface, no direct ledger mutation.`)

- [ ] **Step 9: Typecheck both trees**

Run: `npx tsc --noEmit && (cd web && npx tsc --noEmit)` → clean.

- [ ] **Step 10: Commit**

```bash
git add src/authz src/api tests/authz web/app/api web/app/lib
git commit -m "feat(authz): gate tasks/capture/admin mutations via the Operation matrix (G1)"
```

---

### Task 2: errorToStatus adoption sweep

**Files:**
- Modify (12): `web/app/api/vat-rate/route.ts`, `web/app/api/tasks/route.ts`, `web/app/api/tasks/[id]/comments/route.ts`, `web/app/api/tasks/[id]/resolve/route.ts`, `web/app/api/overview/route.ts`, `web/app/api/vid/deadlines/route.ts`, `web/app/api/bank/transactions/route.ts`, `web/app/api/notifications/route.ts`, `web/app/api/notifications/read-all/route.ts`, `web/app/api/notifications/[id]/read/route.ts`, `web/app/api/audit/route.ts`, `web/app/api/journal/route.ts`

**Interfaces:**
- Consumes: `errorToStatus` from `@/app/lib/authz` (exists).

- [ ] **Step 1: Apply the transform to every catch block in the 12 files**

Each file contains one or more catch blocks of exactly this shape:

```ts
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const httpStatus = /session/i.test(msg) ? 401 : 403;
    return NextResponse.json({ error: msg }, { status: httpStatus });
  }
```

Replace each with:

```ts
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
```

and add `import { errorToStatus } from '@/app/lib/authz';` (merge into the existing authz import where Task 1 already added one). Variable names may differ slightly per file (`err`/`e`); keep each file's name. No other changes.

- [ ] **Step 2: Verify no old mapping remains**

Run: `grep -rln 'session/i' web/app/api --include=route.ts`
Expected: no output.

- [ ] **Step 3: Typecheck web**

Run: `cd web && npx tsc --noEmit` → clean.

- [ ] **Step 4: Commit**

```bash
git add web/app/api
git commit -m "fix(web): adopt shared errorToStatus mapping in the 12 remaining routes (G2)"
```

---

### Task 3: Auth-domain hygiene — login_attempts prune + session sweep

**Files:**
- Modify: `src/auth/rate-limit.ts`, `src/auth/sessions.ts`
- Test: `tests/auth/rate-limit.test.ts`, `tests/auth/sessions.test.ts`

**Interfaces:** no signature changes.

- [ ] **Step 1: Write the failing tests**

Read both existing test files first and mirror their setup (they use `resetDb`/`closeDb` helpers and drive the real DB). Add to `tests/auth/rate-limit.test.ts`:

```ts
test('a failure at exactly the window edge (900s) starts a fresh window', async () => {
  const at = 1_750_000_000;
  const ids = ['email:edge@test.lv'];
  for (let i = 0; i < 5; i++) await recordLoginFailure(ids, at);
  expect(await checkLoginAllowed(ids, at)).toBe(false);
  // exactly WINDOW_SECONDS later the old window no longer blocks
  expect(await checkLoginAllowed(ids, at + 900)).toBe(true);
});

test('identifiers are isolated: locking one email does not lock another', async () => {
  const at = 1_750_000_000;
  for (let i = 0; i < 5; i++) await recordLoginFailure(['email:a@test.lv', 'ip:1.2.3.4'], at);
  expect(await checkLoginAllowed(['email:a@test.lv'], at)).toBe(false);
  expect(await checkLoginAllowed(['ip:1.2.3.4'], at)).toBe(false);   // shared ip locked
  expect(await checkLoginAllowed(['email:b@test.lv'], at)).toBe(true); // other email free
  expect(await checkLoginAllowed(['email:b@test.lv', 'ip:1.2.3.4'], at)).toBe(false); // combined: ip still blocks
});

test('recordLoginFailure prunes rows older than 24h', async () => {
  const old = 1_750_000_000;
  await recordLoginFailure(['email:stale@test.lv'], old);
  await recordLoginFailure(['email:fresh@test.lv'], old + 24 * 3600 + 1);
  const rows = await appPool.query(`SELECT identifier FROM login_attempts ORDER BY identifier`);
  expect(rows.rows.map((r) => r.identifier)).toEqual(['email:fresh@test.lv']);
});
```

Add to `tests/auth/sessions.test.ts`:

```ts
test('successful login sweeps expired session rows', async () => {
  // seed an expired session directly
  await appPool.query(
    `INSERT INTO sessions(token, user_id, expires_at) VALUES ('deadbeef', $1, now() - interval '1 hour')`,
    [userId], // reuse the test file's existing seeded-user variable
  );
  await login(email, password, totpFor(at), at); // reuse the file's existing login helpers
  const gone = await appPool.query(`SELECT 1 FROM sessions WHERE token = 'deadbeef'`);
  expect(gone.rowCount).toBe(0);
});
```

(Adapt the seeded-user/totp helper names to what the file actually uses — read it first; if it has no reusable login fixture, build one the same way its existing success-path test does.)

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run tests/auth/rate-limit.test.ts tests/auth/sessions.test.ts`
Expected: the prune and sweep tests FAIL (rows survive); the 900s/isolation tests may already pass (they pin current behavior — that is fine, note it in the report).

- [ ] **Step 3: Implement the prune**

In `src/auth/rate-limit.ts` `recordLoginFailure`, after the per-identifier loop:

```ts
  // Opportunistic prune: identifiers that never succeed would otherwise grow the
  // table unbounded (attacker-chosen values). 24h keeps a short forensic window;
  // the limiter itself only reads the last WINDOW_SECONDS.
  await appPool.query(
    `DELETE FROM login_attempts WHERE EXTRACT(EPOCH FROM window_start) < $1::bigint - 86400`,
    [atUnixSeconds],
  );
```

- [ ] **Step 4: Implement the session sweep**

In `src/auth/sessions.ts` `login`, immediately before the `INSERT INTO sessions` line:

```ts
  // Opportunistic sweep: expired rows accumulate otherwise (12h TTL, no cron by design).
  await appPool.query('DELETE FROM sessions WHERE expires_at < now()');
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/auth/` → all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/auth tests/auth
git commit -m "fix(auth): opportunistic pruning — login_attempts >24h and expired sessions"
```

---

### Task 4: Login/admin-users/invite route fixes

**Files:**
- Modify: `web/app/api/auth/login/route.ts` (null IP + comment), `web/app/api/admin/users/route.ts` (duplicate message + firm scoping), `web/app/api/auth/invite/[token]/route.ts` (GET try/catch symmetry)

**Interfaces:** no cross-task interfaces.

- [ ] **Step 1: Null-IP limiter scoping in the login route**

In `web/app/api/auth/login/route.ts`: change `clientIp` to return `string | null` (`return null;` instead of `'unknown'`, keep the trust-assumption comment), and build identifiers conditionally:

```ts
  const ip = clientIp(req);
  const identifiers = [`email:${email.toLowerCase()}`, ...(ip ? [`ip:${ip}`] : [])];
```

Also reword the misleading comment at the `recordLoginFailure` catch (currently "Fail open, same rationale as the checkLoginAllowed guard above." — the guard above is fail-CLOSED):

```ts
      } catch {
        // Recording is best-effort: a limiter-storage failure must not block the
        // error response. (Unlike checkLoginAllowed above, nothing here fails open —
        // the next check simply sees one fewer recorded failure.)
      }
```

- [ ] **Step 2: admin/users — friendly duplicate + firm-scoped assignments**

In `web/app/api/admin/users/route.ts` POST:

(a) Firm-scope the assignment ids — replace:

```ts
      for (const clientId of body.clientCompanyIds ?? []) await assignUserToClient(userId, clientId);
```

with:

```ts
      // Defense-in-depth: only assign clients belonging to the acting admin's firm
      // (resolveTenantContext re-checks at use time, but don't persist foreign ids).
      const firmClients = new Set((await listClientCompaniesForFirm(session.firmId)).map((c) => c.id));
      for (const clientId of body.clientCompanyIds ?? []) {
        if (firmClients.has(clientId)) await assignUserToClient(userId, clientId);
      }
```

with `import { listClientCompaniesForFirm } from '@domain/tenancy/firms.js';` (same import the admin/clients route uses).

(b) Friendly duplicate message — replace the catch block:

```ts
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
```

with:

```ts
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/duplicate key|already exists|unique constraint/i.test(msg)) {
      // Stable body — never leak constraint names. The existence oracle a 409
      // implies is inherent to unique emails (accepted, hobby-release triage).
      return NextResponse.json({ error: 'email already in use' }, { status: 409 });
    }
    if (/forbidden|session|not signed in/i.test(msg)) {
      return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
    }
    return NextResponse.json({ error: 'could not create user' }, { status: 400 });
  }
```

- [ ] **Step 3: Invite GET/POST try-catch symmetry**

In `web/app/api/auth/invite/[token]/route.ts`: read both handlers. Wrap the GET handler's body in the same `try { ... } catch` shape its POST uses (same error mapping), so a thrown lookup error can't escape as an unhandled 500. Keep behavior identical for the success and known-failure paths.

- [ ] **Step 4: Typecheck + focused auth tests**

Run: `cd web && npx tsc --noEmit` → clean; `npx vitest run tests/auth/` → still green (route changes don't touch domain, but the suite is cheap insurance here).

- [ ] **Step 5: Commit**

```bash
git add web/app/api/auth web/app/api/admin/users
git commit -m "fix(auth,admin): null-IP limiter scoping, friendly duplicate-email 409, firm-scoped invite assignments, invite GET symmetry"
```

---

### Task 5: Blob/bootstrap signal helpers, migration 036, cosmetics

**Files:**
- Create: `src/blob/config-status.ts`, `src/dev/guard.ts`, `migrations/036_user_invites_user_id_idx.sql`
- Modify: `src/blob/factory.ts`, `web/app/api/health/route.ts`, `web/app/api/dev/bootstrap/route.ts`, `web/app/invite/[token]/invite-form.tsx`, `web/app/components/InviteUserPanel.tsx`, `web/app/components/AdminTables.tsx`, `web/app/lib/i18n.ts`
- Test: `tests/blob/config-status.test.ts`, `tests/dev/guard.test.ts`

**Interfaces:**
- Produces: `blobConfigStatus(env: { VERCEL_ENV?: string; BLOB_READ_WRITE_TOKEN?: string }): 'ok' | 'misconfigured'`; `devBootstrapAllowed(env: { NODE_ENV?: string; VERCEL_ENV?: string }): boolean`.

- [ ] **Step 1: Write the failing helper tests**

`tests/blob/config-status.test.ts`:

```ts
import { expect, test } from 'vitest';
import { blobConfigStatus } from '../../src/blob/config-status.js';

test('misconfigured only when deployed to Vercel without a blob token', () => {
  expect(blobConfigStatus({ VERCEL_ENV: 'production' })).toBe('misconfigured');
  expect(blobConfigStatus({ VERCEL_ENV: 'preview' })).toBe('misconfigured');
  expect(blobConfigStatus({ VERCEL_ENV: 'production', BLOB_READ_WRITE_TOKEN: 'x' })).toBe('ok');
  expect(blobConfigStatus({})).toBe('ok'); // local dev: LocalBlobStore is fine
  expect(blobConfigStatus({ BLOB_READ_WRITE_TOKEN: 'x' })).toBe('ok');
});
```

`tests/dev/guard.test.ts`:

```ts
import { expect, test } from 'vitest';
import { devBootstrapAllowed } from '../../src/dev/guard.js';

test('bootstrap allowed only outside production and off Vercel', () => {
  expect(devBootstrapAllowed({})).toBe(true);
  expect(devBootstrapAllowed({ NODE_ENV: 'development' })).toBe(true);
  expect(devBootstrapAllowed({ NODE_ENV: 'production' })).toBe(false);
  expect(devBootstrapAllowed({ VERCEL_ENV: 'preview' })).toBe(false);
  expect(devBootstrapAllowed({ NODE_ENV: 'test', VERCEL_ENV: 'production' })).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/blob/config-status.test.ts tests/dev/guard.test.ts`
Expected: FAIL — modules don't exist.

- [ ] **Step 3: Implement the helpers**

`src/blob/config-status.ts`:

```ts
/** 'misconfigured' ⇔ deployed to Vercel without a blob token (first upload would 500 with EROFS). */
export function blobConfigStatus(env: { VERCEL_ENV?: string; BLOB_READ_WRITE_TOKEN?: string }): 'ok' | 'misconfigured' {
  return env.VERCEL_ENV && !env.BLOB_READ_WRITE_TOKEN ? 'misconfigured' : 'ok';
}
```

`src/dev/guard.ts`:

```ts
/** Dev bootstrap (migrate+seed+sign-in) must never run in production or on Vercel. */
export function devBootstrapAllowed(env: { NODE_ENV?: string; VERCEL_ENV?: string }): boolean {
  return env.NODE_ENV !== 'production' && !env.VERCEL_ENV;
}
```

- [ ] **Step 4: Wire them**

`src/blob/factory.ts` — add after the imports:

```ts
import { blobConfigStatus } from './config-status.js';

if (blobConfigStatus(process.env) === 'misconfigured') {
  console.warn('[blob] VERCEL_ENV is set but BLOB_READ_WRITE_TOKEN is not — uploads will fail (EROFS). Configure Vercel Blob.');
}
```

`web/app/api/health/route.ts`:

```ts
import { blobConfigStatus } from '@domain/blob/config-status.js';

export async function GET() {
  const blob = blobConfigStatus(process.env);
  try {
    await appPool.query('SELECT 1');
    return NextResponse.json({ ok: true, blob }, { status: 200 });
  } catch {
    return NextResponse.json({ ok: false, blob }, { status: 503 });
  }
}
```

`web/app/api/dev/bootstrap/route.ts` — replace the inline guard condition at line ~24 with `if (!devBootstrapAllowed(process.env)) {` (same rejection body as today) and import `devBootstrapAllowed` from `@domain/dev/guard.js`.

- [ ] **Step 5: Migration 036**

`migrations/036_user_invites_user_id_idx.sql`:

```sql
CREATE INDEX user_invites_user_id_idx ON user_invites(user_id);
```

- [ ] **Step 6: Cosmetics + i18n**

(a) `web/app/invite/[token]/invite-form.tsx` line ~167: `{busy ? '…' : t('invite.activate')}` → `{busy ? t('state.loading') : t('invite.activate')}` (`state.loading` exists in all catalogs).

(b) New key `admin.error` in all three catalogs of `web/app/lib/i18n.ts`, with the same text each catalog uses for `admin.onb.error` (copy per-language). Then switch the two NON-onboarding usages to it: `web/app/components/InviteUserPanel.tsx:107` and `web/app/components/AdminTables.tsx:272`. `OnboardingPanel.tsx` keeps `admin.onb.error`.

- [ ] **Step 7: Verify**

Run: `npx vitest run tests/blob/ tests/dev/ && npx tsc --noEmit && (cd web && npx tsc --noEmit && npm run build)` → all clean (build validates the i18n key).

- [ ] **Step 8: Commit**

```bash
git add src/blob src/dev migrations/036_user_invites_user_id_idx.sql tests/blob tests/dev web/app
git commit -m "fix(ops): blob misconfig signal on /api/health, testable bootstrap guard, invites index, UI cosmetics"
```

---

### Task 6: HANDOFF cleanup + full gates

**Files:**
- Modify: `HANDOFF.md`

- [ ] **Step 1: Update HANDOFF**

- Cross-cutting "Role-gating on mutating API routes" paragraph: mark **FIXED 2026-07-19** — tasks/capture/admin mutations now gated via the `Operation` matrix; notifications/assistant deliberately self-scoped; matrix remains the single auditable policy.
- Cross-cutting "Uniform error-status mapping" paragraph: mark **FIXED 2026-07-19** — all routes now use `errorToStatus`.
- Hobby-release follow-ups list: strike items 1–6 with **FIXED 2026-07-19** (house style); item 7's cosmetics likewise. Leave the "Accepted trade-offs" paragraph as is (still accurate — note the duplicate-email 409 now returns a stable body).

- [ ] **Step 2: Full gates**

```bash
npm test && npx tsc --noEmit && (cd web && npx tsc --noEmit && npm run build)
```

Expected: full suite green, typechecks clean, web build clean.

- [ ] **Step 3: Commit**

```bash
git add HANDOFF.md
git commit -m "docs: hardening batch shipped — close G1/G2 and hobby-release follow-ups in HANDOFF"
```

---

## Self-Review Notes (already applied)

- Spec coverage: §1 authz → T1; §2 sweep → T2; §3 prune/sweep → T3, admin-users/invite/login → T4, blob signal + index + cosmetics → T5; §4 testing → T1/T3/T5; acceptance 1–4 → T1/T4/T3/T5, 5 → T6.
- T1 Step 5 and T2 touch the same three task-route files; either order works (each step says "merge imports if present"). Execute T1 before T2 (plan order) so T2's grep check is the final word.
- Deliberate discovery steps with full method + stop conditions: T1 Step 7 (confirm sibling admin routes share the inline-check shape), T3 Step 1 (adapt fixture helper names to the existing test file), T4 Step 3 (mirror the file's own POST catch shape).
