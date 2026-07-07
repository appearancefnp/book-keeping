import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { getInvoiceProfile, setInvoiceProfile } from '../../src/einvoice/invoice-profile.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

const sample = {
  paymentTerms: 'Net 14', note: 'Thanks', dueDateOffsetDays: 14, numberPrefix: 'INV-2026-',
  defaultLines: [{ description: 'Retainer', net: '500.00', vatRate: 21 }],
};

test('getInvoiceProfile returns null when unset', async () => {
  const t = await makeFirmAndClient();
  const c = ctx(t);
  const p = await withTenant(c, (tx) => getInvoiceProfile(tx, c));
  expect(p).toBeNull();
});

test('setInvoiceProfile upserts (second set overwrites) and audits', async () => {
  const t = await makeFirmAndClient();
  const c = ctx(t);
  await withTenant(c, (tx) => setInvoiceProfile(tx, c, sample));
  await withTenant(c, (tx) => setInvoiceProfile(tx, c, { ...sample, numberPrefix: 'INV-B-' }));
  const p = await withTenant(c, (tx) => getInvoiceProfile(tx, c));
  expect(p!.numberPrefix).toBe('INV-B-');
  expect(p!.defaultLines[0]!.net).toBe('500.00');
  const audit = await withTenant(c, (tx) =>
    tx.query(`SELECT count(*)::int AS n FROM audit_log WHERE entity_type='invoice_profile'`));
  expect(audit.rows[0].n).toBeGreaterThanOrEqual(1);
  // upsert, not duplicate rows
  const rows = await withTenant(c, (tx) =>
    tx.query(`SELECT count(*)::int AS n FROM invoice_profiles`));
  expect(rows.rows[0].n).toBe(1);
});

test('RLS isolates profiles per client', async () => {
  const a = await makeFirmAndClient('A');
  const b = await makeFirmAndClient('B');
  const ca = ctx(a); const cb = ctx(b);
  await withTenant(ca, (tx) => setInvoiceProfile(tx, ca, sample));
  const fromB = await withTenant(cb, (tx) => getInvoiceProfile(tx, cb));
  expect(fromB).toBeNull();
});
