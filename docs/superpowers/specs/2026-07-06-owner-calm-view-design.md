# G3 — Owner-calm view: design

Date: 2026-07-06. Addresses gap **G3** from `docs/HANDOFF-audit-fixes.md` /
`docs/SPEC-AUDIT.md`: the SME `owner` role currently sees the full accountant-density
cabinet; the spec (§5, design principle "owner-calm vs accountant-density") wants a
lighter, overview-first window on the same data.

This is the first of two decision-gated items to be built; **G4 (tariffs & templates)
is a separate spec, next.**

## Decisions (from the brainstorm)

- **Shape:** a dedicated owner home + curated navigation (not merely a trimmed nav on
  the existing dense pages).
- **Owner approves material items directly** (not view-only) — spec §5 ("approves
  material items"). Reuses the existing proposal approve/reject routes, which are
  already open to assigned users.
- **Landing:** role-branch on `/` — the owner's `/` renders the owner home; every other
  role keeps the existing approval queue. One route, branch on role.
- **Page-read gating is out of scope:** hiding dense pages from the owner's nav is
  presentation only; an owner could still type `/journal`. Acceptable for now (matches
  the existing posture — the sensitive *mutations* are already G1-role-gated). Recorded
  as a follow-up below.

## Scope

### What the owner sees on the home (`/`)

All from data that already exists — no new tables, no migration:

1. **Position at a glance** — plain-language cards built from `/api/overview` data:
   trial-balance summary, VAT net payable, outstanding receivables.
2. **Needs your approval** — *only material items*: proposals in `pending_approval`
   whose amount ≥ the client's `materialThresholdCents` (autonomy policy, default
   €1000 = `100000` cents) **∪** every `declaration`-type proposal (hard-gated in spec).
   Approve/reject inline with the same `RationaleBlock` the accountant sees.
3. **Upload a document** — the existing `FileDropzone` → intake flow.
4. **Ask** — entry point to the existing assistant slide-over.
5. **Deadlines** — the existing calm VID strip (`upcomingVidDeadlines`).

### Curated navigation (owner only)

Sidebar shows the owner: **Home, Documents, Notifications**.
Hidden from the owner: full queue, invoices, bank, journal, parties, tasks,
overview-as-separate-page (folded into Home), admin, settings.

Every other role's navigation and experience is unchanged.

## Architecture

### Navigation gating — `web/app/components/Sidebar.tsx`

Today: `BASE_ITEMS` for everyone + `ADMIN_ITEMS` for `accountant`/`firm_admin`.
Change: introduce an explicit per-role item set. When `role === 'owner'`, render
`OWNER_ITEMS` (Home/Documents/Notifications); otherwise the current logic
(`BASE_ITEMS` + admin extras for firm roles). Contained, additive change.

### Role-aware landing — `/` route

The `/` page renders the **OwnerHome** component when `role === 'owner'`, else the
existing approval-queue component. The shell already resolves and passes `role`, so this
is a branch, not new plumbing.

### New domain helper — `src/proposals/material.ts`

`listMaterialApprovals(tx, ctx)`: returns `pending_approval` proposals that are material
— amount ≥ the client's `materialThresholdCents` (read via the autonomy policy) **∪**
`type === 'declaration'`. The proposal amount is derived from the posting payload's
debit sum (money as integer cents, never floats). Pure function, unit-tested.

- Reads the threshold from the same source `resolveAutonomy` uses
  (`autonomy_policy.material_threshold_cents`), defaulting to `100000n` when no policy
  row exists — consistent with `setAutonomy`'s default.
- Non-posting/declaration types with no derivable amount are treated as non-material
  (excluded) unless they are declarations.

### New API route — `web/app/api/proposals/material/route.ts`

`GET` only, standard pattern: `getSessionToken` → `resolveTenantContext(token,
clientCompanyId)` → `withTenant(ctx, tx => listMaterialApprovals(tx, ctx))`, uniform
`errorToStatus` mapping (the helper added in G2). Approve/reject continue through the
**existing** proposal routes — no new mutation surface.

### OwnerHome UI — `web/app/(cabinet)/` (owner home component + styles)

Composes: overview cards + material-approval list (reusing the existing proposal
card + `RationaleBlock` + approve/reject actions) + `FileDropzone` + VID deadline strip
+ assistant entry. Follows the existing cabinet page + `@domain/*` route conventions,
stroked `currentColor` icons, tabular numerals, no tracked-uppercase.

### i18n

New owner-home strings added to all three catalogs (EN/LV/RU) in
`web/app/lib/i18n.ts` — the typed `Record<keyof typeof EN>` fails the build if a
language misses a key. New nav label(s) via the existing `nav.*` / `nav.short.*` scheme.

## Data flow

```
owner GET /
  → shell resolves role='owner' → renders OwnerHome
      → GET /api/overview          (trial balance, VAT, receivables — existing)
      → GET /api/proposals/material (NEW: material subset)
      → GET /api/vid/deadlines      (existing)
  → approve/reject → existing POST proposal routes
  → upload → existing intake flow
```

No new tables. The only net-new backend is `listMaterialApprovals` + its GET route.

## Testing

- **Domain** (`tests/proposals/material.test.ts`, Vitest against real Postgres):
  below-threshold posting excluded; at/above-threshold included; every `declaration`
  included regardless of amount; respects tenant (RLS) scope; default threshold applied
  when no autonomy policy row exists.
- **HTTP smoke** (per-role, against the running dev server — the path that has caught
  prior route bugs): an `owner` session's material endpoint returns the material subset;
  owner can approve a material item (posts / transitions status); the owner's rendered
  nav is the curated set.
- **Gates:** full backend suite green (single vitest process — never concurrent), root +
  web `tsc --noEmit` clean, web build clean.

## Out of scope

- **G4** (tariffs & templates) — separate spec, built next.
- **Server-side page-read gating for the owner** — hiding dense pages is presentation
  only; owner mutations are already G1-gated. Recorded as a follow-up: if the owner
  should be *prevented* from reading `/journal`, `/bank`, etc., add a role check to those
  page loaders. Not built here.
- No new approval-authority model; no change to accountant/employee experience.

## Follow-ups (noted, not built)

1. Server-side gating of dense page *reads* for the `owner` role, if calm-by-default is
   later deemed insufficient and read-restriction is required.
2. If "material" needs a richer definition (e.g. per-operation thresholds, cumulative
   sums), extend `listMaterialApprovals` — the seam is one function.
