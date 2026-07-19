# LR Holiday Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the LR public-holiday calendar to a shared module, add the statutory May-4/Nov-18 observed-Monday rule, and make payroll's workday math holiday-aware.

**Architecture:** Move `src/einvoice/holidays.ts` → `src/calendar/holidays.ts` (pure, computed per-year, no DB), extend `latvianHolidays` with the observed-day rule, and add `!isLatvianHoliday(iso)` to `src/payroll/workdays.ts` `isWorkDay` — every payroll consumer (proration, absences, averages, accrual) inherits the fix through unchanged signatures.

**Tech Stack:** TypeScript ESM (`.js` import suffixes), vitest (real DB for payroll suites, pure for calendar).

**Spec:** `docs/superpowers/specs/2026-07-19-lr-holiday-calendar-design.md` — read it first.

## Global Constraints

- `src/` imports use `.js` suffixes (ESM); tests mirror `src/` layout under `tests/`.
- No new dependencies, no migrations, no UI, no DB table — the calendar stays a pure computed module with the injectable-predicate escape hatch.
- Posted historical payroll runs are never recomputed; only test fixtures change.
- Every re-derived test expectation MUST carry an inline comment naming the holiday(s) that changed it.
- Before declaring done: `npm test` (root), `npx tsc --noEmit` (root), `cd web && npx tsc --noEmit` (web is untouched but the gate is house convention).

**Weekday-holiday reference for re-deriving fixtures** (verified; Easter 2025 = Apr 20, Easter 2026 = Apr 5):

| Year | Weekday holidays (those that can affect a Mon–Fri count) |
|---|---|
| 2025 | Jan 1 (Wed), Apr 18 (Fri, Good Fri), Apr 21 (Mon, Easter Mon), May 1 (Thu), **May 5 (Mon, observed May 4** — May 4 is a Sunday**)**, Jun 23 (Mon), Jun 24 (Tue), Nov 18 (Tue), Dec 24 (Wed), Dec 25 (Thu), Dec 26 (Fri), Dec 31 (Wed) |
| 2026 | Jan 1 (Thu), Apr 3 (Fri, Good Fri), Apr 6 (Mon, Easter Mon), May 1 (Fri), May 4 (Mon), Jun 23 (Tue), Jun 24 (Wed), Nov 18 (Wed), Dec 24 (Thu), Dec 25 (Fri), Dec 31 (Thu) — Dec 26 is a Saturday; no observed days in 2026 |

---

### Task 1: Shared calendar module + observed-Monday rule

**Files:**
- Move: `src/einvoice/holidays.ts` → `src/calendar/holidays.ts` (git mv, then edit)
- Move: `tests/einvoice/holidays.test.ts` → `tests/calendar/holidays.test.ts` (git mv, then edit)
- Modify: `src/einvoice/vid.ts:4` (import path only)

**Interfaces:**
- Consumes: nothing new.
- Produces (Task 2 imports this): `isLatvianHoliday(date: string): boolean` from `src/calendar/holidays.js`; also `latvianHolidays(year: number): Set<string>`, `easterSunday(year: number): string` (unchanged signatures).

- [ ] **Step 1: Move both files with git mv**

```bash
mkdir -p src/calendar tests/calendar
git mv src/einvoice/holidays.ts src/calendar/holidays.ts
git mv tests/einvoice/holidays.test.ts tests/calendar/holidays.test.ts
```

- [ ] **Step 2: Fix the two import paths**

`src/einvoice/vid.ts` line 4: `import { isLatvianHoliday } from './holidays.js';` → `import { isLatvianHoliday } from '../calendar/holidays.js';`

`tests/calendar/holidays.test.ts` line 2: `from '../../src/einvoice/holidays.js'` → `from '../../src/calendar/holidays.js'`

- [ ] **Step 3: Run existing tests to confirm the move is clean**

Run: `npx vitest run tests/calendar/holidays.test.ts tests/einvoice/vid-deadlines.test.ts`
Expected: PASS (nothing behavioral changed yet).

- [ ] **Step 4: Write the failing observed-day tests**

Append to `tests/calendar/holidays.test.ts` inside the `latvianHolidays` describe:

```ts
  test('May 4 falling on a weekend adds the following Monday (2025: May 4 = Sunday)', () => {
    const set = latvianHolidays(2025);
    expect(set.has('2025-05-04')).toBe(true);  // the day itself stays a holiday
    expect(set.has('2025-05-05')).toBe(true);  // observed Monday
  });

  test('Nov 18 falling on a Saturday adds the following Monday (2028: Nov 18 = Saturday)', () => {
    const set = latvianHolidays(2028);
    expect(set.has('2028-11-20')).toBe(true);
  });

  test('no observed days in a year where May 4 and Nov 18 are weekdays (2026)', () => {
    const set = latvianHolidays(2026);
    expect(set.has('2026-05-05')).toBe(false); // May 4 2026 is a Monday
    expect(set.has('2026-11-19')).toBe(false); // Nov 18 2026 is a Wednesday
  });

  test('isLatvianHoliday sees the observed Monday', () => {
    expect(isLatvianHoliday('2025-05-05')).toBe(true);
  });
```

