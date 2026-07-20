/**
 * Informational accrued late fee, in integer cents (returned as a decimal string).
 * fee = flatCents + round_half_up(outstandingCents * annualBps/10000 * daysOverdue/365).
 * All arithmetic is bigint so large balances never lose precision.
 */
export function accruedLateFeeCents(input: {
  outstandingCents: string; daysOverdue: number; annualBps: number; flatCents: string;
}): string {
  const flat = BigInt(input.flatCents);
  if (input.annualBps <= 0 || input.daysOverdue <= 0) return flat.toString();
  const outstanding = BigInt(input.outstandingCents);
  const numerator = outstanding * BigInt(input.annualBps) * BigInt(input.daysOverdue);
  const denominator = 10000n * 365n;
  // round half-up: (n + d/2) / d
  const interest = (numerator + denominator / 2n) / denominator;
  return (flat + interest).toString();
}
