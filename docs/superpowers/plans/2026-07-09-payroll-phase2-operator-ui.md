# Payroll (Algas) Phase 2 — Operator UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the accountant screens to drive the phase-1 payroll engine — manage employees, issue orders, run the month, and review the result through an **exceptions-first** view with a manual-adjustment path — implementing instruction-document sections 2.2 (monthly cycle), 2.4 (exception handling), and 5 (manual controls).

**Architecture:** Next.js App Router client pages under `web/app/(cabinet)/payroll/*`, each following the established repo pattern exactly (see `web/app/(cabinet)/parties/page.tsx`): `'use client'`, a `Suspense` wrapper, `useSearchParams().get('client')` for the client company id, `useMessages()` for trilingual copy, `fetch` to the `/api/payroll/*` routes built in phase 1, and `SkeletonCard`/`ErrorState`/`EmptyState` for states. Money renders through `formatDecimal` from `app/lib/format.ts`. One thin backend addition (manual pay-component / absence routes) supports section 5; everything else sits on the existing tested API. **Section 5's "manual control" is modelled as append-and-recompute, not mutation** — corrections are entered as pay components / absences with a mandatory reason (captured in the existing audit log), then the draft run is recomputed. This preserves the append-only, deterministic core from phase 1 rather than letting the UI overwrite a computed figure.

