/**
 * True if `s` is a real calendar date in strict `YYYY-MM-DD` form.
 *
 * Beyond a format check, it round-trips through `Date` so calendar-impossible
 * dates (e.g. `2026-02-31`) are rejected rather than silently normalised — the
 * UTC parse of an out-of-range day rolls over to the next month, so the
 * re-serialised value no longer equals the input. Mirrors the guard in the M1
 * report routes (profit-and-loss / balance-sheet), centralised for reuse.
 */
export function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
