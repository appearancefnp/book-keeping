// Registers production job handlers as a side effect of import.
import { registerHandler } from './handlers.js';
import { runDunning } from '../dunning/dunning.js';
import { enqueueDunningRun, nextDay } from '../dunning/schedule.js';
import { registerReaper } from './reapers.js';
import { reapDunning } from '../dunning/reap.js';

registerHandler('dunning_run', async (tx, ctx, payload) => {
  const asOf = (payload.asOf as string | undefined) ?? new Date().toISOString().slice(0, 10);
  const { enabled } = await runDunning(tx, ctx, { asOf });
  // Self-perpetuate only while the policy is enabled (else jobs would grow one row/client/day).
  if (enabled) await enqueueDunningRun(tx, ctx, { asOf: nextDay(asOf) });
});

registerReaper(reapDunning);
