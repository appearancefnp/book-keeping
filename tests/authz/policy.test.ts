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
  'payroll.write': ['firm_admin', 'accountant'],
  'invoice_profile.write': ['firm_admin', 'accountant'],
  'bills.write': ['firm_admin', 'accountant', 'employee'],
  'payruns.write': ['firm_admin', 'accountant', 'employee'],
  'proposals.decide': ['firm_admin', 'accountant', 'owner'],
  'users.write': ['firm_admin'],
  'tasks.write': ['firm_admin', 'accountant', 'owner', 'employee'],
  'documents.capture': ['firm_admin', 'accountant', 'owner', 'employee'],
  'clients.write': ['firm_admin'],
  'tariffs.write': ['firm_admin'],
  'templates.write': ['firm_admin'],
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

test('users.write is firm_admin only', () => {
  expect(isRoleAllowed('firm_admin', 'users.write')).toBe(true);
  for (const role of ['accountant', 'owner', 'employee', 'agent', 'nonsense']) {
    expect(isRoleAllowed(role, 'users.write')).toBe(false);
  }
});

test('tasks.write and documents.capture allow all four roles, deny unknown', () => {
  for (const op of ['tasks.write', 'documents.capture'] as const) {
    for (const role of ['firm_admin', 'accountant', 'owner', 'employee']) {
      expect(isRoleAllowed(role, op)).toBe(true);
    }
    expect(isRoleAllowed('agent', op)).toBe(false);
    expect(isRoleAllowed('nonsense', op)).toBe(false);
  }
});

test('admin write ops are firm_admin only', () => {
  for (const op of ['clients.write', 'tariffs.write', 'templates.write'] as const) {
    expect(isRoleAllowed('firm_admin', op)).toBe(true);
    for (const role of ['accountant', 'owner', 'employee', 'nonsense']) {
      expect(isRoleAllowed(role, op)).toBe(false);
    }
  }
});
