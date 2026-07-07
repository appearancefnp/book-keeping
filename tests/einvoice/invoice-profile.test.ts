import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { getInvoiceProfile, setInvoiceProfile, setInvoiceLogo } from '../../src/einvoice/invoice-profile.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

const sample = {
  paymentTerms: 'Net 14', note: 'Thanks', dueDateOffsetDays: 14, numberPrefix: 'INV-2026-',
  defaultLines: [{ description: 'Retainer', net: '500.00', vatRate: 21 }],
  footer: null,
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
  expect(audit.rows[0].n).toBe(2);
  // upsert, not duplicate rows
  const rows = await withTenant(c, (tx) =>
    tx.query(`SELECT count(*)::int AS n FROM invoice_profiles`));
  expect(rows.rows[0].n).toBe(1);
});

test('RLS isolates profiles per client (unfiltered query sees nothing cross-tenant)', async () => {
  const a = await makeFirmAndClient('A');
  const b = await makeFirmAndClient('B');
  const ca = ctx(a); const cb = ctx(b);
  await withTenant(ca, (tx) => setInvoiceProfile(tx, ca, sample));
  // Under client A's session, the row is visible.
  const seenByA = await withTenant(ca, (tx) => tx.query('SELECT count(*)::int AS n FROM invoice_profiles'));
  expect(seenByA.rows[0].n).toBe(1);
  // Under client B's session, an UNFILTERED select must see 0 rows — only RLS can be responsible
  // for hiding A's row here (no WHERE clause in the query).
  const seenByB = await withTenant(cb, (tx) => tx.query('SELECT count(*)::int AS n FROM invoice_profiles'));
  expect(seenByB.rows[0].n).toBe(0);
  // And the domain getter is null for B.
  expect(await withTenant(cb, (tx) => getInvoiceProfile(tx, cb))).toBeNull();
});

test('setInvoiceProfile writes footer but does not clobber an uploaded logo', async () => {
  const t = await makeFirmAndClient();
  const c = ctx(t);
  await withTenant(c, (tx) => setInvoiceLogo(tx, c, 'invoice-logo/x'));
  await withTenant(c, (tx) => setInvoiceProfile(tx, c, { ...sample, footer: 'Reg. LV123' }));
  const p = await withTenant(c, (tx) => getInvoiceProfile(tx, c));
  expect(p!.footer).toBe('Reg. LV123');
  expect(p!.logoBlobKey).toBe('invoice-logo/x'); // preserved
});

test('setInvoiceLogo upserts the key and audits', async () => {
  const t = await makeFirmAndClient();
  const c = ctx(t);
  await withTenant(c, (tx) => setInvoiceLogo(tx, c, 'invoice-logo/y'));
  const p = await withTenant(c, (tx) => getInvoiceProfile(tx, c));
  expect(p!.logoBlobKey).toBe('invoice-logo/y');
  const audit = await withTenant(c, (tx) =>
    tx.query(`SELECT count(*)::int AS n FROM audit_log WHERE entity_type='invoice_profile' AND action='set_logo'`));
  expect(audit.rows[0].n).toBe(1);
});
