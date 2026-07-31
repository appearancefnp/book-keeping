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

test('updateParty can change the country and leaves other fields unchanged', async () => {
  const t = await makeFirmAndClient();
  const p = await withTenant(ctx(t), (tx) => createParty(tx, ctx(t), { kind: 'customer', name: 'TestCorp', regNo: '40100000004', countryCode: 'LV' }));
  await withTenant(ctx(t), (tx) => updateParty(tx, ctx(t), p.id, { countryCode: 'LT' }));
  const updated = await withTenant(ctx(t), (tx) => getParty(tx, ctx(t), p.id));
  expect(updated.countryCode).toBe('LT');
  expect(updated.name).toBe('TestCorp');
  expect(updated.regNo).toBe('40100000004');
});

test('updateParty rejects a one-letter country code and leaves the value unchanged', async () => {
  const t = await makeFirmAndClient();
  const p = await withTenant(ctx(t), (tx) => createParty(tx, ctx(t), { kind: 'customer', name: 'OneLetter', regNo: '40100000005', countryCode: 'FI' }));
  await expect(withTenant(ctx(t), (tx) => updateParty(tx, ctx(t), p.id, { countryCode: 'E' })))
    .rejects.toThrow();
  const unchanged = await withTenant(ctx(t), (tx) => getParty(tx, ctx(t), p.id));
  expect(unchanged.countryCode).toBe('FI');
});

test('updateParty rejects a three-letter country code', async () => {
  const t = await makeFirmAndClient();
  const p = await withTenant(ctx(t), (tx) => createParty(tx, ctx(t), { kind: 'customer', name: 'ThreeLetters', regNo: '40100000006', countryCode: 'DE' }));
  await expect(withTenant(ctx(t), (tx) => updateParty(tx, ctx(t), p.id, { countryCode: 'DEU' })))
    .rejects.toThrow();
  const unchanged = await withTenant(ctx(t), (tx) => getParty(tx, ctx(t), p.id));
  expect(unchanged.countryCode).toBe('DE');
});

test('updateParty rejects an empty string country code', async () => {
  const t = await makeFirmAndClient();
  const p = await withTenant(ctx(t), (tx) => createParty(tx, ctx(t), { kind: 'customer', name: 'EmptyString', regNo: '40100000007', countryCode: 'IT' }));
  await expect(withTenant(ctx(t), (tx) => updateParty(tx, ctx(t), p.id, { countryCode: '' })))
    .rejects.toThrow();
  const unchanged = await withTenant(ctx(t), (tx) => getParty(tx, ctx(t), p.id));
  expect(unchanged.countryCode).toBe('IT');
});

test('updateParty uppercases a valid lowercase country code', async () => {
  const t = await makeFirmAndClient();
  const p = await withTenant(ctx(t), (tx) => createParty(tx, ctx(t), { kind: 'customer', name: 'LowercaseCC', regNo: '40100000008' }));
  await withTenant(ctx(t), (tx) => updateParty(tx, ctx(t), p.id, { countryCode: 'pl' }));
  const updated = await withTenant(ctx(t), (tx) => getParty(tx, ctx(t), p.id));
  expect(updated.countryCode).toBe('PL');
});

test('creating a party with no country audits countryCode: LV', async () => {
  const t = await makeFirmAndClient();
  const p = await withTenant(ctx(t), (tx) => createParty(tx, ctx(t), { kind: 'customer', name: 'NoCountry', regNo: '40100000009' }));

  const auditRows = await withTenant(ctx(t), (tx) => tx.query(
    `SELECT after FROM audit_log WHERE client_company_id = $1 AND entity_type = 'party' AND entity_id = $2 AND action = 'create'`,
    [t.clientCompanyId, p.id]
  ));

  expect(auditRows.rowCount).toBe(1);
  const after = auditRows.rows[0].after;
  expect(after.countryCode).toBe('LV');
});
