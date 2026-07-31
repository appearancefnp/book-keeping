import { nextWorkingDay } from '../calendar/holidays.js';
import type { Periodicity } from './vat-settings.js';

export interface FilingPeriod {
  /** 'YYYY-MM' for monthly, 'YYYY-Qn' for quarterly. Stable — used as an API parameter. */
  label: string;
  fromDate: string; toDate: string;
  /** The 20th of the month following the period, rolled to the next working day. */
  dueDate: string;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Last calendar day of a month, via day 0 of the following month. */
function lastDayOf(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 0));
  return d.toISOString().slice(0, 10);
}

/** The 20th of the month after `toDate`'s month, rolled forward to a working day. */
function dueDateAfter(year: number, month: number): string {
  const y = month === 12 ? year + 1 : year;
  const m = month === 12 ? 1 : month + 1;
  return nextWorkingDay(`${y}-${pad(m)}-20`);
}

function monthlyPeriod(year: number, month: number): FilingPeriod {
  return {
    label: `${year}-${pad(month)}`,
    fromDate: `${year}-${pad(month)}-01`,
    toDate: lastDayOf(year, month),
    dueDate: dueDateAfter(year, month),
  };
}

function quarterlyPeriod(year: number, quarter: number): FilingPeriod {
  const endMonth = quarter * 3;
  return {
    label: `${year}-Q${quarter}`,
    fromDate: `${year}-${pad(endMonth - 2)}-01`,
    toDate: lastDayOf(year, endMonth),
    dueDate: dueDateAfter(year, endMonth),
  };
}

export function filingPeriodsFor(year: number, periodicity: Periodicity): FilingPeriod[] {
  return periodicity === 'monthly'
    ? Array.from({ length: 12 }, (_, i) => monthlyPeriod(year, i + 1))
    : Array.from({ length: 4 }, (_, i) => quarterlyPeriod(year, i + 1));
}

export function currentFilingPeriod(onDate: string, periodicity: Periodicity): FilingPeriod {
  const [y, m] = onDate.split('-').map(Number);
  return periodicity === 'monthly'
    ? monthlyPeriod(y!, m!)
    : quarterlyPeriod(y!, Math.floor((m! - 1) / 3) + 1);
}

export function filingPeriodByLabel(label: string, periodicity: Periodicity): FilingPeriod {
  if (periodicity === 'monthly') {
    const m = /^(\d{4})-(\d{2})$/.exec(label);
    const month = m ? Number(m[2]) : 0;
    if (!m || month < 1 || month > 12) throw new Error(`Invalid monthly filing period: "${label}"`);
    return monthlyPeriod(Number(m[1]), month);
  }
  const q = /^(\d{4})-Q([1-4])$/.exec(label);
  if (!q) throw new Error(`Invalid quarterly filing period: "${label}"`);
  return quarterlyPeriod(Number(q[1]), Number(q[2]));
}
