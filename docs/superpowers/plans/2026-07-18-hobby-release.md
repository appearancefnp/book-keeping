# Hobby Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app deployable to Vercel free tiers for real users: invite-based user provisioning with 2FA enrolment, durable blob storage, and security hardening (rate limiting, secure cookies, headers, pool tuning, health check).

**Architecture:** Follows the spec `docs/superpowers/specs/2026-07-18-hobby-release-design.md`. Everything plugs into existing seams: the `BlobStore` interface, the `Operation` role matrix, the auth module's `appPool` pattern (firm-level, no `withTenant`), and the trilingual i18n catalogs.

**Tech Stack:** TypeScript, pg, vitest (real Postgres on localhost:5433 via `docker compose up -d db`), Next.js 16 in `web/`, new deps: `@vercel/blob` and `qrcode` (web only).

## Global Constraints

- Migration numbering: take max+1 across ALL files. 030–032 exist; this plan uses **033** and **034**. The guard test `tests/db/migration-numbering.test.ts` must stay green.
- Money in integer cents; ledger append-only (untouched by this plan).
- Auth module pattern: user/session functions run on `appPool` directly (firm-level data, no `withTenant`, no client-scoped `appendAudit`) — match `src/auth/users.ts`.
- i18n: every new user-facing string added to ALL THREE catalogs (EN/LV/RU) in `web/app/lib/i18n.ts`; the typed `Record<keyof typeof EN, string>` fails the build otherwise.
- `web/` is a Next.js version with breaking changes vs training data — **read the relevant guide in `web/node_modules/next/dist/docs/` before writing any Next.js route/page code** (per `web/AGENTS.md`).
- Web API routes: copy an existing route's pattern. Firm-level admin routes use `validateSession` (see `web/app/api/admin/users/route.ts`); tenant routes use `resolveTenantContext`.
- Invite/limiter failures must be generic — invalid = expired = used all return the same message; lockout returns the same 401 as bad credentials (no user enumeration, no token probing signal).
- Verification: `npm test` (root) + `npx tsc --noEmit` (root) + `cd web && npx tsc --noEmit` must pass after every task; `cd web && npm run build` after tasks that touch `web/` deps or pages.
- Commit messages end with the session trailer line the controller provides.

---

### Task 1: Migration 033 + invites domain + invited-login rejection

**Files:**
- Create: `migrations/033_user_invites.sql`
- Create: `src/auth/invites.ts`
- Modify: `src/auth/users.ts` (add `status` to `findUserByEmail`)
- Modify: `src/auth/sessions.ts:9-18` (reject invited users)
- Test: `tests/auth/invites.test.ts`

**Interfaces:**
- Consumes: `generateTotpSecret`, `totpCodeFor`, `verifyTotp`, `totpUri` (`src/auth/totp.ts`), `hashPassword` (`src/auth/passwords.ts`), `createUser`/`findUserByEmail` (`src/auth/users.ts`), `appPool`.
- Produces (used by Tasks 3–4):
  - `createInvite(userId: string, createdBy: string, atUnixSeconds: number): Promise<{ token: string; expiresAtIso: string }>`
  - `previewInvite(token: string, atUnixSeconds: number): Promise<{ email: string; firmName: string; otpauthUri: string; totpSecret: string } | null>`
  - `acceptInvite(token: string, input: { password: string; totpCode: string }, atUnixSeconds: number): Promise<void>` (throws `Error('invalid invite')` on any failure)
  - `users.status` column: `'invited' | 'active'`; `login()` now throws `Invalid credentials` for invited users.

- [ ] **Step 1: Write the migration**

`migrations/033_user_invites.sql`:

```sql
-- Invite-based provisioning + 2FA enrolment (hobby-release spec).
ALTER TABLE users ADD COLUMN status text NOT NULL DEFAULT 'active'
  CHECK (status IN ('invited', 'active'));

CREATE TABLE user_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON user_invites TO bookkeeping_app;
```

(Check `migrations/017_users_sessions.sql` for how grants are phrased there and mirror it exactly; if a broader grant convention exists — e.g. `GRANT ... ON ALL TABLES` in 007 — match that instead.)

- [ ] **Step 2: Write the failing test**

`tests/auth/invites.test.ts`:

```typescript
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { createFirm } from '../../src/tenancy/firms.js';
import { createUser } from '../../src/auth/users.js';
import { login } from '../../src/auth/sessions.js';
import { totpCodeFor } from '../../src/auth/totp.js';
import { createInvite, previewInvite, acceptInvite } from '../../src/auth/invites.js';

const NOW = 1_700_000_000;
const DAY = 86_400;

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function setup() {
  const firm = await createFirm('Invite Firm');
  const admin = await createUser({ firmId: firm.id, email: 'admin@t.lv', password: 'password123', role: 'firm_admin' });
  const invitee = await createUser({ firmId: firm.id, email: 'new@t.lv', password: 'placeholder-never-used-1', role: 'owner' });
  return { firm, adminId: admin.id, userId: invitee.id };
}

test('full happy path: invite → preview → accept → login', async () => {
  const { adminId, userId } = await setup();
  const { token } = await createInvite(userId, adminId, NOW);

  const preview = await previewInvite(token, NOW);
  expect(preview).not.toBeNull();
  expect(preview!.email).toBe('new@t.lv');
  expect(preview!.firmName).toBe('Invite Firm');
  expect(preview!.otpauthUri).toContain('otpauth://totp/');

  // Invited user cannot log in yet (even with correct new-ish credentials).
  await expect(login('new@t.lv', 'placeholder-never-used-1', totpCodeFor(preview!.totpSecret, NOW), NOW))
    .rejects.toThrow(/invalid credentials/i);

  await acceptInvite(token, { password: 'a-strong-password-12', totpCode: totpCodeFor(preview!.totpSecret, NOW) }, NOW);
  const { sessionToken } = await login('new@t.lv', 'a-strong-password-12', totpCodeFor(preview!.totpSecret, NOW), NOW);
  expect(sessionToken).toBeTruthy();
});

test('token is single-use and expired/garbage tokens are rejected identically', async () => {
  const { adminId, userId } = await setup();
  const { token } = await createInvite(userId, adminId, NOW);
  const preview = await previewInvite(token, NOW);
  await acceptInvite(token, { password: 'a-strong-password-12', totpCode: totpCodeFor(preview!.totpSecret, NOW) }, NOW);

  await expect(acceptInvite(token, { password: 'another-password-123', totpCode: totpCodeFor(preview!.totpSecret, NOW) }, NOW))
    .rejects.toThrow(/invalid invite/i);
  expect(await previewInvite(token, NOW)).toBeNull();
  expect(await previewInvite('deadbeef'.repeat(8), NOW)).toBeNull();

  const { token: t2 } = await createInvite(userId, adminId, NOW);
  expect(await previewInvite(t2, NOW + 3 * DAY + 1)).toBeNull(); // 72h expiry
});

test('wrong TOTP code leaves invite usable and user inactive', async () => {
  const { adminId, userId } = await setup();
  const { token } = await createInvite(userId, adminId, NOW);
  await expect(acceptInvite(token, { password: 'a-strong-password-12', totpCode: '000000' }, NOW))
    .rejects.toThrow(/invalid invite/i);
  expect(await previewInvite(token, NOW)).not.toBeNull(); // still unused
  await expect(login('new@t.lv', 'a-strong-password-12', '000000', NOW)).rejects.toThrow();
});

test('re-invite rotates the TOTP secret and invalidates prior invites', async () => {
  const { adminId, userId } = await setup();
  const { token: first } = await createInvite(userId, adminId, NOW);
  const firstPreview = await previewInvite(first, NOW);
  const { token: second } = await createInvite(userId, adminId, NOW);
  expect(await previewInvite(first, NOW)).toBeNull(); // prior invite invalidated
  const secondPreview = await previewInvite(second, NOW);
  expect(secondPreview!.totpSecret).not.toBe(firstPreview!.totpSecret);
  expect(secondPreview!.otpauthUri).toContain(secondPreview!.totpSecret);
});

test('short password is rejected', async () => {
  const { adminId, userId } = await setup();
  const { token } = await createInvite(userId, adminId, NOW);
  const preview = await previewInvite(token, NOW);
  await expect(acceptInvite(token, { password: 'short', totpCode: totpCodeFor(preview!.totpSecret, NOW) }, NOW))
    .rejects.toThrow(); // zod min(12)
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/auth/invites.test.ts`
Expected: FAIL — module `src/auth/invites.js` not found (and after migration exists, functions undefined).

- [ ] **Step 4: Implement**

`src/auth/invites.ts`:

```typescript
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { appPool } from '../db/pool.js';
import { hashPassword } from './passwords.js';
import { generateTotpSecret, totpUri, verifyTotp } from './totp.js';

const INVITE_TTL_SECONDS = 72 * 3600;

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Creates a one-time invite for `userId`, rotating their TOTP secret and
 * locking the account (`status='invited'`) until the invite is accepted.
 * Prior unused invites for the user are invalidated. Returns the RAW token
 * (only its sha256 is stored) — show it once, never log it.
 */
export async function createInvite(
  userId: string, createdBy: string, atUnixSeconds: number,
): Promise<{ token: string; expiresAtIso: string }> {
  const token = randomBytes(32).toString('hex');
  const expiresAtIso = new Date((atUnixSeconds + INVITE_TTL_SECONDS) * 1000).toISOString();
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM user_invites WHERE user_id = $1 AND used_at IS NULL`, [userId]);
    await client.query(
      `UPDATE users SET status = 'invited', totp_secret = $2 WHERE id = $1`,
      [userId, generateTotpSecret()],
    );
    await client.query(
      `INSERT INTO user_invites(user_id, token_hash, expires_at, created_by) VALUES ($1,$2,$3,$4)`,
      [userId, sha256(token), expiresAtIso, createdBy],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return { token, expiresAtIso };
}

interface InviteRow { inviteId: string; userId: string; email: string; firmName: string; totpSecret: string; }

async function findValidInvite(token: string, atUnixSeconds: number): Promise<InviteRow | null> {
  const res = await appPool.query(
    `SELECT i.id AS "inviteId", u.id AS "userId", u.email, f.name AS "firmName", u.totp_secret AS "totpSecret"
     FROM user_invites i
     JOIN users u ON u.id = i.user_id
     JOIN firms f ON f.id = u.firm_id
     WHERE i.token_hash = $1 AND i.used_at IS NULL
       AND EXTRACT(EPOCH FROM i.expires_at) > $2`,
    [sha256(token), atUnixSeconds],
  );
  return res.rows[0] ?? null;
}

/** Returns invite details for the enrolment page, or null (invalid = expired = used, indistinguishable). */
export async function previewInvite(
  token: string, atUnixSeconds: number,
): Promise<{ email: string; firmName: string; otpauthUri: string; totpSecret: string } | null> {
  const row = await findValidInvite(token, atUnixSeconds);
  if (!row) return null;
  return {
    email: row.email,
    firmName: row.firmName,
    totpSecret: row.totpSecret,
    otpauthUri: totpUri(row.totpSecret, row.email),
  };
}

const acceptSchema = z.object({ password: z.string().min(12), totpCode: z.string().length(6) });

/**
 * Activates the account: verifies the TOTP code against the invite's fresh
 * secret (proves the authenticator is enrolled) BEFORE setting the password
 * and flipping status. Single transaction; generic error on any failure.
 */
