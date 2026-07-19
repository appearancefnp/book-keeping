# LR public-holiday calendar — shared module + payroll workdays — design

Date: 2026-07-19. Status: approved for planning.

## Goal

Finish the LR public-holiday work: the VID half already shipped
(`src/einvoice/holidays.ts`, commit `6de4df0`, consumed by `addWorkingDays`).
This feature (1) fixes a statutory gap in that calendar (observed-day rule),
(2) promotes it to a shared module, (3) makes payroll's workday math
holiday-aware everywhere, and (4) clears the now-stale HANDOFF/comment notes.

## Decisions (made during brainstorming)

- **Payroll scope: holiday-aware everywhere.** `isWorkDay` (and therefore
  `workDaysInMonth`/`workDaysOverlap` and all their consumers — salary
  proration, absence workdays, average-earnings divisor, vacation accrual)
  subtract LR public holidays. This is what "darba dienas" means in LR law.
  Posted historical runs are untouched (ledger is append-only); only future
  runs compute differently.
- **Module placement: move to `src/calendar/holidays.ts`** (approach A). Only
  two files import the current module, so no compatibility shim — imports are
  updated. Rejected: leaving it in `src/einvoice/` (payroll → einvoice is a
  misleading dependency; the "for VID" header stops being true); a DB table
  (statutory + computable, the injectable predicate already allows future
  overrides — YAGNI).

## 1. Calendar module — `src/calendar/holidays.ts` (moved from `src/einvoice/`)

Exports unchanged: `easterSunday(year)`, `latvianHolidays(year): Set<string>`,
`isLatvianHoliday(date: string): boolean` (memoised per year).

**New statutory rule (the gap):** per "Par svētku, atceres un atzīmējamām
dienām", when **May 4** or **November 18** falls on a Saturday or Sunday, the
**following Monday** is a holiday. `latvianHolidays` adds that Monday to the
year's set. (No collision with other holidays is possible: Easter Monday falls
Mar 23–Apr 26; the fixed dates don't neighbour these Mondays.) All other
holidays do not shift.

Header comment rewritten: shared LR statutory calendar (VID due dates +
payroll workdays), not "for VID working-day due-date calculation".

`src/einvoice/holidays.ts` is **deleted**. Import updates:
`src/einvoice/vid.ts` and `tests/einvoice/holidays.test.ts` (test file moves
to `tests/calendar/holidays.test.ts`, mirroring `src/`).

## 2. Payroll wiring — `src/payroll/workdays.ts`

```ts
export function isWorkDay(iso: string): boolean {
  const dow = new Date(toUtc(iso)).getUTCDay();
  return dow !== 0 && dow !== 6 && !isLatvianHoliday(iso);
}
```

No other signature changes; `workDaysInMonth`/`workDaysOverlap` call
`isWorkDay` and inherit the behavior, which transitively corrects:

- `run.ts` — monthly salary proration and absence workday counts,
- `average-earnings.ts` — the daily-average divisor (and its monthly variant),
- `accrual.ts` — vacation workdays used.

The stale header comment ("LR public holidays are NOT yet subtracted — same
documented deferral as addWorkingDays()") is removed. Existing payroll test
fixtures get **re-derived expectations** where their months contain weekday
holidays (June: 23/24; December: 24/25/26/31; January: 1; May: 1/4; November:
18; Easter cluster). Fixtures whose months have no weekday holidays are
unaffected.

## 3. Docs

`HANDOFF.md`:
- §2 (VID) notes at ~lines 172 and 186 ("skips weekends only — LR public
  holidays are deferred" / "needs the LR public-holiday calendar") — marked
  **FIXED**: calendar shipped in `6de4df0`, observed-day rule + payroll
  wiring in this change.
- §5 payroll open-items list (~line 286): "LR public-holiday calendar (shared
  gap with `vid.ts`)" — removed/marked fixed.

## 4. Testing

- **Calendar** (`tests/calendar/holidays.test.ts`, moved + extended):
  existing assertions unchanged; new observed-day cases —
  `latvianHolidays(2025)` contains `2025-05-05` (May 4 = Sunday);
  `latvianHolidays(2028)` contains `2028-11-20` (Nov 18 = Saturday);
  `latvianHolidays(2026)` contains no `2026-05-05` (May 4 = Monday) and no
  `2026-11-19` (Nov 18 = Wednesday); `isLatvianHoliday('2025-05-05')` true.
- **Payroll workdays**: direct assertions — `workDaysInMonth(2026, 12)`
  (Dec 2026: 23 Mon–Fri days minus 24 (Thu), 25 (Fri), 31 (Thu) → 20;
  26 Dec is a Saturday), `workDaysInMonth(2026, 6)` (Jun 23 Tue, 24 Wed
  subtracted), and a `workDaysOverlap` window spanning a holiday.
- **Payroll suites**: re-derive affected expectations in run/accrual/
  average-earnings tests; every changed number justified in-line by naming the
  holiday(s) that moved it.
- **VID**: `tests/einvoice/vid-deadlines.test.ts` passes unchanged (only the
  import path inside `vid.ts` moves).

## Acceptance

1. `latvianHolidays(2025)` includes the observed May 5; 2028 includes Nov 20;
   2026 gains no observed days.
2. A December 2026 payroll run prorates over 20 workdays, not 23.
3. VID due-date behavior identical to before this change (calendar content
   for 2026 has no observed days, so no VID expectation shifts).
4. `npm test` (root) and `npx tsc --noEmit` in root and `web/` all clean.

## Out of scope (explicit)

Per-client holiday overrides, non-Latvian calendars, remembrance days
(atzīmējamās dienas — not public holidays), retro-recomputation of posted
payroll runs, a holidays DB table, and any UI surface.
