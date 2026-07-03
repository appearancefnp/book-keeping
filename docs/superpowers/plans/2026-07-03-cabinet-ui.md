# Personal Cabinet UI (Plan 10) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grow the web app from a single approval-queue page into the full role-aware personal cabinet (spec §6): a sidebar shell + real 2FA login + i18n over eight surfaces, each a thin view on the existing tested backend.

**Architecture:** Next.js App Router with a `(cabinet)` route group whose layout renders the AppShell (left Sidebar + TopBar + assistant slide-over); a separate `/login`. Each screen calls a thin backend-for-frontend route handler (`web/app/api/**/route.ts`) that authenticates via the `bk_session` cookie and either calls an existing `src/api/*` domain handler through an `AuthedRequest`, or does a cookie→`validateSession`→domain-function call. No business logic in the web layer.

**Tech Stack:** Next.js 16 (App Router, `--webpack`), TypeScript strict/ESM (`.js` import extensions in `src/`; web uses the `@/` + `@domain/*` aliases already configured), the existing "Quiet Ledger" CSS tokens (`web/app/globals.css`), PostgreSQL via the existing domain layer, vitest for backend, Playwright for web verification.

## Global Constraints

- **No business logic in the web layer.** Every web route handler is thin: authenticate (cookie → `validateSession`/`resolveTenantContext`), call an existing domain function or `src/api` handler, map to JSON. Figures are never computed in the browser.
- **Auth on every route.** Every BFF route reads the `bk_session` cookie via `getSessionToken()` (`web/app/lib/session.ts`); no token → `401`. Client-scoped routes require a `clientCompanyId` (query for GET, body for POST) and go through `authed`/`resolveTenantContext` (401 unauth, 403 wrong-tenant). Firm-level routes use `validateSession` + `session.firmId`.
- **ESM import extensions:** files under `src/` use `.js` extensions on relative imports; web files use `@/…` and `@domain/…` aliases (see existing `web/app/api/proposals/route.ts`). Route handlers set `export const runtime = 'nodejs'` and `export const dynamic = 'force-dynamic'`. Dynamic route params are a Promise: `await ctx.params`.
- **Design system:** reuse `web/app/globals.css` OKLCH tokens and existing components (`EmptyState`, `ErrorState`, `SkeletonCard`, `Toast`, `StatusBadge`, `DetailList`, `ProposalCard`, `RationaleBlock`, `PostingLines`). New `*.module.css` files use the same tokens (`--bg`, `--ink`, `--ink-soft`, `--primary`, `--border`, `--radius-sm`, `--space-*`, `--ok`, `--danger`, `--attention`). Figures use `font-variant-numeric: tabular-nums`. Absolute bans (DESIGN.md): no gradient text, no side-stripe borders, no hero-metric cards, no tracked-uppercase eyebrows. Teal accent ≤10%. Body text contrast ≥4.5:1.
- **States:** every data view renders loading (`SkeletonCard`), empty (`EmptyState`), and error (`ErrorState` + `Toast`) states. Never a blank screen.
- **i18n:** all UI chrome strings come from the dictionary layer (Task 2) via `useMessages()`; domain data (memos, names, figures) passes through untranslated. Ship LV + EN; RU keys stubbed (fall back to EN).
- **VAT/receivables account config** (matches the seed CoA): `outputVatAccount: '5721'`, `inputVatAccount: '5722'`, `receivablesAccount: '2310'`.
- **Verification:** backend tasks add vitest tests (run against the Docker DB on 5433). Web tasks are verified with Playwright against `npm run dev` + a seeded DB (`npm run seed`): screenshot desktop 1440 + mobile 390, exercise the core action, confirm zero console errors, and check the Quiet-Ledger constraints above.
- **Do not break the backend suite (142 tests) or typecheck.** Run `npm run typecheck` (root) and, for web changes, `cd web && npx tsc --noEmit`.

## Consumed interfaces (verbatim, already on `main`)