export async function acceptInvite(
  token: string, input: { password: string; totpCode: string }, atUnixSeconds: number,
): Promise<void> {
  const p = acceptSchema.parse(input);
  const row = await findValidInvite(token, atUnixSeconds);
  if (!row || !verifyTotp(row.totpSecret, p.totpCode, atUnixSeconds)) {
    throw new Error('invalid invite');
  }
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    const used = await client.query(
      `UPDATE user_invites SET used_at = now() WHERE id = $1 AND used_at IS NULL`,
      [row.inviteId],
    );
    if (!used.rowCount) throw new Error('invalid invite'); // raced double-accept
    await client.query(
      `UPDATE users SET password_hash = $2, status = 'active' WHERE id = $1`,
      [row.userId, hashPassword(p.password)],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
```

In `src/auth/users.ts`, extend `findUserByEmail`'s SELECT with `status`:

```typescript
export async function findUserByEmail(email: string): Promise<(UserRow & { passwordHash: string; totpSecret: string; status: 'invited' | 'active' }) | null> {
  const res = await appPool.query(
    `SELECT id, firm_id AS "firmId", email, role, language, status, password_hash AS "passwordHash", totp_secret AS "totpSecret"
     FROM users WHERE email = $1`,
    [email],
  );
  return res.rows[0] ?? null;
}
```

In `src/auth/sessions.ts` `login()`, after the user lookup line, reject invited accounts with the SAME generic error as bad credentials:

```typescript
  const user = await findUserByEmail(email);
  if (!user || user.status !== 'active' || !verifyPassword(password, user.passwordHash)) throw new Error('Invalid credentials');
```

- [ ] **Step 5: Run migration + tests**

Run: `npm run migrate && npx vitest run tests/auth/invites.test.ts tests/auth`
Expected: PASS (all invite tests + existing auth tests — resetDb re-runs migrations in tests, so 033 applies there automatically).

- [ ] **Step 6: Full suite + typecheck, then commit**

Run: `npm test && npx tsc --noEmit`
Expected: PASS. (`npm run seed` users default to `status='active'` via the column default — seed logins unaffected.)

```bash
git add migrations/033_user_invites.sql src/auth/invites.ts src/auth/users.ts src/auth/sessions.ts tests/auth/invites.test.ts
git commit -m "feat(auth): invite-based provisioning with 2FA enrolment (domain)"
```

---

### Task 2: Login rate limiting + secure cookie

**Files:**
- Create: `migrations/034_login_attempts.sql`
- Create: `src/auth/rate-limit.ts`
- Modify: `web/app/api/auth/login/route.ts`
- Test: `tests/auth/rate-limit.test.ts`

**Interfaces:**
- Produces (used by Task 3's invite routes):
  - `checkLoginAllowed(identifiers: string[], atUnixSeconds: number): Promise<boolean>`
  - `recordLoginFailure(identifiers: string[], atUnixSeconds: number): Promise<void>`
  - `clearLoginFailures(identifiers: string[]): Promise<void>`
- Policy: max 5 failures per identifier per 15-minute fixed window; blocked until the window ends; success clears.

- [ ] **Step 1: Write the migration**

`migrations/034_login_attempts.sql`:

```sql
-- Login brute-force protection (hobby-release spec): fixed 15-min window per identifier.
CREATE TABLE login_attempts (
  identifier text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  fail_count int NOT NULL DEFAULT 0
);

GRANT SELECT, INSERT, UPDATE, DELETE ON login_attempts TO bookkeeping_app;
```

(Mirror the repo's actual grant convention as in Task 1.)

- [ ] **Step 2: Write the failing test**

`tests/auth/rate-limit.test.ts`:

```typescript
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { checkLoginAllowed, recordLoginFailure, clearLoginFailures } from '../../src/auth/rate-limit.js';

const NOW = 1_700_000_000;

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('allows up to 5 failures, blocks the 6th attempt in the window', async () => {
  const ids = ['email:a@t.lv'];
  for (let i = 0; i < 5; i++) {
    expect(await checkLoginAllowed(ids, NOW)).toBe(true);
    await recordLoginFailure(ids, NOW);
  }
  expect(await checkLoginAllowed(ids, NOW)).toBe(false);
});

test('window expiry unblocks; failure after expiry starts a fresh window', async () => {
  const ids = ['email:b@t.lv'];
  for (let i = 0; i < 5; i++) await recordLoginFailure(ids, NOW);
  expect(await checkLoginAllowed(ids, NOW + 899)).toBe(false);
  expect(await checkLoginAllowed(ids, NOW + 901)).toBe(true);
  await recordLoginFailure(ids, NOW + 901);
  expect(await checkLoginAllowed(ids, NOW + 901)).toBe(true); // count restarted at 1
});

test('success clears; identifiers are independent but ANY blocked identifier blocks', async () => {
  const ids = ['email:c@t.lv', 'ip:1.2.3.4'];
  for (let i = 0; i < 5; i++) await recordLoginFailure(ids, NOW);
  expect(await checkLoginAllowed(['email:c@t.lv'], NOW)).toBe(false);
  expect(await checkLoginAllowed(['ip:1.2.3.4'], NOW)).toBe(false);
  expect(await checkLoginAllowed(['email:other@t.lv', 'ip:9.9.9.9'], NOW)).toBe(true);
  await clearLoginFailures(ids);
  expect(await checkLoginAllowed(ids, NOW)).toBe(true);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/auth/rate-limit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`src/auth/rate-limit.ts`:

```typescript
import { appPool } from '../db/pool.js';

const WINDOW_SECONDS = 15 * 60;
const MAX_FAILURES = 5;

/** True unless ANY identifier has >= MAX_FAILURES failures inside the current window. */
export async function checkLoginAllowed(identifiers: string[], atUnixSeconds: number): Promise<boolean> {
  if (identifiers.length === 0) return true;
  const res = await appPool.query(
    `SELECT 1 FROM login_attempts
     WHERE identifier = ANY($1)
       AND fail_count >= $2
       AND EXTRACT(EPOCH FROM window_start) > $3 - $4
     LIMIT 1`,
    [identifiers, MAX_FAILURES, atUnixSeconds, WINDOW_SECONDS],
  );
  return res.rowCount === 0;
}

/** Records one failure per identifier; a failure outside the window starts a fresh window. */
export async function recordLoginFailure(identifiers: string[], atUnixSeconds: number): Promise<void> {
  const nowIso = new Date(atUnixSeconds * 1000).toISOString();
  for (const id of identifiers) {
    await appPool.query(
      `INSERT INTO login_attempts(identifier, window_start, fail_count) VALUES ($1, $2, 1)
       ON CONFLICT (identifier) DO UPDATE SET
         fail_count = CASE WHEN EXTRACT(EPOCH FROM login_attempts.window_start) > $3 - $4
                           THEN login_attempts.fail_count + 1 ELSE 1 END,
         window_start = CASE WHEN EXTRACT(EPOCH FROM login_attempts.window_start) > $3 - $4
                             THEN login_attempts.window_start ELSE $2 END`,
      [id, nowIso, atUnixSeconds, WINDOW_SECONDS],
    );
  }
}

export async function clearLoginFailures(identifiers: string[]): Promise<void> {
  if (identifiers.length === 0) return;
  await appPool.query(`DELETE FROM login_attempts WHERE identifier = ANY($1)`, [identifiers]);
}
```

- [ ] **Step 5: Wire into the login route + secure cookie**

Replace the body of `web/app/api/auth/login/route.ts` POST with (structure preserved; new lines marked):

```typescript
export async function POST(req: Request) {
  const { email, password, code } = (await req.json().catch(() => ({}))) as {
    email?: string; password?: string; code?: string;
  };
  if (!email || !password || !code)
    return NextResponse.json({ error: 'email, password and code are required' }, { status: 400 });

  const ip = (req.headers.get('x-forwarded-for') ?? 'unknown').split(',')[0]!.trim();
  const identifiers = [`email:${email.toLowerCase()}`, `ip:${ip}`];
  const at = nowUnix();
  if (!(await checkLoginAllowed(identifiers, at))) {
    // Same shape/message as a bad login — no lockout oracle.
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
  }
  try {
    const { sessionToken } = await login(email, password, code, at);
    await clearLoginFailures(identifiers);
    (await cookies()).set(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 12,
    });
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (e) {
    await recordLoginFailure(identifiers, at);
    const msg = e instanceof Error ? e.message : 'login failed';
    return NextResponse.json({ error: msg }, { status: 401 });
  }
}
```

with imports added: `import { checkLoginAllowed, clearLoginFailures, recordLoginFailure } from '@domain/auth/rate-limit.js';`

- [ ] **Step 6: Migrate, run tests, typecheck both, commit**

Run: `npm run migrate && npm test && npx tsc --noEmit && (cd web && npx tsc --noEmit)`
Expected: PASS.

```bash
git add migrations/034_login_attempts.sql src/auth/rate-limit.ts tests/auth/rate-limit.test.ts web/app/api/auth/login/route.ts
git commit -m "feat(auth): login rate limiting + secure session cookie"
```

---

### Task 3: users.write operation + admin create/re-invite route + public invite routes

**Files:**
- Modify: `src/authz/policy.ts` (add `'users.write'`)
- Modify: `web/app/api/admin/users/route.ts` (add POST)
- Create: `web/app/api/auth/invite/[token]/route.ts` (GET + POST)
- Test: `tests/authz/policy.test.ts` (extend if it exists; otherwise create with just the new-op cases)

**Interfaces:**
- Consumes: Task 1's `createInvite`/`previewInvite`/`acceptInvite`; Task 2's limiter; `createUser`, `assignUserToClient` (`src/auth/context.js` — verify the import path by grepping `assignUserToClient`), `validateSession`.
- Produces: `POST /api/admin/users` body `{ email, role, language?, clientCompanyIds?: string[] }` → `{ inviteUrl, expiresAt }`; or `{ userId }` → re-invite. `GET /api/auth/invite/[token]` → `{ email, firmName, otpauthUri, totpSecret }` | 404. `POST /api/auth/invite/[token]` body `{ password, totpCode }` → `{ ok: true }` | 404.

- [ ] **Step 1: Policy addition (+ test)**

In `src/authz/policy.ts` add to the `Operation` union and matrix:

```typescript
  | 'proposals.decide' // approve/reject proposals in the approval queue
  | 'users.write'; // create users / issue credential-reset invites
```

```typescript
  'proposals.decide': ['firm_admin', 'accountant', 'owner'],
  'users.write': ['firm_admin'],
```

(Note: `'proposals.decide'` already exists from the known-issues branch; only append `'users.write'`.)

Test (extend `tests/authz/policy.test.ts`, or create it):

```typescript
import { expect, test } from 'vitest';
import { isRoleAllowed } from '../../src/authz/policy.js';

test('users.write is firm_admin only', () => {
  expect(isRoleAllowed('firm_admin', 'users.write')).toBe(true);
  for (const role of ['accountant', 'owner', 'employee', 'agent', 'nonsense']) {
    expect(isRoleAllowed(role, 'users.write')).toBe(false);
  }
});
```

Run: `npx vitest run tests/authz` — expected FAIL (op missing) then PASS after the policy edit.

- [ ] **Step 2: Admin POST route**

Append to `web/app/api/admin/users/route.ts` (keep GET as is; read a Next docs guide from `web/node_modules/next/dist/docs/` if route-handler syntax is in doubt):

```typescript
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';
import { createUser, findUserByEmail } from '@domain/auth/users.js';
import { assignUserToClient } from '@domain/auth/context.js';
import { createInvite } from '@domain/auth/invites.js';
import { randomBytes } from 'node:crypto';

export async function POST(req: Request) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const session = await validateSession(token, nowUnix());
  if (!session) return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
  try {
    assertRoleAllowed(session.role, 'users.write');
    const body = (await req.json().catch(() => ({}))) as {
      email?: string; role?: string; language?: string; clientCompanyIds?: string[]; userId?: string;
    };

    let userId = body.userId;
    if (!userId) {
      if (!body.email || !body.role) return NextResponse.json({ error: 'email and role are required' }, { status: 400 });
      // Placeholder password nobody knows; acceptInvite overwrites it.
      const { id } = await createUser({
        firmId: session.firmId, email: body.email, password: randomBytes(24).toString('hex'),
        role: body.role as never, language: body.language,
      });
      userId = id;
      for (const clientId of body.clientCompanyIds ?? []) await assignUserToClient(userId, clientId);
    } else {
      // Re-invite may only target a user in the admin's own firm.
      const target = (await listUsersForFirm(session.firmId)).find((u) => u.id === userId);
      if (!target) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }

    const { token: inviteToken, expiresAtIso } = await createInvite(userId, session.userId, nowUnix());
    return NextResponse.json({ inviteUrl: `/invite/${inviteToken}`, expiresAt: expiresAtIso }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
```

(`findUserByEmail` import may be unused — drop it if so. Verify `assignUserToClient`'s real module with `grep -rn "export.*assignUserToClient" src/`.)

- [ ] **Step 3: Public invite routes**

`web/app/api/auth/invite/[token]/route.ts`:

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { previewInvite, acceptInvite } from '@domain/auth/invites.js';
import { checkLoginAllowed, recordLoginFailure } from '@domain/auth/rate-limit.js';
import { nowUnix } from '@/app/lib/session';

// Trusted client IP: x-real-ip (Vercel-set) first, else the LAST x-forwarded-for
// hop (earlier hops are attacker-suppliable), else 'unknown'. Mirrors the login
// route's clientIp helper (hardened after the Task 2 review).
function ipOf(req: NextRequest): string {
  const real = req.headers.get('x-real-ip');
  if (real) return real.trim();
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const hops = xff.split(',');
    return hops[hops.length - 1]!.trim();
  }
  return 'unknown';
}

// Limiter calls are guarded and fail CLOSED: a limiter-only breakage must not
// disable token-probing protection (the 404 shape stays generic either way).
// Mirrors the login route's hardened guard.
async function allowed(ids: string[], at: number): Promise<boolean> {
  try { return await checkLoginAllowed(ids, at); } catch { return false; }
}
async function recordFailure(ids: string[], at: number): Promise<void> {
  try { await recordLoginFailure(ids, at); } catch { /* recording is best-effort */ }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const at = nowUnix();
  const ids = [`invite-ip:${ipOf(req)}`];
  if (!(await allowed(ids, at))) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const preview = await previewInvite(token, at);
  if (!preview) {
    await recordFailure(ids, at); // token probing burns the same budget
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json(preview, { status: 200 });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { password?: string; totpCode?: string };
  const at = nowUnix();
  const ids = [`invite-ip:${ipOf(req)}`];
  if (!(await allowed(ids, at))) return NextResponse.json({ error: 'not found' }, { status: 404 });
  try {
    await acceptInvite(token, { password: body.password ?? '', totpCode: body.totpCode ?? '' }, at);
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch {
    await recordFailure(ids, at);
    return NextResponse.json({ error: 'not found' }, { status: 404 }); // generic: invalid = expired = used
  }
}
```

- [ ] **Step 4: Full suite + both typechecks, commit**

Run: `npm test && npx tsc --noEmit && (cd web && npx tsc --noEmit)`
Expected: PASS.

```bash
git add src/authz/policy.ts tests/authz web/app/api/admin/users/route.ts web/app/api/auth/invite
git commit -m "feat(auth): admin invite issuance + public invite accept routes (users.write)"
```

---

### Task 4: Invite page + admin UI + i18n

**Files:**
- Create: `web/app/invite/[token]/page.tsx`, `web/app/invite/[token]/invite-form.tsx`, `web/app/invite/[token]/invite.module.css`
- Modify: `web/app/components/AdminTables.tsx` (invite form + link display + per-user re-invite in the Users section, ~line 214)
- Modify: `web/app/lib/i18n.ts` (keys below, ALL THREE catalogs)
- Modify: `web/package.json` (add `qrcode` + `@types/qrcode`)

**Interfaces:**
- Consumes: Task 3's routes. QR: `import QRCode from 'qrcode'` → `QRCode.toDataURL(otpauthUri)` client-side.
- Page pattern: mirror `web/app/login/page.tsx` (server component wrapping a `'use client'` form in `LanguageProvider`; styles via a CSS module — copy `login.module.css` as the base). **Read the Next.js docs guide in `web/node_modules/next/dist/docs/` for client-component + dynamic-params conventions before writing.**

- [ ] **Step 1: Add i18n keys (build enforces completeness)**

Add to EN catalog (and translated equivalents to LV and RU — the file's existing style is compact grouped lines):

```typescript
  'invite.title': 'Activate your account', 'invite.intro': 'Set a password and enrol two-factor authentication to activate your account.',
  'invite.firm': 'Firm', 'invite.email': 'Email',
  'invite.password': 'New password', 'invite.passwordHint': 'At least 12 characters',
  'invite.scan': 'Scan this QR code with your authenticator app', 'invite.manualSecret': 'Or enter the secret manually:',
  'invite.code': '6-digit code from the app', 'invite.activate': 'Activate account',
  'invite.done': 'Account activated — you can now sign in.', 'invite.goLogin': 'Go to sign in',
  'invite.invalid': 'This invite link is invalid or has expired.',
  'admin.inviteUser': 'Invite user', 'admin.inviteEmail': 'Email', 'admin.inviteRole': 'Role',
  'admin.inviteClients': 'Client companies', 'admin.inviteCreate': 'Create invite',
  'admin.inviteLink': 'Invite link (shown once — copy it now)', 'admin.inviteCopy': 'Copy',
  'admin.reinvite': 'Reset & re-invite',
```

LV: `'invite.title': 'Aktivizējiet savu kontu'`, `'invite.intro': 'Iestatiet paroli un pievienojiet divu faktoru autentifikāciju, lai aktivizētu kontu.'`, `'invite.firm': 'Birojs'`, `'invite.email': 'E-pasts'`, `'invite.password': 'Jaunā parole'`, `'invite.passwordHint': 'Vismaz 12 rakstzīmes'`, `'invite.scan': 'Noskenējiet šo QR kodu ar autentifikācijas lietotni'`, `'invite.manualSecret': 'Vai ievadiet slepeno atslēgu manuāli:'`, `'invite.code': '6 ciparu kods no lietotnes'`, `'invite.activate': 'Aktivizēt kontu'`, `'invite.done': 'Konts aktivizēts — tagad varat pierakstīties.'`, `'invite.goLogin': 'Uz pierakstīšanos'`, `'invite.invalid': 'Šī ielūguma saite nav derīga vai tai beidzies termiņš.'`, `'admin.inviteUser': 'Uzaicināt lietotāju'`, `'admin.inviteEmail': 'E-pasts'`, `'admin.inviteRole': 'Loma'`, `'admin.inviteClients': 'Klientu uzņēmumi'`, `'admin.inviteCreate': 'Izveidot ielūgumu'`, `'admin.inviteLink': 'Ielūguma saite (redzama vienreiz — nokopējiet tūlīt)'`, `'admin.inviteCopy': 'Kopēt'`, `'admin.reinvite': 'Atiestatīt un uzaicināt atkārtoti'`

RU: `'invite.title': 'Активируйте свою учётную запись'`, `'invite.intro': 'Задайте пароль и настройте двухфакторную аутентификацию, чтобы активировать учётную запись.'`, `'invite.firm': 'Фирма'`, `'invite.email': 'Эл. почта'`, `'invite.password': 'Новый пароль'`, `'invite.passwordHint': 'Не менее 12 символов'`, `'invite.scan': 'Отсканируйте этот QR-код в приложении-аутентификаторе'`, `'invite.manualSecret': 'Или введите секретный ключ вручную:'`, `'invite.code': '6-значный код из приложения'`, `'invite.activate': 'Активировать учётную запись'`, `'invite.done': 'Учётная запись активирована — теперь вы можете войти.'`, `'invite.goLogin': 'К входу'`, `'invite.invalid': 'Эта ссылка-приглашение недействительна или срок её действия истёк.'`, `'admin.inviteUser': 'Пригласить пользователя'`, `'admin.inviteEmail': 'Эл. почта'`, `'admin.inviteRole': 'Роль'`, `'admin.inviteClients': 'Компании клиентов'`, `'admin.inviteCreate': 'Создать приглашение'`, `'admin.inviteLink': 'Ссылка-приглашение (показывается один раз — скопируйте сейчас)'`, `'admin.inviteCopy': 'Копировать'`, `'admin.reinvite': 'Сбросить и пригласить заново'`

Run: `cd web && npx tsc --noEmit` — expected PASS only when all three catalogs carry every key.

- [ ] **Step 2: Install deps**

Run: `cd web && npm install qrcode && npm install -D @types/qrcode`

- [ ] **Step 3: Invite page**

`web/app/invite/[token]/page.tsx` (server component, mirrors login page structure):

```tsx
import { LanguageProvider } from '@/app/lib/i18n-context';
import { InviteForm } from './invite-form';
import styles from './invite.module.css';

export const metadata = { title: 'Activate account — Bookkeeping Cabinet' };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <LanguageProvider>
      <div className={styles.page}>
        <div className={styles.card}>
          <InviteForm token={token} />
        </div>
      </div>
    </LanguageProvider>
  );
}
```

`invite-form.tsx` (`'use client'`): on mount, `GET /api/auth/invite/${token}`; 404 → show `t('invite.invalid')` only. Otherwise render: firm + email (read-only), password input (`minLength={12}`, hint `invite.passwordHint`), QR `<img>` from `QRCode.toDataURL(preview.otpauthUri)` with `alt` = `t('invite.scan')`, the secret as selectable `<code>` under `invite.manualSecret`, TOTP input (`inputMode="numeric"`, `maxLength={6}`), submit button `invite.activate` → `POST /api/auth/invite/${token}` with `{ password, totpCode }`; on 200 show `invite.done` + link `invite.goLogin` → `/login`; on 404 show `invite.invalid` (do not distinguish causes). Status/error text in an `aria-live="polite"` element; every visible string via `t(...)` — no hardcoded copy. Copy `login.module.css` → `invite.module.css` and extend minimally (`.qr { width: 12rem; height: 12rem; }`, `.secret { user-select: all; }`). Follow the form/element idioms of `web/app/login/login-form.tsx`.

- [ ] **Step 4: Admin UI**

In `web/app/components/AdminTables.tsx`, inside the Users section (`~line 214`), add a client-side invite panel above `<UsersTable>`:
- Form fields: email (`admin.inviteEmail`), role select (reuse the existing role label helper if present; values `firm_admin|accountant|owner|employee`), client-company multi-checkboxes from the `clients` prop already passed to `AdminTables` (`admin.inviteClients`), submit `admin.inviteCreate` → `POST /api/admin/users`.
- On 201: show returned `inviteUrl` (prefix with `window.location.origin`) in a read-only input labeled `admin.inviteLink` + a `admin.inviteCopy` button (`navigator.clipboard.writeText`). Never render the link again after navigation.
- Each `UsersTable` row gains a `admin.reinvite` button → `POST /api/admin/users` with `{ userId }` → same link display.
- Non-`firm_admin` viewers: hide the panel and buttons (mirror how the page already gates admin-only sections; the route enforces server-side regardless).
- If `AdminTables.tsx` grows past ~350 lines, extract the panel to `web/app/components/InviteUserPanel.tsx` and note it in the report.

- [ ] **Step 5: Verify in the running app, typecheck, build, commit**

Run: `npm test && npx tsc --noEmit && (cd web && npx tsc --noEmit && npm run build)`
Expected: all PASS (root suite unaffected; web build proves the page compiles and i18n is complete).

Manual smoke (dev server + seeded DB): create an invite from `/admin` as the seeded accountant → expect 403 (accountant lacks `users.write` — correct); the full happy path is exercised in Task 6's provision script instead. Note the 403 check result in the report.

```bash
git add web/app/invite web/app/components/AdminTables.tsx web/app/lib/i18n.ts web/package.json web/package-lock.json
git commit -m "feat(web): invite acceptance page with QR 2FA enrolment + admin invite UI"
```

(If Step 4 created `InviteUserPanel.tsx`, add it too.)

---

### Task 5: VercelBlobStore + factory

**Files:**
- Create: `src/blob/vercel-blob-store.ts`, `src/blob/factory.ts`
- Modify: `web/app/api/documents/capture/route.ts:6,36`, `web/app/api/invoice-profile/logo/route.ts:8,12`, `web/app/invoice-document/[id]/page.tsx:9,15`
- Modify: `web/package.json` (add `@vercel/blob`)
- Test: `tests/blob/factory.test.ts`

**Interfaces:**
- Consumes: `BlobStore` interface (`src/blob/blob-store.ts:4-7`): `put(key, bytes, mime): Promise<void>`, `get(key): Promise<{ bytes, mime }>`.
- Produces: `makeBlobStore(): BlobStore` — `VercelBlobStore` iff `process.env.BLOB_READ_WRITE_TOKEN` is set, else `LocalBlobStore(process.env.BLOB_DIR ?? '.blob-store')`.

- [ ] **Step 1: Write the failing factory test**

`tests/blob/factory.test.ts`:

```typescript
import { afterEach, expect, test } from 'vitest';
import { makeBlobStore } from '../../src/blob/factory.js';
import { LocalBlobStore } from '../../src/blob/blob-store.js';
import { VercelBlobStore } from '../../src/blob/vercel-blob-store.js';

const saved = process.env.BLOB_READ_WRITE_TOKEN;
afterEach(() => {
  if (saved === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
  else process.env.BLOB_READ_WRITE_TOKEN = saved;
});

test('returns LocalBlobStore without a Vercel token', () => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  expect(makeBlobStore()).toBeInstanceOf(LocalBlobStore);
});

test('returns VercelBlobStore when BLOB_READ_WRITE_TOKEN is set', () => {
  process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_test_token';
  expect(makeBlobStore()).toBeInstanceOf(VercelBlobStore);
});
```

Run: `npx vitest run tests/blob/factory.test.ts` — expected FAIL (modules missing).

- [ ] **Step 2: Install dep and implement**

Run: `cd web && npm install @vercel/blob` (the SDK lives in web's node_modules; `src/` files that import it are only ever executed by the web app — same situation as other `@domain` code — but vitest at the root must not need it, so the factory imports `VercelBlobStore` statically only if that keeps root tests green; if root vitest fails to resolve `@vercel/blob`, make `vercel-blob-store.ts` import it lazily inside methods via `await import('@vercel/blob')` and keep the constructor dependency-free).

`src/blob/vercel-blob-store.ts` — reference implementation; **verify the exact API against the installed SDK** (`web/node_modules/@vercel/blob/dist/*.d.ts`) and adapt — the SDK's option names and access modes change between versions:

```typescript
import type { BlobStore } from './blob-store.js';

/**
 * Vercel Blob-backed store. Keys map 1:1 to blob pathnames, so existing DB
 * references keep working. Requires BLOB_READ_WRITE_TOKEN (Vercel injects it).
 * Objects must not be publicly guessable: prefer private access if the
 * installed SDK supports it; otherwise rely on unguessable random-suffix URLs
 * and never expose the URL outside the server.
 */
export class VercelBlobStore implements BlobStore {
  async put(key: string, bytes: Buffer, mime: string): Promise<void> {
    const { put } = await import('@vercel/blob');
    await put(key, bytes, { access: 'public', contentType: mime, addRandomSuffix: false, allowOverwrite: true });
  }

  async get(key: string): Promise<{ bytes: Buffer; mime: string }> {
    const { list } = await import('@vercel/blob');
    const { blobs } = await list({ prefix: key, limit: 1 });
    const hit = blobs.find((b) => b.pathname === key);
    if (!hit) throw new Error(`blob not found: ${key}`);
    const res = await fetch(hit.url);
    if (!res.ok) throw new Error(`blob fetch failed: ${res.status}`);
    return { bytes: Buffer.from(await res.arrayBuffer()), mime: res.headers.get('content-type') ?? 'application/octet-stream' };
  }
}
```

`src/blob/factory.ts`:

```typescript
import { type BlobStore, LocalBlobStore } from './blob-store.js';
import { VercelBlobStore } from './vercel-blob-store.js';

/** Vercel Blob when the platform token is present, local filesystem otherwise (dev/tests). */
export function makeBlobStore(): BlobStore {
  if (process.env.BLOB_READ_WRITE_TOKEN) return new VercelBlobStore();
  return new LocalBlobStore(process.env.BLOB_DIR ?? '.blob-store');
}
```

Switch the three web call sites from `new LocalBlobStore(process.env.BLOB_DIR ?? '.blob-store')` to `makeBlobStore()` (import `{ makeBlobStore } from '@domain/blob/factory.js'`, drop the `LocalBlobStore` import).

- [ ] **Step 3: Tests + typechecks + build, commit**

Run: `npm test && npx tsc --noEmit && (cd web && npx tsc --noEmit && npm run build)`
Expected: PASS. If root `tsc` cannot resolve `@vercel/blob` types, add `// @ts-expect-error` is NOT acceptable — instead type the dynamic import loosely (`const { put } = (await import('@vercel/blob')) as any`) and note it; the real type-check happens in web's tsc which has the dependency.

```bash
git add src/blob/vercel-blob-store.ts src/blob/factory.ts tests/blob/factory.test.ts web/app/api/documents/capture/route.ts web/app/api/invoice-profile/logo/route.ts "web/app/invoice-document/[id]/page.tsx" web/package.json web/package-lock.json
git commit -m "feat(blob): Vercel Blob store behind BlobStore factory (durable uploads)"
```

---

### Task 6: Hardening — headers, pool tuning, bootstrap guard, health route, provision script

**Files:**
- Modify: `web/next.config.ts` (headers), `src/db/pool.ts` (tuning), `web/app/api/dev/bootstrap/route.ts` (VERCEL_ENV guard)
- Create: `web/app/api/health/route.ts`, `src/dev/provision-admin.ts`
- Modify: `package.json` (script), `.env.example` (sslmode + new vars docs)
- Test: `tests/db/pool-config.test.ts`

**Interfaces:**
- Produces: `GET /api/health` → 200 `{ ok: true }` / 503 `{ ok: false }`; `npm run provision-admin` (env: `PROVISION_FIRM`, `PROVISION_EMAIL`) → prints a one-time invite path.

- [ ] **Step 1: Pool tuning (+ test first)**

`tests/db/pool-config.test.ts`:

```typescript
import { expect, test } from 'vitest';
import { appPool, adminPool } from '../../src/db/pool.js';

test('pools are tuned for serverless (bounded, with timeouts)', () => {
  for (const pool of [appPool, adminPool]) {
    expect(pool.options.max).toBe(5);
    expect(pool.options.connectionTimeoutMillis).toBe(10_000);
    expect(pool.options.idleTimeoutMillis).toBe(30_000);
  }
});
```

Run (expect FAIL), then change `src/db/pool.ts:4-5`:

```typescript
const poolConfig = { max: 5, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 };
export const adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL, ...poolConfig });
export const appPool = new Pool({ connectionString: process.env.DATABASE_URL, ...poolConfig });
```

Re-run: PASS.

- [ ] **Step 2: Security headers**

In `web/next.config.ts`, add to the config object (keep existing `experimental`/`webpack` keys):

```typescript
  async headers() {
    return [{
      source: '/(.*)',
      headers: [
        { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      ],
    }];
  },
```

- [ ] **Step 3: Bootstrap guard**

In `web/app/api/dev/bootstrap/route.ts`, extend the guard:

```typescript
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV) {
    return NextResponse.json({ error: 'not available in production' }, { status: 403 });
  }
```

- [ ] **Step 4: Health route**

`web/app/api/health/route.ts`:

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { appPool } from '@domain/db/pool.js';

export async function GET() {
  try {
    await appPool.query('SELECT 1');
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
```

- [ ] **Step 5: Provision script**

`src/dev/provision-admin.ts` (mirrors `seed.ts`'s CLI style — check its imports for `createFirm`):

```typescript
import { appPool, adminPool } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';
import { createFirm } from '../tenancy/firms.js';
import { createUser, findUserByEmail } from '../auth/users.js';
import { createInvite } from '../auth/invites.js';
import { randomBytes } from 'node:crypto';

/**
 * One-off production provisioning: creates the firm + first firm_admin and
 * prints a one-time invite path. Idempotent on email: re-running re-invites.
 * Usage: PROVISION_FIRM="My Firm" PROVISION_EMAIL=me@firm.lv npm run provision-admin
 */
async function main() {
  const firmName = process.env.PROVISION_FIRM;
  const email = process.env.PROVISION_EMAIL;
  if (!firmName || !email) throw new Error('Set PROVISION_FIRM and PROVISION_EMAIL');
  await runMigrations();

  let user = await findUserByEmail(email);
  let userId: string;
  if (user) {
    userId = user.id;
    console.log(`User ${email} exists — issuing a credential-reset invite.`);
  } else {
    const firm = await createFirm(firmName);
    const created = await createUser({ firmId: firm.id, email, password: randomBytes(24).toString('hex'), role: 'firm_admin' });
    userId = created.id;
    console.log(`Created firm "${firmName}" and firm_admin ${email}.`);
  }
  const { token, expiresAtIso } = await createInvite(userId, userId, Math.floor(Date.now() / 1000));
  console.log(`\nInvite path (valid until ${expiresAtIso}, single use):\n  /invite/${token}\n`);
  console.log('Open it as https://<your-deployment>/invite/<token>');
}

main()
  .then(async () => { await Promise.all([appPool.end(), adminPool.end()]); })
  .catch((e) => { console.error(e); process.exit(1); });
```

Add to root `package.json` scripts: `"provision-admin": "node --env-file=.env --import tsx src/dev/provision-admin.ts"`.

- [ ] **Step 6: .env.example docs**

Append to `.env.example`:

```
# Production (Vercel + Neon):
#  - DATABASE_URL: Neon POOLED endpoint + ?sslmode=require (runtime, role bookkeeping_app)
#  - ADMIN_DATABASE_URL: Neon DIRECT endpoint + ?sslmode=require (migrations/provisioning only)
#  - BLOB_READ_WRITE_TOKEN: enables Vercel Blob for uploads (auto-injected by Vercel)
#  - GEMINI_API_KEY: free-tier AI extraction. Caveat: free tier may retain/train on data —
#    switch to ANTHROPIC_API_KEY (takes precedence) before processing sensitive client documents.
```

- [ ] **Step 7: Verify + commit**

Run: `npm test && npx tsc --noEmit && (cd web && npx tsc --noEmit && npm run build)`
Then end-to-end locally: `PROVISION_FIRM="Smoke Firm" PROVISION_EMAIL=smoke@t.lv npm run provision-admin` → open the printed path on the dev server → set password + scan/enter TOTP → activate → log in. Record the outcome in the report.

```bash
git add web/next.config.ts src/db/pool.ts web/app/api/dev/bootstrap/route.ts web/app/api/health/route.ts src/dev/provision-admin.ts package.json .env.example tests/db/pool-config.test.ts
git commit -m "feat(ops): security headers, pool tuning, health route, admin provisioning"
```

---

### Task 7: Deploy runbook

**Files:**
- Modify: `docs/RUNNING.md` §3 (replace the generic Vercel section with the Neon+Blob walkthrough)
- Modify: `HANDOFF.md` (mark the production-readiness blockers/gaps closed with date; reference `docs/audit/PRODUCTION-READINESS.md`)

- [ ] **Step 1: Rewrite RUNNING.md §3** with the concrete sequence: Neon project creation (free tier), two connection strings (pooled → `DATABASE_URL`, direct → `ADMIN_DATABASE_URL`, both `?sslmode=require`), `npm run migrate` locally against the direct URL, Vercel project (Root Directory `web`), env vars incl. `BLOB_READ_WRITE_TOKEN` (from the Vercel Blob store creation) and `GEMINI_API_KEY` (+ the retention caveat), deploy, `npm run provision-admin` against prod env, open the invite URL, smoke-test checklist (login → upload a document → issue an invoice → **re-upload the invoice logo and immediately view an invoice document to confirm the new logo renders (blob cache-bypass check)** → `GET /api/health`), backup note (Neon PITR; scheduled `pg_dump` before data volume grows). Content should be copy-paste runnable; no placeholders except `<your-deployment>` hostnames.
- [ ] **Step 2: Update HANDOFF.md** — under the cross-cutting section, mark: rate limiting ✅ (2026-07-18), user provisioning/2FA enrolment ✅, blob durability ✅, health route ✅; note what remains open (GDPR, audit hash chain, session cleanup, e-signature).
- [ ] **Step 3: Commit**

```bash
git add docs/RUNNING.md HANDOFF.md
git commit -m "docs: Neon+Vercel deploy runbook; mark production-readiness gaps closed"
```

---

### Task 8: Full verification

- [ ] **Step 1:** `npm test` (root) — all pass.
- [ ] **Step 2:** `npx tsc --noEmit && (cd web && npx tsc --noEmit && npm run build)` — clean.
- [ ] **Step 3:** `npx vitest run tests/db/migration-numbering.test.ts` — the 033/034 additions pass the collision guard.
- [ ] **Step 4:** Fresh-database drill: `npm run seed`, log in as the seeded accountant on the dev server, confirm the app still works end-to-end (queue, documents, reports load).

---

## Out of scope (per spec)

Email sending, GDPR export/erasure, audit hash-chain, session-row cleanup job, app-level field encryption, Peppol/VID wiring, session cookie rotation.
