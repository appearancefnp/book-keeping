# Handoff — audit fixes (next session)

Written 2026-07-05, after the MVP-UI pass. This is the **actionable worklist** for the
next session: fix the gaps the coverage audit surfaced. It excludes the two
externally-blocked buckets (live Peppol delivery, real VID/EDS filing) — those wait on
provider + accountant decisions (see `HANDOFF.md` §1/§2 and §"First decisions"), not on us.

> **Progress 2026-07-06 (this session):** ✅ **G1** (route-level role gating —
> `src/authz/policy.ts` matrix + `assertRoleAllowed` wired into periods/autonomy/bank/
> einvoice/parties routes), ✅ **G2** (uniform `errorToStatus` in `web/app/lib/authz.ts`;
> duplicate party now 409 not 403), ✅ **G6** (LR public-holiday calendar —
> `src/einvoice/holidays.ts` threaded into `addWorkingDays`), and ✅ **all Priority-3
> cosmetics** (removed 5 unused i18n keys, disabled bank file input mid-import, parties
> `kind` enum validated at the route). Commits `fa3ea74`, `6de4df0`, `626a45c`. Full
> suite 185/185; root+web typecheck clean; G1/G2 verified end-to-end via per-role HTTP
> smoke on the dev server.
>
> **Update 2026-07-06:** ✅ **G3** (owner-calm view) shipped via subagent-driven plan
> `docs/superpowers/plans/2026-07-06-owner-calm-view.md`: dedicated OwnerHome at `/`
> (role-branch), curated owner nav (Home/Documents/Notifications), material-approvals
> query (`src/proposals/material.ts`) + `GET /api/proposals/material`. Owner approves
> material items (≥ autonomy threshold ∪ declarations) inline. Full suite 189/189;
> root+web typecheck + web build clean; per-role HTTP smoke verified (owner→OwnerHome +
> 3-item nav + approve cycle; accountant→queue unchanged). **Recorded follow-up:**
> server-side page-read gating for the owner (an owner can still type `/journal`; nav
> hiding is calm-by-default, not access control — mutations are already G1-gated).
> **G4** (tariffs & templates) is specced next (decisions captured: per-client monthly
> retainer; onboarding + invoice/document + notification templates).
>
> **Update 2026-07-06 (cont.):** ✅ **G4 slice 1 — per-client tariffs** shipped via
> subagent-driven plan `docs/superpowers/plans/2026-07-06-tariffs.md` (spec
> `docs/superpowers/specs/2026-07-06-tariffs-design.md`). New `client_tariffs` table
> (effective-dated, VAT + currency, **no RLS** — firm-scoped like the rest of `/admin`,
> cross-firm isolation unit-tested), `src/tariffs/tariffs.ts` domain, `GET/POST
> /api/admin/tariffs` (read = accountant/firm_admin; **write = firm_admin only**;
> firm-scoping check before write), and a tariff table + inline edit form on `/admin`.
> Store-rate-only (no invoice/posting/billing). Full suite 193/193; root+web typecheck +
> web build clean; per-role HTTP smoke verified (firm_admin GET 200 / POST 201 / GET
> reflects rate / cross-firm 403 / negative 400; accountant GET 200 / POST 403; no-cookie
> 401).
>
> **Update 2026-07-07:** ✅ **G4 slice 2 — onboarding templates + Add-client flow**
> shipped via subagent-driven plan `docs/superpowers/plans/2026-07-06-onboarding-templates.md`
> (spec `docs/superpowers/specs/2026-07-06-onboarding-templates-design.md`). New
> `onboarding_templates` table (jsonb body, **no RLS**, firm-scoped, cross-firm isolation
> unit-tested), `src/onboarding/templates.ts` (`snapshotClientAsTemplate`,
> `listTemplatesForFirm`, `getTemplateBody`, `createClientFromTemplate` — creates a client,
> auto-assigns the creator, seeds accounts+autonomy+tariff from the template), `GET/POST
> /api/admin/templates` + `POST /api/admin/clients` (the previously-missing Add-client
> flow), and an OnboardingPanel on `/admin` (Add-client form + Save-as-template + list;
> firm_admin writes, accountant reads). Snapshot-only authoring; apply-on-create only.
> Full suite 197/197; root+web typecheck + web build clean; per-role HTTP smoke verified
> (firm_admin snapshot 201 → template captured 2 accounts → create-from-template 201 →
> new client seeded with the same accounts; unknown-template 400; cross-firm 403;
> accountant POST 403; no-cookie 401). **Review caught & fixed:** an implementer had
> polluted production `createClientFromTemplate` with dummy-user creation to satisfy a
> flawed test (reverted; test now uses a real user); and a stale client-select default
> that blocked the create-first-client→snapshot flow.
> **G4 remaining slices (each own spec→plan→build):** (3) invoice/document templates,
> (4) notification/email templates. **Still open:** credit notes, G5 (2FA enrolment),
> WCAG automated check.
>
> **Update 2026-07-07 (cont.):** ✅ **G4 slice 3a — per-client invoice profile + UBL
> content** shipped via subagent-driven plan `docs/superpowers/plans/2026-07-07-invoice-profile.md`
> (spec `docs/superpowers/specs/2026-07-07-invoice-profile-design.md`). A per-client
> invoice-defaults record (payment terms, note, due-date offset, number prefix, default
> lines) that (a) pre-fills the composer and (b) threads **Note / PaymentTerms / DueDate**
> into the real UBL. New `invoice_profiles` table — **RLS-enabled** (this IS per-client
> tenant data, unlike the firm-admin no-RLS slices 1–2; genuine RLS isolation now tested
> via an unfiltered cross-tenant query). `src/einvoice/invoice-profile.ts` domain;
> extended `EInvoice`/`buildUblInvoice`/`parseUblInvoice` (optional fields, emitted only
> when present → absent output byte-identical, backward-compatible); new
> `invoice_profile.write` authz op (firm_admin/accountant); `GET/POST /api/invoice-profile`
> (per-client tenant routes); composer applies defaults + sends the fields; "Invoice
> defaults" form on `/settings`. Full suite 207/207; root+web typecheck + web build clean;
> per-role HTTP smoke verified (accountant GET/POST 200; employee/owner POST 403; employee
> GET 200 read-open; no-cookie 401; profile round-trips) AND a real end-to-end issue →
> the stored UBL contains `cbc:DueDate`, `cbc:Note`, `cac:PaymentTerms`. **Reviews caught
> & fixed:** a weak RLS test that didn't exercise RLS (strengthened to an unfiltered
> cross-tenant query), and a 0-day due-offset silently becoming "no due date" (`0 || null`
> → now preserves explicit 0). **G4 remaining:** slice 3b (branded HTML/PDF invoice
> renderer + logo/footer — render tech decided: server-rendered branded HTML, print-to-PDF,
> logo via blob store), slice 4 (notification/email templates). **Still open:** credit
> notes, G5 (2FA enrolment), WCAG check.

