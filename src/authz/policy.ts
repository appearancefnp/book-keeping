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
  | 'invoice_profile.write' // set invoice profile (payment terms, numbering, defaults)
  | 'bills.write' // create/void accounts-payable bills
  | 'payruns.write' // create accounts-payable pay-runs (SEPA pain.001)
  | 'proposals.decide' // approve/reject proposals in the approval queue
  | 'users.write' // create users / issue credential-reset invites
  | 'tasks.write' // create/resolve/comment on collab tasks
  | 'documents.capture' // photograph/upload a document for AI intake
  | 'clients.write' // admin: create client companies
  | 'tariffs.write' // admin: manage tariffs
  | 'templates.write' // admin: manage onboarding templates
  | 'receivables.settle' // settle or void an AR receivable
  | 'dunning.write' // edit the dunning policy
  | 'dunning.run' // trigger a dunning run
  | 'expenses.write' // create/edit/submit/delete own (or, firm-side, any) expense claim
  | 'expenses.reimburse' // settle a claim / build a reimbursement payment order — firm-side only
  | 'expenses.settings.write' // set the client's mileage rate — firm-side only
  | 'filings.prepare' // prepare a VAT return / EC Sales List for approval — firm-side only
  | 'vat.settings.write'; // set the client's VAT number + filing periodicity — firm-side only

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
  'bills.write': ['firm_admin', 'accountant', 'employee'],
  'payruns.write': ['firm_admin', 'accountant', 'employee'],
  'proposals.decide': ['firm_admin', 'accountant', 'owner'],
  'users.write': ['firm_admin'],
  'tasks.write': ['firm_admin', 'accountant', 'owner', 'employee'],
  'documents.capture': ['firm_admin', 'accountant', 'owner', 'employee'],
  'clients.write': ['firm_admin'],
  'tariffs.write': ['firm_admin'],
  'templates.write': ['firm_admin'],
  'receivables.settle': ['firm_admin', 'accountant'],
  'dunning.write': ['firm_admin', 'accountant'],
  'dunning.run': ['firm_admin', 'accountant'],
  'expenses.write': ['firm_admin', 'accountant', 'owner', 'employee'],
  'expenses.reimburse': ['firm_admin', 'accountant'],
  'expenses.settings.write': ['firm_admin', 'accountant'],
  'filings.prepare': ['firm_admin', 'accountant'],
  'vat.settings.write': ['firm_admin', 'accountant'],
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
