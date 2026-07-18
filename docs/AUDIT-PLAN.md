# Application Audit Plan

Date: 2026-07-18. Scope: the whole repo — Node/TypeScript domain backend (`src/`,
26 modules, 107 test files), Next.js web cabinet (`web/`, ~25 API route groups,
14 cabinet pages), 33 SQL migrations, and the docs corpus. Context: the MVP
presentation layer sits over a tested backend (351/351 tests passing per
HANDOFF.md); Peppol and VID integrations are deliberately stubbed behind
interfaces. A knowledge graph of the repo was built to support this audit
(`graphify-out/graph.html`, `graphify-out/GRAPH_REPORT.md` — 1,699 nodes,
6,077 edges, 74 communities).

**Method for every phase:** evidence first. Each finding gets a severity
(blocker / high / medium / low), a `file:line` reference, a concrete failure
scenario, and a recommended fix. Findings that survive an adversarial re-check
go in the report; speculation doesn't. Each phase ends with a written report in
`docs/audit/` before the next phase starts.

---

## Phase 1 — Architecture (first)

**Goal:** verify the "modular monolith with seams" architecture is real, not
aspirational, and that it will bear the roadmap (real Peppol AP, real VID
client, payroll growth, multi-currency later).

Checks:

1. **Layering discipline.** Confirm the dependency direction holds:
   `web/app/api/*` → `@domain/*` (src) → db, and that no `src/` module imports
   from `web/`. Use the graph's import edges; grep for violations.
2. **Tenancy enforcement.** `withTenant()` is the #1 god node (236 edges) —
   verify *every* domain mutation path goes through it and RLS, and that no
   route queries the pool directly. One bypass is a cross-tenant data leak.
3. **The seams.** `AccessPoint`, `VidClient`, `DocumentExtractor`, `ChatModel`,
   `BlobStore` — confirm each is injected (constructor/DI), stub-swappable, and
   that no caller reaches around the interface. These are the product's
   critical path (HANDOFF §1–2).
4. **Append-only ledger invariant.** Verify DB triggers actually forbid
   UPDATE/DELETE on journal tables and that all corrections are reversals
   (`migrations/005_journal.sql`, `src/ledger/posting.ts`).
5. **Migration hygiene.** *Seed finding:* migration numbers collide —
   `023_client_tariffs.sql` vs `023_payroll_rules.sql`, same at 024, 025, 026.
   Verify the migration runner's ordering is deterministic across fresh
   installs and existing databases; decide renumber-vs-tolerate.
6. **Cross-community coupling.** The graph flags `TenantContext` bridging 15
   communities and weak cohesion inside the three biggest communities
   (E-invoicing/DB infra 0.055, Auth/RBAC 0.061, Payroll 0.054) — assess
   whether that's healthy shared-kernel coupling or module bleed.
7. **Module boundary review of `src/api/` vs `web/app/api/`** — two API layers
   exist (mobile-intake handlers vs Next routes); confirm the split is
   intentional and non-duplicative.

Output: `docs/audit/ARCHITECTURE.md` with a dependency map, invariant
verification results, and a keep/fix/refactor list.

## Phase 2 — Code quality

**Goal:** confirm the codebase is as disciplined as it looks (largest src file
is only 316 lines) and burn down the known-debt list.

Checks:

1. **Known deferred debt (from HANDOFF.md — verify each still reproduces):**
   - Bank-match reject leaves the transaction stuck `matched`, never
     re-proposed (shared pattern with `proposeMatches`).
   - Hard-coded LR account codes (`5310/5722/2620/2699`) in bills, pay-run,
     ap-aging routes.
   - AP bank-matching is amount-only with a propose-time TOCTOU window.
   - Route-level role gating missing on mutating routes (`/api/periods`,
     `/api/autonomy`, …) — UI-gated only; an `employee` can call them directly.
   - Error→status mapping: parties POST returns 403 for a duplicate that is
     really 400/409; fold in the shared `errorToStatus` helper (it exists —
     85 edges in the graph — check adoption is uniform).
   - Minor cleanups list in `.superpowers/sdd/progress.md` (M2 section).
2. **Money invariant.** All arithmetic in integer cents via `src/db/money.ts`;
   grep for float math, `parseFloat`, `toFixed` on amounts, and division
   without explicit rounding policy (VAT rounding especially).
