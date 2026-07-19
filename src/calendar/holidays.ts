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

/** The following Monday when `date` falls on a weekend, else null (May 4 / Nov 18 rule). */
function observedMonday(date: string): string | null {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (dow === 6) return shiftIso(date, 2); // Saturday → Monday
  if (dow === 0) return shiftIso(date, 1); // Sunday → Monday
  return null;
}

/** The set of Latvian public holidays ('YYYY-MM-DD') for a given calendar year. */
export function latvianHolidays(year: number): Set<string> {
  const easter = easterSunday(year);
  const set = new Set<string>([
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
  // Observed-Monday rule: only May 4 and Nov 18 shift when they fall on a weekend.
  for (const d of [iso(year, 5, 4), iso(year, 11, 18)]) {
    const observed = observedMonday(d);
    if (observed) set.add(observed);
  }
  return set;
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
