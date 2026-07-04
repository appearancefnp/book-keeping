# MVP UI over the Tested API — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the invoice-creation flow (HANDOFF.md #3) and the missing MVP-tier screens over the already-tested backend (HANDOFF.md #4): parties, invoice outbox + composer, bank import + payment orders, journal browser, periods + autonomy settings, and the VID deadline strip.

**Architecture:** No new migrations — every table already exists. Add small read/list functions to the domain layer (`src/`) with Vitest coverage, expose them through new Next.js API routes that copy the existing `getSessionToken → resolveTenantContext → withTenant` pattern, and build client pages that copy the existing `(cabinet)` page skeleton (Suspense + `?client=` + error/loading/empty/data branches). Peppol/VID stay behind their existing interfaces (`StubAccessPoint` until HANDOFF #1/#2 land).

**Tech Stack:** TypeScript, Next.js 16.2.10 (App Router, `--webpack`, client pages), React 19, CSS Modules with `globals.css` tokens, pg + RLS, Vitest against real Postgres.

## Roadmap context (from HANDOFF.md)

| # | Bucket | Status in this plan |
|---|--------|--------------------|
| 1 | Peppol real network | **Blocked** on provider choice + onboarding (spec §10.3). Not in this plan; everything here keeps the `AccessPoint` seam so it plugs in. |
| 2 | VID/EDS real filing | **Blocked** on connection method + accountant-verified schema (spec §10.1). This plan ships the *deadline visibility* part (Task 13) which needs no network. |
| 3 | Invoice creation UI + issue flow | **Tasks 3–6.** Credit notes are deferred to a follow-up plan (needs UBL CreditNote doc type + backend design — a separate spec, per HANDOFF "backend gap too"). |
| 4 | MVP-tier UI over existing API | **Tasks 1–2, 7–13.** Deferred from #4: admin tariffs/templates (blocked on monetisation decision), 2FA enrolment UI (no server-side reset/enrol functions exist — needs backend design first), bank submission of pain.001 (integration decision). |
| 5 | Absent accounting modules | Out of scope — each needs accountant input + its own plan. |

Decisions the user must make before the blocked work (HANDOFF "First decisions"): Peppol provider, VID/EDS method + form list with an accountant, bank list for integrations, monetisation model, AI-approach boundary.

## Global Constraints

- **Never bypass RLS**: every domain call runs inside `withTenant(ctx, (tx) => …)`; ctx from `resolveTenantContext(token, clientCompanyId, nowUnix())`.
- **Money is integer cents** (`bigint`/`::text` on the wire) or decimal strings; never floats in domain code. Web display: `formatCents` / `formatDecimal` from `web/app/lib/format.ts`.
- **Ledger is append-only** — journal tables have no UPDATE/DELETE grant; corrections are reversals.
- **Every mutation calls `appendAudit(tx, ctx, {...})`** (existing domain functions already do; new routes that mutate outside existing functions must too).
- **i18n**: every user-facing string added to ALL THREE catalogs in `web/app/lib/i18n.ts` (`EN` as const, `LV`/`RU` typed `Record<keyof typeof EN, string>` — build fails if a key is missing). Components consume via `const { t } = useMessages()` from `@/app/lib/i18n-context`.
- **Icons**: inline stroked SVG, `currentColor`, strokeWidth 1.5, no emoji — extend `web/app/components/NavIcon.tsx`.
- **Design rules (DESIGN.md)**: no tracked-uppercase labels; status = icon + label, never colour alone; tabular numerals right-aligned for money; single teal accent; flat surfaces + hairlines.
- **API route boilerplate** (every new `route.ts`): `export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';` at top; domain imports via `@domain/<path>.js` (`.js` extension, source is `.ts`); 401 `{ error: 'Not signed in' }` when no token; 400 when `clientCompanyId` missing; catch → `/session/i.test(msg) ? 401 : 403`.
- **Page skeleton** (every new `page.tsx`): `'use client'`; default export wraps inner component in `<Suspense>`; inner reads `useSearchParams().get('client')`; fetch with `{ cache: 'no-store' }`; render order error → loading → empty → data; co-located `page.module.css` using `var(--token)` values only.
- **This is a modified Next.js 16** — per `web/AGENTS.md`, consult `web/node_modules/next/dist/docs/` if any Next API behaves unexpectedly. Route params are async (`ctx: { params: Promise<{id: string}> }`).
- **Verification commands**: root `npm test` (needs Postgres: `docker compose up -d`; tests DROP+recreate the schema) and `npx tsc --noEmit` in BOTH root and `web/`.
- **Commits**: one per task, `feat:` for domain, `feat(web):` for UI/routes, message ends with the standard co-author trailer used in this repo's history.

## File Structure (new/modified)

```
src/einvoice/query.ts            NEW  listEinvoices
src/einvoice/vid.ts              MOD  + upcomingVidDeadlines
src/banking/query.ts             NEW  listBankTransactions
src/ledger/query.ts              NEW  listJournalEntries
src/ledger/periods.ts            MOD  + listPeriods
src/autonomy/autonomy.ts         MOD  + listAutonomyPolicies
tests/einvoice/query.test.ts     NEW
tests/einvoice/vid-deadlines.test.ts NEW
tests/banking/query.test.ts      NEW
tests/ledger/query.test.ts       NEW
tests/ledger/list-periods.test.ts NEW
tests/autonomy/list.test.ts      NEW
web/app/lib/access-point.ts      NEW  shared AccessPoint instance (stub for now)
web/app/api/parties/route.ts     NEW  GET list / POST create
web/app/api/parties/[id]/route.ts NEW PATCH update
web/app/api/einvoices/route.ts   NEW  GET list / POST issue
web/app/api/vat-rate/route.ts    NEW  GET effective standard VAT rate
web/app/api/bank/import/route.ts NEW  POST camt.053 XML
web/app/api/bank/transactions/route.ts NEW GET list
web/app/api/bank/payment-orders/route.ts NEW POST generate pain.001
web/app/api/journal/route.ts     NEW  GET entries
web/app/api/periods/route.ts     NEW  GET list / POST open|close
web/app/api/autonomy/route.ts    NEW  GET list / POST set
web/app/api/vid/deadlines/route.ts NEW GET upcoming/overdue
web/app/(cabinet)/parties/page.tsx (+ .module.css)   NEW
web/app/(cabinet)/invoices/page.tsx (+ .module.css)  NEW outbox
web/app/(cabinet)/invoices/new/page.tsx (+ .module.css) NEW composer
web/app/(cabinet)/bank/page.tsx (+ .module.css)      NEW
web/app/(cabinet)/journal/page.tsx (+ .module.css)   NEW
web/app/(cabinet)/settings/page.tsx (+ .module.css)  NEW periods+autonomy
web/app/(cabinet)/overview/page.tsx  MOD + VID deadline strip
web/app/components/Sidebar.tsx   MOD  + nav items (invoices, bank, journal, parties; settings admin-gated)
web/app/components/NavIcon.tsx   MOD  + icons
web/app/lib/i18n.ts              MOD  + keys in EN/LV/RU (per task)
HANDOFF.md                       MOD  final task marks shipped items
```

---

### Task 1: Parties API routes

**Files:**
- Create: `web/app/api/parties/route.ts`
- Create: `web/app/api/parties/[id]/route.ts`

**Interfaces:**
- Consumes: `listParties(tx, ctx, { kind? })`, `createParty(tx, ctx, { kind, name, regNo?, vatNo? })`, `updateParty(tx, ctx, id, patch)` from `@domain/parties/parties.js`; `PartyKind = 'customer'|'vendor'|'both'`; `PartyRow = { id, kind, name, regNo, vatNo }`.
- Produces: `GET /api/parties?clientCompanyId&kind?` → `{ parties: PartyRow[] }`; `POST /api/parties` body `{ clientCompanyId, kind, name, regNo?, vatNo? }` → 201 `{ id }`; `PATCH /api/parties/:id` body `{ clientCompanyId, name?, regNo?, vatNo?, kind? }` → 200 `{ ok: true }`. Task 2 and Task 6 (composer customer picker) rely on these exact shapes.

- [ ] **Step 1: Write `web/app/api/parties/route.ts`**

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { listParties, createParty } from '@domain/parties/parties.js';
import type { PartyKind } from '@domain/parties/parties.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const kind = req.nextUrl.searchParams.get('kind') as PartyKind | null;

  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const parties = await withTenant(ctx, (tx) => listParties(tx, ctx, kind ? { kind } : {}));
    return NextResponse.json({ parties }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: /session/i.test(msg) ? 401 : 403 });
  }
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    clientCompanyId?: string; kind?: PartyKind; name?: string; regNo?: string | null; vatNo?: string | null;
  };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.kind || !body.name) return NextResponse.json({ error: 'missing kind or name' }, { status: 400 });

  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    const result = await withTenant(ctx, (tx) =>
      createParty(tx, ctx, { kind: body.kind!, name: body.name!, regNo: body.regNo ?? null, vatNo: body.vatNo ?? null }),
    );
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: /session/i.test(msg) ? 401 : 403 });
  }
}
```

- [ ] **Step 2: Write `web/app/api/parties/[id]/route.ts`**

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { updateParty } from '@domain/parties/parties.js';
import type { PartyKind } from '@domain/parties/parties.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    clientCompanyId?: string; name?: string; regNo?: string | null; vatNo?: string | null; kind?: PartyKind;
  };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });

  try {
    const tctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    await withTenant(tctx, (tx) =>
      updateParty(tx, tctx, id, {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.regNo !== undefined && { regNo: body.regNo }),
        ...(body.vatNo !== undefined && { vatNo: body.vatNo }),
        ...(body.kind !== undefined && { kind: body.kind }),
      }),
    );
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: /session/i.test(msg) ? 401 : 403 });
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `cd /Users/karlis/git/book-keeping/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add web/app/api/parties
git commit -m "feat(web): parties API routes (list/create/update)"
```

---

### Task 2: Parties page + navigation entry

**Files:**
- Create: `web/app/(cabinet)/parties/page.tsx`, `web/app/(cabinet)/parties/page.module.css`
- Modify: `web/app/components/Sidebar.tsx` (add nav item + widen key unions), `web/app/components/NavIcon.tsx` (add `parties` icon), `web/app/lib/i18n.ts` (keys below in EN+LV+RU)

**Interfaces:**
- Consumes: Task 1 routes; `useMessages()` hook; `EmptyState`, `ErrorState`, `SkeletonCard`, `Toast` components.
- Produces: page at `/parties?client=<uuid>`; nav key `'parties'`.

- [ ] **Step 1: i18n keys** — add to `EN` (and translated to `LV`, `RU`) in `web/app/lib/i18n.ts`:

```typescript
// EN
'nav.parties': 'Customers & vendors',
'nav.short.parties': 'Parties',
'parties.title': 'Customers & vendors',
'parties.new': 'New party',
'parties.name': 'Name',
'parties.kind': 'Kind',
'parties.kind.customer': 'Customer',
'parties.kind.vendor': 'Vendor',
'parties.kind.both': 'Customer & vendor',
'parties.regNo': 'Reg. no.',
'parties.vatNo': 'VAT no.',
'parties.save': 'Save',
'parties.cancel': 'Cancel',
'parties.edit': 'Edit',
'parties.empty': 'No customers or vendors yet.',
'parties.emptyDetail': 'Add the companies you invoice and buy from.',
'parties.saved': 'Party saved',
// LV
'nav.parties': 'Klienti un piegādātāji',
'nav.short.parties': 'Partneri',
'parties.title': 'Klienti un piegādātāji',
'parties.new': 'Jauns partneris',
'parties.name': 'Nosaukums',
'parties.kind': 'Veids',
'parties.kind.customer': 'Klients',
'parties.kind.vendor': 'Piegādātājs',
'parties.kind.both': 'Klients un piegādātājs',
'parties.regNo': 'Reģ. nr.',
'parties.vatNo': 'PVN nr.',
'parties.save': 'Saglabāt',
'parties.cancel': 'Atcelt',
'parties.edit': 'Rediģēt',
'parties.empty': 'Vēl nav klientu vai piegādātāju.',
'parties.emptyDetail': 'Pievienojiet uzņēmumus, kuriem izrakstāt rēķinus un no kuriem pērkat.',
'parties.saved': 'Partneris saglabāts',
// RU
'nav.parties': 'Клиенты и поставщики',
'nav.short.parties': 'Партнёры',
'parties.title': 'Клиенты и поставщики',
'parties.new': 'Новый партнёр',
'parties.name': 'Название',
'parties.kind': 'Тип',
'parties.kind.customer': 'Клиент',
'parties.kind.vendor': 'Поставщик',
'parties.kind.both': 'Клиент и поставщик',
'parties.regNo': 'Рег. №',
'parties.vatNo': '№ НДС',
'parties.save': 'Сохранить',
'parties.cancel': 'Отмена',
'parties.edit': 'Изменить',
'parties.empty': 'Пока нет клиентов или поставщиков.',
'parties.emptyDetail': 'Добавьте компании, которым вы выставляете счета и у которых покупаете.',
'parties.saved': 'Партнёр сохранён',
```

- [ ] **Step 2: NavIcon** — in `web/app/components/NavIcon.tsx` add `'parties'` to `NavIconName` and to `PATHS`:

```tsx
// Two-person silhouette / parties
parties: (
  <>
    <circle cx="7.5" cy="7" r="2.5" />
    <path d="M3.5 16.5c0-2.5 1.8-4 4-4s4 1.5 4 4" strokeLinecap="round" />
    <circle cx="13.75" cy="7.75" r="2" />
    <path d="M13 12.75c2 0 3.5 1.4 3.5 3.5" strokeLinecap="round" />
  </>
),
```

- [ ] **Step 3: Sidebar** — in `web/app/components/Sidebar.tsx`: widen the `NavItem` `key`/`shortKey` unions with `'nav.parties'`/`'nav.short.parties'` (match how existing keys are typed), and append to `BASE_ITEMS`:

```typescript
{ key: 'nav.parties', shortKey: 'nav.short.parties', href: '/parties', icon: 'parties' },
```

(Place after the tasks/notifications entries — exact position: last of `BASE_ITEMS`. Preserve the existing item-object shape if field names differ — copy an existing entry and substitute values.)

- [ ] **Step 4: Page** — `web/app/(cabinet)/parties/page.tsx`:

```tsx
'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { EmptyState } from '@/app/components/EmptyState';
import styles from './page.module.css';

type PartyKind = 'customer' | 'vendor' | 'both';
interface PartyRow { id: string; kind: PartyKind; name: string; regNo: string | null; vatNo: string | null; }
interface FormState { id: string | null; kind: PartyKind; name: string; regNo: string; vatNo: string; }

const EMPTY_FORM: FormState = { id: null, kind: 'customer', name: '', regNo: '', vatNo: '' };

