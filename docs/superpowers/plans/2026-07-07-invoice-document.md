# Branded Invoice Document Renderer (G4 Slice 3b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render an issued invoice as a branded, print-to-PDF HTML document — logo + footer from the client's invoice profile, content parsed from the stored UBL.

**Architecture:** Extend `invoice_profiles` with `logo_blob_key` + `footer`. A pure `renderInvoiceHtml` helper (domain, testable) builds a self-contained HTML fragment. A logo-upload route stores the image in the blob store. A standalone `/invoice-document/[id]` page (outside the cabinet shell) parses the stored UBL, loads the profile + logo (as a data URI), and injects the rendered fragment + a Print button. Outbox and `/settings` get the entry points.

**Tech Stack:** TypeScript (NodeNext), Postgres via `pg` (RLS), Vitest (real Postgres + pure unit), Next.js 16 (App Router, `--webpack`), React 19, CSS modules, `LocalBlobStore`.

## Global Constraints

- **Money** as integer cents / decimal strings, never floats. Per-line VAT for display computed cent-safe via `toCents`/`fromCents` (`src/db/money.js`).
- **Domain** in `src/<module>/`; per-client mutations `(tx, ctx, …)` inside `withTenant` + `appendAudit`. `invoice_profiles` and `einvoices` are RLS-enabled (tenant isolation) — reads/writes go through `withTenant`.
- **The render helper is PURE** — no React, no I/O, no web imports (it must not import `web/app/lib/i18n.ts`); it carries its own EN/LV/RU label map. Returns a self-contained HTML **fragment** (a `.invoice-doc` `<div>` with a scoped `<style>`), NOT a full `<html>` document.
- **HTML escaping:** every interpolated value goes through `escapeXml` from `src/xml/escape.js` (escapes `& < > " '` — safe for HTML text/attributes here).
- **Per-client API pattern** for the upload route (`resolveTenantContext` → `withTenant`; `assertRoleAllowed(ctx.actorRole, 'invoice_profile.write')`); `errorToStatus` mapping (401 no-token first).
- **Standalone document page** lives OUTSIDE the `(cabinet)` route group (no AppShell); auth still enforced via `requireSession` + `resolveTenantContext`.
- **i18n:** every web-facing string in EN AND LV AND RU in `web/app/lib/i18n.ts` (typed `Record<keyof typeof EN>`). No tracked-uppercase.
- **Tests:** Vitest vs real Postgres (`docker compose up -d`). ⚠️ **Never run two vitest processes at once.**
- **Verify gates:** `npm test` (root) + `npx tsc --noEmit` in root AND `web/` + `npm run build` in `web/`.
- **Commit trailer:** end each commit with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Branch:** work in-place on `main` (user-authorized).

## Reused signatures

- `parseUblInvoice(xml): EInvoice` (`src/einvoice/ubl.js`) — `EInvoice` has invoiceNumber, issueDate, currency, supplier/customer `{name,regNo,vatNo}`, lines `{description,net,vatRate,vat}`, netTotal/vatTotal/grandTotal, and optional dueDate/note/paymentTerms (slice 3a).
- `getInvoiceProfile`/`setInvoiceProfile` + `InvoiceProfile` (`src/einvoice/invoice-profile.js`, slice 3a).
- `toCents(s): bigint` / `fromCents(c: bigint): string` (`src/db/money.js`).
- `escapeXml(s): string` (`src/xml/escape.js`).
- `LocalBlobStore` (`src/blob/blob-store.js`): `put(key, bytes: Buffer, mime)`, `get(key): {bytes, mime}`.
- `appendAudit(tx, ctx, {...})`. `withTenant(ctx, fn)`. `resolveTenantContext`, `requireSession`.

---

### Task 1: Profile branding columns + domain

**Files:**
- Create: `migrations/026_invoice_profile_branding.sql`
- Modify: `src/einvoice/invoice-profile.ts`
- Test: `tests/einvoice/invoice-profile.test.ts` (add cases)

**Interfaces:**
- `InvoiceProfile` gains `logoBlobKey: string | null` and `footer: string | null`.
- `setInvoiceProfile` writes `footer` but does NOT touch `logo_blob_key` (no-clobber).
- New `setInvoiceLogo(tx, ctx, key: string): Promise<void>` — upserts only `logo_blob_key` (+ audit).

