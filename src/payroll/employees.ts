import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appendAudit } from '../audit/audit.js';

export type ContractType = 'indefinite' | 'fixed_term';
export type WageType = 'monthly' | 'hourly';

export interface EmployeeRow {
  id: string; firstName: string; lastName: string; personalCode: string; position: string;
  contractNo: string; contractDate: string; contractType: ContractType;
  wageType: WageType; wage: string;
  hiredOn: string; terminatedOn: string | null;
  openingVacationDays: string; openingBalanceDate: string;
}

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const moneyStr = z.string().regex(/^\d+(\.\d{1,2})?$/);

const newEmployeeSchema = z.object({
  firstName: z.string().min(1), lastName: z.string().min(1),
  personalCode: z.string().regex(/^\d{6}-?\d{5}$/),
  position: z.string().min(1),
  contractNo: z.string().min(1), contractDate: dateStr,
  contractType: z.enum(['indefinite', 'fixed_term']),
  wageType: z.enum(['monthly', 'hourly']),
  wage: moneyStr,
  hiredOn: dateStr,
  openingVacationDays: z.string().regex(/^-?\d+(\.\d{1,2})?$/).default('0'),
  openingBalanceDate: dateStr,
});
export type NewEmployee = z.input<typeof newEmployeeSchema>;

const SELECT_COLS = `id, first_name AS "firstName", last_name AS "lastName",
  personal_code AS "personalCode", position, contract_no AS "contractNo",
  to_char(contract_date,'YYYY-MM-DD') AS "contractDate", contract_type AS "contractType",
  wage_type AS "wageType", wage::text AS wage,
  to_char(hired_on,'YYYY-MM-DD') AS "hiredOn",
  to_char(terminated_on,'YYYY-MM-DD') AS "terminatedOn",
  opening_vacation_days::text AS "openingVacationDays",
  to_char(opening_balance_date,'YYYY-MM-DD') AS "openingBalanceDate"`;

export async function createEmployee(tx: PoolClient, ctx: TenantContext, input: NewEmployee): Promise<{ id: string }> {
  const e = newEmployeeSchema.parse(input);
  const res = await tx.query(
    `INSERT INTO employees(client_company_id, first_name, last_name, personal_code, position,
       contract_no, contract_date, contract_type, wage_type, wage, hired_on,
       opening_vacation_days, opening_balance_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [ctx.clientCompanyId, e.firstName, e.lastName, e.personalCode, e.position,
     e.contractNo, e.contractDate, e.contractType, e.wageType, e.wage, e.hiredOn,
     e.openingVacationDays, e.openingBalanceDate],
  );
  const id = res.rows[0].id as string;
  await appendAudit(tx, ctx, { action: 'create', entityType: 'employee', entityId: id, before: null, after: e });
  return { id };
}

export async function getEmployee(tx: PoolClient, ctx: TenantContext, id: string): Promise<EmployeeRow> {
  const res = await tx.query(
    `SELECT ${SELECT_COLS} FROM employees WHERE id = $1 AND client_company_id = $2`,
    [id, ctx.clientCompanyId],
  );
  if (!res.rowCount) throw new Error(`Employee not found: ${id}`);
  return res.rows[0];
}

export async function listEmployees(tx: PoolClient, ctx: TenantContext): Promise<EmployeeRow[]> {
  const res = await tx.query(
    `SELECT ${SELECT_COLS} FROM employees WHERE client_company_id = $1 ORDER BY last_name, first_name`,
    [ctx.clientCompanyId],
  );
  return res.rows;
}

/** Employees employed at any point inside (year, month). */
export async function activeEmployeesFor(tx: PoolClient, ctx: TenantContext, year: number, month: number): Promise<EmployeeRow[]> {
  const first = `${year}-${String(month).padStart(2, '0')}-01`;
  const res = await tx.query(
    `SELECT ${SELECT_COLS} FROM employees
     WHERE client_company_id = $1
       AND hired_on <= (date_trunc('month', $2::date) + interval '1 month' - interval '1 day')::date
       AND (terminated_on IS NULL OR terminated_on >= $2::date)
     ORDER BY last_name, first_name`,
    [ctx.clientCompanyId, first],
  );
  return res.rows;
}

export async function updateEmployee(
  tx: PoolClient, ctx: TenantContext, id: string,
  patch: { wage?: string; position?: string; terminatedOn?: string | null },
): Promise<void> {
  const before = await getEmployee(tx, ctx, id);
  const merged = {
    wage: patch.wage !== undefined ? moneyStr.parse(patch.wage) : before.wage,
    position: patch.position ?? before.position,
    terminatedOn: patch.terminatedOn !== undefined ? patch.terminatedOn : before.terminatedOn,
  };
  await tx.query(
    `UPDATE employees SET wage=$1, position=$2, terminated_on=$3 WHERE id=$4 AND client_company_id=$5`,
    [merged.wage, merged.position, merged.terminatedOn, id, ctx.clientCompanyId],
  );
  await appendAudit(tx, ctx, { action: 'update', entityType: 'employee', entityId: id, before, after: merged });
}

export interface MonthlyTaxStatus {
  taxBookActive: boolean; dependents: number; disabilityGroup: number;
  isPensioner: boolean; isRepressed: boolean;
}

/** Upsert the month's tax-book data (doc 2.2 — refreshed every month; manual in phase 1). */
export async function setMonthlyTaxStatus(
  tx: PoolClient, ctx: TenantContext, employeeId: string,
  s: {
    year: number; month: number; taxBookActive: boolean; dependents: number; disabilityGroup: number;
    isPensioner?: boolean; isRepressed?: boolean;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO employee_tax_status(client_company_id, employee_id, year, month, tax_book_active, dependents, disability_group, is_pensioner, is_repressed)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (employee_id, year, month)
     DO UPDATE SET tax_book_active = EXCLUDED.tax_book_active,
                   dependents = EXCLUDED.dependents,
                   disability_group = EXCLUDED.disability_group,
                   is_pensioner = EXCLUDED.is_pensioner,
                   is_repressed = EXCLUDED.is_repressed`,
    [ctx.clientCompanyId, employeeId, s.year, s.month, s.taxBookActive, s.dependents, s.disabilityGroup,
     s.isPensioner ?? false, s.isRepressed ?? false],
  );
  await appendAudit(tx, ctx, {
    action: 'update', entityType: 'employee_tax_status', entityId: employeeId,
    before: null, after: s,
  });
}

