/** Shared money-formatting utilities for the tax module. */

/** Convert a cent-denominated integer string to a 2-decimal-place string. Handles negatives. */
export function centsToDecimal(cents: string): string {
  const n = BigInt(cents);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '00');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}
