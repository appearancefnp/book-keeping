# AR money-in UI — receivable status + settle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface each outbound invoice's payment status, due date, and outstanding balance on `/invoices`, and let a user record a payment (settle) or void it from a drawer, wired to the existing `POST /api/receivables/[id]`.

**Architecture:** Approach A from the spec — extend the existing `listEinvoices` query with the AR columns already on `einvoices` (no new route, single existing fetch). The `/invoices` page renders three new columns plus a Settle action; a state-driven `role="dialog"` drawer (mirroring `payroll/runs/[id]`) POSTs to the already-shipped settle/void route and re-fetches on success. Backend guards (over-payment, void/paid rejection, bank-txn dedup) are authoritative; the UI only surfaces their error messages.

**Tech Stack:** TypeScript, Node/`pg` domain layer, Vitest (domain tests), Next.js (modified — see Global Constraints), React client components, CSS modules, typed i18n record.

## Global Constraints

- **No new migration, no new domain logic.** This slice is additive over shipped M4-A backend.
- **i18n in all three catalogs** (en, lv, ru) in `web/app/lib/i18n.ts` — the record is typed, so a missing key fails the `web` build. Every user-facing string added here goes in all three.
- **`ReceivableStatus`** union (`'open' | 'partially_paid' | 'paid' | 'void'`) is imported from `src/receivables/receivables.ts` — do not redefine it.
- **Modified Next.js:** per `web/AGENTS.md`, before editing any file under `web/`, read the relevant guide under `web/node_modules/next/dist/docs/`. APIs may differ from training data.
- **Money is integer cents as strings**; format for display with `formatCents` from `web/app/lib/format`.
- **No React test harness exists** — client-component tasks (2–4) verify via `tsc --noEmit` + `npm run build` in `web/` + a manual check. Only the domain query task (1) has an automated test.
- **Gate for the whole slice:** `npm test` (root) green; `tsc --noEmit` clean in root **and** `web/`; `npm run build` in `web/` clean.

---

### Task 1: Extend `listEinvoices` with AR columns

**Files:**
- Modify: `src/einvoice/query.ts` (the `EinvoiceRow` interface, lines ~4-16; the `listEinvoices` SELECT, lines ~32-42; the row mapping, lines ~44-57)
- Test: `tests/einvoice/query.test.ts` (extend the existing `'lists outbound einvoices with statuses'` test, lines ~36-49)

**Interfaces:**
- Consumes: nothing new (reads columns `status`, `due_date`, `amount_paid_cents`, `grand_total_cents` already on `einvoices` from migration 032).
- Produces: `EinvoiceRow` gains `status: ReceivableStatus | null`, `dueDate: string | null`, `amountPaidCents: string | null`, `outstandingCents: string | null`. Consumed by the `/invoices` page in Task 3.

- [ ] **Step 1: Extend the existing outbound test to assert the four new fields**

In `tests/einvoice/query.test.ts`, add these assertions to the end of the `'lists outbound einvoices with statuses'` test (after the existing `expect(row.direction).toBe('outbound');`). The `issueOne` helper issues via `sendInvoice` with no `customerPartyId`/`dueDate`, so the outbound row is born `status='open'` with a null due date and zero paid:

```ts
  expect(row.status).toBe('open');
  expect(row.amountPaidCents).toBe('0');
  expect(row.outstandingCents).toBe('12100');
  expect(row.dueDate).toBeNull();
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/einvoice/query.test.ts -t "lists outbound einvoices with statuses"`
Expected: FAIL — `row.status` etc. are `undefined` (property does not exist on the returned object / type error at build), assertion `expected undefined to be 'open'`.

- [ ] **Step 3: Add the four fields to the `EinvoiceRow` interface**