```ts
// src/auth/sessions.ts
login(email, password, totpCode, atUnixSeconds): Promise<{ sessionToken: string }>   // throws 'Invalid credentials' | 'Invalid 2FA code'
validateSession(token, atUnixSeconds): Promise<{ userId: string; firmId: string; role: string } | null>
logout(token): Promise<void>
// src/auth/users.ts
type UserRole = 'firm_admin'|'accountant'|'owner'|'employee'
interface UserRow { id: string; firmId: string; email: string; role: UserRole; language: string }
findUserByEmail(email): Promise<(UserRow & { passwordHash: string; totpSecret: string }) | null>
// src/auth/context.ts
resolveTenantContext(token, clientCompanyId, atUnixSeconds): Promise<TenantContext>  // throws /session/→401 else 403
// src/tenancy/context.ts
interface TenantContext { firmId: string; clientCompanyId: string; actorId: string; actorRole: string }
// src/documents/documents.ts
type DocumentStatus='received'|'extracting'|'extracted'|'needs_review'|'posted'|'rejected'
interface DocumentRow { id; source; storageKey; mime; status; partyId; journalEntryId; extractedData }
listDocuments(tx, ctx, {status?}): Promise<DocumentRow[]>
// src/api/handlers.ts + src/api/*
authed(req: AuthedRequest, fn:(ctx)=>Promise<ApiResponse>): Promise<ApiResponse>
approvalQueueHandler(req)->{proposals}; approveHandler(req[params.id]); rejectHandler(req[params.id, body.reason])
financialsHandler(req)->{trialBalance: TrialBalanceRow[]}
homeSummaryHandler(req)->{pendingApprovals,documentsNeedingReview,openTasks}
documentsHandler(req[params.status?])->{documents}; documentHandler(req[params.id])
makeCaptureHandler({blob,extractor,resolveTemplate})->(req{body:{bytesBase64,mime}})->{documentId,proposalId,status}
// src/api/types.ts
interface AuthedRequest { token; clientCompanyId; params?; body?; atUnixSeconds }
interface ApiResponse { status: number; body: unknown }
// src/ledger/balances.ts   trialBalance(tx,ctx)->TrialBalanceRow{code,name,debit,credit,balance}[]
// src/tax/explain.ts       explainVat(tx,ctx,{fromDate,toDate,config})->{netPayable,ruleRef:{ruleType,value,effectiveFrom},contributions}
// src/banking/sepa.ts      outstandingReceivables(tx,ctx,receivablesAccount)->{balanceCents}
// src/collab/tasks.ts      interface TaskRow{id,title,detail,status:'open'|'resolved'}; listTasks(tx,ctx,{status?}); createTask(tx,ctx,{title,detail?}); resolveTask(tx,ctx,id)
// src/collab/comments.ts   interface CommentRow{id,author,body}; listComments(tx,ctx,entityType,entityId); addComment(tx,ctx,{entityType,entityId,body})
// src/collab/notifications.ts interface NotificationRow{id,kind,message,read}; listNotifications(tx,ctx,recipient,{unreadOnly?}); markRead(tx,ctx,id); notify(...)
// src/collab/audit-view.ts interface AuditRow{action,entityType,entityId,actorId,createdAt}; listAuditLog(tx,ctx,{entityType?,entityId?})
// src/tenancy/firms.ts     interface ClientCompany{id,firmId,name,regNo,baseCurrency}; createClientCompany(firmId,{...})
// web/app/lib/session.ts   SESSION_COOKIE='bk_session'; getSessionToken():Promise<string|null>; nowUnix():number
// src/db/pool.ts           withTenant(ctx, fn); appPool
```

**Produced across tasks (web):** `useMessages()`, `<LanguageSwitcher/>`, `<AppShell/>`, `<Sidebar/>`, `<TopBar/>`, `<AssistantLauncher/>`, `<ChatPanel/>`, `<FileDropzone/>`, `<FigureRows/>`, and route handlers under `web/app/api/{auth,overview,documents,tasks,notifications,assistant,admin,audit}`.

---

## Task 1: Backend gap functions (domain fns the cabinet needs)

The digest found the cabinet needs read/write functions that don't exist yet, plus two display timestamps. Add them with tests. All are thin and tenant/firm-scoped.

**Files:**
- Modify: `src/auth/users.ts` (add `listUsersForFirm`)
- Modify: `src/tenancy/firms.ts` (add `listClientCompaniesForFirm`)
- Modify: `src/collab/notifications.ts` (add `markAllRead`; add `createdAt` to `NotificationRow` + its SELECT)
- Modify: `src/collab/comments.ts` (add `createdAt` to `CommentRow` + its SELECT)
- Test: `tests/collab/cabinet-gaps.test.ts` (new), and extend the existing collab tests only if they assert the row shape.

**Interfaces produced:**
```ts
listUsersForFirm(firmId: string): Promise<UserRow[]>                       // src/auth/users.ts
listClientCompaniesForFirm(firmId: string): Promise<ClientCompany[]>      // src/tenancy/firms.ts
markAllRead(tx: PoolClient, ctx: TenantContext, recipient: string): Promise<void>  // src/collab/notifications.ts
// NotificationRow gains: createdAt: string ; CommentRow gains: createdAt: string
```

- [ ] **Step 1: Write the failing test — `tests/collab/cabinet-gaps.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant, appPool } from '../../src/db/pool.js';
import { createUser, listUsersForFirm } from '../../src/auth/users.js';
import { listClientCompaniesForFirm, createClientCompany } from '../../src/tenancy/firms.js';
import { notify, listNotifications, markAllRead } from '../../src/collab/notifications.js';
import { addComment, listComments } from '../../src/collab/comments.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('listUsersForFirm returns all users in the firm', async () => {
  const t = await makeFirmAndClient();
  await createUser({ firmId: t.firmId, email: 'x@demo.lv', password: 'password123', role: 'employee' });
  const users = await listUsersForFirm(t.firmId);
  expect(users.some((u) => u.email === 'x@demo.lv')).toBe(true);
  expect(users.every((u) => u.firmId === t.firmId)).toBe(true);
});

test('listClientCompaniesForFirm returns every client of the firm', async () => {
  const t = await makeFirmAndClient();
  await createClientCompany(t.firmId, { name: 'Second SIA', regNo: '40000000099' });
  const clients = await listClientCompaniesForFirm(t.firmId);
  expect(clients.length).toBeGreaterThanOrEqual(2);
  expect(clients.every((c) => c.firmId === t.firmId)).toBe(true);
});

test('markAllRead marks every notification for the recipient read; rows carry createdAt', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await notify(tx, ctx(t), { recipient: ctx(t).actorId, kind: 'deadline', message: 'a' });
    await notify(tx, ctx(t), { recipient: ctx(t).actorId, kind: 'deadline', message: 'b' });
    await markAllRead(tx, ctx(t), ctx(t).actorId);
  });
  const rows = await withTenant(ctx(t), (tx) => listNotifications(tx, ctx(t), ctx(t).actorId));
  expect(rows.length).toBe(2);
  expect(rows.every((r) => r.read === true)).toBe(true);
  expect(typeof rows[0]!.createdAt).toBe('string');
});

test('listComments rows carry createdAt', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await addComment(tx, ctx(t), { entityType: 'task', entityId: '11111111-1111-1111-1111-111111111111', body: 'hi' });
  });
  const rows = await withTenant(ctx(t), (tx) => listComments(tx, ctx(t), 'task', '11111111-1111-1111-1111-111111111111'));
  expect(typeof rows[0]!.createdAt).toBe('string');
});
```

