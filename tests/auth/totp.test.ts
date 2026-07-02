import { expect, test } from 'vitest';
import { generateTotpSecret, verifyTotp, totpCodeFor } from '../../src/auth/totp.js';

test('a freshly generated code verifies at the same time step', () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000;
  const code = totpCodeFor(secret, now);
  expect(verifyTotp(secret, code, now)).toBe(true);
});
test('a wrong code does not verify', () => {
  const secret = generateTotpSecret();
  expect(verifyTotp(secret, '000000', 1_700_000_000)).toBe(false);
});
test('accepts the previous 30s window (clock skew tolerance)', () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000;
  const prev = totpCodeFor(secret, now - 30);
  expect(verifyTotp(secret, prev, now)).toBe(true);
});
