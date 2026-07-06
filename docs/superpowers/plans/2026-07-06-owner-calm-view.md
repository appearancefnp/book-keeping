# Owner-Calm View (G3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the SME `owner` role a dedicated, calm home at `/` (position at a glance, only material approvals, upload, deadlines) with a curated three-item navigation, reusing existing data.

**Architecture:** One new domain query (`listMaterialApprovals`) + one GET route expose the "material" subset of pending proposals. The `/` route becomes a server component that renders `OwnerHome` for `role === 'owner'` and the existing queue (extracted into `QueueView`) for everyone else. The Sidebar shows owners a curated item set. No migration; approve/reject reuse existing proposal routes.

**Tech Stack:** TypeScript (NodeNext), Postgres via `pg` + RLS `withTenant`, Vitest (real Postgres), Next.js 16 (App Router, `--webpack`), React 19, CSS modules.

## Global Constraints

- **Domain:** `src/<module>/`, pure `(tx, ctx, ...)` fns; money as integer cents via `src/db/money.ts` (`toCents`, `sumCents`) — never floats. RLS via `withTenant(ctx, ...)`, never bypassed.
- **API route:** `export const runtime = 'nodejs'` + `export const dynamic = 'force-dynamic'`; `@domain/*.js` imports; `getSessionToken()` → `resolveTenantContext(token, clientCompanyId, nowUnix())` → domain call inside `withTenant`. Map caught errors with `errorToStatus(msg)` from `@/app/lib/authz` (401 no-token first).
- **i18n:** every user-facing string in EN **and** LV **and** RU in `web/app/lib/i18n.ts` (typed `Record<keyof typeof EN>` — a missing key fails the build). No tracked-uppercase labels.
- **Icons:** inline stroked SVG via `NavIcon`, `currentColor`.
- **Tests:** Vitest against real Postgres (`docker compose up -d` first). ⚠️ **Never run two vitest processes at once** — the suite DROPs/recreates the shared schema; concurrent runs corrupt each other.
- **Verify gates:** `npm test` (root) + `npx tsc --noEmit` in root **and** `web/` + `npm run build` in `web/`.
- **Commit trailer:** end each commit message with
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Branch:** work in-place on `main` (user-authorized for this repo).

---

### Task 1: Domain — `listMaterialApprovals`

**Files:**
- Create: `src/proposals/material.ts`
- Test: `tests/proposals/material.test.ts`

