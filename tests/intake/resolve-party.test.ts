import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createParty } from '../../src/parties/parties.js';
import { resolveParty } from '../../src/intake/resolve-party.js';
import type { ExtractedInvoice } from '../../src/intake/extraction-schema.js';

const inv = (regNo: string | null): ExtractedInvoice => ({
  supplierName: 'SIA Piegādātājs', supplierRegNo: regNo, date: '2026-03-10', currency: 'EUR',
  lineItems: [{ description: 'A', net: '100.00', vatRate: 21, vat: '21.00' }],
  vatTotal: '21.00', netTotal: '100.00', grandTotal: '121.00',
});

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('resolves to an existing vendor by reg number', async () => {
  const t = await makeFirmAndClient();
  const existing = await withTenant(ctx(t), (tx) => createParty(tx, ctx(t), { kind: 'vendor', name: 'SIA Piegādātājs', regNo: '40100000000' }));
  const r = await withTenant(ctx(t), (tx) => resolveParty(tx, ctx(t), inv('40100000000')));
  expect(r.partyId).toBe(existing.id);
  expect(r.isNew).toBe(false);
});

test('flags a new supplier when no reg match exists', async () => {
  const t = await makeFirmAndClient();
  const r = await withTenant(ctx(t), (tx) => resolveParty(tx, ctx(t), inv('49999999999')));
  expect(r.partyId).toBeNull();
  expect(r.isNew).toBe(true);
});
