import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('migration adds doc_type to einvoices and vendor_credit_notes tables', async () => {
  const t = await makeFirmAndClient();
  const cols = await withTenant(ctx(t), async (tx) =>
    (await tx.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'einvoices' AND column_name IN ('doc_type','corrected_invoice_number')`,
    )).rows.map((r) => r.column_name).sort(),
  );
  expect(cols).toEqual(['corrected_invoice_number', 'doc_type']);

  const tbl = await withTenant(ctx(t), async (tx) =>
    (await tx.query(
      `SELECT to_regclass('public.vendor_credit_notes') AS a, to_regclass('public.vendor_credit_note_lines') AS b`,
    )).rows[0],
  );
  expect(tbl.a).toBe('vendor_credit_notes');
  expect(tbl.b).toBe('vendor_credit_note_lines');
});
