# Personal Cabinet UI (Plan 10) — Design

**Status:** approved for planning · **Date:** 2026-07-03 · **Register:** product UI

## 1. Purpose & scope

Turn the web app from a single approval-queue page into the full **personal cabinet** described in
the MVP design spec §6 — one shared, role-aware workspace over the existing, tested backend. Every
screen is a thin view over already-built domain code (Plans 1–9); the web layer holds no business
logic. The visual system is the existing **"Quiet Ledger"** (`web/app/globals.css` OKLCH tokens,
`DESIGN.md`), reusing the components built for the approval queue.

This spec covers **Phase 1 of the cabinet UI**: the app shell, real authentication, an i18n layer,
and eight surfaces at **read + one core action** depth. It is deep enough to plan directly.

### Decisions fixed during brainstorming

| Decision | Choice |
|---|---|
| Navigation shell | Persistent **left sidebar**; collapses to a **bottom tab bar** under ~640px |
| Interactivity depth | **Read + core action** per screen (not full CRUD) |
| i18n | **i18n-ready**; ship **LV + EN** dictionaries + a working switcher; RU keys stubbed |
| Assistant surface | **Global slide-over panel** (an "Ask" button in the top bar), also reachable at `/assistant` |
| Design system | Reuse the existing "Quiet Ledger" tokens and approval-queue components |
| Data access | Thin **backend-for-frontend** route handlers (`authed` + `withTenant`) over existing domain functions |

### In scope

App shell + role-aware nav; real login + mandatory 2FA (TOTP) + logout; i18n message layer +
LV/EN + switcher; and eight surfaces: **Login**, **Approval queue** (exists — reskinned into the
shell), **Documents** (list + upload), **Overview** (financial position), **Tasks** (list +
complete + comment), **Notifications** (list + mark read), **Assistant** (slide-over + page), and
**Admin** (clients + users + audit trail, read-mostly).

### Out of scope (interfaces exist; deferred by choice)

Issue-invoice / outbound-e-invoice UI; full admin CRUD (create/edit clients, users, tariffs,
permissions, templates, settings); RU translations (keys stubbed now); React Native mobile app;
cash-flow forecast & anomaly views. These have backend support and can attach later.

## 2. Architecture

### 2.1 Routing & the app shell

Next.js App Router (existing config: `--webpack`, `@domain/*` alias, `extensionAlias`, route
handlers `runtime='nodejs'` + `dynamic='force-dynamic'`). Two route groups:

- `app/login/` — outside the shell (no sidebar).
- `app/(cabinet)/` — a layout that renders the **AppShell**: a persistent left **Sidebar**
  (sections below), and a **TopBar** with the **client switcher**, **language switcher**, **user
  menu** (shows role; logout), and an **"Ask" button** that opens the assistant slide-over. The
  current `app/page.tsx` moves under this group as the Queue screen.

Responsive: the sidebar is a fixed left rail ≥640px and a **bottom tab bar** below; the assistant
opens as a right slide-over ≥640px and a full-height sheet below. No horizontal page scroll at any
width; wide content (tables) scrolls inside its own container.

### 2.2 Authentication & the guard

A real `/login` screen: email + password → then a **6-digit TOTP** step (2FA is mandatory) →
session cookie (the existing `bk_session`). Backend: `auth/sessions.login`, `auth/users`,
`auth/totp`. New BFF routes `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`.
The `(cabinet)` layout checks the session server-side and **redirects unauthenticated users to
`/login`**; `/api/dev/bootstrap` remains for dev, still guarded by `NODE_ENV`.

### 2.3 i18n

A message-dictionary layer: `app/lib/i18n.ts` exporting typed message keys and `LV` + `EN`
dictionaries (RU stubbed with the same keys, English fallback). A `useMessages()` hook reads the
active language from a cookie (default `lv`); a **language switcher** in the top bar updates it.
All UI chrome strings route through the dictionary — replacing today's hardcoded English labels and
the static "LV" badge. Domain data (memos, party names) is passed through untranslated. Backend
`i18n/messages` remains the source for server-issued strings; the web dictionary covers UI chrome.

### 2.4 Data: backend-for-frontend

Each screen calls a thin route handler under `app/api/**`, each wrapping already-tested domain
functions inside `authed(req, ctx => withTenant(ctx, tx => …))`. No web-side business logic; no
figures computed in the browser. The expanded `app/lib/api-client.ts` centralizes fetches (session
cookie, error normalization → `{status, body}`), returning typed results the screens render.

### 2.5 Design system reuse

Reuse Quiet Ledger tokens and existing components: `ProposalCard`, `DetailList`, `StatusBadge`,
`Toast`, `EmptyState`, `ErrorState`, `SkeletonCard`, `RationaleBlock`, `PostingLines`. New shared
components: `AppShell`, `Sidebar`, `TopBar`, `LanguageSwitcher`, `FileDropzone`, `ChatPanel`,
`AssistantLauncher`, and quiet **figure rows** for Overview (labelled rows with tabular numerals —
**not** hero-metric cards; `DESIGN.md`/impeccable ban that template). Flat-by-default, teal accent
≤10%, tabular numerals on all figures, WCAG AA contrast.

## 3. Screens

Each screen: a read view + at most one core write action. Every screen has loading (skeleton),
empty (`EmptyState`), and error (`ErrorState` + toast) states, and is verified at desktop + mobile.

### 3.1 Login (`/login`)
Two-step form (credentials → TOTP). On success, sets the session cookie and redirects to `/`.
Invalid credentials / wrong code → inline error, no lockout leak. Backend: `auth/sessions`,
`auth/users`, `auth/totp`. Routes: `/api/auth/login`, `/api/auth/logout`, `/api/auth/me`.

