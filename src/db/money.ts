/** Parse a decimal money string ("100.00", "-5.5") into integer cents. Max 2 dp. */
export function toCents(s: string): bigint {
  if (!/^-?\d+(\.\d{1,2})?$/.test(s.trim())) {
    throw new Error(`Invalid money value: "${s}" (max 2 decimal places)`);
  }
  const neg = s.trim().startsWith('-');
  const [whole, frac = ''] = s.trim().replace('-', '').split('.');
  const cents = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
  return neg ? -cents : cents;
}

export function sumCents(values: string[]): bigint {
  return values.reduce<bigint>((acc, v) => acc + toCents(v), 0n);
}

export function centsEqual(a: bigint, b: bigint): boolean {
  return a === b;
}