3. **Test depth vs breadth.** 107 test files mirror the 26 modules — sample
   the highest-risk ones (`computeVat`, `payroll/calc`, `banking/match`,
   `einvoice/ubl`) for boundary/property coverage, not just happy paths.
   Check the web layer: components/pages appear untested (vitest covers `src/`
   + `tests/api` handlers only).
4. **Hotspots.** `web/app/lib/i18n.ts` (1,319 lines — by design, but check the
   typed-catalog enforcement still fails the build on a missing key) and
   `web/app/(cabinet)/reports/page.tsx` (497 lines, 6 tabs — candidate to
   split per tab).
5. **Type strictness.** Both tsconfigs: `strict`, `noUncheckedIndexedAccess`
   (root has it — verify web too); `zod` at every trust boundary (API input,
   AI extractor output, XML parsing).
6. **Error handling in integrations.** camt.053 parser, UBL parse, AI
   extraction: malformed input must reject with a message, never post to the
   ledger (the inbound-Peppol reconciliation rejection from M2 is the model).

Output: `docs/audit/CODE-QUALITY.md` + a fix-list ordered by risk; trivial
fixes may be applied directly with tests.

## Phase 3 — End-user organization (is it organized for the end user?)

**Goal:** judge the cabinet against its own four personas (PRODUCT.md): firm
accountant (power user), SME owner (calm, mobile, non-accountant), client
employee (limited slice), firm administrator.

Checks, per role — run the app (`docs/RUNNING.md`, `/api/dev/bootstrap` seed)
and walk each journey end-to-end with Playwright:

1. **Accountant:** month-clearing loop — approval queue → journal → bank →
   reports. Is the queue one-glance/one-action with rationale inline (design
   principle #1–2)? Keyboard navigability? Density earned through clarity?
2. **Owner:** the calm view — can a non-accountant answer "how much tax this
   month?" without jargon? VID deadline strip calm, not alarming (principle
   #3)? Mobile viewport walkthrough.
3. **Employee:** invoice composer + document upload only; verify the permission
   slice both in the Sidebar *and* server-side (ties to the Phase 2 role-gating
   finding).
4. **Admin:** clients/tariffs/permissions/templates — HANDOFF says admin is
   read-only; document the gap explicitly.
5. **Information architecture:** 14 cabinet pages — does the Sidebar grouping
   match task frequency (queue and documents first)? Are reports (P&L, BS, GL,
   TB, aging, comparatives — now 6 tabs) findable and cross-linked (drill-down
   from statement line → GL)?
6. **Trilingual reality check:** every user-facing string in all three
   catalogs (build-enforced — verify), layouts at LV/RU string lengths,
   Cyrillic rendering, `LOCALE_FOR` date formats.
7. **Accessibility (WCAG 2.2 AA per PRODUCT.md):** contrast ≥ 4.5:1, status
   never colour-alone, reduced-motion, focus order, tabular numerals
   right-aligned (DESIGN.md named rules — audit against each).

Output: `docs/audit/UX-ORGANIZATION.md` — per-role journey verdicts with
screenshots, IA recommendations, and a design-rule compliance table.

## Phase 4 — Follow-on audits (scheduled after 1–3)

- **Security/authz:** RLS policy review per table, session/2FA flows, rate
  limiting on login (flagged absent), audit-log tamper evidence (hash chain —
  flagged absent), secrets handling in env.
- **Regulatory/compliance:** EN 16931 validation completeness, VAT declaration
  vs real EDS schema (known mock), 5-working-day VID window with the now-added
  LR holiday calendar (`src/einvoice/holidays.ts`), GDPR export/erasure (absent).
- **Performance:** report queries over large ledgers (GL/comparatives are
  read-heavy), N+1 in route handlers, exceljs memory on big exports.

---

## Sequencing and effort

| Phase | Effort | Depends on |
|-------|--------|------------|
| 1 Architecture | ~half a day | graph (done) |
| 2 Code quality | ~1 day | Phase 1 map |
| 3 End-user organization | ~1 day (needs running app) | seeded dev env |
| 4 Follow-ons | scoped separately | findings from 1–3 |

Standing inputs: `graphify-out/graph.html` (architecture map),
`GRAPH_REPORT.md` (god nodes / weak-cohesion list), HANDOFF.md (known-debt
register), docs/SPEC-AUDIT.md + docs/ROADMAP-market-gaps.md (prior audits —
this plan verifies their fixes rather than re-deriving them).

Graph caveat: 471 doc→code edges dangle (plan/spec docs referencing symbols by
name) — normal for doc-heavy corpora; the code-side (AST) edges are exact.
