import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant, appPool } from '../../src/db/pool.js';
import { createUser, listUsersForFirm } from '../../src/auth/users.js';
import { listClientCompaniesForFirm, createClientCompany } from '../../src/tenancy/firms.js';
import { notify, listNotifications, markAllRead } from '../../src/collab/notifications.js';
import { addComment, listComments } from '../../src/collab/comments.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('listUsersForFirm returns all users in the firm', async () => {
  const t = await makeFirmAndClient();
  await createUser({ firmId: t.firmId, email: 'x@demo.lv', password: 'password123', role: 'employee' });
  const users = await listUsersForFirm(t.firmId);
  expect(users.some((u) => u.email === 'x@demo.lv')).toBe(true);
  expect(users.every((u) => u.firmId === t.firmId)).toBe(true);
});

test('listClientCompaniesForFirm returns every client of the firm', async () => {
  const t = await makeFirmAndClient();
  await createClientCompany(t.firmId, { name: 'Second SIA', regNo: '40000000099' });
  const clients = await listClientCompaniesForFirm(t.firmId);
  expect(clients.length).toBeGreaterThanOrEqual(2);
  expect(clients.every((c) => c.firmId === t.firmId)).toBe(true);
});

test('markAllRead marks every notification for the recipient read; rows carry createdAt', async () => {
  const t = await makeFirmAndClient();
  const c = ctx(t);
  await withTenant(c, async (tx) => {
    await notify(tx, c, { recipient: c.actorId, kind: 'deadline', message: 'a' });
    await notify(tx, c, { recipient: c.actorId, kind: 'deadline', message: 'b' });
    await markAllRead(tx, c, c.actorId);
  });
  const rows = await withTenant(c, (tx) => listNotifications(tx, c, c.actorId));
  expect(rows.length).toBe(2);
  expect(rows.every((r) => r.read === true)).toBe(true);
  expect(typeof rows[0]!.createdAt).toBe('string');
});

test('listComments rows carry createdAt', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await addComment(tx, ctx(t), { entityType: 'task', entityId: '11111111-1111-1111-1111-111111111111', body: 'hi' });
  });
  const rows = await withTenant(ctx(t), (tx) => listComments(tx, ctx(t), 'task', '11111111-1111-1111-1111-111111111111'));
  expect(typeof rows[0]!.createdAt).toBe('string');
});
