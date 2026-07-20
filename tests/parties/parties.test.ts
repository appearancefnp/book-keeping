import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createParty, getParty, listParties, updateParty, dueDateFromTerms } from '../../src/parties/parties.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('creates a vendor and reads it back', async () => {
  const t = await makeFirmAndClient();
  const { id } = await withTenant(ctx(t), (tx) => createParty(tx, ctx(t), { kind: 'vendor', name: 'SIA Piegādātājs', regNo: '40100000000' }));
  const p = await withTenant(ctx(t), (tx) => getParty(tx, ctx(t), id));
  expect(p.kind).toBe('vendor');
  expect(p.name).toBe('SIA Piegādātājs');
});

test('lists parties filtered by kind, ordered by name', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await createParty(tx, ctx(t), { kind: 'customer', name: 'Beta' });
    await createParty(tx, ctx(t), { kind: 'customer', name: 'Alfa' });
    await createParty(tx, ctx(t), { kind: 'vendor', name: 'Gamma' });
  });
  const customers = await withTenant(ctx(t), (tx) => listParties(tx, ctx(t), { kind: 'customer' }));
  expect(customers.map((p) => p.name)).toEqual(['Alfa', 'Beta']);
});

test('updateParty changes mutable fields', async () => {
  const t = await makeFirmAndClient();
  const { id } = await withTenant(ctx(t), (tx) => createParty(tx, ctx(t), { kind: 'customer', name: 'Old' }));
  await withTenant(ctx(t), (tx) => updateParty(tx, ctx(t), id, { name: 'New', vatNo: 'LV40100000000' }));
  const p = await withTenant(ctx(t), (tx) => getParty(tx, ctx(t), id));
  expect(p.name).toBe('New');
  expect(p.vatNo).toBe('LV40100000000');
});

test('rejects an invalid kind', async () => {
  const t = await makeFirmAndClient();
  await expect(withTenant(ctx(t), (tx) => createParty(tx, ctx(t), { kind: 'bogus' as never, name: 'X' }))).rejects.toThrow();
});

test('stores and updates a customer default payment terms', async () => {
  const t = await makeFirmAndClient();
  const cid = ctx(t);
  const created = await withTenant(cid, (tx) => createParty(tx, cid, { kind: 'customer', name: 'SIA Klients', paymentTermsDays: 14 }));
  const afterCreate = await withTenant(cid, (tx) => getParty(tx, cid, created.id));
  expect(afterCreate.paymentTermsDays).toBe(14);
  await withTenant(cid, (tx) => updateParty(tx, cid, created.id, { paymentTermsDays: 30 }));
  const afterUpdate = await withTenant(cid, (tx) => getParty(tx, cid, created.id));
  expect(afterUpdate.paymentTermsDays).toBe(30);
});

// Task 7 — the einvoices compose route falls back to this pure helper when the caller supplies
// neither an explicit dueDate nor an invoice.dueDate, deriving it from the customer's terms.
test('dueDateFromTerms adds payment-terms days to the issue date, crossing month/year boundaries', () => {
  expect(dueDateFromTerms('2026-03-10', 14)).toBe('2026-03-24');
  expect(dueDateFromTerms('2026-01-20', 14)).toBe('2026-02-03');
  expect(dueDateFromTerms('2026-12-25', 10)).toBe('2027-01-04');
  expect(dueDateFromTerms('2026-03-10', 0)).toBe('2026-03-10');
});
