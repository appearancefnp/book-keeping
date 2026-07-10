import { expect, test } from 'vitest';
import { computePayroll, type PayrollCalcInput } from '../../src/payroll/calc.js';
import type { PayrollParams } from '../../src/payroll/params.js';

// Frozen 2026 parameter set (same values migration 023 seeds).
const P: PayrollParams = {
  iinRateBasicBp: 2550n, iinRateTopBp: 3300n, iinRateBand3Bp: 3600n,
  iinThresholdMonthlyCents: 877500n, iinThreshold2MonthlyCents: 1666666n,
  nontaxableMinimumCents: 55000n, pensionerMinimumCents: 100000n, dependentReliefCents: 25000n,
  disabilityReliefGroup12Cents: 15400n, disabilityReliefGroup3Cents: 12000n, repressionReliefCents: 15400n,
  vsaoiEmployeeBp: 1050n, vsaoiEmployerBp: 2359n, vsaoiCapAnnualCents: 10530000n,
  minWageMonthlyCents: 78000n, riskDutyMonthlyCents: 36n,
  premiumNightBp: 5000n, premiumOvertimeBp: 10000n, premiumHolidayBp: 10000n,
  sickDay23Bp: 7500n, sickDay49Bp: 8000n,
  vacationDaysPerMonthHundredths: 167n, deductionCapBp: 2000n,
};

const BASE: PayrollCalcInput = {
  baseCents: 100000n, premiumCents: 0n, bonusCents: 0n, vacationPayCents: 0n,
  sickPayCents: 0n, otherTaxableCents: 0n, severanceExemptCents: 0n,
  taxBookActive: true, dependents: 0, disabilityGroup: 0,
  workedDays: 23, totalWorkDays: 23,
  requestedDeductionsCents: 0n, ytdVsaoiBaseCents: 0n,
};

test('standard month: 1000 EUR gross, tax book, 1 dependent -> net 870.77', () => {
  const r = computePayroll({ ...BASE, dependents: 1 }, P);
  expect(r.grossCents).toBe(100000n);
  expect(r.vsaoiEmployeeCents).toBe(10500n);     // 10.5%
  expect(r.nontaxableAppliedCents).toBe(55000n); // full month
  expect(r.dependentReliefCents).toBe(25000n);
  expect(r.iinBaseCents).toBe(9500n);            // 1000 - 105 - 550 - 250
  expect(r.iinCents).toBe(2423n);                // 25.5% of 95.00 = 24.225 -> 24.23
  expect(r.netCents).toBe(87077n);               // 870.77
  expect(r.payoutCents).toBe(87077n);
  expect(r.vsaoiEmployerCents).toBe(23590n);     // 23.59%
  expect(r.riskDutyCents).toBe(36n);
  expect(r.warnings).toEqual([]);
});

test('progressive IIN above the monthly threshold (progressiveMonthly on)', () => {
  const r = computePayroll({ ...BASE, baseCents: 1100000n, dependents: 0, progressiveMonthly: true }, P);
  // VSAOI 1155.00; base 11000-1155-550 = 9295.00; 8775 @25.5% + 520 @33% = 2409.225 -> 2409.23
  expect(r.vsaoiEmployeeCents).toBe(115500n);
  expect(r.iinBaseCents).toBe(929500n);
  expect(r.iinCents).toBe(240923n);
});

test('default (flat 25.5%): the same high earner is withheld a single rate monthly', () => {
  const r = computePayroll({ ...BASE, baseCents: 1100000n, dependents: 0 }, P);
  // base 9295.00 @ 25.5% flat = 2370.225 -> 2370.23 (33% band settled annually, not monthly)
  expect(r.iinBaseCents).toBe(929500n);
  expect(r.iinCents).toBe(237023n);
});

test('third band 36% above the 2nd threshold (progressiveMonthly on)', () => {
  // gross 20000.00: VSAOI 2100.00; base 20000-2100-550 = 17350.00 = 1735000c
  // 877500 @25.5% + 789166 @33% + 68334 @36% = 2237625000 + 2604247800 + 246002400 = 5087875200 /10000 -> 508788c
  const r = computePayroll({ ...BASE, baseCents: 2000000n, dependents: 0, progressiveMonthly: true }, P);
  expect(r.iinBaseCents).toBe(1735000n);
  expect(r.iinCents).toBe(508788n);
});

