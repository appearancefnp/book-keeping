import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export interface PayrollSettings {
  munRegime: boolean;
  iinProgressiveMonthly: boolean;
  accWageExpense: string;
  accSeveranceExpense: string;
  accEmployerVsaoiExpense: string;
  accRiskDutyExpense: string;
  accWagesPayable: string;
  accIinPayable: string;
  accVsaoiPayable: string;
  accRiskDutyPayable: string;
  accOtherDeductionsPayable: string;
  accVacationAccrualLiability: string;
  accVacationAccrualVsaoiLiability: string;
}

const SELECT_COLS = `mun_regime AS "munRegime", iin_progressive_monthly AS "iinProgressiveMonthly",
  acc_wage_expense AS "accWageExpense", acc_severance_expense AS "accSeveranceExpense",
  acc_employer_vsaoi_expense AS "accEmployerVsaoiExpense", acc_risk_duty_expense AS "accRiskDutyExpense",
  acc_wages_payable AS "accWagesPayable", acc_iin_payable AS "accIinPayable",
  acc_vsaoi_payable AS "accVsaoiPayable", acc_risk_duty_payable AS "accRiskDutyPayable",
  acc_other_deductions_payable AS "accOtherDeductionsPayable",
  acc_vacation_accrual_liability AS "accVacationAccrualLiability",
  acc_vacation_accrual_vsaoi_liability AS "accVacationAccrualVsaoiLiability"`;

/** Read the client's payroll settings, creating the default row on first use. */
export async function getPayrollSettings(tx: PoolClient, ctx: TenantContext): Promise<PayrollSettings> {
  await tx.query(
    'INSERT INTO payroll_settings(client_company_id) VALUES ($1) ON CONFLICT (client_company_id) DO NOTHING',
    [ctx.clientCompanyId],
  );
  const res = await tx.query(
    `SELECT ${SELECT_COLS} FROM payroll_settings WHERE client_company_id = $1`,
    [ctx.clientCompanyId],
  );
  return res.rows[0];
}

/** Standard LV chart entries for every account the payroll posting scheme touches (doc 3.4/3.7). */
const PAYROLL_ACCOUNTS: { key: keyof PayrollSettings; name: string; type: 'expense' | 'liability' }[] = [
  { key: 'accWageExpense', name: 'Darba algas (Wages expense)', type: 'expense' },
  { key: 'accSeveranceExpense', name: 'Atlaišanas pabalsti (Severance)', type: 'expense' },
  { key: 'accEmployerVsaoiExpense', name: 'Darba devēja VSAOI izmaksas', type: 'expense' },
  { key: 'accRiskDutyExpense', name: 'Riska nodevas izmaksas', type: 'expense' },
  { key: 'accWagesPayable', name: 'Norēķini par darba algu', type: 'liability' },
  { key: 'accIinPayable', name: 'IIN saistības', type: 'liability' },
  { key: 'accVsaoiPayable', name: 'VSAOI saistības', type: 'liability' },
  { key: 'accRiskDutyPayable', name: 'Riska nodevas saistības', type: 'liability' },
  { key: 'accOtherDeductionsPayable', name: 'Citi ieturējumi (uzturlīdzekļi u.c.)', type: 'liability' },
  { key: 'accVacationAccrualLiability', name: 'Uzkrātās saistības — atvaļinājumi', type: 'liability' },
  { key: 'accVacationAccrualVsaoiLiability', name: 'Uzkrātās saistības — VSAOI par atvaļinājumiem', type: 'liability' },
];

/** Create any missing payroll accounts in the client's chart. Idempotent. */
export async function ensurePayrollAccounts(tx: PoolClient, ctx: TenantContext): Promise<void> {
  const s = await getPayrollSettings(tx, ctx);
  for (const a of PAYROLL_ACCOUNTS) {
    await tx.query(
      `INSERT INTO accounts(client_company_id, code, name, type) VALUES ($1,$2,$3,$4)
       ON CONFLICT (client_company_id, code) DO NOTHING`,
      [ctx.clientCompanyId, s[a.key], a.name, a.type],
    );
  }
}
