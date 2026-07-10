# Per-Client Invoice Profile + UBL Content (G4 Slice 3a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-client invoice-defaults record (payment terms, note, due-date offset, number prefix, default lines) that pre-fills the invoice composer and threads Note / PaymentTerms / DueDate into the real UBL invoice.

**Architecture:** Extend the UBL `EInvoice`/`buildUblInvoice`/`parseUblInvoice` with three optional fields (backward-compatible). A new RLS-scoped `invoice_profiles` table (one row per client) with a `src/einvoice/invoice-profile.ts` domain. A new `invoice_profile.write` authz op. Per-client tenant routes `GET/POST /api/invoice-profile`. The composer fetches the profile and applies defaults; a `/settings` section edits it.

**Tech Stack:** TypeScript (NodeNext), Postgres via `pg` (jsonb + RLS), Vitest (real Postgres), Next.js 16 (App Router, `--webpack`), React 19, CSS modules.

## Global Constraints

- **Money** as integer cents / decimal strings, never floats. `default_lines[].net` is a decimal string like `"100.00"` (matches `InvoiceLineIn.net`); `vatRate` a number.
- **Domain** in `src/<module>/`; per-client mutations take `(tx, ctx, …)`, run inside `withTenant`, and call `appendAudit`. RLS enforced — `invoice_profiles` is tenant-scoped (ENABLE + FORCE RLS), NOT the firm-admin no-RLS pattern.
- **Per-client API pattern** (mirror `web/app/api/periods/route.ts`): `getSessionToken()` → `resolveTenantContext(token, clientCompanyId, nowUnix())` → domain call inside `withTenant`; map errors via `errorToStatus` from `@/app/lib/authz` (401 no-token first). Writes gate with `assertRoleAllowed(ctx.actorRole, 'invoice_profile.write')`.
- **UBL:** new fields emitted ONLY when present, in EN 16931 / UBL 2.1 order; absent → byte-identical output (backward-compat). All text `escapeXml`'d.
- **i18n:** every user-facing string in EN AND LV AND RU in `web/app/lib/i18n.ts` (typed `Record<keyof typeof EN>` — missing key fails build). No tracked-uppercase; tabular numerals for money.
- **Tests:** Vitest against real Postgres (`docker compose up -d` first). ⚠️ **Never run two vitest processes at once** — the suite DROPs/recreates the shared schema.
- **Verify gates:** `npm test` (root) + `npx tsc --noEmit` in root AND `web/` + `npm run build` in `web/`.
- **Commit trailer:** end each commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Branch:** work in-place on `main` (user-authorized).

---

### Task 1: UBL threading — optional Note / PaymentTerms / DueDate

**Files:**
- Modify: `src/einvoice/ubl.ts`
- Test: `tests/einvoice/ubl.test.ts` (add cases)

**Interfaces:**
- Produces: `EInvoice` gains optional `dueDate?: string`, `note?: string`, `paymentTerms?: string`. `buildUblInvoice` emits them when present; `parseUblInvoice` reads them back.

- [ ] **Step 1: Add failing tests**

Read `tests/einvoice/ubl.test.ts` first to match its style/imports. Append:

```ts
test('buildUblInvoice omits optional fields when absent (backward-compatible)', () => {
  const inv = {
    invoiceNumber: 'INV-1', issueDate: '2026-07-01', currency: 'EUR',
    supplier: { name: 'S', regNo: '1', vatNo: 'LV1' },
    customer: { name: 'C', regNo: '2', vatNo: 'LV2' },
    lines: [{ description: 'x', net: '100.00', vatRate: 21, vat: '21.00' }],
    netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
  };
  const xml = buildUblInvoice(inv);
  expect(xml).not.toContain('<cbc:DueDate>');
  expect(xml).not.toContain('<cbc:Note>');
  expect(xml).not.toContain('<cac:PaymentTerms>');
});

test('buildUblInvoice emits DueDate, Note, PaymentTerms when present, in valid order', () => {
  const inv = {
    invoiceNumber: 'INV-2', issueDate: '2026-07-01', currency: 'EUR',
    supplier: { name: 'S', regNo: '1', vatNo: 'LV1' },
    customer: { name: 'C', regNo: '2', vatNo: 'LV2' },
    lines: [{ description: 'x', net: '100.00', vatRate: 21, vat: '21.00' }],
    netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
    dueDate: '2026-07-15', note: 'Thank you', paymentTerms: 'Net 14 days',
  };
  const xml = buildUblInvoice(inv);
  expect(xml).toContain('<cbc:DueDate>2026-07-15</cbc:DueDate>');
  expect(xml).toContain('<cbc:Note>Thank you</cbc:Note>');
  expect(xml).toContain('<cac:PaymentTerms><cbc:Note>Net 14 days</cbc:Note></cac:PaymentTerms>');
  // DueDate after IssueDate, before DocumentCurrencyCode
  expect(xml.indexOf('<cbc:DueDate>')).toBeGreaterThan(xml.indexOf('<cbc:IssueDate>'));
  expect(xml.indexOf('<cbc:DueDate>')).toBeLessThan(xml.indexOf('<cbc:DocumentCurrencyCode>'));
  // PaymentTerms after customer party, before TaxTotal
  expect(xml.indexOf('<cac:PaymentTerms>')).toBeGreaterThan(xml.indexOf('AccountingCustomerParty'));
  expect(xml.indexOf('<cac:PaymentTerms>')).toBeLessThan(xml.indexOf('<cac:TaxTotal>'));
});

test('parseUblInvoice round-trips the optional fields', () => {
  const inv = {
    invoiceNumber: 'INV-3', issueDate: '2026-07-01', currency: 'EUR',
    supplier: { name: 'S', regNo: '1', vatNo: 'LV1' },
    customer: { name: 'C', regNo: '2', vatNo: 'LV2' },
    lines: [{ description: 'x', net: '100.00', vatRate: 21, vat: '21.00' }],
    netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
    dueDate: '2026-07-15', note: 'Thank you', paymentTerms: 'Net 14 days',
  };
  const parsed = parseUblInvoice(buildUblInvoice(inv));
  expect(parsed.dueDate).toBe('2026-07-15');
  expect(parsed.note).toBe('Thank you');
  expect(parsed.paymentTerms).toBe('Net 14 days');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/einvoice/ubl.test.ts`
Expected: the three new tests FAIL (fields not emitted/parsed yet); existing tests still pass.

- [ ] **Step 3: Implement**

In `src/einvoice/ubl.ts`:

(a) Extend the interface:
```ts
export interface EInvoice {
  invoiceNumber: string; issueDate: string; currency: string;
  supplier: InvoiceParty; customer: InvoiceParty; lines: InvoiceLineIn[];
  netTotal: string; vatTotal: string; grandTotal: string;
  dueDate?: string; note?: string; paymentTerms?: string;
}
```

(b) In `buildUblInvoice`, change the returned array so it (1) inserts the optional entries in the right place as `null` when absent and (2) `.filter(Boolean)` before `.join('\n')` so an absent field adds no line (byte-identical output). Replace the `return [ … ].join('\n');` block with:

```ts
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">',
    `  <cbc:CustomizationID>${CUSTOMIZATION}</cbc:CustomizationID>`,
    `  <cbc:ProfileID>${PROFILE}</cbc:ProfileID>`,
    `  <cbc:ID>${escapeXml(inv.invoiceNumber)}</cbc:ID>`,
    `  <cbc:IssueDate>${inv.issueDate}</cbc:IssueDate>`,
    inv.dueDate ? `  <cbc:DueDate>${inv.dueDate}</cbc:DueDate>` : null,
    inv.note ? `  <cbc:Note>${escapeXml(inv.note)}</cbc:Note>` : null,
    `  <cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode>`,
    party('AccountingSupplierParty', inv.supplier, cur),
    party('AccountingCustomerParty', inv.customer, cur),
    inv.paymentTerms ? `  <cac:PaymentTerms><cbc:Note>${escapeXml(inv.paymentTerms)}</cbc:Note></cac:PaymentTerms>` : null,
    `  <cac:TaxTotal><cbc:TaxAmount currencyID="${cur}">${inv.vatTotal}</cbc:TaxAmount></cac:TaxTotal>`,
    `  <cac:LegalMonetaryTotal>`,
    `    <cbc:LineExtensionAmount currencyID="${cur}">${inv.netTotal}</cbc:LineExtensionAmount>`,
    `    <cbc:TaxExclusiveAmount currencyID="${cur}">${inv.netTotal}</cbc:TaxExclusiveAmount>`,
    `    <cbc:TaxInclusiveAmount currencyID="${cur}">${inv.grandTotal}</cbc:TaxInclusiveAmount>`,
    `    <cbc:PayableAmount currencyID="${cur}">${inv.grandTotal}</cbc:PayableAmount>`,
    `  </cac:LegalMonetaryTotal>`,
    lines,
    '</Invoice>',
  ].filter(Boolean).join('\n');
```