test('pensioner: the EUR 1000 minimum replaces the standard EUR 550', () => {
  const r = computePayroll({ ...BASE, isPensioner: true }, P);
  expect(r.nontaxableAppliedCents).toBe(100000n); // 1000.00
  // base 1000 - 105 - 1000 < 0 -> IIN base 0, IIN 0; net = 1000 - 105 = 895.00
  expect(r.iinBaseCents).toBe(0n);
  expect(r.iinCents).toBe(0n);
  expect(r.netCents).toBe(89500n);
});

test('politically-repressed relief is additive (EUR 154/mo)', () => {
  const r = computePayroll({ ...BASE, isRepressed: true }, P);
  expect(r.repressionReliefCents).toBe(15400n);
  // base 1000 - 105 - 550 - 154 = 191.00 @ 25.5% flat = 48.705 -> 48.71
  expect(r.iinBaseCents).toBe(19100n);
  expect(r.iinCents).toBe(4871n);
});

test('no active tax book: no reliefs at all', () => {
  const r = computePayroll({ ...BASE, taxBookActive: false, dependents: 3, disabilityGroup: 2 }, P);
  expect(r.nontaxableAppliedCents).toBe(0n);
  expect(r.dependentReliefCents).toBe(0n);
  expect(r.disabilityReliefCents).toBe(0n);
  expect(r.iinBaseCents).toBe(89500n); // 1000 - 105
});

test('non-taxable minimum prorated for a partial month (doc 3.1 step 3)', () => {
  // Worked 10 of 22 workdays; base prorated by the caller to 454.55
  const r = computePayroll({ ...BASE, baseCents: 45455n, workedDays: 10, totalWorkDays: 22 }, P);
  expect(r.nontaxableAppliedCents).toBe(25000n); // 550 * 10/22 = 250.00
});

test('disability relief by group', () => {
  const g2 = computePayroll({ ...BASE, disabilityGroup: 2 }, P);
  expect(g2.disabilityReliefCents).toBe(15400n);
  const g3 = computePayroll({ ...BASE, disabilityGroup: 3 }, P);
  expect(g3.disabilityReliefCents).toBe(12000n);
});

test('IIN base never negative when reliefs exceed income', () => {
  const r = computePayroll({ ...BASE, baseCents: 40000n, dependents: 2 }, P);
  // 400 - 42 - 550 - 500 < 0 -> base 0, IIN 0
  expect(r.iinBaseCents).toBe(0n);
  expect(r.iinCents).toBe(0n);
});

test('other deductions capped at 20% of the payable amount (doc 3.1 step 6)', () => {
  const r = computePayroll({ ...BASE, requestedDeductionsCents: 50000n }, P);
  // payable before other deductions: 1000 - 105 - IIN(87.98) = 807.02; cap 20% = 161.40
  expect(r.iinCents).toBe(8798n); // (1000-105-550)*25.5% = 87.975 -> 87.98
  expect(r.deductionsAppliedCents).toBe(16140n);
  expect(r.netCents).toBe(80702n - 16140n);
  expect(r.warnings).toContain('deduction_capped');
});

test('statutory severance is paid out but never taxed (doc 3.8)', () => {
  const r = computePayroll({ ...BASE, severanceExemptCents: 100000n }, P);
  expect(r.grossCents).toBe(100000n);           // severance not in gross
  expect(r.payoutCents).toBe(r.netCents + 100000n);
});

test('below-minimum-wage warning for a full month', () => {
  const r = computePayroll({ ...BASE, baseCents: 70000n }, P);
  expect(r.warnings).toContain('below_minimum_wage');
  const partial = computePayroll({ ...BASE, baseCents: 70000n, workedDays: 15 }, P);
  expect(partial.warnings).not.toContain('below_minimum_wage');
});

test('VSAOI annual cap: warning only, withholding continues (solidarity tax)', () => {
  const r = computePayroll({ ...BASE, baseCents: 1000000n, ytdVsaoiBaseCents: 10000000n }, P);
  expect(r.vsaoiEmployeeCents).toBe(105000n); // still 10.5%
  expect(r.warnings).toContain('vsaoi_cap_reached');
});

test('every result carries a human-readable explanation trail', () => {
  const r = computePayroll({ ...BASE, dependents: 1 }, P);
  expect(r.explanation.length).toBeGreaterThanOrEqual(5);
  expect(r.explanation[0]!.step).toMatch(/bruto/i);
  for (const line of r.explanation) expect(line.amount).toMatch(/^-?\d+\.\d{2}$/);
});
