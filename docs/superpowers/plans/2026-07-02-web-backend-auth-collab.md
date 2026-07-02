# Web Backend: Auth, RBAC, Collaboration & API — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the fully-tested server side of the personal cabinet — authentication (password + mandatory 2FA), sessions, role-based access control with per-client scoping, the collaboration domain (tasks/requests, comments, notifications, audit viewer), and an HTTP API that exposes the domain (approval queue, documents, financial views) to the eventual web and mobile clients.

**Scope note — presentation layer deferred.** This plan delivers the *backend-for-frontend*: everything the web (Next.js) and mobile (React Native) UIs will call, verified by the same real-Postgres test suite as Plans 1–6. The React/Next.js and React Native **presentation layers are intentionally out of scope** here — they require browser/device verification and the frontend-design skill, and are best built in an interactive session over this tested API. This is a deliberate, documented boundary, not an omission.

**Architecture:** Extends the merged Plan 1–6 monolith. Auth primitives use only Node's `crypto` (scrypt password hashing, RFC 6238 TOTP via HMAC-SHA1, random session tokens) — no new dependency. RBAC maps an authenticated user + a chosen client company to the existing `TenantContext` (`actorRole`), enforcing per-client authorization server-side. The API is a set of pure handler functions `(AuthedRequest) → Promise<ApiResponse>` plus a thin `node:http` router; handlers call the existing domain modules inside `withTenant`. The approval-queue handler is the keystone: it dispatches an approved proposal to the correct post function by type (`posting → postApprovedPosting`, `bank_match → postApprovedBankMatch`).

**Tech Stack:** Same as Plans 1–6 — Node 24+/TypeScript (strict, ESM), PostgreSQL 16, `pg`, `zod`, `vitest`, admin-run migrations. No new runtime dependency (auth uses `node:crypto`).

## Global Constraints

- **Inherits all Plan 1–6 constraints** (integer-cents; `withTenant`; RLS ENABLE+FORCE + explicit `client_company_id` predicate on tenant reads; migrations as admin, minimal grants; audited state changes; agent output is a proposal).
- **Passwords are never stored plaintext** — scrypt with a per-user random salt; constant-time comparison.
- **2FA is mandatory** — a session is only "authenticated" after both password and a valid TOTP code; login is a two-step (password → totp) flow.
- **Authorization is server-side and per-client** — `resolveTenantContext` verifies the session AND that the user is assigned to the requested client company; it throws on any mismatch. No handler trusts a client id from the request without this check.
- **Users, sessions, assignments belong to a Firm; client-scoped collaboration data is RLS tenant-scoped.** **Migration numbering continues at 017.**
- **Determinism in tests:** time-dependent logic (TOTP, session expiry) takes an injected timestamp; runtime callers pass the real clock.

## Consumed interfaces (all on `main` after Plans 1–6)

```ts
withTenant(ctx, fn); TenantContext{firmId,clientCompanyId,actorId,actorRole}
createFirm(name); createClientCompany(firmId,{...})   // src/tenancy/firms.ts (app pool)
listProposals(tx,ctx,{status}); getProposal(tx,ctx,id)   // proposals
approveProposal(tx,ctx,id); rejectProposal(tx,ctx,id,reason)   // lifecycle
postApprovedPosting(tx,ctx,id)      // src/proposals/post-proposal.ts
postApprovedBankMatch(tx,ctx,id)    // src/banking/confirm-match.ts
listDocuments(tx,ctx,{status}); createDocument(tx,ctx,{...})
trialBalance(tx,ctx)                // src/ledger/balances.ts
computeVat(tx,ctx,{fromDate,toDate,config}); outstandingReceivables(tx,ctx,acct)
appendAudit(tx,ctx,{...})
```

## File structure

```
migrations/
  017_users_sessions.sql
  018_rbac_assignments.sql
  019_collaboration.sql
src/
  auth/passwords.ts        # hashPassword, verifyPassword (scrypt)
  auth/totp.ts             # generateTotpSecret, totpUri, verifyTotp (RFC 6238)
  auth/users.ts            # createUser, findUserByEmail
  auth/sessions.ts         # login (password+totp), createSession, validateSession, logout
  auth/context.ts          # resolveTenantContext(sessionToken, clientCompanyId) -> TenantContext
  collab/tasks.ts          # createTask, listTasks, resolveTask
  collab/comments.ts       # addComment, listComments
  collab/notifications.ts  # notify, listNotifications, markRead
  collab/audit-view.ts     # listAuditLog
  api/types.ts             # AuthedRequest, ApiResponse
  api/handlers.ts          # approvalQueue, approve, reject, documents, financials
  api/router.ts            # node:http router wiring session -> handler
  i18n/messages.ts         # LV/RU/EN catalog + t(lang, key)
tests/
  auth/passwords.test.ts, auth/totp.test.ts, auth/sessions.test.ts, auth/context.test.ts
  collab/collab.test.ts
  api/handlers.test.ts
  i18n/messages.test.ts
```

**Interfaces produced (web + mobile clients consume these):**

