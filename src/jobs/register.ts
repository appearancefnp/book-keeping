// Registers production job handlers as a side effect of import.
import { registerHandler } from './handlers.js';
import { runDunning } from '../dunning/dunning.js';
import { enqueueDunningRun, nextDay } from '../dunning/schedule.js';

registerHandler('dunning_run', async (tx, ctx, payload) => {
  const asOf = (payload.asOf as string | undefined) ?? new Date().toISOString().slice(0, 10);
  await runDunning(tx, ctx, { asOf });
  // Self-perpetuate: enqueue tomorrow's run (deduped on the date).
  await enqueueDunningRun(tx, ctx, { asOf: nextDay(asOf) });
});
