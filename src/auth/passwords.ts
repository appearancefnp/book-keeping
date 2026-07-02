import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** Returns "saltHex:hashHex". scrypt with a random 16-byte salt. */
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const hash = Buffer.from(hashHex, 'hex');
  const check = scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  return hash.length === check.length && timingSafeEqual(hash, check);
}
