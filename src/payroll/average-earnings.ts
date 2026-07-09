import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { divRound } from './rates.js';
import { workDaysInMonth } from './workdays.js';

/**
 * THE shared average-earnings function (doc 3.2) — vacation pay, sick pay,
 * severance and termination compensation all call this; never reimplement it.
 *
 * Base = base pay + premiums + bonuses (avg_base_gross), EXCLUDING previous
 * average-pay payments (vacation/sick), so no "calculation from a calculation".
 */
export interface AverageEarningsResult {
  dailyCents: bigint;
  monthlyCents: bigint;  // daily x (calendar workdays in the window / 6) — used for severance
  from: string;          // 'YYYY-MM'
  to: string;            // 'YYYY-MM'
  shifted: boolean;      // window moved back past a long absence (doc 3.2 case 2)
  totalWorkedDays: number;
  monthsUsed: { year: number; month: number; grossCents: bigint; workedDays: number }[];
}

const key = (y: number, m: number) => y * 12 + (m - 1);
const fromKey = (k: number) => ({ year: Math.floor(k / 12), month: (k % 12) + 1 });
const label = (k: number) => { const { year, month } = fromKey(k); return `${year}-${String(month).padStart(2, '0')}`; };

export async function computeAverageEarnings(
  tx: PoolClient, ctx: TenantContext, employeeId: string, eventDate: string,
): Promise<AverageEarningsResult> {
  // Merge history: imported opening months first, real approved payroll months overwrite.
  const res = await tx.query(
    `SELECT year, month, (ROUND(avg_base_gross * 100))::bigint AS gross_cents, worked_days, 0 AS pri
       FROM employee_opening_history WHERE employee_id = $1 AND client_company_id = $2
     UNION ALL
     SELECT r.year, r.month, (ROUND(i.avg_base_gross * 100))::bigint, i.worked_days, 1 AS pri
       FROM payroll_items i JOIN payroll_runs r ON r.id = i.run_id
      WHERE i.employee_id = $1 AND i.client_company_id = $2 AND r.status = 'approved'
     ORDER BY pri`,
    [employeeId, ctx.clientCompanyId],
  );
  const byMonth = new Map<number, { grossCents: bigint; workedDays: number }>();
  for (const row of res.rows) {
    byMonth.set(key(row.year, row.month), { grossCents: BigInt(row.gross_cents), workedDays: row.worked_days });
  }
  if (byMonth.size === 0) {
    throw new Error(`No earnings history for employee ${employeeId} — import opening history (doc 2.1) or approve a payroll run first`);
  }

  const eventKey = key(Number(eventDate.slice(0, 4)), Number(eventDate.slice(5, 7)));
  let windowEnd = eventKey - 1; // last FULL month before the event month
  let shifted = false;

  const monthsIn = (endKey: number) => {
    const months: { year: number; month: number; grossCents: bigint; workedDays: number }[] = [];
    for (let k = endKey - 5; k <= endKey; k++) {
      const m = byMonth.get(k);
      if (m) months.push({ ...fromKey(k), ...m });
    }
    return months;
  };

  let months = monthsIn(windowEnd);
  if (months.reduce((s, m) => s + m.workedDays, 0) === 0) {
    // Long absence: shift the window to end at the latest earlier month with worked days.
    const candidates = [...byMonth.entries()]
      .filter(([k, m]) => k < windowEnd - 5 && m.workedDays > 0)
      .map(([k]) => k);
    if (candidates.length === 0) {
      throw new Error(`No worked days in any known month for employee ${employeeId} — check opening history (doc 2.1)`);
    }
    windowEnd = Math.max(...candidates);
    shifted = true;
    months = monthsIn(windowEnd);
  }

  const totalGross = months.reduce((s, m) => s + m.grossCents, 0n);
  const totalWorkedDays = months.reduce((s, m) => s + m.workedDays, 0);
  if (totalWorkedDays === 0) {
    throw new Error(`No worked days in the average-earnings window for employee ${employeeId}`);
  }
  const dailyCents = divRound(totalGross, BigInt(totalWorkedDays));

  // Monthly average (for severance, doc 3.8): daily x calendar workdays in the window / 6.
  let calendarWorkDays = 0;
  for (let k = windowEnd - 5; k <= windowEnd; k++) {
    const { year, month } = fromKey(k);
    calendarWorkDays += workDaysInMonth(year, month);
  }
  const monthlyCents = divRound(dailyCents * BigInt(calendarWorkDays), 6n);

  return {
    dailyCents, monthlyCents,
    from: label(windowEnd - 5), to: label(windowEnd),
    shifted, totalWorkedDays, monthsUsed: months,
  };
}
