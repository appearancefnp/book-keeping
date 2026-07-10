import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createParty, getParty, updateParty } from '../../src/parties/parties.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('createParty stores iban and getParty returns it', async () => {
  const t = await makeFirmAndClient();
  const { id } = await withTenant(ctx(t), (tx) =>
    createParty(tx, ctx(t), { kind: 'vendor', name: 'Acme', iban: 'LV80BANK0000435195001' }));
  const p = await withTenant(ctx(t), (tx) => getParty(tx, ctx(t), id));
  expect(p.iban).toBe('LV80BANK0000435195001');
});

test('iban defaults to null and is patchable', async () => {
  const t = await makeFirmAndClient();
  const { id } = await withTenant(ctx(t), (tx) => createParty(tx, ctx(t), { kind: 'vendor', name: 'NoIban' }));
  let p = await withTenant(ctx(t), (tx) => getParty(tx, ctx(t), id));
  expect(p.iban).toBeNull();
  await withTenant(ctx(t), (tx) => updateParty(tx, ctx(t), id, { iban: 'LV12ABCD0000000000001' }));
  p = await withTenant(ctx(t), (tx) => getParty(tx, ctx(t), id));
  expect(p.iban).toBe('LV12ABCD0000000000001');
});