function PartiesInner() {
  const searchParams = useSearchParams();
  const { t } = useMessages();
  const clientCompanyId = searchParams.get('client');

  const [parties, setParties] = useState<PartyRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/parties?clientCompanyId=${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { parties: PartyRow[] };
      setParties(body.parties);
    } catch (err) {
      setError((err as Error).message ?? t('state.error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (clientCompanyId) load(clientCompanyId);
  }, [clientCompanyId, load]);

  async function save() {
    if (!clientCompanyId || !form || !form.name.trim()) return;
    setSaving(true);
    setSaveError(null);
    const payload = {
      clientCompanyId,
      kind: form.kind,
      name: form.name.trim(),
      regNo: form.regNo.trim() || null,
      vatNo: form.vatNo.trim() || null,
    };
    try {
      const res = await fetch(form.id ? `/api/parties/${form.id}` : '/api/parties', {
        method: form.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setForm(null);
      await load(clientCompanyId);
    } catch (err) {
      setSaveError((err as Error).message ?? t('state.error'));
    } finally {
      setSaving(false);
    }
  }

  const kindLabel = (k: PartyKind) =>
    k === 'customer' ? t('parties.kind.customer') : k === 'vendor' ? t('parties.kind.vendor') : t('parties.kind.both');

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.headRow}>
          <h1 className={styles.pageHeading}>{t('parties.title')}</h1>
          <button type="button" className={styles.primaryBtn} onClick={() => { setSaveError(null); setForm({ ...EMPTY_FORM }); }}>
            {t('parties.new')}
          </button>
        </div>

        {form && (
          <form className={styles.form} onSubmit={(e) => { e.preventDefault(); save(); }}>
            <label className={styles.field}>
              <span>{t('parties.name')}</span>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </label>
            <label className={styles.field}>
              <span>{t('parties.kind')}</span>
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as PartyKind })}>
                <option value="customer">{t('parties.kind.customer')}</option>
                <option value="vendor">{t('parties.kind.vendor')}</option>
                <option value="both">{t('parties.kind.both')}</option>
              </select>
            </label>
            <label className={styles.field}>
              <span>{t('parties.regNo')}</span>
              <input value={form.regNo} onChange={(e) => setForm({ ...form, regNo: e.target.value })} />
            </label>
            <label className={styles.field}>
              <span>{t('parties.vatNo')}</span>
              <input value={form.vatNo} onChange={(e) => setForm({ ...form, vatNo: e.target.value })} />
            </label>
            {saveError && <p className={styles.formError} role="alert">{saveError}</p>}
            <div className={styles.formActions}>
              <button type="submit" className={styles.primaryBtn} disabled={saving || !form.name.trim()}>
                {t('parties.save')}
              </button>
              <button type="button" className={styles.ghostBtn} onClick={() => setForm(null)}>
                {t('parties.cancel')}
              </button>
            </div>
          </form>
        )}

        {error && <ErrorState message={error} onRetry={() => clientCompanyId && load(clientCompanyId)} />}
        {!error && loading && <div className={styles.skeletons}><SkeletonCard /><SkeletonCard /></div>}
        {!error && !loading && parties && parties.length === 0 && (
          <EmptyState message={t('parties.empty')} detail={t('parties.emptyDetail')} />
        )}
        {!error && !loading && parties && parties.length > 0 && (
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">{t('parties.name')}</th>
                  <th scope="col">{t('parties.kind')}</th>
                  <th scope="col">{t('parties.regNo')}</th>
                  <th scope="col">{t('parties.vatNo')}</th>
                  <th scope="col"><span className="sr-only">{t('parties.edit')}</span></th>
                </tr>
              </thead>
              <tbody>
                {parties.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td>{kindLabel(p.kind)}</td>
                    <td className={styles.mono}>{p.regNo ?? '—'}</td>
                    <td className={styles.mono}>{p.vatNo ?? '—'}</td>
                    <td className={styles.actionsCell}>
                      <button
                        type="button"
                        className={styles.ghostBtn}
                        onClick={() => {
                          setSaveError(null);
                          setForm({ id: p.id, kind: p.kind, name: p.name, regNo: p.regNo ?? '', vatNo: p.vatNo ?? '' });
                        }}
                      >
                        {t('parties.edit')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}

function PartiesSkeleton() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.skeletons}><SkeletonCard /><SkeletonCard /></div>
      </main>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<PartiesSkeleton />}>
      <PartiesInner />
    </Suspense>
  );
}
```

- [ ] **Step 5: CSS** — `web/app/(cabinet)/parties/page.module.css` (this stylesheet is the shared template for later pages in this plan; later tasks repeat it with their own additions):

```css
.page { display: flex; justify-content: center; }
.main { width: 100%; max-width: 960px; padding: var(--space-6) var(--space-5); display: flex; flex-direction: column; gap: var(--space-5); }
.headRow { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; }
.pageHeading { font-size: 1.375rem; font-weight: 600; color: var(--ink); margin: 0; }
.skeletons { display: flex; flex-direction: column; gap: var(--space-4); }

.primaryBtn { background: var(--primary); color: var(--primary-ink); border: none; border-radius: var(--radius-sm); padding: var(--space-2) var(--space-4); font: inherit; font-weight: 500; cursor: pointer; }
.primaryBtn:disabled { opacity: 0.55; cursor: default; }
.ghostBtn { background: transparent; color: var(--primary-deep); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: var(--space-1) var(--space-3); font: inherit; cursor: pointer; }

.form { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--space-4); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); padding: var(--space-5); }
.field { display: flex; flex-direction: column; gap: var(--space-1); font-size: 0.875rem; color: var(--ink-soft); }
.field input, .field select { font: inherit; color: var(--ink); background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: var(--space-2) var(--space-3); }
.formActions { grid-column: 1 / -1; display: flex; gap: var(--space-3); }
.formError { grid-column: 1 / -1; color: var(--danger); font-size: 0.875rem; margin: 0; }

.tableWrapper { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); }
.table { width: 100%; border-collapse: collapse; font-size: 0.9375rem; }
.table th { text-align: left; font-weight: 500; color: var(--ink-soft); padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border); }
.table td { padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border); color: var(--ink); }
.table tbody tr:last-child td { border-bottom: none; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.875rem; }
.actionsCell { text-align: right; }
```

- [ ] **Step 6: Typecheck**

Run: `cd /Users/karlis/git/book-keeping/web && npx tsc --noEmit`
Expected: no errors (a missing LV/RU i18n key fails here — fix before commit).

- [ ] **Step 7: Commit**

```bash
git add web/app/\(cabinet\)/parties web/app/components/Sidebar.tsx web/app/components/NavIcon.tsx web/app/lib/i18n.ts
git commit -m "feat(web): parties management page + nav"
```

---

### Task 3: Domain — `listEinvoices` query + tests

**Files:**
- Create: `src/einvoice/query.ts`
- Test: `tests/einvoice/query.test.ts`

**Interfaces:**
- Consumes: `einvoices` table (migration 015), `TenantContext` from `../tenancy/context.js`.
- Produces: `listEinvoices(tx: PoolClient, ctx: TenantContext, filter?: { direction?: 'outbound'|'inbound'; limit?: number }): Promise<EinvoiceRow[]>` where `EinvoiceRow = { id, direction, invoiceNumber, issueDate, grandTotalCents, currency, peppolStatus, peppolMessageId, vidStatus, vidDueDate, journalEntryId, createdAt }` (all strings except nullables). Tasks 4 and 13 consume this.

- [ ] **Step 1: Write the failing test** — `tests/einvoice/query.test.ts`:

```typescript
import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { sendInvoice } from '../../src/einvoice/outbound.js';
import { listEinvoices } from '../../src/einvoice/query.js';
import type { EInvoice } from '../../src/einvoice/ubl.js';

const inv: EInvoice = {
  invoiceNumber: 'INV-2026-042', issueDate: '2026-03-10', currency: 'EUR',
  supplier: { name: 'SIA Pārdevējs', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'SIA Klients', regNo: '40200000000', vatNo: 'LV40200000000' },
  lines: [{ description: 'Prece', net: '100.00', vatRate: 21, vat: '21.00' }],
  netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
};

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function issueOne(t: { firmId: string; clientCompanyId: string }) {
  const ap = new StubAccessPoint();
  return withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Debtors', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, ctx(t), { code: '5721', name: 'Output VAT', type: 'liability' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    return sendInvoice(tx, ctx(t), {
      invoice: inv, recipientPeppolId: '0088:123', ap,
      receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721',
    });
  });
}

test('lists outbound einvoices with statuses', async () => {
  const t = await makeFirmAndClient();
  await issueOne(t);
  const rows = await withTenant(ctx(t), (tx) => listEinvoices(tx, ctx(t), { direction: 'outbound' }));
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  expect(row.invoiceNumber).toBe('INV-2026-042');
  expect(row.issueDate).toBe('2026-03-10');
  expect(row.grandTotalCents).toBe('12100');
  expect(row.peppolStatus).toBe('sent');
  expect(row.vidStatus).toBe('pending');
  expect(row.direction).toBe('outbound');
});

test('does not leak other tenants and respects limit', async () => {
  const t1 = await makeFirmAndClient('SIA Viens');
  const t2 = await makeFirmAndClient('SIA Divi');
  await issueOne(t1);
  const rowsT2 = await withTenant(ctx(t2), (tx) => listEinvoices(tx, ctx(t2)));
  expect(rowsT2).toHaveLength(0);
  const limited = await withTenant(ctx(t1), (tx) => listEinvoices(tx, ctx(t1), { limit: 0 }));
  expect(limited).toHaveLength(0);
});
```

Note: `makeFirmAndClient` may or may not accept a name argument — check `tests/helpers/db.ts` (signature is `makeFirmAndClient(clientName = 'SIA Test')`, so it does). `createAccount`'s exact signature: verify against `src/ledger/accounts.ts` before running; adjust the `type` value if the accepted union differs (existing test `tests/einvoice/outbound.test.ts` uses exactly this call shape — mirror it).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/karlis/git/book-keeping && docker compose up -d && npx vitest run tests/einvoice/query.test.ts`
Expected: FAIL — cannot resolve `../../src/einvoice/query.js`.

- [ ] **Step 3: Implement** — `src/einvoice/query.ts`:

```typescript
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export interface EinvoiceRow {
  id: string;
  direction: 'outbound' | 'inbound';
  invoiceNumber: string;
  issueDate: string;
  grandTotalCents: string;
  currency: string;
  peppolStatus: string;
  peppolMessageId: string | null;
  vidStatus: string;
  vidDueDate: string | null;
  journalEntryId: string | null;
  createdAt: string;
}

export async function listEinvoices(
  tx: PoolClient,
  ctx: TenantContext,
  filter: { direction?: 'outbound' | 'inbound'; limit?: number } = {},
): Promise<EinvoiceRow[]> {
  const params: unknown[] = [ctx.clientCompanyId];
  let where = 'client_company_id = $1';
  if (filter.direction) {
    params.push(filter.direction);
    where += ` AND direction = $${params.length}`;
  }
  params.push(filter.limit ?? 50);
  const res = await tx.query(
    `SELECT id, direction, invoice_number,
            to_char(issue_date, 'YYYY-MM-DD') AS issue_date,
            grand_total_cents::text AS grand_total_cents,
            currency, peppol_status, peppol_message_id,
            vid_status, to_char(vid_due_date, 'YYYY-MM-DD') AS vid_due_date,
            journal_entry_id, created_at::text AS created_at
       FROM einvoices
      WHERE ${where}
      ORDER BY issue_date DESC, created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return res.rows.map((r) => ({
    id: r.id,
    direction: r.direction,
    invoiceNumber: r.invoice_number,
    issueDate: r.issue_date,
    grandTotalCents: r.grand_total_cents,
    currency: r.currency,
    peppolStatus: r.peppol_status,
    peppolMessageId: r.peppol_message_id,
    vidStatus: r.vid_status,
    vidDueDate: r.vid_due_date,
    journalEntryId: r.journal_entry_id,
    createdAt: r.created_at,
  }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/einvoice/query.test.ts`
Expected: 2 passed. Then run the full suite: `npm test` — all pass (146 + 2).

- [ ] **Step 5: Commit**

```bash
git add src/einvoice/query.ts tests/einvoice/query.test.ts
git commit -m "feat: listEinvoices query for outbox/status views"
```

---

### Task 4: E-invoice + VAT-rate API routes

**Files:**
- Create: `web/app/lib/access-point.ts`
- Create: `web/app/api/einvoices/route.ts`
- Create: `web/app/api/vat-rate/route.ts`

**Interfaces:**
- Consumes: `sendInvoice(tx, ctx, { invoice, recipientPeppolId, ap, receivableAccount, salesAccount, vatAccount })` from `@domain/einvoice/outbound.js`; `listEinvoices` (Task 3); `EInvoice` from `@domain/einvoice/ubl.js`; `getTaxRate(tx, ruleType, onDate)` from `@domain/tax/rules.js`; `StubAccessPoint`.
- Produces: `GET /api/einvoices?clientCompanyId&direction?&limit?` → `{ einvoices: EinvoiceRow[] }`; `POST /api/einvoices` body `{ clientCompanyId, invoice: EInvoice, recipientPeppolId }` → 201 `{ einvoiceId, entryId, messageId }`; `GET /api/vat-rate?clientCompanyId&on=YYYY-MM-DD` → `{ rate: number }`. Tasks 5, 6 consume these.

- [ ] **Step 1: Shared Access Point instance** — `web/app/lib/access-point.ts`:

```typescript
import { StubAccessPoint } from '@domain/einvoice/access-point.js';

// Single Access Point used by the einvoice routes. Currently the in-memory
// stub — swap for the real provider implementation when HANDOFF.md #1 lands;
// the AccessPoint interface stays the same.
export const accessPoint = new StubAccessPoint();
```

- [ ] **Step 2: `web/app/api/einvoices/route.ts`**

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { listEinvoices } from '@domain/einvoice/query.js';
import { sendInvoice } from '@domain/einvoice/outbound.js';
import type { EInvoice } from '@domain/einvoice/ubl.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { accessPoint } from '@/app/lib/access-point';

// Default LV chart-of-accounts codes; override per deployment via env.
const RECEIVABLE_ACCOUNT = process.env.EINVOICE_RECEIVABLE_ACCOUNT ?? '2310';
const SALES_ACCOUNT = process.env.EINVOICE_SALES_ACCOUNT ?? '6110';
const VAT_ACCOUNT = process.env.EINVOICE_VAT_ACCOUNT ?? '5721';

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const direction = req.nextUrl.searchParams.get('direction') as 'outbound' | 'inbound' | null;
  const limitParam = Number(req.nextUrl.searchParams.get('limit'));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : 50;

  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const einvoices = await withTenant(ctx, (tx) =>
      listEinvoices(tx, ctx, { ...(direction && { direction }), limit }),
    );
    return NextResponse.json({ einvoices }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: /session/i.test(msg) ? 401 : 403 });
  }
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    clientCompanyId?: string;
    invoice?: EInvoice;
    recipientPeppolId?: string;
  };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.invoice) return NextResponse.json({ error: 'missing invoice' }, { status: 400 });
  if (!body.recipientPeppolId) return NextResponse.json({ error: 'missing recipientPeppolId' }, { status: 400 });

  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    const result = await withTenant(ctx, (tx) =>
      sendInvoice(tx, ctx, {
        invoice: body.invoice!,
        recipientPeppolId: body.recipientPeppolId!,
        ap: accessPoint,
        receivableAccount: RECEIVABLE_ACCOUNT,
        salesAccount: SALES_ACCOUNT,
        vatAccount: VAT_ACCOUNT,
      }),
    );
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Validation/posting failures (EN 16931 issues, closed period, missing
    // account) are client-fixable → 400, not 403.
    const httpStatus = /session/i.test(msg) ? 401 : /forbidden|denied|not assigned/i.test(msg) ? 403 : 400;
    return NextResponse.json({ error: msg }, { status: httpStatus });
  }
}
```

- [ ] **Step 3: `web/app/api/vat-rate/route.ts`**

First verify the rule-type literal: `grep -rn "vat_standard" /Users/karlis/git/book-keeping/src /Users/karlis/git/book-keeping/migrations | head` — use the literal that `src/tax/` and the seed data actually use (expected `'vat_standard'`; if the grep shows a different string, substitute it below).

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { getTaxRate } from '@domain/tax/rules.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const on = req.nextUrl.searchParams.get('on') ?? new Date().toISOString().slice(0, 10);

  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const rule = await withTenant(ctx, (tx) => getTaxRate(tx, 'vat_standard', on));
    return NextResponse.json({ rate: Number(rule.value) }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: /session/i.test(msg) ? 401 : 403 });
  }
}
```

- [ ] **Step 4: Typecheck**

Run: `cd /Users/karlis/git/book-keeping/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add web/app/lib/access-point.ts web/app/api/einvoices web/app/api/vat-rate
git commit -m "feat(web): einvoice issue/list + vat-rate API routes"
```

---

### Task 5: Invoice outbox page + nav

**Files:**
- Create: `web/app/(cabinet)/invoices/page.tsx`, `web/app/(cabinet)/invoices/page.module.css`
- Modify: `web/app/components/Sidebar.tsx`, `web/app/components/NavIcon.tsx`, `web/app/lib/i18n.ts`

**Interfaces:**
- Consumes: `GET /api/einvoices` (Task 4), `formatCents` + `formatDate`-style helpers from `@/app/lib/format`, `LOCALE_FOR` for dates.
- Produces: page at `/invoices?client=<uuid>` with a "New invoice" link to `/invoices/new?client=<uuid>`; nav key `'invoices'`. Task 6 links back here.

- [ ] **Step 1: i18n keys** (EN shown; add LV + RU translations following Task 2's pattern — translate faithfully, no uppercase tracking):

```typescript
// EN
'nav.invoices': 'Invoices',
'nav.short.invoices': 'Invoices',
'einv.title': 'Invoices',
'einv.new': 'New invoice',
'einv.number': 'Invoice',
'einv.issueDate': 'Issued',
'einv.total': 'Total',
'einv.peppol': 'Peppol',
'einv.vid': 'VID',
'einv.vidDue': 'VID due',
'einv.direction.outbound': 'Sent',
'einv.direction.inbound': 'Received',
'einv.status.queued': 'Queued',
'einv.status.sent': 'Sent',
'einv.status.delivered': 'Delivered',
'einv.status.failed': 'Failed',
'einv.status.received': 'Received',
'einv.status.pending': 'Awaiting submission',
'einv.status.submitted': 'Submitted',
'einv.status.not_required': 'Not required',
'einv.empty': 'No invoices yet.',
'einv.emptyDetail': 'Issue your first invoice and it will appear here with its Peppol and VID status.',
// LV — e.g. 'einv.title': 'Rēķini', 'einv.new': 'Jauns rēķins', 'einv.number': 'Rēķins',
// 'einv.issueDate': 'Izrakstīts', 'einv.total': 'Summa', 'einv.vidDue': 'VID termiņš',
// 'einv.status.pending': 'Gaida iesniegšanu', 'einv.status.submitted': 'Iesniegts',
// 'einv.status.not_required': 'Nav nepieciešams', 'einv.status.queued': 'Rindā',
// 'einv.status.sent': 'Nosūtīts', 'einv.status.delivered': 'Piegādāts', 'einv.status.failed': 'Neizdevās',
// 'einv.status.received': 'Saņemts', 'einv.direction.outbound': 'Nosūtīts', 'einv.direction.inbound': 'Saņemts',
// 'einv.empty': 'Vēl nav rēķinu.', 'einv.emptyDetail': 'Izrakstiet pirmo rēķinu, un tas parādīsies šeit ar Peppol un VID statusu.',
// 'nav.invoices': 'Rēķini', 'nav.short.invoices': 'Rēķini'
// RU — 'einv.title': 'Счета', 'einv.new': 'Новый счёт', 'einv.number': 'Счёт',
// 'einv.issueDate': 'Выставлен', 'einv.total': 'Сумма', 'einv.vidDue': 'Срок VID',
// 'einv.status.pending': 'Ожидает подачи', 'einv.status.submitted': 'Подан',
// 'einv.status.not_required': 'Не требуется', 'einv.status.queued': 'В очереди',
// 'einv.status.sent': 'Отправлен', 'einv.status.delivered': 'Доставлен', 'einv.status.failed': 'Ошибка',
// 'einv.status.received': 'Получен', 'einv.direction.outbound': 'Отправлен', 'einv.direction.inbound': 'Получен',
// 'einv.empty': 'Счетов пока нет.', 'einv.emptyDetail': 'Выставьте первый счёт — он появится здесь со статусами Peppol и VID.',
// 'nav.invoices': 'Счета', 'nav.short.invoices': 'Счета'
```

- [ ] **Step 2: NavIcon `invoices`** (document with lines + a small €-free amount mark, stroked):

```tsx
// Invoice: document with ruled lines
invoices: (
  <>
    <path d="M5.5 2.75h9A1.25 1.25 0 0115.75 4v13.25l-2.25-1.5-1.75 1.5-1.75-1.5-1.75 1.5-2.25-1.5V4A1.25 1.25 0 015.5 2.75z" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M7.5 6.5h5M7.5 9.25h5M7.5 12h3" strokeLinecap="round" />
  </>
),
```

- [ ] **Step 3: Sidebar item** — append to `BASE_ITEMS` (after `documents`), widening unions as in Task 2:

```typescript
{ key: 'nav.invoices', shortKey: 'nav.short.invoices', href: '/invoices', icon: 'invoices' },
```

- [ ] **Step 4: Page** — `web/app/(cabinet)/invoices/page.tsx`:

```tsx
'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import type { MsgKey } from '@/app/lib/i18n';
import { LOCALE_FOR } from '@/app/lib/i18n';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { EmptyState } from '@/app/components/EmptyState';
import { formatCents } from '@/app/lib/format';
import styles from './page.module.css';