(c) In `parseUblInvoice`, add the optional fields to the returned object (place after `currency`):
```ts
    ...(inv.DueDate !== undefined && { dueDate: String(inv.DueDate) }),
    ...(inv.Note !== undefined && { note: String(inv.Note) }),
    ...((inv.PaymentTerms as { Note?: unknown })?.Note !== undefined && {
      paymentTerms: String((inv.PaymentTerms as { Note?: unknown }).Note),
    }),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/einvoice/ubl.test.ts`
Expected: all pass (new + existing).

- [ ] **Step 5: Commit**

```bash
git add src/einvoice/ubl.ts tests/einvoice/ubl.test.ts
git commit -m "feat: thread optional Note/PaymentTerms/DueDate through UBL invoice (G4 slice 3a)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Migration + invoice-profile domain + tests

**Files:**
- Create: `migrations/025_invoice_profiles.sql`
- Create: `src/einvoice/invoice-profile.ts`
- Test: `tests/einvoice/invoice-profile.test.ts`

**Interfaces:**
- Produces: types `InvoiceProfileLine`, `InvoiceProfile`; `getInvoiceProfile(tx, ctx): Promise<InvoiceProfile | null>`; `setInvoiceProfile(tx, ctx, input: InvoiceProfile): Promise<void>`.

- [ ] **Step 1: Migration**

Create `migrations/025_invoice_profiles.sql`:

```sql
-- Per-client invoice defaults (G4 slice 3a). Tenant data → RLS-enabled like accounts.
CREATE TABLE invoice_profiles (
  client_company_id     uuid PRIMARY KEY REFERENCES client_companies(id),
  payment_terms         text,
  note                  text,
  due_date_offset_days  integer,
  number_prefix         text,
  default_lines         jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid
);

ALTER TABLE invoice_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY invoice_profiles_tenant_isolation ON invoice_profiles
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON invoice_profiles TO bookkeeping_app;
```

- [ ] **Step 2: Failing test**

Create `tests/einvoice/invoice-profile.test.ts`:

```ts
import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { getInvoiceProfile, setInvoiceProfile } from '../../src/einvoice/invoice-profile.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

const sample = {
  paymentTerms: 'Net 14', note: 'Thanks', dueDateOffsetDays: 14, numberPrefix: 'INV-2026-',
  defaultLines: [{ description: 'Retainer', net: '500.00', vatRate: 21 }],
};

test('getInvoiceProfile returns null when unset', async () => {
  const t = await makeFirmAndClient();
  const c = ctx(t);
  const p = await withTenant(c, (tx) => getInvoiceProfile(tx, c));
  expect(p).toBeNull();
});

test('setInvoiceProfile upserts (second set overwrites) and audits', async () => {
  const t = await makeFirmAndClient();
  const c = ctx(t);
  await withTenant(c, (tx) => setInvoiceProfile(tx, c, sample));
  await withTenant(c, (tx) => setInvoiceProfile(tx, c, { ...sample, numberPrefix: 'INV-B-' }));
  const p = await withTenant(c, (tx) => getInvoiceProfile(tx, c));
  expect(p!.numberPrefix).toBe('INV-B-');
  expect(p!.defaultLines[0]!.net).toBe('500.00');
  const audit = await withTenant(c, (tx) =>
    tx.query(`SELECT count(*)::int AS n FROM audit_log WHERE entity_type='invoice_profile'`));
  expect(audit.rows[0].n).toBeGreaterThanOrEqual(1);
  // upsert, not duplicate rows
  const rows = await withTenant(c, (tx) =>
    tx.query(`SELECT count(*)::int AS n FROM invoice_profiles`));
  expect(rows.rows[0].n).toBe(1);
});