**Tech Stack:** Next.js (App Router, the repo's pinned version — see `web/AGENTS.md`), React client components, CSS modules with the existing design tokens, the trilingual `i18n.ts` catalog, vitest for the one backend task.

**Verification model:** This repo has **no React test runner** — all vitest suites are backend, against Postgres. So UI page tasks verify through (a) `cd web; npx tsc --noEmit` for type safety and (b) the browser **preview workflow** (preview_start → snapshot/screenshot/console). The one backend task (Task 2) adds thin route wrappers over already-tested phase-1 domain functions and gets a **domain-level** vitest that proves the section-5 append-and-recompute path end to end (the route wrappers themselves are verified by `tsc`, exactly as the phase-1 payroll routes and `parties/[id]` are). Do not invent a React testing setup; match the repo.

**Scope (this plan):** employee list + card, monthly tax-status and opening-history entry, orders list + create + approve, the monthly run (open → compute → exceptions review → approve), payslip detail with the phase-1 explanation trail, and manual adjustments with a mandatory reason.

**Deliberately out of scope (later plans):** employee self-service portal (instr. 2.3, phase 3); order PDF + eParaksts (4.2); VID EDS report UI (3.5); AI helpers (7.x); scheduled auto-run (7.1) — this plan gives the accountant the manual "compute now" button, not the cron. Business-trip orders (4.1) are not built (no backend). Company-level one-time setup (2.1 — company form, collective-agreement norms, structural units) is not built.

**Cross-cutting conventions (verified against the repo, do not deviate):**
- Client id comes from the URL query `?client=<uuid>`, read via `useSearchParams().get('client')`, and is sent to the API as `clientCompanyId`. When absent, render a "select a client" empty state (mirror `tasks.selectClient`).
- Every user-facing string is a key added to **all three** catalogs in `web/app/lib/i18n.ts` (`EN` before line `} as const`, then `LV`, then `RU`). TS fails the build if any language misses a key.
- Sidebar nav items are gated: `ADMIN_ROLES = {'accountant','firm_admin'}`. Payroll is firm-side, so it goes in the admin-gated group.
- Icons are inline stroked SVG (`currentColor`, ~1.5px) added to `NavIcon.tsx`'s `NavIconName` union and `PATHS` map. No emoji.
- API error bodies are `{ error: string }`; on `!res.ok` throw `body.error ?? HTTP <status>`.

---

### Task 1: Scaffolding — i18n keys, nav entry, icon, route folder

**Files:**
- Modify: `web/app/lib/i18n.ts` (add `pay.*` keys + `nav.payroll` / `nav.short.payroll` to EN, LV, RU)
- Modify: `web/app/components/NavIcon.tsx` (add `payroll` icon)
- Modify: `web/app/components/Sidebar.tsx` (add the nav item to the admin-gated group)

- [ ] **Step 1: Add the nav icon**

In `web/app/components/NavIcon.tsx`, add `'payroll'` to the `NavIconName` union and this entry to `PATHS` (a wallet/people glyph, matching the stroked convention):

```tsx
  // Payroll — stylised payslip with a coin
  payroll: (
    <>
      <path d="M4 4.75h9.5A1.25 1.25 0 0114.75 6v9.25A1.25 1.25 0 0113.5 16.5H4A1.25 1.25 0 012.75 15.25V6A1.25 1.25 0 014 4.75z" strokeLinejoin="round" />
      <path d="M5.5 8h6M5.5 11h3.5" strokeLinecap="round" />
      <circle cx="14" cy="13" r="3.25" />
      <path d="M14 11.75v2.5M12.9 13h2.2" strokeLinecap="round" />
    </>
  ),
```

- [ ] **Step 2: Add the i18n keys to all three catalogs**

In `web/app/lib/i18n.ts`, inside the `EN` object (before `} as const;` at line ~225) add the nav keys next to the other `nav.*` entries and this block with the rest of the page groups:

```ts
  'nav.payroll': 'Payroll', 'nav.short.payroll': 'Payroll',
  // Payroll — employees
  'pay.title': 'Payroll',
  'pay.selectClient': 'Select a client to manage payroll.',
  'pay.tab.employees': 'Employees', 'pay.tab.orders': 'Orders', 'pay.tab.runs': 'Payroll runs',
  'pay.emp.title': 'Employees', 'pay.emp.new': 'New employee', 'pay.emp.name': 'Name',
  'pay.emp.personalCode': 'Personal code', 'pay.emp.position': 'Position',
  'pay.emp.contractNo': 'Contract no.', 'pay.emp.contractDate': 'Contract date',
  'pay.emp.contractType': 'Contract type', 'pay.emp.contractType.indefinite': 'Indefinite',
  'pay.emp.contractType.fixed_term': 'Fixed term',
  'pay.emp.wageType': 'Wage type', 'pay.emp.wageType.monthly': 'Monthly', 'pay.emp.wageType.hourly': 'Hourly',
  'pay.emp.wage': 'Wage', 'pay.emp.hiredOn': 'Hired on', 'pay.emp.terminatedOn': 'Terminated on',
  'pay.emp.openingVacationDays': 'Opening vacation days', 'pay.emp.openingBalanceDate': 'Opening balance date',
  'pay.emp.empty': 'No employees yet.', 'pay.emp.emptyDetail': 'Add the people this company pays.',
  'pay.emp.save': 'Save', 'pay.emp.cancel': 'Cancel', 'pay.emp.edit': 'Edit', 'pay.emp.open': 'Open',
  'pay.emp.active': 'Active', 'pay.emp.terminated': 'Terminated',
  // Employee detail — tax status, history, manual inputs (instr. 2.1 / 5)
  'pay.tax.title': 'Monthly tax-book status', 'pay.tax.period': 'Period (YYYY-MM)',
  'pay.tax.bookActive': 'Tax book active here', 'pay.tax.dependents': 'Dependents',
  'pay.tax.disability': 'Disability group', 'pay.tax.none': 'None',
  'pay.tax.save': 'Save status', 'pay.tax.hint': 'Refresh every month from EDS (manual for now, instr. 2.2).',
  'pay.adj.title': 'Manual adjustments', 'pay.adj.hint': 'Corrections are added as components and folded in on the next recompute (instr. 5).',
  'pay.adj.kind': 'Kind', 'pay.adj.amount': 'Amount', 'pay.adj.quantity': 'Hours',
  'pay.adj.reason': 'Reason (required)', 'pay.adj.add': 'Add', 'pay.adj.addAbsence': 'Add absence',
  'pay.adj.absenceType': 'Absence type', 'pay.adj.from': 'From', 'pay.adj.to': 'To',
  'pay.adj.needReason': 'A reason is required for a manual adjustment.',
  // Orders (rīkojumi) — instr. 4
  'pay.ord.title': 'Orders', 'pay.ord.new': 'New order', 'pay.ord.type': 'Type', 'pay.ord.status': 'Status',
  'pay.ord.type.hire': 'Hire', 'pay.ord.type.termination': 'Termination', 'pay.ord.type.bonus': 'Bonus',
  'pay.ord.type.vacation': 'Vacation', 'pay.ord.type.wage_change': 'Wage change',
  'pay.ord.status.draft': 'Draft', 'pay.ord.status.approved': 'Approved',
  'pay.ord.employees': 'Employees', 'pay.ord.amount': 'Amount', 'pay.ord.from': 'From', 'pay.ord.to': 'To',
  'pay.ord.effective': 'Effective date', 'pay.ord.reason': 'Reason', 'pay.ord.severance': 'Pay severance',
  'pay.ord.create': 'Create order', 'pay.ord.approve': 'Approve & apply', 'pay.ord.cancel': 'Cancel',
  'pay.ord.empty': 'No orders yet.', 'pay.ord.emptyDetail': 'Issue an order to change pay or status.',
  'pay.ord.approved': 'Order approved and applied.',
  // Runs — instr. 2.2 / 2.4
  'pay.run.title': 'Payroll runs', 'pay.run.open': 'Open month', 'pay.run.period': 'Period',
  'pay.run.status': 'Status', 'pay.run.status.draft': 'Draft', 'pay.run.status.computed': 'Computed',
  'pay.run.status.approved': 'Approved', 'pay.run.compute': 'Compute', 'pay.run.recompute': 'Recompute',
  'pay.run.approve': 'Approve & post', 'pay.run.open.btn': 'Open',
  'pay.run.empty': 'No payroll runs yet.', 'pay.run.emptyDetail': 'Open a month to compute payroll.',
  'pay.run.exceptions': 'Needs attention', 'pay.run.exceptionsDetail': 'These items have warnings — review before approving.',
  'pay.run.clean': 'No warnings — everything looks normal.',
  'pay.run.employee': 'Employee', 'pay.run.gross': 'Gross', 'pay.run.net': 'Net', 'pay.run.payout': 'Payout',
  'pay.run.warnings': 'Warnings', 'pay.run.detail': 'Payslip', 'pay.run.close': 'Close',
  'pay.run.explanation': 'How this was calculated', 'pay.run.approved': 'Run approved and posted to the journal.',
  'pay.run.computed': 'Run computed. Review exceptions, then approve.',
  'pay.run.allItems': 'All employees',
  // Warning labels (instr. 2.2/2.4)
  'pay.warn.tax_status_missing': 'No tax-book status for this month',
  'pay.warn.tax_status_stale': 'Tax-book status is from an earlier month',
  'pay.warn.below_minimum_wage': 'Below the minimum wage',
  'pay.warn.vsaoi_cap_reached': 'VSAOI annual cap reached',
  'pay.warn.deduction_capped': 'Deductions capped at the legal limit',
  'pay.warn.avg_earnings_fallback': 'No history — average earnings estimated from the wage',
  'pay.warn.avg_earnings_window_shifted': 'Average-earnings window shifted past a long absence',
```

Then add the **same keys** to the `LV` object (after line ~227) and the `RU` object (after line ~453), translated. LV values (use these exact strings):

```ts
  'nav.payroll': 'Algas', 'nav.short.payroll': 'Algas',
  'pay.title': 'Algas',
  'pay.selectClient': 'Izvēlieties klientu, lai pārvaldītu algas.',
  'pay.tab.employees': 'Darbinieki', 'pay.tab.orders': 'Rīkojumi', 'pay.tab.runs': 'Algu aprēķini',
  'pay.emp.title': 'Darbinieki', 'pay.emp.new': 'Jauns darbinieks', 'pay.emp.name': 'Vārds, uzvārds',
  'pay.emp.personalCode': 'Personas kods', 'pay.emp.position': 'Amats',
  'pay.emp.contractNo': 'Līguma nr.', 'pay.emp.contractDate': 'Līguma datums',
  'pay.emp.contractType': 'Līguma veids', 'pay.emp.contractType.indefinite': 'Beztermiņa',
  'pay.emp.contractType.fixed_term': 'Uz noteiktu laiku',
  'pay.emp.wageType': 'Algas veids', 'pay.emp.wageType.monthly': 'Mēnešalga', 'pay.emp.wageType.hourly': 'Stundas likme',
  'pay.emp.wage': 'Alga', 'pay.emp.hiredOn': 'Pieņemts darbā', 'pay.emp.terminatedOn': 'Atlaists',
  'pay.emp.openingVacationDays': 'Sākotnējais atvaļinājuma atlikums (dienas)', 'pay.emp.openingBalanceDate': 'Atlikuma datums',
  'pay.emp.empty': 'Vēl nav darbinieku.', 'pay.emp.emptyDetail': 'Pievienojiet darbiniekus, kuriem uzņēmums maksā algu.',
  'pay.emp.save': 'Saglabāt', 'pay.emp.cancel': 'Atcelt', 'pay.emp.edit': 'Rediģēt', 'pay.emp.open': 'Atvērt',
  'pay.emp.active': 'Aktīvs', 'pay.emp.terminated': 'Atlaists',
  'pay.tax.title': 'Ikmēneša nodokļu grāmatiņas statuss', 'pay.tax.period': 'Periods (GGGG-MM)',
  'pay.tax.bookActive': 'Grāmatiņa aktīva šeit', 'pay.tax.dependents': 'Apgādājamie',
  'pay.tax.disability': 'Invaliditātes grupa', 'pay.tax.none': 'Nav',
  'pay.tax.save': 'Saglabāt statusu', 'pay.tax.hint': 'Atjaunojiet katru mēnesi no EDS (pagaidām manuāli, 2.2. sadaļa).',
  'pay.adj.title': 'Manuālas korekcijas', 'pay.adj.hint': 'Korekcijas tiek pievienotas kā komponentes un iekļautas nākamajā pārrēķinā (5. sadaļa).',
  'pay.adj.kind': 'Veids', 'pay.adj.amount': 'Summa', 'pay.adj.quantity': 'Stundas',
  'pay.adj.reason': 'Pamatojums (obligāts)', 'pay.adj.add': 'Pievienot', 'pay.adj.addAbsence': 'Pievienot prombūtni',
  'pay.adj.absenceType': 'Prombūtnes veids', 'pay.adj.from': 'No', 'pay.adj.to': 'Līdz',
  'pay.adj.needReason': 'Manuālai korekcijai nepieciešams pamatojums.',
  'pay.ord.title': 'Rīkojumi', 'pay.ord.new': 'Jauns rīkojums', 'pay.ord.type': 'Veids', 'pay.ord.status': 'Statuss',
  'pay.ord.type.hire': 'Pieņemšana darbā', 'pay.ord.type.termination': 'Atlaišana', 'pay.ord.type.bonus': 'Prēmija',
  'pay.ord.type.vacation': 'Atvaļinājums', 'pay.ord.type.wage_change': 'Algas izmaiņa',
  'pay.ord.status.draft': 'Melnraksts', 'pay.ord.status.approved': 'Apstiprināts',
  'pay.ord.employees': 'Darbinieki', 'pay.ord.amount': 'Summa', 'pay.ord.from': 'No', 'pay.ord.to': 'Līdz',
  'pay.ord.effective': 'Spēkā no', 'pay.ord.reason': 'Pamatojums', 'pay.ord.severance': 'Maksāt atlaišanas pabalstu',
  'pay.ord.create': 'Izveidot rīkojumu', 'pay.ord.approve': 'Apstiprināt un piemērot', 'pay.ord.cancel': 'Atcelt',
  'pay.ord.empty': 'Vēl nav rīkojumu.', 'pay.ord.emptyDetail': 'Izdodiet rīkojumu, lai mainītu algu vai statusu.',
  'pay.ord.approved': 'Rīkojums apstiprināts un piemērots.',
  'pay.run.title': 'Algu aprēķini', 'pay.run.open': 'Atvērt mēnesi', 'pay.run.period': 'Periods',
  'pay.run.status': 'Statuss', 'pay.run.status.draft': 'Melnraksts', 'pay.run.status.computed': 'Aprēķināts',
  'pay.run.status.approved': 'Apstiprināts', 'pay.run.compute': 'Aprēķināt', 'pay.run.recompute': 'Pārrēķināt',
  'pay.run.approve': 'Apstiprināt un grāmatot', 'pay.run.open.btn': 'Atvērt',
  'pay.run.empty': 'Vēl nav algu aprēķinu.', 'pay.run.emptyDetail': 'Atveriet mēnesi, lai aprēķinātu algas.',
  'pay.run.exceptions': 'Nepieciešama uzmanība', 'pay.run.exceptionsDetail': 'Šiem ierakstiem ir brīdinājumi — pārskatiet pirms apstiprināšanas.',
  'pay.run.clean': 'Nav brīdinājumu — viss izskatās normāli.',
  'pay.run.employee': 'Darbinieks', 'pay.run.gross': 'Bruto', 'pay.run.net': 'Neto', 'pay.run.payout': 'Izmaksa',
  'pay.run.warnings': 'Brīdinājumi', 'pay.run.detail': 'Algas lapiņa', 'pay.run.close': 'Aizvērt',
  'pay.run.explanation': 'Kā tas aprēķināts', 'pay.run.approved': 'Aprēķins apstiprināts un iegrāmatots žurnālā.',
  'pay.run.computed': 'Aprēķins gatavs. Pārskatiet izņēmumus un apstipriniet.',
  'pay.run.allItems': 'Visi darbinieki',
  'pay.warn.tax_status_missing': 'Nav nodokļu grāmatiņas statusa šim mēnesim',
  'pay.warn.tax_status_stale': 'Nodokļu grāmatiņas statuss ir no iepriekšēja mēneša',
  'pay.warn.below_minimum_wage': 'Zem minimālās algas',
  'pay.warn.vsaoi_cap_reached': 'Sasniegti VSAOI gada griesti',
  'pay.warn.deduction_capped': 'Ieturējumi ierobežoti līdz likumīgajam limitam',
  'pay.warn.avg_earnings_fallback': 'Nav vēstures — vidējā izpeļņa aplēsta no algas',
  'pay.warn.avg_earnings_window_shifted': 'Vidējās izpeļņas periods pārbīdīts pāri ilgai prombūtnei',
```

RU values (use these exact strings):

```ts
  'nav.payroll': 'Зарплата', 'nav.short.payroll': 'Зарплата',
  'pay.title': 'Зарплата',
  'pay.selectClient': 'Выберите клиента для управления зарплатой.',
  'pay.tab.employees': 'Сотрудники', 'pay.tab.orders': 'Приказы', 'pay.tab.runs': 'Расчёты зарплаты',
  'pay.emp.title': 'Сотрудники', 'pay.emp.new': 'Новый сотрудник', 'pay.emp.name': 'Имя, фамилия',
  'pay.emp.personalCode': 'Персональный код', 'pay.emp.position': 'Должность',
  'pay.emp.contractNo': 'Номер договора', 'pay.emp.contractDate': 'Дата договора',
  'pay.emp.contractType': 'Тип договора', 'pay.emp.contractType.indefinite': 'Бессрочный',
  'pay.emp.contractType.fixed_term': 'Срочный',
  'pay.emp.wageType': 'Тип оплаты', 'pay.emp.wageType.monthly': 'Оклад', 'pay.emp.wageType.hourly': 'Почасовая',
  'pay.emp.wage': 'Оплата', 'pay.emp.hiredOn': 'Принят', 'pay.emp.terminatedOn': 'Уволен',
  'pay.emp.openingVacationDays': 'Начальный остаток отпуска (дни)', 'pay.emp.openingBalanceDate': 'Дата остатка',
  'pay.emp.empty': 'Пока нет сотрудников.', 'pay.emp.emptyDetail': 'Добавьте людей, которым компания платит зарплату.',
  'pay.emp.save': 'Сохранить', 'pay.emp.cancel': 'Отмена', 'pay.emp.edit': 'Изменить', 'pay.emp.open': 'Открыть',
  'pay.emp.active': 'Активен', 'pay.emp.terminated': 'Уволен',
  'pay.tax.title': 'Ежемесячный статус налоговой книжки', 'pay.tax.period': 'Период (ГГГГ-ММ)',
  'pay.tax.bookActive': 'Книжка активна здесь', 'pay.tax.dependents': 'Иждивенцы',
  'pay.tax.disability': 'Группа инвалидности', 'pay.tax.none': 'Нет',
  'pay.tax.save': 'Сохранить статус', 'pay.tax.hint': 'Обновляйте каждый месяц из EDS (пока вручную, раздел 2.2).',
  'pay.adj.title': 'Ручные корректировки', 'pay.adj.hint': 'Корректировки добавляются как компоненты и учитываются при следующем пересчёте (раздел 5).',
  'pay.adj.kind': 'Вид', 'pay.adj.amount': 'Сумма', 'pay.adj.quantity': 'Часы',
  'pay.adj.reason': 'Основание (обязательно)', 'pay.adj.add': 'Добавить', 'pay.adj.addAbsence': 'Добавить отсутствие',
  'pay.adj.absenceType': 'Тип отсутствия', 'pay.adj.from': 'С', 'pay.adj.to': 'По',
  'pay.adj.needReason': 'Для ручной корректировки требуется основание.',
  'pay.ord.title': 'Приказы', 'pay.ord.new': 'Новый приказ', 'pay.ord.type': 'Тип', 'pay.ord.status': 'Статус',
  'pay.ord.type.hire': 'Приём на работу', 'pay.ord.type.termination': 'Увольнение', 'pay.ord.type.bonus': 'Премия',
  'pay.ord.type.vacation': 'Отпуск', 'pay.ord.type.wage_change': 'Изменение оплаты',
  'pay.ord.status.draft': 'Черновик', 'pay.ord.status.approved': 'Утверждён',
  'pay.ord.employees': 'Сотрудники', 'pay.ord.amount': 'Сумма', 'pay.ord.from': 'С', 'pay.ord.to': 'По',
  'pay.ord.effective': 'Действует с', 'pay.ord.reason': 'Основание', 'pay.ord.severance': 'Выплатить выходное пособие',
  'pay.ord.create': 'Создать приказ', 'pay.ord.approve': 'Утвердить и применить', 'pay.ord.cancel': 'Отмена',
  'pay.ord.empty': 'Пока нет приказов.', 'pay.ord.emptyDetail': 'Издайте приказ для изменения оплаты или статуса.',
  'pay.ord.approved': 'Приказ утверждён и применён.',
  'pay.run.title': 'Расчёты зарплаты', 'pay.run.open': 'Открыть месяц', 'pay.run.period': 'Период',
  'pay.run.status': 'Статус', 'pay.run.status.draft': 'Черновик', 'pay.run.status.computed': 'Рассчитан',
  'pay.run.status.approved': 'Утверждён', 'pay.run.compute': 'Рассчитать', 'pay.run.recompute': 'Пересчитать',
  'pay.run.approve': 'Утвердить и провести', 'pay.run.open.btn': 'Открыть',
  'pay.run.empty': 'Пока нет расчётов зарплаты.', 'pay.run.emptyDetail': 'Откройте месяц для расчёта зарплаты.',
  'pay.run.exceptions': 'Требует внимания', 'pay.run.exceptionsDetail': 'У этих записей есть предупреждения — проверьте перед утверждением.',
  'pay.run.clean': 'Предупреждений нет — всё выглядит нормально.',
  'pay.run.employee': 'Сотрудник', 'pay.run.gross': 'Брутто', 'pay.run.net': 'Нетто', 'pay.run.payout': 'К выплате',
  'pay.run.warnings': 'Предупреждения', 'pay.run.detail': 'Расчётный лист', 'pay.run.close': 'Закрыть',
  'pay.run.explanation': 'Как это рассчитано', 'pay.run.approved': 'Расчёт утверждён и проведён в журнал.',
  'pay.run.computed': 'Расчёт готов. Проверьте исключения и утвердите.',
  'pay.run.allItems': 'Все сотрудники',
  'pay.warn.tax_status_missing': 'Нет статуса налоговой книжки за этот месяц',
  'pay.warn.tax_status_stale': 'Статус налоговой книжки за прошлый месяц',
  'pay.warn.below_minimum_wage': 'Ниже минимальной зарплаты',
  'pay.warn.vsaoi_cap_reached': 'Достигнут годовой потолок VSAOI',
  'pay.warn.deduction_capped': 'Удержания ограничены законным пределом',
  'pay.warn.avg_earnings_fallback': 'Нет истории — средний заработок оценён по окладу',
  'pay.warn.avg_earnings_window_shifted': 'Период среднего заработка сдвинут из-за長 длительного отсутствия',
```

> Note: fix the stray character in the last RU string to `длительного отсутствия` when pasting — written here without the accidental CJK glyph.

- [ ] **Step 3: Add the nav item (admin-gated)**

In `web/app/components/Sidebar.tsx`: extend both `key` and `shortKey` unions in the `NavItem` interface with `'nav.payroll'` / `'nav.short.payroll'`, then add payroll to the admin-gated group so only firm-side roles see it:

```tsx
const ADMIN_ITEMS: NavItem[] = [
  { key: 'nav.payroll', shortKey: 'nav.short.payroll', href: '/payroll', icon: 'payroll' },
  { key: 'nav.settings', shortKey: 'nav.short.settings', href: '/settings', icon: 'settings' },
  ADMIN_ITEM,
];
```

- [ ] **Step 4: Verify types**

Run: `cd web; npx tsc --noEmit`
Expected: exit 0. (If a language is missing a key, TS names it — add it.)

- [ ] **Step 5: Commit**

```bash
git add web/app/lib/i18n.ts web/app/components/NavIcon.tsx web/app/components/Sidebar.tsx
git commit -m "feat(web): payroll nav entry, icon, and trilingual copy scaffolding"
```

---

### Task 2: Backend — manual-adjustment routes (instr. 5) + domain proof

Section 5 wants the accountant to enter corrections directly (a manual premium/bonus, an ad-hoc absence) with a mandatory reason and an audit trail. The phase-1 domain already has `addPayComponent` / `addAbsence` (both audited, both accept a `note`). This task exposes them over HTTP with the reason made mandatory, and proves the "append a correction → recompute folds it in" behaviour with a domain-level test.

**Files:**
- Create: `web/app/api/payroll/employees/[id]/components/route.ts`
- Create: `web/app/api/payroll/employees/[id]/absences/route.ts`
- Test: `tests/payroll/manual-adjustment.test.ts`

- [ ] **Step 1: Write the failing domain test**

```typescript
// tests/payroll/manual-adjustment.test.ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createEmployee, setMonthlyTaxStatus } from '../../src/payroll/employees.js';
import { addPayComponent } from '../../src/payroll/inputs.js';
import { openRun, computeRun, getRunWithItems } from '../../src/payroll/run.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

const EMP = {
  firstName: 'Anna', lastName: 'Ozola', personalCode: '010190-12345', position: 'X',
  contractNo: 'DL-1', contractDate: '2026-01-02', contractType: 'indefinite' as const,
  wageType: 'monthly' as const, wage: '1000.00', hiredOn: '2026-01-02',
  openingVacationDays: '0', openingBalanceDate: '2026-01-02',
};

test('a manual adjustment with a reason is audited and folded in on recompute (instr. 5)', async () => {
  const t = ctx(await makeFirmAndClient());
  const { id: emp } = await withTenant(t, (tx) => createEmployee(tx, t, EMP));
  await withTenant(t, (tx) => setMonthlyTaxStatus(tx, t, emp, {
    year: 2026, month: 7, taxBookActive: true, dependents: 0, disabilityGroup: 0,
  }));

  // First run — clean.
  const { id: runId } = await withTenant(t, (tx) => openRun(tx, t, { year: 2026, month: 7 }));
  await withTenant(t, (tx) => computeRun(tx, t, runId));
  expect((await withTenant(t, (tx) => getRunWithItems(tx, t, runId))).items[0]!.bonus).toBe('0.00');

  // Manual correction with a mandatory reason, then recompute.
  await withTenant(t, (tx) => addPayComponent(tx, t, {
    employeeId: emp, year: 2026, month: 7, kind: 'bonus', amount: '120.00',
    note: 'Manuāla korekcija: aizmirsta prēmija',
  }));
  await withTenant(t, (tx) => computeRun(tx, t, runId));
  expect((await withTenant(t, (tx) => getRunWithItems(tx, t, runId))).items[0]!.bonus).toBe('120.00');

  // The reason is in the audit trail.
  const audit = await withTenant(t, (tx) => tx.query(
    `SELECT after FROM audit_log WHERE client_company_id = $1 AND entity_type = 'pay_component'`,
    [t.clientCompanyId]));
  expect(JSON.stringify(audit.rows[0].after)).toContain('aizmirsta prēmija');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/payroll/manual-adjustment.test.ts`
Expected: PASS actually — this exercises only phase-1 domain code, so it should already pass, confirming the append-and-recompute path the UI relies on. (If it fails, stop: the phase-1 engine regressed.) Treat this test as the guardrail the routes below depend on.

- [ ] **Step 3: Add the component route**

`web/app/api/payroll/employees/[id]/components/route.ts`:

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { addPayComponent, type ComponentKind } from '@domain/payroll/inputs.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    clientCompanyId?: string; year?: number; month?: number; kind?: ComponentKind;
    amount?: string; quantity?: string; reason?: string;
  };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (body.year === undefined || body.month === undefined || !body.kind) {
    return NextResponse.json({ error: 'missing year/month/kind' }, { status: 400 });
  }
  if (!body.reason || !body.reason.trim()) {
    return NextResponse.json({ error: 'a reason is required for a manual adjustment' }, { status: 400 });
  }
  try {
    const tctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(tctx.actorRole, 'payroll.write');
    const result = await withTenant(tctx, (tx) => addPayComponent(tx, tctx, {
      employeeId: id, year: body.year!, month: body.month!, kind: body.kind!,
      ...(body.amount !== undefined && { amount: body.amount }),
      ...(body.quantity !== undefined && { quantity: body.quantity }),
      note: body.reason!.trim(),
    }));
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
```

- [ ] **Step 4: Add the absence route**

`web/app/api/payroll/employees/[id]/absences/route.ts`:

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { addAbsence, type AbsenceType } from '@domain/payroll/inputs.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    clientCompanyId?: string; type?: AbsenceType; dateFrom?: string; dateTo?: string; reason?: string;
  };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.type || !body.dateFrom || !body.dateTo) {
    return NextResponse.json({ error: 'missing type/dateFrom/dateTo' }, { status: 400 });
  }
  try {
    const tctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(tctx.actorRole, 'payroll.write');
    const result = await withTenant(tctx, (tx) => addAbsence(tx, tctx, {
      employeeId: id, type: body.type!, dateFrom: body.dateFrom!, dateTo: body.dateTo!,
      ...(body.reason && body.reason.trim() && { note: body.reason.trim() }),
    }));
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
```

- [ ] **Step 5: Verify**

Run: `npx vitest run tests/payroll/manual-adjustment.test.ts` — PASS.
Run: `cd web; npx tsc --noEmit` — exit 0.

- [ ] **Step 6: Commit**

```bash
git add web/app/api/payroll/employees/[id]/components web/app/api/payroll/employees/[id]/absences tests/payroll/manual-adjustment.test.ts
git commit -m "feat(payroll): manual pay-component/absence routes with mandatory reason (instr. 5)"
```

---

### Task 3: Payroll shell (tabs + shared CSS) and the employees list

The `/payroll` landing is the employees list, with a tab strip to Orders and Runs. All tab links preserve the `?client=` param. A "New employee" form mirrors the parties create form but with the full `NewEmployee` field set.

**Files:**
- Create: `web/app/(cabinet)/payroll/payroll.module.css`
- Create: `web/app/(cabinet)/payroll/PayrollTabs.tsx`
- Create: `web/app/(cabinet)/payroll/page.tsx`

- [ ] **Step 1: Shared CSS**

`web/app/(cabinet)/payroll/payroll.module.css`:

```css
.page { display: flex; justify-content: center; }
.main { width: 100%; max-width: 1040px; padding: var(--space-6) var(--space-5); display: flex; flex-direction: column; gap: var(--space-5); }
.headRow { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; }
.pageHeading { font-size: 1.375rem; font-weight: 600; color: var(--ink); margin: 0; }
.skeletons { display: flex; flex-direction: column; gap: var(--space-4); }

.tabs { display: flex; gap: var(--space-2); border-bottom: 1px solid var(--border); }
.tab { padding: var(--space-2) var(--space-4); font: inherit; color: var(--ink-soft); text-decoration: none; border-bottom: 2px solid transparent; }
.tabActive { color: var(--ink); border-bottom-color: var(--primary); font-weight: 500; }

.primaryBtn { background: var(--primary); color: var(--primary-ink); border: none; border-radius: var(--radius-sm); padding: var(--space-2) var(--space-4); font: inherit; font-weight: 500; cursor: pointer; }
.primaryBtn:disabled { opacity: 0.55; cursor: default; }
.ghostBtn { background: transparent; color: var(--primary-deep); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: var(--space-1) var(--space-3); font: inherit; cursor: pointer; }
.dangerBtn { background: transparent; color: var(--danger); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: var(--space-1) var(--space-3); font: inherit; cursor: pointer; }

.form { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--space-4); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); padding: var(--space-5); }
.field { display: flex; flex-direction: column; gap: var(--space-1); font-size: 0.875rem; color: var(--ink-soft); }
.field input, .field select { font: inherit; color: var(--ink); background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: var(--space-2) var(--space-3); }
.checkField { flex-direction: row; align-items: center; gap: var(--space-2); }
.formActions { grid-column: 1 / -1; display: flex; gap: var(--space-3); }
.formError { grid-column: 1 / -1; color: var(--danger); font-size: 0.875rem; margin: 0; }

.tableWrapper { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); }
.table { width: 100%; border-collapse: collapse; font-size: 0.9375rem; }
.table th { text-align: left; font-weight: 500; color: var(--ink-soft); padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border); }
.table td { padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border); color: var(--ink); }
.table tbody tr:last-child td { border-bottom: none; }
.num { font-variant-numeric: tabular-nums; text-align: right; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.875rem; }
.actionsCell { text-align: right; white-space: nowrap; }

.section { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); padding: var(--space-5); display: flex; flex-direction: column; gap: var(--space-4); }
.sectionTitle { font-size: 1.0625rem; font-weight: 600; color: var(--ink); margin: 0; }
.hint { font-size: 0.8125rem; color: var(--ink-soft); margin: 0; }
.rowActions { display: flex; gap: var(--space-3); align-items: center; }
.statusChip { font-size: 0.75rem; padding: 2px var(--space-2); border-radius: var(--radius-sm); border: 1px solid var(--border); color: var(--ink-soft); }

/* exception / warning surfacing (instr. 2.4) */
.exceptionCard { border: 1px solid var(--warning, #c98a00); border-radius: var(--radius-md); background: color-mix(in srgb, var(--warning, #c98a00) 8%, var(--surface)); padding: var(--space-4); }
.warnRow td { background: color-mix(in srgb, var(--warning, #c98a00) 6%, transparent); }
.warnList { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.warnBadge { font-size: 0.75rem; padding: 2px var(--space-2); border-radius: var(--radius-sm); background: color-mix(in srgb, var(--warning, #c98a00) 18%, transparent); color: var(--ink); }
.okNote { color: var(--ink-soft); font-size: 0.875rem; }

/* payslip detail drawer */
.drawer { position: fixed; inset: 0; background: color-mix(in srgb, black 40%, transparent); display: flex; justify-content: flex-end; z-index: 50; }
.drawerPanel { width: min(520px, 100%); height: 100%; background: var(--surface); padding: var(--space-6) var(--space-5); overflow-y: auto; display: flex; flex-direction: column; gap: var(--space-4); }
.explain { display: flex; flex-direction: column; gap: var(--space-2); }
.explainRow { display: flex; justify-content: space-between; gap: var(--space-4); font-size: 0.9375rem; padding: var(--space-1) 0; border-bottom: 1px dashed var(--border); }
.explainRow span:last-child { font-variant-numeric: tabular-nums; }
```

- [ ] **Step 2: Tab strip**

`web/app/(cabinet)/payroll/PayrollTabs.tsx`:

```tsx
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import styles from './payroll.module.css';

/** Payroll sub-navigation. Preserves the ?client= param on every tab. */
export function PayrollTabs({ client }: { client: string | null }) {
  const pathname = usePathname();
  const { t } = useMessages();
  const q = client ? `?client=${encodeURIComponent(client)}` : '';
  const tabs: { href: string; label: string; match: (p: string) => boolean }[] = [
    { href: `/payroll${q}`, label: t('pay.tab.employees'), match: (p) => p === '/payroll' || p.startsWith('/payroll/employees') },
    { href: `/payroll/orders${q}`, label: t('pay.tab.orders'), match: (p) => p.startsWith('/payroll/orders') },
    { href: `/payroll/runs${q}`, label: t('pay.tab.runs'), match: (p) => p.startsWith('/payroll/runs') },
  ];
  return (
    <nav className={styles.tabs} aria-label={t('pay.title')}>
      {tabs.map((tab) => (
        <Link key={tab.href} href={tab.href}
          className={`${styles.tab}${tab.match(pathname) ? ` ${styles.tabActive}` : ''}`}
          aria-current={tab.match(pathname) ? 'page' : undefined}>
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
```

- [ ] **Step 3: Employees list + create form**

`web/app/(cabinet)/payroll/page.tsx`:

```tsx
'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { EmptyState } from '@/app/components/EmptyState';
import { formatDecimal } from '@/app/lib/format';
import { PayrollTabs } from './PayrollTabs';
import styles from './payroll.module.css';

interface EmployeeRow {
  id: string; firstName: string; lastName: string; personalCode: string; position: string;
  wageType: 'monthly' | 'hourly'; wage: string; hiredOn: string; terminatedOn: string | null;
}
type ContractType = 'indefinite' | 'fixed_term';
type WageType = 'monthly' | 'hourly';
interface FormState {
  firstName: string; lastName: string; personalCode: string; position: string;
  contractNo: string; contractDate: string; contractType: ContractType;
  wageType: WageType; wage: string; hiredOn: string;
  openingVacationDays: string; openingBalanceDate: string;
}
const EMPTY_FORM: FormState = {
  firstName: '', lastName: '', personalCode: '', position: '',
  contractNo: '', contractDate: '', contractType: 'indefinite',
  wageType: 'monthly', wage: '', hiredOn: '', openingVacationDays: '0', openingBalanceDate: '',
};

function EmployeesInner() {
  const searchParams = useSearchParams();
  const { t } = useMessages();
  const client = searchParams.get('client');

  const [rows, setRows] = useState<EmployeeRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/payroll/employees?clientCompanyId=${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setRows((await res.json()).employees);
    } catch (err) {
      setError((err as Error).message ?? t('state.error'));
    } finally { setLoading(false); }
  }, [t]);

  useEffect(() => { if (client) load(client); }, [client, load]);

  async function save() {
    if (!client || !form) return;
    setSaving(true); setSaveError(null);
    try {
      const res = await fetch('/api/payroll/employees', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientCompanyId: client, employee: form }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setForm(null); await load(client);
    } catch (err) {
      setSaveError((err as Error).message ?? t('state.error'));
    } finally { setSaving(false); }
  }

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.headRow}>
          <h1 className={styles.pageHeading}>{t('pay.title')}</h1>
          {client && (
            <button type="button" className={styles.primaryBtn} onClick={() => { setSaveError(null); setForm({ ...EMPTY_FORM }); }}>
              {t('pay.emp.new')}
            </button>
          )}
        </div>
        <PayrollTabs client={client} />

        {!client && <EmptyState message={t('pay.selectClient')} />}

        {client && form && (
          <form className={styles.form} onSubmit={(e) => { e.preventDefault(); save(); }}>
            {([
              ['firstName', 'text'], ['lastName', 'text'], ['personalCode', 'text'], ['position', 'text'],
              ['contractNo', 'text'], ['contractDate', 'date'], ['hiredOn', 'date'],
              ['wage', 'text'], ['openingVacationDays', 'text'], ['openingBalanceDate', 'date'],
            ] as [keyof FormState, string][]).map(([key, type]) => (
              <label key={key} className={styles.field}>
                <span>{t(`pay.emp.${key === 'firstName' || key === 'lastName' ? 'name' : key}` as never)}</span>
                <input type={type} value={form[key]} required={key !== 'openingVacationDays'}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
              </label>
            ))}
            <label className={styles.field}>
              <span>{t('pay.emp.contractType')}</span>
              <select value={form.contractType} onChange={(e) => setForm({ ...form, contractType: e.target.value as ContractType })}>
                <option value="indefinite">{t('pay.emp.contractType.indefinite')}</option>
                <option value="fixed_term">{t('pay.emp.contractType.fixed_term')}</option>
              </select>
            </label>
            <label className={styles.field}>
              <span>{t('pay.emp.wageType')}</span>
              <select value={form.wageType} onChange={(e) => setForm({ ...form, wageType: e.target.value as WageType })}>
                <option value="monthly">{t('pay.emp.wageType.monthly')}</option>
                <option value="hourly">{t('pay.emp.wageType.hourly')}</option>
              </select>
            </label>
            {saveError && <p className={styles.formError} role="alert">{saveError}</p>}
            <div className={styles.formActions}>
              <button type="submit" className={styles.primaryBtn} disabled={saving}>{t('pay.emp.save')}</button>
              <button type="button" className={styles.ghostBtn} onClick={() => setForm(null)}>{t('pay.emp.cancel')}</button>
            </div>
          </form>
        )}

        {client && error && <ErrorState message={error} onRetry={() => load(client)} />}
        {client && !error && loading && <div className={styles.skeletons}><SkeletonCard /><SkeletonCard /></div>}
        {client && !error && !loading && rows && rows.length === 0 && (
          <EmptyState message={t('pay.emp.empty')} detail={t('pay.emp.emptyDetail')} />
        )}
        {client && !error && !loading && rows && rows.length > 0 && (
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">{t('pay.emp.name')}</th>
                  <th scope="col">{t('pay.emp.position')}</th>
                  <th scope="col">{t('pay.emp.wage')}</th>
                  <th scope="col">{t('pay.emp.contractType')}</th>
                  <th scope="col"><span className="sr-only">{t('pay.emp.open')}</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td>{e.lastName} {e.firstName}{e.terminatedOn ? ` · ${t('pay.emp.terminated')}` : ''}</td>
                    <td>{e.position}</td>
                    <td className={styles.num}>{formatDecimal(e.wage)}{e.wageType === 'hourly' ? '/h' : ''}</td>
                    <td>{e.wageType === 'monthly' ? t('pay.emp.wageType.monthly') : t('pay.emp.wageType.hourly')}</td>
                    <td className={styles.actionsCell}>
                      <Link className={styles.ghostBtn} href={`/payroll/employees/${e.id}?client=${encodeURIComponent(client)}`}>
                        {t('pay.emp.open')}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<div className={styles.skeletons}><SkeletonCard /></div>}><EmployeesInner /></Suspense>;
}
```

- [ ] **Step 4: Verify**

Run: `cd web; npx tsc --noEmit` — exit 0.
Preview: `preview_start` the web dev server, open `/payroll?client=<a real client id>`, confirm the tab strip, the "New employee" form saves, and the new row appears. Screenshot for the record. (Get a client id from the running app's client selector or the dev seed.)

- [ ] **Step 5: Commit**

```bash
git add "web/app/(cabinet)/payroll/payroll.module.css" "web/app/(cabinet)/payroll/PayrollTabs.tsx" "web/app/(cabinet)/payroll/page.tsx"
git commit -m "feat(web): payroll shell (tabs) + employees list and create form"
```

---

### Task 4: Employee detail — tax status, edit, manual adjustments (instr. 2.1 + 5)

Deep-linked at `/payroll/employees/[id]`. There is no single-employee GET endpoint (kept the phase-1 API surface unchanged), so this page loads the list and finds the row — acceptable at this scale; note it in a comment. It exposes: wage/position edit (PATCH), monthly tax-book entry (POST tax-status), and manual adjustments — a pay component or an absence, each with a reason (POST components / absences). **Termination is intentionally not here** — it must go through a termination order (Task 5) so the section-3.8 settlement runs; this page links there.

**Files:**
- Create: `web/app/(cabinet)/payroll/employees/[id]/page.tsx`

- [ ] **Step 1: Write the page**

`web/app/(cabinet)/payroll/employees/[id]/page.tsx`:

```tsx
'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { EmptyState } from '@/app/components/EmptyState';
import { PayrollTabs } from '../../PayrollTabs';
import styles from '../../payroll.module.css';

interface EmployeeRow {
  id: string; firstName: string; lastName: string; personalCode: string; position: string;
  wageType: 'monthly' | 'hourly'; wage: string; hiredOn: string; terminatedOn: string | null;
}
type MoneyKind = 'bonus' | 'other_taxable' | 'deduction';
type AbsenceType = 'vacation' | 'sick_a' | 'sick_b' | 'unpaid' | 'other';

function post(url: string, body: unknown) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function DetailInner() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const searchParams = useSearchParams();
  const { t } = useMessages();
  const client = searchParams.get('client');

  const [emp, setEmp] = useState<EmployeeRow | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // Edit
  const [wage, setWage] = useState(''); const [position, setPosition] = useState('');
  // Tax status
  const now = new Date();
  const [period, setPeriod] = useState(`${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`);
  const [bookActive, setBookActive] = useState(true);
  const [dependents, setDependents] = useState('0'); const [disability, setDisability] = useState('0');
  // Manual component
  const [kind, setKind] = useState<MoneyKind>('bonus'); const [amount, setAmount] = useState(''); const [compReason, setCompReason] = useState('');
  // Manual absence
  const [absType, setAbsType] = useState<AbsenceType>('unpaid'); const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [absReason, setAbsReason] = useState('');

  const load = useCallback(async (cid: string) => {
    setLoading(true); setError(null);
    try {
      // No single-employee GET endpoint: load the list and pick this id.
      const res = await fetch(`/api/payroll/employees?clientCompanyId=${encodeURIComponent(cid)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      const found = ((await res.json()).employees as EmployeeRow[]).find((e) => e.id === id) ?? null;
      if (!found) throw new Error('Employee not found');
      setEmp(found); setWage(found.wage); setPosition(found.position);
    } catch (err) { setError((err as Error).message); } finally { setLoading(false); }
  }, [id]);

  useEffect(() => { if (client) load(client); }, [client, load]);

  async function run(fn: () => Promise<Response>, okMsg: string) {
    if (!client) return;
    setMsg(null); setError(null);
    try {
      const res = await fn();
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setMsg(okMsg); await load(client);
    } catch (err) { setError((err as Error).message); }
  }

  const [y, m] = period.split('-').map(Number);

  if (!client) return <div className={styles.page}><main className={styles.main}><PayrollTabs client={null} /><EmptyState message={t('pay.selectClient')} /></main></div>;

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.headRow}>
          <h1 className={styles.pageHeading}>{emp ? `${emp.lastName} ${emp.firstName}` : t('pay.emp.title')}</h1>
          <Link className={styles.ghostBtn} href={`/payroll?client=${encodeURIComponent(client)}`}>{t('pay.run.close')}</Link>
        </div>
        <PayrollTabs client={client} />
        {msg && <p className={styles.hint} role="status">{msg}</p>}
        {error && <ErrorState message={error} onRetry={() => load(client)} />}
        {loading && <div className={styles.skeletons}><SkeletonCard /></div>}

        {emp && (
          <>
            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>{t('pay.emp.edit')}</h2>
              <form className={styles.form} onSubmit={(e) => { e.preventDefault(); run(
                () => fetch(`/api/payroll/employees/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientCompanyId: client, wage, position }) }),
                t('pay.emp.save'));
              }}>
                <label className={styles.field}><span>{t('pay.emp.wage')}</span>
                  <input value={wage} onChange={(e) => setWage(e.target.value)} /></label>
                <label className={styles.field}><span>{t('pay.emp.position')}</span>
                  <input value={position} onChange={(e) => setPosition(e.target.value)} /></label>
                <div className={styles.formActions}><button className={styles.primaryBtn} type="submit">{t('pay.emp.save')}</button></div>
              </form>
            </section>

            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>{t('pay.tax.title')}</h2>
              <p className={styles.hint}>{t('pay.tax.hint')}</p>
              <form className={styles.form} onSubmit={(e) => { e.preventDefault(); run(
                () => post(`/api/payroll/employees/${id}/tax-status`, { clientCompanyId: client, year: y, month: m, taxBookActive: bookActive, dependents: Number(dependents), disabilityGroup: Number(disability) }),
                t('pay.tax.save'));
              }}>
                <label className={styles.field}><span>{t('pay.tax.period')}</span>
                  <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} required /></label>
                <label className={`${styles.field} ${styles.checkField}`}>
                  <input type="checkbox" checked={bookActive} onChange={(e) => setBookActive(e.target.checked)} />
                  <span>{t('pay.tax.bookActive')}</span></label>
                <label className={styles.field}><span>{t('pay.tax.dependents')}</span>
                  <input type="number" min="0" value={dependents} onChange={(e) => setDependents(e.target.value)} /></label>
                <label className={styles.field}><span>{t('pay.tax.disability')}</span>
                  <select value={disability} onChange={(e) => setDisability(e.target.value)}>
                    <option value="0">{t('pay.tax.none')}</option><option value="1">I</option><option value="2">II</option><option value="3">III</option>
                  </select></label>
                <div className={styles.formActions}><button className={styles.primaryBtn} type="submit">{t('pay.tax.save')}</button></div>
              </form>
            </section>

            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>{t('pay.adj.title')}</h2>
              <p className={styles.hint}>{t('pay.adj.hint')}</p>
              <form className={styles.form} onSubmit={(e) => {
                e.preventDefault();
                if (!compReason.trim()) { setError(t('pay.adj.needReason')); return; }
                run(() => post(`/api/payroll/employees/${id}/components`, { clientCompanyId: client, year: y, month: m, kind, amount, reason: compReason }), t('pay.adj.add'));
                setAmount(''); setCompReason('');
              }}>
                <label className={styles.field}><span>{t('pay.tax.period')}</span>
                  <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} required /></label>
                <label className={styles.field}><span>{t('pay.adj.kind')}</span>
                  <select value={kind} onChange={(e) => setKind(e.target.value as MoneyKind)}>
                    <option value="bonus">{t('pay.ord.type.bonus')}</option>
                    <option value="other_taxable">other_taxable</option>
                    <option value="deduction">deduction</option>
                  </select></label>
                <label className={styles.field}><span>{t('pay.adj.amount')}</span>
                  <input value={amount} onChange={(e) => setAmount(e.target.value)} required /></label>
                <label className={styles.field}><span>{t('pay.adj.reason')}</span>
                  <input value={compReason} onChange={(e) => setCompReason(e.target.value)} required /></label>
                <div className={styles.formActions}><button className={styles.primaryBtn} type="submit">{t('pay.adj.add')}</button></div>
              </form>
              <form className={styles.form} onSubmit={(e) => {
                e.preventDefault();
                run(() => post(`/api/payroll/employees/${id}/absences`, { clientCompanyId: client, type: absType, dateFrom: from, dateTo: to, reason: absReason }), t('pay.adj.addAbsence'));
                setFrom(''); setTo(''); setAbsReason('');
              }}>
                <label className={styles.field}><span>{t('pay.adj.absenceType')}</span>
                  <select value={absType} onChange={(e) => setAbsType(e.target.value as AbsenceType)}>
                    <option value="vacation">{t('pay.ord.type.vacation')}</option>
                    <option value="sick_a">sick_a</option><option value="sick_b">sick_b</option>
                    <option value="unpaid">unpaid</option><option value="other">other</option>
                  </select></label>
                <label className={styles.field}><span>{t('pay.adj.from')}</span>
                  <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required /></label>
                <label className={styles.field}><span>{t('pay.adj.to')}</span>
                  <input type="date" value={to} onChange={(e) => setTo(e.target.value)} required /></label>
                <label className={styles.field}><span>{t('pay.adj.reason')}</span>
                  <input value={absReason} onChange={(e) => setAbsReason(e.target.value)} /></label>
                <div className={styles.formActions}><button className={styles.ghostBtn} type="submit">{t('pay.adj.addAbsence')}</button></div>
              </form>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<div className={styles.skeletons}><SkeletonCard /></div>}><DetailInner /></Suspense>;
}
```

- [ ] **Step 2: Verify**

Run: `cd web; npx tsc --noEmit` — exit 0.
Preview: open an employee via the list's "Open"; save a wage change; save a tax-book status for the current month; add a bonus with a reason; confirm success messages and no console errors. Screenshot.

- [ ] **Step 3: Commit**

```bash
git add "web/app/(cabinet)/payroll/employees"
git commit -m "feat(web): employee detail — edit, monthly tax status, manual adjustments (instr. 2.1/5)"
```

---

### Task 5: Orders — list, create, approve (instr. 4)

At `/payroll/orders`. Lists orders with type/status, a create form whose fields adapt to the order type, and an "Approve & apply" button on drafts. Employee pickers load from the employees endpoint. Business-trip orders are not offered (no backend). This is also where termination happens (so the 3.8 settlement runs).

**Files:**
- Create: `web/app/(cabinet)/payroll/orders/page.tsx`

- [ ] **Step 1: Write the page**

`web/app/(cabinet)/payroll/orders/page.tsx`:

```tsx
'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { EmptyState } from '@/app/components/EmptyState';
import { formatDecimal } from '@/app/lib/format';
import { PayrollTabs } from '../PayrollTabs';
import styles from '../payroll.module.css';

type OrderType = 'hire' | 'termination' | 'bonus' | 'vacation' | 'wage_change';
interface OrderRow {
  id: string; orderType: OrderType; status: 'draft' | 'approved'; employeeIds: string[];
  amount: string | null; dateFrom: string | null; dateTo: string | null; effectiveDate: string; reason: string;
}
interface EmployeeRow { id: string; firstName: string; lastName: string; }

const AMOUNT_TYPES = new Set<OrderType>(['bonus', 'wage_change']);
const RANGE_TYPES = new Set<OrderType>(['vacation', 'termination']);

function OrdersInner() {
  const searchParams = useSearchParams();
  const { t } = useMessages();
  const client = searchParams.get('client');

  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [emps, setEmps] = useState<EmployeeRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const [orderType, setOrderType] = useState<OrderType>('bonus');
  const [employeeIds, setEmployeeIds] = useState<string[]>([]);
  const [amount, setAmount] = useState(''); const [dateFrom, setDateFrom] = useState(''); const [dateTo, setDateTo] = useState('');
  const [effectiveDate, setEffectiveDate] = useState(''); const [reason, setReason] = useState(''); const [severance, setSeverance] = useState(false);

  const load = useCallback(async (cid: string) => {
    setLoading(true); setError(null);
    try {
      const [oRes, eRes] = await Promise.all([
        fetch(`/api/payroll/orders?clientCompanyId=${encodeURIComponent(cid)}`, { cache: 'no-store' }),
        fetch(`/api/payroll/employees?clientCompanyId=${encodeURIComponent(cid)}`, { cache: 'no-store' }),
      ]);
      if (!oRes.ok) throw new Error((await oRes.json().catch(() => ({}))).error ?? `HTTP ${oRes.status}`);
      if (!eRes.ok) throw new Error((await eRes.json().catch(() => ({}))).error ?? `HTTP ${eRes.status}`);
      setOrders((await oRes.json()).orders);
      setEmps((await eRes.json()).employees);
    } catch (err) { setError((err as Error).message); } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (client) load(client); }, [client, load]);

  async function create() {
    if (!client) return;
    setMsg(null); setError(null);
    const order: Record<string, unknown> = { orderType, employeeIds, effectiveDate, reason };
    if (AMOUNT_TYPES.has(orderType)) order.amount = amount;
    if (RANGE_TYPES.has(orderType)) { order.dateFrom = dateFrom; order.dateTo = dateTo; }
    if (orderType === 'termination') order.payload = { severance };
    try {
      const res = await fetch('/api/payroll/orders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientCompanyId: client, order }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setOpen(false); setEmployeeIds([]); setAmount(''); setDateFrom(''); setDateTo(''); setEffectiveDate(''); setReason(''); setSeverance(false);
      await load(client);
    } catch (err) { setError((err as Error).message); }
  }

  async function approve(id: string) {
    if (!client) return;
    setMsg(null); setError(null);
    try {
      const res = await fetch(`/api/payroll/orders/${id}/approve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientCompanyId: client }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setMsg(t('pay.ord.approved')); await load(client);
    } catch (err) { setError((err as Error).message); }
  }

  const typeLabel = (ty: OrderType) => t(`pay.ord.type.${ty}` as never);

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.headRow}>
          <h1 className={styles.pageHeading}>{t('pay.ord.title')}</h1>
          {client && <button className={styles.primaryBtn} onClick={() => setOpen(true)}>{t('pay.ord.new')}</button>}
        </div>
        <PayrollTabs client={client} />
        {!client && <EmptyState message={t('pay.selectClient')} />}
        {msg && <p className={styles.hint} role="status">{msg}</p>}
        {client && error && <ErrorState message={error} onRetry={() => load(client)} />}

        {client && open && (
          <form className={styles.form} onSubmit={(e) => { e.preventDefault(); create(); }}>
            <label className={styles.field}><span>{t('pay.ord.type')}</span>
              <select value={orderType} onChange={(e) => setOrderType(e.target.value as OrderType)}>
                {(['bonus', 'vacation', 'wage_change', 'termination', 'hire'] as OrderType[]).map((ty) => (
                  <option key={ty} value={ty}>{typeLabel(ty)}</option>
                ))}
              </select></label>
            <label className={styles.field}><span>{t('pay.ord.employees')}</span>
              <select multiple={orderType === 'bonus'} value={orderType === 'bonus' ? employeeIds : (employeeIds[0] ?? '')}
                onChange={(e) => setEmployeeIds(orderType === 'bonus'
                  ? Array.from(e.target.selectedOptions, (o) => o.value)
                  : [e.target.value])}>
                {orderType !== 'bonus' && <option value="">—</option>}
                {emps.map((emp) => <option key={emp.id} value={emp.id}>{emp.lastName} {emp.firstName}</option>)}
              </select></label>
            {AMOUNT_TYPES.has(orderType) && (
              <label className={styles.field}><span>{t('pay.ord.amount')}</span>
                <input value={amount} onChange={(e) => setAmount(e.target.value)} required /></label>
            )}
            {RANGE_TYPES.has(orderType) && (
              <>
                <label className={styles.field}><span>{t('pay.ord.from')}</span>
                  <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} required /></label>
                <label className={styles.field}><span>{t('pay.ord.to')}</span>
                  <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} required /></label>
              </>
            )}
            {orderType === 'termination' && (
              <label className={`${styles.field} ${styles.checkField}`}>
                <input type="checkbox" checked={severance} onChange={(e) => setSeverance(e.target.checked)} />
                <span>{t('pay.ord.severance')}</span></label>
            )}
            <label className={styles.field}><span>{t('pay.ord.effective')}</span>
              <input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} required /></label>
            <label className={styles.field}><span>{t('pay.ord.reason')}</span>
              <input value={reason} onChange={(e) => setReason(e.target.value)} required /></label>
            <div className={styles.formActions}>
              <button className={styles.primaryBtn} type="submit">{t('pay.ord.create')}</button>
              <button className={styles.ghostBtn} type="button" onClick={() => setOpen(false)}>{t('pay.ord.cancel')}</button>
            </div>
          </form>
        )}

        {client && !error && loading && <div className={styles.skeletons}><SkeletonCard /></div>}
        {client && !error && !loading && orders && orders.length === 0 && (
          <EmptyState message={t('pay.ord.empty')} detail={t('pay.ord.emptyDetail')} />
        )}
        {client && !error && !loading && orders && orders.length > 0 && (
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead><tr>
                <th scope="col">{t('pay.ord.type')}</th><th scope="col">{t('pay.ord.effective')}</th>
                <th scope="col">{t('pay.ord.amount')}</th><th scope="col">{t('pay.ord.status')}</th>
                <th scope="col"><span className="sr-only">{t('pay.ord.approve')}</span></th>
              </tr></thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td>{typeLabel(o.orderType)}</td>
                    <td className={styles.mono}>{o.effectiveDate}</td>
                    <td className={styles.num}>{o.amount ? formatDecimal(o.amount) : '—'}</td>
                    <td><span className={styles.statusChip}>{t(`pay.ord.status.${o.status}` as never)}</span></td>
                    <td className={styles.actionsCell}>
                      {o.status === 'draft'
                        ? <button className={styles.primaryBtn} onClick={() => approve(o.id)}>{t('pay.ord.approve')}</button>
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<div className={styles.skeletons}><SkeletonCard /></div>}><OrdersInner /></Suspense>;
}
```

- [ ] **Step 2: Verify**

Run: `cd web; npx tsc --noEmit` — exit 0.
Preview: create a bonus order for one employee, approve it, confirm it flips to Approved; create a vacation order with a date range and approve. Screenshot the list showing both statuses.

- [ ] **Step 3: Commit**

```bash
git add "web/app/(cabinet)/payroll/orders"
git commit -m "feat(web): orders — list, type-adaptive create form, approve (instr. 4)"
```

---

### Task 6: Payroll runs — list and open a month

At `/payroll/runs`. Lists runs with period + status, an "open month" form, and each row links to the run detail. This is the entry to the monthly cycle (instr. 2.2).

**Files:**
- Create: `web/app/(cabinet)/payroll/runs/page.tsx`

- [ ] **Step 1: Write the page**

`web/app/(cabinet)/payroll/runs/page.tsx`:

```tsx
'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { EmptyState } from '@/app/components/EmptyState';
import { PayrollTabs } from '../PayrollTabs';
import styles from '../payroll.module.css';

interface RunRow { id: string; year: number; month: number; status: 'draft' | 'computed' | 'approved'; }

function RunsInner() {
  const searchParams = useSearchParams();
  const { t } = useMessages();
  const client = searchParams.get('client');

  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = new Date();
  const [period, setPeriod] = useState(`${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`);

  const load = useCallback(async (cid: string) => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/payroll/runs?clientCompanyId=${encodeURIComponent(cid)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setRuns((await res.json()).runs);
    } catch (err) { setError((err as Error).message); } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (client) load(client); }, [client, load]);

  async function openMonth() {
    if (!client) return;
    setError(null);
    const [year, month] = period.split('-').map(Number);
    try {
      const res = await fetch('/api/payroll/runs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientCompanyId: client, year, month }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      await load(client);
    } catch (err) { setError((err as Error).message); }
  }

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.headRow}>
          <h1 className={styles.pageHeading}>{t('pay.run.title')}</h1>
        </div>
        <PayrollTabs client={client} />
        {!client && <EmptyState message={t('pay.selectClient')} />}

        {client && (
          <form className={styles.form} onSubmit={(e) => { e.preventDefault(); openMonth(); }}>
            <label className={styles.field}><span>{t('pay.run.period')}</span>
              <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} required /></label>
            <div className={styles.formActions}><button className={styles.primaryBtn} type="submit">{t('pay.run.open')}</button></div>
          </form>
        )}

        {client && error && <ErrorState message={error} onRetry={() => load(client)} />}
        {client && !error && loading && <div className={styles.skeletons}><SkeletonCard /></div>}
        {client && !error && !loading && runs && runs.length === 0 && (
          <EmptyState message={t('pay.run.empty')} detail={t('pay.run.emptyDetail')} />
        )}
        {client && !error && !loading && runs && runs.length > 0 && (
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead><tr>
                <th scope="col">{t('pay.run.period')}</th><th scope="col">{t('pay.run.status')}</th>
                <th scope="col"><span className="sr-only">{t('pay.emp.open')}</span></th>
              </tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className={styles.mono}>{r.year}-{String(r.month).padStart(2, '0')}</td>
                    <td><span className={styles.statusChip}>{t(`pay.run.status.${r.status}` as never)}</span></td>
                    <td className={styles.actionsCell}>
                      <Link className={styles.ghostBtn} href={`/payroll/runs/${r.id}?client=${encodeURIComponent(client)}`}>{t('pay.emp.open')}</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<div className={styles.skeletons}><SkeletonCard /></div>}><RunsInner /></Suspense>;
}
```

- [ ] **Step 2: Verify**

Run: `cd web; npx tsc --noEmit` — exit 0.
Preview: open the current month, confirm a Draft run row appears and links to the detail. Screenshot.

- [ ] **Step 3: Commit**

```bash
git add "web/app/(cabinet)/payroll/runs/page.tsx"
git commit -m "feat(web): payroll runs list + open-month"
```

---

### Task 7: Run review — the exceptions-first centerpiece (instr. 2.2 + 2.4)

Deep-linked at `/payroll/runs/[id]`. This is the screen the document is built around: after compute, the accountant sees **only what needs attention first** (items carrying warnings, with each warning spelled out), then the full list, can open any payslip to read the phase-1 explanation trail, and approves — which posts to the journal. Recompute picks up any manual adjustments or newly approved orders. Employee names come from the employees list (items carry only ids).

**Files:**
- Create: `web/app/(cabinet)/payroll/runs/[id]/page.tsx`

- [ ] **Step 1: Write the page**

`web/app/(cabinet)/payroll/runs/[id]/page.tsx`:

```tsx
'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { formatDecimal } from '@/app/lib/format';
import { PayrollTabs } from '../../PayrollTabs';
import styles from '../../payroll.module.css';