- [ ] **Step 5: Run to verify they fail**

Run: `npx vitest run tests/calendar/holidays.test.ts`
Expected: FAIL — `2025-05-05` / `2028-11-20` not in set.

- [ ] **Step 6: Implement the rule and rewrite the header**

In `src/calendar/holidays.ts`, replace the top-of-file comment block with:

```ts
/**
 * Shared LR statutory public-holiday calendar ("Par svētku, atceres un atzīmējamām dienām").
 * Consumers: VID working-day due dates (src/einvoice/vid.ts) and payroll workday math
 * (src/payroll/workdays.ts). Computed per-year — fixed dates, Easter-derived movable
 * feasts, and the observed-Monday rule (when May 4 or Nov 18 falls on a weekend, the
 * following Monday is a holiday) — so no table needs maintaining. `addWorkingDays`
 * takes an injectable `isHoliday` predicate, so the exact list stays confirmable/
 * adjustable with the accountant (spec §10.1) without touching the arithmetic.
 *
 * NOTE: Easter Sunday and Whit Sunday are Sundays by construction — included for
 * completeness/reuse; they never affect a working-day count.
 */
```

Below `shiftIso`, add:

```ts
/** The following Monday when `date` falls on a weekend, else null (May 4 / Nov 18 rule). */
function observedMonday(date: string): string | null {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (dow === 6) return shiftIso(date, 2); // Saturday → Monday
  if (dow === 0) return shiftIso(date, 1); // Sunday → Monday
  return null;
}
```

In `latvianHolidays`, build the set as today, then before returning:

```ts
  const set = new Set<string>([ /* ...existing entries unchanged... */ ]);
  // Observed-Monday rule: only May 4 and Nov 18 shift when they fall on a weekend.
  for (const d of [iso(year, 5, 4), iso(year, 11, 18)]) {
    const observed = observedMonday(d);
    if (observed) set.add(observed);
  }
  return set;
```

(Refactor the existing `return new Set<string>([...])` into `const set = ...; return set;` — entries themselves unchanged.)

- [ ] **Step 7: Run to verify pass**

Run: `npx vitest run tests/calendar/holidays.test.ts tests/einvoice/`
Expected: PASS — new rule in, VID tests untouched.

- [ ] **Step 8: Commit**

```bash
git add -A src/calendar src/einvoice tests/calendar
git commit -m "feat(calendar): shared LR holiday module with May 4 / Nov 18 observed-Monday rule"
```

---

### Task 2: Holiday-aware payroll workdays + fixture re-derivation

**Files:**
- Modify: `src/payroll/workdays.ts` (header + `isWorkDay`)
- Modify: `tests/payroll/workdays.test.ts` (new direct assertions; re-derive existing if affected)
- Modify: whichever of `tests/payroll/{run-compute,run-approve,absence-pay,accrual,average-earnings,termination}.test.ts` fail after the change — re-derive expectations using the reference table in Global Constraints

**Interfaces:**
- Consumes: `isLatvianHoliday` from `src/calendar/holidays.js` (Task 1).
- Produces: no signature changes — `isWorkDay`, `workDaysInMonth`, `workDaysOverlap` keep their exact shapes; only values change.

- [ ] **Step 1: Write the failing direct tests**

Append to `tests/payroll/workdays.test.ts`:

```ts
test('workDaysInMonth subtracts weekday holidays — December 2026', () => {
  // 23 Mon–Fri days − Dec 24 (Thu), 25 (Fri), 31 (Thu); Dec 26 is a Saturday.
  expect(workDaysInMonth(2026, 12)).toBe(20);
});

test('workDaysInMonth subtracts Līgo/Jāņi — June 2026', () => {
  // 22 Mon–Fri days − Jun 23 (Tue) − Jun 24 (Wed).
  expect(workDaysInMonth(2026, 6)).toBe(20);
});

test('workDaysOverlap skips holidays inside the window', () => {
  // 2026-04-01 (Wed) .. 2026-04-10 (Fri): 8 weekdays − Good Friday (Apr 3) − Easter Monday (Apr 6).
  expect(workDaysOverlap('2026-04-01', '2026-04-10', 2026, 4)).toBe(6);
});

test('isWorkDay is false on a weekday holiday and on the observed Monday', () => {
  expect(isWorkDay('2026-12-25')).toBe(false); // Christmas, Friday
  expect(isWorkDay('2025-05-05')).toBe(false); // observed May 4 (Sunday → Monday)
  expect(isWorkDay('2026-12-28')).toBe(true);  // plain Monday
});
```

