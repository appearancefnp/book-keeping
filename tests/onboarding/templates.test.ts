import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { setAutonomy } from '../../src/autonomy/autonomy.js';
import { setTariff } from '../../src/tariffs/tariffs.js';
import { listAccounts } from '../../src/ledger/accounts.js';
import { listAutonomyPolicies } from '../../src/autonomy/autonomy.js';
import { getCurrentTariff } from '../../src/tariffs/tariffs.js';
import {
  snapshotClientAsTemplate, listTemplatesForFirm, getTemplateBody, createClientFromTemplate,
} from '../../src/onboarding/templates.js';
import { appPool } from '../../src/db/pool.js';
import { randomUUID } from 'node:crypto';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

// Seed a source client with 2 accounts, 1 autonomy policy, 1 tariff.
async function seedSource(t: { firmId: string; clientCompanyId: string }) {
  const c = ctx(t);
  await withTenant(c, async (tx) => {
    await createAccount(tx, c, { code: '2310', name: 'Payables', type: 'liability' });
    await createAccount(tx, c, { code: '6110', name: 'Purchases', type: 'expense' });
    await setAutonomy(tx, c, { operationType: 'posting', mode: 'approval', materialThresholdCents: 100000n });
    await setTariff(tx, c, { monthlyAmountCents: 150000n, currency: 'EUR', vatRate: '21', effectiveFrom: '2026-01-01' });
  });
  return c;
}

test('snapshotClientAsTemplate captures accounts + autonomy + tariff into the body', async () => {
  const t = await makeFirmAndClient();
  const c = await seedSource(t);
  const { id } = await withTenant(c, (tx) => snapshotClientAsTemplate(tx, c, 'Standard SIA'));
  expect(id).toBeTruthy();
  const body = await getTemplateBody(t.firmId, id);
  expect(body!.accounts.length).toBe(2);
  expect(body!.accounts.map((a) => a.code).sort()).toEqual(['2310', '6110']);
  expect(body!.autonomy.length).toBe(1);
  expect(body!.autonomy[0]!.operationType).toBe('posting');
  expect(body!.tariff?.monthlyAmountCents).toBe('150000');
});

test('createClientFromTemplate seeds the new client and assigns the creator', async () => {
  const t = await makeFirmAndClient();
  const c = await seedSource(t);
  const { id: templateId } = await withTenant(c, (tx) => snapshotClientAsTemplate(tx, c, 'Standard SIA'));
  const actorId = randomUUID();
  const created = await createClientFromTemplate(
    t.firmId, { name: 'New SIA', regNo: '40199999999', baseCurrency: 'EUR' }, templateId, actorId,
  );
  const nctx = { firmId: t.firmId, clientCompanyId: created.id, actorId, actorRole: 'firm_admin' };
  const accounts = await withTenant(nctx, (tx) => listAccounts(tx, nctx));
  expect(accounts.map((a) => a.code).sort()).toEqual(['2310', '6110']);
  const pol = await withTenant(nctx, (tx) => listAutonomyPolicies(tx, nctx));
  expect(pol.length).toBe(1);
  const tar = await withTenant(nctx, (tx) => getCurrentTariff(tx, nctx, '2026-07-01'));
  expect(tar?.monthlyAmountCents).toBe('150000');
  const assigned = await appPool.query(
    'SELECT 1 FROM user_client_assignments WHERE user_id = $1 AND client_company_id = $2',
    [actorId, created.id],
  );
  expect(assigned.rowCount).toBe(1);
});

test('createClientFromTemplate with null template makes a bare client (creator assigned, no accounts)', async () => {
  const t = await makeFirmAndClient();
  const actorId = randomUUID();
  const created = await createClientFromTemplate(
    t.firmId, { name: 'Bare SIA', regNo: '40188888888' }, null, actorId,
  );
  const nctx = { firmId: t.firmId, clientCompanyId: created.id, actorId, actorRole: 'firm_admin' };
  const accounts = await withTenant(nctx, (tx) => listAccounts(tx, nctx));
  expect(accounts.length).toBe(0);
  const assigned = await appPool.query(
    'SELECT 1 FROM user_client_assignments WHERE user_id = $1 AND client_company_id = $2',
    [actorId, created.id],
  );
  expect(assigned.rowCount).toBe(1);
});

test('getTemplateBody / listTemplatesForFirm are firm-scoped', async () => {
  const a = await makeFirmAndClient('A client');
  const b = await makeFirmAndClient('B client'); // different firm
  const ca = await seedSource(a);
  const { id } = await withTenant(ca, (tx) => snapshotClientAsTemplate(tx, ca, 'A template'));
  // firm B cannot read firm A's template
  expect(await getTemplateBody(b.firmId, id)).toBeNull();
  expect((await listTemplatesForFirm(b.firmId)).length).toBe(0);
  const listA = await listTemplatesForFirm(a.firmId);
  expect(listA.length).toBe(1);
  expect(listA[0]!.accountCount).toBe(2);
  expect(listA[0]!.hasTariff).toBe(true);
});
