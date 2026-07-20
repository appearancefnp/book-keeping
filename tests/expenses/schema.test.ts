import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { adminPool, withTenant } from '../../src/db/pool.js';
import { createEmployee } from '../../src/payroll/employees.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

const EMP = {
  firstName: 'Anna', lastName: 'Ozola', personalCode: '010190-12345', position: 'Grāmatvede',
  contractNo: 'DL-1', contractDate: '2026-01-02', contractType: 'indefinite' as const,
  wageType: 'monthly' as const, wage: '1000.00',
  hiredOn: '2026-01-02', openingBalanceDate: '2026-01-02',
};

test('expense_claims, expense_claim_lines, expense_settings exist with RLS forced', async () => {
  const res = await adminPool.query(
    `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
     WHERE relname IN ('expense_claims', 'expense_claim_lines', 'expense_settings')`,
  );
  expect(res.rowCount).toBe(3);
  for (const row of res.rows) {
    expect(row.relrowsecurity, `${row.relname} should have RLS enabled`).toBe(true);
    expect(row.relforcerowsecurity, `${row.relname} should FORCE RLS`).toBe(true);
  }
});

test('employees gains nullable user_id / iban; expense_claims has reimbursement_bank_transaction_id with partial unique index', async () => {
  const cols = await adminPool.query(
    `SELECT column_name, is_nullable, data_type FROM information_schema.columns
     WHERE table_name = 'employees' AND column_name IN ('user_id', 'iban')`,
  );
  expect(cols.rowCount).toBe(2);
  const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]));
  expect(byName.user_id.is_nullable).toBe('YES');
  expect(byName.user_id.data_type).toBe('uuid');
  expect(byName.iban.is_nullable).toBe('YES');
  expect(byName.iban.data_type).toBe('text');

  const claimCol = await adminPool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'expense_claims' AND column_name = 'reimbursement_bank_transaction_id'`,
  );
  expect(claimCol.rowCount).toBe(1);

  const idx = await adminPool.query(
    `SELECT indexdef FROM pg_indexes WHERE tablename = 'expense_claims' AND indexname = 'expense_claims_reimb_txn_uidx'`,
  );
  expect(idx.rowCount).toBe(1);
  expect(idx.rows[0].indexdef).toMatch(/UNIQUE/i);
  expect(idx.rows[0].indexdef).toMatch(/WHERE/i);
});

test('documents source CHECK accepts \'expense\' and still rejects garbage', async () => {
  const t = ctx(await makeFirmAndClient());
  await withTenant(t, (tx) => tx.query(
    `INSERT INTO documents(client_company_id, source, storage_key, mime, uploaded_by)
     VALUES ($1, 'expense', 'k1', 'image/png', 'test')`,
    [t.clientCompanyId],
  ));

  await expect(withTenant(t, (tx) => tx.query(
    `INSERT INTO documents(client_company_id, source, storage_key, mime, uploaded_by)
     VALUES ($1, 'nonsense', 'k2', 'image/png', 'test')`,
    [t.clientCompanyId],
  ))).rejects.toThrow(/violates check constraint/i);
});

test('expense_claims status CHECK rejects \'bogus\'', async () => {
  const t = ctx(await makeFirmAndClient());
  const { id: employeeId } = await withTenant(t, (tx) => createEmployee(tx, t, EMP));

  await expect(withTenant(t, (tx) => tx.query(
    `INSERT INTO expense_claims(client_company_id, employee_id, status) VALUES ($1, $2, 'bogus')`,
    [t.clientCompanyId, employeeId],
  ))).rejects.toThrow(/violates check constraint/i);
});

test('tenant isolation: a claim inserted for client A is invisible under client B', async () => {
  const a = ctx(await makeFirmAndClient('SIA A'));
  const b = ctx(await makeFirmAndClient('SIA B'));
  const { id: employeeId } = await withTenant(a, (tx) => createEmployee(tx, a, EMP));

  await withTenant(a, (tx) => tx.query(
    `INSERT INTO expense_claims(client_company_id, employee_id) VALUES ($1, $2)`,
    [a.clientCompanyId, employeeId],
  ));

  const seenByB = await withTenant(b, (tx) => tx.query(`SELECT id FROM expense_claims`));
  expect(seenByB.rowCount).toBe(0);

  const seenByA = await withTenant(a, (tx) => tx.query(`SELECT id FROM expense_claims`));
  expect(seenByA.rowCount).toBe(1);
});