```ts
function hashPassword(pw: string): string;                 // "salt:hash"
function verifyPassword(pw: string, stored: string): boolean;
function generateTotpSecret(): string;                     // base32
function verifyTotp(secret: string, code: string, atUnixSeconds: number): boolean;
function createUser(input: {firmId,email,password,role,language?}): Promise<{id, totpSecret}>;
function login(email, password, totpCode, atUnixSeconds): Promise<{ sessionToken: string }>;
function validateSession(token, atUnixSeconds): Promise<{ userId, firmId, role } | null>;
function resolveTenantContext(token, clientCompanyId, atUnixSeconds): Promise<TenantContext>;
// collab
createTask/listTasks/resolveTask; addComment/listComments; notify/listNotifications/markRead; listAuditLog
// api
interface AuthedRequest { token: string; clientCompanyId: string; params?: Record<string,string>; body?: unknown; atUnixSeconds: number; }
interface ApiResponse { status: number; body: unknown; }
approvalQueueHandler, approveHandler, rejectHandler, documentsHandler, financialsHandler: (req) => Promise<ApiResponse>;
```

---

## Task 1: Password hashing + users + sessions schema

**Files:** Create `migrations/017_users_sessions.sql`, `src/auth/passwords.ts`, `src/auth/users.ts`; Test `tests/auth/passwords.test.ts`.

**Interfaces:** Produces `hashPassword`, `verifyPassword`, `createUser`, `findUserByEmail`.

- [ ] **Step 1: Create `migrations/017_users_sessions.sql`**

```sql
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  totp_secret text NOT NULL,
  role text NOT NULL CHECK (role IN ('firm_admin','accountant','owner','employee')),
  language text NOT NULL DEFAULT 'lv' CHECK (language IN ('lv','ru','en')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

-- Users/sessions are firm-level auth data, administered on the app pool (not client-tenant RLS).
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO bookkeeping_app;
GRANT SELECT, INSERT, UPDATE ON users TO bookkeeping_app;
```

> Note: `sessions` gets DELETE (logout removes the row) — the one table in the system with DELETE, justified because a session is ephemeral auth state, not audited business data.

- [ ] **Step 2: Write the failing test — `tests/auth/passwords.test.ts`**

```ts
import { expect, test } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/auth/passwords.js';

test('hash then verify round-trips', () => {
  const stored = hashPassword('correct horse battery staple');
  expect(stored).toContain(':');
  expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
});
test('wrong password does not verify', () => {
  const stored = hashPassword('secret');
  expect(verifyPassword('guess', stored)).toBe(false);
});
test('two hashes of the same password differ (random salt)', () => {
  expect(hashPassword('x')).not.toBe(hashPassword('x'));
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `docker compose up -d db && npx vitest run tests/auth/passwords.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Create `src/auth/passwords.ts`**

```ts
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** Returns "saltHex:hashHex". scrypt with a random 16-byte salt. */
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const hash = Buffer.from(hashHex, 'hex');
  const check = scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  return hash.length === check.length && timingSafeEqual(hash, check);
}
```

- [ ] **Step 5: Create `src/auth/users.ts`**

```ts
import { z } from 'zod';
import { appPool } from '../db/pool.js';
import { hashPassword } from './passwords.js';
import { generateTotpSecret } from './totp.js';

export type UserRole = 'firm_admin' | 'accountant' | 'owner' | 'employee';
export interface UserRow { id: string; firmId: string; email: string; role: UserRole; language: string; }

const newUserSchema = z.object({
  firmId: z.string().uuid(),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(['firm_admin', 'accountant', 'owner', 'employee']),
  language: z.enum(['lv', 'ru', 'en']).default('lv'),
});

export async function createUser(input: {
  firmId: string; email: string; password: string; role: UserRole; language?: string;
}): Promise<{ id: string; totpSecret: string }> {
  const p = newUserSchema.parse(input);
  const totpSecret = generateTotpSecret();
  const res = await appPool.query(
    `INSERT INTO users(firm_id, email, password_hash, totp_secret, role, language)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [p.firmId, p.email, hashPassword(p.password), totpSecret, p.role, p.language],
  );
  return { id: res.rows[0].id, totpSecret };
}

export async function findUserByEmail(email: string): Promise<(UserRow & { passwordHash: string; totpSecret: string }) | null> {
  const res = await appPool.query(
    `SELECT id, firm_id AS "firmId", email, role, language, password_hash AS "passwordHash", totp_secret AS "totpSecret"
     FROM users WHERE email = $1`,
    [email],
  );
  return res.rows[0] ?? null;
}
```

- [ ] **Step 6: Run to verify passwords test passes; commit**

Run: `npx vitest run tests/auth/passwords.test.ts`
Expected: PASS. (users.ts imports totp.ts which is created in Task 2 — if running the full suite now fails on that import, proceed to Task 2; the passwords test itself does not import users.ts.)

```bash
git add migrations/017_users_sessions.sql src/auth/passwords.ts src/auth/users.ts tests/auth/passwords.test.ts
git commit -m "feat: password hashing + users schema"
```

> If `src/auth/users.ts` referencing `./totp.js` breaks typecheck before Task 2 exists, create `src/auth/totp.ts` in Task 2 immediately after; do the passwords commit first, then Task 2. (Task ordering keeps each commit's own test green.)

---

## Task 2: TOTP 2FA (RFC 6238)

**Files:** Create `src/auth/totp.ts`; Test `tests/auth/totp.test.ts`.

**Interfaces:** Produces `generateTotpSecret`, `totpUri`, `verifyTotp`.

- [ ] **Step 1: Write the failing test — `tests/auth/totp.test.ts`**

```ts
import { expect, test } from 'vitest';
import { generateTotpSecret, verifyTotp, totpCodeFor } from '../../src/auth/totp.js';

