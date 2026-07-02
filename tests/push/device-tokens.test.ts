import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { registerDeviceToken, listDeviceTokens, pendingPushNotifications } from '../../src/push/device-tokens.js';
import { notify } from '../../src/collab/notifications.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('register is idempotent and lists tokens', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await registerDeviceToken(tx, ctx(t), { token: 'tok-1', platform: 'ios' });
    await registerDeviceToken(tx, ctx(t), { token: 'tok-1', platform: 'ios' }); // duplicate, no error
  });
  const tokens = await withTenant(ctx(t), (tx) => listDeviceTokens(tx, ctx(t)));
  expect(tokens).toHaveLength(1);
  expect(tokens[0]!.platform).toBe('ios');
});

test('pendingPushNotifications joins unread notifications to the recipient\'s device tokens', async () => {
  const t = await makeFirmAndClient();
  const c = ctx(t);
  await withTenant(c, async (tx) => {
    await registerDeviceToken(tx, c, { token: 'tok-1', platform: 'android' });
    await notify(tx, c, { recipient: c.actorId, kind: 'approval_needed', message: 'Approve please' });
  });
  const pending = await withTenant(c, (tx) => pendingPushNotifications(tx, c));
  expect(pending).toHaveLength(1);
  expect(pending[0]!.token).toBe('tok-1');
  expect(pending[0]!.message).toBe('Approve please');
});
