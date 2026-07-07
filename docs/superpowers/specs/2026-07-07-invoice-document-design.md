# G4 Slice 3b — Branded invoice document renderer: design

Date: 2026-07-07. Completes the invoice/document-template arc of gap **G4** (spec §5).
Slice 3a shipped the per-client `invoice_profiles` record (payment terms, note, due-date
offset, number prefix, default lines) + threaded Note/PaymentTerms/DueDate into the UBL.
This slice renders a **branded, human-readable invoice document** from an issued invoice,
using the profile for logo + footer.

Remaining G4 slice after this: (4) notification/email templates.

## Decisions (from the brainstorm)

- **Render tech:** server-rendered branded **HTML** the user prints/saves as PDF via the
  browser (no PDF dependency), decided in the slice-3 brainstorm.
- **Logo:** uploaded to the existing `LocalBlobStore` (base64 JSON POST, same pattern as
  `/api/documents/capture`), embedded in the document as an inline **data URI**.
- **Footer:** free text on the profile.
- **Document home:** a Next.js **page route** that is **standalone** — outside the
  `(cabinet)` route group so it does NOT inherit the AppShell chrome (a clean print
  surface). Path: `/invoice-document/[id]?client=<cid>&lang=<lv|ru|en>`. Auth is still
  enforced (requireSession + resolveTenantContext).
- **Data source:** parse the **stored UBL** (`parseUblInvoice`) for invoice content — it
  already carries note/paymentTerms/dueDate from slice 3a — plus the profile for branding.

## Profile schema extension — `migrations/026_invoice_profile_branding.sql`

Add two nullable columns to the existing (RLS-enabled) `invoice_profiles`:
```sql
ALTER TABLE invoice_profiles ADD COLUMN logo_blob_key text;
ALTER TABLE invoice_profiles ADD COLUMN footer text;
```
No new grants/policy (the table already has RLS + `SELECT, INSERT, UPDATE`). The row holds
only the blob **key**; the image bytes live in the blob store.

Extend `InvoiceProfile` (src/einvoice/invoice-profile.ts) with `logoBlobKey: string | null`
and `footer: string | null`; `getInvoiceProfile` selects them; `setInvoiceProfile` upserts
them. **Important:** slice 3a's settings form POSTs the full profile — `setInvoiceProfile`
must NOT clobber `logo_blob_key` when the caller omits it. Resolution: the logo key is set
**only** by the logo-upload route (below); `setInvoiceProfile` preserves the existing
`logo_blob_key` unless explicitly provided. Implement by making the column update in the
upsert conditional (`COALESCE(EXCLUDED.logo_blob_key, invoice_profiles.logo_blob_key)`),
and have the profile POST route pass `logoBlobKey: undefined` (→ SQL null → COALESCE keeps
the old value). `footer` IS part of the profile form, so it is set normally.

## Logo upload — `web/app/api/invoice-profile/logo/route.ts`

`POST` (per-client tenant route; `assertRoleAllowed(ctx.actorRole, 'invoice_profile.write')`):
body `{ clientCompanyId, bytesBase64, mime }`. Validates `mime` starts with `image/` and
the decoded size is within a sane cap (e.g. ≤ 1 MB). `blob.put(key, bytes, mime)` with a
deterministic key `invoice-logo/<clientCompanyId>` (re-upload overwrites), then persist
`logo_blob_key = key` on the profile (a targeted domain call `setInvoiceLogo(tx, ctx, key)`
that updates just that column + upserts a row if none exists, and `appendAudit`). Blob via
`new LocalBlobStore(process.env.BLOB_DIR ?? '.blob-store')` (mirrors
`/api/documents/capture`). Errors via `errorToStatus`. Returns `{ ok: true }`.

## Einvoice UBL getter — `src/einvoice/query.ts`

Add `getEinvoiceUbl(tx, ctx, id): Promise<{ invoiceNumber: string; ublXml: string } | null>`
— RLS-scoped `SELECT invoice_number, ubl_xml FROM einvoices WHERE id = $1 AND
client_company_id = $2` (bounded to the tenant; `listEinvoices` omits `ubl_xml`). Returns
null when not found.

## Render helper — `src/einvoice/invoice-html.ts` (pure, testable)

`renderInvoiceHtml(inv: EInvoice, opts: { footer: string | null; logoDataUri: string | null; lang: Lang }): string`
— a pure function returning a **self-contained HTML fragment** (a single `.invoice-doc`
wrapper `<div>` containing a scoped `<style>` block + the markup), NOT a full
`<html>`/`<head>` document — so the page can inject it via `dangerouslySetInnerHTML`
without nesting a document. Kept in the domain (no React, no I/O) so it is unit-testable
without a browser and keeps the page thin. It:
- escapes all interpolated text (reuse `escapeXml` / a small HTML-escape),
- shows header (logo `<img src=dataUri>` when present, "INVOICE" + number + issue/due date),
- supplier + customer blocks,
- a line table (description · net · VAT % · line VAT computed cent-safe from net×rate),
- totals (net/VAT/grand) in `inv.currency`,
- note + payment terms when present, footer when present,
- inline `<style>` including `@media print` (hide the print button, clean margins) so
  browser print → "Save as PDF" yields a clean page. Money formatted with the existing
  `formatDecimal`/cent-safe helpers; tabular numerals.

