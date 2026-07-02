import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createTask, listTasks, resolveTask } from '../../src/collab/tasks.js';
import { addComment, listComments } from '../../src/collab/comments.js';
import { notify, listNotifications, markRead } from '../../src/collab/notifications.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('task lifecycle: create -> list open -> resolve', async () => {
  const t = await makeFirmAndClient();
  const { id } = await withTenant(ctx(t), (tx) => createTask(tx, ctx(t), { title: 'Missing contract', detail: 'Need the vendor contract' }));
  expect((await withTenant(ctx(t), (tx) => listTasks(tx, ctx(t), { status: 'open' }))).length).toBe(1);
  await withTenant(ctx(t), (tx) => resolveTask(tx, ctx(t), id));
  expect((await withTenant(ctx(t), (tx) => listTasks(tx, ctx(t), { status: 'open' }))).length).toBe(0);
});
test('comments attach to an entity and list in order', async () => {
  const t = await makeFirmAndClient();
  const eid = '11111111-1111-1111-1111-111111111111';
  await withTenant(ctx(t), async (tx) => {
    await addComment(tx, ctx(t), { entityType: 'proposal', entityId: eid, body: 'first' });
    await addComment(tx, ctx(t), { entityType: 'proposal', entityId: eid, body: 'second' });
  });
  const comments = await withTenant(ctx(t), (tx) => listComments(tx, ctx(t), 'proposal', eid));
  expect(comments.map((c) => c.body)).toEqual(['first', 'second']);
});
test('notifications: create, list unread, mark read', async () => {
  const t = await makeFirmAndClient();
  const { id } = await withTenant(ctx(t), (tx) => notify(tx, ctx(t), { recipient: 'user-1', kind: 'approval_needed', message: 'A proposal awaits approval' }));
  expect((await withTenant(ctx(t), (tx) => listNotifications(tx, ctx(t), 'user-1', { unreadOnly: true }))).length).toBe(1);
  await withTenant(ctx(t), (tx) => markRead(tx, ctx(t), id));
  expect((await withTenant(ctx(t), (tx) => listNotifications(tx, ctx(t), 'user-1', { unreadOnly: true }))).length).toBe(0);
});
