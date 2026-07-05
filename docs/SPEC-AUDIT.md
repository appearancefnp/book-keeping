# Spec ↔ Implementation Audit

Date: 2026-07-05. Audits the current UI and feature set against the concept spec
(`Gramatvedibas_sistemas_koncepcija.docx`, distilled in `PRODUCT.md` / `DESIGN.md`),
after the MVP-UI pass (plan `docs/superpowers/plans/2026-07-03-mvp-ui-over-tested-api.md`).

Legend: ✅ shipped (UI + backend) · 🟡 backend only, no UI · 🔶 partial · ⛔ absent ·
🔒 blocked on an external decision.

---

## 1. Strategic wedge (spec §2.1) — Peppol + near-real-time VID

| Capability | Backend | UI | Status |
|---|---|---|---|
| EN 16931 / Peppol BIS 3.0 UBL build + parse + validate | real (`src/einvoice/ubl.ts`, `validate.ts`) | issue via composer | ✅ (build/validate/post) |
| Outbound issue pipeline (`sendInvoice`) | real | `/invoices/new` composer, `/invoices` outbox | ✅ |
| Access Point network delivery | `AccessPoint` interface + `StubAccessPoint` only | status column shows stub state | 🔒 needs accredited SP + onboarding (spec §10.3) |
| Participant lookup (SML/SMP) | ⛔ | ⛔ | 🔒 |
| Inbound ingestion → proposal | real (`inbound.ts`) | flows into approval queue | 🔶 no live polling/webhook (needs #1) |
| VID submission (file to EDS) | `VidClient` interface, records attempts | — | 🔒 needs real API + accountant-verified schema (§10.1) |
| VID 5-working-day deadline visibility | `upcomingVidDeadlines` | calm strip on `/overview` | ✅ (visibility); ⛔ holiday calendar (weekends only) |
| EDS declaration XML to real schema | representative mock | — | 🔒 must finalise with an accountant |

**Verdict:** the invoice *creation/validation/posting* half of the wedge is now usable
end-to-end; the *network* half (Peppol delivery, VID filing) is correctly seam'd behind
interfaces and blocked only on external provider/accountant decisions, exactly as the
architecture intended.

## 2. Autonomous AI agent + human authority (spec §4.1; design principles 1–2)

| Capability | Status |
|---|---|
| Agent drafts → proposals with inline rationale (rule/computation/source) | ✅ approval queue `/`, `RationaleBlock` |
| One-glance approve/reject | ✅ |
| Per-operation autonomy dial (auto vs approval, material threshold) | ✅ now configurable in `/settings` (was backend-only) |
| "declaration" always requires approval (hard guardrail) | ✅ enforced in `resolveAutonomy` |
| Agentic chat/assistant | ✅ `/assistant` |
| Cash-flow forecast / anomaly detection / proactive reminders (§6.9) | ⛔ new tools/jobs, not built |

## 3. Shared cabinet + roles (spec §5; design principle 4)

| Role | Spec duties | Coverage |
|---|---|---|
| Firm accountant | many clients, controls agent, approves, files | ✅ primary surface complete |
| SME owner | review position, approve material, plain-language Q&A, upload | 🔶 sees the same screens; no dedicated calmer owner view |
| Client employee | upload documents, **issue invoices**, limited slice | ✅ can now issue invoices (was impossible pre-pass); 🔶 permission-scoping is coarse (see gap G1) |
| Firm administrator | manage clients, tariffs, permissions, templates | 🔶 clients/users read-mostly in `/admin`; ⛔ tariffs & templates (don't exist backend or UI) |

Collaboration substrate — tasks, comments, notifications, full audit trail — ✅ (`/tasks`,
`/notifications`, `/admin` audit view). One shared cabinet with `?client=` switching ✅.

## 4. MVP-tier operational screens (spec §6, Phase 1)

| Screen | Status |
|---|---|
| Documents intake (AI/OCR) | ✅ `/documents` |
| Financial overview (trial balance, VAT, receivables) | ✅ `/overview` |
| Invoice composer + outbox | ✅ `/invoices`, `/invoices/new` |
| Bank: camt.053 import, transactions, pain.001 payment orders | ✅ `/bank` |
| Journal / entry browser | ✅ `/journal` |
| Parties (customer/vendor) management | ✅ `/parties` |
| Accounting periods open/close | ✅ `/settings` |
| Autonomy policy configuration | ✅ `/settings` |
| VID deadline strip | ✅ `/overview` |
| Credit notes | ⛔ backend + UI (needs UBL CreditNote type) |
| Settings / 2FA enrolment / profile | ⛔ no user-facing 2FA setup/recovery, no profile page |
| Payment-order bank *submission* | ⛔ generation only; submission is an integration decision |

## 5. Absent accounting modules (spec §6, Phase 2–3) — all ⛔

Payroll & HR + VSAOI/IIN (§6.3) · Fixed assets & depreciation (§6.5) ·
Warehouse/inventory (§6.4) · Annual report + closing (§6.8) ·
UIN & MUN alternative tax regimes (§6.2) · Multi-currency + FX differences (§6.1) ·
Assistant forecasting/anomaly tools (§6.9). Each needs migration + domain + tests +
API + page **and** accountant input on LR rules (§10.1). Smaller VAT gaps also open:
reverse charge / intra-EU, exemptions, monthly-vs-quarterly periodicity.

## 6. Cross-cutting (spec §7/§9) — all ⛔ / 🔶

GDPR export + erasure (§7/§9) ⛔ · E-signature (§6.7) ⛔ · Push dispatch (queue exists,
no APNs/FCM send) 🔶 · Native mobile + offline photo queue (§4.3) 🔶 responsive web +
camera capture only · Open API + marketplace (§9) ⛔ · Login rate-limiting + audit
hash-chain ⛔.

## 7. Design-principle & accessibility adherence (DESIGN.md, PRODUCT.md §Accessibility)

- ✅ **Explain everything** — rationale beside every proposal.
- ✅ **Human holds authority** — approve/reject one-action; declaration hard-gated.
- ✅ **Calm VID state** — deadline strip uses `--attention` (amber) + label, no red banner.
- ✅ **Trilingual** — every string in EN/LV/RU, build-enforced; dates via `LOCALE_FOR`.
- ✅ **Colour-isn't-status / tabular numerals / stroked icons / no tracked-uppercase** —
  held across all new screens.
- 🔶 **Owner-calm vs accountant-density** — one screen set serves both; no lighter owner view yet.
- 🟡 **WCAG 2.2 AA** — tokens and semantics are AA-oriented; not independently audited
  (no automated a11y check in CI).

---

## Concrete gaps & findings to carry forward

- **G1 — Route-level role gating.** `/settings` (periods, autonomy) and the other new
  mutating routes gate only in the UI (Sidebar) + `resolveTenantContext`; no server-side
  role check. Consistent with the existing posture (only `/api/admin/*` is role-gated),
  but a client-assigned `employee` could call `/api/periods` or `/api/autonomy` directly.
  Add role checks when tightening authz. (In HANDOFF cross-cutting list.)
- **G2 — Non-uniform error→status.** einvoices POST maps validation failures to 400;
  parties POST returns 403 for a duplicate `UNIQUE(client,kind,reg_no)` (should be 400/409).
  Fold in a shared error→status helper.
- **G3 — Owner view.** Spec wants a lighter, calmer owner window on the same data;
  today owner sees the accountant screens (minus admin/settings). Consider a simplified
  overview-first owner mode.
- **G4 — Tariffs & templates.** Spec §5 admin duties; absent everywhere. Blocked on the
  monetisation-model decision (§10).
- **G5 — 2FA enrolment UX.** TOTP is provisioned only at `createUser` server-side; no
  user-facing setup/recovery/profile screen.
- **G6 — LR public-holiday calendar.** VID due-date calc skips weekends only.
- Minor cosmetic: a few unused i18n keys (`parties.saved`, `einv.issued`,
  `einv.direction.*`, `journal.showMore`); bank upload input not `disabled` mid-import.

## Bottom line

The MVP presentation layer over the tested backend is now **feature-complete for Phase 1**:
every tested domain capability that had no UI now has one, and the client-employee role can
finally issue invoices. The remaining work is exactly the two buckets the spec calls the
strategic core — **live Peppol + VID connectivity** (blocked on provider/accountant
decisions, cleanly seam'd) — and the **Phase 2–3 accounting modules** (net-new, each
needing accountant input). No architectural rework is required for either.