test('RLS isolates profiles per client', async () => {
  const a = await makeFirmAndClient('A');
  const b = await makeFirmAndClient('B');
  const ca = ctx(a); const cb = ctx(b);
  await withTenant(ca, (tx) => setInvoiceProfile(tx, ca, sample));
  const fromB = await withTenant(cb, (tx) => getInvoiceProfile(tx, cb));
  expect(fromB).toBeNull();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/einvoice/invoice-profile.test.ts`
Expected: FAIL — cannot resolve `../../src/einvoice/invoice-profile.js`.

- [ ] **Step 4: Implement**

Create `src/einvoice/invoice-profile.ts`:

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appendAudit } from '../audit/audit.js';

export interface InvoiceProfileLine { description: string; net: string; vatRate: number }
export interface InvoiceProfile {
  paymentTerms: string | null;
  note: string | null;
  dueDateOffsetDays: number | null;
  numberPrefix: string | null;
  defaultLines: InvoiceProfileLine[];
}

export async function getInvoiceProfile(tx: PoolClient, ctx: TenantContext): Promise<InvoiceProfile | null> {
  const res = await tx.query(
    `SELECT payment_terms AS "paymentTerms", note, due_date_offset_days AS "dueDateOffsetDays",
            number_prefix AS "numberPrefix", default_lines AS "defaultLines"
     FROM invoice_profiles WHERE client_company_id = $1`,
    [ctx.clientCompanyId],
  );
  return res.rows[0] ?? null;
}

export async function setInvoiceProfile(tx: PoolClient, ctx: TenantContext, input: InvoiceProfile): Promise<void> {
  await tx.query(
    `INSERT INTO invoice_profiles(client_company_id, payment_terms, note, due_date_offset_days, number_prefix, default_lines, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
     ON CONFLICT (client_company_id) DO UPDATE SET
       payment_terms = EXCLUDED.payment_terms, note = EXCLUDED.note,
       due_date_offset_days = EXCLUDED.due_date_offset_days, number_prefix = EXCLUDED.number_prefix,
       default_lines = EXCLUDED.default_lines, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [ctx.clientCompanyId, input.paymentTerms, input.note, input.dueDateOffsetDays,
     input.numberPrefix, JSON.stringify(input.defaultLines ?? []), ctx.actorId],
  );
  await appendAudit(tx, ctx, {
    action: 'set', entityType: 'invoice_profile', entityId: ctx.clientCompanyId, before: null, after: input,
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/einvoice/invoice-profile.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add migrations/025_invoice_profiles.sql src/einvoice/invoice-profile.ts tests/einvoice/invoice-profile.test.ts
git commit -m "feat: invoice_profiles table + invoice-profile domain (G4 slice 3a)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Authz op + API routes

**Files:**
- Modify: `src/authz/policy.ts` (add `invoice_profile.write`)
- Modify: `tests/authz/policy.test.ts` (add to the matrix)
- Create: `web/app/api/invoice-profile/route.ts`

**Interfaces:**
- Consumes: `getInvoiceProfile`/`setInvoiceProfile` (Task 2); `resolveTenantContext`, `withTenant`; `assertRoleAllowed`, `errorToStatus` from `@/app/lib/authz`.
- Produces: operation `'invoice_profile.write'`; `GET /api/invoice-profile?clientCompanyId=` → `{ profile }`; `POST /api/invoice-profile` → `{ ok: true }`.

- [ ] **Step 1: Extend the authz policy + test**

In `src/authz/policy.ts`: add `'invoice_profile.write'` to the `Operation` union and to `OPERATION_ROLES` with value `['firm_admin', 'accountant']`.

In `tests/authz/policy.test.ts`: add `'invoice_profile.write': ['firm_admin', 'accountant'],` to the `MATRIX` object (the existing test iterates the matrix, so this adds coverage automatically).

- [ ] **Step 2: Run authz test**

Run: `npx vitest run tests/authz/policy.test.ts`
Expected: PASS (matrix now includes invoice_profile.write; firm_admin/accountant allowed, owner/employee/unknown denied).

- [ ] **Step 3: Create the route**

Create `web/app/api/invoice-profile/route.ts`:

```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { getInvoiceProfile, setInvoiceProfile, type InvoiceProfile } from '@domain/einvoice/invoice-profile.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const profile = await withTenant(ctx, (tx) => getInvoiceProfile(tx, ctx));
    return NextResponse.json({ profile }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string; profile?: InvoiceProfile };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.profile) return NextResponse.json({ error: 'missing profile' }, { status: 400 });
  const p = body.profile;
  // Validate.
  if (p.dueDateOffsetDays !== null && p.dueDateOffsetDays !== undefined &&
      (!Number.isInteger(p.dueDateOffsetDays) || p.dueDateOffsetDays < 0)) {
    return NextResponse.json({ error: 'invalid dueDateOffsetDays' }, { status: 400 });
  }
  if (!Array.isArray(p.defaultLines)) {
    return NextResponse.json({ error: 'invalid defaultLines' }, { status: 400 });
  }
  for (const l of p.defaultLines) {
    if (typeof l?.description !== 'string' || typeof l?.net !== 'string' || typeof l?.vatRate !== 'number') {
      return NextResponse.json({ error: 'invalid default line' }, { status: 400 });
    }
  }
  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'invoice_profile.write');
    await withTenant(ctx, (tx) => setInvoiceProfile(tx, ctx, {
      paymentTerms: p.paymentTerms?.trim() || null,
      note: p.note?.trim() || null,
      dueDateOffsetDays: p.dueDateOffsetDays ?? null,
      numberPrefix: p.numberPrefix?.trim() || null,
      defaultLines: p.defaultLines,
    }));
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
```

- [ ] **Step 4: Verify typecheck + HTTP smoke**

Run: `cd web && npx tsc --noEmit` (clean).
Then smoke against the running dev server ($J=/Users/karlis/.claude/jobs/5ea66caa/tmp):
```bash
AT=$(curl -s -c - "http://localhost:3000/api/dev/bootstrap" -o /dev/null | grep bk_session | awk '{print $7}')
CID=$(curl -s -b "bk_session=$AT" "http://localhost:3000/api/admin/clients" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).clients[0].id))")
curl -s -o /dev/null -w "accountant GET: %{http_code}\n" -b "bk_session=$AT" "http://localhost:3000/api/invoice-profile?clientCompanyId=$CID"   # 200
curl -s -o /dev/null -w "accountant POST: %{http_code}\n" -b "bk_session=$AT" -X POST "http://localhost:3000/api/invoice-profile" -H 'content-type: application/json' -d "{\"clientCompanyId\":\"$CID\",\"profile\":{\"paymentTerms\":\"Net 14\",\"note\":\"Thanks\",\"dueDateOffsetDays\":14,\"numberPrefix\":\"INV-\",\"defaultLines\":[]}}"   # 200
curl -s -o /dev/null -w "no-cookie GET: %{http_code}\n" "http://localhost:3000/api/invoice-profile?clientCompanyId=$CID"   # 401
```
Expected: 200 / 200 / 401. (employee/owner→403 on POST verified by the controller in Task 6.)

- [ ] **Step 5: Commit**

```bash
git add src/authz/policy.ts tests/authz/policy.test.ts web/app/api/invoice-profile/route.ts
git commit -m "feat(web): invoice_profile.write authz + GET/POST /api/invoice-profile (G4 slice 3a)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Composer wiring — apply profile defaults + send UBL fields

**Files:**
- Modify: `web/app/(cabinet)/invoices/new/page.tsx`

**Interfaces:**
- Consumes: `GET /api/invoice-profile`; the extended `EInvoice` (Task 1). The composer already builds an `invoice` object and POSTs `{ clientCompanyId, invoice, recipientPeppolId }` to `/api/einvoices`.

- [ ] **Step 1: Read the composer, then integrate**

Read `web/app/(cabinet)/invoices/new/page.tsx` fully. Make these additions (match the existing state/style):

1. Add state: `const [note, setNote] = useState('');` `const [paymentTerms, setPaymentTerms] = useState('');` `const [dueDate, setDueDate] = useState('');` and `const [offsetDays, setOffsetDays] = useState<number | null>(null);`.
2. In the load effect (where parties/company/rate are fetched), also `fetch('/api/invoice-profile?clientCompanyId='+encodeURIComponent(id))`. When a profile is returned, apply:
   - if `profile.numberPrefix` and `invoiceNumber` is empty → `setInvoiceNumber(profile.numberPrefix)`.
   - if `profile.defaultLines?.length` → seed `setLines(profile.defaultLines.map(l => ({ description: l.description, net: l.net, vatRate: l.vatRate })))`.
   - `setNote(profile.note ?? '')`, `setPaymentTerms(profile.paymentTerms ?? '')`, `setOffsetDays(profile.dueDateOffsetDays ?? null)`.
3. Compute due date from issueDate + offset: add an effect that, when `offsetDays !== null`, sets `dueDate` to `issueDate` + offset days (compute with `new Date(issueDate)`, add days, `.toISOString().slice(0,10)`). Keep it editable (user can override); recompute when `issueDate`/`offsetDays` change only if the user hasn't manually edited — simplest acceptable behavior: recompute on issueDate/offset change.
4. Add three form fields (near invoiceNumber/issueDate) — a date input bound to `dueDate`, and two text/textarea inputs bound to `note` and `paymentTerms` — each with a `t(...)`-labelled `<label>`.
5. In the `invoice` object built for the POST, add the optional fields when non-empty:
   ```ts
   ...(dueDate.trim() && { dueDate: dueDate.trim() }),
   ...(note.trim() && { note: note.trim() }),
   ...(paymentTerms.trim() && { paymentTerms: paymentTerms.trim() }),
   ```

Add i18n keys used here (`inv.note`, `inv.paymentTerms`, `inv.dueDate`) to all three catalogs (EN/LV/RU) — EN: 'Note' / 'Payment terms' / 'Due date'; LV: 'Piezīme' / 'Apmaksas nosacījumi' / 'Apmaksas termiņš'; RU: 'Примечание' / 'Условия оплаты' / 'Срок оплаты'.

- [ ] **Step 2: Verify typecheck + build**

Run: `cd web && npx tsc --noEmit && npm run build`
Expected: clean; build succeeds.

- [ ] **Step 3: Commit**

```bash
git add web/app/\(cabinet\)/invoices/new/page.tsx web/app/lib/i18n.ts
git commit -m "feat(web): invoice composer applies profile defaults + sends Note/Terms/DueDate (G4 slice 3a)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Settings UI — Invoice defaults form

**Files:**
- Create: `web/app/(cabinet)/settings/InvoiceDefaultsForm.tsx`
- Modify: `web/app/(cabinet)/settings/page.tsx` (render the form)
- Modify: `web/app/lib/i18n.ts` (settings.invoice.* strings)

**Interfaces:**
- Consumes: `GET/POST /api/invoice-profile`; the settings page's `clientCompanyId` (from `?client=`) and `useMessages`.
- Produces: `export function InvoiceDefaultsForm({ clientCompanyId }: { clientCompanyId: string })`.

- [ ] **Step 1: Add i18n strings**

In `web/app/lib/i18n.ts`, add to all three catalogs under `settings.invoice.*`:

EN: `'settings.invoice.title': 'Invoice defaults'`, `'settings.invoice.paymentTerms': 'Payment terms'`, `'settings.invoice.note': 'Note'`, `'settings.invoice.dueOffset': 'Due-date offset (days)'`, `'settings.invoice.prefix': 'Invoice-number prefix'`, `'settings.invoice.lines': 'Default line items'`, `'settings.invoice.addLine': 'Add line'`, `'settings.invoice.desc': 'Description'`, `'settings.invoice.net': 'Net'`, `'settings.invoice.vat': 'VAT %'`, `'settings.invoice.save': 'Save invoice defaults'`, `'settings.invoice.saved': 'Saved.'`, `'settings.invoice.error': 'Could not save invoice defaults.'`

LV: 'Rēķinu noklusējumi' / 'Apmaksas nosacījumi' / 'Piezīme' / 'Apmaksas termiņš (dienas)' / 'Rēķina numura prefikss' / 'Noklusējuma rindas' / 'Pievienot rindu' / 'Apraksts' / 'Neto' / 'PVN %' / 'Saglabāt' / 'Saglabāts.' / 'Neizdevās saglabāt.'

RU: 'Настройки счёта' / 'Условия оплаты' / 'Примечание' / 'Смещение срока оплаты (дни)' / 'Префикс номера счёта' / 'Строки по умолчанию' / 'Добавить строку' / 'Описание' / 'Нетто' / 'НДС %' / 'Сохранить' / 'Сохранено.' / 'Не удалось сохранить.'

- [ ] **Step 2: Create InvoiceDefaultsForm.tsx**

Create `web/app/(cabinet)/settings/InvoiceDefaultsForm.tsx` — a `'use client'` component that: on mount `GET /api/invoice-profile?clientCompanyId=`, populates local state (paymentTerms, note, dueDateOffsetDays, numberPrefix, defaultLines[]); renders textareas/inputs + an add/remove editor for default lines (description text, net decimal input, vatRate number); on Save, `POST /api/invoice-profile` with `{ clientCompanyId, profile: {...} }` (dueDateOffsetDays parsed via `Number(x) || null`, empty strings → null), shows a saved/error status. Reuse the settings page's CSS module classes (`import styles from './page.module.css'`) for `card`/`sectionHeading`/`formError`; add minimal inline structure. All labels via `t(...)`. Tabular numerals on the net input column.

- [ ] **Step 3: Wire into the settings page**

In `web/app/(cabinet)/settings/page.tsx` (read it first): import `InvoiceDefaultsForm`, and render `<InvoiceDefaultsForm clientCompanyId={clientCompanyId} />` after the autonomy `<section>` (inside the same authenticated/loaded branch where `clientCompanyId` is known and non-empty).

- [ ] **Step 4: Verify typecheck + build**

Run: `cd web && npx tsc --noEmit && npm run build`
Expected: clean; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add web/app/\(cabinet\)/settings/InvoiceDefaultsForm.tsx web/app/\(cabinet\)/settings/page.tsx web/app/lib/i18n.ts
git commit -m "feat(web): Invoice defaults form on /settings (G4 slice 3a)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Final verification gates

**Files:** none (verification only).

- [ ] **Step 1: Full backend suite (single vitest process)**

Run: `npm test`
Expected: all green (197 existing + 3 ubl + 3 profile + authz cases = ~203+).

- [ ] **Step 2: Typechecks + build**

Run: `npx tsc --noEmit` (root), `cd web && npx tsc --noEmit && npm run build`. All clean.

- [ ] **Step 3: Per-role HTTP smoke + UBL content check (controller)**

Confirm: GET profile (any assigned user) 200; POST as accountant 200, as employee/owner 403, no-cookie 401; then set a profile with a note/payment-terms/due-offset, compose+issue an invoice via `POST /api/einvoices` including those fields, and confirm the stored/returned UBL contains `cbc:DueDate`, `cbc:Note`, and `cac:PaymentTerms`.

- [ ] **Step 4: Update the audit-fixes handoff**

In `docs/HANDOFF-audit-fixes.md`, note **G4 slice 3a (invoice profile + UBL content)** shipped; slice 3b (branded renderer) + slice 4 (notification templates) remain.

- [ ] **Step 5: Commit**

```bash
git add docs/HANDOFF-audit-fixes.md
git commit -m "docs: mark G4 slice 3a (invoice profile + UBL content) shipped

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage:** RLS table (Task 2 migration); optional UBL fields emitted in EN 16931 order + backward-compat + round-trip (Task 1); domain upsert+audit+RLS isolation (Task 2); authz op + matrix (Task 3); tenant routes with write-gate + validation (Task 3); composer applies defaults + sends fields (Task 4); settings form (Task 5). All covered.
- **Backward-compat:** Task 1's `.filter(Boolean)` + conditional entries guarantee absent-field output is byte-identical; the explicit "omits when absent" test guards it; the full suite (Task 6) confirms `validate`/`inbound`/`outbound` still pass.
- **Types:** `EInvoice` optional fields (Task 1) consumed by the composer (Task 4) and unchanged einvoices route (passes `body.invoice` through). `InvoiceProfile` shape (Task 2) ↔ route (Task 3) ↔ form/composer (Tasks 4-5) consistent. `'invoice_profile.write'` (Task 3) used by the POST route.
- **Money:** `default_lines[].net` decimal strings end-to-end; `dueDateOffsetDays` integer; no floats.
- **RLS** (new vs slices 1-2's no-RLS) guarded by the per-client isolation test in Task 2.
