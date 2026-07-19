/**
 * Workday calendar: Mon–Fri excluding LR public holidays (src/calendar/holidays.ts).
 * All dates are ISO 'YYYY-MM-DD' strings, handled in UTC.
 */

import { isLatvianHoliday } from '../calendar/holidays.js';

const DAY_MS = 86_400_000;

function toUtc(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}
function toIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function isWorkDay(iso: string): boolean {
  const dow = new Date(toUtc(iso)).getUTCDay();
  return dow !== 0 && dow !== 6 && !isLatvianHoliday(iso);
}

export function lastDayOfMonth(year: number, month: number): string {
  return toIso(Date.UTC(year, month, 0)); // day 0 of next month
}

export function firstDayOfMonth(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

/** Inclusive ISO date iterator. */
export function* calendarDays(fromIso: string, toIsoDate: string): Generator<string> {
  for (let t = toUtc(fromIso); t <= toUtc(toIsoDate); t += DAY_MS) yield toIso(t);
}

export function workDaysInMonth(year: number, month: number): number {
  return workDaysOverlap(firstDayOfMonth(year, month), lastDayOfMonth(year, month), year, month);
}

/** Workdays of [fromIso, toIso] that fall inside (year, month). */
export function workDaysOverlap(fromIso: string, toIsoDate: string, year: number, month: number): number {
  const lo = Math.max(toUtc(fromIso), toUtc(firstDayOfMonth(year, month)));
  const hi = Math.min(toUtc(toIsoDate), toUtc(lastDayOfMonth(year, month)));
  let n = 0;
  for (let t = lo; t <= hi; t += DAY_MS) if (isWorkDay(toIso(t))) n++;
  return n;
}