In `src/einvoice/query.ts`, add the import and extend the interface:

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import type { ReceivableStatus } from '../receivables/receivables.js';

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
  status: ReceivableStatus | null;
  dueDate: string | null;
  amountPaidCents: string | null;
  outstandingCents: string | null;
}
```

- [ ] **Step 4: Add the columns to the SELECT and the row mapping**

In `listEinvoices`, add the four columns to the SELECT (after `vid_due_date`):

```ts
  const res = await tx.query(
    `SELECT id, direction, invoice_number,
            to_char(issue_date, 'YYYY-MM-DD') AS issue_date,
            grand_total_cents::text AS grand_total_cents,
            currency, peppol_status, peppol_message_id,
            vid_status, to_char(vid_due_date, 'YYYY-MM-DD') AS vid_due_date,
            journal_entry_id, created_at::text AS created_at,
            status,
            to_char(due_date, 'YYYY-MM-DD') AS due_date,
            amount_paid_cents::text AS amount_paid_cents,
            (grand_total_cents - amount_paid_cents)::text AS outstanding_cents
       FROM einvoices
      WHERE ${where}
      ORDER BY issue_date DESC, created_at DESC
      LIMIT $${params.length}`,
    params,
  );
```

And add the four fields to the `.map(...)` return object (after `createdAt: r.created_at,`):

```ts
    createdAt: r.created_at,
    status: r.status,
    dueDate: r.due_date,
    amountPaidCents: r.amount_paid_cents,
    outstandingCents: r.outstanding_cents,
```

> Note: `amount_paid_cents` defaults to 0 on outbound rows (migration 032), so `outstanding_cents` is concrete for outbound and `status` is `'open'` at issue. Inbound rows leave `status` null; the nullable types cover them.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/einvoice/query.test.ts`
Expected: PASS (all tests in the file, including the extended one).

- [ ] **Step 6: Typecheck root**

Run: `npx tsc --noEmit`
Expected: clean (no output).

- [ ] **Step 7: Commit**

```bash
git add src/einvoice/query.ts tests/einvoice/query.test.ts
git commit -m "feat(receivables): expose AR status/due/outstanding on listEinvoices"
```

---

### Task 2: `PaymentStatusBadge` component + status-label i18n

**Files:**
- Create: `web/app/components/PaymentStatusBadge.tsx`
- Create: `web/app/components/PaymentStatusBadge.module.css`
- Modify: `web/app/lib/i18n.ts` (add keys to all three catalogs, near the existing `einv.status.*` keys)

**Interfaces:**
- Consumes: `ReceivableStatus` (imported from the domain), `useMessages`/`MsgKey` from `web/app/lib`.
- Produces: `export function PaymentStatusBadge({ status }: { status: ReceivableStatus })` — a pill. Consumed by the `/invoices` page in Task 3.

- [ ] **Step 1: Read the Next.js component guidance**

Run: `ls web/node_modules/next/dist/docs/` and read the guide relevant to client components before writing the file.

- [ ] **Step 2: Add the payment-status i18n keys to all three catalogs**

In `web/app/lib/i18n.ts`, add these keys inside each of the three language objects (place them next to the existing `einv.status.*` block). English:

```ts
  'pay.status.open': 'Open',
  'pay.status.partially_paid': 'Partially paid',
  'pay.status.paid': 'Paid',
  'pay.status.void': 'Void',
```

Latvian:

```ts
  'pay.status.open': 'Atvērts',
  'pay.status.partially_paid': 'Daļēji apmaksāts',
  'pay.status.paid': 'Apmaksāts',
  'pay.status.void': 'Anulēts',
```

Russian:

```ts
  'pay.status.open': 'Открыт',
  'pay.status.partially_paid': 'Частично оплачен',
  'pay.status.paid': 'Оплачен',
  'pay.status.void': 'Аннулирован',
```

- [ ] **Step 3: Write the component**

`web/app/components/PaymentStatusBadge.tsx`:

```tsx
'use client';

import type { ReceivableStatus } from '@domain/receivables/receivables.js';
import { useMessages } from '../lib/i18n-context';
import type { MsgKey } from '../lib/i18n';
import styles from './PaymentStatusBadge.module.css';

const CLASS_FOR: Record<ReceivableStatus, string> = {
  open: styles.open,
  partially_paid: styles.partial,
  paid: styles.paid,
  void: styles.void,
};

export function PaymentStatusBadge({ status }: { status: ReceivableStatus }) {
  const { t } = useMessages();
  return (
    <span className={`${styles.badge} ${CLASS_FOR[status]}`}>
      {t(`pay.status.${status}` as MsgKey)}
    </span>
  );
}
```

> Confirm the `@domain/...` import alias resolves in `web/` (the settle route at `web/app/api/receivables/[id]/route.ts` imports `@domain/receivables/...`, so it does). Confirm `useMessages` lives at `web/app/lib/i18n-context` (as in `StatusBadge.tsx`).

- [ ] **Step 4: Write the styles**

`web/app/components/PaymentStatusBadge.module.css` — mirror the pill shape of `StatusBadge.module.css`, with a distinct tint per status (open = neutral, partially_paid = amber, paid = green, void = muted/strikethrough). Keep it consistent with the app's existing badge styling:

```css
.badge {
  display: inline-flex;
  align-items: center;
  padding: 0.125rem 0.5rem;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
  white-space: nowrap;
}
.open { background: var(--surface-muted, #eef1f4); color: var(--text-muted, #52606d); }
.partial { background: #fef3c7; color: #92400e; }
.paid { background: #dcfce7; color: #166534; }
.void { background: var(--surface-muted, #eef1f4); color: var(--text-muted, #52606d); text-decoration: line-through; }
```

> If the codebase defines CSS custom properties for surfaces/text, prefer those over the hard-coded hex fallbacks above; match the tokens already used in `StatusBadge.module.css`.

- [ ] **Step 5: Typecheck web**

Run: `cd web && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add web/app/components/PaymentStatusBadge.tsx web/app/components/PaymentStatusBadge.module.css web/app/lib/i18n.ts
git commit -m "feat(receivables): PaymentStatusBadge + payment-status i18n"
```

---

### Task 3: Payment columns on the `/invoices` list

**Files:**
- Modify: `web/app/(cabinet)/invoices/page.tsx` (client `EinvoiceRow` interface, lines ~15-19; `thead`, lines ~84-92; `tbody` row, lines ~95-115)
- Modify: `web/app/lib/i18n.ts` (three new column-header keys in all three catalogs)

**Interfaces:**
- Consumes: the four new `EinvoiceRow` fields from Task 1 (returned by `/api/einvoices`); `PaymentStatusBadge` from Task 2.
- Produces: the list rendering used by the drawer in Task 4 (the Settle action cell + `setSettleRow` state hook are added here in Task 4; Task 3 renders the read-only columns only).

- [ ] **Step 1: Add the column-header i18n keys to all three catalogs**

In `web/app/lib/i18n.ts`, add to each language object (near the other `einv.*` keys). English:

```ts
  'einv.payment': 'Payment',
  'einv.due': 'Due',
  'einv.outstanding': 'Outstanding',
```

Latvian:

```ts
  'einv.payment': 'Maksājums',
  'einv.due': 'Termiņš',
  'einv.outstanding': 'Atlikums',
```

Russian:

```ts
  'einv.payment': 'Оплата',
  'einv.due': 'Срок',
  'einv.outstanding': 'Остаток',
```

- [ ] **Step 2: Extend the client-side `EinvoiceRow` interface and import the badge**

In `web/app/(cabinet)/invoices/page.tsx`, add the import and the four fields:

```tsx
import { PaymentStatusBadge } from '@/app/components/PaymentStatusBadge';
import type { ReceivableStatus } from '@domain/receivables/receivables.js';
```

