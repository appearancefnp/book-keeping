import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant, withSupervisor } from '../../src/db/pool.js';
import { createParty } from '../../src/parties/parties.js';
import { createProposal, listProposals } from '../../src/proposals/proposals.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function seedTemplate(t: ReturnType<typeof ctx>) {
  await withTenant(t, async (tx) => {
    const { id: partyId } = await createParty(tx, t, { kind: 'customer', name: 'SIA Klients' });
    await tx.query(
      `INSERT INTO recurring_invoice_templates
         (client_company_id, customer_party_id, recipient_peppol_id, invoice_payload,
          anchor_day, interval_months, next_run_date)
       VALUES ($1,$2,'0088:x','{}'::jsonb,1,1,'2026-06-01')`,
      [t.clientCompanyId, partyId],
    );
  });
}

test('supervisor reads recurring templates across tenants; app sees only its own', async () => {
  const a = ctx(await makeFirmAndClient('SIA A'));
  const b = ctx(await makeFirmAndClient('SIA B'));
  await seedTemplate(a);
  await seedTemplate(b);

  const own = await withTenant(a, (tx) => tx.query(`SELECT id FROM recurring_invoice_templates`));
  expect(own.rowCount).toBe(1); // tenant isolation

  const all = await withSupervisor((tx) => tx.query(`SELECT client_company_id FROM recurring_invoice_templates`));
  expect(all.rowCount).toBe(2); // control-plane cross-tenant read
});

test('proposals accept the recurring_invoice type', async () => {
  const t = ctx(await makeFirmAndClient());
  await withTenant(t, (tx) => createProposal(tx, t, {
    type: 'recurring_invoice', payload: { hello: 'world' }, rationale: {}, status: 'pending_approval',
  }));
  const held = await withTenant(t, (tx) => listProposals(tx, t, { status: 'pending_approval' }));
  expect(held.map((p) => p.type)).toEqual(['recurring_invoice']);
});
