import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { appendAudit } from '../../src/audit/audit.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('appends an audit row scoped to the tenant', async () => {
  const t = await makeFirmAndClient();
  const rows = await withTenant(ctx(t), async (tx) => {
    await appendAudit(tx, ctx(t), {
      action: 'create', entityType: 'account', entityId: null,
      before: null, after: { code: '2310' },
    });
    const r = await tx.query('SELECT action, entity_type, after FROM audit_log');
    return r.rows;
  });
  expect(rows).toHaveLength(1);
  expect(rows[0].action).toBe('create');
  expect(rows[0].after).toEqual({ code: '2310' });
});