```tsx
interface EinvoiceRow {
  id: string; direction: 'outbound' | 'inbound'; invoiceNumber: string; issueDate: string;
  grandTotalCents: string; currency: string; peppolStatus: string; peppolMessageId: string | null;
  vidStatus: string; vidDueDate: string | null;
  status: ReceivableStatus | null; dueDate: string | null;
  amountPaidCents: string | null; outstandingCents: string | null;
}
```

- [ ] **Step 3: Add the three header cells**

In the `thead` row, after the `einv.vidDue` header cell, add:

```tsx
                  <th scope="col">{t('einv.payment')}</th>
                  <th scope="col">{t('einv.due')}</th>
                  <th scope="col" className={styles.colAmount}>{t('einv.outstanding')}</th>
```

- [ ] **Step 4: Add the three body cells**

In the `tbody` `<tr>`, after the `r.vidDueDate` cell, add. All three AR cells render only for **outbound rows that carry a `status`** (an actual receivable); inbound rows render "—". Note: `outstandingCents`/`amountPaidCents` are `NOT NULL DEFAULT 0` in the DB, so they are non-null even for inbound rows — do **not** use `outstandingCents != null` as an inbound guard; gate on `r.status` (the genuinely-nullable field) instead. Outstanding uses `formatCents`:

```tsx
                    <td>{r.direction === 'outbound' && r.status ? <PaymentStatusBadge status={r.status} /> : '—'}</td>
                    <td>{r.direction === 'outbound' && r.status && r.dueDate ? fmtDate(r.dueDate) : '—'}</td>
                    <td className={styles.colAmount}>
                      {r.direction === 'outbound' && r.status ? (formatCents(r.outstandingCents ?? '0', r.currency) ?? '—') : '—'}
                    </td>
```

- [ ] **Step 5: Typecheck + build web**

Run: `cd web && npx tsc --noEmit && npm run build`
Expected: both clean (build succeeds; no missing-i18n-key type error).

- [ ] **Step 6: Manual verification**

Start the app, open `/invoices?client=<id>` for a client with at least one outbound invoice. Confirm: a **Payment** pill (Open), a **Due** date (or "—" if none), and an **Outstanding** amount render for outbound rows; inbound rows show "—" in all three. (See project run skill / README for the dev command.)

- [ ] **Step 7: Commit**

```bash
git add "web/app/(cabinet)/invoices/page.tsx" web/app/lib/i18n.ts
git commit -m "feat(receivables): payment status/due/outstanding columns on /invoices"
```

---

### Task 4: Settle/void drawer

**Files:**
- Modify: `web/app/(cabinet)/invoices/page.tsx` (add the Settle action cell, the drawer, and the settle/void handler + state)
- Modify: `web/app/(cabinet)/invoices/page.module.css` (drawer + form styles)
- Modify: `web/app/lib/i18n.ts` (drawer strings in all three catalogs)

**Interfaces:**
- Consumes: `EinvoiceRow` (Task 3), `POST /api/receivables/[id]` (shipped in M4-A) with body `{ clientCompanyId: string, action: 'settle' | 'void', amountCents?: string, paidDate?: string }`; the existing `load(clientCompanyId)` callback to re-fetch.
- Produces: nothing downstream (terminal task of the slice).

- [ ] **Step 1: Add the drawer i18n keys to all three catalogs**

In `web/app/lib/i18n.ts`, add to each language object. English:

```ts
  'settle.action': 'Settle',
  'settle.title': 'Record payment',
  'settle.amount': 'Amount',
  'settle.paidDate': 'Paid date',
  'settle.submit': 'Settle',
  'settle.void': 'Void invoice',
  'settle.cancel': 'Cancel',
  'settle.success': 'Payment recorded',
```

Latvian:

```ts
  'settle.action': 'Apmaksāt',
  'settle.title': 'Reģistrēt maksājumu',
  'settle.amount': 'Summa',
  'settle.paidDate': 'Maksājuma datums',
  'settle.submit': 'Apmaksāt',
  'settle.void': 'Anulēt rēķinu',
  'settle.cancel': 'Atcelt',
  'settle.success': 'Maksājums reģistrēts',
```