- [ ] **Step 1: Migration**

Create `migrations/026_invoice_profile_branding.sql`:
```sql
-- Branding for the invoice document renderer (G4 slice 3b).
ALTER TABLE invoice_profiles ADD COLUMN logo_blob_key text;
ALTER TABLE invoice_profiles ADD COLUMN footer text;
```
(No new grants/policy — `invoice_profiles` already has RLS + SELECT/INSERT/UPDATE.)

- [ ] **Step 2: Add failing tests**

Append to `tests/einvoice/invoice-profile.test.ts`:
```ts
test('setInvoiceProfile writes footer but does not clobber an uploaded logo', async () => {
  const t = await makeFirmAndClient();
  const c = ctx(t);
  await withTenant(c, (tx) => setInvoiceLogo(tx, c, 'invoice-logo/x'));
  await withTenant(c, (tx) => setInvoiceProfile(tx, c, { ...sample, footer: 'Reg. LV123' }));
  const p = await withTenant(c, (tx) => getInvoiceProfile(tx, c));
  expect(p!.footer).toBe('Reg. LV123');
  expect(p!.logoBlobKey).toBe('invoice-logo/x'); // preserved
});

test('setInvoiceLogo upserts the key and audits', async () => {
  const t = await makeFirmAndClient();
  const c = ctx(t);
  await withTenant(c, (tx) => setInvoiceLogo(tx, c, 'invoice-logo/y'));
  const p = await withTenant(c, (tx) => getInvoiceProfile(tx, c));
  expect(p!.logoBlobKey).toBe('invoice-logo/y');
  const audit = await withTenant(c, (tx) =>
    tx.query(`SELECT count(*)::int AS n FROM audit_log WHERE entity_type='invoice_profile' AND action='set_logo'`));
  expect(audit.rows[0].n).toBe(1);
});
```
Also add `import { setInvoiceLogo } from '../../src/einvoice/invoice-profile.js';` and extend the existing `sample` object literal with `footer: null` (so the 3a tests still typecheck against the widened `InvoiceProfile`). Ensure `sample` includes `logoBlobKey: null, footer: null` if the type requires them — but see Step 4: `setInvoiceProfile`'s input type will make logo/footer optional to avoid churn.

- [ ] **Step 3: Run tests → fail**

Run: `npx vitest run tests/einvoice/invoice-profile.test.ts`
Expected: FAIL (setInvoiceLogo missing; logoBlobKey/footer not selected).

- [ ] **Step 4: Implement**

In `src/einvoice/invoice-profile.ts`:

Extend the interface:
```ts
export interface InvoiceProfile {
  paymentTerms: string | null;
  note: string | null;
  dueDateOffsetDays: number | null;
  numberPrefix: string | null;
  defaultLines: InvoiceProfileLine[];
  footer: string | null;
  logoBlobKey: string | null;
}
```

`getInvoiceProfile` — add `footer` and `logo_blob_key AS "logoBlobKey"` to the SELECT.

`setInvoiceProfile` — accept the profile; write `footer` but NOT `logo_blob_key` (so a profile save never clobbers the logo). Its input may omit `logoBlobKey` (the route passes the profile minus logo). Use `Omit<InvoiceProfile, 'logoBlobKey'>` as the input type, and in the upsert include `footer` in both the INSERT column list and the `DO UPDATE SET` (leave `logo_blob_key` out of the SET entirely; on first INSERT it defaults to null):
```ts
export async function setInvoiceProfile(tx: PoolClient, ctx: TenantContext, input: Omit<InvoiceProfile, 'logoBlobKey'>): Promise<void> {
  await tx.query(
    `INSERT INTO invoice_profiles(client_company_id, payment_terms, note, due_date_offset_days, number_prefix, default_lines, footer, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
     ON CONFLICT (client_company_id) DO UPDATE SET
       payment_terms = EXCLUDED.payment_terms, note = EXCLUDED.note,
       due_date_offset_days = EXCLUDED.due_date_offset_days, number_prefix = EXCLUDED.number_prefix,
       default_lines = EXCLUDED.default_lines, footer = EXCLUDED.footer,
       updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [ctx.clientCompanyId, input.paymentTerms, input.note, input.dueDateOffsetDays,
     input.numberPrefix, JSON.stringify(input.defaultLines ?? []), input.footer, ctx.actorId],
  );
  await appendAudit(tx, ctx, { action: 'set', entityType: 'invoice_profile', entityId: ctx.clientCompanyId, before: null, after: input });
}