interface Item {
  employeeId: string; gross: string; net: string; payout: string;
  base: string; premiums: string; bonus: string; vacationPay: string; sickPay: string;
  vsaoiEmployee: string; iin: string; otherDeductions: string; vsaoiEmployer: string; riskDuty: string;
  warnings: string[]; explanation: { step: string; amount: string }[];
}
interface RunData { id: string; year: number; month: number; status: 'draft' | 'computed' | 'approved'; items: Item[] }
interface EmployeeRow { id: string; firstName: string; lastName: string; }

function RunInner() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const searchParams = useSearchParams();
  const { t } = useMessages();
  const client = searchParams.get('client');

  const [run, setRun] = useState<RunData | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<Item | null>(null);

  const load = useCallback(async (cid: string) => {
    setLoading(true); setError(null);
    try {
      const [rRes, eRes] = await Promise.all([
        fetch(`/api/payroll/runs/${id}?clientCompanyId=${encodeURIComponent(cid)}`, { cache: 'no-store' }),
        fetch(`/api/payroll/employees?clientCompanyId=${encodeURIComponent(cid)}`, { cache: 'no-store' }),
      ]);
      if (!rRes.ok) throw new Error((await rRes.json().catch(() => ({}))).error ?? `HTTP ${rRes.status}`);
      if (!eRes.ok) throw new Error((await eRes.json().catch(() => ({}))).error ?? `HTTP ${eRes.status}`);
      setRun((await rRes.json()).run);
      const emps = (await eRes.json()).employees as EmployeeRow[];
      setNames(Object.fromEntries(emps.map((e) => [e.id, `${e.lastName} ${e.firstName}`])));
    } catch (err) { setError((err as Error).message); } finally { setLoading(false); }
  }, [id]);

  useEffect(() => { if (client) load(client); }, [client, load]);

  async function act(path: string, okMsg: string) {
    if (!client) return;
    setBusy(true); setMsg(null); setError(null);
    try {
      const res = await fetch(`/api/payroll/runs/${id}/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientCompanyId: client }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setMsg(okMsg); await load(client);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  const warnLabel = (w: string) => { const k = `pay.warn.${w}`; const s = t(k as never); return s === k ? w : s; };
  const name = (eid: string) => names[eid] ?? eid;

  const exceptions = useMemo(() => run?.items.filter((i) => i.warnings.length > 0) ?? [], [run]);

  if (!client) return <div className={styles.page}><main className={styles.main}><PayrollTabs client={null} /></main></div>;

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.headRow}>
          <h1 className={styles.pageHeading}>
            {run ? `${run.year}-${String(run.month).padStart(2, '0')}` : t('pay.run.title')}
            {run && <span className={styles.statusChip} style={{ marginLeft: 12 }}>{t(`pay.run.status.${run.status}` as never)}</span>}
          </h1>
          <Link className={styles.ghostBtn} href={`/payroll/runs?client=${encodeURIComponent(client)}`}>{t('pay.run.close')}</Link>
        </div>
        <PayrollTabs client={client} />
        {msg && <p className={styles.hint} role="status">{msg}</p>}
        {error && <ErrorState message={error} onRetry={() => load(client)} />}
        {loading && <div className={styles.skeletons}><SkeletonCard /></div>}

        {run && (
          <>
            <div className={styles.rowActions}>
              {run.status !== 'approved' && (
                <button className={styles.primaryBtn} disabled={busy} onClick={() => act('compute', t('pay.run.computed'))}>
                  {run.status === 'draft' ? t('pay.run.compute') : t('pay.run.recompute')}
                </button>
              )}
              {run.status === 'computed' && (
                <button className={styles.primaryBtn} disabled={busy} onClick={() => act('approve', t('pay.run.approved'))}>
                  {t('pay.run.approve')}
                </button>
              )}
            </div>

            {run.items.length > 0 && (
              <section className={styles.section}>
                <h2 className={styles.sectionTitle}>{t('pay.run.exceptions')}</h2>
                {exceptions.length === 0
                  ? <p className={styles.okNote}>{t('pay.run.clean')}</p>
                  : (
                    <>
                      <p className={styles.hint}>{t('pay.run.exceptionsDetail')}</p>
                      {exceptions.map((i) => (
                        <div key={i.employeeId} className={styles.exceptionCard}>
                          <div className={styles.headRow}>
                            <strong>{name(i.employeeId)}</strong>
                            <button className={styles.ghostBtn} onClick={() => setDetail(i)}>{t('pay.run.detail')}</button>
                          </div>
                          <div className={styles.warnList}>
                            {i.warnings.map((w) => <span key={w} className={styles.warnBadge}>{warnLabel(w)}</span>)}
                          </div>
                        </div>
                      ))}
                    </>
                  )}
              </section>
            )}

            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>{t('pay.run.allItems')}</h2>
              <div className={styles.tableWrapper}>
                <table className={styles.table}>
                  <thead><tr>
                    <th scope="col">{t('pay.run.employee')}</th>
                    <th scope="col" className={styles.num}>{t('pay.run.gross')}</th>
                    <th scope="col" className={styles.num}>{t('pay.run.net')}</th>
                    <th scope="col" className={styles.num}>{t('pay.run.payout')}</th>
                    <th scope="col">{t('pay.run.warnings')}</th>
                    <th scope="col"><span className="sr-only">{t('pay.run.detail')}</span></th>
                  </tr></thead>
                  <tbody>
                    {run.items.map((i) => (
                      <tr key={i.employeeId} className={i.warnings.length > 0 ? styles.warnRow : undefined}>
                        <td>{name(i.employeeId)}</td>
                        <td className={styles.num}>{formatDecimal(i.gross)}</td>
                        <td className={styles.num}>{formatDecimal(i.net)}</td>
                        <td className={styles.num}>{formatDecimal(i.payout)}</td>
                        <td>{i.warnings.length > 0 ? i.warnings.length : '—'}</td>
                        <td className={styles.actionsCell}>
                          <button className={styles.ghostBtn} onClick={() => setDetail(i)}>{t('pay.run.detail')}</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}

        {detail && (
          <div className={styles.drawer} role="dialog" aria-modal="true" onClick={() => setDetail(null)}>
            <div className={styles.drawerPanel} onClick={(e) => e.stopPropagation()}>
              <div className={styles.headRow}>
                <h2 className={styles.sectionTitle}>{name(detail.employeeId)}</h2>
                <button className={styles.ghostBtn} onClick={() => setDetail(null)}>{t('pay.run.close')}</button>
              </div>
              {detail.warnings.length > 0 && (
                <div className={styles.warnList}>
                  {detail.warnings.map((w) => <span key={w} className={styles.warnBadge}>{warnLabel(w)}</span>)}
                </div>
              )}
              <h3 className={styles.hint}>{t('pay.run.explanation')}</h3>
              <div className={styles.explain}>
                {detail.explanation.map((line, idx) => (
                  <div key={idx} className={styles.explainRow}><span>{line.step}</span><span>{formatDecimal(line.amount)}</span></div>
                ))}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<div className={styles.skeletons}><SkeletonCard /></div>}><RunInner /></Suspense>;
}
```

- [ ] **Step 2: Verify (full monthly cycle in the preview)**

Run: `cd web; npx tsc --noEmit` — exit 0.
Preview the whole instr-2.2 loop against a seeded client with at least one employee and an **open accounting period** for the month:
1. Open the month (Task 6), open the run.
2. Click **Compute** → status becomes Computed; an item appears. If the employee has no tax-book status, it shows in "Needs attention" with `tax_status_missing`.
3. Set the employee's tax status (employee detail), come back, **Recompute** → the warning clears.
4. Open a **Payslip** → the explanation trail lists the bruto→neto steps with amounts.
5. Click **Approve & post** → status becomes Approved; confirm two journal entries per employee exist (check `/journal` or the DB).
Capture a screenshot of the exceptions view and of an approved run.

- [ ] **Step 3: Commit**

```bash
git add "web/app/(cabinet)/payroll/runs/[id]"
git commit -m "feat(web): run review — exceptions-first, payslip explanation, approve & post (instr. 2.2/2.4)"
```

---

### Task 8: Full verification + docs

- [ ] **Step 1: Typecheck and test everything**

```bash
cd web && npx tsc --noEmit          # exit 0
cd .. && npx tsc --noEmit           # exit 0 (Task 2's routes)
npm test                            # backend suite still green (256+ tests, incl. the Task 2 guardrail)
```

Fix anything red before continuing.

- [ ] **Step 2: End-to-end preview smoke**

With the dev server running and a seeded client that has an open accounting period: walk employees → orders → runs exactly as in Task 7 Step 2, plus confirm the Sidebar shows **Payroll** only for accountant/firm_admin (sign in as an `owner` or client `employee` and confirm it is hidden). Capture one screenshot of the approved run for the record.

- [ ] **Step 3: Update HANDOFF.md**

In `HANDOFF.md`, extend the payroll bullet's "still open" list — remove "payroll UI pages" from it and add a shipped note:

```markdown
  Phase-2 operator UI shipped (see
  `docs/superpowers/plans/2026-07-09-payroll-phase2-operator-ui.md`): employees,
  orders, and the monthly run with an exceptions-first review, payslip
  explanation, and approve→post — plus manual adjustments with a mandatory
  reason (instr. 5). Still open: VID EDS report UI (3.5), order PDF + eParaksts
  (4.2), employee self-service (2.3), AI helpers (7.x), scheduled auto-run (7.1),
  business-trip orders, company-level setup (2.1).
```

- [ ] **Step 4: Commit**

```bash
git add HANDOFF.md
git commit -m "docs: mark payroll phase-2 operator UI shipped in HANDOFF"
```

---

## Execution notes

- **Dev server / preview:** if `.claude/launch.json` has no web entry, add one (`npm run dev` in `web/`, its port) so `preview_start` works. All UI verification is preview-based — there is no React test runner in this repo, by design.
- **A client id is required in the URL.** Every payroll page reads `?client=<uuid>`. Use the app's client selector, or grab a seeded client id from the dev bootstrap, and keep it in the URL as you navigate (the tab strip preserves it).
- **The monthly cycle needs an open accounting period** for the target month, or `Approve & post` fails the `postEntry` period guard (correctly). Open it under `/settings` (admin) before approving.
- **`web/AGENTS.md` caveat:** this Next version may differ from training data. The route and page shapes here mirror files that already compile in the repo (`parties/[id]/route.ts`, `parties/page.tsx`); if a signature is rejected, read `web/node_modules/next/dist/docs/` and match the existing files rather than guessing.
- **Do not push** without the user's explicit per-session approval. Commit locally per task.
- **Order of tasks matters:** Task 1 (i18n keys) must land before any page task, or `t(...)` calls reference missing keys and `tsc` fails on the `MsgKey` union.

## What this plan does NOT cover (next plans)

VID EDS payroll report UI (instr. 3.5), order PDF + eParaksts signing (4.2), employee self-service portal (2.3), the AI helper layer (7.x), scheduled auto-run (7.1), business-trip orders, and company-level one-time setup (2.1). After this plan, sections **2.2, 2.4, and 5 are covered**; the remaining open items are those listed here.