**Interfaces:**
- Consumes: `listProposals(tx, ctx, { status })` and `ProposalRow` from `src/proposals/proposals.js`; `sumCents(values: string[]): bigint` from `src/db/money.js`; `TenantContext` from `src/tenancy/context.js`.
- Produces: `listMaterialApprovals(tx: PoolClient, ctx: TenantContext): Promise<ProposalRow[]>` — the subset of `pending_approval` proposals that are material (every `declaration`, plus any proposal whose amount ≥ the client's per-operation material threshold; default `100000n` cents = €1000 when no `autonomy_policy` row exists for that operation type).

- [ ] **Step 1: Write the failing test**

Create `tests/proposals/material.test.ts`:

```ts
import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createProposal } from '../../src/proposals/proposals.js';
import { setAutonomy } from '../../src/autonomy/autonomy.js';
import { listMaterialApprovals } from '../../src/proposals/material.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

// A balanced posting proposal for `amount` (decimal string), pending approval.
function posting(amount: string) {
  return {
    type: 'posting' as const,
    status: 'pending_approval' as const,
    payload: {
      date: '2026-07-01', currency: 'EUR', memo: 'x',
      lines: [
        { accountCode: '6110', debit: amount, credit: '0' },
        { accountCode: '5310', debit: '0', credit: amount },
      ],
    },
    rationale: { ruleRef: 'r' },
  };
}

test('includes postings at/above the material threshold, excludes below', async () => {
  const t = await makeFirmAndClient();
  const c = ctx(t);
  await withTenant(c, async (tx) => {
    await setAutonomy(tx, c, { operationType: 'posting', mode: 'approval', materialThresholdCents: 50000n }); // €500
    await createProposal(tx, c, posting('600.00')); // 60000c ≥ 50000 → material
    await createProposal(tx, c, posting('400.00')); // 40000c < 50000 → not
  });
  const rows = await withTenant(c, (tx) => listMaterialApprovals(tx, c));
  expect(rows.length).toBe(1);
});

test('always includes declarations regardless of amount', async () => {
  const t = await makeFirmAndClient();
  const c = ctx(t);
  await withTenant(c, async (tx) => {
    await setAutonomy(tx, c, { operationType: 'posting', mode: 'approval', materialThresholdCents: 100000n });
    await createProposal(tx, c, {
      type: 'declaration', status: 'pending_approval', payload: { netPayable: '12.00' }, rationale: {},
    });
  });
  const rows = await withTenant(c, (tx) => listMaterialApprovals(tx, c));
  expect(rows.length).toBe(1);
  expect(rows[0]!.type).toBe('declaration');
});

test('applies the default €1000 threshold when no autonomy policy row exists', async () => {
  const t = await makeFirmAndClient();
  const c = ctx(t);
  await withTenant(c, async (tx) => {
    await createProposal(tx, c, posting('1500.00')); // 150000 ≥ 100000 default → material
    await createProposal(tx, c, posting('900.00'));  // 90000 < 100000 → not
  });
  const rows = await withTenant(c, (tx) => listMaterialApprovals(tx, c));
  expect(rows.length).toBe(1);
});

test('only returns pending_approval proposals', async () => {
  const t = await makeFirmAndClient();
  const c = ctx(t);
  await withTenant(c, async (tx) => {
    await createProposal(tx, c, { ...posting('2000.00'), status: 'approved' });
  });
  const rows = await withTenant(c, (tx) => listMaterialApprovals(tx, c));
  expect(rows.length).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/proposals/material.test.ts`
Expected: FAIL — cannot resolve `../../src/proposals/material.js` (module not created yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/proposals/material.ts`:

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { listProposals, type ProposalRow } from './proposals.js';
import { sumCents } from '../db/money.js';

// €1000 — matches setAutonomy's default in src/autonomy/autonomy.ts.
const DEFAULT_THRESHOLD_CENTS = 100000n;

/** Amount (integer cents) a proposal represents, or null if none is derivable. */
function proposalAmountCents(row: ProposalRow): bigint | null {
  const payload = row.payload as { lines?: { debit?: string }[]; amountCents?: string } | null;
  if (row.type === 'posting') {
    const debits = (payload?.lines ?? []).map((l) => l.debit ?? '0');
    return debits.length ? sumCents(debits) : null;
  }
  if (row.type === 'bank_match') {
    return payload?.amountCents !== undefined ? BigInt(payload.amountCents) : null;
  }
  return null; // task, or no amount
}

/**
 * Proposals awaiting approval that are "material" for the owner-calm view (G3):
 * every declaration (hard-gated), plus any proposal whose amount ≥ the client's
 * per-operation material threshold (autonomy policy; default €1000 when unset).
 */
export async function listMaterialApprovals(
  tx: PoolClient, ctx: TenantContext,
): Promise<ProposalRow[]> {
  const pending = await listProposals(tx, ctx, { status: 'pending_approval' });

  // One read of all thresholds for this client → Map<operationType, cents>.
  const res = await tx.query(
    `SELECT operation_type AS "op", material_threshold_cents::text AS "threshold"
     FROM autonomy_policy WHERE client_company_id = $1`,
    [ctx.clientCompanyId],
  );
  const thresholds = new Map<string, bigint>(
    res.rows.map((r) => [r.op as string, BigInt(r.threshold)]),
  );

  return pending.filter((row) => {
    if (row.type === 'declaration') return true; // always material
    const amount = proposalAmountCents(row);
    if (amount === null) return false;
    const threshold = thresholds.get(row.type) ?? DEFAULT_THRESHOLD_CENTS;
    return amount >= threshold;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/proposals/material.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/proposals/material.ts tests/proposals/material.test.ts
git commit -m "feat: listMaterialApprovals — material proposal subset for owner view (G3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: API route + client fetch — material approvals

**Files:**
- Create: `web/app/api/proposals/material/route.ts`
- Modify: `web/app/lib/api-client.ts` (add `fetchMaterialApprovals`)

**Interfaces:**
- Consumes: `listMaterialApprovals` (Task 1); `errorToStatus` from `@/app/lib/authz`; `getSessionToken`, `nowUnix` from `@/app/lib/session`; `Proposal` from `@/app/lib/proposal-types`.
- Produces: `GET /api/proposals/material?clientCompanyId=…` → `{ proposals: ProposalRow[] }`; client helper `fetchMaterialApprovals(clientCompanyId: string): Promise<Proposal[]>`.

- [ ] **Step 1: Create the route**

Create `web/app/api/proposals/material/route.ts`:

```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { listMaterialApprovals } from '@domain/proposals/material.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { errorToStatus } from '@/app/lib/authz';

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });

  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const proposals = await withTenant(ctx, (tx) => listMaterialApprovals(tx, ctx));
    return NextResponse.json({ proposals }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
```

- [ ] **Step 2: Add the client helper**

In `web/app/lib/api-client.ts`, immediately after the `fetchProposals` function, add:

```ts
export async function fetchMaterialApprovals(clientCompanyId: string): Promise<Proposal[]> {
  const params = new URLSearchParams({ clientCompanyId });
  const data = await jsonOrThrow(
    await fetch(`/api/proposals/material?${params.toString()}`, { cache: 'no-store' }),
  );
  return (data as { proposals: Proposal[] }).proposals;
}
```

(`Proposal` and `jsonOrThrow` are already imported/defined in this file — confirm the `Proposal` import exists at the top; it is used by `fetchProposals`.)

- [ ] **Step 3: Verify typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Smoke the route (dev server running on :3000)**

```bash
J=/Users/karlis/.claude/jobs/5ea66caa/tmp
curl -s -c $J/ck.txt "http://localhost:3000/api/dev/bootstrap" -o /dev/null
CID=$(curl -s -b $J/ck.txt "http://localhost:3000/api/admin/clients" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).clients[0].id))")
curl -s -b $J/ck.txt "http://localhost:3000/api/proposals/material?clientCompanyId=$CID" -w "\nstatus: %{http_code}\n"
curl -s "http://localhost:3000/api/proposals/material" -o /dev/null -w "no-cookie status: %{http_code}\n"  # expect 400 (missing clientCompanyId) — token check is 401 only w/o cookie AND path; here no clientCompanyId
```
Expected: authenticated call → `200` with `{"proposals":[...]}` (the seed's €2100/€890 postings may or may not clear the default €1000 bar — that's fine, just confirm 200 + shape). No-cookie call → `401`.

- [ ] **Step 5: Commit**

```bash
git add web/app/api/proposals/material/route.ts web/app/lib/api-client.ts
git commit -m "feat(web): GET /api/proposals/material + client fetch (G3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Sidebar — curated owner navigation + nav i18n

