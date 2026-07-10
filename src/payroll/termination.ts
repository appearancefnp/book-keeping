import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { fromCents } from '../db/money.js';
import { divRound } from './rates.js';
import { getEmployee, updateEmployee } from './employees.js';
import { addPayComponent } from './inputs.js';
import { computeAverageEarnings } from './average-earnings.js';
import { vacationBalanceHundredths } from './accrual.js';

/** Severance by unbroken tenure with this employer (doc 3.8 table). */
export function severanceMonthsFor(hiredOn: string, lastDay: string): number {
  const h = new Date(`${hiredOn}T00:00:00Z`);
  const l = new Date(`${lastDay}T00:00:00Z`);
  let years = l.getUTCFullYear() - h.getUTCFullYear();
  const beforeAnniversary = l.getUTCMonth() < h.getUTCMonth()
    || (l.getUTCMonth() === h.getUTCMonth() && l.getUTCDate() < h.getUTCDate());
  if (beforeAnniversary) years--;
  return years < 5 ? 1 : years < 10 ? 2 : years < 20 ? 3 : 4;
}

/**
 * Apply a termination (called by approveOrder): set terminated_on, then create the
 * final-settlement components so the normal run produces ONE combined item (doc 3.8):
 *  - vacation compensation = remaining day balance x average daily earnings (taxable);
 *  - statutory severance = months-by-tenure x average monthly earnings (IIN/VSAOI-exempt).
 * The last month's wage itself comes from the regular run proration.
 */
export async function applyTermination(
  tx: PoolClient, ctx: TenantContext,
  args: { orderId: string; employeeId: string; lastDay: string; severance: boolean },
): Promise<void> {
  const emp = await getEmployee(tx, ctx, args.employeeId);
  const year = Number(args.lastDay.slice(0, 4));
  const month = Number(args.lastDay.slice(5, 7));

  // Set terminated_on FIRST so the balance stops accruing past the final month.
  await updateEmployee(tx, ctx, args.employeeId, { terminatedOn: args.lastDay });

  const avg = await computeAverageEarnings(tx, ctx, args.employeeId, args.lastDay);

  const balance = await vacationBalanceHundredths(tx, ctx, args.employeeId, year, month);
  if (balance > 0n) {
    await addPayComponent(tx, ctx, {
      employeeId: args.employeeId, year, month, kind: 'other_taxable',
      amount: fromCents(divRound(balance * avg.dailyCents, 100n)),
      sourceOrderId: args.orderId, note: 'Kompensācija par neizmantoto atvaļinājumu (3.8)',
    });
  }

  if (args.severance) {
    const months = severanceMonthsFor(emp.hiredOn, args.lastDay);
    await addPayComponent(tx, ctx, {
      employeeId: args.employeeId, year, month, kind: 'severance_exempt',
      amount: fromCents(BigInt(months) * avg.monthlyCents),
      sourceOrderId: args.orderId, note: `Atlaišanas pabalsts — ${months} mēn. vidējā izpeļņa (3.8)`,
    });
  }
}