Russian:

```ts
  'settle.action': 'Оплатить',
  'settle.title': 'Записать платёж',
  'settle.amount': 'Сумма',
  'settle.paidDate': 'Дата оплаты',
  'settle.submit': 'Оплатить',
  'settle.void': 'Аннулировать счёт',
  'settle.cancel': 'Отмена',
  'settle.success': 'Платёж записан',
```

- [ ] **Step 2: Add drawer state and the settle/void handler**

In `InvoicesInner`, add state near the other `useState` hooks. `settleRow` holds the row being settled; `amount` is a decimal-string input (major units) converted to cents on submit; `paidDate` defaults to today. Add:

```tsx
  const [settleRow, setSettleRow] = useState<EinvoiceRow | null>(null);
  const [amount, setAmount] = useState('');
  const [paidDate, setPaidDate] = useState('');
  const [settleError, setSettleError] = useState<string | null>(null);
  const [settleBusy, setSettleBusy] = useState(false);

  const openSettle = (r: EinvoiceRow) => {
    setSettleRow(r);
    // Prefill amount to outstanding in major units (cents/100), date to today.
    setAmount(r.outstandingCents ? (Number(r.outstandingCents) / 100).toFixed(2) : '');
    setPaidDate(new Date().toISOString().slice(0, 10));
    setSettleError(null);
  };

  const submitSettle = async (action: 'settle' | 'void') => {
    if (!settleRow || !clientCompanyId) return;
    setSettleBusy(true);
    setSettleError(null);
    try {
      const body: Record<string, string> = { clientCompanyId, action };
      if (action === 'settle') {
        body.amountCents = String(Math.round(Number(amount) * 100));
        body.paidDate = paidDate;
      }
      const res = await fetch(`/api/receivables/${encodeURIComponent(settleRow.id)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setSettleRow(null);
      await load(clientCompanyId);
    } catch (err) {
      setSettleError((err as Error).message);
    } finally {
      setSettleBusy(false);
    }
  };
```

- [ ] **Step 3: Add the Settle action cell to each outbound unpaid row**

Add a new trailing `<th>` in the header (screen-reader only, mirroring the existing view-doc column) and a new cell in the body row. In `thead`, after the view-doc header:

```tsx
                  <th scope="col"><span className="sr-only">{t('settle.action')}</span></th>
```

In `tbody`, after the view-doc cell:

```tsx
                    <td>
                      {r.direction === 'outbound' && (r.status === 'open' || r.status === 'partially_paid') ? (
                        <button type="button" className={styles.linkBtn} onClick={() => openSettle(r)}>
                          {t('settle.action')}
                        </button>
                      ) : '—'}
                    </td>
```

- [ ] **Step 4: Render the drawer**

Add, just before the closing `</main>` of `InvoicesInner`, a state-driven dialog mirroring the `payroll/runs/[id]` drawer (overlay click closes; `aria-modal`). Void is offered only when status is `open`:

```tsx
        {settleRow && (
          <div className={styles.overlay} role="dialog" aria-modal="true" onClick={() => setSettleRow(null)}>
            <div className={styles.drawer} onClick={(e) => e.stopPropagation()}>
              <h2>{t('settle.title')}</h2>
              <p className={styles.mono}>{settleRow.invoiceNumber}</p>
              <label>
                {t('settle.amount')}
                <input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </label>
              <label>
                {t('settle.paidDate')}
                <input type="date" value={paidDate} onChange={(e) => setPaidDate(e.target.value)} />
              </label>
              {settleError && <p className={styles.settleError}>{settleError}</p>}
              <div className={styles.drawerActions}>
                <button type="button" onClick={() => setSettleRow(null)} disabled={settleBusy}>{t('settle.cancel')}</button>
                {settleRow.status === 'open' && (
                  <button type="button" onClick={() => submitSettle('void')} disabled={settleBusy}>{t('settle.void')}</button>
                )}
                <button type="button" className={styles.primaryBtn} onClick={() => submitSettle('settle')} disabled={settleBusy}>
                  {t('settle.submit')}
                </button>
              </div>
            </div>
          </div>
        )}
