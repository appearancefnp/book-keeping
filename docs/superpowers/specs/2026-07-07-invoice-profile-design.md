# G4 Slice 3a — Per-client invoice profile + UBL content: design

Date: 2026-07-07. Part of gap **G4** (spec §5 — firm administrator manages clients,
tariffs, permissions, **templates**). Slices 1 (tariffs) and 2 (onboarding templates)
shipped. This slice is the **invoice/document template** work, decomposed:

- **Slice 3a (this spec):** a per-client **invoice profile** of content defaults that
  pre-fill the composer AND thread into the real UBL invoice (Note / PaymentTerms /
  DueDate).
- **Slice 3b (next spec):** a branded, human-readable HTML invoice document
  (server-rendered, print-to-PDF) with logo (uploaded to the existing blob store) and
  footer, using the profile.

Later G4 slice: (4) notification/email templates.

## Decisions (from the brainstorm)

- **No PDF/branding renderer exists** and the invoice model is UBL-only. So 3a delivers
  content defaults that become **real invoice content** (not cosmetic); branding/render
  is 3b.
- **Shape:** one **per-client invoice-defaults record** (not a named-template library),
  auto-applied in the composer.
- **Fields:** payment terms text, note text, due-date offset (days), invoice-number
  prefix, default line items.
- **Real UBL content:** the note, payment terms, and a computed due date are emitted into
  the UBL invoice (EN 16931 / Peppol BIS), not just shown in the UI.
- **Render tech / logo (for 3b, recorded):** server-rendered branded HTML, print-to-PDF;
  logo uploaded to the existing `LocalBlobStore`.

## Data model — `migrations/025_invoice_profiles.sql`

