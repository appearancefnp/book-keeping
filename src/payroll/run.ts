import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { toCents, fromCents } from '../db/money.js';
import { appendAudit } from '../audit/audit.js';
import { applyBp, divRound } from './rates.js';
import { loadPayrollParams, type PayrollParams } from './params.js';
import { getPayrollSettings } from './settings.js';
import { activeEmployeesFor, taxStatusFor, type EmployeeRow } from './employees.js';
import { listAbsencesOverlapping, listComponents } from './inputs.js';
import { computePayroll } from './calc.js';
import { computeAverageEarnings } from './average-earnings.js';
import { computeSickPayA, computeVacationPay } from './absence-pay.js';
import { firstDayOfMonth, lastDayOfMonth, workDaysInMonth, workDaysOverlap } from './workdays.js';
import { postEntry, type NewJournalLine } from '../ledger/posting.js';
import { ensurePayrollAccounts, type PayrollSettings } from './settings.js';
import { recomputeAccrual } from './accrual.js';

export interface RunRow { id: string; year: number; month: number; status: 'draft' | 'computed' | 'approved'; }
export interface RunItemRow {
  employeeId: string; workedDays: number; totalWorkDays: number;
  base: string; premiums: string; bonus: string; vacationPay: string; sickPay: string;
  otherTaxable: string; severanceExempt: string; gross: string; avgBaseGross: string; avgDaily: string;
  vsaoiEmployee: string; iin: string; otherDeductions: string; net: string; payout: string;
  vsaoiEmployer: string; riskDuty: string; warnings: string[]; explanation: { step: string; amount: string }[];
}

export async function openRun(
  tx: PoolClient, ctx: TenantContext, p: { year: number; month: number },
): Promise<{ id: string }> {
  const settings = await getPayrollSettings(tx, ctx);
  if (settings.munRegime) {
    throw new Error('MUN-regime payroll is not supported in phase 1 — the flag is stored, the calculation is general-regime only');
  }
  const res = await tx.query(
    `INSERT INTO payroll_runs(client_company_id, year, month) VALUES ($1,$2,$3) RETURNING id`,
    [ctx.clientCompanyId, p.year, p.month],
  );
  const id = res.rows[0].id as string;
  await appendAudit(tx, ctx, { action: 'create', entityType: 'payroll_run', entityId: id, before: null, after: p });
  return { id };
}

export async function getRun(tx: PoolClient, ctx: TenantContext, runId: string): Promise<RunRow> {
  const res = await tx.query(
    `SELECT id, year, month, status FROM payroll_runs WHERE id = $1 AND client_company_id = $2`,
    [runId, ctx.clientCompanyId],
  );
  if (!res.rowCount) throw new Error(`Payroll run not found: ${runId}`);
  return res.rows[0];
}

export async function listRuns(tx: PoolClient, ctx: TenantContext): Promise<RunRow[]> {
  const res = await tx.query(
    `SELECT id, year, month, status FROM payroll_runs WHERE client_company_id = $1 ORDER BY year DESC, month DESC`,
    [ctx.clientCompanyId],
  );
  return res.rows;
}

export async function getRunWithItems(
  tx: PoolClient, ctx: TenantContext, runId: string,
): Promise<RunRow & { items: RunItemRow[] }> {
  const run = await getRun(tx, ctx, runId);
  const res = await tx.query(
    `SELECT employee_id AS "employeeId", worked_days AS "workedDays", total_work_days AS "totalWorkDays",
            base::text, premiums::text, bonus::text, vacation_pay::text AS "vacationPay",
            sick_pay::text AS "sickPay", other_taxable::text AS "otherTaxable",
            severance_exempt::text AS "severanceExempt", gross::text, avg_base_gross::text AS "avgBaseGross",
            avg_daily::text AS "avgDaily", vsaoi_employee::text AS "vsaoiEmployee", iin::text,
            other_deductions::text AS "otherDeductions", net::text, payout::text,
            vsaoi_employer::text AS "vsaoiEmployer", risk_duty::text AS "riskDuty", warnings, explanation
     FROM payroll_items WHERE run_id = $1 AND client_company_id = $2 ORDER BY employee_id`,
    [runId, ctx.clientCompanyId],
  );
  return { ...run, items: res.rows };
}

/** Hour-quantity string ('8' / '7.50') -> hour-hundredths (800n / 750n). */
const toHourHundredths = toCents;