(Import `isWorkDay` in that test file if not already imported.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/payroll/workdays.test.ts`
Expected: FAIL — counts come back 23/22/8 and `isWorkDay` true on holidays.

- [ ] **Step 3: Implement**

`src/payroll/workdays.ts` — replace the header comment and `isWorkDay`:

```ts
/**
 * Workday calendar: Mon–Fri excluding LR public holidays (src/calendar/holidays.ts).
 * All dates are ISO 'YYYY-MM-DD' strings, handled in UTC.
 */

import { isLatvianHoliday } from '../calendar/holidays.js';

const DAY_MS = 86_400_000;
```

```ts
export function isWorkDay(iso: string): boolean {
  const dow = new Date(toUtc(iso)).getUTCDay();
  return dow !== 0 && dow !== 6 && !isLatvianHoliday(iso);
}
```

Everything else in the file is unchanged.

- [ ] **Step 4: Run the direct tests, then the whole payroll suite**

Run: `npx vitest run tests/payroll/workdays.test.ts` → PASS.
Run: `npx vitest run tests/payroll/` → expect FAILURES in fixtures whose months contain weekday holidays. That is the re-derivation worklist — do not touch tests that pass.

- [ ] **Step 5: Re-derive each failing expectation**

For every failing assertion: identify the fixture's month(s), look up the weekday holidays in the Global Constraints reference table, recompute the expected value by hand (workday counts change the proration divisor/absence counts/daily-average divisor — the formulas themselves are unchanged), update the expectation, and add an inline comment naming the holiday(s), e.g.:

```ts
// 20 workdays in 2026-06 (22 Mon–Fri − Jun 23 Līgo − Jun 24 Jāņi)
```

Rules:
- The NUMBER changes, never the formula or the production code. If a recomputed value seems to require changing domain code, STOP and report BLOCKED — that means a real bug, not a fixture drift.
- If a fixture's month has no weekday holiday but the test still fails, STOP and report BLOCKED with the failure output.
- Prefer moving a fixture to a holiday-free month ONLY if the test's intent is generic (e.g. "prorates a mid-month start") and the comment says so; tests whose intent involves specific months keep their months.

- [ ] **Step 6: Run the payroll suite until green**

Run: `npx vitest run tests/payroll/`
Expected: PASS, every changed number carrying its holiday comment.

- [ ] **Step 7: Commit**

```bash
git add src/payroll/workdays.ts tests/payroll/
git commit -m "feat(payroll): workday math excludes LR public holidays — proration, absences, averages, accrual"
```

---

### Task 3: HANDOFF cleanup + full verification

**Files:**
- Modify: `HANDOFF.md` (three spots; find exact lines with `grep -n -i holiday HANDOFF.md`)

**Interfaces:** none (docs).

- [ ] **Step 1: Update the three stale HANDOFF notes**

1. VID "What exists" bullet (~line 171): replace `(⚠️ **skips weekends only — LR public holidays are deferred**; wire in the holiday calendar here)` with `(skips weekends **and** LR public holidays — shared calendar `src/calendar/holidays.ts`, incl. the May 4 / Nov 18 observed-Monday rule)`.
2. VID "What to build" bullet (~line 186): wrap in strikethrough and mark fixed, house style: `~~The 5-day due-date calc needs the **LR public-holiday calendar** (currently only weekends are skipped).~~ **FIXED 2026-07-19** — shared `src/calendar/holidays.ts` (observed-Monday rule included), also wired into payroll workdays.`
3. Payroll open-items list (~line 286): delete the item `LR public-holiday calendar (shared gap with `vid.ts`),` from the comma list (the surrounding items stay).

- [ ] **Step 2: Full gates**

```bash
npm test && npx tsc --noEmit && (cd web && npx tsc --noEmit)
```

Expected: full suite green (calendar tests moved + extended, payroll re-derived), both typechecks clean. (Web build not needed — no web files touched.)

- [ ] **Step 3: Commit**

```bash
git add HANDOFF.md
git commit -m "docs: LR holiday calendar shipped — close VID + payroll holiday notes in HANDOFF"
```

---

## Self-Review Notes (already applied)

- Spec coverage: §1 calendar move + rule → T1; §2 payroll → T2; §3 docs → T3; §4 testing split across T1/T2; acceptance 1–2 → T1/T2 tests, 3 → T1 Step 3 + full suite, 4 → T3 Step 2.
- The fixture re-derivation in T2 Step 5 is a discovery step by necessity (the failing set is only knowable by running the suite) — the method, the reference data, and the STOP conditions are fully specified, so it is not a placeholder.
- Type consistency: `isLatvianHoliday` name/signature identical in T1 Produces and T2 Consumes; no other cross-task symbols.
