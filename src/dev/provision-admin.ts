import { appPool, adminPool } from '../db/pool.js';
import { requireEnv } from '../db/require-env.js';
import { runMigrations } from '../db/migrate.js';
import { createFirm } from '../tenancy/firms.js';
import { createUser, findUserByEmail } from '../auth/users.js';
import { createInvite } from '../auth/invites.js';
import { randomBytes } from 'node:crypto';

/**
 * One-off production provisioning: creates the firm + first firm_admin and
 * prints a one-time invite path. Idempotent on email: re-running re-invites.
 * Usage: PROVISION_FIRM="My Firm" PROVISION_EMAIL=me@firm.lv npm run provision-admin
 */
async function main() {
  requireEnv(['ADMIN_DATABASE_URL', 'DATABASE_URL']);
  const firmName = process.env.PROVISION_FIRM;
  const email = process.env.PROVISION_EMAIL;
  if (!firmName || !email) throw new Error('Set PROVISION_FIRM and PROVISION_EMAIL');
  await runMigrations();

  let user = await findUserByEmail(email);
  let userId: string;
  if (user) {
    const existingFirm = await appPool.query<{ name: string }>('SELECT name FROM firms WHERE id = $1', [user.firmId]);
    const actualFirmName = existingFirm.rows[0]?.name ?? '(unknown firm)';
    if (actualFirmName !== firmName) {
      console.error(
        `Refusing to provision: ${email} already belongs to firm "${actualFirmName}", not requested firm "${firmName}". ` +
          'No invite issued and nothing was changed.',
      );
      process.exit(1);
      return;
    }
    userId = user.id;
    console.log(`User ${email} exists in firm "${actualFirmName}" — issuing a credential-reset invite.`);
  } else {
    const firm = await createFirm(firmName);
    const created = await createUser({ firmId: firm.id, email, password: randomBytes(24).toString('hex'), role: 'firm_admin' });
    userId = created.id;
    console.log(`Created firm "${firmName}" and firm_admin ${email}.`);
  }
  const { token, expiresAtIso } = await createInvite(userId, userId, Math.floor(Date.now() / 1000));
  console.log(`\nInvite path (valid until ${expiresAtIso}, single use):\n  /invite/${token}\n`);
  console.log('Open it as https://<your-deployment>/invite/<token>');
}

main()
  .then(async () => { await Promise.all([appPool.end(), adminPool.end()]); })
  .catch((e) => { console.error(e); process.exit(1); });