Localised labels (Invoice, From, Bill to, Net, VAT, Total, Due, Note, Terms) via the `lang`
param — the domain helper takes a small label map (passed in from the page using the app's
i18n) OR a minimal built-in EN/LV/RU label set inside the helper. Decision: **built-in
label map inside the helper** keyed by `lang` (keeps the pure function self-contained;
avoids threading the web i18n into the domain). The three label sets live beside the helper.

## Document page — `web/app/invoice-document/[id]/page.tsx` (standalone, no cabinet shell)

A **server component** OUTSIDE the `(cabinet)` group (so only the root layout applies — no
AppShell): `requireSession()` → read `id` (route param) + `client` + `lang` (search params;
`lang` validated ∈ `lv|ru|en`, default `lv`) → `resolveTenantContext(token, client,
nowUnix())` → `withTenant`: `getEinvoiceUbl(tx, ctx, id)` (not-found state if null) →
`parseUblInvoice(ublXml)` → `EInvoice`; `getInvoiceProfile(tx, ctx)` → footer + `logoBlobKey`.
If a logo key exists, `blob.get(key)` → `data:${mime};base64,${bytes.toString('base64')}`
(guard blob-missing → render without a logo). Call
`renderInvoiceHtml(einvoice, { footer, logoDataUri, lang })` → inject the returned fragment
via `dangerouslySetInnerHTML`, alongside a small client `PrintButton` component
(`window.print()`); the fragment's scoped `@media print` hides the button. Because the page
is standalone there is no app chrome to hide.

Access is tenant-scoped (any assigned user of that client can view/print). Wrong/foreign
`id` (or one from another tenant) → `getEinvoiceUbl` returns null → a "not found" state.

## Outbox link — `web/app/(cabinet)/invoices/page.tsx`

Add a **View / Print** link on each outbound invoice row →
`/invoice-document/<id>?client=<activeClientId>&lang=<active UI lang>` (opens the standalone
document page; the outbox has the active client via `?client=` and the UI language via
`useMessages`). Open in a new tab (`target="_blank"`) so the outbox is preserved.

## Settings — logo + footer — extend slice-3a `InvoiceDefaultsForm`

Add to the "Invoice defaults" form: a **footer** textarea (part of the profile POST) and a
**logo** file input that previews the current logo and, on select, base64-encodes and POSTs
to `/api/invoice-profile/logo`, then refreshes. Gated to accountant/firm_admin (form is
already). New i18n strings in EN/LV/RU.

## Data flow

```
/settings → logo file → POST /api/invoice-profile/logo → blob.put + logo_blob_key (audited)
          → footer via existing POST /api/invoice-profile (COALESCE keeps logo)
/invoices  → "View / Print" (new tab) → /invoice-document/<id>?client=<cid>&lang=<lang>
document page (standalone server component): getEinvoiceUbl → parseUblInvoice → EInvoice
                        getInvoiceProfile → footer + logoBlobKey → blob.get → data URI
                        renderInvoiceHtml(einvoice, {footer, logoDataUri, lang}) → print-ready HTML
```

## Testing

- **Domain — `renderInvoiceHtml`** (pure, no DB/browser): given an EInvoice (with
  note/paymentTerms/dueDate) + footer + a logo data URI, the HTML contains the invoice
  number, both party names, every line description, the totals, note, payment terms,
  footer, and an `<img src="data:...">`; with `logoDataUri: null` there is no `<img>`;
  all interpolated text is escaped (pass a name containing `<` and assert it's escaped).
- **Domain — `getEinvoiceUbl`** (real Postgres): returns `{invoiceNumber, ublXml}` for an
  issued invoice; null for a missing id; RLS isolation (another client's ctx can't read it).
- **Domain — profile logo** (real Postgres): `setInvoiceLogo` persists the key + audits;
  `setInvoiceProfile` with `logoBlobKey: undefined` does NOT clobber an existing key
  (COALESCE), while `footer` updates normally.
- **HTTP smoke** (per-role): logo upload accountant 200 / employee 403 / no-cookie 401;
  then GET `/invoice-document/<id>?client=<cid>&lang=lv` 200 and confirm the response HTML
  contains the invoice number, a party name, the footer, and (after upload) an
  `<img src="data:image` tag; a foreign/absent id → not-found.
- **Gates:** full backend suite green (single vitest process), root + web `tsc --noEmit`
  clean, web `npm run build` clean.

## Out of scope

- Real server-side PDF file generation (HTML + browser print, per the earlier decision).
- Multiple document themes / configurable colours.
- Emailing or attaching the PDF; storing a rendered snapshot.
- Slice 4 (notification/email templates).

## Follow-ups (noted, not built)

1. A true PDF export (headless render) if browser-print proves insufficient.
2. Rendering inbound invoices too (this slice targets outbound issued invoices).
