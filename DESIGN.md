<!-- SEED: re-run /impeccable document once there's frontend code to capture the actual tokens and components. Colors, fonts, and component specs below are directional, not final. -->
---
name: AI Bookkeeping Cabinet
description: Calm, trustworthy, legible UI for a Latvian SME bookkeeping platform — restrained deep-teal accent, humanist sans with tabular numerals.
---

# Design System: AI Bookkeeping Cabinet

## 1. Overview

**Creative North Star: "The Quiet Ledger"**

A workspace that feels like a calm, exact professional — the opposite of the anxious clutter accountants and SME owners escape when they leave Horizon/1C. Numbers are the hero; the interface recedes so the figures, the AI's reasoning, and the approve/reject decision are the only things competing for attention. Trust is earned through legibility and restraint, not decoration. Every AI action wears its reasoning in the open (which rule, what computation, which source) so the machine never feels like a black box — the human always sees enough to approve with confidence.

The surface is a **restrained** one: tinted-neutral backgrounds carrying a single **deep teal/petrol** accent used sparingly (≤10%) for primary actions and live status. Deep teal was chosen deliberately over the navy-and-gold banking cliché and over the cream/beige default — it reads competent and modern without coldness or hype. Motion is quiet: state changes, focus, and approve/reject feedback only; nothing choreographed distracts from reconciliation.

Directional references (refine these): **Stripe Dashboard** (trustworthy financial clarity, calm data density), **Linear** (keyboard-first calm, restraint, superb legibility at density), **Mercury** (calm, unintimidating banking UI). We borrow their *restraint and legibility*, not their exact palettes.

**Key Characteristics:**
- Legibility over flash; density that serves comprehension, never clutter.
- One calm accent; the neutral surface does the heavy lifting.
- Explanation is a first-class UI element, always beside the AI's proposal.
- Trilingual by construction (LV / RU / EN) — layouts tolerate long Latvian/Russian strings and Cyrillic.
- Status never relies on colour alone.

## 2. Colors

A restrained, tinted-neutral system anchored by a single deep teal/petrol accent. Exact values `[to be resolved during implementation]` — compose in OKLCH, verify contrast (body ≥ 4.5:1).

### Primary
- **Deep Teal / Petrol** `[to be resolved during implementation]`: the one accent — primary buttons, active nav, focus rings, "pending approval" and live-status emphasis. Used on ≤10% of any screen.

### Neutral
- **Tinted surface & background** `[to be resolved]`: near-neutral tinted a hair toward the teal hue (chroma ~0.005–0.015) — explicitly **not cream/beige/sand**. Carries most of the interface.
- **Ink (body / figures)** `[to be resolved]`: high-contrast text end of the ramp; numeric tables sit comfortably above 4.5:1. Never light-gray "for elegance."
- **Border / divider** `[to be resolved]`: quiet 1px hairlines; full borders, never side-stripes.

### Status (semantic, colour-blind-safe)
- **Approve / posted / on-time**, **Reject / rejected**, **Attention / overdue / needs-review** `[to be resolved]`: each pairs a hue with an icon/shape/label — **never red-green alone**. Debit/credit and over/under-due must be distinguishable without colour.

### Named Rules
**The One Accent Rule.** Deep teal appears on ≤10% of any screen; its rarity is what makes "this needs your approval" and "this action is primary" instantly legible. If half the screen is teal, the signal is gone.

**The No-Cream Rule.** The body background is a true neutral tinted toward teal, never a warm cream/beige/sand/paper tone. Warmth is not this brand.

**The Colour-Isn't-Status Rule.** Every status is carried by icon + label + shape, with colour as reinforcement only. Forbidden: red/green as the sole signal.

## 3. Typography

**Display / UI Font:** Humanist sans with broad Latin + Cyrillic coverage `[family to be chosen at implementation]` (candidates to evaluate: Inter, IBM Plex Sans, Söhne, or similar — must ship real Cyrillic, not faux).
**Numeric:** the same family's **tabular, lining numerals** (`font-variant-numeric: tabular-nums`) so figures align and reconcile down a column.
**Label/Mono Font (optional):** a monospace for machine identifiers only (invoice numbers, VAT ids, message ids) `[to be chosen]`.

