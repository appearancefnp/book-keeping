import { afterAll, beforeAll, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { adminPool } from '../../src/db/pool.js';
import { loadPayrollParams } from '../../src/payroll/params.js';

beforeAll(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('loads the 2026 parameter set as cents/basis points', async () => {
  const client = await adminPool.connect();
  try {
    const p = await loadPayrollParams(client, '2026-07-01');
    expect(p.iinRateBasicBp).toBe(2550n);
    expect(p.iinRateTopBp).toBe(3300n);
    expect(p.iinThresholdMonthlyCents).toBe(877500n); // 105300/12 = 8775.00
    expect(p.nontaxableMinimumCents).toBe(55000n);    // 2026 row, not 2025
    expect(p.dependentReliefCents).toBe(25000n);
    expect(p.disabilityReliefGroup12Cents).toBe(15400n);
    expect(p.disabilityReliefGroup3Cents).toBe(12000n);
    expect(p.vsaoiEmployeeBp).toBe(1050n);
    expect(p.vsaoiEmployerBp).toBe(2359n);
    expect(p.vsaoiCapAnnualCents).toBe(10530000n);
    expect(p.minWageMonthlyCents).toBe(78000n);
    expect(p.riskDutyMonthlyCents).toBe(36n);
    expect(p.premiumNightBp).toBe(5000n);
    expect(p.premiumOvertimeBp).toBe(10000n);
    expect(p.premiumHolidayBp).toBe(10000n);
    expect(p.sickDay23Bp).toBe(7500n);
    expect(p.sickDay49Bp).toBe(8000n);
    expect(p.vacationDaysPerMonthHundredths).toBe(167n);
    expect(p.deductionCapBp).toBe(2000n);
  } finally { client.release(); }
});

test('date-versioning: 2025 values before 2026', async () => {
  const client = await adminPool.connect();
  try {
    const p = await loadPayrollParams(client, '2025-06-01');
    expect(p.nontaxableMinimumCents).toBe(51000n);
    expect(p.minWageMonthlyCents).toBe(74000n);
  } finally { client.release(); }
});
