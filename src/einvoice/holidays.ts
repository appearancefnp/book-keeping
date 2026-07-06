/**
 * Latvian public-holiday calendar for VID working-day due-date calculation (HANDOFF G6).
 *
 * Statutory source: "Par svētku, atceres un atzīmējamām dienām". The set is computed
 * per-year (fixed dates + Easter-derived movable feasts) so no table needs maintaining.
 * Kept as a pure, injectable source: `addWorkingDays` takes an `isHoliday` predicate,
 * so the exact list stays confirmable/adjustable with the accountant (spec §10.1)
 * without touching the working-day arithmetic.
 *
 * NOTE: only days that can fall on a weekday matter for a working-day count (weekends
 * are already skipped). Easter Sunday and Whit Sunday are Sundays by construction and
 * are included for completeness/reuse, not because they affect the count.
 */

function iso(y: number, m: number, d: number): string {
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

/** Easter Sunday for a Gregorian year via the anonymous Gregorian algorithm. Returns 'YYYY-MM-DD'. */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(year, month, day);
}

/** Shift 'YYYY-MM-DD' by `days` (may be negative), returning 'YYYY-MM-DD'. */
function shiftIso(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** The set of Latvian public holidays ('YYYY-MM-DD') for a given calendar year. */
export function latvianHolidays(year: number): Set<string> {
  const easter = easterSunday(year);
  return new Set<string>([
    iso(year, 1, 1), // Jaunais gads — New Year
    shiftIso(easter, -2), // Lielā Piektdiena — Good Friday
    easter, // Lieldienas — Easter Sunday
    shiftIso(easter, 1), // Otrās Lieldienas — Easter Monday
    iso(year, 5, 1), // Darba svētki — Labour Day
    iso(year, 5, 4), // Neatkarības atjaunošanas diena — Restoration of Independence
    shiftIso(easter, 49), // Vasarsvētki — Whit Sunday (Pentecost)
    iso(year, 6, 23), // Līgo
    iso(year, 6, 24), // Jāņi — Midsummer
    iso(year, 11, 18), // Republikas proklamēšanas diena — Proclamation of the Republic
    iso(year, 12, 24), // Ziemassvētku vakars — Christmas Eve
    iso(year, 12, 25), // Ziemassvētki — Christmas
    iso(year, 12, 26), // Otrie Ziemassvētki — Second day of Christmas
    iso(year, 12, 31), // Vecgada vakars — New Year's Eve
  ]);
}

const cache = new Map<number, Set<string>>();

/** True if 'YYYY-MM-DD' is a Latvian public holiday. Year sets are memoised. */
export function isLatvianHoliday(date: string): boolean {
  const year = Number(date.slice(0, 4));
  let set = cache.get(year);
  if (!set) {
    set = latvianHolidays(year);
    cache.set(year, set);
  }
  return set.has(date);
}