/**
 * Tax status for the month. Exact row -> stale:false. No exact row -> most recent
 * EARLIER month (stale:true — the run must warn per doc 2.2). Nothing at all -> null
 * (the run treats the tax book as inactive and warns).
 */
export async function taxStatusFor(
  tx: PoolClient, ctx: TenantContext, employeeId: string, year: number, month: number,
): Promise<(MonthlyTaxStatus & { stale: boolean }) | null> {
  const res = await tx.query(
    `SELECT year, month, tax_book_active AS "taxBookActive", dependents, disability_group AS "disabilityGroup",
            is_pensioner AS "isPensioner", is_repressed AS "isRepressed"
     FROM employee_tax_status
     WHERE employee_id = $1 AND client_company_id = $2 AND (year*12 + month) <= $3
     ORDER BY year DESC, month DESC LIMIT 1`,
    [employeeId, ctx.clientCompanyId, year * 12 + month],
  );
  if (!res.rowCount) return null;
  const r = res.rows[0];
  return {
    taxBookActive: r.taxBookActive, dependents: r.dependents, disabilityGroup: r.disabilityGroup,
    isPensioner: r.isPensioner, isRepressed: r.isRepressed,
    stale: !(r.year === year && r.month === month),
  };
}

/** Import pre-system months for average-earnings (doc 2.1: last 6 months before entry). */
export async function importOpeningHistory(
  tx: PoolClient, ctx: TenantContext, employeeId: string,
  rows: { year: number; month: number; avgBaseGross: string; workedDays: number }[],
): Promise<void> {
  for (const r of rows) {
    await tx.query(
      `INSERT INTO employee_opening_history(client_company_id, employee_id, year, month, avg_base_gross, worked_days)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [ctx.clientCompanyId, employeeId, r.year, r.month, moneyStr.parse(r.avgBaseGross), r.workedDays],
    );
  }
  await appendAudit(tx, ctx, {
    action: 'create', entityType: 'employee_opening_history', entityId: employeeId,
    before: null, after: { rows },
  });
}
