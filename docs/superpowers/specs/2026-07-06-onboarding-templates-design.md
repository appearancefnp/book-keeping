# G4 Slice 2 — Onboarding templates + Add-client flow: design

Date: 2026-07-06. Second slice of gap **G4** (spec §5 — the firm administrator manages
clients, tariffs, permissions, **templates**). Slice 1 (per-client tariffs) shipped;
this slice adds **client-onboarding templates** and, because there is no client-creation
flow in the app yet, the **admin "Add client" flow** that applies a template on create.

G4's remaining slices after this: (3) invoice/document templates, (4) notification/email
templates — each its own spec.

## Decisions (from the brainstorm)

- **Application point:** build an admin **"Add client"** flow; a template is applied **on
  create** (to the brand-new, empty client — so there are no existing rows to reconcile).
  There is no apply-to-existing-client path this slice.
- **Template bundles all three:** default chart of accounts + default autonomy policies +
  assigned tariff (tariff optional per template).
- **Authoring = snapshot an existing client:** "Save as template" captures a client's
  current accounts + autonomy + tariff into a named template. No chart-of-accounts editor
  is built; corrections are a re-snapshot. No in-form body editing this slice.
- **Storage:** a single firm-scoped table with a `jsonb` body (not normalized child
  tables) — a template is applied wholesale as a config bundle.