## Read first
- `docs/SPEC-AUDIT.md` — the coverage snapshot these fixes come from (gaps **G1–G6** + minors).
- `docs/superpowers/plans/2026-07-03-mvp-ui-over-tested-api.md` — the just-executed plan;
  every convention below is demonstrated there.
- `.superpowers/sdd/progress.md` — the execution ledger (per-task commits + accumulated
  minor findings). The "Minor findings" section there is the source for the cosmetics below.

## Conventions (unchanged — match these)
- **Domain**: `src/<module>/`, pure `(tx, ctx, ...)` fns, every mutation `appendAudit`, RLS via
  `withTenant` — never bypass. Money as integer cents / decimal strings, never floats.
- **API route**: `runtime='nodejs'` + `dynamic='force-dynamic'`; `@domain/*.js` imports;
  401 no-token, 400 missing `clientCompanyId`, catch → `/session/i ? 401 : 403`.
- **i18n**: every string in EN+LV+RU in `web/app/lib/i18n.ts` (build fails otherwise).
- **Tests**: Vitest against real Postgres (`docker compose up -d` first).
  ⚠️ **Never run two vitest processes at once** — the suite DROPs/recreates the shared
  schema; concurrent runs show as `tuple concurrently updated` / hook timeouts.
- **Verify**: `npm test` (root) + `npx tsc --noEmit` in root and `web/`.
- **Commit trailer**:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` then
  `Claude-Session: <session-url>`.
- **Subagent execution note**: last session, background agents frequently stalled (stream
  watchdog) or dropped on API errors — often *after* doing the work (files staged, commit
  pending). Before re-dispatching, always check `git log`/`git status` and the ledger;
  finish a stalled agent's last step directly rather than redoing the task.

---

## Priority 1 — security/correctness (do first)

### G1. Route-level role gating on mutating routes
**Why:** `/settings` (periods, autonomy) is gated only in the UI + `resolveTenantContext`;
a client-assigned `employee`/`owner` could `POST /api/periods` or `/api/autonomy` directly.
Matches current posture (only `/api/admin/*` role-gates) but is a real authz gap.
**Where:** `web/app/api/periods/route.ts`, `web/app/api/autonomy/route.ts` (POST handlers);
consider also `bank/import`, `bank/payment-orders`, `parties` writes, `einvoices` POST.
**How:** decide the role matrix first (who may open/close periods, set autonomy, issue
invoices, import bank data). Add a small shared guard — resolve the tenant context, then
check `ctx.actorRole` against an allow-set, returning 403 with a clear message before the
domain call. Pattern to mirror: the admin routes (`web/app/api/admin/clients/route.ts`)
already do `validateSession` → role check. Prefer centralizing in one helper
(e.g. `web/app/lib/authz.ts`) over copy-paste.
**Acceptance:** an `employee` session gets 403 from the gated routes; accountant/firm_admin
still succeed. Add a route/domain test per role where feasible.

### G2. Uniform error→status mapping
**Why:** inconsistent: einvoices POST maps validation → 400, but parties POST returns **403**
for a duplicate `UNIQUE(client,kind,reg_no)` (should be 400/409). Misleads clients.
**Where:** all mutating routes; today each inlines `/session/i ? 401 : 403`.
**How:** a shared `errorToStatus(msg)` helper: session → 401; forbidden/denied/not-assigned →
403; duplicate/unique/validation/constraint → 409/400; else 400 (or 500 for truly unknown).
Apply to parties, periods, autonomy, bank, einvoices. Keep the einvoices 400 behaviour.
**Acceptance:** creating a duplicate party returns 409 (or 400), not 403; existing 401/403
paths unchanged.

---

## Priority 2 — feature gaps with existing backend (straightforward UI/thin-domain)

### Credit notes (HANDOFF #3 leftover)
**Why:** the only remaining piece of the invoicing story; spec expects it.
**Backend gap too:** no UBL CreditNote document type yet. Scope: extend `src/einvoice/ubl.ts`
(CreditNote build/parse), a `createCreditNote`/reversal-aware posting path, then a UI action
from the outbox ("credit this invoice"). This is bigger than a UI-only task — treat as its
own mini-plan (migration? probably not; domain + tests + API + UI).
**Acceptance:** issue a credit note against an invoice; it posts the reversal and renders
valid UBL.

### G5. 2FA enrolment / recovery + profile page
**Why:** TOTP is provisioned only inside `createUser` server-side; no user-facing setup,
QR display, or recovery. Users can't self-manage 2FA.
**Backend gap:** no enrol/reset/disable domain functions exist — design these first
(`src/auth/totp.ts` has the primitives: `generateTotpSecret`, `totpUri`, `verifyTotp`).
Decide: reset flow, recovery codes?, who can trigger. Then a `/settings` "Security" section
or a `/profile` page showing the otpauth QR and a verify step.
**Acceptance:** a user can view/rotate their TOTP with a verify confirmation.

### G6. LR public-holiday calendar for VID due dates
**Why:** `addWorkingDays` in `src/einvoice/vid.ts` skips weekends only; LR public holidays
are ignored, so 5-working-day due dates can be wrong.
**How:** add a holiday source (static table or `tax_rules`-style data), thread it into
`addWorkingDays`. Confirm the LR holiday list with the accountant (§10.1).
**Acceptance:** a due date spanning a public holiday shifts correctly; unit-tested.

---

## Priority 3 — polish / cosmetics (quick, batch together)

From `.superpowers/sdd/progress.md` "Minor findings":
- Remove or use unused i18n keys: `parties.saved`, `einv.issued`, `einv.direction.*`,
  `journal.showMore`.
- `web/app/(cabinet)/bank/page.tsx`: disable the file `<input>` while an import is in
  flight (currently only the `<label>` is `aria-disabled`) — prevents a double concurrent import.
- Optional: parties `kind` query/body value isn't validated against the enum at the route
  (DB CHECK catches it); add a 400 for a bad `kind` if doing G2 anyway.

---

## Larger, decision-gated (scope only if the decision lands)

- **G3 — Owner-calm view.** Spec wants a lighter owner window on the same data. Today owner
  sees accountant screens (minus admin/settings). Design a simplified, overview-first owner
  mode. Needs a product call on scope.
- **G4 — Tariffs & templates (admin §5).** Absent backend + UI. Blocked on the monetisation
  model decision (§10). Don't start until that's chosen.
- **WCAG 2.2 AA** — add an automated a11y check (axe) to catch regressions; the tokens are
  AA-oriented but unaudited.

## Explicitly out of scope for "fix the gaps" (external blockers)
- Live Peppol Access Point delivery, SML/SMP lookup, inbound polling (spec §1 / §10.3).
- Real VID/EDS filing + finalised declaration XML (spec §2 / §10.1).
- Phase 2–3 accounting modules (payroll, fixed assets, warehouse, annual report, UIN/MUN,
  multi-currency) — each net-new and needs accountant input; separate plans.

## Suggested order for next session
1. G1 + G2 together (shared authz + error-status helpers; one review pass). ← highest value.
2. Priority 3 cosmetics (fast, clears the ledger's minor list).
3. G6 holiday calendar (self-contained, testable).
4. G5 2FA (needs a short backend design first).
5. Credit notes (own mini-plan).
6. Revisit G3/G4/WCAG once product/monetisation calls are made.

Recommend `superpowers:writing-plans` → `superpowers:subagent-driven-development` again for
items 1–5, since they're independent and well-specified.