Genuine per-client tenant data (the client's own invoice settings, read by whoever
composes that client's invoices), so **RLS-enabled** like `accounts` / `autonomy_policy`
— NOT the firm-admin no-RLS pattern used by tariffs/onboarding templates.

```sql
CREATE TABLE invoice_profiles (
  client_company_id     uuid PRIMARY KEY REFERENCES client_companies(id),
  payment_terms         text,
  note                  text,
  due_date_offset_days  integer,            -- e.g. 14 → DueDate = issueDate + 14
  number_prefix         text,               -- e.g. 'INV-2026-'
  default_lines         jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{description,net,vatRate}]
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

- `PRIMARY KEY (client_company_id)` → exactly one profile per client; `setInvoiceProfile`
  upserts on it.
- `default_lines` money as cent-safe decimal strings (matching `InvoiceLineIn.net`);
  `vatRate` a number. Never floats for money.
- RLS mirrors `accounts` (`ENABLE` + `FORCE` + tenant policy).

## UBL threading — `src/einvoice/ubl.ts`

Extend `EInvoice` with three **optional** fields:
```ts
export interface EInvoice {
  invoiceNumber: string; issueDate: string; currency: string;
  supplier: InvoiceParty; customer: InvoiceParty; lines: InvoiceLineIn[];
  netTotal: string; vatTotal: string; grandTotal: string;
  dueDate?: string;        // YYYY-MM-DD
  note?: string;
  paymentTerms?: string;
}
```

`buildUblInvoice` emits each **only when present**, in correct UBL 2.1 / EN 16931
sequence:
- `cbc:DueDate` — immediately after `cbc:IssueDate`.
- `cbc:Note` — after `cbc:DueDate`, before `cbc:DocumentCurrencyCode`.
- `cac:PaymentTerms` (`<cac:PaymentTerms><cbc:Note>…</cbc:Note></cac:PaymentTerms>`) —
  after the customer party (`AccountingCustomerParty`), before `cac:TaxTotal`.

All three are `escapeXml`'d. **Backward-compatible:** when the fields are absent, the
emitted XML is byte-identical to today (the new lines are conditionally joined in), so
existing `ubl`/`validate`/`inbound`/`outbound` tests stay green.

`parseUblInvoice` reads them back into the optional fields (`inv.DueDate`, `inv.Note`,
`inv.PaymentTerms?.Note`); absent → field omitted/undefined.

`validate.ts` (EN 16931) is unchanged — the three are optional, so no new required-field
rule; the existing validation must still pass.

## Domain — `src/einvoice/invoice-profile.ts`

```ts
export interface InvoiceProfileLine { description: string; net: string; vatRate: number }
export interface InvoiceProfile {
  paymentTerms: string | null;
  note: string | null;
  dueDateOffsetDays: number | null;
  numberPrefix: string | null;
  defaultLines: InvoiceProfileLine[];
}
export async function getInvoiceProfile(tx, ctx): Promise<InvoiceProfile | null>;
export async function setInvoiceProfile(tx, ctx, input: InvoiceProfile): Promise<void>;
```
Per-client `(tx, ctx)` run inside `withTenant`; `setInvoiceProfile` upserts on
`client_company_id` (`ON CONFLICT DO UPDATE`, `updated_by = ctx.actorId`) and
`appendAudit(action:'set', entityType:'invoice_profile', entityId: ctx.clientCompanyId)`.

## Authorization

Add to the G1 policy (`src/authz/policy.ts`) a new operation:
`'invoice_profile.write': ['firm_admin', 'accountant']` (settings-level config, same set
as `periods.write` / `autonomy.write`). Reads are open to any assigned tenant user (the
composer must read the profile to apply defaults).

## API — per-client tenant routes (not admin)

Follow the per-client pattern (`resolveTenantContext`), like `/api/periods`:
- **`GET /api/invoice-profile?clientCompanyId=`** → `getSessionToken` →
  `resolveTenantContext` → `withTenant(getInvoiceProfile)` → `{ profile }` (null if unset).
  No role gate (tenant read).
- **`POST /api/invoice-profile`** → `resolveTenantContext` →
  `assertRoleAllowed(ctx.actorRole, 'invoice_profile.write')` →
  `withTenant(setInvoiceProfile)` → `{ ok: true }`. Body validated: `dueDateOffsetDays`
  a non-negative integer or null; `defaultLines` an array of `{description, net, vatRate}`
  with cent-safe `net`; strings trimmed. Errors via `errorToStatus`.

## Composer wiring — `web/app/(cabinet)/invoices/new/page.tsx`

On load (alongside the existing parties/company/rate fetch), `GET /api/invoice-profile`.
Apply:
- Pre-fill `invoiceNumber` with `number_prefix` (user appends the running number).
- Seed the lines editor from `default_lines` when the profile has them (replacing the
  single empty starter line).
- Add three editable fields — **note**, **payment terms**, **due date** — pre-filled from
  the profile (`dueDate` = `issueDate + due_date_offset_days`, recomputed when issueDate
  changes; blank if no offset). All editable per invoice.
- Include `note`, `paymentTerms`, `dueDate` (when non-empty) in the `EInvoice` POSTed to
  `/api/einvoices` → they flow through `sendInvoice` → `buildUblInvoice` into the UBL.

## UI — `/settings` (`web/app/(cabinet)/settings/page.tsx`)

Add an **"Invoice defaults"** section to the existing per-client settings page (which
already has accounting periods + autonomy). A form: payment terms (textarea), note
(textarea), due-date offset (number), invoice-number prefix (text), and a small
add/remove editor for default line items (description / net / VAT rate). Loads via
`GET /api/invoice-profile`, saves via `POST`. Gated in the UI to accountant/firm_admin
(matches the rest of `/settings`); the POST route enforces it server-side regardless.
New user-facing strings in EN/LV/RU (typed `Record<keyof typeof EN>` — missing key fails
the build). No tracked-uppercase; tabular numerals for money.

## Data flow

```
/settings → GET /api/invoice-profile → form
          → POST /api/invoice-profile (accountant/firm_admin) → upsert + audit
/invoices/new → GET /api/invoice-profile → pre-fill number prefix, default lines,
                note/terms/due-date fields
              → POST /api/einvoices {invoice:{…,note,paymentTerms,dueDate}} → sendInvoice
              → buildUblInvoice emits cbc:DueDate, cbc:Note, cac:PaymentTerms
```

## Testing

- **UBL** (`tests/einvoice/ubl.test.ts` additions): build+parse round-trip WITH the three
  fields (assert the elements appear in the right place and parse back); build WITHOUT
  them produces XML identical to the pre-change output (backward-compat); a full-suite run
  confirms `validate`/`inbound`/`outbound` still pass.
- **invoice-profile domain** (`tests/einvoice/invoice-profile.test.ts`, real Postgres):
  `setInvoiceProfile` upserts (second set overwrites, not duplicates) + writes an audit
  row; `getInvoiceProfile` returns null when unset and the stored value otherwise; RLS
  isolation — a second client's context cannot read the first client's profile.
- **authz** (`tests/authz/policy.test.ts` addition): `invoice_profile.write` allows
  firm_admin/accountant, denies owner/employee/unknown.
- **HTTP smoke** (per-role): GET profile (any assigned user) 200; POST as accountant 200,
  as employee/owner 403, no-cookie 401; then issue an invoice through the composer path
  and confirm the returned/stored UBL contains `cbc:DueDate`, `cbc:Note`,
  `cac:PaymentTerms`.
- **Gates:** full backend suite green (single vitest process — never concurrent), root +
  web `tsc --noEmit` clean, web `npm run build` clean.

## Out of scope

- Slice 3b: branded HTML/PDF invoice document, logo upload, footer.
- Invoice-number **auto-sequencing** (prefix pre-fill only; no server counter).
- Multiple named invoice templates (one profile per client).
- New EN 16931 *validation* rules for the optional fields (they're optional).

## Follow-ups (noted, not built)

1. Slice 3b renderer consumes this profile (+ adds logo/footer columns via a later
   migration).
2. Invoice-number sequencing (a per-client counter) if prefix-only proves insufficient.