interface EinvoiceRow {
  id: string; direction: 'outbound' | 'inbound'; invoiceNumber: string; issueDate: string;
  grandTotalCents: string; currency: string; peppolStatus: string; peppolMessageId: string | null;
  vidStatus: string; vidDueDate: string | null;
}

function InvoicesInner() {
  const searchParams = useSearchParams();
  const { t, lang } = useMessages();
  const clientCompanyId = searchParams.get('client');

  const [rows, setRows] = useState<EinvoiceRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/einvoices?clientCompanyId=${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { einvoices: EinvoiceRow[] };
      setRows(body.einvoices);
    } catch (err) {
      setError((err as Error).message ?? t('state.error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (clientCompanyId) load(clientCompanyId);
  }, [clientCompanyId, load]);

  const fmtDate = (iso: string) =>
    new Intl.DateTimeFormat(LOCALE_FOR[lang], { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));

  // Status keys are constrained by DB CHECKs; fall back to the raw value defensively.
  const statusLabel = (s: string) => {
    const key = `einv.status.${s}` as MsgKey;
    const label = t(key);
    return label === key ? s : label;
  };

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.headRow}>
          <h1 className={styles.pageHeading}>{t('einv.title')}</h1>
          <Link
            className={styles.primaryBtn}
            href={`/invoices/new${clientCompanyId ? `?client=${encodeURIComponent(clientCompanyId)}` : ''}`}
          >
            {t('einv.new')}
          </Link>
        </div>

        {error && <ErrorState message={error} onRetry={() => clientCompanyId && load(clientCompanyId)} />}
        {!error && loading && <div className={styles.skeletons}><SkeletonCard /><SkeletonCard /></div>}
        {!error && !loading && rows && rows.length === 0 && (
          <EmptyState message={t('einv.empty')} detail={t('einv.emptyDetail')} />
        )}
        {!error && !loading && rows && rows.length > 0 && (
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">{t('einv.number')}</th>
                  <th scope="col">{t('einv.issueDate')}</th>
                  <th scope="col" className={styles.colAmount}>{t('einv.total')}</th>
                  <th scope="col">{t('einv.peppol')}</th>
                  <th scope="col">{t('einv.vid')}</th>
                  <th scope="col">{t('einv.vidDue')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className={styles.mono}>{r.invoiceNumber}</td>
                    <td>{fmtDate(r.issueDate)}</td>
                    <td className={styles.colAmount}>{formatCents(r.grandTotalCents, r.currency) ?? '—'}</td>
                    <td>{statusLabel(r.peppolStatus)}</td>
                    <td>{statusLabel(r.vidStatus)}</td>
                    <td>{r.vidDueDate ? fmtDate(r.vidDueDate) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}

function InvoicesSkeleton() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.skeletons}><SkeletonCard /><SkeletonCard /></div>
      </main>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<InvoicesSkeleton />}>
      <InvoicesInner />
    </Suspense>
  );
}
```

- [ ] **Step 5: CSS** — `web/app/(cabinet)/invoices/page.module.css`: copy Task 2's stylesheet verbatim, then append:

```css
.colAmount { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.primaryBtn { text-decoration: none; display: inline-flex; align-items: center; }
```

(The second rule extends the copied `.primaryBtn` for the `<Link>` usage.)

- [ ] **Step 6: Typecheck + commit**

Run: `cd /Users/karlis/git/book-keeping/web && npx tsc --noEmit` → no errors.

```bash
git add web/app/\(cabinet\)/invoices web/app/components/Sidebar.tsx web/app/components/NavIcon.tsx web/app/lib/i18n.ts
git commit -m "feat(web): invoice outbox page with Peppol/VID status"
```

---

### Task 6: Invoice composer (`/invoices/new`)

**Files:**
- Create: `web/app/(cabinet)/invoices/new/page.tsx`, `web/app/(cabinet)/invoices/new/page.module.css`
- Modify: `web/app/lib/i18n.ts`

**Interfaces:**
- Consumes: `GET /api/parties?clientCompanyId` (Task 1), `GET /api/vat-rate` and `POST /api/einvoices` (Task 4), the client-company list the shell already loads — reuse the existing helper in `web/app/lib/api-client.ts` that AppShell/TopBar use to fetch `/api/clients` (read that file first and call the same function; the client object has `{ id, name, regNo, baseCurrency }`).
- Produces: on success navigates to `/invoices?client=…`. EInvoice JSON posted matches `EInvoice` exactly: all money fields as `"123.45"` strings, `vatRate` a number.

- [ ] **Step 1: i18n keys** (EN; translate to LV/RU as before):

```typescript
'einv.compose': 'New invoice',
'einv.customer': 'Customer',
'einv.customer.pick': 'Choose a customer…',
'einv.peppolId': 'Recipient Peppol ID',
'einv.supplier': 'Your details',
'einv.supplier.name': 'Name',
'einv.lines': 'Lines',
'einv.line.description': 'Description',
'einv.line.net': 'Net',
'einv.line.vatRate': 'VAT %',
'einv.line.vat': 'VAT',
'einv.line.add': 'Add line',
'einv.line.remove': 'Remove line',
'einv.netTotal': 'Net total',
'einv.vatTotal': 'VAT total',
'einv.grandTotal': 'Total due',
'einv.issue': 'Issue invoice',
'einv.issuing': 'Issuing…',
'einv.issued': 'Invoice issued',
'einv.noCustomers': 'No customers yet — add one under Customers & vendors first.',
```

LV: `'einv.compose': 'Jauns rēķins', 'einv.customer': 'Klients', 'einv.customer.pick': 'Izvēlieties klientu…', 'einv.peppolId': 'Saņēmēja Peppol ID', 'einv.supplier': 'Jūsu rekvizīti', 'einv.supplier.name': 'Nosaukums', 'einv.lines': 'Pozīcijas', 'einv.line.description': 'Apraksts', 'einv.line.net': 'Neto', 'einv.line.vatRate': 'PVN %', 'einv.line.vat': 'PVN', 'einv.line.add': 'Pievienot pozīciju', 'einv.line.remove': 'Noņemt pozīciju', 'einv.netTotal': 'Neto kopā', 'einv.vatTotal': 'PVN kopā', 'einv.grandTotal': 'Kopā apmaksai', 'einv.issue': 'Izrakstīt rēķinu', 'einv.issuing': 'Izraksta…', 'einv.issued': 'Rēķins izrakstīts', 'einv.noCustomers': 'Vēl nav klientu — vispirms pievienojiet sadaļā Klienti un piegādātāji.'`

RU: `'einv.compose': 'Новый счёт', 'einv.customer': 'Клиент', 'einv.customer.pick': 'Выберите клиента…', 'einv.peppolId': 'Peppol ID получателя', 'einv.supplier': 'Ваши реквизиты', 'einv.supplier.name': 'Название', 'einv.lines': 'Позиции', 'einv.line.description': 'Описание', 'einv.line.net': 'Нетто', 'einv.line.vatRate': 'НДС %', 'einv.line.vat': 'НДС', 'einv.line.add': 'Добавить позицию', 'einv.line.remove': 'Убрать позицию', 'einv.netTotal': 'Итого нетто', 'einv.vatTotal': 'Итого НДС', 'einv.grandTotal': 'Итого к оплате', 'einv.issue': 'Выставить счёт', 'einv.issuing': 'Выставляется…', 'einv.issued': 'Счёт выставлен', 'einv.noCustomers': 'Клиентов пока нет — сначала добавьте в разделе «Клиенты и поставщики».'`

- [ ] **Step 2: Page** — `web/app/(cabinet)/invoices/new/page.tsx`. Cent-safe math is done in integer cents; every money string sent to the API is produced by `fromCents`. VAT per line = `round(netCents * rate / 100)`; totals = sums of line cents, so EN 16931 total-consistency checks hold.

```tsx
'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import { ErrorState } from '@/app/components/ErrorState';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import styles from './page.module.css';

interface PartyRow { id: string; kind: 'customer' | 'vendor' | 'both'; name: string; regNo: string | null; vatNo: string | null; }
interface ClientCompany { id: string; name: string; regNo: string; baseCurrency: string; }
interface LineDraft { description: string; net: string; vatRate: number; }

function toCents(s: string): number {
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
function fromCents(c: number): string {
  return (c / 100).toFixed(2);
}
function lineVatCents(l: LineDraft): number {
  return Math.round((toCents(l.net) * l.vatRate) / 100);
}

function ComposerInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { t } = useMessages();
  const clientCompanyId = searchParams.get('client');

  const [customers, setCustomers] = useState<PartyRow[] | null>(null);
  const [company, setCompany] = useState<ClientCompany | null>(null);
  const [defaultRate, setDefaultRate] = useState<number>(21);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [issueDate, setIssueDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [customerId, setCustomerId] = useState('');
  const [peppolId, setPeppolId] = useState('');
  const [supplierVatNo, setSupplierVatNo] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([{ description: '', net: '', vatRate: 21 }]);
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    setLoadError(null);
    try {
      const [pRes, cRes, rRes] = await Promise.all([
        fetch(`/api/parties?clientCompanyId=${encodeURIComponent(id)}`, { cache: 'no-store' }),
        fetch('/api/clients', { cache: 'no-store' }),
        fetch(`/api/vat-rate?clientCompanyId=${encodeURIComponent(id)}`, { cache: 'no-store' }),
      ]);
      if (!pRes.ok) throw new Error(((await pRes.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${pRes.status}`);
      const parties = ((await pRes.json()) as { parties: PartyRow[] }).parties;
      setCustomers(parties.filter((p) => p.kind === 'customer' || p.kind === 'both'));
      if (cRes.ok) {
        const body = (await cRes.json()) as { clients?: ClientCompany[] };
        const mine = (body.clients ?? []).find((c) => c.id === id) ?? null;
        setCompany(mine);
        if (mine?.regNo) setSupplierVatNo(`LV${mine.regNo}`);
      }
      if (rRes.ok) {
        const body = (await rRes.json()) as { rate?: number };
        if (typeof body.rate === 'number' && Number.isFinite(body.rate)) {
          setDefaultRate(body.rate);
          setLines((ls) => ls.map((l) => ({ ...l, vatRate: body.rate! })));
        }
      }
    } catch (err) {
      setLoadError((err as Error).message ?? t('state.error'));
    }
  }, [t]);

  useEffect(() => {
    if (clientCompanyId) load(clientCompanyId);
  }, [clientCompanyId, load]);

  const customer = useMemo(() => customers?.find((c) => c.id === customerId) ?? null, [customers, customerId]);

  useEffect(() => {
    if (customer?.regNo) setPeppolId(`0088:${customer.regNo}`);
  }, [customer]);

  const netTotalCents = lines.reduce((acc, l) => acc + toCents(l.net), 0);
  const vatTotalCents = lines.reduce((acc, l) => acc + lineVatCents(l), 0);
  const grandTotalCents = netTotalCents + vatTotalCents;

  const canIssue =
    !!clientCompanyId && !!company && !!customer && !!invoiceNumber.trim() && !!peppolId.trim() &&
    lines.length > 0 && lines.every((l) => l.description.trim() && toCents(l.net) > 0);

  async function issue() {
    if (!canIssue || !clientCompanyId || !company || !customer) return;
    setIssuing(true);
    setIssueError(null);
    const invoice = {
      invoiceNumber: invoiceNumber.trim(),
      issueDate,
      currency: company.baseCurrency || 'EUR',
      supplier: { name: company.name, regNo: company.regNo, vatNo: supplierVatNo.trim() },
      customer: { name: customer.name, regNo: customer.regNo ?? '', vatNo: customer.vatNo ?? '' },
      lines: lines.map((l) => ({
        description: l.description.trim(),
        net: fromCents(toCents(l.net)),
        vatRate: l.vatRate,
        vat: fromCents(lineVatCents(l)),
      })),
      netTotal: fromCents(netTotalCents),
      vatTotal: fromCents(vatTotalCents),
      grandTotal: fromCents(grandTotalCents),
    };
    try {
      const res = await fetch('/api/einvoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientCompanyId, invoice, recipientPeppolId: peppolId.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      router.push(`/invoices?client=${encodeURIComponent(clientCompanyId)}`);
    } catch (err) {
      setIssueError((err as Error).message ?? t('state.error'));
      setIssuing(false);
    }
  }

  if (loadError) {
    return (
      <div className={styles.page}><main className={styles.main}>
        <ErrorState message={loadError} onRetry={() => clientCompanyId && load(clientCompanyId)} />
      </main></div>
    );
  }
  if (!customers) {
    return (
      <div className={styles.page}><main className={styles.main}>
        <div className={styles.skeletons}><SkeletonCard /><SkeletonCard /></div>
      </main></div>
    );
  }

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <h1 className={styles.pageHeading}>{t('einv.compose')}</h1>

        {customers.length === 0 ? (
          <p className={styles.notice}>{t('einv.noCustomers')}</p>
        ) : (
          <form className={styles.composer} onSubmit={(e) => { e.preventDefault(); issue(); }}>
            <section className={styles.card}>
              <div className={styles.fieldGrid}>
                <label className={styles.field}>
                  <span>{t('einv.number')}</span>
                  <input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} required />
                </label>
                <label className={styles.field}>
                  <span>{t('einv.issueDate')}</span>
                  <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} required />
                </label>
                <label className={styles.field}>
                  <span>{t('einv.customer')}</span>
                  <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} required>
                    <option value="">{t('einv.customer.pick')}</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </label>
                <label className={styles.field}>
                  <span>{t('einv.peppolId')}</span>
                  <input value={peppolId} onChange={(e) => setPeppolId(e.target.value)} required />
                </label>
              </div>
            </section>

            <section className={styles.card}>
              <h2 className={styles.sectionHeading}>{t('einv.supplier')}</h2>
              <div className={styles.fieldGrid}>
                <label className={styles.field}>
                  <span>{t('einv.supplier.name')}</span>
                  <input value={company?.name ?? ''} readOnly />
                </label>
                <label className={styles.field}>
                  <span>{t('parties.regNo')}</span>
                  <input value={company?.regNo ?? ''} readOnly />
                </label>
                <label className={styles.field}>
                  <span>{t('parties.vatNo')}</span>
                  <input value={supplierVatNo} onChange={(e) => setSupplierVatNo(e.target.value)} />
                </label>
              </div>
            </section>

            <section className={styles.card}>
              <h2 className={styles.sectionHeading}>{t('einv.lines')}</h2>
              <div className={styles.tableWrapper}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">{t('einv.line.description')}</th>
                      <th scope="col" className={styles.colAmount}>{t('einv.line.net')}</th>
                      <th scope="col" className={styles.colAmount}>{t('einv.line.vatRate')}</th>
                      <th scope="col" className={styles.colAmount}>{t('einv.line.vat')}</th>
                      <th scope="col"><span className="sr-only">{t('einv.line.remove')}</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => (
                      <tr key={i}>
                        <td>
                          <input
                            aria-label={t('einv.line.description')}
                            value={l.description}
                            onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))}
                          />
                        </td>
                        <td className={styles.colAmount}>
                          <input
                            aria-label={t('einv.line.net')}
                            inputMode="decimal"
                            className={styles.amountInput}
                            value={l.net}
                            onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, net: e.target.value } : x)))}
                          />
                        </td>
                        <td className={styles.colAmount}>
                          <input
                            aria-label={t('einv.line.vatRate')}
                            inputMode="numeric"
                            className={styles.rateInput}
                            value={String(l.vatRate)}
                            onChange={(e) => {
                              const v = Number(e.target.value);
                              setLines(lines.map((x, j) => (j === i ? { ...x, vatRate: Number.isFinite(v) ? v : defaultRate } : x)));
                            }}
                          />
                        </td>
                        <td className={styles.colAmount}>{fromCents(lineVatCents(l))}</td>
                        <td>
                          <button
                            type="button"
                            className={styles.ghostBtn}
                            onClick={() => setLines(lines.filter((_, j) => j !== i))}
                            disabled={lines.length === 1}
                          >
                            {t('einv.line.remove')}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button
                type="button"
                className={styles.ghostBtn}
                onClick={() => setLines([...lines, { description: '', net: '', vatRate: defaultRate }])}
              >
                {t('einv.line.add')}
              </button>
            </section>

            <section className={styles.card}>
              <dl className={styles.totals}>
                <div><dt>{t('einv.netTotal')}</dt><dd>{fromCents(netTotalCents)}</dd></div>
                <div><dt>{t('einv.vatTotal')}</dt><dd>{fromCents(vatTotalCents)}</dd></div>
                <div className={styles.grand}><dt>{t('einv.grandTotal')}</dt><dd>{fromCents(grandTotalCents)} {company?.baseCurrency ?? 'EUR'}</dd></div>
              </dl>
              {issueError && <p className={styles.formError} role="alert">{issueError}</p>}
              <button type="submit" className={styles.primaryBtn} disabled={!canIssue || issuing}>
                {issuing ? t('einv.issuing') : t('einv.issue')}
              </button>
            </section>
          </form>
        )}
      </main>
    </div>
  );
}

function ComposerSkeleton() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.skeletons}><SkeletonCard /><SkeletonCard /></div>
      </main>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<ComposerSkeleton />}>
      <ComposerInner />
    </Suspense>
  );
}
```

**Note on `/api/clients`:** before wiring, read `web/app/lib/api-client.ts` and the `/api/clients` route to confirm the response field (`clients` vs a bare array) and reuse the exported fetch helper if one exists — adjust the `cRes` handling to match reality.

- [ ] **Step 3: CSS** — `web/app/(cabinet)/invoices/new/page.module.css`: copy Task 2's stylesheet verbatim, then append:

```css
.composer { display: flex; flex-direction: column; gap: var(--space-5); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); padding: var(--space-5); display: flex; flex-direction: column; gap: var(--space-4); }
.sectionHeading { font-size: 1rem; font-weight: 600; color: var(--ink); margin: 0; }
.fieldGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-4); }
.notice { color: var(--ink-soft); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); padding: var(--space-5); }
.colAmount { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.table td input { width: 100%; font: inherit; color: var(--ink); background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: var(--space-1) var(--space-2); }
.amountInput { max-width: 8rem; text-align: right; }
.rateInput { max-width: 4.5rem; text-align: right; }
.totals { display: flex; flex-direction: column; gap: var(--space-2); margin: 0; }
.totals div { display: flex; justify-content: space-between; gap: var(--space-4); }
.totals dt { color: var(--ink-soft); }
.totals dd { margin: 0; font-variant-numeric: tabular-nums; }
.grand dt, .grand dd { font-weight: 600; color: var(--ink); }
```

- [ ] **Step 4: Typecheck + commit**

Run: `cd /Users/karlis/git/book-keeping/web && npx tsc --noEmit` → no errors.

```bash
git add web/app/\(cabinet\)/invoices/new web/app/lib/i18n.ts
git commit -m "feat(web): invoice composer with VAT auto-compute and issue flow"
```

---

### Task 7: Domain — `listBankTransactions` + tests

**Files:**
- Create: `src/banking/query.ts`
- Test: `tests/banking/query.test.ts`

**Interfaces:**
- Consumes: `bank_transactions` table (migration 014); `importStatement(tx, ctx, stmt: BankStatement)` and `BankTxn` from existing banking module (for the test).
- Produces: `listBankTransactions(tx, ctx, filter?: { status?: 'unmatched'|'matched'|'reconciled'; limit?: number }): Promise<BankTransactionRow[]>` with `BankTransactionRow = { id, account, bookingDate, amountCents, currency, side, reference, counterparty, status, matchedEntryId }`. Tasks 8–9 consume this.

- [ ] **Step 1: Write the failing test** — `tests/banking/query.test.ts`:

```typescript
import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { importStatement } from '../../src/banking/import.js';
import { listBankTransactions } from '../../src/banking/query.js';
import type { BankStatement } from '../../src/banking/camt-parser.js';

const stmt: BankStatement = {
  account: 'LV12BANK0000000000001',
  transactions: [
    { bookingDate: '2026-03-05', amountCents: '12100', currency: 'EUR', side: 'credit', reference: 'INV-1', counterparty: 'SIA Klients', endToEndId: 'E2E-1' },
    { bookingDate: '2026-03-06', amountCents: '5000', currency: 'EUR', side: 'debit', reference: 'Rent', counterparty: 'SIA Namsaimnieks', endToEndId: 'E2E-2' },
  ],
};

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('lists imported transactions newest-first with status', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), (tx) => importStatement(tx, ctx(t), stmt));
  const rows = await withTenant(ctx(t), (tx) => listBankTransactions(tx, ctx(t)));
  expect(rows).toHaveLength(2);
  expect(rows[0]!.bookingDate).toBe('2026-03-06');
  expect(rows[0]!.status).toBe('unmatched');
  expect(rows[1]!.amountCents).toBe('12100');
  expect(rows[1]!.side).toBe('credit');
});

test('filters by status and scopes to tenant', async () => {
  const t1 = await makeFirmAndClient('SIA Viens');
  const t2 = await makeFirmAndClient('SIA Divi');
  await withTenant(ctx(t1), (tx) => importStatement(tx, ctx(t1), stmt));
  const matched = await withTenant(ctx(t1), (tx) => listBankTransactions(tx, ctx(t1), { status: 'matched' }));
  expect(matched).toHaveLength(0);
  const other = await withTenant(ctx(t2), (tx) => listBankTransactions(tx, ctx(t2)));
  expect(other).toHaveLength(0);
});
```

- [ ] **Step 2: Run to verify FAIL** — `npx vitest run tests/banking/query.test.ts` → module-not-found for `src/banking/query.js`.

- [ ] **Step 3: Implement** — `src/banking/query.ts`:

```typescript
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export type BankTxnStatus = 'unmatched' | 'matched' | 'reconciled';

export interface BankTransactionRow {
  id: string;
  account: string;
  bookingDate: string;
  amountCents: string;
  currency: string;
  side: 'credit' | 'debit';
  reference: string;
  counterparty: string;
  status: BankTxnStatus;
  matchedEntryId: string | null;
}

export async function listBankTransactions(
  tx: PoolClient,
  ctx: TenantContext,
  filter: { status?: BankTxnStatus; limit?: number } = {},
): Promise<BankTransactionRow[]> {
  const params: unknown[] = [ctx.clientCompanyId];
  let where = 'client_company_id = $1';
  if (filter.status) {
    params.push(filter.status);
    where += ` AND status = $${params.length}`;
  }
  params.push(filter.limit ?? 100);
  const res = await tx.query(
    `SELECT id, account, to_char(booking_date, 'YYYY-MM-DD') AS booking_date,
            amount_cents::text AS amount_cents, currency, side, reference,
            counterparty, status, matched_entry_id
       FROM bank_transactions
      WHERE ${where}
      ORDER BY booking_date DESC, created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return res.rows.map((r) => ({
    id: r.id,
    account: r.account,
    bookingDate: r.booking_date,
    amountCents: r.amount_cents,
    currency: r.currency,
    side: r.side,
    reference: r.reference,
    counterparty: r.counterparty,
    status: r.status,
    matchedEntryId: r.matched_entry_id,
  }));
}
```

- [ ] **Step 4: Run to verify PASS** — `npx vitest run tests/banking/query.test.ts` → 2 passed; then `npm test` → all pass.

- [ ] **Step 5: Commit**

```bash
git add src/banking/query.ts tests/banking/query.test.ts
git commit -m "feat: listBankTransactions query for bank screen"
```

---

### Task 8: Bank API routes (import, list, payment orders)

**Files:**
- Create: `web/app/api/bank/import/route.ts`
- Create: `web/app/api/bank/transactions/route.ts`
- Create: `web/app/api/bank/payment-orders/route.ts`

**Interfaces:**
- Consumes: `parseCamt053(xml): BankStatement`, `importStatement(tx, ctx, stmt)`, `listBankTransactions` (Task 7), `generateSepaCreditTransfer(payments: { iban, amount, reference }[]): string`, `appendAudit(tx, ctx, {...})` from `@domain/audit/audit.js`.
- Produces: `POST /api/bank/import` body `{ clientCompanyId, xml }` → 200 `{ imported, skipped }`; `GET /api/bank/transactions?clientCompanyId&status?` → `{ transactions: BankTransactionRow[] }`; `POST /api/bank/payment-orders` body `{ clientCompanyId, payments: [{ iban, amount, reference }] }` → 200 `{ xml }`. Task 9 consumes all three.

- [ ] **Step 1: `web/app/api/bank/import/route.ts`**

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { parseCamt053 } from '@domain/banking/camt-parser.js';
import { importStatement } from '@domain/banking/import.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string; xml?: string };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.xml) return NextResponse.json({ error: 'missing xml' }, { status: 400 });

  let stmt;
  try {
    stmt = parseCamt053(body.xml);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `camt.053 parse failed: ${msg}` }, { status: 400 });
  }

  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    const result = await withTenant(ctx, (tx) => importStatement(tx, ctx, stmt));
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: /session/i.test(msg) ? 401 : 403 });
  }
}
```

- [ ] **Step 2: `web/app/api/bank/transactions/route.ts`**

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { listBankTransactions } from '@domain/banking/query.js';
import type { BankTxnStatus } from '@domain/banking/query.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const status = req.nextUrl.searchParams.get('status') as BankTxnStatus | null;

  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const transactions = await withTenant(ctx, (tx) =>
      listBankTransactions(tx, ctx, status ? { status } : {}),
    );
    return NextResponse.json({ transactions }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: /session/i.test(msg) ? 401 : 403 });
  }
}
```

- [ ] **Step 3: `web/app/api/bank/payment-orders/route.ts`** — pure generation, but audited (a payment file leaving the system is an action the audit trail must see):

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { generateSepaCreditTransfer } from '@domain/banking/sepa.js';
import { appendAudit } from '@domain/audit/audit.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';

interface PaymentIn { iban?: string; amount?: string; reference?: string; }

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string; payments?: PaymentIn[] };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const payments = (body.payments ?? []).filter(
    (p): p is { iban: string; amount: string; reference: string } =>
      !!p.iban?.trim() && !!p.amount?.trim() && Number(p.amount) > 0 && p.reference !== undefined,
  );
  if (payments.length === 0) return NextResponse.json({ error: 'no valid payments' }, { status: 400 });

  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    const xml = generateSepaCreditTransfer(payments);
    await withTenant(ctx, (tx) =>
      appendAudit(tx, ctx, {
        action: 'payment_order.generated',
        entityType: 'payment_order',
        entityId: null,
        before: null,
        after: { count: payments.length, references: payments.map((p) => p.reference) },
      }),
    );
    return NextResponse.json({ xml }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: /session/i.test(msg) ? 401 : 403 });
  }
}
```

- [ ] **Step 4: Typecheck + commit**

Run: `cd /Users/karlis/git/book-keeping/web && npx tsc --noEmit` → no errors.

```bash
git add web/app/api/bank
git commit -m "feat(web): bank import/transactions/payment-order API routes"
```

---

### Task 9: Bank page (statement upload, transactions, payment orders) + nav

**Files:**
- Create: `web/app/(cabinet)/bank/page.tsx`, `web/app/(cabinet)/bank/page.module.css`
- Modify: `web/app/components/Sidebar.tsx`, `web/app/components/NavIcon.tsx`, `web/app/lib/i18n.ts`

**Interfaces:**
- Consumes: Task 8 routes; `formatCents`; match proposals already surface in the approval queue (`/`), so this page only links there conceptually — no queue changes.
- Produces: page at `/bank?client=<uuid>`; nav key `'bank'`.

- [ ] **Step 1: i18n keys** (EN; add LV + RU translations following Task 2's pattern):

```typescript
'nav.bank': 'Bank',
'nav.short.bank': 'Bank',
'bankpage.title': 'Bank',
'bankpage.upload': 'Import a camt.053 statement',
'bankpage.uploadHint': 'Drop or choose the XML file your bank exported.',
'bankpage.choose': 'Choose file',
'bankpage.imported': '{imported} imported, {skipped} already known',
'bankpage.transactions': 'Transactions',
'bankpage.date': 'Date',
'bankpage.counterparty': 'Counterparty',
'bankpage.reference': 'Reference',
'bankpage.amount': 'Amount',
'bankpage.status': 'Status',
'bankpage.status.unmatched': 'Unmatched',
'bankpage.status.matched': 'Matched',
'bankpage.status.reconciled': 'Reconciled',
'bankpage.matchHint': 'Match proposals appear in the approval queue.',
'bankpage.empty': 'No bank transactions yet.',
'bankpage.emptyDetail': 'Import a statement and the transactions will appear here.',
'bankpage.orders': 'Payment order',
'bankpage.ordersHint': 'Compose a SEPA credit transfer (pain.001) and download it for your bank.',
'bankpage.iban': 'IBAN',
'bankpage.orderAmount': 'Amount (EUR)',
'bankpage.orderReference': 'Reference',
'bankpage.addPayment': 'Add payment',
'bankpage.removePayment': 'Remove payment',
'bankpage.generate': 'Generate pain.001',
'bankpage.generated': 'Payment file downloaded',
```

LV: `'nav.bank': 'Banka', 'nav.short.bank': 'Banka', 'bankpage.title': 'Banka', 'bankpage.upload': 'Importēt camt.053 izrakstu', 'bankpage.uploadHint': 'Ievelciet vai izvēlieties bankas eksportēto XML failu.', 'bankpage.choose': 'Izvēlēties failu', 'bankpage.imported': '{imported} importēti, {skipped} jau zināmi', 'bankpage.transactions': 'Darījumi', 'bankpage.date': 'Datums', 'bankpage.counterparty': 'Darījuma partneris', 'bankpage.reference': 'Maksājuma mērķis', 'bankpage.amount': 'Summa', 'bankpage.status': 'Statuss', 'bankpage.status.unmatched': 'Nesaistīts', 'bankpage.status.matched': 'Saistīts', 'bankpage.status.reconciled': 'Saskaņots', 'bankpage.matchHint': 'Saistīšanas priekšlikumi parādās apstiprināšanas rindā.', 'bankpage.empty': 'Vēl nav bankas darījumu.', 'bankpage.emptyDetail': 'Importējiet izrakstu, un darījumi parādīsies šeit.', 'bankpage.orders': 'Maksājuma uzdevums', 'bankpage.ordersHint': 'Sagatavojiet SEPA pārskaitījumu (pain.001) un lejupielādējiet to savai bankai.', 'bankpage.iban': 'IBAN', 'bankpage.orderAmount': 'Summa (EUR)', 'bankpage.orderReference': 'Maksājuma mērķis', 'bankpage.addPayment': 'Pievienot maksājumu', 'bankpage.removePayment': 'Noņemt maksājumu', 'bankpage.generate': 'Ģenerēt pain.001', 'bankpage.generated': 'Maksājuma fails lejupielādēts'`

RU: `'nav.bank': 'Банк', 'nav.short.bank': 'Банк', 'bankpage.title': 'Банк', 'bankpage.upload': 'Импорт выписки camt.053', 'bankpage.uploadHint': 'Перетащите или выберите XML-файл, экспортированный банком.', 'bankpage.choose': 'Выбрать файл', 'bankpage.imported': '{imported} импортировано, {skipped} уже известны', 'bankpage.transactions': 'Операции', 'bankpage.date': 'Дата', 'bankpage.counterparty': 'Контрагент', 'bankpage.reference': 'Назначение платежа', 'bankpage.amount': 'Сумма', 'bankpage.status': 'Статус', 'bankpage.status.unmatched': 'Не сопоставлено', 'bankpage.status.matched': 'Сопоставлено', 'bankpage.status.reconciled': 'Сверено', 'bankpage.matchHint': 'Предложения сопоставления появляются в очереди согласования.', 'bankpage.empty': 'Банковских операций пока нет.', 'bankpage.emptyDetail': 'Импортируйте выписку — операции появятся здесь.', 'bankpage.orders': 'Платёжное поручение', 'bankpage.ordersHint': 'Составьте SEPA-перевод (pain.001) и скачайте файл для банка.', 'bankpage.iban': 'IBAN', 'bankpage.orderAmount': 'Сумма (EUR)', 'bankpage.orderReference': 'Назначение', 'bankpage.addPayment': 'Добавить платёж', 'bankpage.removePayment': 'Убрать платёж', 'bankpage.generate': 'Сформировать pain.001', 'bankpage.generated': 'Платёжный файл скачан'`

- [ ] **Step 2: NavIcon `bank`**:

```tsx
// Bank: pediment + columns
bank: (
  <>
    <path d="M3.5 8h13L10 3.5 3.5 8z" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M5.5 8v6M10 8v6M14.5 8v6" strokeLinecap="round" />
    <path d="M3.5 16.5h13" strokeLinecap="round" />
  </>
),
```

- [ ] **Step 3: Sidebar item** — append to `BASE_ITEMS` after `invoices`:

```typescript
{ key: 'nav.bank', shortKey: 'nav.short.bank', href: '/bank', icon: 'bank' },
```

- [ ] **Step 4: Page** — `web/app/(cabinet)/bank/page.tsx`:

```tsx
'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import type { MsgKey } from '@/app/lib/i18n';
import { LOCALE_FOR } from '@/app/lib/i18n';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { EmptyState } from '@/app/components/EmptyState';
import { formatCents } from '@/app/lib/format';
import styles from './page.module.css';

interface BankTransactionRow {
  id: string; account: string; bookingDate: string; amountCents: string; currency: string;
  side: 'credit' | 'debit'; reference: string; counterparty: string; status: string; matchedEntryId: string | null;
}
interface PaymentDraft { iban: string; amount: string; reference: string; }

function BankInner() {
  const searchParams = useSearchParams();
  const { t, lang } = useMessages();
  const clientCompanyId = searchParams.get('client');
  const fileInput = useRef<HTMLInputElement>(null);

  const [rows, setRows] = useState<BankTransactionRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [payments, setPayments] = useState<PaymentDraft[]>([{ iban: '', amount: '', reference: '' }]);
  const [generating, setGenerating] = useState(false);
  const [orderMsg, setOrderMsg] = useState<string | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/bank/transactions?clientCompanyId=${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setRows(((await res.json()) as { transactions: BankTransactionRow[] }).transactions);
    } catch (err) {
      setError((err as Error).message ?? t('state.error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (clientCompanyId) load(clientCompanyId);
  }, [clientCompanyId, load]);

  async function importFile(file: File) {
    if (!clientCompanyId) return;
    setImporting(true);
    setImportMsg(null);
    setImportError(null);
    try {
      const xml = await file.text();
      const res = await fetch('/api/bank/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientCompanyId, xml }),
      });
      const body = (await res.json().catch(() => ({}))) as { imported?: number; skipped?: number; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setImportMsg(
        t('bankpage.imported')
          .replace('{imported}', String(body.imported ?? 0))
          .replace('{skipped}', String(body.skipped ?? 0)),
      );
      await load(clientCompanyId);
    } catch (err) {
      setImportError((err as Error).message ?? t('state.error'));
    } finally {
      setImporting(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function generateOrder() {
    if (!clientCompanyId) return;
    setGenerating(true);
    setOrderMsg(null);
    setOrderError(null);
    try {
      const res = await fetch('/api/bank/payment-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientCompanyId, payments }),
      });
      const body = (await res.json().catch(() => ({}))) as { xml?: string; error?: string };
      if (!res.ok || !body.xml) throw new Error(body.error ?? `HTTP ${res.status}`);
      const blob = new Blob([body.xml], { type: 'application/xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'pain001.xml';
      a.click();
      URL.revokeObjectURL(url);
      setOrderMsg(t('bankpage.generated'));
    } catch (err) {
      setOrderError((err as Error).message ?? t('state.error'));
    } finally {
      setGenerating(false);
    }
  }

  const fmtDate = (iso: string) =>
    new Intl.DateTimeFormat(LOCALE_FOR[lang], { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
  const statusLabel = (s: string) => {
    const key = `bankpage.status.${s}` as MsgKey;
    const label = t(key);
    return label === key ? s : label;
  };
  const signedAmount = (r: BankTransactionRow) => {
    const n = formatCents(r.amountCents, r.currency) ?? '—';
    return r.side === 'debit' ? `−${n}` : n;
  };
  const canGenerate = payments.some((p) => p.iban.trim() && Number(p.amount) > 0);

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <h1 className={styles.pageHeading}>{t('bankpage.title')}</h1>

        <section className={styles.card} aria-labelledby="upload-heading">
          <h2 id="upload-heading" className={styles.sectionHeading}>{t('bankpage.upload')}</h2>
          <p className={styles.hint}>{t('bankpage.uploadHint')}</p>
          <input
            ref={fileInput}
            type="file"
            accept=".xml,text/xml,application/xml"
            className="sr-only"
            id="camt-file"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); }}
          />
          <label htmlFor="camt-file" className={styles.primaryBtn} aria-disabled={importing}>
            {importing ? t('state.loading') : t('bankpage.choose')}
          </label>
          {importMsg && <p className={styles.okMsg} role="status">{importMsg}</p>}
          {importError && <p className={styles.formError} role="alert">{importError}</p>}
        </section>

        <section className={styles.card} aria-labelledby="txns-heading">
          <h2 id="txns-heading" className={styles.sectionHeading}>{t('bankpage.transactions')}</h2>
          <p className={styles.hint}>{t('bankpage.matchHint')}</p>
          {error && <ErrorState message={error} onRetry={() => clientCompanyId && load(clientCompanyId)} />}
          {!error && loading && <div className={styles.skeletons}><SkeletonCard /></div>}
          {!error && !loading && rows && rows.length === 0 && (
            <EmptyState message={t('bankpage.empty')} detail={t('bankpage.emptyDetail')} />
          )}
          {!error && !loading && rows && rows.length > 0 && (
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">{t('bankpage.date')}</th>
                    <th scope="col">{t('bankpage.counterparty')}</th>
                    <th scope="col">{t('bankpage.reference')}</th>
                    <th scope="col" className={styles.colAmount}>{t('bankpage.amount')}</th>
                    <th scope="col">{t('bankpage.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>{fmtDate(r.bookingDate)}</td>
                      <td>{r.counterparty || '—'}</td>
                      <td>{r.reference || '—'}</td>
                      <td className={styles.colAmount}>{signedAmount(r)}</td>
                      <td>{statusLabel(r.status)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className={styles.card} aria-labelledby="orders-heading">
          <h2 id="orders-heading" className={styles.sectionHeading}>{t('bankpage.orders')}</h2>
          <p className={styles.hint}>{t('bankpage.ordersHint')}</p>
          {payments.map((p, i) => (
            <div key={i} className={styles.paymentRow}>
              <label className={styles.field}>
                <span>{t('bankpage.iban')}</span>
                <input value={p.iban} onChange={(e) => setPayments(payments.map((x, j) => (j === i ? { ...x, iban: e.target.value } : x)))} />
              </label>
              <label className={styles.field}>
                <span>{t('bankpage.orderAmount')}</span>
                <input inputMode="decimal" value={p.amount} onChange={(e) => setPayments(payments.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
              </label>
              <label className={styles.field}>
                <span>{t('bankpage.orderReference')}</span>
                <input value={p.reference} onChange={(e) => setPayments(payments.map((x, j) => (j === i ? { ...x, reference: e.target.value } : x)))} />
              </label>
              <button type="button" className={styles.ghostBtn} onClick={() => setPayments(payments.filter((_, j) => j !== i))} disabled={payments.length === 1}>
                {t('bankpage.removePayment')}
              </button>
            </div>
          ))}
          <div className={styles.formActions}>
            <button type="button" className={styles.ghostBtn} onClick={() => setPayments([...payments, { iban: '', amount: '', reference: '' }])}>
              {t('bankpage.addPayment')}
            </button>
            <button type="button" className={styles.primaryBtn} onClick={generateOrder} disabled={!canGenerate || generating}>
              {t('bankpage.generate')}
            </button>
          </div>
          {orderMsg && <p className={styles.okMsg} role="status">{orderMsg}</p>}
          {orderError && <p className={styles.formError} role="alert">{orderError}</p>}
        </section>
      </main>
    </div>
  );
}

function BankSkeleton() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.skeletons}><SkeletonCard /><SkeletonCard /></div>
      </main>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<BankSkeleton />}>
      <BankInner />
    </Suspense>
  );
}
```

- [ ] **Step 5: CSS** — `web/app/(cabinet)/bank/page.module.css`: copy Task 2's stylesheet verbatim, then append:

```css
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); padding: var(--space-5); display: flex; flex-direction: column; gap: var(--space-4); align-items: flex-start; }
.card .tableWrapper { align-self: stretch; }
.sectionHeading { font-size: 1rem; font-weight: 600; color: var(--ink); margin: 0; }
.hint { color: var(--ink-soft); font-size: 0.875rem; margin: 0; }
.okMsg { color: var(--ok); font-size: 0.875rem; margin: 0; }
.colAmount { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.paymentRow { display: grid; grid-template-columns: 2fr 1fr 2fr auto; gap: var(--space-3); align-items: end; align-self: stretch; }
@media (max-width: 640px) { .paymentRow { grid-template-columns: 1fr; align-items: stretch; } }
label.primaryBtn { display: inline-flex; cursor: pointer; }
```

- [ ] **Step 6: Typecheck + commit**

Run: `cd /Users/karlis/git/book-keeping/web && npx tsc --noEmit` → no errors.

```bash
git add web/app/\(cabinet\)/bank web/app/components/Sidebar.tsx web/app/components/NavIcon.tsx web/app/lib/i18n.ts
git commit -m "feat(web): bank page — camt.053 import, transactions, pain.001 payment orders"
```

---

### Task 10: Domain — `listJournalEntries`, `listPeriods`, `listAutonomyPolicies` + tests

**Files:**
- Create: `src/ledger/query.ts`
- Modify: `src/ledger/periods.ts` (append `listPeriods`)
- Modify: `src/autonomy/autonomy.ts` (append `listAutonomyPolicies`)
- Test: `tests/ledger/query.test.ts`, `tests/ledger/list-periods.test.ts`, `tests/autonomy/list.test.ts`

**Interfaces:**
- Consumes: `journal_entries`/`journal_lines`/`accounts` tables; `accounting_periods`; `autonomy_policy`; for tests `postEntry`, `openPeriod`, `closePeriod`, `setAutonomy`, `createAccount`.
- Produces (Tasks 11–12 consume):
  - `listJournalEntries(tx, ctx, filter?: { limit?: number }): Promise<JournalEntryListRow[]>` — `JournalEntryListRow = { id, entryDate, memo, currency, reversesEntryId, lines: { accountCode, accountName, debit, credit, description }[] }`
  - `listPeriods(tx, ctx): Promise<{ year, month, status }[]>`
  - `listAutonomyPolicies(tx, ctx): Promise<{ operationType, mode, materialThresholdCents }[]>` (`materialThresholdCents` as string)

- [ ] **Step 1: Failing test 1** — `tests/ledger/query.test.ts`:

```typescript
import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { listJournalEntries } from '../../src/ledger/query.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('lists posted entries newest-first with account-coded lines', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2600', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    await postEntry(tx, ctx(t), {
      date: '2026-03-01', memo: 'First', currency: 'EUR',
      lines: [
        { accountCode: '2600', debit: '100.00', credit: '0' },
        { accountCode: '6110', debit: '0', credit: '100.00' },
      ],
    });
    await postEntry(tx, ctx(t), {
      date: '2026-03-15', memo: 'Second', currency: 'EUR',
      lines: [
        { accountCode: '2600', debit: '50.00', credit: '0' },
        { accountCode: '6110', debit: '0', credit: '50.00' },
      ],
    });
  });
  const entries = await withTenant(ctx(t), (tx) => listJournalEntries(tx, ctx(t)));
  expect(entries).toHaveLength(2);
  expect(entries[0]!.memo).toBe('Second');
  expect(entries[0]!.entryDate).toBe('2026-03-15');
  expect(entries[0]!.lines).toHaveLength(2);
  const bankLine = entries[0]!.lines.find((l) => l.accountCode === '2600')!;
  expect(bankLine.debit).toBe('50.00');
  expect(bankLine.accountName).toBe('Bank');
});

test('limit applies to entries, not lines; tenant-scoped', async () => {
  const t = await makeFirmAndClient();
  const t2 = await makeFirmAndClient('SIA Cits');
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2600', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    for (const d of ['2026-03-01', '2026-03-02', '2026-03-03']) {
      await postEntry(tx, ctx(t), {
        date: d, memo: `E ${d}`, currency: 'EUR',
        lines: [
          { accountCode: '2600', debit: '10.00', credit: '0' },
          { accountCode: '6110', debit: '0', credit: '10.00' },
        ],
      });
    }
  });
  const limited = await withTenant(ctx(t), (tx) => listJournalEntries(tx, ctx(t), { limit: 2 }));
  expect(limited).toHaveLength(2);
  expect(limited.every((e) => e.lines.length === 2)).toBe(true);
  const other = await withTenant(ctx(t2), (tx) => listJournalEntries(tx, ctx(t2)));
  expect(other).toHaveLength(0);
});
```

(`postEntry`'s exact line shape: `NewJournalLine = { accountCode, debit, credit, description? }` — matches above. If `debit: '0'` fails a numeric check, use `'0.00'`.)

- [ ] **Step 2: Failing tests 2+3** — `tests/ledger/list-periods.test.ts`:

```typescript
import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { openPeriod, closePeriod, listPeriods } from '../../src/ledger/periods.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('lists periods newest-first with status', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await openPeriod(tx, ctx(t), { year: 2026, month: 1 });
    await openPeriod(tx, ctx(t), { year: 2026, month: 2 });
    await closePeriod(tx, ctx(t), { year: 2026, month: 1 });
  });
  const periods = await withTenant(ctx(t), (tx) => listPeriods(tx, ctx(t)));
  expect(periods).toEqual([
    { year: 2026, month: 2, status: 'open' },
    { year: 2026, month: 1, status: 'closed' },
  ]);
});
```

and `tests/autonomy/list.test.ts`:

```typescript
import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { setAutonomy, listAutonomyPolicies } from '../../src/autonomy/autonomy.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('lists configured policies with thresholds as strings', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await setAutonomy(tx, ctx(t), { operationType: 'posting', mode: 'auto', materialThresholdCents: 50000n });
    await setAutonomy(tx, ctx(t), { operationType: 'bank_match', mode: 'approval' });
  });
  const policies = await withTenant(ctx(t), (tx) => listAutonomyPolicies(tx, ctx(t)));
  expect(policies).toHaveLength(2);
  const posting = policies.find((p) => p.operationType === 'posting')!;
  expect(posting.mode).toBe('auto');
  expect(posting.materialThresholdCents).toBe('50000');
});
```

- [ ] **Step 3: Run all three to verify FAIL** — `npx vitest run tests/ledger/query.test.ts tests/ledger/list-periods.test.ts tests/autonomy/list.test.ts` → import errors for the three new exports.

- [ ] **Step 4: Implement.** `src/ledger/query.ts`:

```typescript
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export interface JournalEntryListLine {
  accountCode: string;
  accountName: string;
  debit: string;
  credit: string;
  description: string | null;
}

export interface JournalEntryListRow {
  id: string;
  entryDate: string;
  memo: string;
  currency: string;
  reversesEntryId: string | null;
  lines: JournalEntryListLine[];
}

export async function listJournalEntries(
  tx: PoolClient,
  ctx: TenantContext,
  filter: { limit?: number } = {},
): Promise<JournalEntryListRow[]> {
  const res = await tx.query(
    `SELECT e.id, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date, e.memo, e.currency,
            e.reverses_entry_id,
            a.code AS account_code, a.name AS account_name,
            l.debit::text AS debit, l.credit::text AS credit, l.description
       FROM (SELECT id FROM journal_entries
              WHERE client_company_id = $1
              ORDER BY entry_date DESC, created_at DESC
              LIMIT $2) sel
       JOIN journal_entries e ON e.id = sel.id
       JOIN journal_lines l ON l.entry_id = e.id
       JOIN accounts a ON a.id = l.account_id
      ORDER BY e.entry_date DESC, e.created_at DESC, e.id, a.code`,
    [ctx.clientCompanyId, filter.limit ?? 50],
  );
  const byId = new Map<string, JournalEntryListRow>();
  for (const r of res.rows) {
    let entry = byId.get(r.id);
    if (!entry) {
      entry = {
        id: r.id,
        entryDate: r.entry_date,
        memo: r.memo,
        currency: r.currency,
        reversesEntryId: r.reverses_entry_id,
        lines: [],
      };
      byId.set(r.id, entry);
    }
    entry.lines.push({
      accountCode: r.account_code,
      accountName: r.account_name,
      debit: r.debit,
      credit: r.credit,
      description: r.description,
    });
  }
  return [...byId.values()];
}
```

Append to `src/ledger/periods.ts`:

```typescript
export interface PeriodRow { year: number; month: number; status: 'open' | 'closed'; }

export async function listPeriods(tx: PoolClient, ctx: TenantContext): Promise<PeriodRow[]> {
  const res = await tx.query(
    `SELECT year, month, status FROM accounting_periods
      WHERE client_company_id = $1
      ORDER BY year DESC, month DESC`,
    [ctx.clientCompanyId],
  );
  return res.rows.map((r) => ({ year: r.year, month: r.month, status: r.status }));
}
```

(Match the file's existing imports — `PoolClient`/`TenantContext` are already imported there.)

Append to `src/autonomy/autonomy.ts`:

```typescript
export interface AutonomyPolicyRow {
  operationType: string;
  mode: AutonomyMode;
  materialThresholdCents: string;
}

export async function listAutonomyPolicies(tx: PoolClient, ctx: TenantContext): Promise<AutonomyPolicyRow[]> {
  const res = await tx.query(
    `SELECT operation_type, mode, material_threshold_cents::text AS material_threshold_cents
       FROM autonomy_policy
      WHERE client_company_id = $1
      ORDER BY operation_type`,
    [ctx.clientCompanyId],
  );
  return res.rows.map((r) => ({
    operationType: r.operation_type,
    mode: r.mode,
    materialThresholdCents: r.material_threshold_cents,
  }));
}
```

- [ ] **Step 5: Run to verify PASS** — the three files, then full `npm test` → all pass.

- [ ] **Step 6: Commit**

```bash
git add src/ledger/query.ts src/ledger/periods.ts src/autonomy/autonomy.ts tests/ledger/query.test.ts tests/ledger/list-periods.test.ts tests/autonomy/list.test.ts
git commit -m "feat: list queries for journal entries, periods, autonomy policies"
```

---

### Task 11: Journal API route + journal browser page + nav

**Files:**
- Create: `web/app/api/journal/route.ts`
- Create: `web/app/(cabinet)/journal/page.tsx`, `web/app/(cabinet)/journal/page.module.css`
- Modify: `web/app/components/Sidebar.tsx`, `web/app/components/NavIcon.tsx`, `web/app/lib/i18n.ts`

**Interfaces:**
- Consumes: `listJournalEntries` (Task 10); `parsePaging` from `@/app/lib/paging` if its shape fits (`{ limit }`) — otherwise read `limit` from searchParams directly as in Task 4.
- Produces: `GET /api/journal?clientCompanyId&limit?` → `{ entries: JournalEntryListRow[] }`; page at `/journal?client=<uuid>`; nav key `'journal'`.

- [ ] **Step 1: Route** — `web/app/api/journal/route.ts`:

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { listJournalEntries } from '@domain/ledger/query.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const limitParam = Number(req.nextUrl.searchParams.get('limit'));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : 50;

  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const entries = await withTenant(ctx, (tx) => listJournalEntries(tx, ctx, { limit }));
    return NextResponse.json({ entries }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: /session/i.test(msg) ? 401 : 403 });
  }
}
```

- [ ] **Step 2: i18n keys** (EN; add LV + RU following Task 2's pattern):

```typescript
'nav.journal': 'Journal',
'nav.short.journal': 'Journal',
'journal.title': 'Journal',
'journal.date': 'Date',
'journal.memo': 'Memo',
'journal.reversal': 'Reversal',
'journal.empty': 'No journal entries yet.',
'journal.emptyDetail': 'Approved postings will appear here.',
'journal.showMore': 'Show more',
```

LV: `'nav.journal': 'Žurnāls', 'nav.short.journal': 'Žurnāls', 'journal.title': 'Žurnāls', 'journal.date': 'Datums', 'journal.memo': 'Apraksts', 'journal.reversal': 'Storno', 'journal.empty': 'Vēl nav žurnāla ierakstu.', 'journal.emptyDetail': 'Apstiprinātie grāmatojumi parādīsies šeit.', 'journal.showMore': 'Rādīt vairāk'`

RU: `'nav.journal': 'Журнал', 'nav.short.journal': 'Журнал', 'journal.title': 'Журнал', 'journal.date': 'Дата', 'journal.memo': 'Описание', 'journal.reversal': 'Сторно', 'journal.empty': 'Записей в журнале пока нет.', 'journal.emptyDetail': 'Утверждённые проводки появятся здесь.', 'journal.showMore': 'Показать ещё'`

- [ ] **Step 3: NavIcon `journal`** + Sidebar item (append after `bank`):

```tsx
// Open ledger book
journal: (
  <>
    <path d="M10 4.5c-1.5-1.2-3.5-1.5-6-1.2V15c2.5-.3 4.5 0 6 1.2 1.5-1.2 3.5-1.5 6-1.2V3.3c-2.5-.3-4.5 0-6 1.2z" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M10 4.5v11.7" strokeLinecap="round" />
  </>
),
```

```typescript
{ key: 'nav.journal', shortKey: 'nav.short.journal', href: '/journal', icon: 'journal' },
```

- [ ] **Step 4: Page** — `web/app/(cabinet)/journal/page.tsx`. Entries render as cards: date + memo header, lines table underneath (reusing the tabular-numeral conventions). Growing-window pagination like the queue (`PAGE_SIZE = 50`, refetch with larger limit):

```tsx
'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import { LOCALE_FOR } from '@/app/lib/i18n';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { EmptyState } from '@/app/components/EmptyState';
import { LoadMoreButton } from '@/app/components/LoadMoreButton';
import styles from './page.module.css';

const PAGE_SIZE = 50;

interface JournalLine { accountCode: string; accountName: string; debit: string; credit: string; description: string | null; }
interface JournalEntry { id: string; entryDate: string; memo: string; currency: string; reversesEntryId: string | null; lines: JournalLine[]; }

function isZero(v: string): boolean { return !v || Number(v) === 0; }

function JournalInner() {
  const searchParams = useSearchParams();
  const { t, lang } = useMessages();
  const clientCompanyId = searchParams.get('client');

  const [entries, setEntries] = useState<JournalEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE_SIZE);

  const load = useCallback(async (id: string, max: number, quiet: boolean) => {
    if (quiet) setLoadingMore(true); else setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/journal?clientCompanyId=${encodeURIComponent(id)}&limit=${max}`,
        { cache: 'no-store' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setEntries(((await res.json()) as { entries: JournalEntry[] }).entries);
    } catch (err) {
      setError((err as Error).message ?? t('state.error'));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [t]);

  useEffect(() => {
    setLimit(PAGE_SIZE);
    if (clientCompanyId) load(clientCompanyId, PAGE_SIZE, false);
  }, [clientCompanyId, load]);

  const fmtDate = (iso: string) =>
    new Intl.DateTimeFormat(LOCALE_FOR[lang], { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
  const fmtAmount = (v: string) =>
    isZero(v) ? '—' : new Intl.NumberFormat('lv-LV', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v));

  const canLoadMore = !!entries && entries.length >= limit;

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <h1 className={styles.pageHeading}>{t('journal.title')}</h1>

        {error && <ErrorState message={error} onRetry={() => clientCompanyId && load(clientCompanyId, limit, false)} />}
        {!error && loading && <div className={styles.skeletons}><SkeletonCard /><SkeletonCard /></div>}
        {!error && !loading && entries && entries.length === 0 && (
          <EmptyState message={t('journal.empty')} detail={t('journal.emptyDetail')} />
        )}
        {!error && !loading && entries && entries.length > 0 && (
          <div className={styles.entries}>
            {entries.map((e) => (
              <article key={e.id} className={styles.entry}>
                <header className={styles.entryHead}>
                  <span className={styles.entryDate}>{fmtDate(e.entryDate)}</span>
                  <span className={styles.entryMemo}>{e.memo}</span>
                  {e.reversesEntryId && <span className={styles.reversal}>{t('journal.reversal')}</span>}
                </header>
                <div className={styles.tableWrapper}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th scope="col">{t('over.account')}</th>
                        <th scope="col" className={styles.colAmount}>{t('over.debit')}</th>
                        <th scope="col" className={styles.colAmount}>{t('over.credit')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {e.lines.map((l, i) => (
                        <tr key={i}>
                          <td>
                            <span className={styles.mono}>{l.accountCode}</span>
                            <span className={styles.accountName}> {l.accountName}</span>
                          </td>
                          <td className={styles.colAmount}>{fmtAmount(l.debit)}</td>
                          <td className={styles.colAmount}>{fmtAmount(l.credit)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>
            ))}
            {canLoadMore && (
              <LoadMoreButton
                busy={loadingMore}
                onClick={() => {
                  const next = limit + PAGE_SIZE;
                  setLimit(next);
                  if (clientCompanyId) load(clientCompanyId, next, true);
                }}
              />
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function JournalSkeleton() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.skeletons}><SkeletonCard /><SkeletonCard /></div>
      </main>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<JournalSkeleton />}>
      <JournalInner />
    </Suspense>
  );
}
```

**Check `LoadMoreButton`'s props first** (`web/app/components/LoadMoreButton.tsx`): if its prop names differ from `busy`/`onClick` (e.g. it takes a label or `loading`), adapt the call to its real signature.

- [ ] **Step 5: CSS** — `web/app/(cabinet)/journal/page.module.css`: copy Task 2's stylesheet verbatim, then append:

```css
.entries { display: flex; flex-direction: column; gap: var(--space-4); }
.entry { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden; }
.entryHead { display: flex; align-items: baseline; gap: var(--space-3); padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.entryDate { color: var(--ink-soft); font-size: 0.875rem; white-space: nowrap; }
.entryMemo { color: var(--ink); font-weight: 500; }
.reversal { margin-left: auto; color: var(--attention); font-size: 0.8125rem; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0 var(--space-2); }
.entry .tableWrapper { border: none; border-radius: 0; }
.colAmount { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.accountName { color: var(--ink-soft); }
```

- [ ] **Step 6: Typecheck + commit**

Run: `cd /Users/karlis/git/book-keeping/web && npx tsc --noEmit` → no errors.

```bash
git add web/app/api/journal web/app/\(cabinet\)/journal web/app/components/Sidebar.tsx web/app/components/NavIcon.tsx web/app/lib/i18n.ts
git commit -m "feat(web): journal browser page + API"
```

---

### Task 12: Settings page — periods + autonomy (admin-gated) + APIs

**Files:**
- Create: `web/app/api/periods/route.ts`, `web/app/api/autonomy/route.ts`
- Create: `web/app/(cabinet)/settings/page.tsx`, `web/app/(cabinet)/settings/page.module.css`
- Modify: `web/app/components/Sidebar.tsx` (settings item, gated like admin), `web/app/components/NavIcon.tsx` (`settings` icon), `web/app/lib/i18n.ts`

**Interfaces:**
- Consumes: `listPeriods`, `openPeriod`, `closePeriod` from `@domain/ledger/periods.js`; `listAutonomyPolicies`, `setAutonomy`, `AutonomyMode` from `@domain/autonomy/autonomy.js` (Task 10).
- Produces: `GET /api/periods?clientCompanyId` → `{ periods }`; `POST /api/periods` body `{ clientCompanyId, year, month, action: 'open'|'close' }` → `{ ok: true }`; `GET /api/autonomy?clientCompanyId` → `{ policies }` (thresholds as cent strings); `POST /api/autonomy` body `{ clientCompanyId, operationType, mode, materialThresholdCents?: string }` → `{ ok: true }`. Page at `/settings?client=<uuid>`.

- [ ] **Step 1: `web/app/api/periods/route.ts`**

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { listPeriods, openPeriod, closePeriod } from '@domain/ledger/periods.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });

  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const periods = await withTenant(ctx, (tx) => listPeriods(tx, ctx));
    return NextResponse.json({ periods }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: /session/i.test(msg) ? 401 : 403 });
  }
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    clientCompanyId?: string; year?: number; month?: number; action?: 'open' | 'close';
  };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const year = Number(body.year);
  const month = Number(body.month);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return NextResponse.json({ error: 'invalid year/month' }, { status: 400 });
  }
  if (body.action !== 'open' && body.action !== 'close') {
    return NextResponse.json({ error: 'invalid action' }, { status: 400 });
  }

  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    await withTenant(ctx, (tx) =>
      body.action === 'open' ? openPeriod(tx, ctx, { year, month }) : closePeriod(tx, ctx, { year, month }),
    );
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: /session/i.test(msg) ? 401 : 403 });
  }
}
```

- [ ] **Step 2: `web/app/api/autonomy/route.ts`**

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { listAutonomyPolicies, setAutonomy } from '@domain/autonomy/autonomy.js';
import type { AutonomyMode } from '@domain/autonomy/autonomy.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });

  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const policies = await withTenant(ctx, (tx) => listAutonomyPolicies(tx, ctx));
    return NextResponse.json({ policies }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: /session/i.test(msg) ? 401 : 403 });
  }
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    clientCompanyId?: string; operationType?: string; mode?: AutonomyMode; materialThresholdCents?: string;
  };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.operationType?.trim()) return NextResponse.json({ error: 'missing operationType' }, { status: 400 });
  if (body.mode !== 'auto' && body.mode !== 'approval') {
    return NextResponse.json({ error: 'invalid mode' }, { status: 400 });
  }
  let threshold: bigint | undefined;
  if (body.materialThresholdCents !== undefined) {
    try {
      threshold = BigInt(body.materialThresholdCents);
      if (threshold < 0n) throw new Error('negative');
    } catch {
      return NextResponse.json({ error: 'invalid materialThresholdCents' }, { status: 400 });
    }
  }

  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    await withTenant(ctx, (tx) =>
      setAutonomy(tx, ctx, {
        operationType: body.operationType!.trim(),
        mode: body.mode!,
        ...(threshold !== undefined && { materialThresholdCents: threshold }),
      }),
    );
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: /session/i.test(msg) ? 401 : 403 });
  }
}
```

