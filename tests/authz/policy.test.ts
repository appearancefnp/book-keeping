import { describe, expect, test } from 'vitest';
import { assertRoleAllowed, isRoleAllowed, type Operation } from '../../src/authz/policy.js';
import type { UserRole } from '../../src/auth/users.js';

const ALL_ROLES: UserRole[] = ['firm_admin', 'accountant', 'owner', 'employee'];

// The confirmed role matrix (docs/HANDOFF-audit-fixes.md G1). Each operation lists
// exactly the roles that MAY perform it; every other role must be rejected.
const MATRIX: Record<Operation, UserRole[]> = {
  'periods.write': ['firm_admin', 'accountant'],
  'autonomy.write': ['firm_admin', 'accountant'],
  'einvoice.issue': ['firm_admin', 'accountant', 'owner', 'employee'],
  'bank.write': ['firm_admin', 'accountant'],
  'parties.write': ['firm_admin', 'accountant', 'employee'],
};

describe('authz policy — role matrix', () => {
  for (const op of Object.keys(MATRIX) as Operation[]) {
    const allowed = MATRIX[op];
    for (const role of ALL_ROLES) {
      const shouldAllow = allowed.includes(role);
      test(`${role} ${shouldAllow ? 'may' : 'may NOT'} ${op}`, () => {
        expect(isRoleAllowed(role, op)).toBe(shouldAllow);
        if (shouldAllow) {
          expect(() => assertRoleAllowed(role, op)).not.toThrow();
        } else {
          expect(() => assertRoleAllowed(role, op)).toThrow(/forbidden/i);
        }
      });
    }
  }
});

describe('authz policy — unknown role', () => {
  test('an unrecognised role is denied every operation', () => {
    for (const op of Object.keys(MATRIX) as Operation[]) {
      expect(isRoleAllowed('agent', op)).toBe(false);
      expect(() => assertRoleAllowed('agent', op)).toThrow(/forbidden/i);
    }
  });
});