- **Auto-assign the creator:** `createClientFromTemplate` assigns the creating user to the
  new client via `assignUserToClient`, so the client is immediately usable (otherwise no
  one is assigned and its per-client cabinet can't be opened).
- **RLS posture:** `onboarding_templates` has **no RLS** (firm-admin cross-client data),
  filtered by `firm_id` in every path — same posture as `client_tariffs` / the rest of
  `/admin`.
- **Authorization:** writes (create client, save template) = **`firm_admin` only**; reads
  (list templates) = `accountant` **or** `firm_admin`. Matches slice 1.

## Data model — `migrations/024_onboarding_templates.sql`

```sql
CREATE TABLE onboarding_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id     uuid NOT NULL REFERENCES firms(id),
  name        text NOT NULL,
  body        jsonb NOT NULL,        -- see shape below
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,                   -- actor user id
  UNIQUE (firm_id, name)
);
CREATE INDEX onboarding_templates_firm_idx ON onboarding_templates(firm_id);

GRANT SELECT, INSERT ON onboarding_templates TO bookkeeping_app;
```

`body` shape (money as integer-cents strings inside the JSON):
```json
{
  "accounts":  [ { "code": "2310", "name": "…", "type": "liability" }, … ],
  "autonomy":  [ { "operationType": "posting", "mode": "approval", "materialThresholdCents": "100000" }, … ],
  "tariff":    { "monthlyAmountCents": "150000", "currency": "EUR", "vatRate": "21" }  // or null
}
```

- **No RLS** (firm-admin cross-client data); correctness relies on the `firm_id` filter in
  every path. Grants `SELECT, INSERT` (append-only; a re-snapshot under the same name is a
  new template unless the name collides — see below). App DB role `bookkeeping_app`.
- **Name collision:** `UNIQUE(firm_id, name)` — snapshotting to an existing name returns a
  409 (via `errorToStatus`), so the admin picks a new name. (No upsert this slice.)

## Domain — `src/onboarding/templates.ts`

- `snapshotClientAsTemplate(tx, ctx, name: string): Promise<{ id: string }>`
  Runs inside `withTenant(ctx)` for the source client. Reads `listAccounts(tx, ctx)`,
  `listAutonomyPolicies(tx, ctx)`, `getCurrentTariff(tx, ctx, asOf)`; assembles `body`
  (accounts → `{code,name,type}`; autonomy → `{operationType,mode,materialThresholdCents}`;
  tariff → `{monthlyAmountCents,currency,vatRate}` or null); inserts the template row
  (`created_by = ctx.actorId`); `appendAudit(action:'snapshot', entityType:'onboarding_template', entityId:id)`.
  Returns `{id}`.
- `listTemplatesForFirm(firmId: string): Promise<TemplateSummary[]>`
  Firm-scoped (`appPool`). Returns `{ id, name, accountCount, policyCount, hasTariff }`
  (counts derived from `body` via `jsonb_array_length` / `body ? 'tariff'`).
- `getTemplateBody(firmId: string, id: string): Promise<TemplateBody | null>`
  Firm-scoped fetch of one template's `body` (used by create-from-template). Returns
  `null` when the id is absent or belongs to another firm; the route maps `null` to a
  **400 `unknown template`** (does not leak cross-firm existence).
- `createClientFromTemplate(firmId, input: { name; regNo; baseCurrency? }, templateId: string | null, actorId: string): Promise<ClientCompany>`
  1. `createClientCompany(firmId, input)` (existing, `appPool`).
  2. `assignUserToClient(actorId, client.id)` (existing) — auto-assign the creator.
  3. If `templateId`: `getTemplateBody(firmId, templateId)` (null → route returns 400
     `unknown template`), then
     `withTenant(ctxForNewClient)` → for each account `createAccount`; for each autonomy
     `setAutonomy`; if tariff, `setTariff`; then `appendAudit(action:'create_from_template', entityType:'client_company', entityId:client.id, after:{templateId})`.
  4. Return the `ClientCompany`.

Types: `TemplateBody`, `TemplateSummary`. `ctxForNewClient = { firmId, clientCompanyId: client.id, actorId, actorRole }` (constructed like the tariffs POST route; the creator's role is `firm_admin`).

## API — extend `web/app/api/admin/`

All follow the admin route pattern (`validateSession` → role gate → firm-scoped;
`errorToStatus`, 401-no-token first), like slice 1.

- **`POST /api/admin/clients`** (GET already lists) — **`firm_admin` only**. Body
  `{ name, regNo, baseCurrency?, templateId? }`. Validate name/regNo non-empty, currency 3
  letters if present. If `templateId` present, it must belong to the firm (the domain's
  `getTemplateBody` returns null otherwise → 400 `unknown template`). Calls
  `createClientFromTemplate(session.firmId, …, templateId ?? null, session.userId)`. → 201
  `{ client }`.
- **`GET /api/admin/templates`** — read gate (`accountant`|`firm_admin`) →
  `listTemplatesForFirm(session.firmId)` → `{ templates, role }`.
- **`POST /api/admin/templates`** — **`firm_admin` only**. Body `{ clientCompanyId, name }`.
  Firm-scoping check on `clientCompanyId` (`SELECT 1 FROM client_companies WHERE id=$1 AND
  firm_id=$2`; else 403 `client not in firm`). Construct `ctx` for that client →
  `withTenant(ctx, tx => snapshotClientAsTemplate(tx, ctx, name))`. → 201 `{ id }`.

## UI — extend `/admin` (`web/app/(cabinet)/admin/page.tsx`)

Two new firm-admin sections (accountant sees them read-only — no action controls):

- **Add client** form: name, reg-no, currency (default `EUR`), and an optional template
  `<select>` populated from `GET /api/admin/templates`. Submit → `POST /api/admin/clients`
  → refetch the admin data (the new client appears in the clients/tariffs tables).
- **Templates**: a list (name + "N accounts · M policies · tariff ✓/–"), and a **Save as
  template** control (a client `<select>` + a name field) → `POST /api/admin/templates` →
  refetch. Reuses the tariff-fetch/`role` gating pattern from slice 1.

New user-facing strings in EN/LV/RU in `web/app/lib/i18n.ts` (typed
`Record<keyof typeof EN>` — a missing key fails the build). No tracked-uppercase labels;
tabular numerals where counts/money appear.

## Data flow

```
Save as template:  admin → POST /api/admin/templates {clientCompanyId,name}
                     → withTenant(client): read accounts+autonomy+tariff → insert template (audited)
Add client:        admin → POST /api/admin/clients {name,regNo,baseCurrency,templateId?}
                     → createClientCompany → assignUserToClient(creator)
                     → if template: withTenant(newClient): createAccount×, setAutonomy×, setTariff (audited)
List:              admin → GET /api/admin/templates → {templates, role}
```

## Testing

- **Domain** (`tests/onboarding/templates.test.ts`, Vitest vs real Postgres):
  - `snapshotClientAsTemplate` captures a client's accounts + autonomy + tariff into `body`
    (assert body shape/counts), and audits.
  - `createClientFromTemplate` with a template → new client has exactly those accounts
    (by code), autonomy policies, and tariff; and the creator is assigned
    (`user_client_assignments` row exists).
  - `createClientFromTemplate` with `null` template → bare client, creator assigned, no
    accounts.
  - Firm isolation: `getTemplateBody(firmB, templateFromFirmA)` → null (guards no-RLS);
    `listTemplatesForFirm` returns only the firm's templates.
- **HTTP smoke** (per-role): `firm_admin` POST /api/admin/clients (+templateId) → 201 and a
  follow-up read shows the seeded accounts; POST /api/admin/templates → 201; `GET
  /api/admin/templates` → 200 with counts; `accountant` POST either → 403; cross-firm
  `clientCompanyId`/`templateId` → 403/400; no cookie → 401.
- **Gates:** full backend suite green (single vitest process — never concurrent), root +
  web `tsc --noEmit` clean, web `npm run build` clean.

## Out of scope

- In-form editing of a template `body` (authoring is snapshot-only; correct via
  re-snapshot under a new name).
- Apply-a-template-to-an-existing-client (only apply-on-create).
- Deleting/renaming templates.
- G4 slices 3 (invoice/document templates) and 4 (notification/email templates).

## Follow-ups (noted, not built)

1. Template editing/deletion once snapshot-only proves limiting.
2. Apply-to-existing-client provisioning (needs idempotent conflict handling on accounts).
3. Assignment management UI (this slice only auto-assigns the creator; assigning other
   firm users to a client is a separate gap).