- [ ] **Step 3: i18n keys** (EN; add LV + RU following Task 2's pattern):

```typescript
'nav.settings': 'Settings',
'nav.short.settings': 'Settings',
'settings.title': 'Settings',
'settings.periods': 'Accounting periods',
'settings.periodsHint': 'Postings are only accepted into open periods. Closing a period locks it.',
'settings.period': 'Period',
'settings.periodStatus': 'Status',
'settings.period.open': 'Open',
'settings.period.closed': 'Closed',
'settings.openPeriod': 'Open period',
'settings.closePeriod': 'Close',
'settings.reopenPeriod': 'Reopen',
'settings.year': 'Year',
'settings.month': 'Month',
'settings.periodsEmpty': 'No periods yet — open the current month to start posting.',
'settings.autonomy': 'Agent autonomy',
'settings.autonomyHint': 'Choose which operations the agent may execute on its own. Amounts at or above the threshold always go to the approval queue; declarations always require approval.',
'settings.operation': 'Operation',
'settings.mode': 'Mode',
'settings.mode.auto': 'Automatic below threshold',
'settings.mode.approval': 'Always ask',
'settings.threshold': 'Threshold',
'settings.autonomyEmpty': 'No autonomy policies configured — the agent asks for approval on everything.',
'settings.addPolicy': 'Add policy',
'settings.op.posting': 'Document postings',
'settings.op.bank_match': 'Bank matches',
'settings.op.declaration': 'Declarations',
'settings.saved': 'Saved',
```

LV: `'nav.settings': 'Iestatījumi', 'nav.short.settings': 'Iestatījumi', 'settings.title': 'Iestatījumi', 'settings.periods': 'Grāmatvedības periodi', 'settings.periodsHint': 'Grāmatojumi tiek pieņemti tikai atvērtos periodos. Perioda slēgšana to noslēdz.', 'settings.period': 'Periods', 'settings.periodStatus': 'Statuss', 'settings.period.open': 'Atvērts', 'settings.period.closed': 'Slēgts', 'settings.openPeriod': 'Atvērt periodu', 'settings.closePeriod': 'Slēgt', 'settings.reopenPeriod': 'Atvērt atkārtoti', 'settings.year': 'Gads', 'settings.month': 'Mēnesis', 'settings.periodsEmpty': 'Vēl nav periodu — atveriet tekošo mēnesi, lai sāktu grāmatot.', 'settings.autonomy': 'Aģenta patstāvība', 'settings.autonomyHint': 'Izvēlieties, kuras darbības aģents drīkst veikt patstāvīgi. Summas, kas sasniedz slieksni, vienmēr nonāk apstiprināšanas rindā; deklarācijām apstiprinājums vajadzīgs vienmēr.', 'settings.operation': 'Darbība', 'settings.mode': 'Režīms', 'settings.mode.auto': 'Automātiski zem sliekšņa', 'settings.mode.approval': 'Vienmēr jautāt', 'settings.threshold': 'Slieksnis', 'settings.autonomyEmpty': 'Nav konfigurētu patstāvības noteikumu — aģents visam prasa apstiprinājumu.', 'settings.addPolicy': 'Pievienot noteikumu', 'settings.op.posting': 'Dokumentu grāmatojumi', 'settings.op.bank_match': 'Bankas saistīšana', 'settings.op.declaration': 'Deklarācijas', 'settings.saved': 'Saglabāts'`

RU: `'nav.settings': 'Настройки', 'nav.short.settings': 'Настройки', 'settings.title': 'Настройки', 'settings.periods': 'Отчётные периоды', 'settings.periodsHint': 'Проводки принимаются только в открытые периоды. Закрытие периода блокирует его.', 'settings.period': 'Период', 'settings.periodStatus': 'Статус', 'settings.period.open': 'Открыт', 'settings.period.closed': 'Закрыт', 'settings.openPeriod': 'Открыть период', 'settings.closePeriod': 'Закрыть', 'settings.reopenPeriod': 'Открыть снова', 'settings.year': 'Год', 'settings.month': 'Месяц', 'settings.periodsEmpty': 'Периодов пока нет — откройте текущий месяц, чтобы начать проводки.', 'settings.autonomy': 'Автономность агента', 'settings.autonomyHint': 'Выберите, какие операции агент может выполнять самостоятельно. Суммы от порога и выше всегда идут в очередь согласования; декларации всегда требуют одобрения.', 'settings.operation': 'Операция', 'settings.mode': 'Режим', 'settings.mode.auto': 'Автоматически ниже порога', 'settings.mode.approval': 'Всегда спрашивать', 'settings.threshold': 'Порог', 'settings.autonomyEmpty': 'Правила автономности не настроены — агент запрашивает одобрение на всё.', 'settings.addPolicy': 'Добавить правило', 'settings.op.posting': 'Проводки документов', 'settings.op.bank_match': 'Сопоставление банка', 'settings.op.declaration': 'Декларации', 'settings.saved': 'Сохранено'`

- [ ] **Step 4: NavIcon `settings`** + Sidebar gated item. Icon (sliders — distinct from admin's gear):

```tsx
// Sliders / settings
settings: (
  <>
    <path d="M3.5 6h13M3.5 10h13M3.5 14h13" strokeLinecap="round" />
    <circle cx="8" cy="6" r="1.75" fill="var(--surface, #fff)" />
    <circle cx="12.5" cy="10" r="1.75" fill="var(--surface, #fff)" />
    <circle cx="6.5" cy="14" r="1.75" fill="var(--surface, #fff)" />
  </>
),
```

(If the `fill` hack clashes with the icon container background, drop the `fill` attribute — stroked circles over the lines are acceptable.)

In `Sidebar.tsx`, add settings next to the admin item using the same `ADMIN_ROLES` gate. If the current code appends a single `ADMIN_ITEM`, change to an `ADMIN_ITEMS` array:

```typescript
const ADMIN_ITEMS: NavItem[] = [
  { key: 'nav.settings', shortKey: 'nav.short.settings', href: '/settings', icon: 'settings' },
  ADMIN_ITEM, // the existing admin entry
];
const items = ADMIN_ROLES.has(role) ? [...BASE_ITEMS, ...ADMIN_ITEMS] : BASE_ITEMS;
```

(Adapt to the file's actual structure; keep the admin entry last.)

- [ ] **Step 5: Page** — `web/app/(cabinet)/settings/page.tsx`:

```tsx
'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import type { MsgKey } from '@/app/lib/i18n';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { formatCents } from '@/app/lib/format';
import styles from './page.module.css';

interface PeriodRow { year: number; month: number; status: 'open' | 'closed'; }
interface PolicyRow { operationType: string; mode: 'auto' | 'approval'; materialThresholdCents: string; }

const KNOWN_OPS = ['posting', 'bank_match', 'declaration'] as const;

function SettingsInner() {
  const searchParams = useSearchParams();
  const { t } = useMessages();
  const clientCompanyId = searchParams.get('client');

  const [periods, setPeriods] = useState<PeriodRow[] | null>(null);
  const [policies, setPolicies] = useState<PolicyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [newYear, setNewYear] = useState(() => String(new Date().getFullYear()));
  const [newMonth, setNewMonth] = useState(() => String(new Date().getMonth() + 1));
  const [newOp, setNewOp] = useState('posting');
  const [newMode, setNewMode] = useState<'auto' | 'approval'>('approval');
  const [newThresholdEur, setNewThresholdEur] = useState('1000');

  const load = useCallback(async (id: string) => {
    setError(null);
    try {
      const [pRes, aRes] = await Promise.all([
        fetch(`/api/periods?clientCompanyId=${encodeURIComponent(id)}`, { cache: 'no-store' }),
        fetch(`/api/autonomy?clientCompanyId=${encodeURIComponent(id)}`, { cache: 'no-store' }),
      ]);
      if (!pRes.ok) throw new Error(((await pRes.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${pRes.status}`);
      if (!aRes.ok) throw new Error(((await aRes.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${aRes.status}`);
      setPeriods(((await pRes.json()) as { periods: PeriodRow[] }).periods);
      setPolicies(((await aRes.json()) as { policies: PolicyRow[] }).policies);
    } catch (err) {
      setError((err as Error).message ?? t('state.error'));
    }
  }, [t]);

  useEffect(() => {
    if (clientCompanyId) load(clientCompanyId);
  }, [clientCompanyId, load]);

  async function post(url: string, body: Record<string, unknown>) {
    if (!clientCompanyId) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientCompanyId, ...body }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      await load(clientCompanyId);
    } catch (err) {
      setActionError((err as Error).message ?? t('state.error'));
    } finally {
      setBusy(false);
    }
  }

  const opLabel = (op: string) => {
    const key = `settings.op.${op}` as MsgKey;
    const label = t(key);
    return label === key ? op : label;
  };

  if (error) {
    return (
      <div className={styles.page}><main className={styles.main}>
        <ErrorState message={error} onRetry={() => clientCompanyId && load(clientCompanyId)} />
      </main></div>
    );
  }
  if (!periods || !policies) {
    return (
      <div className={styles.page}><main className={styles.main}>
        <div className={styles.skeletons}><SkeletonCard /><SkeletonCard /></div>
      </main></div>
    );
  }

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <h1 className={styles.pageHeading}>{t('settings.title')}</h1>
        {actionError && <p className={styles.formError} role="alert">{actionError}</p>}

        <section className={styles.card} aria-labelledby="periods-heading">
          <h2 id="periods-heading" className={styles.sectionHeading}>{t('settings.periods')}</h2>
          <p className={styles.hint}>{t('settings.periodsHint')}</p>
          {periods.length === 0 && <p className={styles.hint}>{t('settings.periodsEmpty')}</p>}
          {periods.length > 0 && (
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">{t('settings.period')}</th>
                    <th scope="col">{t('settings.periodStatus')}</th>
                    <th scope="col"><span className="sr-only">{t('settings.closePeriod')}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {periods.map((p) => (
                    <tr key={`${p.year}-${p.month}`}>
                      <td className={styles.mono}>{p.year}-{String(p.month).padStart(2, '0')}</td>
                      <td>{p.status === 'open' ? t('settings.period.open') : t('settings.period.closed')}</td>
                      <td className={styles.actionsCell}>
                        <button
                          type="button"
                          className={styles.ghostBtn}
                          disabled={busy}
                          onClick={() => post('/api/periods', { year: p.year, month: p.month, action: p.status === 'open' ? 'close' : 'open' })}
                        >
                          {p.status === 'open' ? t('settings.closePeriod') : t('settings.reopenPeriod')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <form
            className={styles.inlineForm}
            onSubmit={(e) => { e.preventDefault(); post('/api/periods', { year: Number(newYear), month: Number(newMonth), action: 'open' }); }}
          >
            <label className={styles.field}>
              <span>{t('settings.year')}</span>
              <input inputMode="numeric" value={newYear} onChange={(e) => setNewYear(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span>{t('settings.month')}</span>
              <input inputMode="numeric" value={newMonth} onChange={(e) => setNewMonth(e.target.value)} />
            </label>
            <button type="submit" className={styles.primaryBtn} disabled={busy}>{t('settings.openPeriod')}</button>
          </form>
        </section>

        <section className={styles.card} aria-labelledby="autonomy-heading">
          <h2 id="autonomy-heading" className={styles.sectionHeading}>{t('settings.autonomy')}</h2>
          <p className={styles.hint}>{t('settings.autonomyHint')}</p>
          {policies.length === 0 && <p className={styles.hint}>{t('settings.autonomyEmpty')}</p>}
          {policies.length > 0 && (
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">{t('settings.operation')}</th>
                    <th scope="col">{t('settings.mode')}</th>
                    <th scope="col" className={styles.colAmount}>{t('settings.threshold')}</th>
                    <th scope="col"><span className="sr-only">{t('settings.mode')}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {policies.map((p) => (
                    <tr key={p.operationType}>
                      <td>{opLabel(p.operationType)}</td>
                      <td>{p.mode === 'auto' ? t('settings.mode.auto') : t('settings.mode.approval')}</td>
                      <td className={styles.colAmount}>{formatCents(p.materialThresholdCents) ?? '—'}</td>
                      <td className={styles.actionsCell}>
                        <button
                          type="button"
                          className={styles.ghostBtn}
                          disabled={busy}
                          onClick={() => post('/api/autonomy', {
                            operationType: p.operationType,
                            mode: p.mode === 'auto' ? 'approval' : 'auto',
                            materialThresholdCents: p.materialThresholdCents,
                          })}
                        >
                          {p.mode === 'auto' ? t('settings.mode.approval') : t('settings.mode.auto')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <form
            className={styles.inlineForm}
            onSubmit={(e) => {
              e.preventDefault();
              const eur = Number(newThresholdEur);
              post('/api/autonomy', {
                operationType: newOp,
                mode: newMode,
                ...(Number.isFinite(eur) && eur >= 0 && { materialThresholdCents: String(Math.round(eur * 100)) }),
              });
            }}
          >
            <label className={styles.field}>
              <span>{t('settings.operation')}</span>
              <select value={newOp} onChange={(e) => setNewOp(e.target.value)}>
                {KNOWN_OPS.map((op) => <option key={op} value={op}>{opLabel(op)}</option>)}
              </select>
            </label>
            <label className={styles.field}>
              <span>{t('settings.mode')}</span>
              <select value={newMode} onChange={(e) => setNewMode(e.target.value as 'auto' | 'approval')}>
                <option value="approval">{t('settings.mode.approval')}</option>
                <option value="auto">{t('settings.mode.auto')}</option>
              </select>
            </label>
            <label className={styles.field}>
              <span>{t('settings.threshold')} (EUR)</span>
              <input inputMode="decimal" value={newThresholdEur} onChange={(e) => setNewThresholdEur(e.target.value)} />
            </label>
            <button type="submit" className={styles.primaryBtn} disabled={busy}>{t('settings.addPolicy')}</button>
          </form>
        </section>
      </main>
    </div>
  );
}

function SettingsSkeleton() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.skeletons}><SkeletonCard /><SkeletonCard /></div>
      </main>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<SettingsSkeleton />}>
      <SettingsInner />
    </Suspense>
  );
}
```

- [ ] **Step 6: CSS** — `web/app/(cabinet)/settings/page.module.css`: copy Task 2's stylesheet verbatim, then append:

```css
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); padding: var(--space-5); display: flex; flex-direction: column; gap: var(--space-4); }
.sectionHeading { font-size: 1rem; font-weight: 600; color: var(--ink); margin: 0; }
.hint { color: var(--ink-soft); font-size: 0.875rem; margin: 0; }
.inlineForm { display: flex; gap: var(--space-3); align-items: end; flex-wrap: wrap; }
.colAmount { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
```

- [ ] **Step 7: Typecheck + commit**

Run: `cd /Users/karlis/git/book-keeping/web && npx tsc --noEmit` → no errors.

```bash
git add web/app/api/periods web/app/api/autonomy web/app/\(cabinet\)/settings web/app/components/Sidebar.tsx web/app/components/NavIcon.tsx web/app/lib/i18n.ts
git commit -m "feat(web): settings page — accounting periods + agent autonomy policies"
```

---

### Task 13: VID deadline strip — domain fn + API + overview integration

**Files:**
- Modify: `src/einvoice/vid.ts` (append `upcomingVidDeadlines`)
- Test: `tests/einvoice/vid-deadlines.test.ts`
- Create: `web/app/api/vid/deadlines/route.ts`
- Modify: `web/app/(cabinet)/overview/page.tsx` (deadline strip section), `web/app/lib/i18n.ts`

**Interfaces:**
- Consumes: `einvoices` table; existing `addWorkingDays(date, n)` in the same file; overview page structure from Task-context (sections with `styles.section`).
- Produces: `upcomingVidDeadlines(tx, ctx, asOf: string): Promise<{ einvoiceId, invoiceNumber, dueDate, overdue }[]>`; `GET /api/vid/deadlines?clientCompanyId&asOf?` → `{ deadlines }`.

- [ ] **Step 1: Failing test** — `tests/einvoice/vid-deadlines.test.ts`:

```typescript
import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { sendInvoice } from '../../src/einvoice/outbound.js';
import { upcomingVidDeadlines, addWorkingDays } from '../../src/einvoice/vid.js';
import type { EInvoice } from '../../src/einvoice/ubl.js';

function inv(number: string, issueDate: string): EInvoice {
  return {
    invoiceNumber: number, issueDate, currency: 'EUR',
    supplier: { name: 'SIA Pārdevējs', regNo: '40100000000', vatNo: 'LV40100000000' },
    customer: { name: 'SIA Klients', regNo: '40200000000', vatNo: 'LV40200000000' },
    lines: [{ description: 'Prece', net: '100.00', vatRate: 21, vat: '21.00' }],
    netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
  };
}

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('reports pending outbound invoices with due date and overdue flag', async () => {
  const t = await makeFirmAndClient();
  const ap = new StubAccessPoint();
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Debtors', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, ctx(t), { code: '5721', name: 'Output VAT', type: 'liability' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    await sendInvoice(tx, ctx(t), { invoice: inv('INV-1', '2026-03-02'), recipientPeppolId: '0088:1', ap, receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721' });
    await sendInvoice(tx, ctx(t), { invoice: inv('INV-2', '2026-03-30'), recipientPeppolId: '0088:1', ap, receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721' });
  });
  // asOf 2026-03-31: INV-1 (issued 02.03, due 09.03) overdue; INV-2 (issued 30.03) not yet.
  const deadlines = await withTenant(ctx(t), (tx) => upcomingVidDeadlines(tx, ctx(t), '2026-03-31'));
  expect(deadlines).toHaveLength(2);
  const first = deadlines.find((d) => d.invoiceNumber === 'INV-1')!;
  expect(first.dueDate).toBe(addWorkingDays('2026-03-02', 5));
  expect(first.overdue).toBe(true);
  const second = deadlines.find((d) => d.invoiceNumber === 'INV-2')!;
  expect(second.overdue).toBe(false);
});
```

- [ ] **Step 2: Run to verify FAIL** — `npx vitest run tests/einvoice/vid-deadlines.test.ts` → `upcomingVidDeadlines` not exported.

- [ ] **Step 3: Implement** — append to `src/einvoice/vid.ts`:

```typescript
export interface VidDeadline {
  einvoiceId: string;
  invoiceNumber: string;
  dueDate: string;
  overdue: boolean;
}

/** Outbound invoices still awaiting VID submission, with their 5-working-day
 *  due date (stored one if present, else computed from issue date). */
export async function upcomingVidDeadlines(
  tx: PoolClient,
  ctx: TenantContext,
  asOf: string,
): Promise<VidDeadline[]> {
  const res = await tx.query(
    `SELECT id, invoice_number,
            to_char(issue_date, 'YYYY-MM-DD') AS issue_date,
            to_char(vid_due_date, 'YYYY-MM-DD') AS vid_due_date
       FROM einvoices
      WHERE client_company_id = $1 AND direction = 'outbound' AND vid_status = 'pending'
      ORDER BY issue_date ASC`,
    [ctx.clientCompanyId],
  );
  return res.rows.map((r) => {
    const dueDate: string = r.vid_due_date ?? addWorkingDays(r.issue_date, 5);
    return { einvoiceId: r.id, invoiceNumber: r.invoice_number, dueDate, overdue: dueDate < asOf };
  });
}
```

- [ ] **Step 4: Run to verify PASS**, then full `npm test` → all pass. Commit domain half:

```bash
git add src/einvoice/vid.ts tests/einvoice/vid-deadlines.test.ts
git commit -m "feat: upcomingVidDeadlines for the deadline strip"
```

- [ ] **Step 5: Route** — `web/app/api/vid/deadlines/route.ts`:

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { upcomingVidDeadlines } from '@domain/einvoice/vid.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const asOf = req.nextUrl.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10);

  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const deadlines = await withTenant(ctx, (tx) => upcomingVidDeadlines(tx, ctx, asOf));
    return NextResponse.json({ deadlines }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: /session/i.test(msg) ? 401 : 403 });
  }
}
```

- [ ] **Step 6: i18n keys** (EN; add LV + RU):

```typescript
'vid.strip': 'VID submissions',
'vid.stripHint': 'Invoice data goes to VID within 5 working days of issue. Nothing here needs urgent action unless marked overdue.',
'vid.due': 'due {date}',
'vid.overdue': 'was due {date}',
'vid.allClear': 'Nothing awaiting VID submission.',
```

LV: `'vid.strip': 'VID iesniegšana', 'vid.stripHint': 'Rēķinu dati VID jānodod 5 darbdienu laikā no izrakstīšanas. Nekas šeit neprasa steidzamu rīcību, ja vien nav atzīmēts kā nokavēts.', 'vid.due': 'termiņš {date}', 'vid.overdue': 'termiņš bija {date}', 'vid.allClear': 'Nekas negaida iesniegšanu VID.'`

RU: `'vid.strip': 'Подача в VID', 'vid.stripHint': 'Данные счетов передаются в VID в течение 5 рабочих дней с выставления. Срочных действий не требуется, если нет пометки о просрочке.', 'vid.due': 'срок {date}', 'vid.overdue': 'срок был {date}', 'vid.allClear': 'Ничего не ожидает подачи в VID.'`

- [ ] **Step 7: Overview integration** — in `web/app/(cabinet)/overview/page.tsx`:

1. Add to the data interfaces: `interface VidDeadline { einvoiceId: string; invoiceNumber: string; dueDate: string; overdue: boolean; }` and a `deadlines` state: `const [deadlines, setDeadlines] = useState<VidDeadline[] | null>(null);`
2. In the existing `load` callback, after the overview fetch succeeds, fetch deadlines best-effort (a failure must NOT break the overview):

```typescript
try {
  const dRes = await fetch(`/api/vid/deadlines?clientCompanyId=${encodeURIComponent(id)}`, { cache: 'no-store' });
  if (dRes.ok) setDeadlines(((await dRes.json()) as { deadlines: VidDeadline[] }).deadlines);
} catch { /* strip is optional; ignore */ }
```

3. Render the strip as the FIRST section inside the existing data branch (before the VAT section), calm styling per DESIGN.md principle 3 — plain language, no red-alert; overdue gets the `--attention` token and an icon+label, not a red banner:

```tsx
<section className={styles.section} aria-labelledby="vid-strip-heading">
  <h2 id="vid-strip-heading" className={styles.sectionHeading}>{t('vid.strip')}</h2>
  <p className={styles.stripHint}>{t('vid.stripHint')}</p>
  {(!deadlines || deadlines.length === 0) ? (
    <p className={styles.stripAllClear}>{t('vid.allClear')}</p>
  ) : (
    <ul className={styles.strip}>
      {deadlines.map((d) => (
        <li key={d.einvoiceId} className={d.overdue ? styles.stripItemOverdue : styles.stripItem}>
          <span className={styles.stripInvoice}>{d.invoiceNumber}</span>
          <span className={styles.stripDue}>
            {(d.overdue ? t('vid.overdue') : t('vid.due')).replace(
              '{date}',
              new Intl.DateTimeFormat(LOCALE_FOR[lang], { day: 'numeric', month: 'short' }).format(new Date(d.dueDate)),
            )}
          </span>
        </li>
      ))}
    </ul>
  )}
</section>
```

(The page already imports `LOCALE_FOR`? If not, add it; it already destructures `{ t }` from `useMessages()` — extend to `{ t, lang }`.)

4. Append to `web/app/(cabinet)/overview/page.module.css`:

```css
.stripHint { color: var(--ink-soft); font-size: 0.875rem; margin: 0 0 var(--space-3); }
.stripAllClear { color: var(--ink-soft); margin: 0; }
.strip { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--space-3); }
.stripItem, .stripItemOverdue { display: flex; flex-direction: column; gap: 2px; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: var(--space-2) var(--space-3); background: var(--surface); }
.stripItemOverdue { border-color: var(--attention); }
.stripInvoice { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.875rem; color: var(--ink); }
.stripDue { font-size: 0.8125rem; color: var(--ink-soft); }
.stripItemOverdue .stripDue { color: var(--attention); }
```

- [ ] **Step 8: Typecheck + commit**

Run: `cd /Users/karlis/git/book-keeping/web && npx tsc --noEmit` → no errors.

```bash
git add web/app/api/vid web/app/\(cabinet\)/overview web/app/lib/i18n.ts
git commit -m "feat(web): calm VID deadline strip on overview"
```

---

### Task 14: Full verification + smoke test + handoff update

**Files:**
- Modify: `HANDOFF.md`

- [ ] **Step 1: Full test suite** — `cd /Users/karlis/git/book-keeping && docker compose up -d && npm test` → all tests pass (146 pre-existing + ~8 new).

- [ ] **Step 2: Typecheck both packages** — `npx tsc --noEmit` (root) and `cd web && npx tsc --noEmit` → no errors.

- [ ] **Step 3: Production build** — `cd web && npm run build` → build succeeds, all new routes/pages listed.

- [ ] **Step 4: Browser smoke test.** Follow `docs/RUNNING.md` to start the dev server and seed data (dev bootstrap route exists at `/api/dev/bootstrap`). With Playwright or manually, walk: log in → open `/parties`, create a customer → `/invoices/new`, compose a 1-line invoice, Issue → `/invoices` shows it with Peppol `Sent` + VID `Awaiting submission` → `/overview` shows the invoice in the VID strip → `/journal` shows the posted receivable entry → `/bank` imports `tests`' sample camt fixture if one exists (else skip import, verify empty state) → `/settings` opens a period and adds an autonomy policy. Capture screenshots of each screen in all three languages for at least the invoices screen (LV default, switch to RU, EN).

- [ ] **Step 5: Update `HANDOFF.md`** — in section 3, note the composer/outbox shipped (credit notes still open); in section 4, mark bank upload + payment orders + journal + periods + parties + autonomy + VID view as shipped (with page paths); leave admin tariffs/templates, 2FA enrolment, and the blocked #1/#2 items as-is.

- [ ] **Step 6: Final commit + push**

```bash
git add HANDOFF.md docs/superpowers/plans/2026-07-03-mvp-ui-over-tested-api.md
git commit -m "docs: mark shipped MVP-UI items in handoff; add plan"
git push origin main
```



