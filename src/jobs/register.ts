// Registers production job handlers as a side effect of import.
import { registerHandler } from './handlers.js';
import { runDunning } from '../dunning/dunning.js';
import { enqueueDunningRun, nextDay } from '../dunning/schedule.js';
import { registerReaper } from './reapers.js';
import { reapDunning } from '../dunning/reap.js';
import { generateDueRecurring } from '../recurring/generate.js';
import { getTemplate } from '../recurring/recurring.js';
import { enqueueRecurringGenerate, periodKey } from '../recurring/schedule.js';
import { utcMidnight } from '../dunning/schedule.js';
import { reapRecurring } from '../recurring/reap.js';
import { getAccessPoint } from '../einvoice/access-point-factory.js';
import { outboundInvoiceAccounts } from '../einvoice/accounts.js';

registerHandler('dunning_run', async (tx, ctx, payload) => {
  const asOf = (payload.asOf as string | undefined) ?? new Date().toISOString().slice(0, 10);
  const { enabled } = await runDunning(tx, ctx, { asOf });
  // Self-perpetuate only while the policy is enabled (else jobs would grow one row/client/day).
  if (enabled) await enqueueDunningRun(tx, ctx, { asOf: nextDay(asOf) });
});

registerReaper(reapDunning);

registerHandler('recurring_generate', async (tx, ctx, payload) => {
  const templateId = payload.templateId as string;
  // asOf lets tests run deterministically; production omits it and bills against the real date.
  const asOf = payload.asOf as string | undefined;
  const now = asOf ? new Date(asOf + 'T00:00:00Z') : new Date();
  const { active } = await generateDueRecurring(tx, ctx, {
    templateId, now, ap: getAccessPoint(), accounts: outboundInvoiceAccounts(),
  });
  // Self-perpetuate only while active (else jobs would grow one row/template/period).
  if (active) {
    const t = await getTemplate(tx, ctx, templateId);
    await enqueueRecurringGenerate(tx, ctx, {
      templateId, period: periodKey(t.nextRunDate), runAt: utcMidnight(t.nextRunDate),
    });
  }
});

registerReaper(reapRecurring);