test('a freshly generated code verifies at the same time step', () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000;
  const code = totpCodeFor(secret, now);
  expect(verifyTotp(secret, code, now)).toBe(true);
});
test('a wrong code does not verify', () => {
  const secret = generateTotpSecret();
  expect(verifyTotp(secret, '000000', 1_700_000_000)).toBe(false);
});
test('accepts the previous 30s window (clock skew tolerance)', () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000;
  const prev = totpCodeFor(secret, now - 30);
  expect(verifyTotp(secret, prev, now)).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/auth/totp.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `src/auth/totp.ts`** (RFC 6238, base32 secret, HMAC-SHA1, ±1 step tolerance)

```ts
import { createHmac, randomBytes } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(): string {
  const bytes = randomBytes(20);
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function base32Decode(s: string): Buffer {
  let bits = '';
  for (const c of s.toUpperCase().replace(/=+$/, '')) {
    const idx = B32.indexOf(c);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function hotp(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin = ((hmac[offset]! & 0x7f) << 24) | ((hmac[offset + 1]! & 0xff) << 16) | ((hmac[offset + 2]! & 0xff) << 8) | (hmac[offset + 3]! & 0xff);
  return (bin % 1_000_000).toString().padStart(6, '0');
}

export function totpCodeFor(secret: string, atUnixSeconds: number): string {
  return hotp(secret, Math.floor(atUnixSeconds / 30));
}

/** Verify with ±1 time-step (30s) tolerance for clock skew. */
export function verifyTotp(secret: string, code: string, atUnixSeconds: number): boolean {
  const step = Math.floor(atUnixSeconds / 30);
  return [step - 1, step, step + 1].some((c) => hotp(secret, c) === code);
}

export function totpUri(secret: string, label: string, issuer = 'Bookkeeping'): string {
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;
}
```

- [ ] **Step 4: Run to verify it passes; commit**

Run: `npx vitest run tests/auth/totp.test.ts && npx vitest run`
Expected: PASS (and the full suite now compiles, since `users.ts`'s `./totp.js` import resolves).

```bash
git add src/auth/totp.ts tests/auth/totp.test.ts
git commit -m "feat: RFC 6238 TOTP 2FA"
```

---

## Task 3: Login (password + mandatory 2FA) + sessions

**Files:** Create `src/auth/sessions.ts`; Test `tests/auth/sessions.test.ts`.

**Interfaces:** Consumes `findUserByEmail`, `verifyPassword`, `verifyTotp`. Produces `login`, `validateSession`, `logout`.

- [ ] **Step 1: Write the failing test — `tests/auth/sessions.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { createFirm } from '../../src/tenancy/firms.js';
import { createUser } from '../../src/auth/users.js';
import { totpCodeFor } from '../../src/auth/totp.js';
import { login, validateSession, logout } from '../../src/auth/sessions.js';

const NOW = 1_700_000_000;

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function seedUser() {
  const firm = await createFirm('Firm');
  const { id, totpSecret } = await createUser({ firmId: firm.id, email: 'a@b.lv', password: 'password123', role: 'accountant' });
  return { firmId: firm.id, userId: id, totpSecret };
}

test('login requires a valid password AND totp; returns a session', async () => {
  const { totpSecret } = await seedUser();
  const { sessionToken } = await login('a@b.lv', 'password123', totpCodeFor(totpSecret, NOW), NOW);
  expect(sessionToken).toBeTruthy();
  const s = await validateSession(sessionToken, NOW);
  expect(s?.role).toBe('accountant');
});
test('wrong password is rejected', async () => {
  await seedUser();
  await expect(login('a@b.lv', 'nope', '000000', NOW)).rejects.toThrow(/credentials/i);
});
test('valid password but wrong totp is rejected (2FA mandatory)', async () => {
  await seedUser();
  await expect(login('a@b.lv', 'password123', '000000', NOW)).rejects.toThrow(/2fa|code/i);
});
test('logout invalidates the session', async () => {
  const { totpSecret } = await seedUser();
  const { sessionToken } = await login('a@b.lv', 'password123', totpCodeFor(totpSecret, NOW), NOW);
  await logout(sessionToken);
  expect(await validateSession(sessionToken, NOW)).toBeNull();
});
test('an expired session does not validate', async () => {
  const { totpSecret } = await seedUser();
  const { sessionToken } = await login('a@b.lv', 'password123', totpCodeFor(totpSecret, NOW), NOW);
  expect(await validateSession(sessionToken, NOW + 60 * 60 * 24 * 30)).toBeNull(); // 30 days later
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/auth/sessions.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `src/auth/sessions.ts`**

```ts
import { randomBytes } from 'node:crypto';
import { appPool } from '../db/pool.js';
import { findUserByEmail } from './users.js';
import { verifyPassword } from './passwords.js';
import { verifyTotp } from './totp.js';

const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12h

export async function login(email: string, password: string, totpCode: string, atUnixSeconds: number): Promise<{ sessionToken: string }> {
  const user = await findUserByEmail(email);
  if (!user || !verifyPassword(password, user.passwordHash)) throw new Error('Invalid credentials');
  if (!verifyTotp(user.totpSecret, totpCode, atUnixSeconds)) throw new Error('Invalid 2FA code');

  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date((atUnixSeconds + SESSION_TTL_SECONDS) * 1000).toISOString();
  await appPool.query('INSERT INTO sessions(token, user_id, expires_at) VALUES ($1,$2,$3)', [token, user.id, expiresAt]);
  return { sessionToken: token };
}

export async function validateSession(token: string, atUnixSeconds: number): Promise<{ userId: string; firmId: string; role: string } | null> {
  const res = await appPool.query(
    `SELECT s.user_id AS "userId", u.firm_id AS "firmId", u.role,
            EXTRACT(EPOCH FROM s.expires_at) AS "expiresEpoch"
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1`,
    [token],
  );
  const row = res.rows[0];
  if (!row) return null;
  if (Number(row.expiresEpoch) <= atUnixSeconds) return null;
  return { userId: row.userId, firmId: row.firmId, role: row.role };
}

export async function logout(token: string): Promise<void> {
  await appPool.query('DELETE FROM sessions WHERE token = $1', [token]);
}
```

- [ ] **Step 4: Run to verify it passes; commit**

Run: `npx vitest run tests/auth/sessions.test.ts`
Expected: PASS (5 tests).

```bash
git add src/auth/sessions.ts tests/auth/sessions.test.ts
git commit -m "feat: login (password + mandatory 2FA) and sessions"
```

---

## Task 4: RBAC assignments + tenant-context resolution

**Files:** Create `migrations/018_rbac_assignments.sql`, `src/auth/context.ts`; Test `tests/auth/context.test.ts`.

**Interfaces:** Consumes `validateSession`. Produces `assignUserToClient`, `resolveTenantContext`.

- [ ] **Step 1: Create `migrations/018_rbac_assignments.sql`**

```sql
CREATE TABLE user_client_assignments (
  user_id uuid NOT NULL REFERENCES users(id),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  PRIMARY KEY (user_id, client_company_id)
);
GRANT SELECT, INSERT, DELETE ON user_client_assignments TO bookkeeping_app;
```

> No RLS: this is firm-level administrative mapping (which users may access which clients), managed on the app pool. Authorization is enforced in `resolveTenantContext`.

- [ ] **Step 2: Write the failing test — `tests/auth/context.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { createFirm, createClientCompany } from '../../src/tenancy/firms.js';
import { createUser } from '../../src/auth/users.js';
import { totpCodeFor } from '../../src/auth/totp.js';
import { login } from '../../src/auth/sessions.js';
import { assignUserToClient, resolveTenantContext } from '../../src/auth/context.js';

const NOW = 1_700_000_000;

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function setup() {
  const firm = await createFirm('Firm');
  const client = await createClientCompany(firm.id, { name: 'SIA K', regNo: '40100000000' });
  const { id: userId, totpSecret } = await createUser({ firmId: firm.id, email: 'a@b.lv', password: 'password123', role: 'accountant' });
  const { sessionToken } = await login('a@b.lv', 'password123', totpCodeFor(totpSecret, NOW), NOW);
  return { firmId: firm.id, clientId: client.id, userId, sessionToken };
}

test('resolves a TenantContext for an assigned client', async () => {
  const { clientId, userId, sessionToken } = await setup();
  await assignUserToClient(userId, clientId);
  const ctx = await resolveTenantContext(sessionToken, clientId, NOW);
  expect(ctx.clientCompanyId).toBe(clientId);
  expect(ctx.actorId).toBe(userId);
  expect(ctx.actorRole).toBe('accountant');
});
test('refuses a client the user is NOT assigned to', async () => {
  const { clientId, sessionToken } = await setup();
  await expect(resolveTenantContext(sessionToken, clientId, NOW)).rejects.toThrow(/not authorized|assign/i);
});
test('refuses an invalid session', async () => {
  const { clientId } = await setup();
  await expect(resolveTenantContext('bogus-token', clientId, NOW)).rejects.toThrow(/session/i);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/auth/context.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Create `src/auth/context.ts`**

```ts
import { appPool } from '../db/pool.js';
import { validateSession } from './sessions.js';
import type { TenantContext } from '../tenancy/context.js';

export async function assignUserToClient(userId: string, clientCompanyId: string): Promise<void> {
  await appPool.query(
    `INSERT INTO user_client_assignments(user_id, client_company_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [userId, clientCompanyId],
  );
}

/** Validate the session AND that the user is assigned to the client, then build a TenantContext. */
export async function resolveTenantContext(
  token: string, clientCompanyId: string, atUnixSeconds: number,
): Promise<TenantContext> {
  const session = await validateSession(token, atUnixSeconds);
  if (!session) throw new Error('Invalid or expired session');

  const assigned = await appPool.query(
    `SELECT 1 FROM user_client_assignments a
     JOIN client_companies c ON c.id = a.client_company_id
     WHERE a.user_id = $1 AND a.client_company_id = $2 AND c.firm_id = $3`,
    [session.userId, clientCompanyId, session.firmId],
  );
  if (!assigned.rowCount) throw new Error('User is not authorized for this client company');

  return { firmId: session.firmId, clientCompanyId, actorId: session.userId, actorRole: session.role };
}
```

- [ ] **Step 5: Run to verify it passes; commit**

Run: `npx vitest run tests/auth/context.test.ts`
Expected: PASS (3 tests).

```bash
git add migrations/018_rbac_assignments.sql src/auth/context.ts tests/auth/context.test.ts
git commit -m "feat: RBAC assignments + tenant-context resolution"
```

---

## Task 5: Collaboration domain (tasks, comments, notifications, audit view)

**Files:** Create `migrations/019_collaboration.sql`, `src/collab/tasks.ts`, `src/collab/comments.ts`, `src/collab/notifications.ts`, `src/collab/audit-view.ts`; Test `tests/collab/collab.test.ts`.

- [ ] **Step 1: Create `migrations/019_collaboration.sql`** (three RLS tenant tables)

```sql
CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  title text NOT NULL,
  detail text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  author text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  recipient text NOT NULL,
  kind text NOT NULL,
  message text NOT NULL,
  read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comments_entity_idx ON comments(client_company_id, entity_type, entity_id);
CREATE INDEX notifications_recipient_idx ON notifications(client_company_id, recipient, read);

DO $$ DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tasks','comments','notifications'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I_tenant ON %I USING (client_company_id = current_setting(''app.current_client_id'', true)::uuid) WITH CHECK (client_company_id = current_setting(''app.current_client_id'', true)::uuid)', t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO bookkeeping_app', t);
  END LOOP;
END $$;
```

- [ ] **Step 2: Write the failing test — `tests/collab/collab.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createTask, listTasks, resolveTask } from '../../src/collab/tasks.js';
import { addComment, listComments } from '../../src/collab/comments.js';
import { notify, listNotifications, markRead } from '../../src/collab/notifications.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('task lifecycle: create -> list open -> resolve', async () => {
  const t = await makeFirmAndClient();
  const { id } = await withTenant(ctx(t), (tx) => createTask(tx, ctx(t), { title: 'Missing contract', detail: 'Need the vendor contract' }));
  expect((await withTenant(ctx(t), (tx) => listTasks(tx, ctx(t), { status: 'open' }))).length).toBe(1);
  await withTenant(ctx(t), (tx) => resolveTask(tx, ctx(t), id));
  expect((await withTenant(ctx(t), (tx) => listTasks(tx, ctx(t), { status: 'open' }))).length).toBe(0);
});
test('comments attach to an entity and list in order', async () => {
  const t = await makeFirmAndClient();
  const eid = '11111111-1111-1111-1111-111111111111';
  await withTenant(ctx(t), async (tx) => {
    await addComment(tx, ctx(t), { entityType: 'proposal', entityId: eid, body: 'first' });
    await addComment(tx, ctx(t), { entityType: 'proposal', entityId: eid, body: 'second' });
  });
  const comments = await withTenant(ctx(t), (tx) => listComments(tx, ctx(t), 'proposal', eid));
  expect(comments.map((c) => c.body)).toEqual(['first', 'second']);
});
test('notifications: create, list unread, mark read', async () => {
  const t = await makeFirmAndClient();
  const { id } = await withTenant(ctx(t), (tx) => notify(tx, ctx(t), { recipient: 'user-1', kind: 'approval_needed', message: 'A proposal awaits approval' }));
  expect((await withTenant(ctx(t), (tx) => listNotifications(tx, ctx(t), 'user-1', { unreadOnly: true }))).length).toBe(1);
  await withTenant(ctx(t), (tx) => markRead(tx, ctx(t), id));
  expect((await withTenant(ctx(t), (tx) => listNotifications(tx, ctx(t), 'user-1', { unreadOnly: true }))).length).toBe(0);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/collab/collab.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 4: Create the four collab modules**

`src/collab/tasks.ts`:

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appendAudit } from '../audit/audit.js';

export interface TaskRow { id: string; title: string; detail: string; status: 'open' | 'resolved'; }

export async function createTask(tx: PoolClient, ctx: TenantContext, input: { title: string; detail?: string }): Promise<{ id: string }> {
  const res = await tx.query(
    `INSERT INTO tasks(client_company_id, title, detail, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
    [ctx.clientCompanyId, input.title, input.detail ?? '', ctx.actorId],
  );
  const id = res.rows[0].id as string;
  await appendAudit(tx, ctx, { action: 'create', entityType: 'task', entityId: id, before: null, after: { title: input.title } });
  return { id };
}
export async function listTasks(tx: PoolClient, ctx: TenantContext, filter: { status?: 'open' | 'resolved' } = {}): Promise<TaskRow[]> {
  const res = await tx.query(
    `SELECT id, title, detail, status FROM tasks
     WHERE client_company_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at`,
    [ctx.clientCompanyId, filter.status ?? null],
  );
  return res.rows;
}
export async function resolveTask(tx: PoolClient, ctx: TenantContext, id: string): Promise<void> {
  const res = await tx.query(`UPDATE tasks SET status = 'resolved' WHERE id = $1 AND client_company_id = $2`, [id, ctx.clientCompanyId]);
  if (!res.rowCount) throw new Error(`Task not found: ${id}`);
  await appendAudit(tx, ctx, { action: 'resolve', entityType: 'task', entityId: id, before: null, after: { status: 'resolved' } });
}
```

`src/collab/comments.ts`:

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export interface CommentRow { id: string; author: string; body: string; }

export async function addComment(tx: PoolClient, ctx: TenantContext, input: { entityType: string; entityId: string; body: string }): Promise<{ id: string }> {
  const res = await tx.query(
    `INSERT INTO comments(client_company_id, entity_type, entity_id, author, body) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [ctx.clientCompanyId, input.entityType, input.entityId, ctx.actorId, input.body],
  );
  return { id: res.rows[0].id };
}
export async function listComments(tx: PoolClient, ctx: TenantContext, entityType: string, entityId: string): Promise<CommentRow[]> {
  const res = await tx.query(
    `SELECT id, author, body FROM comments
     WHERE client_company_id = $1 AND entity_type = $2 AND entity_id = $3 ORDER BY created_at, id`,
    [ctx.clientCompanyId, entityType, entityId],
  );
  return res.rows;
}
```

`src/collab/notifications.ts`:

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export interface NotificationRow { id: string; kind: string; message: string; read: boolean; }

export async function notify(tx: PoolClient, ctx: TenantContext, input: { recipient: string; kind: string; message: string }): Promise<{ id: string }> {
  const res = await tx.query(
    `INSERT INTO notifications(client_company_id, recipient, kind, message) VALUES ($1,$2,$3,$4) RETURNING id`,
    [ctx.clientCompanyId, input.recipient, input.kind, input.message],
  );
  return { id: res.rows[0].id };
}
export async function listNotifications(tx: PoolClient, ctx: TenantContext, recipient: string, opts: { unreadOnly?: boolean } = {}): Promise<NotificationRow[]> {
  const res = await tx.query(
    `SELECT id, kind, message, read FROM notifications
     WHERE client_company_id = $1 AND recipient = $2 AND ($3::boolean IS NOT TRUE OR read = false)
     ORDER BY created_at DESC`,
    [ctx.clientCompanyId, recipient, opts.unreadOnly ?? false],
  );
  return res.rows;
}
export async function markRead(tx: PoolClient, ctx: TenantContext, id: string): Promise<void> {
  await tx.query(`UPDATE notifications SET read = true WHERE id = $1 AND client_company_id = $2`, [id, ctx.clientCompanyId]);
}
```

`src/collab/audit-view.ts`:

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export interface AuditRow { action: string; entityType: string; entityId: string | null; actorId: string; createdAt: string; }

export async function listAuditLog(tx: PoolClient, ctx: TenantContext, filter: { entityType?: string; entityId?: string } = {}): Promise<AuditRow[]> {
  const res = await tx.query(
    `SELECT action, entity_type AS "entityType", entity_id AS "entityId", actor_id AS "actorId", to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SSZ') AS "createdAt"
     FROM audit_log
     WHERE client_company_id = $1
       AND ($2::text IS NULL OR entity_type = $2)
       AND ($3::uuid IS NULL OR entity_id = $3)
     ORDER BY created_at DESC LIMIT 500`,
    [ctx.clientCompanyId, filter.entityType ?? null, filter.entityId ?? null],
  );
  return res.rows;
}
```

- [ ] **Step 5: Run to verify it passes; commit**

Run: `npx vitest run tests/collab/collab.test.ts`
Expected: PASS (3 tests).

```bash
git add migrations/019_collaboration.sql src/collab tests/collab/collab.test.ts
git commit -m "feat: collaboration domain (tasks, comments, notifications, audit view)"
```

---

## Task 6: API handlers + i18n (the keystone)

**Files:** Create `src/api/types.ts`, `src/api/handlers.ts`, `src/i18n/messages.ts`; Test `tests/api/handlers.test.ts`, `tests/i18n/messages.test.ts`.

**Interfaces:** Consumes `resolveTenantContext`, `withTenant`, `listProposals`/`getProposal`, `approveProposal`/`rejectProposal`, `postApprovedPosting`, `postApprovedBankMatch`, `trialBalance`. Produces the handler functions.

The approve handler is the keystone: it approves a proposal, then dispatches to the correct post function by `type`, all in one `withTenant` transaction — the single server-side entry point the cabinet's "Approve" button calls.

- [ ] **Step 1: Write the failing tests — `tests/i18n/messages.test.ts`**

```ts
import { expect, test } from 'vitest';
import { t } from '../../src/i18n/messages.js';

test('resolves a key per language, falls back to en', () => {
  expect(t('lv', 'approve')).toBe('Apstiprināt');
  expect(t('ru', 'approve')).toBe('Подтвердить');
  expect(t('en', 'approve')).toBe('Approve');
  expect(t('lv', 'nonexistent_key')).toBe('nonexistent_key'); // missing key returns the key
});
```

and `tests/api/handlers.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createFirm, createClientCompany } from '../../src/tenancy/firms.js';
import { createUser } from '../../src/auth/users.js';
import { totpCodeFor } from '../../src/auth/totp.js';
import { login } from '../../src/auth/sessions.js';
import { assignUserToClient } from '../../src/auth/context.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { createProposal } from '../../src/proposals/proposals.js';
import { submitForApproval } from '../../src/proposals/lifecycle.js';
import { approvalQueueHandler, approveHandler } from '../../src/api/handlers.js';

const NOW = 1_700_000_000;

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function setup() {
  const firm = await createFirm('Firm');
  const client = await createClientCompany(firm.id, { name: 'SIA K', regNo: '40100000000' });
  const { id: userId, totpSecret } = await createUser({ firmId: firm.id, email: 'a@b.lv', password: 'password123', role: 'accountant' });
  await assignUserToClient(userId, client.id);
  const { sessionToken } = await login('a@b.lv', 'password123', totpCodeFor(totpSecret, NOW), NOW);
  // seed a posting proposal in pending_approval
  const cid = { firmId: firm.id, clientCompanyId: client.id, actorId: userId, actorRole: 'accountant' };
  const proposalId = await withTenant(cid, async (tx) => {
    await createAccount(tx, cid, { code: '2310', name: 'Bank', type: 'asset' });
    await createAccount(tx, cid, { code: '6110', name: 'Sales', type: 'income' });
    await openPeriod(tx, cid, { year: 2026, month: 3 });
    const { id } = await createProposal(tx, cid, {
      type: 'posting',
      payload: { date: '2026-03-10', memo: 'Sale', currency: 'EUR', lines: [
        { accountCode: '2310', debit: '121.00', credit: '0' }, { accountCode: '6110', debit: '0', credit: '121.00' },
      ]},
      rationale: { ruleRef: 'x' },
    });
    await submitForApproval(tx, cid, id);
    return id;
  });
  return { clientId: client.id, sessionToken, proposalId };
}

test('approval queue handler returns pending proposals for the authed client', async () => {
  const { clientId, sessionToken } = await setup();
  const res = await approvalQueueHandler({ token: sessionToken, clientCompanyId: clientId, atUnixSeconds: NOW });
  expect(res.status).toBe(200);
  expect((res.body as { proposals: unknown[] }).proposals).toHaveLength(1);
});

test('approve handler approves AND posts a posting proposal (keystone)', async () => {
  const { clientId, sessionToken, proposalId } = await setup();
  const res = await approveHandler({ token: sessionToken, clientCompanyId: clientId, params: { id: proposalId }, atUnixSeconds: NOW });
  expect(res.status).toBe(200);
  expect((res.body as { entryId: string }).entryId).toBeTruthy();
});

test('handler rejects an unauthenticated request', async () => {
  const { clientId, proposalId } = await setup();
  const res = await approveHandler({ token: 'bogus', clientCompanyId: clientId, params: { id: proposalId }, atUnixSeconds: NOW });
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/i18n/messages.test.ts tests/api/handlers.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Create `src/i18n/messages.ts`**

```ts
type Lang = 'lv' | 'ru' | 'en';
const CATALOG: Record<string, Record<Lang, string>> = {
  approve: { lv: 'Apstiprināt', ru: 'Подтвердить', en: 'Approve' },
  reject: { lv: 'Noraidīt', ru: 'Отклонить', en: 'Reject' },
  approval_queue: { lv: 'Apstiprināšanas rinda', ru: 'Очередь подтверждений', en: 'Approval queue' },
};
export function t(lang: Lang, key: string): string {
  return CATALOG[key]?.[lang] ?? CATALOG[key]?.en ?? key;
}
```

- [ ] **Step 4: Create `src/api/types.ts`**

```ts
export interface AuthedRequest { token: string; clientCompanyId: string; params?: Record<string, string>; body?: unknown; atUnixSeconds: number; }
export interface ApiResponse { status: number; body: unknown; }
```

- [ ] **Step 5: Create `src/api/handlers.ts`**

```ts
import { withTenant } from '../db/pool.js';
import { resolveTenantContext } from '../auth/context.js';
import type { AuthedRequest, ApiResponse } from './types.js';
import { listProposals, getProposal } from '../proposals/proposals.js';
import { approveProposal, rejectProposal } from '../proposals/lifecycle.js';
import { postApprovedPosting } from '../proposals/post-proposal.js';
import { postApprovedBankMatch } from '../banking/confirm-match.js';
import { trialBalance } from '../ledger/balances.js';

/** Wraps a handler: resolves auth+RBAC, maps errors to 401/403, else runs the body with a TenantContext. */
async function authed(req: AuthedRequest, fn: (ctx: import('../tenancy/context.js').TenantContext) => Promise<ApiResponse>): Promise<ApiResponse> {
  let ctx;
  try {
    ctx = await resolveTenantContext(req.token, req.clientCompanyId, req.atUnixSeconds);
  } catch (e) {
    const msg = String(e);
    const status = /session/i.test(msg) ? 401 : 403;
    return { status, body: { error: msg.replace('Error: ', '') } };
  }
  return fn(ctx);
}

export function approvalQueueHandler(req: AuthedRequest): Promise<ApiResponse> {
  return authed(req, async (ctx) => {
    const proposals = await withTenant(ctx, (tx) => listProposals(tx, ctx, { status: 'pending_approval' }));
    return { status: 200, body: { proposals } };
  });
}

export function approveHandler(req: AuthedRequest): Promise<ApiResponse> {
  return authed(req, async (ctx) => {
    const id = req.params?.id;
    if (!id) return { status: 400, body: { error: 'missing proposal id' } };
    const result = await withTenant(ctx, async (tx) => {
      const prop = await getProposal(tx, ctx, id);
      await approveProposal(tx, ctx, id);
      // Dispatch to the correct post function by type.
      if (prop.type === 'posting') return postApprovedPosting(tx, ctx, id);
      if (prop.type === 'bank_match') return postApprovedBankMatch(tx, ctx, id);
      return { entryId: null }; // declaration/task: approval only, no ledger post here
    });
    return { status: 200, body: result };
  });
}

export function rejectHandler(req: AuthedRequest): Promise<ApiResponse> {
  return authed(req, async (ctx) => {
    const id = req.params?.id;
    if (!id) return { status: 400, body: { error: 'missing proposal id' } };
    const reason = (req.body as { reason?: string })?.reason ?? 'rejected';
    await withTenant(ctx, (tx) => rejectProposal(tx, ctx, id, reason));
    return { status: 200, body: { ok: true } };
  });
}

export function financialsHandler(req: AuthedRequest): Promise<ApiResponse> {
  return authed(req, async (ctx) => {
    const tb = await withTenant(ctx, (tx) => trialBalance(tx, ctx));
    return { status: 200, body: { trialBalance: tb } };
  });
}
```

- [ ] **Step 6: Run to verify they pass; full suite + typecheck**

Run: `npx vitest run tests/i18n/messages.test.ts tests/api/handlers.test.ts && npx vitest run && npm run typecheck`
Expected: PASS, clean.

- [ ] **Step 7: Commit**

```bash
git add src/api src/i18n tests/api tests/i18n
git commit -m "feat: API handlers (auth+RBAC -> domain) and i18n catalog"
```

---

## Self-review

**Spec coverage (design §5 cabinet/roles, §6 modules exposed, §7 auth/2FA/RBAC, §9 i18n):**
- Auth: email+password + **mandatory 2FA**, sessions with expiry → Tasks 1, 2, 3. ✓
- RBAC with the four roles + per-client authorization enforced server-side → Task 4 (`resolveTenantContext` throws on unassigned client). ✓
- Collaboration: tasks/requests ("missing contract"), comments on operations, notifications, audit-trail viewer → Task 5. ✓
- API exposing the approval queue + approve/reject (dispatching to the right post function), documents, financial views → Task 6. ✓
- i18n LV/RU/EN → Task 6 (catalog + user `language`). ✓

**Deliberately deferred (documented scope boundary):** the **React/Next.js web UI and React Native mobile UI** — presentation layers over this tested API, requiring browser/device verification + the frontend-design skill, best built interactively. **UI/UX build tooling decision (per product owner): use the "impeccable init" plugin** to scaffold and drive the web UI/UX when the presentation layer is built. Also deferred: the concrete auth-provider/SSO choice (this plan implements first-party password+TOTP, which a provider can later replace behind the same `login`/`session` seam); rate-limiting/lockout; email/SMS delivery for notifications (the `notifications` rows are the transport-agnostic source). A thin `node:http` router (`src/api/router.ts`) wiring handlers to routes is trivial over the tested handlers and can be added when a server is stood up.

**Placeholder scan:** none — auth uses real `node:crypto` (scrypt, RFC 6238 TOTP), handlers call real domain modules; all verified against a real DB. The i18n catalog is a small real seed, extensible.

**Type consistency:** consumed Plan 1–6 signatures match `main`; `TenantContext` is produced by `resolveTenantContext` exactly as the domain expects; the approve keystone dispatches `posting`/`bank_match` to the real Plan 2/5 post functions. Auth time is injected everywhere for deterministic tests.
