import { assertRoleAllowed, isRoleAllowed, type Operation } from '@domain/authz/policy.js';

export { assertRoleAllowed, isRoleAllowed };
export type { Operation };

/**
 * Map a caught error message to an HTTP status (HANDOFF G2 — uniform mapping).
 *
 * Replaces the crude per-route `/session/i ? 401 : 403`, which mislabelled
 * client-fixable failures (e.g. a duplicate party) as 403. Order matters: the
 * checks are evaluated top-to-bottom and the first match wins.
 *
 *  - session / expired / no token            → 401 (re-authenticate)
 *  - forbidden / denied / not authorized      → 403 (wrong role or client)
 *  - duplicate / unique / already exists       → 409 (conflicting state)
 *  - anything else                             → 400 (validation / bad input)
 */
export function errorToStatus(msg: string): number {
  if (/session|expired|not signed in|no token/i.test(msg)) return 401;
  if (/forbidden|denied|not authorized|not assigned|not permitted/i.test(msg)) return 403;
  if (/duplicate key|already exists|unique constraint/i.test(msg)) return 409;
  return 400;
}
