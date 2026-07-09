/**
 * Integer math for payroll rates. Rates come from tax_rules as decimal strings and
 * are parsed with toCents into hundredths — for percentages that makes basis points:
 * '25.5' -> 2550n bp; for day counts: '1.67' -> 167n day-hundredths.
 * All amounts are non-negative integer cents; rounding is half-up.
 */

/** numerator/denominator with half-up rounding. Both must be >= 0, denominator > 0. */
export function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error(`divRound: denominator must be > 0, got ${denominator}`);
  return (2n * numerator + denominator) / (2n * denominator);
}

/** Apply a basis-point rate (2550n = 25.5%) to an amount in cents, half-up. */
export function applyBp(amountCents: bigint, rateBp: bigint): bigint {
  return divRound(amountCents * rateBp, 10000n);
}
