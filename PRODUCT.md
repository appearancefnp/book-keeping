# Product

## Register

product

## Users

Latvian SME bookkeeping, worked through one shared cabinet by four roles:

- **Firm accountant** — the primary power user. Manages the books of *many* client companies from one workspace, controls the AI agent, and approves complex operations. Context: at a desk, working long sessions across many clients, filing with the state (VID). Needs speed, density that aids comprehension, and total confidence in what the AI drafted before approving it.
- **SME owner / entrepreneur** — reviews financial position, approves decisions with material consequences, asks plain-language questions ("how much tax this month?"), uploads documents. Context: busy, non-accountant, often on mobile, anxious about tax compliance. Needs calm, jargon-free clarity and reassurance.
- **Client employee** — uploads documents, issues invoices, sees a limited slice by permission.
- **Firm administrator** — manages clients, tariffs, permissions, templates.

The go-to-market is accountant-led (the "with services" model): the firm's own accountants serve the first clients, so the accountant workflow is the primary surface and the client/owner view is a lighter, calmer window onto the same data.

## Product Purpose

A cloud, AI-native bookkeeping platform for Latvian SMEs, comparable in scope to Horizon/1C but built around two things incumbents lack: an **autonomous AI agent** that does routine work and asks for approval on anything with material consequences, and a **shared client↔accountant cabinet**. The strategic wedge is Latvia's mandatory structured e-invoicing (Peppol/EN 16931 + near-real-time VID reporting: B2G from 2026, all domestic B2B from 2028).

The backend is built and tested (ledger, AI/OCR intake, VAT engine, banking, Peppol/VID, auth/RBAC, collaboration, mobile/intake API — Plans 1–8). **This UI is the presentation layer over that tested API.** Success looks like: an accountant clears a client's month in a fraction of the time by approving legible AI drafts; an SME owner understands their tax position without fear; every figure traces to its source.

## Brand Personality

Calm, trustworthy, clear. The voice is a competent professional who explains rather than impresses — plain language, no jargon-flexing, no alarm. It should feel like institutional-grade financial software that a nervous small-business owner and a veteran accountant *both* trust on sight. Confidence through legibility, not decoration. Multilingual by nature (LV / RU / EN) — copy is written to translate cleanly.

## Anti-references

- **Legacy ERP density (Horizon / 1C).** Cluttered, dated, intimidating grey enterprise screens packed with toolbars and modal-on-modal. This is the incumbent we displace; the whole point is to *not* feel like this.
- **Generic SaaS-cream / "AI made this" template slop.** Cream/beige body backgrounds, tiny tracked-uppercase eyebrows over every section, identical icon-heading-text card grids, gradient text, decorative glassmorphism.
- **Crypto / neon fintech.** Dark neon gradients, hype aesthetics, glassmorphic dashboards — the wrong trust signal for software that files taxes with the state.
- (Playful consumer-app touches are acceptable in moderation for the owner/mobile views, but never at the cost of gravitas in the accountant and filing surfaces.)

## Design Principles

1. **Explain everything — no black boxes.** Every AI action carries its reasoning inline: which rule/norm, what computation, which source document/entry. The approval UI shows the *why* beside the *what*, always drill-downable. This is the product's core differentiator; the UI must make it effortless, not buried.
2. **The human holds authority.** The agent drafts; the human approves anything with material consequences (postings above a threshold, tax filings, payroll). Approve/reject must be a one-glance, one-action decision with the rationale and source right there. Never let the UI imply the machine decided.
3. **Make the state (VID) feel calm, not scary.** Taxes, deadlines, and the 5-working-day VID window are surfaced early, in plain language, with context — never as red-alert dread. Turn "fear of the tax office" into quiet, understood obligations.
4. **One workspace, shared truth.** Client and accountant act in the same cabinet with role-scoped views; scattered email/WhatsApp/receipts become a managed, auditable process (tasks, comments, full audit trail). Continuity and provenance over silos.
5. **Legibility over flash; density that serves comprehension.** High contrast, generous rhythm, numbers that are easy to read and reconcile. For the accountant, density is a feature — but density earned through clarity, not clutter. Nothing decorative that a nervous owner could misread.

## Accessibility & Inclusion

- **WCAG 2.2 AA** minimum. Financial data legibility is non-negotiable: body text ≥ 4.5:1, numeric tables comfortably above; never light-gray "for elegance."
- **Trilingual UI and documents (LV / RU / EN)**, with per-user language preference already modeled server-side; layouts must tolerate Latvian/Russian string lengths without overflow.
- **Reduced-motion** alternative for every animation.
- **Colour-blind-safe** status signaling — never rely on red/green alone for approve/reject, over/underdue, debit/credit; pair with shape, icon, or label.
- Users span a wide age/expertise range (veteran accountants, non-technical SME owners); default to obvious affordances over clever ones, and keyboard-navigable flows for the power-user accountant surfaces.
