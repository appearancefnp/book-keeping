import type { PoolClient } from 'pg';
import { getTaxRate } from '../tax/rules.js';
import { toCents } from '../db/money.js';

/** All national payroll parameters effective on one date, pre-parsed for integer math.
 *  Money fields are cents; *Bp fields are basis points ('25.5' -> 2550n). */
export interface PayrollParams {
  iinRateBasicBp: bigint;
  iinRateTopBp: bigint;
  iinRateBand3Bp: bigint;
  iinThresholdMonthlyCents: bigint;
  iinThreshold2MonthlyCents: bigint;
  nontaxableMinimumCents: bigint;
  pensionerMinimumCents: bigint;
  dependentReliefCents: bigint;
  disabilityReliefGroup12Cents: bigint;
  disabilityReliefGroup3Cents: bigint;
  repressionReliefCents: bigint;
  vsaoiEmployeeBp: bigint;
  vsaoiEmployerBp: bigint;
  vsaoiCapAnnualCents: bigint;
  minWageMonthlyCents: bigint;
  riskDutyMonthlyCents: bigint;
  premiumNightBp: bigint;
  premiumOvertimeBp: bigint;
  premiumHolidayBp: bigint;
  sickDay23Bp: bigint;
  sickDay49Bp: bigint;
  vacationDaysPerMonthHundredths: bigint;
  deductionCapBp: bigint;
}

export async function loadPayrollParams(tx: PoolClient, onDate: string): Promise<PayrollParams> {
  const v = async (ruleType: string) => toCents((await getTaxRate(tx, ruleType, onDate)).value);
  return {
    iinRateBasicBp: await v('payroll_iin_rate_basic'),
    iinRateTopBp: await v('payroll_iin_rate_top'),
    iinRateBand3Bp: await v('payroll_iin_rate_band3'),
    iinThresholdMonthlyCents: (await v('payroll_iin_threshold_annual')) / 12n, // 10530000/12 = 877500 exact
    iinThreshold2MonthlyCents: (await v('payroll_iin_threshold2_annual')) / 12n, // 20000000/12 = 1666666 (floor)
    nontaxableMinimumCents: await v('payroll_nontaxable_minimum_monthly'),
    pensionerMinimumCents: await v('payroll_pensioner_minimum_monthly'),
    dependentReliefCents: await v('payroll_dependent_relief_monthly'),
    disabilityReliefGroup12Cents: await v('payroll_disability_relief_group12_monthly'),
    disabilityReliefGroup3Cents: await v('payroll_disability_relief_group3_monthly'),
    repressionReliefCents: await v('payroll_repression_relief_monthly'),
    vsaoiEmployeeBp: await v('payroll_vsaoi_rate_employee'),
    vsaoiEmployerBp: await v('payroll_vsaoi_rate_employer'),
    vsaoiCapAnnualCents: await v('payroll_vsaoi_cap_annual'),
    minWageMonthlyCents: await v('payroll_min_wage_monthly'),
    riskDutyMonthlyCents: await v('payroll_risk_duty_monthly'),
    premiumNightBp: await v('payroll_premium_night_pct'),
    premiumOvertimeBp: await v('payroll_premium_overtime_pct'),
    premiumHolidayBp: await v('payroll_premium_holiday_pct'),
    sickDay23Bp: await v('payroll_sick_pay_day2_3_pct'),
    sickDay49Bp: await v('payroll_sick_pay_day4_9_pct'),
    vacationDaysPerMonthHundredths: await v('payroll_vacation_days_per_month'),
    deductionCapBp: await v('payroll_deduction_cap_pct'),
  };
}