**Character:** one calm, legible humanist family in multiple weights — no font *pairing* on a similar axis. Contrast comes from weight and size, not from a second competing sans.

### Hierarchy
- **Display** (light–regular, clamp max ≤ 4rem): sparse — page/section titles only. Never shouting.
- **Headline / Title** (medium): screen and card headers.
- **Body** (regular, ~15–16px, line-height ~1.5, ≤ 65–75ch prose): labels, descriptions, the AI's plain-language rationale.
- **Figures** (tabular numerals, medium): all money, dates, counts — right-aligned in tables.
- **Label** (medium, sentence case): field labels and buttons. Sentence case, **not** tracked all-caps.

### Named Rules
**The Tabular Numbers Rule.** Every monetary or countable figure uses tabular lining numerals and right-aligns in tables. Misaligned digits in a ledger read as sloppy and untrustworthy.

**The No-Eyebrow Rule.** No tiny tracked-uppercase kicker above sections. Hierarchy comes from size, weight, and spacing.

## 4. Elevation

**Flat by default.** Surfaces are flat at rest; depth is conveyed by the tinted-neutral tonal layering (background → surface → raised), 1px hairline borders, and generous spacing — not by drop shadows. Shadows appear only as a *response to state*: a soft, low shadow on an open dialog/menu or a lifted item on hover. No decorative ambient shadows, no glassmorphism.

### Named Rules
**The Flat-Ledger Rule.** If a resting surface has a drop shadow, remove it — layer with tone and a hairline instead. Shadow is a state signal (open, dragging), never decoration.

## 5. Components

_No components exist yet — this is a pre-implementation seed. Re-run `/impeccable document` in scan mode once the frontend is built to capture the real button/field/table/approval-card primitives and generate the `.impeccable/design.json` sidecar._

Anticipated signature components to design first (backed by tested API handlers): the **Approval Queue card** (proposal + inline rationale: rule, computation, source drill-down + one-action approve/reject), the **numeric ledger/trial-balance table** (tabular numerals, right-aligned, reconciling totals), the **document review panel** (extracted fields + confidence + source image), and the **calm tax/deadline strip** (VID obligations surfaced early, plain-language, never red-alert).

## 6. Do's and Don'ts

### Do:
- **Do** keep the deep-teal accent to ≤10% of any screen (The One Accent Rule).
- **Do** use tabular lining numerals and right-align every figure in tables.
- **Do** put the AI's reasoning (rule + computation + source) *beside* every proposal — explanation is a first-class element, drill-downable.
- **Do** verify contrast: body ≥ 4.5:1, numeric tables above it; bump toward ink if it's even close.
- **Do** signal status with icon + label + shape, colour as reinforcement only (colour-blind-safe).
- **Do** test every heading and label at LV/RU/EN lengths and in Cyrillic; the viewport and the language are part of the design.
- **Do** provide a reduced-motion alternative for every transition.

### Don't:
- **Don't** make it look like **legacy ERP (Horizon / 1C)** — no toolbar-dense, grey, modal-on-modal enterprise clutter. Density must be earned through clarity.
- **Don't** ship the **generic SaaS-cream / "AI made this" template look**: no cream/beige body, no tiny tracked-uppercase eyebrows over every section, no identical icon-heading-text card grids, no gradient text, no decorative glassmorphism.
- **Don't** use **crypto / neon fintech** aesthetics — no dark neon gradients, glass dashboards, or hype styling; wrong trust signal for software that files with the state.
- **Don't** rely on red/green alone for approve/reject, debit/credit, or over/under-due.
- **Don't** use `border-left`/`border-right` > 1px as a coloured accent stripe; use full borders, tint, or a leading icon/number.
- **Don't** let figures use proportional numerals or misalign in columns.
- **Don't** alarm the user about taxes — the VID/deadline surfaces are calm and explanatory, never red-alert dread.