### 3.2 Approval queue (`/`, in the shell)
The existing screen, reparented into the cabinet shell (sidebar + top bar). Unchanged behavior:
lists `pending_approval` proposals (postings/matches/declarations) with rationale + cited sources,
one-action approve, reject-with-reason. Existing routes `/api/proposals*`.

### 3.3 Documents (`/documents`)
A list of the client's documents with status (received → extracting → proposed → posted) and type.
Core action: **upload** a document (drag-drop / picker) → creates the document, stores the blob,
and enqueues extraction. Backend: `documents.listDocuments`, `intake/capture-handler`,
`intake/blob-store`. Routes: `GET /api/documents`, `POST /api/documents` (upload). Uploading a
document that yields a proposal shows it later in the Queue — the two screens connect.

### 3.4 Overview (`/overview`)
The owner's financial position: **trial balance** (accounts with debit/credit/balance), current
**VAT position** (net payable + rule + period), and **outstanding receivables**. Read-only; quiet
figure rows and a compact table with tabular numerals. Backend: `ledger/balances.trialBalance`,
`tax/explain.explainVat` (or `vat-compute`), `banking/sepa.outstandingReceivables`. Route:
`GET /api/overview` (one aggregate payload).

### 3.5 Tasks (`/tasks`)
The collaboration to-do list ("missing contract for this expense"): open tasks/requests with
status and assignee. Core actions: **complete** a task and **add a comment** (the comment thread
per task). Backend: `collab/tasks`, `collab/comments`. Routes: `GET /api/tasks`,
`POST /api/tasks/[id]/complete`, `GET|POST /api/tasks/[id]/comments`.

### 3.6 Notifications (`/notifications`)
Deadlines and agent questions awaiting attention, newest first. Core action: **mark read** (single
+ mark-all). The top-bar bell shows an unread count. Backend: `collab/notifications`. Routes:
`GET /api/notifications`, `POST /api/notifications/[id]/read`, `POST /api/notifications/read-all`.

### 3.7 Assistant (slide-over + `/assistant`)
A `ChatPanel` that posts a question and renders the grounded, **cited** answer + disclaimer from
Plan 9. Available as a **global slide-over** (top-bar "Ask") from any screen and as a full page at
`/assistant`. Read-only/advisory (Plan 9 guarantees). Backend: `makeAssistantHandler`. Route:
`POST /api/assistant`.

### 3.8 Admin (`/admin`)
Read-mostly firm administration for accountants/admins: list **clients** (the firm's client
companies) and **users** (with roles), and a read **audit trail** view (who/what/when, before→after)
scoped to the client. No create/edit in this phase. Backend: `tenancy/firms`, `auth/users`,
`collab/audit-view`. Routes: `GET /api/admin/clients`, `GET /api/admin/users`, `GET /api/audit`.
Sidebar shows Admin only for accountant/administrator roles; the API enforces it regardless.

## 4. Roles, permissions, states

- **Role-aware nav:** the Sidebar renders only sections the role can use (owner: Queue, Overview,
  Documents, Tasks, Notifications, Assistant; accountant/admin: + Admin). Hiding is convenience;
  the **server RBAC (`authed` + `resolveTenantContext`) is the real boundary** — every BFF route is
  authed and tenant-scoped, mirroring RLS.
- **States:** every data view has skeleton (loading), `EmptyState` (no data), and `ErrorState` +
  toast (failure). Upload and assistant have inline progress + failure handling. Auth failure at any
  route → 401 → client redirect to `/login`.

## 5. Testing

- New BFF route handlers are thin wrappers over domain functions already covered by the 142-test
  backend suite; they add auth + tenant scoping + shape mapping only.
- Each screen is verified with **Playwright** against the dev server + the seeded demo DB
  (`npm run seed`): screenshot desktop (1440) + mobile (390), exercise the screen's core action, and
  confirm **zero console errors**, plus a design pass against Quiet Ledger (tokens, tabular numerals,
  contrast, no banned patterns). This mirrors how the approval queue was validated.
- The seed is extended as needed so every screen is non-empty (documents, tasks, notifications,
  audit rows, balances).

## 6. File structure (indicative)

```
web/app/
  login/page.tsx
  (cabinet)/layout.tsx                # AppShell: Sidebar + TopBar + assistant slide-over host
  (cabinet)/page.tsx                  # Queue (moved from app/page.tsx)
  (cabinet)/documents/page.tsx
  (cabinet)/overview/page.tsx
  (cabinet)/tasks/page.tsx
  (cabinet)/notifications/page.tsx
  (cabinet)/assistant/page.tsx
  (cabinet)/admin/page.tsx
  components/{AppShell,Sidebar,TopBar,LanguageSwitcher,FileDropzone,ChatPanel,AssistantLauncher,FigureRows,...}.tsx
  lib/{i18n,api-client,session,...}.ts
  api/auth/{login,logout,me}/route.ts
  api/{documents,overview,tasks,notifications,assistant,audit}/**/route.ts
  api/admin/{clients,users}/route.ts
```

## 7. Success criteria

A signed-in user can traverse all eight surfaces from the sidebar, in LV or EN, on desktop and
mobile; can log in with 2FA, upload a document, read their financial position, complete/comment a
task, clear a notification, ask the assistant and get a cited answer, approve/reject a proposal, and
(as accountant) view clients/users/audit — every screen sourced from the tested backend, with
loading/empty/error states, no console errors, and Quiet-Ledger visual quality.