```

- [ ] **Step 5: Add drawer/form styles**

In `web/app/(cabinet)/invoices/page.module.css`, add `.overlay` (fixed full-screen dim backdrop, flex-centered / right-anchored), `.drawer` (panel, padding, column flex, max-width), `.drawerActions` (row, gap, right-aligned), `.linkBtn` (button styled as the existing view-doc link), and `.settleError` (error text). Match spacing/colors already used in this module and in `payroll/runs/[id]/page.module.css`. Reuse `.primaryBtn` and `.mono` if already defined in this module (they are used by the page).

> Read `web/app/(cabinet)/payroll/runs/[id]/page.module.css` for the established `.drawer` treatment and copy its structure/tokens so the two drawers look consistent.

- [ ] **Step 6: Typecheck + build web**

Run: `cd web && npx tsc --noEmit && npm run build`
Expected: both clean.

- [ ] **Step 7: Manual verification**

On `/invoices?client=<id>`: click **Settle** on an open invoice → drawer opens with the outstanding amount prefilled and today's date. Submit a **partial** amount → status becomes **Partially paid**, outstanding drops. Settle the remainder → status becomes **Paid**, the Settle action disappears. On another open invoice, click **Void** → status becomes **Void**. Trigger a server guard (e.g. an amount above outstanding) → the drawer shows the server error message and does not close.

- [ ] **Step 8: Full gate + commit**

Run (from repo root): `npm test && npx tsc --noEmit && cd web && npx tsc --noEmit && npm run build`
Expected: root tests green, both typechecks clean, web build clean.

```bash
git add "web/app/(cabinet)/invoices/page.tsx" "web/app/(cabinet)/invoices/page.module.css" web/app/lib/i18n.ts
git commit -m "feat(receivables): settle/void drawer on /invoices"
```

---

## Self-Review

**Spec coverage:**
- Spec §1 (extend `listEinvoices`) → Task 1. ✓
- Spec §2 (list columns + `PaymentStatusBadge` + Settle action visibility) → Tasks 2 (badge) + 3 (columns) + 4 (Settle action). ✓
- Spec §3 (settle drawer, prefill, POST body, success re-fetch, error surface, void only when open) → Task 4. ✓
- Spec §4 (i18n all three catalogs: headers, status labels, drawer strings) → status labels in Task 2, headers in Task 3, drawer strings in Task 4. ✓
- Spec §5 (query test for new fields; gates) → Task 1 test; gate commands in Global Constraints and Task 4 Step 8. ✓
- Spec deferred items (customer statement, filter, `/invoices/[id]`, later slices) → not implemented, correct. ✓
- **Gap noted:** the spec's testing bullet mentions asserting the fields are "null on an inbound row." No clean inbound-`einvoices` fixture exists (the inbound Peppol flow produces `bills`, not inbound receivable rows), so Task 1 asserts the outbound-populated case only; the null case is covered structurally by the nullable types and the "only the outbound issue path sets status" invariant. This is a deliberate, documented deviation, not an omission.

**Placeholder scan:** No TBD/TODO. Every code step shows complete code. CSS steps (Task 2 Step 4, Task 4 Step 5) describe intent with a concrete starting block and point at an existing module to mirror — acceptable for styling, not a logic placeholder.

**Type consistency:** `EinvoiceRow` field names (`status`, `dueDate`, `amountPaidCents`, `outstandingCents`) are identical across Task 1 (domain), Task 3 (client interface), and Task 4 (usage). `ReceivableStatus` is imported, never redefined. `PaymentStatusBadge({ status })` signature matches its Task 3 usage. The POST body shape matches the route read in `web/app/api/receivables/[id]/route.ts` (`clientCompanyId`, `action`, `amountCents`, `paidDate`). ✓
