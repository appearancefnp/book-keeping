import type { UserRole } from '../auth/users.js';

/**
 * Mutating operations that require route-level role gating (HANDOFF G1).
 *
 * The enforcement point is the API route, immediately after `resolveTenantContext`
 * establishes the actor's role and before the domain call. Centralising the matrix
 * here keeps the policy in one auditable place rather than copy-pasted per route.
 */
export type Operation =
  | 'periods.write' // open/close accounting periods
  | 'autonomy.write' // set agent autonomy policy
  | 'einvoice.issue' // issue an outbound invoice
  | 'bank.write' // import statements / build payment orders
  | 'parties.write' // create/update customers & vendors
  | 'payroll.write' // employees, orders, runs — firm-side only
  | 'invoice_profile.write'; // set invoice profile (payment terms, numbering, defaults)

/**
 * Which roles may perform each mutating operation.
 *
 * Firm-side roles (`firm_admin`, `accountant`) may do everything. Client-side roles
 * are scoped per spec §5: the client `employee` issues invoices ("izraksta rēķinus")
 * and manages parties (to pick a customer when invoicing); the `owner` may issue
 * invoices but not touch firm-controlled accounting settings (periods, autonomy).
 */
const OPERATION_ROLES: Record<Operation, readonly UserRole[]> = {
  'periods.write': ['firm_admin', 'accountant'],
  'autonomy.write': ['firm_admin', 'accountant'],
  'einvoice.issue': ['firm_admin', 'accountant', 'owner', 'employee'],
  'bank.write': ['firm_admin', 'accountant'],
  'parties.write': ['firm_admin', 'accountant', 'employee'],
  'payroll.write': ['firm_admin', 'accountant'],
  'invoice_profile.write': ['firm_admin', 'accountant'],
};

/** True if `role` is permitted to perform `op`. Unrecognised roles are denied. */
export function isRoleAllowed(role: string, op: Operation): boolean {
  return (OPERATION_ROLES[op] as readonly string[]).includes(role);
}

/**
 * Throw a `forbidden`-prefixed error if `role` may not perform `op`. The prefix is
 * recognised by the web layer's `errorToStatus` and mapped to HTTP 403.
 */
export function assertRoleAllowed(role: string, op: Operation): void {
  if (!isRoleAllowed(role, op)) {
    throw new Error(`forbidden: role '${role}' may not perform '${op}'`);
  }
}