**Files:**
- Modify: `web/app/components/Sidebar.tsx`
- Modify: `web/app/lib/i18n.ts` (add `nav.home`, `nav.short.home` to all three catalogs)

**Interfaces:**
- Consumes: existing `NavItem`, `BASE_ITEMS`, `ADMIN_ITEMS`, `ADMIN_ROLES`, `NavIcon`.
- Produces: owners see exactly `[Home, Documents, Notifications]`; all other roles unchanged.

- [ ] **Step 1: Add nav i18n keys**

In `web/app/lib/i18n.ts`, add to the **EN** catalog next to the other `nav.*` keys:

```ts
  'nav.home': 'Home',
  'nav.short.home': 'Home',
```

Add to the **LV** catalog in the same relative position:

```ts
  'nav.home': 'Sākums',
  'nav.short.home': 'Sākums',
```

Add to the **RU** catalog in the same relative position:

```ts
  'nav.home': 'Главная',
  'nav.short.home': 'Главная',
```

- [ ] **Step 2: Extend NavItem key unions and add OWNER_ITEMS**

In `web/app/components/Sidebar.tsx`, add `'nav.home'` to the `key` union and `'nav.short.home'` to the `shortKey` union in the `NavItem` interface. Then add, after the `ADMIN_ITEMS` declaration:

