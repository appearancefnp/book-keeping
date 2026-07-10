import { applyBp } from './rates.js';
import { calendarDays, isWorkDay, firstDayOfMonth, lastDayOfMonth } from './workdays.js';

/**
 * Employer-paid sick pay, A lapa (doc 3.1 step 1 component; researched rules):
 * calendar day 1 unpaid, days 2-3 >=75%, days 4-9 >=80% of average daily earnings,
 * paid only for would-be workdays. Day 10+ is B lapa (state), never employer-paid.
 */
export function computeSickPayA(args: {
  sickFrom: string; sickTo: string; year: number; month: number;
  avgDailyCents: bigint; sickDay23Bp: bigint; sickDay49Bp: bigint;
}): { totalCents: bigint; days: { date: string; dayIndex: number; cents: bigint }[] } {
  const monthFrom = firstDayOfMonth(args.year, args.month);
  const monthTo = lastDayOfMonth(args.year, args.month);
  const days: { date: string; dayIndex: number; cents: bigint }[] = [];
  let total = 0n;
  let idx = 0;
  for (const date of calendarDays(args.sickFrom, args.sickTo)) {
    idx++; // calendar-day index from the first sick day, across month boundaries
    if (date < monthFrom || date > monthTo) continue;
    if (!isWorkDay(date)) continue;
    const rateBp = idx === 1 ? 0n : idx <= 3 ? args.sickDay23Bp : idx <= 9 ? args.sickDay49Bp : 0n;
    const cents = applyBp(args.avgDailyCents, rateBp);
    days.push({ date, dayIndex: idx, cents });
    total += cents;
  }
  return { totalCents: total, days };
}

/** Vacation pay for the month = overlapping workdays x average daily earnings (doc 3.2 step 5). */
export function computeVacationPay(args: {
  from: string; to: string; year: number; month: number; avgDailyCents: bigint;
}): bigint {
  const monthFrom = firstDayOfMonth(args.year, args.month);
  const monthTo = lastDayOfMonth(args.year, args.month);
  let total = 0n;
  for (const date of calendarDays(args.from, args.to)) {
    if (date < monthFrom || date > monthTo) continue;
    if (isWorkDay(date)) total += args.avgDailyCents;
  }
  return total;
}
