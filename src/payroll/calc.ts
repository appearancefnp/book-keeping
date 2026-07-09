import { fromCents } from '../db/money.js';
import { applyBp, divRound } from './rates.js';
import type { PayrollParams } from './params.js';

/**
 * The strict calculation core (instruction doc 3.1 + section 6).
 * Pure and deterministic: same input -> same output, no DB, no AI.
 * The caller (run.ts) assembles the inputs; this function runs the fixed legal sequence.
 */

export interface PayrollCalcInput {
  baseCents: bigint;                // pay for time worked
  premiumCents: bigint;             // night/overtime/holiday supplements (doc 3.3)
  bonusCents: bigint;
  vacationPayCents: bigint;         // average-earnings based
  sickPayCents: bigint;             // employer A-lapa sick pay
  otherTaxableCents: bigint;
  severanceExemptCents: bigint;     // statutory severance: paid out, IIN- and VSAOI-exempt
  taxBookActive: boolean;
  dependents: number;
  disabilityGroup: 0 | 1 | 2 | 3;
  workedDays: number;               // prorates the non-taxable minimum
  totalWorkDays: number;
  requestedDeductionsCents: bigint; // maintenance / loans / union (doc 3.1 step 6)
  ytdVsaoiBaseCents: bigint;        // prior approved months' gross this calendar year
}

export interface ExplanationLine { step: string; amount: string; }

export interface PayrollCalcResult {
  grossCents: bigint;
  vsaoiEmployeeCents: bigint;
  nontaxableAppliedCents: bigint;
  dependentReliefCents: bigint;
  disabilityReliefCents: bigint;
  iinBaseCents: bigint;
  iinCents: bigint;
  deductionsAppliedCents: bigint;
  netCents: bigint;
  payoutCents: bigint;              // net + exempt severance
  vsaoiEmployerCents: bigint;
  riskDutyCents: bigint;
  warnings: string[];
  explanation: ExplanationLine[];
}

export function computePayroll(input: PayrollCalcInput, p: PayrollParams): PayrollCalcResult {
  const warnings: string[] = [];
  const explanation: ExplanationLine[] = [];
  const note = (step: string, cents: bigint) => explanation.push({ step, amount: fromCents(cents) });

  // 1. Gross = sum of taxable components (doc 3.1 step 1).
  const gross = input.baseCents + input.premiumCents + input.bonusCents
    + input.vacationPayCents + input.sickPayCents + input.otherTaxableCents;
  note('Bruto (pamatalga + piemaksas + prēmijas + atvaļinājums + slimības nauda + citi)', gross);

  // 2. Employee VSAOI (doc 3.1 step 2). Above the annual cap contributions continue
  //    at the same rates as solidarity tax, so withholding is unchanged — warn only.
  const vsaoiEmployee = applyBp(gross, p.vsaoiEmployeeBp);
  note('VSAOI darbinieka daļa', vsaoiEmployee);
  if (input.ytdVsaoiBaseCents + gross > p.vsaoiCapAnnualCents) warnings.push('vsaoi_cap_reached');

  // 3. Reliefs — only with an active tax book THIS month (doc 3.1 step 3).
  let nontaxable = 0n; let dependentRelief = 0n; let disabilityRelief = 0n;
  if (input.taxBookActive) {
    nontaxable = input.totalWorkDays > 0
      ? divRound(p.nontaxableMinimumCents * BigInt(input.workedDays), BigInt(input.totalWorkDays))
      : 0n;
    dependentRelief = p.dependentReliefCents * BigInt(input.dependents);
    disabilityRelief = input.disabilityGroup === 1 || input.disabilityGroup === 2
      ? p.disabilityReliefGroup12Cents
      : input.disabilityGroup === 3 ? p.disabilityReliefGroup3Cents : 0n;
    note('Neapliekamais minimums (proporcionāli nostrādātajam)', nontaxable);
    if (dependentRelief > 0n) note('Atvieglojums par apgādājamiem', dependentRelief);
    if (disabilityRelief > 0n) note('Invaliditātes atvieglojums', disabilityRelief);
  } else {
    note('Algas nodokļa grāmatiņa nav aktīva — atvieglojumi netiek piemēroti', 0n);
  }

  // 4. IIN base (doc 3.1 step 4), never negative.
  let iinBase = gross - vsaoiEmployee - nontaxable - dependentRelief - disabilityRelief;
  if (iinBase < 0n) iinBase = 0n;
  note('IIN bāze', iinBase);

  // 5. Progressive IIN (doc 3.1 step 5) — single half-up rounding across both bands.
  const below = iinBase < p.iinThresholdMonthlyCents ? iinBase : p.iinThresholdMonthlyCents;
  const above = iinBase - below;
  const iin = divRound(below * p.iinRateBasicBp + above * p.iinRateTopBp, 10000n);
  note('IIN (progresīvā skala)', iin);

  // 6. Other deductions capped at deduction_cap_pct of the payable amount (doc 3.1 step 6).
  const payableBeforeDeductions = gross - vsaoiEmployee - iin;
  const cap = applyBp(payableBeforeDeductions, p.deductionCapBp);
  let deductionsApplied = input.requestedDeductionsCents;
  if (deductionsApplied > cap) { deductionsApplied = cap; warnings.push('deduction_capped'); }
  if (deductionsApplied > 0n) note('Citi ieturējumi (ar griestiem)', deductionsApplied);

  // 7. Net + payout (doc 3.1 step 7). Statutory severance is exempt: payout only.
  const net = payableBeforeDeductions - deductionsApplied;
  const payout = net + input.severanceExemptCents;
  note('Neto', net);
  if (input.severanceExemptCents > 0n) note('Atlaišanas pabalsts (neapliekams)', input.severanceExemptCents);

  // 8. Employer-side costs (doc 3.1 last step) — never reduce the employee's net.
  const vsaoiEmployer = applyBp(gross, p.vsaoiEmployerBp);
  const riskDuty = p.riskDutyMonthlyCents;
  note('VSAOI darba devēja daļa', vsaoiEmployer);

  // Warnings.
  if (input.workedDays === input.totalWorkDays && input.totalWorkDays > 0
      && input.baseCents < p.minWageMonthlyCents) {
    warnings.push('below_minimum_wage');
  }

  return {
    grossCents: gross, vsaoiEmployeeCents: vsaoiEmployee,
    nontaxableAppliedCents: nontaxable, dependentReliefCents: dependentRelief, disabilityReliefCents: disabilityRelief,
    iinBaseCents: iinBase, iinCents: iin,
    deductionsAppliedCents: deductionsApplied, netCents: net, payoutCents: payout,
    vsaoiEmployerCents: vsaoiEmployer, riskDutyCents: riskDuty,
    warnings, explanation,
  };
}