```ts
const OWNER_ITEMS: NavItem[] = [
  { key: 'nav.home',          shortKey: 'nav.short.home',          href: '/',              icon: 'overview' },
  { key: 'nav.documents',     shortKey: 'nav.short.documents',     href: '/documents',     icon: 'documents' },
  { key: 'nav.notifications', shortKey: 'nav.short.notifications', href: '/notifications', icon: 'notifications' },
];
```

- [ ] **Step 3: Branch item selection on role**

In `Sidebar.tsx`, replace the current `items` line:

```ts
  const items = ADMIN_ROLES.has(role) ? [...BASE_ITEMS, ...ADMIN_ITEMS] : BASE_ITEMS;
```

with:

```ts
  const items = role === 'owner'
    ? OWNER_ITEMS
    : ADMIN_ROLES.has(role)
      ? [...BASE_ITEMS, ...ADMIN_ITEMS]
      : BASE_ITEMS;
```

- [ ] **Step 4: Verify typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: no errors (the `Record<keyof typeof EN>` catalogs stay in parity; the `NavItem` unions include the new keys).

- [ ] **Step 5: Commit**

```bash
git add web/app/components/Sidebar.tsx web/app/lib/i18n.ts
git commit -m "feat(web): curated owner navigation (Home/Documents/Notifications) (G3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Extract `QueueView` from the landing page (pure refactor)

**Files:**
- Create: `web/app/(cabinet)/QueueView.tsx`
- Modify: `web/app/(cabinet)/page.tsx`

**Interfaces:**
- Produces: `export function QueueView()` — the current approval-queue UI verbatim; `page.tsx` renders it. No behavior change for any role yet.

- [ ] **Step 1: Move the queue body into QueueView**

Create `web/app/(cabinet)/QueueView.tsx` with the **entire current contents** of `web/app/(cabinet)/page.tsx`, with two changes:
1. Keep the `'use client';` directive at the top.
2. Change the default export into a named export: replace `export default function Page(` (or the current default-export component name) with `export function QueueView(`. Keep the CSS import `import styles from './page.module.css';` unchanged (the file stays colocated).

- [ ] **Step 2: Replace page.tsx with a thin wrapper**

Overwrite `web/app/(cabinet)/page.tsx` with:

```tsx
'use client';

import { QueueView } from './QueueView';

export default function Page() {
  return <QueueView />;
}
```

- [ ] **Step 3: Verify typecheck + build**

Run: `cd web && npx tsc --noEmit && npm run build`
Expected: no errors; build succeeds.

- [ ] **Step 4: Smoke — accountant queue unchanged**

With the dev server running, bootstrap an accountant session (Task 2 Step 4 pattern) and load `http://localhost:3000/` — the approval queue renders exactly as before. (Confirm 200 on `GET /api/proposals?clientCompanyId=…` in the network tab, or via curl.)

- [ ] **Step 5: Commit**

```bash
git add web/app/\(cabinet\)/QueueView.tsx web/app/\(cabinet\)/page.tsx
git commit -m "refactor(web): extract QueueView from landing page (G3 prep)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: OwnerHome component + owner-home i18n

**Files:**
- Create: `web/app/(cabinet)/OwnerHome.tsx`
- Create: `web/app/(cabinet)/OwnerHome.module.css`
- Modify: `web/app/lib/i18n.ts` (owner-home strings in all three catalogs)

**Interfaces:**
- Consumes: `fetchMaterialApprovals` (Task 2), `approveProposal`, `rejectProposal` from `@/app/lib/api-client`; `ProposalCard` (`{ proposal, onApprove, onReject, busy?, leaving? }`); `FileDropzone` (`{ clientCompanyId, uploadLabel?, onUploaded, onToast }`); `EmptyState`, `ErrorState`, `SkeletonCard`, `Toast`; `useMessages`; `useSearchParams`. Client id from the `?client=` param (same as `/documents` and `/overview`).
- Produces: `export function OwnerHome()`.

- [ ] **Step 1: Add owner-home i18n strings**

In `web/app/lib/i18n.ts`, add these keys to the **EN** catalog (and the LV/RU equivalents below) — place them together under an `owner.*` group:

EN:
```ts
  'owner.title': 'Your business',
  'owner.position': 'Position at a glance',
  'owner.vat': 'VAT to pay',
  'owner.receivables': 'Awaiting payment',
  'owner.approvals': 'Needs your approval',
  'owner.approvals.empty': 'Nothing needs your approval right now.',
  'owner.upload': 'Add a document',
  'owner.loadError': 'Could not load your overview.',
```

LV:
```ts
  'owner.title': 'Jūsu uzņēmums',
  'owner.position': 'Stāvoklis īsumā',
  'owner.vat': 'Maksājamais PVN',
  'owner.receivables': 'Gaida apmaksu',
  'owner.approvals': 'Nepieciešams jūsu apstiprinājums',
  'owner.approvals.empty': 'Šobrīd nekas nav jāapstiprina.',
  'owner.upload': 'Pievienot dokumentu',
  'owner.loadError': 'Neizdevās ielādēt pārskatu.',
```

RU:
```ts
  'owner.title': 'Ваш бизнес',
  'owner.position': 'Положение вкратце',
  'owner.vat': 'НДС к уплате',
  'owner.receivables': 'Ожидает оплаты',
  'owner.approvals': 'Требует вашего одобрения',
  'owner.approvals.empty': 'Сейчас одобрять нечего.',
  'owner.upload': 'Добавить документ',
  'owner.loadError': 'Не удалось загрузить обзор.',
```

- [ ] **Step 2: Create OwnerHome.module.css**

Create `web/app/(cabinet)/OwnerHome.module.css`:

```css
.page { display: flex; flex-direction: column; gap: var(--space-5); max-width: 880px; }
.pageHeading { font-size: 1.5rem; font-weight: 600; margin: 0; }
.sectionHeading { font-size: 1rem; font-weight: 600; margin: 0 0 var(--space-3); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--space-3); }
.statCard { border: 1px solid var(--border); border-radius: var(--radius-md); padding: var(--space-4); background: var(--surface); }
.statLabel { font-size: 0.8rem; color: var(--ink-soft); margin: 0 0 var(--space-2); }
.statValue { font-size: 1.375rem; font-weight: 600; font-variant-numeric: tabular-nums; margin: 0; }
.section { border-top: 1px solid var(--border); padding-top: var(--space-4); }
.list { display: flex; flex-direction: column; gap: var(--space-3); }
```

(Token names confirmed in `web/app/globals.css`: `--surface`, `--border`, `--ink`, `--ink-soft` (muted text), `--radius-md`, `--space-1..8`. Use these exact names.)

- [ ] **Step 3: Create OwnerHome.tsx**

Create `web/app/(cabinet)/OwnerHome.tsx`:

```tsx
'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { Proposal } from '@/app/lib/proposal-types';
import { fetchMaterialApprovals, approveProposal, rejectProposal } from '@/app/lib/api-client';
import { useMessages } from '@/app/lib/i18n-context';
import { ProposalCard } from '@/app/components/ProposalCard';
import { FileDropzone } from '@/app/components/FileDropzone';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { EmptyState } from '@/app/components/EmptyState';
import { ErrorState } from '@/app/components/ErrorState';
import { Toast, type ToastKind } from '@/app/components/Toast';
import styles from './OwnerHome.module.css';

interface Overview {
  vat: { netPayable: string };
  receivables: { balanceCents: string };
}

function OwnerHomeInner() {
  const { t } = useMessages();
  const searchParams = useSearchParams();
  const clientId = searchParams.get('client');

  const [overview, setOverview] = useState<Overview | null>(null);
  const [approvals, setApprovals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; kind: ToastKind } | null>(null);

  const load = useCallback(async (cid: string) => {
    setLoading(true);
    setError(false);
    try {
      const [ovRes, appr] = await Promise.all([
        fetch(`/api/overview?clientCompanyId=${encodeURIComponent(cid)}`, { cache: 'no-store' }),
        fetchMaterialApprovals(cid),
      ]);
      if (!ovRes.ok) throw new Error('overview');
      setOverview(await ovRes.json());
      setApprovals(appr);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (clientId) load(clientId); }, [clientId, load]);

  const onApprove = useCallback(async (id: string) => {
    if (!clientId) return;
    setBusyId(id);
    try {
      await approveProposal(id, clientId);
      setApprovals((prev) => prev.filter((p) => p.id !== id));
    } catch {
      setToast({ message: t('owner.loadError'), kind: 'error' });
    } finally {
      setBusyId(null);
    }
  }, [clientId, t]);

  const onReject = useCallback(async (id: string, reason: string) => {
    if (!clientId) return;
    setBusyId(id);
    try {
      await rejectProposal(id, clientId, reason);
      setApprovals((prev) => prev.filter((p) => p.id !== id));
    } catch {
      setToast({ message: t('owner.loadError'), kind: 'error' });
    } finally {
      setBusyId(null);
    }
  }, [clientId, t]);

  return (
    <div className={styles.page}>
      <h1 className={styles.pageHeading}>{t('owner.title')}</h1>

      <section aria-labelledby="pos-heading">
        <h2 id="pos-heading" className={styles.sectionHeading}>{t('owner.position')}</h2>
        {loading ? (
          <div className={styles.cards}><SkeletonCard /><SkeletonCard /></div>
        ) : error ? (
          <ErrorState message={t('owner.loadError')} onRetry={() => clientId && load(clientId)} />
        ) : (
          <div className={styles.cards}>
            <div className={styles.statCard}>
              <p className={styles.statLabel}>{t('owner.vat')}</p>
              <p className={styles.statValue}>{overview?.vat.netPayable ?? '—'}</p>
            </div>
            <div className={styles.statCard}>
              <p className={styles.statLabel}>{t('owner.receivables')}</p>
              <p className={styles.statValue}>{overview?.receivables.balanceCents ?? '—'}</p>
            </div>
          </div>
        )}
      </section>

      <section className={styles.section} aria-labelledby="appr-heading">
        <h2 id="appr-heading" className={styles.sectionHeading}>{t('owner.approvals')}</h2>
        {loading ? (
          <SkeletonCard />
        ) : approvals.length === 0 ? (
          <EmptyState message={t('owner.approvals.empty')} />
        ) : (
          <div className={styles.list}>
            {approvals.map((p) => (
              <ProposalCard key={p.id} proposal={p} onApprove={onApprove} onReject={onReject} busy={busyId === p.id} />
            ))}
          </div>
        )}
      </section>

      <section className={styles.section} aria-labelledby="upload-heading">
        <h2 id="upload-heading" className={styles.sectionHeading}>{t('owner.upload')}</h2>
        {clientId && (
          <FileDropzone
            clientCompanyId={clientId}
            onUploaded={() => load(clientId)}
            onToast={(message, kind) => setToast({ message, kind })}
          />
        )}
      </section>

      {toast && <Toast message={toast.message} kind={toast.kind} onDismiss={() => setToast(null)} />}
    </div>
  );
}

export function OwnerHome() {
  return (
    <Suspense fallback={<SkeletonCard />}>
      <OwnerHomeInner />
    </Suspense>
  );
}
```

**Note (prop names verified against source):** `ErrorState` = `{ message?, onRetry }`, `EmptyState` = `{ message?, detail? }`, `Toast` = `{ message, kind, onDismiss, durationMs? }`, `FileDropzone` = `{ clientCompanyId, uploadLabel?, onUploaded, onToast }`, `SkeletonCard` = no props. The code above matches these. The assistant is available from the AppShell header for all roles — no action needed here. Do not add a separate VID deadline strip.

- [ ] **Step 4: Verify typecheck + build**

Run: `cd web && npx tsc --noEmit && npm run build`
Expected: no errors; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add web/app/\(cabinet\)/OwnerHome.tsx web/app/\(cabinet\)/OwnerHome.module.css web/app/lib/i18n.ts
git commit -m "feat(web): OwnerHome — calm owner landing (position, material approvals, upload) (G3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Role-branch the landing route

**Files:**
- Modify: `web/app/(cabinet)/page.tsx` (client wrapper → server role-branch)

**Interfaces:**
- Consumes: `requireSession()` (returns `{ userId, firmId, role }`) from `@/app/lib/require-session`; `QueueView` (Task 4); `OwnerHome` (Task 5).
- Produces: `/` renders `OwnerHome` for `role === 'owner'`, `QueueView` otherwise.

- [ ] **Step 1: Convert page.tsx to a server role-branch**

Overwrite `web/app/(cabinet)/page.tsx` with:

```tsx
import { requireSession } from '@/app/lib/require-session';
import { QueueView } from './QueueView';
import { OwnerHome } from './OwnerHome';

export default async function Page() {
  const { role } = await requireSession();
  return role === 'owner' ? <OwnerHome /> : <QueueView />;
}
```

(No `'use client'` — this is now a server component that renders the appropriate client component. `QueueView`/`OwnerHome` keep their own `'use client'` + Suspense boundaries.)

- [ ] **Step 2: Verify typecheck + build**

Run: `cd web && npx tsc --noEmit && npm run build`
Expected: no errors; build succeeds; `/` present in the route list.

- [ ] **Step 3: Per-role smoke (dev server on :3000)**

Reuse the employee/owner minting approach from the G1/G2 session: create an `owner@demo.lv` user (role `owner`) assigned to a client, mint a session token, set it as the `bk_session` cookie, and load `/`:

```bash
# owner cookie = bk_session=<token from a domain-minted owner login>
# 1. GET / as owner → OwnerHome markup ("Your business" / localized), curated nav (Home/Documents/Notifications only)
# 2. GET / as accountant (dev bootstrap cookie) → the approval queue, full nav
# 3. As owner: approve a material item → it disappears from the list; GET /api/proposals/material no longer returns it
```
Expected: owner sees OwnerHome + 3-item nav; accountant sees the unchanged queue + full nav; owner can approve a material proposal.

- [ ] **Step 4: Commit**

```bash
git add web/app/\(cabinet\)/page.tsx
git commit -m "feat(web): render OwnerHome for owner role at / (G3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Final verification gates

**Files:** none (verification only).

- [ ] **Step 1: Full backend suite (single vitest process)**

Run: `npm test`
Expected: all green (185 existing + 4 new from Task 1 = 189).

- [ ] **Step 2: Typechecks**

Run: `npx tsc --noEmit` (root) and `cd web && npx tsc --noEmit`
Expected: both clean.

- [ ] **Step 3: Web build**

Run: `cd web && npm run build`
Expected: build succeeds; `/` and `/api/proposals/material` present.

- [ ] **Step 4: Update the audit-fixes handoff**

In `docs/HANDOFF-audit-fixes.md`, mark **G3** done in the progress banner (note: dedicated OwnerHome + curated nav shipped; server-side page-read gating for owner remains the recorded follow-up).

- [ ] **Step 5: Commit**

```bash
git add docs/HANDOFF-audit-fixes.md
git commit -m "docs: mark G3 owner-calm view shipped

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage:** position-at-a-glance (Task 5 cards ← `/api/overview`), material approvals only (Tasks 1–2 + Task 5 list), owner approves directly (Task 5 reuses approve/reject routes), upload (Task 5 `FileDropzone`), deadlines/assistant (inherited from shell — noted, not rebuilt), curated nav (Task 3), role-branch landing (Task 6), no migration (Task 1 reads existing tables). All covered.
- **Follow-up (unbuilt, per spec):** server-side page-read gating for the owner — an owner can still type `/journal`. Recorded in Task 7 Step 4.
- **Types:** `listMaterialApprovals(tx, ctx): Promise<ProposalRow[]>` (Task 1) ↔ route returns `{ proposals }` (Task 2) ↔ `fetchMaterialApprovals → Proposal[]` (Task 2) ↔ `ProposalCard` `proposal: Proposal` (Task 5). Consistent.
- **Component prop names** (`ErrorState`, `EmptyState`, `Toast`, `FileDropzone`, `SkeletonCard`): verified against source and quoted in Task 5's note; the code matches. CSS tokens verified against `globals.css`.
