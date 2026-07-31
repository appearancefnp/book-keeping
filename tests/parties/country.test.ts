import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createParty, getParty, updateParty } from '../../src/parties/parties.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('a party defaults to LV and round-trips an explicit country', async () => {
  const t = await makeFirmAndClient();
  const [lv, ee] = await withTenant(ctx(t), async (tx) => [
    await createParty(tx, ctx(t), { kind: 'customer', name: 'SIA Local', regNo: '40100000001' }),
    await createParty(tx, ctx(t), { kind: 'customer', name: 'OU Eesti', regNo: '11111111', vatNo: 'EE101010101', countryCode: 'EE' }),
  ]);
  const lvRow = await withTenant(ctx(t), (tx) => getParty(tx, ctx(t), lv.id));
  const eeRow = await withTenant(ctx(t), (tx) => getParty(tx, ctx(t), ee.id));
  expect(lvRow.countryCode).toBe('LV');
  expect(eeRow.countryCode).toBe('EE');
});

test('the country code is normalised to upper case and must be two letters', async () => {
  const t = await makeFirmAndClient();
  const p = await withTenant(ctx(t), (tx) => createParty(tx, ctx(t), { kind: 'customer', name: 'X', regNo: '40100000002', countryCode: 'ee' }));
  expect((await withTenant(ctx(t), (tx) => getParty(tx, ctx(t), p.id))).countryCode).toBe('EE');
  await expect(withTenant(ctx(t), (tx) => createParty(tx, ctx(t), { kind: 'customer', name: 'Y', regNo: '40100000003', countryCode: 'EST' })))
    .rejects.toThrow();
});

test('updateParty can change the country', async () => {
  const t = await makeFirmAndClient();
  const p = await withTenant(ctx(t), (tx) => createParty(tx, ctx(t), { kind: 'customer', name: 'Z', regNo: '40100000004' }));
  await withTenant(ctx(t), (tx) => updateParty(tx, ctx(t), p.id, { countryCode: 'LT' }));
  expect((await withTenant(ctx(t), (tx) => getParty(tx, ctx(t), p.id))).countryCode).toBe('LT');
});