- [ ] **Step 2: Run → FAIL** — `docker compose up -d db && npx vitest run tests/collab/cabinet-gaps.test.ts` (missing exports / missing field).

- [ ] **Step 3: Implement.**

`src/auth/users.ts` — append (mirror `findUserByEmail`'s SELECT aliases, drop the secret columns):
```ts
export async function listUsersForFirm(firmId: string): Promise<UserRow[]> {
  const res = await appPool.query(
    `SELECT id, firm_id AS "firmId", email, role, language
     FROM users WHERE firm_id = $1 ORDER BY email ASC`,
    [firmId],
  );
  return res.rows;
}
```
(Ensure `appPool` is imported in the file; it already imports from `../db/pool.js` — reuse the existing import.)

`src/tenancy/firms.ts` — append (mirror `createClientCompany`'s aliases):
```ts
export async function listClientCompaniesForFirm(firmId: string): Promise<ClientCompany[]> {
  const res = await appPool.query(
    `SELECT id, firm_id AS "firmId", name, reg_no AS "regNo", base_currency AS "baseCurrency"
     FROM client_companies WHERE firm_id = $1 ORDER BY name ASC`,
    [firmId],
  );
  return res.rows;
}
```

`src/collab/notifications.ts` — add `createdAt` to the interface + both list/return SELECTs, and add `markAllRead`:
```ts
export interface NotificationRow { id: string; kind: string; message: string; read: boolean; createdAt: string }
// in listNotifications SELECT add:  to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt"
export async function markAllRead(tx: PoolClient, ctx: TenantContext, recipient: string): Promise<void> {
  await tx.query(
    `UPDATE notifications SET read = true
     WHERE client_company_id = $1 AND recipient = $2 AND read = false`,
    [ctx.clientCompanyId, recipient],
  );
}
```
> `notifications` already grants UPDATE to `bookkeeping_app` (markRead exists); no migration needed. Confirm by reading the existing `markRead` query and matching its column names/predicate.

`src/collab/comments.ts` — add `createdAt` to the interface + the `listComments` SELECT:
```ts
export interface CommentRow { id: string; author: string; body: string; createdAt: string }
// in listComments SELECT add:  to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt"
```

- [ ] **Step 4: Run → PASS.** Then run the FULL suite `npx vitest run` and `npm run typecheck` — both green (the added fields are additive; fix any existing collab test that asserted an exact row-shape object).

- [ ] **Step 5: Commit** — `feat: cabinet backend gap fns (listUsersForFirm, listClientCompaniesForFirm, markAllRead, createdAt)`.

---

## Task 2: i18n layer + language switcher (web)

**Files:**
- Create: `web/app/lib/i18n.ts`, `web/app/lib/i18n-context.tsx`, `web/app/components/LanguageSwitcher.tsx`, `web/app/components/LanguageSwitcher.module.css`
- Test: Playwright smoke in Task 4 (the switcher lives in the shell); this task's gate is typecheck + a unit render is unnecessary.

**Interfaces produced:**
```ts
type Lang = 'lv' | 'en' | 'ru';
type MsgKey = keyof typeof EN;              // EN is the canonical key set
useMessages(): { t: (k: MsgKey) => string; lang: Lang; setLang: (l: Lang) => void };
<LanguageProvider>…</LanguageProvider>      // reads/writes a `bk_lang` cookie, default 'lv'
<LanguageSwitcher/>                          // LV / EN / RU selector
```

- [ ] **Step 1: Create `web/app/lib/i18n.ts`** — the dictionaries. Canonical `EN` object holds every UI-chrome key the cabinet uses; `LV` translates them; `RU` is `{}` (falls back to EN). Keys (add as screens need them; these cover the shell + all screens):
```ts
export const EN = {
  'nav.queue': 'Approval queue', 'nav.documents': 'Documents', 'nav.overview': 'Overview',
  'nav.tasks': 'Tasks', 'nav.notifications': 'Notifications', 'nav.admin': 'Admin',
  'top.ask': 'Ask', 'top.signOut': 'Sign out', 'top.client': 'Client',
  'login.title': 'Sign in', 'login.email': 'Email', 'login.password': 'Password',
  'login.code': '6-digit code', 'login.submit': 'Continue', 'login.verify': 'Verify',
  'login.badCreds': 'Wrong email or password', 'login.badCode': 'Invalid 2FA code',
  'docs.title': 'Documents', 'docs.upload': 'Upload document', 'docs.empty': 'No documents yet',
  'docs.status.received': 'Received', 'docs.status.extracting': 'Extracting',
  'docs.status.extracted': 'Extracted', 'docs.status.needs_review': 'Needs review',
  'docs.status.posted': 'Posted', 'docs.status.rejected': 'Rejected',
  'over.title': 'Financial overview', 'over.vat': 'VAT position', 'over.receivables': 'Outstanding receivables',
  'over.netPayable': 'Net VAT payable', 'over.trialBalance': 'Trial balance',
  'over.account': 'Account', 'over.debit': 'Debit', 'over.credit': 'Credit', 'over.balance': 'Balance',
  'tasks.title': 'Tasks', 'tasks.empty': 'No open tasks', 'tasks.complete': 'Mark done',
  'tasks.comment': 'Comment', 'tasks.addComment': 'Add comment', 'tasks.resolved': 'Done',
  'notif.title': 'Notifications', 'notif.empty': 'Nothing new', 'notif.markRead': 'Mark read',
  'notif.markAll': 'Mark all read',
  'admin.title': 'Administration', 'admin.clients': 'Clients', 'admin.users': 'Users',
  'admin.audit': 'Audit trail', 'admin.role': 'Role', 'admin.email': 'Email', 'admin.regNo': 'Reg. No',
  'asst.title': 'Assistant', 'asst.placeholder': 'Ask about your books or taxes…', 'asst.send': 'Send',
  'asst.sources': 'Sources', 'asst.thinking': 'Thinking…',
  'state.loading': 'Loading…', 'state.error': 'Something went wrong', 'state.retry': 'Retry',
} as const;

export const LV: Record<keyof typeof EN, string> = {
  'nav.queue': 'Apstiprināšanas rinda', 'nav.documents': 'Dokumenti', 'nav.overview': 'Pārskats',
  'nav.tasks': 'Uzdevumi', 'nav.notifications': 'Paziņojumi', 'nav.admin': 'Administrēšana',
  'top.ask': 'Jautāt', 'top.signOut': 'Iziet', 'top.client': 'Klients',
  'login.title': 'Pieteikties', 'login.email': 'E-pasts', 'login.password': 'Parole',
  'login.code': '6 ciparu kods', 'login.submit': 'Tālāk', 'login.verify': 'Apstiprināt',
  'login.badCreds': 'Nepareizs e-pasts vai parole', 'login.badCode': 'Nederīgs 2FA kods',
  'docs.title': 'Dokumenti', 'docs.upload': 'Augšupielādēt dokumentu', 'docs.empty': 'Vēl nav dokumentu',
  'docs.status.received': 'Saņemts', 'docs.status.extracting': 'Apstrādā',
  'docs.status.extracted': 'Nolasīts', 'docs.status.needs_review': 'Jāpārbauda',
  'docs.status.posted': 'Iegrāmatots', 'docs.status.rejected': 'Noraidīts',
  'over.title': 'Finanšu pārskats', 'over.vat': 'PVN pozīcija', 'over.receivables': 'Neapmaksātie debitori',
  'over.netPayable': 'Maksājamais PVN', 'over.trialBalance': 'Apgrozījuma bilance',
  'over.account': 'Konts', 'over.debit': 'Debets', 'over.credit': 'Kredīts', 'over.balance': 'Atlikums',
  'tasks.title': 'Uzdevumi', 'tasks.empty': 'Nav atvērtu uzdevumu', 'tasks.complete': 'Atzīmēt izpildītu',
  'tasks.comment': 'Komentārs', 'tasks.addComment': 'Pievienot komentāru', 'tasks.resolved': 'Izpildīts',
  'notif.title': 'Paziņojumi', 'notif.empty': 'Nekā jauna', 'notif.markRead': 'Atzīmēt lasītu',
  'notif.markAll': 'Atzīmēt visus lasītus',
  'admin.title': 'Administrēšana', 'admin.clients': 'Klienti', 'admin.users': 'Lietotāji',
  'admin.audit': 'Audita pieraksti', 'admin.role': 'Loma', 'admin.email': 'E-pasts', 'admin.regNo': 'Reģ. Nr',
  'asst.title': 'Asistents', 'asst.placeholder': 'Jautājiet par grāmatvedību vai nodokļiem…', 'asst.send': 'Sūtīt',
  'asst.sources': 'Avoti', 'asst.thinking': 'Domā…',
  'state.loading': 'Ielādē…', 'state.error': 'Radās kļūda', 'state.retry': 'Mēģināt vēlreiz',
};
export const RU: Partial<Record<keyof typeof EN, string>> = {}; // stub; falls back to EN
export type Lang = 'lv' | 'en' | 'ru';
export type MsgKey = keyof typeof EN;
export function messagesFor(lang: Lang): Record<MsgKey, string> {
  if (lang === 'lv') return LV;
  if (lang === 'ru') return { ...EN, ...RU };
  return EN;
}
```

- [ ] **Step 2: Create `web/app/lib/i18n-context.tsx`** — a client context + hook + cookie persistence:
```tsx
'use client';
import { createContext, useContext, useEffect, useState } from 'react';
import { messagesFor, type Lang, type MsgKey } from './i18n';
const Ctx = createContext<{ t: (k: MsgKey) => string; lang: Lang; setLang: (l: Lang) => void } | null>(null);
function readCookie(): Lang {
  if (typeof document === 'undefined') return 'lv';
  const m = document.cookie.match(/(?:^|; )bk_lang=(lv|en|ru)/);
  return (m?.[1] as Lang) ?? 'lv';
}
export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>('lv');
  useEffect(() => { setLangState(readCookie()); }, []);
  const setLang = (l: Lang) => { document.cookie = `bk_lang=${l}; path=/; max-age=31536000`; setLangState(l); };
  const msgs = messagesFor(lang);
  return <Ctx.Provider value={{ t: (k) => msgs[k] ?? k, lang, setLang }}>{children}</Ctx.Provider>;
}
export function useMessages() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useMessages must be used within LanguageProvider');
  return v;
}
```

- [ ] **Step 3: Create `web/app/components/LanguageSwitcher.tsx`** (+ module.css) — a small segmented `LV / EN / RU` control calling `setLang`; active language uses `--primary`, others `--ink-soft`; keyboard-focusable buttons.

- [ ] **Step 4: Verify** — `cd web && npx tsc --noEmit` clean. (Visual verification happens in Task 4 where the switcher renders in the shell.)

- [ ] **Step 5: Commit** — `feat(web): i18n dictionary layer + language switcher (LV/EN, RU stub)`.

---

## Task 3: Auth — login/logout/me routes + `/login` page + session guard

**Files:**
- Create: `web/app/api/auth/login/route.ts`, `web/app/api/auth/logout/route.ts`, `web/app/api/auth/me/route.ts`
- Create: `web/app/login/page.tsx`, `web/app/login/login-form.tsx` (client), `web/app/login/login.module.css`
- Create: `web/app/lib/require-session.ts` (server guard helper)
- Modify: `web/app/lib/api-client.ts` (add `login`, `logout`, `fetchMe`)

**Interfaces produced:**
```ts
// require-session.ts (server-only)
requireSession(): Promise<{ userId: string; firmId: string; role: string }>  // redirects to /login if absent/invalid
// api-client.ts
login(email, password, code): Promise<void>          // POST /api/auth/login (2-step: call with '' code first? see below)
logout(): Promise<void>                               // POST /api/auth/logout
fetchMe(): Promise<{ userId; firmId; role } | null>  // GET /api/auth/me
```

- [ ] **Step 1: `web/app/api/auth/login/route.ts`** — POST `{email,password,code}` → `login()` → set the `bk_session` cookie. (Single call with all three fields; the page collects password then code before submitting.)
```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { login } from '@domain/auth/sessions.js';
import { SESSION_COOKIE, nowUnix } from '@/app/lib/session';
export async function POST(req: Request) {
  const { email, password, code } = (await req.json().catch(() => ({}))) as { email?: string; password?: string; code?: string };
  if (!email || !password || !code) return NextResponse.json({ error: 'email, password and code are required' }, { status: 400 });
  try {
    const { sessionToken } = await login(email, password, code, nowUnix());
    (await cookies()).set(SESSION_COOKIE, sessionToken, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 12 });
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'login failed';
    return NextResponse.json({ error: msg }, { status: 401 });
  }
}
```

- [ ] **Step 2: `logout/route.ts`** — POST → `logout(token)` + clear cookie; `me/route.ts` — GET → `validateSession(token)` → `{userId,firmId,role}` or `401`.

- [ ] **Step 3: `web/app/lib/require-session.ts`**
```ts
import { redirect } from 'next/navigation';
import { validateSession } from '@domain/auth/sessions.js';
import { getSessionToken, nowUnix } from './session';
export async function requireSession() {
  const token = await getSessionToken();
  const session = token ? await validateSession(token, nowUnix()) : null;
  if (!session) redirect('/login');
  return session;
}
```

- [ ] **Step 4: `web/app/login/page.tsx` + `login-form.tsx`** — a two-step form: step 1 email+password → step 2 6-digit code → `login(email,password,code)` via api-client; on success `router.push('/')`; on `401` show `login.badCreds`/`login.badCode`. Uses `useMessages`. Centered card on `--bg`; teal primary button; inputs with visible focus ring; labels associated; the code input is `inputMode="numeric"` with `autoComplete="one-time-code"`. No sidebar.

- [ ] **Step 5: Verify with Playwright** — `npm run seed` (prints a TOTP secret + current code). Start `cd web && npm run dev`. Navigate `/` → expect redirect to `/login`. Fill `accountant@demo.lv` / `password123` → next step → enter a fresh code from `npm run seed` (regenerate via `node -e` using `totpCodeFor` if expired) → expect redirect to `/` (queue). Screenshot desktop + mobile. Bogus code → inline error, no crash. Zero console errors.

- [ ] **Step 6: Commit** — `feat(web): real login + 2FA, logout, session guard`.

---

## Task 4: App shell — sidebar + top bar + move Queue into `(cabinet)`

**Files:**
- Create: `web/app/(cabinet)/layout.tsx`, `web/app/components/{AppShell,Sidebar,TopBar,AssistantLauncher}.tsx` + matching `.module.css`
- Move: `web/app/page.tsx` → `web/app/(cabinet)/page.tsx` (the Queue; keep its logic, swap chrome strings to `useMessages`, remove the old inline `AppHeader` usage in favor of the shell TopBar)
- Modify: `web/app/layout.tsx` (wrap children in `<LanguageProvider>`)

**Interfaces produced:** `<AppShell nav user client>`, `<Sidebar items role>`, `<TopBar clients activeClientId onClientChange role onAsk>`; `AssistantLauncher` opens the slide-over (host lives in the layout; the panel component itself is Task 5 — for this task the button toggles a placeholder region).

- [ ] **Step 1:** `app/(cabinet)/layout.tsx` — server component: `const session = await requireSession()`. Fetch the firm's clients the user can see (reuse `/api/clients` via `fetchClients()` server-side or a direct call) and render `<AppShell role={session.role} …>` with `{children}`. The shell is a client component holding the active-client state (persisted in a `bk_client` cookie or URL `?client=`), the assistant slide-over open-state, and language via `useMessages`.

- [ ] **Step 2:** `Sidebar` — vertical nav; items: Queue `/`, Documents `/documents`, Overview `/overview`, Tasks `/tasks`, Notifications `/notifications`, and Admin `/admin` **only if** `role` is `accountant`/`firm_admin`. Active route uses `usePathname()` → teal left indication via **full background tint or weight**, NOT a side-stripe border (DESIGN.md ban). Under 640px the sidebar becomes a fixed bottom tab bar (icons + short labels). Each item is an `<a>`/`<Link>` with an accessible label from `useMessages`.

- [ ] **Step 3:** `TopBar` — client `<select>` switcher (label `top.client`), `LanguageSwitcher`, an "Ask" button (`top.ask`) that calls `onAsk`, and a user menu showing the role + `top.signOut` (calls `logout()` then `router.push('/login')`).

- [ ] **Step 4:** Move the Queue: relocate `page.tsx` under `(cabinet)/`, replace its header block with the shell (the shell now provides header/client-switch), and route its remaining hardcoded strings ("Approval queue", "Approve", "Reject", etc.) through `useMessages` keys. Keep all existing proposal-card behavior and `/api/proposals*` calls.

- [ ] **Step 5: Verify with Playwright** — after login, confirm: sidebar renders all sections (Admin present for the accountant), the Queue still lists + approves/rejects, the client switcher swaps data, the language switcher flips chrome LV↔EN, and the layout is correct at 1440 + 390 (sidebar→bottom bar). Zero console errors. Screenshot both widths.

- [ ] **Step 6: Commit** — `feat(web): cabinet app shell (sidebar, top bar, i18n-wired queue)`.

---

## Task 5: Assistant — BFF route + ChatPanel (slide-over + `/assistant`)

**Files:**
- Create: `web/app/api/assistant/route.ts`, `web/app/components/ChatPanel.tsx` + `.module.css`, `web/app/(cabinet)/assistant/page.tsx`
- Modify: the shell layout to host `<ChatPanel/>` in the slide-over region toggled by `AssistantLauncher`.

**Interfaces produced:** `POST /api/assistant {clientCompanyId, question, threadId?}` → `{threadId, answer, citations}`; `<ChatPanel/>`.

- [ ] **Step 1:** `api/assistant/route.ts` — build the handler once and call it. Because `makeAssistantHandler` needs a `ChatModel`, use `StubChatModel` unless an env key is set (POC-safe default):
```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { makeAssistantHandler } from '@domain/assistant/handler.js';
import { StubChatModel } from '@domain/assistant/chat-model.js';
import { AnthropicChatModel } from '@domain/assistant/anthropic-chat.js';
const config = { outputVatAccount: '5721', inputVatAccount: '5722', receivablesAccount: '2310' };
const model = process.env.ANTHROPIC_API_KEY
  ? new AnthropicChatModel()
  : new StubChatModel([{ kind: 'final', text: 'Demo assistant: connect a model (ANTHROPIC_API_KEY / Ollama) to ask over your books.' }]);
const handler = makeAssistantHandler({ model, config });
export async function POST(req: Request) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string; question?: string; threadId?: string };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const res = await handler({ token, clientCompanyId: body.clientCompanyId, body, atUnixSeconds: nowUnix() });
  return NextResponse.json(res.body, { status: res.status });
}
```

- [ ] **Step 2:** `ChatPanel` — a client component: message list (user right, assistant left), a composer (textarea + Send, `asst.placeholder`), a "thinking" indicator, and each assistant message renders its **citations** as a small labelled list (`asst.sources`) reusing the humanized style from `RationaleBlock` (label + value). Posts to `/api/assistant` with the active `clientCompanyId` (from the shell); threads via the returned `threadId`. Errors → inline notice, no crash.

- [ ] **Step 3:** `(cabinet)/assistant/page.tsx` — renders `<ChatPanel/>` full-width; the shell "Ask" button opens the same panel as a right slide-over (≥640px) / full sheet (<640px). One component, two hosts.

- [ ] **Step 4: Verify with Playwright** — open the slide-over via "Ask", send "How much VAT do I owe?", confirm an answer + disclaimer render (Stub in dev), the panel is scrollable and closable, and `/assistant` shows the same panel. Desktop + mobile screenshots; zero console errors.

- [ ] **Step 5: Commit** — `feat(web): assistant chat panel (slide-over + page) over Plan 9`.

---

## Task 6: Documents screen — list + upload

**Files:**
- Create: `web/app/api/documents/route.ts` (GET list), `web/app/api/documents/capture/route.ts` (POST upload), `web/app/(cabinet)/documents/page.tsx`, `web/app/components/{DocumentList,FileDropzone}.tsx` + `.module.css`

**Interfaces produced:** `GET /api/documents?clientCompanyId` → `{documents: DocumentRow[]}` (reuse `documentsHandler`); `POST /api/documents/capture {clientCompanyId, bytesBase64, mime}` → `{documentId, proposalId, status}` (reuse `makeCaptureHandler`).

- [ ] **Step 1:** `api/documents/route.ts` (GET) — thin wrapper over `documentsHandler({token, clientCompanyId, params:{status?}, atUnixSeconds})`, following the `proposals/route.ts` pattern (cookie → 401; clientCompanyId query → 400 if missing).

- [ ] **Step 2:** `api/documents/capture/route.ts` (POST) — construct the capture handler once with a `LocalBlobStore` (base dir from `process.env.BLOB_DIR ?? '.blob-store'`), a `DocumentExtractor` (StubExtractor by default; Ollama/Gemini/Anthropic if the matching env key is set — mirror `docs/oss-poc-options.md`), and `resolveTemplate` returning the default purchase-invoice template. Wrap it like `assistant/route.ts`. Body `{clientCompanyId, bytesBase64, mime}`.

- [ ] **Step 3:** `DocumentList` — a table/list: filename-ish (id short), type (`mime`), and a `StatusBadge`-style chip mapping `DocumentStatus` → the `docs.status.*` message + a token color (`received`→ink-soft, `extracting`→attention, `extracted`/`posted`→ok, `needs_review`→attention, `rejected`→danger). Tabular where numeric. Empty → `EmptyState` (`docs.empty`).

- [ ] **Step 4:** `FileDropzone` — drag-drop + file picker; on file, read as base64 (`FileReader`), POST to `/api/documents/capture`, then refresh the list and toast success ("uploaded → proposal created"); on failure toast the error. Accept images + PDF; show the selected filename and a progress state while posting.

- [ ] **Step 5:** `(cabinet)/documents/page.tsx` — `FileDropzone` above `DocumentList`; loads via `/api/documents` with the active client; skeleton while loading; `ErrorState` + retry on failure.

- [ ] **Step 6: Verify with Playwright** — upload a small test image, confirm it appears in the list and a proposal shows up on the Queue (the pipeline link). Desktop + mobile screenshots; zero console errors.

- [ ] **Step 7: Commit** — `feat(web): documents screen (list + upload → intake)`.

---

## Task 7: Overview screen — financial position

**Files:**
- Create: `web/app/api/overview/route.ts`, `web/app/(cabinet)/overview/page.tsx`, `web/app/components/FigureRows.tsx` + `.module.css`

**Interfaces produced:** `GET /api/overview?clientCompanyId[&from&to]` → `{ trialBalance: TrialBalanceRow[]; vat: {netPayable,rule}; receivables: {outstanding} }`.

- [ ] **Step 1:** `api/overview/route.ts` — cookie→`resolveTenantContext`→`withTenant`, then in one tx call `trialBalance(tx,ctx)`, `explainVat(tx,ctx,{fromDate,toDate,config})` (default period = current month; accept `from`/`to` query), and `outstandingReceivables(tx,ctx,'2310')`; convert `balanceCents`→decimal (reuse the `formatCents`/BigInt approach from `web/app/lib/format.ts`). Return the aggregate. This route uses `resolveTenantContext` directly (not an existing handler) because it composes three domain calls — keep it thin, no computation beyond formatting.

- [ ] **Step 2:** `FigureRows` — a small labelled-figure component (label left in `--ink-soft`, value right, `tabular-nums`, larger weight) for VAT net payable + outstanding receivables. NOT big hero-metric cards (DESIGN.md ban) — quiet rows in a bordered group, like `DetailList`.

- [ ] **Step 3:** `(cabinet)/overview/page.tsx` — two `FigureRows` (VAT position with its rule + period; receivables), then the trial-balance table (`over.account/debit/credit/balance`, tabular numerals, right-aligned amounts, `—` for zero, scroll container on narrow). Skeleton/empty/error states.

- [ ] **Step 4: Verify with Playwright** — with seeded data, confirm the trial balance renders with real numbers, VAT net payable shows, receivables shows; check tabular alignment and mobile scroll. Screenshots; zero console errors.

- [ ] **Step 5: Commit** — `feat(web): financial overview (trial balance, VAT, receivables)`.

---

## Task 8: Tasks screen — list + complete + comment

**Files:**
- Create: `web/app/api/tasks/route.ts` (GET list, POST create), `web/app/api/tasks/[id]/resolve/route.ts` (POST), `web/app/api/tasks/[id]/comments/route.ts` (GET list, POST add), `web/app/(cabinet)/tasks/page.tsx`, `web/app/components/{TaskList,CommentThread}.tsx` + `.module.css`

**Interfaces produced:** `GET /api/tasks?clientCompanyId` → `{tasks}`; `POST /api/tasks {clientCompanyId,title,detail?}`; `POST /api/tasks/[id]/resolve {clientCompanyId}`; `GET /api/tasks/[id]/comments?clientCompanyId` → `{comments}`; `POST /api/tasks/[id]/comments {clientCompanyId, body}`.

- [ ] **Step 1:** The four routes — each cookie→`resolveTenantContext`→`withTenant`→domain call (`listTasks`/`createTask`/`resolveTask`; `listComments(tx,ctx,'task',id)`/`addComment(tx,ctx,{entityType:'task',entityId:id,body})`). Dynamic `[id]` params awaited. Follow the approve-route pattern.

- [ ] **Step 2:** `TaskList` — open tasks with title + detail + a **Mark done** button (`tasks.complete` → POST resolve → refresh); resolved tasks shown muted with a `tasks.resolved` chip. Empty → `EmptyState` (`tasks.empty`).

- [ ] **Step 3:** `CommentThread` — expand a task to show its comments (author + body + `createdAt`), with an add-comment composer (`tasks.addComment`). Posts then refreshes the thread.

- [ ] **Step 4:** `(cabinet)/tasks/page.tsx` — `TaskList` with expandable `CommentThread` per task; skeleton/empty/error.

- [ ] **Step 5: Verify with Playwright** — complete a seeded task (it moves to done), add a comment (it appears with author). Screenshots desktop + mobile; zero console errors.

- [ ] **Step 6: Commit** — `feat(web): tasks screen (complete + comments)`.

---

## Task 9: Notifications screen — list + mark read + unread bell

**Files:**
- Create: `web/app/api/notifications/route.ts` (GET), `web/app/api/notifications/[id]/read/route.ts` (POST), `web/app/api/notifications/read-all/route.ts` (POST), `web/app/(cabinet)/notifications/page.tsx`, `web/app/components/NotificationList.tsx` + `.module.css`
- Modify: `TopBar` (unread count badge on the "Notifications" affordance)

**Interfaces produced:** `GET /api/notifications?clientCompanyId[&unreadOnly]` → `{notifications}`; `POST /api/notifications/[id]/read {clientCompanyId}`; `POST /api/notifications/read-all {clientCompanyId}`.

- [ ] **Step 1:** Routes — cookie→`resolveTenantContext`→`withTenant`; recipient is `ctx.actorId`. GET → `listNotifications(tx,ctx,ctx.actorId,{unreadOnly})`; read → `markRead(tx,ctx,id)`; read-all → `markAllRead(tx,ctx,ctx.actorId)` (Task 1).

- [ ] **Step 2:** `NotificationList` — newest first (rows carry `createdAt` from Task 1); unread rows have a quiet emphasis (weight / a small dot, not a side-stripe), a per-row **Mark read** and a top **Mark all read** (`notif.markAll`). Empty → `EmptyState` (`notif.empty`).

- [ ] **Step 3:** TopBar unread badge — the shell fetches the unread count (`unreadOnly=true`) for the active client and shows it near the Notifications nav item; updates after mark-read.

- [ ] **Step 4:** `(cabinet)/notifications/page.tsx` — the list + states.

- [ ] **Step 5: Verify with Playwright** — mark one read (count drops), mark all read (list clears of unread emphasis). Screenshots; zero console errors.

- [ ] **Step 6: Commit** — `feat(web): notifications screen + unread badge`.

---

## Task 10: Admin screen — clients + users + audit (read-mostly)

**Files:**
- Create: `web/app/api/admin/clients/route.ts` (GET), `web/app/api/admin/users/route.ts` (GET), `web/app/api/audit/route.ts` (GET), `web/app/(cabinet)/admin/page.tsx`, `web/app/components/AdminTables.tsx` + `.module.css`

**Interfaces produced:** `GET /api/admin/clients` → `{clients: ClientCompany[]}` (firm-level: cookie→`validateSession`→`listClientCompaniesForFirm(session.firmId)`); `GET /api/admin/users` → `{users: UserRow[]}` (`listUsersForFirm(session.firmId)`); `GET /api/audit?clientCompanyId` → `{audit: AuditRow[]}` (`listAuditLog` via `resolveTenantContext`).

- [ ] **Step 1:** Routes — clients/users are **firm-level** (use `validateSession` + `session.firmId`, like `clients/route.ts`); enforce role: if `session.role` is not `accountant`/`firm_admin` return `403`. Audit is client-scoped via `resolveTenantContext`.

- [ ] **Step 2:** `AdminTables` — three sections (`admin.clients`, `admin.users`, `admin.audit`): clients table (name, `admin.regNo`, baseCurrency); users table (`admin.email`, `admin.role`); audit table (action, entityType, actorId, `createdAt`). Read-only, tabular, scroll containers on narrow.

- [ ] **Step 3:** `(cabinet)/admin/page.tsx` — renders the three tables for the active client (audit) + firm (clients/users); skeleton/empty/error. The page is only linked in the sidebar for accountant/firm_admin (Task 4), and the API enforces the role regardless.

- [ ] **Step 4: Verify with Playwright** — as the seeded accountant, confirm clients (both), users (accountant+owner), and audit rows render; confirm an owner login does NOT see the Admin nav item and `/admin` API returns 403. Screenshots; zero console errors.

- [ ] **Step 5: Commit** — `feat(web): admin screen (clients, users, audit — read-mostly)`.

---

## Task 11: Seed enrichment + final verification pass

**Files:**
- Modify: `src/dev/seed.ts` (ensure every screen is non-empty), `docs/RUNNING.md` (note the new screens/login flow)

- [ ] **Step 1:** Extend the seed so the demo is non-empty on every screen: at least one **document** per client (via `createDocument` + a blob, or a `needs_review` row), two **tasks** (one open, one resolved) with a **comment**, two **notifications** (one unread) for the accountant, and confirm audit rows exist (they accrue from seeding actions; if sparse, perform one audited action). Keep the existing firm/clients/users/CoA/periods/proposals.

- [ ] **Step 2: Run** `npm run seed` and confirm it prints creds + populates without error.

- [ ] **Step 3: Full verification** — backend `npx vitest run` (still ≥142 green) + `npm run typecheck`; web `cd web && npx tsc --noEmit` + `npm run build` (production build succeeds). Then a Playwright sweep across all eight surfaces at 1440 + 390, LV and EN, verifying each core action and zero console errors.

- [ ] **Step 4: Update `docs/RUNNING.md`** — document logging in via `/login` (email/password + 2FA from `npm run seed`), the new nav, and that the assistant/extractor default to Stub unless a model env key is set.

- [ ] **Step 5: Commit** — `feat(web): seed enrichment + cabinet run docs; final verification`.

---

## Self-review

**Spec coverage (against `2026-07-03-cabinet-ui-design.md`):**
- App shell / role-aware nav → Task 4. ✓  Login + 2FA + guard → Task 3. ✓  i18n LV/EN + switcher → Task 2 (+ used everywhere). ✓
- Queue (reparented) → Task 4. ✓  Documents (list+upload) → Task 6. ✓  Overview → Task 7. ✓  Tasks (+comments) → Task 8. ✓  Notifications (+mark read/all) → Tasks 1+9. ✓  Assistant (slide-over + page) → Task 5. ✓  Admin (clients/users/audit) → Tasks 1+10. ✓
- Backend gaps (listUsersForFirm, listClientCompaniesForFirm, markAllRead, createdAt) → Task 1. ✓
- States (loading/empty/error), role gating, tenant scoping, no-web-logic → Global Constraints + per-task. ✓
- Deferred (invoicing UI, admin CRUD, RU copy, mobile) → not tasked, matches spec §out. ✓

**Placeholder scan:** the CSS is specified by reusing existing tokens/components + explicit design constraints and Playwright verification (concrete, not "style appropriately"); every route/domain call names an exact function + shape from the digest. No TBDs.

**Type consistency:** route handlers consume the exact signatures in "Consumed interfaces"; Task 1's new fns are used by Tasks 9/10; `config` values are identical across Tasks 5/7; `useMessages`/`MsgKey` from Task 2 used by all web tasks; `requireSession` from Task 3 used by Task 4's layout.

**Ordering:** Task 1 (backend) → 2 (i18n) → 3 (auth) → 4 (shell; depends on 2,3) → 5–10 (screens; depend on 4, and 9/10 depend on 1) → 11 (seed + final). Sequential; each ends with an independently testable, committable deliverable.
