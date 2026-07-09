import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { toCents, fromCents } from '../db/money.js';
import { applyBp, divRound } from './rates.js';
import { getEmployee } from './employees.js';
import { lastDayOfMonth, workDaysOverlap } from './workdays.js';

/** 1.67 accrued working days per employed month, in day-hundredths (doc 3.6 A). */
const ACCRUAL_PER_MONTH_HUNDREDTHS = 167n;

const key = (y: number, m: number) => y * 12 + (m - 1);

/**
 * Vacation day balance (doc 3.6 A), in day-hundredths as of the END of (year, month):
 * opening balance + 1.67 per month after the opening month - used vacation workdays
 * dated after the opening date. May be negative (vacation taken in advance).
 */
export async function vacationBalanceHundredths(
  tx: PoolClient, ctx: TenantContext, employeeId: string, year: number, month: number,
): Promise<bigint> {
  const emp = await getEmployee(tx, ctx, employeeId);
  const openingHundredths = toCents(emp.openingVacationDays); // '5' -> 500n day-hundredths
  const openingKey = key(Number(emp.openingBalanceDate.slice(0, 4)), Number(emp.openingBalanceDate.slice(5, 7)));

  // Accrue for each month AFTER the opening month, through the asked month,
  // but not past termination.
  let endKey = key(year, month);
  if (emp.terminatedOn) endKey = Math.min(endKey, key(Number(emp.terminatedOn.slice(0, 4)), Number(emp.terminatedOn.slice(5, 7))));
  const monthsAccrued = BigInt(Math.max(0, endKey - openingKey));

  // Used vacation workdays after the opening date, up to the end of the asked month.
  const res = await tx.query(
    `SELECT to_char(date_from,'YYYY-MM-DD') AS "dateFrom", to_char(date_to,'YYYY-MM-DD') AS "dateTo"
     FROM absences
     WHERE employee_id = $1 AND client_company_id = $2 AND type = 'vacation'
       AND date_from > $3 AND date_from <= $4`,
    [employeeId, ctx.clientCompanyId, emp.openingBalanceDate, lastDayOfMonth(year, month)],
  );
  let usedDays = 0;
  for (const a of res.rows) {
    // Count all workdays of the absence (clamped month-by-month up to the asked month).
    let y = Number(a.dateFrom.slice(0, 4)); let m = Number(a.dateFrom.slice(5, 7));
    const endY = Number(a.dateTo.slice(0, 4)); const endM = Number(a.dateTo.slice(5, 7));
    while (key(y, m) <= Math.min(key(endY, endM), key(year, month))) {
      usedDays += workDaysOverlap(a.dateFrom, a.dateTo, y, m);
      m++; if (m > 12) { m = 1; y++; }
    }
  }

  return openingHundredths + monthsAccrued * ACCRUAL_PER_MONTH_HUNDREDTHS - BigInt(usedDays) * 100n;
}

export interface AccrualResult {
  balanceHundredths: bigint;
  accrualCents: bigint;
  vsaoiCents: bigint;
  deltaCents: bigint;       // vs previous snapshot — post this (doc 3.7 row 1)
  deltaVsaoiCents: bigint;  // doc 3.7 row 2
}

/**
 * Recompute the financial accrual (doc 3.6 B) for (year, month) and store the
 * snapshot. Terminated employees snap to zero — the liability is settled through
 * the final payout, so the released delta offsets the compensation expense
 * (equivalent to the doc-3.7 "pay from 5411" rule at the entry level).
 */
export async function recomputeAccrual(
  tx: PoolClient, ctx: TenantContext,
  args: { employeeId: string; year: number; month: number; avgDailyCents: bigint; employerBp: bigint },
): Promise<AccrualResult> {
  const emp = await getEmployee(tx, ctx, args.employeeId);
  const terminated = emp.terminatedOn !== null
    && key(Number(emp.terminatedOn.slice(0, 4)), Number(emp.terminatedOn.slice(5, 7))) <= key(args.year, args.month);

  const balance = await vacationBalanceHundredths(tx, ctx, args.employeeId, args.year, args.month);
  const accrual = !terminated && balance > 0n ? divRound(balance * args.avgDailyCents, 100n) : 0n;
  const vsaoi = applyBp(accrual, args.employerBp);

  const prev = await tx.query(
    `SELECT (ROUND(accrual * 100))::bigint AS accrual_cents, (ROUND(accrual_vsaoi * 100))::bigint AS vsaoi_cents
     FROM vacation_accruals
     WHERE employee_id = $1 AND client_company_id = $2 AND (year*12 + month) < $3
     ORDER BY year DESC, month DESC LIMIT 1`,
    [args.employeeId, ctx.clientCompanyId, args.year * 12 + args.month],
  );
  const prevAccrual = prev.rowCount ? BigInt(prev.rows[0].accrual_cents) : 0n;
  const prevVsaoi = prev.rowCount ? BigInt(prev.rows[0].vsaoi_cents) : 0n;

  await tx.query(
    `INSERT INTO vacation_accruals(client_company_id, employee_id, year, month, balance_days, avg_daily, accrual, accrual_vsaoi)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (employee_id, year, month)
     DO UPDATE SET balance_days = EXCLUDED.balance_days, avg_daily = EXCLUDED.avg_daily,
                   accrual = EXCLUDED.accrual, accrual_vsaoi = EXCLUDED.accrual_vsaoi`,
    [ctx.clientCompanyId, args.employeeId, args.year, args.month,
     fromCents(balance), fromCents(args.avgDailyCents), fromCents(accrual), fromCents(vsaoi)],
  );

  return {
    balanceHundredths: balance, accrualCents: accrual, vsaoiCents: vsaoi,
    deltaCents: accrual - prevAccrual, deltaVsaoiCents: vsaoi - prevVsaoi,
  };
}
