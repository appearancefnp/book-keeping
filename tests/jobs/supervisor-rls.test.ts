import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant, withSupervisor } from '../../src/db/pool.js';
import { setDunningPolicy } from '../../src/dunning/policy.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('supervisor reads dunning_policy + client_companies across tenants', async () => {
  const a = ctx(await makeFirmAndClient('SIA A'));
  const b = ctx(await makeFirmAndClient('SIA B'));
  for (const t of [a, b]) {
    await withTenant(t, (tx) => setDunningPolicy(tx, t, { enabled: true, lateFeeAnnualBps: 0, lateFeeFlatCents: '0' }));
  }
  const policies = await withSupervisor((tx) => tx.query(`SELECT client_company_id FROM dunning_policy`));
  expect(policies.rowCount).toBe(2);
  const companies = await withSupervisor((tx) => tx.query(`SELECT id, firm_id FROM client_companies`));
  expect(companies.rowCount).toBe(2);
});

test('supervisor can insert a job across tenants', async () => {
  const a = ctx(await makeFirmAndClient('SIA A'));
  await withSupervisor((tx) => tx.query(
    `INSERT INTO jobs(client_company_id, firm_id, type, run_at) VALUES ($1,$2,'test',now())`,
    [a.clientCompanyId, a.firmId],
  ));
  const jobs = await withSupervisor((tx) => tx.query(`SELECT id FROM jobs`));
  expect(jobs.rowCount).toBe(1);
});

test('supervisor has no privilege on other business tables', async () => {
  await expect(
    withSupervisor((tx) => tx.query(`SELECT id FROM einvoices LIMIT 1`)),
  ).rejects.toThrow(/permission denied/i);
});
