import { expect, test } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/auth/passwords.js';

test('hash then verify round-trips', () => {
  const stored = hashPassword('correct horse battery staple');
  expect(stored).toContain(':');
  expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
});
test('wrong password does not verify', () => {
  const stored = hashPassword('secret');
  expect(verifyPassword('guess', stored)).toBe(false);
});
test('two hashes of the same password differ (random salt)', () => {
  expect(hashPassword('x')).not.toBe(hashPassword('x'));
});