async function computeEmployee(
  tx: PoolClient, ctx: TenantContext, emp: EmployeeRow,
  year: number, month: number, params: PayrollParams,
): Promise<Record<string, unknown>> {
  const warnings: string[] = [];
  const totalWorkDays = workDaysInMonth(year, month);
  const first = firstDayOfMonth(year, month);
  const last = lastDayOfMonth(year, month);

  // Employment window inside the month (mid-month hire/termination).
  const empFrom = emp.hiredOn > first ? emp.hiredOn : first;
  const empTo = emp.terminatedOn && emp.terminatedOn < last ? emp.terminatedOn : last;
  const employedWorkDays = workDaysOverlap(empFrom, empTo, year, month);

  // Absences -> absent workdays + pay inputs.
  const absences = await listAbsencesOverlapping(tx, ctx, emp.id, year, month);
  let absentDays = 0;
  for (const a of absences) absentDays += workDaysOverlap(a.dateFrom, a.dateTo, year, month);
  const workedDays = Math.max(0, employedWorkDays - absentDays);

  // Components.
  const comps = await listComponents(tx, ctx, emp.id, year, month);
  const sum = (kind: string) => comps.filter((c) => c.kind === kind)
    .reduce((s, c) => s + toCents(c.amount!), 0n);
  const hours = (kind: string) => comps.filter((c) => c.kind === kind)
    .reduce((s, c) => s + toHourHundredths(c.quantity!), 0n);

  // Base pay + hourly rate (doc 3.3 premium basis).
  const wageCents = toCents(emp.wage);
  let baseCents: bigint;
  let hourlyRateCents: bigint;
  if (emp.wageType === 'monthly') {
    baseCents = totalWorkDays > 0 ? divRound(wageCents * BigInt(workedDays), BigInt(totalWorkDays)) : 0n;
    hourlyRateCents = divRound(wageCents, BigInt(totalWorkDays * 8));
  } else {
    baseCents = divRound(wageCents * hours('hours_worked'), 100n);
    hourlyRateCents = wageCents;
  }

  // Premiums stack (doc 3.3): each is pct of the rate, per hour.
  const premium = (kind: string, bp: bigint) => divRound(applyBp(hourlyRateCents, bp) * hours(kind), 100n);
  const premiumCents = premium('night_hours', params.premiumNightBp)
    + premium('overtime_hours', params.premiumOvertimeBp)
    + premium('holiday_hours', params.premiumHolidayBp);

  // Average earnings — the one shared function; wage-derived fallback if no history yet.
  let avgDailyCents: bigint;
  try {
    const avg = await computeAverageEarnings(tx, ctx, emp.id, first);
    avgDailyCents = avg.dailyCents;
    if (avg.shifted) warnings.push('avg_earnings_window_shifted');
  } catch {
    avgDailyCents = emp.wageType === 'monthly'
      ? divRound(wageCents, BigInt(totalWorkDays))
      : wageCents * 8n;
    warnings.push('avg_earnings_fallback');
  }

  // Absence pay.
  let vacationPayCents = 0n;
  let sickPayCents = 0n;
  for (const a of absences) {
    if (a.type === 'vacation') {
      vacationPayCents += computeVacationPay({ from: a.dateFrom, to: a.dateTo, year, month, avgDailyCents });
    } else if (a.type === 'sick_a') {
      sickPayCents += computeSickPayA({
        sickFrom: a.dateFrom, sickTo: a.dateTo, year, month, avgDailyCents,
        sickDay23Bp: params.sickDay23Bp, sickDay49Bp: params.sickDay49Bp,
      }).totalCents;
    }
    // sick_b / unpaid / other: absence without employer pay
  }

  // Monthly tax-book data (doc 2.2 — must be fresh every month).
  const tax = await taxStatusFor(tx, ctx, emp.id, year, month);
  if (!tax) warnings.push('tax_status_missing');
  else if (tax.stale) warnings.push('tax_status_stale');

  // YTD VSAOI base from approved runs this calendar year.
  const ytd = await tx.query(
    `SELECT COALESCE(SUM(ROUND(i.gross * 100)), 0)::bigint AS cents
     FROM payroll_items i JOIN payroll_runs r ON r.id = i.run_id
     WHERE i.employee_id = $1 AND i.client_company_id = $2
       AND r.status = 'approved' AND r.year = $3 AND r.month < $4`,
    [emp.id, ctx.clientCompanyId, year, month],
  );

  const result = computePayroll({
    baseCents, premiumCents,
    bonusCents: sum('bonus'),
    vacationPayCents, sickPayCents,
    otherTaxableCents: sum('other_taxable'),
    severanceExemptCents: sum('severance_exempt'),
    taxBookActive: tax?.taxBookActive ?? false,
    dependents: tax?.dependents ?? 0,
    disabilityGroup: (tax?.disabilityGroup ?? 0) as 0 | 1 | 2 | 3,
    workedDays, totalWorkDays,
    requestedDeductionsCents: sum('deduction'),
    ytdVsaoiBaseCents: BigInt(ytd.rows[0].cents),
  }, params);

  return {
    employee_id: emp.id, worked_days: workedDays, total_work_days: totalWorkDays,
    base: fromCents(baseCents), premiums: fromCents(premiumCents), bonus: fromCents(sum('bonus')),
    vacation_pay: fromCents(vacationPayCents), sick_pay: fromCents(sickPayCents),
    other_taxable: fromCents(sum('other_taxable')), severance_exempt: fromCents(sum('severance_exempt')),
    gross: fromCents(result.grossCents),
    avg_base_gross: fromCents(baseCents + premiumCents + sum('bonus')),
    avg_daily: fromCents(avgDailyCents),
    vsaoi_employee: fromCents(result.vsaoiEmployeeCents), iin: fromCents(result.iinCents),
    other_deductions: fromCents(result.deductionsAppliedCents),
    net: fromCents(result.netCents), payout: fromCents(result.payoutCents),
    vsaoi_employer: fromCents(result.vsaoiEmployerCents), risk_duty: fromCents(result.riskDutyCents),
    warnings: JSON.stringify([...warnings, ...result.warnings]),
    explanation: JSON.stringify(result.explanation),
  };
}

