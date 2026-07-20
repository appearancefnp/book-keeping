import { timingSafeEqual } from 'node:crypto';

/** Constant-time check of a cron route's Authorization header. Fail closed: no CRON_SECRET → false. */
export function cronAuthorized(authHeader: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || !authHeader) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const got = Buffer.from(authHeader);
  return got.length === expected.length && timingSafeEqual(got, expected);
}
