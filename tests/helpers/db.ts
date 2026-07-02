import { randomUUID } from 'node:crypto';
import { adminPool, appPool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createFirm, createClientCompany } from '../../src/tenancy/firms.js';
import type { TenantContext } from '../../src/tenancy/context.js';

let seq = 0;

/** Wipe the public schema (as admin, to also drop the migrations table cleanly) and re-run migrations. */
export async function resetDb(): Promise<void> {
  await adminPool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations();
}

export async function closeDb(): Promise<void> {
  await Promise.all([adminPool.end(), appPool.end()]);
}

export async function makeFirmAndClient(clientName = 'SIA Test'): Promise<{ firmId: string; clientCompanyId: string }> {
  const firm = await createFirm('Test Firm');
  const client = await createClientCompany(firm.id, { name: clientName, regNo: String(40000000000 + seq++) });
  return { firmId: firm.id, clientCompanyId: client.id };
}

export function ctx(t: { firmId: string; clientCompanyId: string }): TenantContext {
  return { firmId: t.firmId, clientCompanyId: t.clientCompanyId, actorId: randomUUID(), actorRole: 'accountant' };
}
