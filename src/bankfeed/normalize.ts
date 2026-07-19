import { toCents } from '../db/money.js';
import type { BankTxn } from '../banking/types.js';
import type { FeedTxn } from './provider.js';

/** Feed transaction → the shape importStatement stores. Sign decides side; amount stored absolute. */
export function feedTxnToBankTxn(f: FeedTxn): BankTxn {
  const cents = toCents(f.amount);
  const abs = cents < 0n ? -cents : cents;
  return {
    bookingDate: f.bookingDate,
    amountCents: abs.toString(),
    currency: f.currency,
    side: cents < 0n ? 'debit' : 'credit',
    reference: f.reference,
    counterparty: f.counterparty,
    // Dedup rides the (client, account, end_to_end_id, amount, date) unique key;
    // fall back to the provider-stable id so re-syncs always dedup against themselves.
    endToEndId: f.endToEndId || f.providerTxId,
  };
}
