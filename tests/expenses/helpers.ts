import { withTenant } from '../../src/db/pool.js';
import { createEmployee } from '../../src/payroll/employees.js';
import { createUser } from '../../src/auth/users.js';
import { makeFirmAndClient, ctx } from '../helpers/db.js';
import type { TenantContext } from '../../src/tenancy/context.js';

const EMP_BASE = {
  position: 'Grāmatvede', contractDate: '2026-01-02', contractType: 'indefinite' as const,
  wageType: 'monthly' as const, wage: '1000.00', hiredOn: '2026-01-02', openingBalanceDate: '2026-01-02',
};

export interface Fixture {
  firmId: string; clientCompanyId: string;
  accountantCtx: TenantContext;
  employeeAId: string; employeeACtx: TenantContext;
  employeeBId: string; employeeBCtx: TenantContext;
  ownerEmployeeId: string; ownerCtx: TenantContext;
  unlinkedCtx: TenantContext;
}

/**
 * Firm + client with an accountant ctx, two 'employee'-role users each linked to their own
 * employee row (A, B), one 'owner'-role user linked to a third employee, and one 'employee'-role
 * user with no employee link (for the "not linked" error case).
 */
export async function setup(): Promise<Fixture> {
  const t = await makeFirmAndClient();
  const accountantCtx = ctx(t);

  const { id: userAId } = await createUser({ firmId: t.firmId, email: 'a@example.lv', password: 'password123', role: 'employee' });
  const { id: userBId } = await createUser({ firmId: t.firmId, email: 'b@example.lv', password: 'password123', role: 'employee' });
  const { id: userOwnerId } = await createUser({ firmId: t.firmId, email: 'owner@example.lv', password: 'password123', role: 'owner' });
  const { id: userUnlinkedId } = await createUser({ firmId: t.firmId, email: 'unlinked@example.lv', password: 'password123', role: 'employee' });

  const { employeeAId, employeeBId, ownerEmployeeId } = await withTenant(accountantCtx, async (tx) => {
    const a = await createEmployee(tx, accountantCtx, { ...EMP_BASE, firstName: 'Anna', lastName: 'Ozola', personalCode: '010190-12345', contractNo: 'DL-1' });
    const b = await createEmployee(tx, accountantCtx, { ...EMP_BASE, firstName: 'Baiba', lastName: 'Kalna', personalCode: '020290-23456', contractNo: 'DL-2' });
    const o = await createEmployee(tx, accountantCtx, { ...EMP_BASE, firstName: 'Oskars', lastName: 'Bērziņš', personalCode: '030390-34567', contractNo: 'DL-3' });
    await tx.query(`UPDATE employees SET user_id = $1 WHERE id = $2`, [userAId, a.id]);
    await tx.query(`UPDATE employees SET user_id = $1 WHERE id = $2`, [userBId, b.id]);
    await tx.query(`UPDATE employees SET user_id = $1 WHERE id = $2`, [userOwnerId, o.id]);
    return { employeeAId: a.id, employeeBId: b.id, ownerEmployeeId: o.id };
  });

  return {
    firmId: t.firmId, clientCompanyId: t.clientCompanyId, accountantCtx,
    employeeAId, employeeACtx: { firmId: t.firmId, clientCompanyId: t.clientCompanyId, actorId: userAId, actorRole: 'employee' },
    employeeBId, employeeBCtx: { firmId: t.firmId, clientCompanyId: t.clientCompanyId, actorId: userBId, actorRole: 'employee' },
    ownerEmployeeId, ownerCtx: { firmId: t.firmId, clientCompanyId: t.clientCompanyId, actorId: userOwnerId, actorRole: 'owner' },
    unlinkedCtx: { firmId: t.firmId, clientCompanyId: t.clientCompanyId, actorId: userUnlinkedId, actorRole: 'employee' },
  };
}