/** Compute (or recompute) every active employee's item for the run's month. */
export async function computeRun(tx: PoolClient, ctx: TenantContext, runId: string): Promise<void> {
  const run = await getRun(tx, ctx, runId);
  if (run.status === 'approved') throw new Error(`Run ${runId} is approved and cannot be recomputed`);

  const params = await loadPayrollParams(tx, lastDayOfMonth(run.year, run.month));
  await tx.query('DELETE FROM payroll_items WHERE run_id = $1 AND client_company_id = $2', [runId, ctx.clientCompanyId]);

  const employees = await activeEmployeesFor(tx, ctx, run.year, run.month);
  for (const emp of employees) {
    const item = await computeEmployee(tx, ctx, emp, run.year, run.month, params);
    await tx.query(
      `INSERT INTO payroll_items(client_company_id, run_id, employee_id, worked_days, total_work_days,
         base, premiums, bonus, vacation_pay, sick_pay, other_taxable, severance_exempt,
         gross, avg_base_gross, avg_daily, vsaoi_employee, iin, other_deductions, net, payout,
         vsaoi_employer, risk_duty, warnings, explanation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [ctx.clientCompanyId, runId, item.employee_id, item.worked_days, item.total_work_days,
       item.base, item.premiums, item.bonus, item.vacation_pay, item.sick_pay,
       item.other_taxable, item.severance_exempt, item.gross, item.avg_base_gross, item.avg_daily,
       item.vsaoi_employee, item.iin, item.other_deductions, item.net, item.payout,
       item.vsaoi_employer, item.risk_duty, item.warnings, item.explanation],
    );
  }

  await tx.query(
    `UPDATE payroll_runs SET status = 'computed' WHERE id = $1 AND client_company_id = $2`,
    [runId, ctx.clientCompanyId],
  );
  await appendAudit(tx, ctx, {
    action: 'compute', entityType: 'payroll_run', entityId: runId,
    before: { status: run.status }, after: { status: 'computed', employees: employees.length },
  });
}

/** A balanced debit/credit pair; skipped when the amount is zero. */
function pair(debitAcc: string, creditAcc: string, cents: bigint, description: string): NewJournalLine[] {
  if (cents === 0n) return [];
  return [
    { accountCode: debitAcc, debit: fromCents(cents), credit: '0', description },
    { accountCode: creditAcc, debit: '0', credit: fromCents(cents), description },
  ];
}

/**
 * Approve a computed run: post the doc-3.4 accrual rows (1-8) per employee, then
 * the doc-3.7 vacation-accrual delta. Payment rows (9-12) happen in the bank module
 * when money actually moves — the doc requires the two steps stay separate.
 */
export async function approveRun(tx: PoolClient, ctx: TenantContext, runId: string): Promise<void> {
  const run = await getRun(tx, ctx, runId);
  if (run.status !== 'computed') throw new Error(`Run ${runId} is not computed (status: ${run.status})`);

  const s: PayrollSettings = await getPayrollSettings(tx, ctx);
  await ensurePayrollAccounts(tx, ctx);
  const params = await loadPayrollParams(tx, lastDayOfMonth(run.year, run.month));
  const entryDate = lastDayOfMonth(run.year, run.month);
  const label = `${run.year}-${String(run.month).padStart(2, '0')}`;

  const items = await tx.query(
    `SELECT i.employee_id, e.first_name, e.last_name,
            (ROUND(i.gross*100))::bigint AS gross, (ROUND(i.severance_exempt*100))::bigint AS severance,
            (ROUND(i.vsaoi_employee*100))::bigint AS vsaoi_emp, (ROUND(i.iin*100))::bigint AS iin,
            (ROUND(i.other_deductions*100))::bigint AS deductions,
            (ROUND(i.vsaoi_employer*100))::bigint AS vsaoi_er, (ROUND(i.risk_duty*100))::bigint AS risk,
            (ROUND(i.avg_daily*100))::bigint AS avg_daily
     FROM payroll_items i JOIN employees e ON e.id = i.employee_id
     WHERE i.run_id = $1 AND i.client_company_id = $2 ORDER BY e.last_name, e.first_name`,
    [runId, ctx.clientCompanyId],
  );

  for (const r of items.rows) {
    const name = `${r.last_name} ${r.first_name}`;
    // Doc 3.4 rows 1-8 as one balanced entry (each pair is one row of the scheme).
    const lines: NewJournalLine[] = [
      ...pair(s.accWageExpense, s.accWagesPayable, BigInt(r.gross), 'Bruto alga (3.4 r.1-2)'),
      ...pair(s.accSeveranceExpense, s.accWagesPayable, BigInt(r.severance), 'Atlaišanas pabalsts (3.4 r.3)'),
      ...pair(s.accEmployerVsaoiExpense, s.accVsaoiPayable, BigInt(r.vsaoi_er), 'Darba devēja VSAOI (3.4 r.4)'),
      ...pair(s.accRiskDutyExpense, s.accRiskDutyPayable, BigInt(r.risk), 'Riska nodeva (3.4 r.5)'),
      ...pair(s.accWagesPayable, s.accIinPayable, BigInt(r.iin), 'IIN ieturējums (3.4 r.6)'),
      ...pair(s.accWagesPayable, s.accVsaoiPayable, BigInt(r.vsaoi_emp), 'VSAOI darbinieka daļa (3.4 r.7)'),
      ...pair(s.accWagesPayable, s.accOtherDeductionsPayable, BigInt(r.deductions), 'Citi ieturējumi (3.4 r.8)'),
    ];
    if (lines.length > 0) {
      await postEntry(tx, ctx, { date: entryDate, memo: `Alga ${label} — ${name}`, currency: 'EUR', lines });
    }

    // Doc 3.7: vacation-accrual delta (positive = build up, negative = release).
    const acc = await recomputeAccrual(tx, ctx, {
      employeeId: r.employee_id, year: run.year, month: run.month,
      avgDailyCents: BigInt(r.avg_daily), employerBp: params.vsaoiEmployerBp,
    });
    const accLines: NewJournalLine[] = [
      ...(acc.deltaCents >= 0n
        ? pair(s.accWageExpense, s.accVacationAccrualLiability, acc.deltaCents, 'Atvaļinājuma uzkrājums (3.7)')
        : pair(s.accVacationAccrualLiability, s.accWageExpense, -acc.deltaCents, 'Atvaļinājuma uzkrājuma samazinājums (3.7)')),
      ...(acc.deltaVsaoiCents >= 0n
        ? pair(s.accEmployerVsaoiExpense, s.accVacationAccrualVsaoiLiability, acc.deltaVsaoiCents, 'VSAOI par uzkrājumu (3.7)')
        : pair(s.accVacationAccrualVsaoiLiability, s.accEmployerVsaoiExpense, -acc.deltaVsaoiCents, 'VSAOI uzkrājuma samazinājums (3.7)')),
    ];
    if (accLines.length > 0) {
      await postEntry(tx, ctx, { date: entryDate, memo: `Atvaļinājuma uzkrājums ${label} — ${name}`, currency: 'EUR', lines: accLines });
    }
  }

  await tx.query(
    `UPDATE payroll_runs SET status = 'approved', approved_at = now() WHERE id = $1 AND client_company_id = $2`,
    [runId, ctx.clientCompanyId],
  );
  await appendAudit(tx, ctx, {
    action: 'approve', entityType: 'payroll_run', entityId: runId,
    before: { status: 'computed' }, after: { status: 'approved', employees: items.rowCount },
  });
}