export async function setInvoiceLogo(tx: PoolClient, ctx: TenantContext, key: string): Promise<void> {
  await tx.query(
    `INSERT INTO invoice_profiles(client_company_id, logo_blob_key, updated_by)
     VALUES ($1,$2,$3)
     ON CONFLICT (client_company_id) DO UPDATE SET logo_blob_key = EXCLUDED.logo_blob_key, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [ctx.clientCompanyId, key, ctx.actorId],
  );
  await appendAudit(tx, ctx, { action: 'set_logo', entityType: 'invoice_profile', entityId: ctx.clientCompanyId, before: null, after: { logoBlobKey: key } });
}
```
Note: `default_lines` has a NOT NULL DEFAULT `'[]'`, so the `setInvoiceLogo` INSERT (which omits it) is fine on first insert.

Update the existing 3a test's `sample` and any `setInvoiceProfile` calls to include `footer` (the input type now requires it — add `footer: null` to `sample`).

- [ ] **Step 5: Run tests → pass**

Run: `npx vitest run tests/einvoice/invoice-profile.test.ts`
Expected: PASS (existing 3a cases + 2 new).

- [ ] **Step 6: Commit**

```bash
git add migrations/026_invoice_profile_branding.sql src/einvoice/invoice-profile.ts tests/einvoice/invoice-profile.test.ts
git commit -m "feat: invoice_profiles logo_blob_key + footer; setInvoiceLogo (G4 slice 3b)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: getEinvoiceUbl

**Files:**
- Modify: `src/einvoice/query.ts`
- Test: `tests/einvoice/query.test.ts` (add case; if the file doesn't exist, create it following `tests/einvoice/vid.test.ts` setup style)

**Interfaces:**
- `getEinvoiceUbl(tx, ctx, id): Promise<{ invoiceNumber: string; ublXml: string } | null>`.

- [ ] **Step 1: Add failing test**

Add a test that issues/inserts an outbound einvoice for a client, then asserts `getEinvoiceUbl` returns `{invoiceNumber, ublXml}` for its id, `null` for a random id, and `null` under a different client's ctx (RLS). Reuse the existing einvoice test setup (see `tests/einvoice/query.test.ts` or `outbound.test.ts` for how an einvoice row is created — `sendInvoice` with the `StubAccessPoint`). Assert `ublXml` contains `<Invoice`.

- [ ] **Step 2: Run → fail** (`npx vitest run tests/einvoice/query.test.ts`).

- [ ] **Step 3: Implement** — append to `src/einvoice/query.ts`:
```ts
export async function getEinvoiceUbl(
  tx: PoolClient, ctx: TenantContext, id: string,
): Promise<{ invoiceNumber: string; ublXml: string } | null> {
  const res = await tx.query(
    `SELECT invoice_number AS "invoiceNumber", ubl_xml AS "ublXml"
     FROM einvoices WHERE id = $1 AND client_company_id = $2`,
    [id, ctx.clientCompanyId],
  );
  return res.rows[0] ?? null;
}
```
(Match the file's existing imports for `PoolClient`/`TenantContext`.)

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Commit**
```bash
git add src/einvoice/query.ts tests/einvoice/query.test.ts
git commit -m "feat: getEinvoiceUbl — fetch an einvoice's stored UBL by id (G4 slice 3b)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `renderInvoiceHtml` pure helper

**Files:**
- Create: `src/einvoice/invoice-html.ts`
- Test: `tests/einvoice/invoice-html.test.ts`

**Interfaces:**
- `renderInvoiceHtml(inv: EInvoice, opts: { footer: string | null; logoDataUri: string | null; lang: 'lv'|'en'|'ru' }): string` — returns a self-contained HTML fragment.

- [ ] **Step 1: Failing test**

Create `tests/einvoice/invoice-html.test.ts`:
```ts
import { expect, test } from 'vitest';
import { renderInvoiceHtml } from '../../src/einvoice/invoice-html.js';

const inv = {
  invoiceNumber: 'INV-9', issueDate: '2026-07-01', currency: 'EUR',
  supplier: { name: 'Ozola SIA', regNo: '40000000001', vatNo: 'LV40000000001' },
  customer: { name: 'Client <X>', regNo: '2', vatNo: 'LV2' },
  lines: [{ description: 'Consulting', net: '100.00', vatRate: 21, vat: '21.00' }],
  netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
  dueDate: '2026-07-15', note: 'Thanks', paymentTerms: 'Net 14',
};

test('renders invoice number, parties, lines, totals, note, terms, footer', () => {
  const html = renderInvoiceHtml(inv, { footer: 'Reg. LV123', logoDataUri: null, lang: 'en' });
  expect(html).toContain('INV-9');
  expect(html).toContain('Ozola SIA');
  expect(html).toContain('Consulting');
  expect(html).toContain('121.00');
  expect(html).toContain('Thanks');
  expect(html).toContain('Net 14');
  expect(html).toContain('Reg. LV123');
  expect(html).not.toContain('<img'); // no logo
});

test('escapes interpolated text (no raw < from customer name)', () => {
  const html = renderInvoiceHtml(inv, { footer: null, logoDataUri: null, lang: 'en' });
  expect(html).toContain('Client &lt;X&gt;');
  expect(html).not.toContain('Client <X>');
});

test('includes a logo img when a data URI is given', () => {
  const html = renderInvoiceHtml(inv, { footer: null, logoDataUri: 'data:image/png;base64,AAAA', lang: 'lv' });
  expect(html).toContain('<img');
  expect(html).toContain('data:image/png;base64,AAAA');
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

Create `src/einvoice/invoice-html.ts`:
```ts
import type { EInvoice } from './ubl.js';
import { escapeXml } from '../xml/escape.js';
import { toCents, fromCents } from '../db/money.js';

type DocLang = 'lv' | 'en' | 'ru';

const LABELS: Record<DocLang, Record<string, string>> = {
  en: { invoice: 'Invoice', from: 'From', billTo: 'Bill to', regNo: 'Reg. No', vatNo: 'VAT No', issue: 'Issue date', due: 'Due date', desc: 'Description', net: 'Net', vat: 'VAT', lineVat: 'VAT amount', netTotal: 'Net total', vatTotal: 'VAT total', grand: 'Total', note: 'Note', terms: 'Payment terms', print: 'Print / Save as PDF' },
  lv: { invoice: 'Rēķins', from: 'No', billTo: 'Saņēmējs', regNo: 'Reģ. Nr.', vatNo: 'PVN Nr.', issue: 'Izrakstīšanas datums', due: 'Apmaksas termiņš', desc: 'Apraksts', net: 'Neto', vat: 'PVN', lineVat: 'PVN summa', netTotal: 'Neto kopā', vatTotal: 'PVN kopā', grand: 'Kopā', note: 'Piezīme', terms: 'Apmaksas nosacījumi', print: 'Drukāt / Saglabāt PDF' },
  ru: { invoice: 'Счёт', from: 'От', billTo: 'Получатель', regNo: 'Рег. №', vatNo: 'НДС №', issue: 'Дата выставления', due: 'Срок оплаты', desc: 'Описание', net: 'Нетто', vat: 'НДС', lineVat: 'Сумма НДС', netTotal: 'Нетто итого', vatTotal: 'НДС итого', grand: 'Итого', note: 'Примечание', terms: 'Условия оплаты', print: 'Печать / Сохранить PDF' },
};

const money = (v: string, cur: string) => `${escapeXml(v)}&nbsp;${escapeXml(cur)}`;

function lineVat(net: string, rate: number): string {
  return fromCents((toCents(net) * BigInt(Math.round(rate))) / 100n);
}

export function renderInvoiceHtml(
  inv: EInvoice,
  opts: { footer: string | null; logoDataUri: string | null; lang: DocLang },
): string {
  const L = LABELS[opts.lang] ?? LABELS.lv;
  const cur = inv.currency;
  const logo = opts.logoDataUri
    ? `<img class="logo" src="${escapeXml(opts.logoDataUri)}" alt="" />`
    : '';
  const rows = inv.lines.map((l) => `
        <tr>
          <td>${escapeXml(l.description)}</td>
          <td class="num">${money(l.net, cur)}</td>
          <td class="num">${escapeXml(String(l.vatRate))}%</td>
          <td class="num">${money(lineVat(l.net, l.vatRate), cur)}</td>
        </tr>`).join('');
  const party = (label: string, p: { name: string; regNo: string; vatNo: string }) => `
      <div class="party">
        <div class="party-label">${escapeXml(label)}</div>
        <div class="party-name">${escapeXml(p.name)}</div>
        <div>${escapeXml(L.regNo)}: ${escapeXml(p.regNo)}</div>
        <div>${escapeXml(L.vatNo)}: ${escapeXml(p.vatNo)}</div>
      </div>`;
  return `<div class="invoice-doc">
    <style>
      .invoice-doc { font-family: system-ui, sans-serif; color: #1a1a1a; max-width: 800px; margin: 0 auto; padding: 32px; }
      .invoice-doc .head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; }
      .invoice-doc .logo { max-height: 64px; max-width: 240px; }
      .invoice-doc h1 { font-size: 1.5rem; margin: 0 0 4px; }
      .invoice-doc .parties { display: flex; gap: 48px; margin-bottom: 24px; }
      .invoice-doc .party-label { font-size: 0.75rem; text-transform: none; color: #666; margin-bottom: 4px; }
      .invoice-doc .party-name { font-weight: 600; }
      .invoice-doc table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
      .invoice-doc th, .invoice-doc td { padding: 8px; border-bottom: 1px solid #ddd; text-align: left; }
      .invoice-doc .num { text-align: right; font-variant-numeric: tabular-nums; }
      .invoice-doc .totals { margin-left: auto; width: 260px; }
      .invoice-doc .totals .num { text-align: right; }
      .invoice-doc .grand { font-weight: 700; }
      .invoice-doc .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #ddd; color: #555; font-size: 0.85rem; white-space: pre-wrap; }
      @media print { .print-btn { display: none !important; } }
    </style>
    <div class="head">
      <div>${logo}</div>
      <div style="text-align:right">
        <h1>${escapeXml(L.invoice)}</h1>
        <div>${escapeXml(inv.invoiceNumber)}</div>
        <div>${escapeXml(L.issue)}: ${escapeXml(inv.issueDate)}</div>
        ${inv.dueDate ? `<div>${escapeXml(L.due)}: ${escapeXml(inv.dueDate)}</div>` : ''}
      </div>
    </div>
    <div class="parties">
      ${party(L.from, inv.supplier)}
      ${party(L.billTo, inv.customer)}
    </div>
    <table>
      <thead><tr>
        <th>${escapeXml(L.desc)}</th><th class="num">${escapeXml(L.net)}</th>
        <th class="num">${escapeXml(L.vat)}</th><th class="num">${escapeXml(L.lineVat)}</th>
      </tr></thead>
      <tbody>${rows}
      </tbody>
    </table>
    <table class="totals"><tbody>
      <tr><td>${escapeXml(L.netTotal)}</td><td class="num">${money(inv.netTotal, cur)}</td></tr>
      <tr><td>${escapeXml(L.vatTotal)}</td><td class="num">${money(inv.vatTotal, cur)}</td></tr>
      <tr class="grand"><td>${escapeXml(L.grand)}</td><td class="num">${money(inv.grandTotal, cur)}</td></tr>
    </tbody></table>
    ${inv.note ? `<div><strong>${escapeXml(L.note)}:</strong> ${escapeXml(inv.note)}</div>` : ''}
    ${inv.paymentTerms ? `<div><strong>${escapeXml(L.terms)}:</strong> ${escapeXml(inv.paymentTerms)}</div>` : ''}
    ${opts.footer ? `<div class="footer">${escapeXml(opts.footer)}</div>` : ''}
  </div>`;
}
```

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Commit**
```bash
git add src/einvoice/invoice-html.ts tests/einvoice/invoice-html.test.ts
git commit -m "feat: renderInvoiceHtml — pure branded invoice-document fragment (G4 slice 3b)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Logo upload route + profile POST footer

**Files:**
- Create: `web/app/api/invoice-profile/logo/route.ts`
- Modify: `web/app/api/invoice-profile/route.ts` (accept `footer`; pass profile without `logoBlobKey`)

**Interfaces:**
- `POST /api/invoice-profile/logo` `{ clientCompanyId, bytesBase64, mime }` → `{ ok: true }`.
- The existing profile `POST` now includes `footer` in the object handed to `setInvoiceProfile`.

- [ ] **Step 1: Logo route**

Create `web/app/api/invoice-profile/logo/route.ts`:
```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { setInvoiceLogo } from '@domain/einvoice/invoice-profile.js';
import { LocalBlobStore } from '@domain/blob/blob-store.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

const blob = new LocalBlobStore(process.env.BLOB_DIR ?? '.blob-store');
const MAX_BYTES = 1_000_000;

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string; bytesBase64?: string; mime?: string };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.bytesBase64 || !body.mime) return NextResponse.json({ error: 'missing bytesBase64 or mime' }, { status: 400 });
  if (!body.mime.startsWith('image/')) return NextResponse.json({ error: 'logo must be an image' }, { status: 400 });
  const bytes = Buffer.from(body.bytesBase64, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_BYTES) return NextResponse.json({ error: 'invalid logo size' }, { status: 400 });

  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'invoice_profile.write');
    const key = `invoice-logo/${ctx.clientCompanyId}`;
    await blob.put(key, bytes, body.mime);
    await withTenant(ctx, (tx) => setInvoiceLogo(tx, ctx, key));
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
```

- [ ] **Step 2: Profile POST — include footer**

In `web/app/api/invoice-profile/route.ts` POST handler, the object passed to `setInvoiceProfile` must now include `footer: p.footer?.trim() || null` (add `footer?: string` to the destructured `profile` type). Do NOT pass `logoBlobKey` (the domain input type is `Omit<…,'logoBlobKey'>`). Everything else unchanged. (Add a `typeof p.footer` guard alongside the existing string guards from slice 3a.)

- [ ] **Step 3: Verify typecheck + smoke**

`cd web && npx tsc --noEmit` (clean). Then (dev server on :3000; if down, from `web/`: `nohup npm run dev >/tmp/dev.log 2>&1 &` and wait):
```bash
AT=$(curl -s -c - "http://localhost:3000/api/dev/bootstrap" -o /dev/null | grep bk_session | awk '{print $7}')
CID=$(curl -s -b "bk_session=$AT" "http://localhost:3000/api/admin/clients" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).clients[0].id))")
PNG=$(node -e "console.log(Buffer.from([137,80,78,71,13,10,26,10]).toString('base64'))")
curl -s -o /dev/null -w "accountant logo upload: %{http_code}\n" -b "bk_session=$AT" -X POST "http://localhost:3000/api/invoice-profile/logo" -H 'content-type: application/json' -d "{\"clientCompanyId\":\"$CID\",\"bytesBase64\":\"$PNG\",\"mime\":\"image/png\"}"   # 200
curl -s -o /dev/null -w "no-cookie: %{http_code}\n" -X POST "http://localhost:3000/api/invoice-profile/logo" -H 'content-type: application/json' -d "{}"   # 401
```
Expected 200 / 401. (employee 403 verified by controller in Task 6.)

- [ ] **Step 4: Commit**
```bash
git add web/app/api/invoice-profile/logo/route.ts web/app/api/invoice-profile/route.ts
git commit -m "feat(web): logo upload route + footer on invoice-profile POST (G4 slice 3b)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Standalone document page + PrintButton

**Files:**
- Create: `web/app/invoice-document/[id]/page.tsx`
- Create: `web/app/invoice-document/[id]/PrintButton.tsx`

**Interfaces:**
- Consumes: `requireSession`, `resolveTenantContext`, `withTenant`, `getEinvoiceUbl`, `parseUblInvoice`, `getInvoiceProfile`, `renderInvoiceHtml`, `LocalBlobStore`.
- Produces: `/invoice-document/<id>?client=<cid>&lang=<lv|ru|en>` — a standalone print page.

- [ ] **Step 1: PrintButton (client)**

Create `web/app/invoice-document/[id]/PrintButton.tsx`:
```tsx
'use client';
export function PrintButton({ label }: { label: string }) {
  return (
    <button type="button" className="print-btn" onClick={() => window.print()}
      style={{ display: 'block', margin: '16px auto', padding: '8px 16px' }}>
      {label}
    </button>
  );
}
```

- [ ] **Step 2: Page (server component)**

Create `web/app/invoice-document/[id]/page.tsx`:
```tsx
import { requireSession } from '@/app/lib/require-session';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { getEinvoiceUbl } from '@domain/einvoice/query.js';
import { parseUblInvoice } from '@domain/einvoice/ubl.js';
import { getInvoiceProfile } from '@domain/einvoice/invoice-profile.js';
import { renderInvoiceHtml } from '@domain/einvoice/invoice-html.js';
import { LocalBlobStore } from '@domain/blob/blob-store.js';
import { PrintButton } from './PrintButton';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const blob = new LocalBlobStore(process.env.BLOB_DIR ?? '.blob-store');
const LABEL_PRINT: Record<string, string> = { lv: 'Drukāt / Saglabāt PDF', en: 'Print / Save as PDF', ru: 'Печать / Сохранить PDF' };

export default async function InvoiceDocumentPage(
  { params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ client?: string; lang?: string }> },
) {
  await requireSession();
  const { id } = await params;
  const sp = await searchParams;
  const client = sp.client;
  const lang = (sp.lang === 'en' || sp.lang === 'ru' ? sp.lang : 'lv') as 'lv' | 'en' | 'ru';
  if (!client) return <main style={{ padding: 32 }}>Missing client.</main>;

  const token = await getSessionToken();
  let html: string | null = null;
  try {
    const ctx = await resolveTenantContext(token!, client, nowUnix());
    const data = await withTenant(ctx, async (tx) => {
      const ei = await getEinvoiceUbl(tx, ctx, id);
      if (!ei) return null;
      const profile = await getInvoiceProfile(tx, ctx);
      return { ei, profile };
    });
    if (data) {
      const inv = parseUblInvoice(data.ei.ublXml);
      let logoDataUri: string | null = null;
      if (data.profile?.logoBlobKey) {
        try {
          const { bytes, mime } = await blob.get(data.profile.logoBlobKey);
          logoDataUri = `data:${mime};base64,${bytes.toString('base64')}`;
        } catch { logoDataUri = null; }
      }
      html = renderInvoiceHtml(inv, { footer: data.profile?.footer ?? null, logoDataUri, lang });
    }
  } catch {
    html = null;
  }

  if (!html) return <main style={{ padding: 32 }}>Invoice not found.</main>;
  return (
    <main>
      <PrintButton label={LABEL_PRINT[lang] ?? LABEL_PRINT.lv} />
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </main>
  );
}
```

- [ ] **Step 3: Verify typecheck + build**

`cd web && npx tsc --noEmit && npm run build` — clean; `/invoice-document/[id]` present in the route list.

- [ ] **Step 4: Commit**
```bash
git add web/app/invoice-document
git commit -m "feat(web): standalone /invoice-document/[id] print page (G4 slice 3b)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Outbox link + settings logo/footer UI

**Files:**
- Modify: `web/app/(cabinet)/invoices/page.tsx` (View/Print link per outbound row)
- Modify: `web/app/(cabinet)/settings/InvoiceDefaultsForm.tsx` (footer textarea + logo upload)
- Modify: `web/app/lib/i18n.ts` (new strings)

- [ ] **Step 1: i18n**

Add to all three catalogs: `einv.viewDoc` (EN 'View / Print' · LV 'Skatīt / Drukāt' · RU 'Открыть / Печать'); `settings.invoice.footer` (EN 'Footer' · LV 'Kājene' · RU 'Нижний колонтитул'); `settings.invoice.logo` (EN 'Logo' · LV 'Logotips' · RU 'Логотип'); `settings.invoice.logoUploaded` (EN 'Logo uploaded.' · LV 'Logotips augšupielādēts.' · RU 'Логотип загружен.').

- [ ] **Step 2: Outbox link**

In `web/app/(cabinet)/invoices/page.tsx`, add a cell to each outbound row (guard `r.direction === 'outbound'`) with a `<Link>` (or `<a target="_blank">`) to `/invoice-document/${r.id}?client=${encodeURIComponent(clientCompanyId!)}&lang=${lang}` labelled `t('einv.viewDoc')`. Get `lang` from `useMessages()` (it exposes `lang`). Add a matching `<th>` header cell.

- [ ] **Step 3: Settings — footer + logo**

In `InvoiceDefaultsForm.tsx`: add a `footer` textarea bound into the profile state + included in the POST body (`footer`). Add a **logo** file `<input type="file" accept="image/*">`: on change, read the file as base64 (FileReader), `POST /api/invoice-profile/logo` with `{ clientCompanyId, bytesBase64, mime }`, show `t('settings.invoice.logoUploaded')` on success (reuse the existing status/error pattern). Show the current logo (`<img>`) if the loaded profile has `logoBlobKey` — since there's no public blob URL, simplest: after a successful upload just show the success message (a live preview of the uploaded file via `URL.createObjectURL` is optional). Keep money/labels via `t()`.

- [ ] **Step 4: Verify typecheck + build**

`cd web && npx tsc --noEmit && npm run build` — clean.

- [ ] **Step 5: Commit**
```bash
git add web/app/\(cabinet\)/invoices/page.tsx web/app/\(cabinet\)/settings/InvoiceDefaultsForm.tsx web/app/lib/i18n.ts
git commit -m "feat(web): outbox View/Print link + logo/footer on invoice defaults (G4 slice 3b)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Final verification gates

- [ ] **Step 1: Full backend suite** — `npm test` (single process). Expected green (207 + Task1 2 + Task2 ~1 + Task3 3 ≈ 213+).
- [ ] **Step 2: Typechecks + build** — `npx tsc --noEmit` (root), `cd web && npx tsc --noEmit && npm run build`. All clean; `/invoice-document/[id]` + `/api/invoice-profile/logo` present.
- [ ] **Step 3: Per-role + end-to-end smoke (controller):** logo upload accountant 200 / employee 403 / no-cookie 401; issue an invoice (or reuse one), then GET `/invoice-document/<id>?client=<cid>&lang=lv` and confirm the HTML contains the invoice number, a party name, the footer, and an `<img src="data:image` after a logo upload; a bogus id → "not found".
- [ ] **Step 4: Update `docs/HANDOFF-audit-fixes.md`** — G4 slice 3b shipped; only slice 4 (notification templates) remains in G4.
- [ ] **Step 5: Commit** the handoff.

---

## Self-review notes

- **Spec coverage:** logo/footer columns + no-clobber (Task 1); getEinvoiceUbl (Task 2); pure render helper + escaping + logo-optional (Task 3); logo upload route + footer POST (Task 4); standalone print page parsing stored UBL + logo data URI (Task 5); outbox link + settings UI (Task 6). All covered.
- **No-clobber:** `setInvoiceProfile` omits `logo_blob_key` from the upsert entirely (refines the spec's COALESCE idea — simpler, same effect: an UPDATE never touches the column, first INSERT leaves it null); the Task 1 test asserts a profile-save preserves an uploaded logo.
- **Escaping / injection:** the helper routes every interpolated value (incl. the logo data URI attribute) through `escapeXml`; test asserts a `<`-containing name is escaped.
- **Types:** `InvoiceProfile` widened (Task 1) — `setInvoiceProfile` input is `Omit<…,'logoBlobKey'>`; the 3a settings form/route pass footer, not logo. `renderInvoiceHtml` signature (Task 3) consumed by the page (Task 5). `getEinvoiceUbl` (Task 2) → page.
- **Standalone page:** outside `(cabinet)`, so no AppShell chrome; `@media print` in the fragment hides the button. Auth via requireSession + resolveTenantContext (tenant-scoped; foreign id → null → not-found).
- **Money:** per-line VAT computed via `toCents`/`fromCents` (cent-safe); totals shown as parsed decimal strings. No floats.
