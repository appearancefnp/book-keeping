import type { BankFeedProvider } from './provider.js';
import { GoCardlessProvider } from './gocardless.js';
import { StubBankFeedProvider } from './stub.js';
import { bankFeedStubAllowed } from './stub-allowed.js';

// Module-level state is NOT shared across Next.js route bundles in dev — each
// route would get its own stub with its own in-memory requisitions. Stash the
// singleton on globalThis so every route sees the same provider instance.
const g = globalThis as typeof globalThis & { __bankFeedProvider?: BankFeedProvider };

/**
 * GoCardless when credentials are present. Otherwise the auto-linking stub — but only
 * where that is safe: in production it would inject demo transactions into real books,
 * so it requires BANKFEED_ALLOW_STUB=1. Tests construct StubBankFeedProvider directly.
 */
export function makeBankFeedProvider(): BankFeedProvider {
  if (!g.__bankFeedProvider) {
    const id = process.env.GOCARDLESS_SECRET_ID;
    const key = process.env.GOCARDLESS_SECRET_KEY;
    if (id && key) {
      g.__bankFeedProvider = new GoCardlessProvider(id, key);
    } else {
      const { NODE_ENV, BANKFEED_ALLOW_STUB } = process.env;
      if (!bankFeedStubAllowed({ NODE_ENV, BANKFEED_ALLOW_STUB })) {
        throw new Error(
          'bank feed: GOCARDLESS_SECRET_ID and GOCARDLESS_SECRET_KEY are required in ' +
          'production. The auto-linking stub would inject demo transactions into real ' +
          'books. Set BANKFEED_ALLOW_STUB=1 only for a deployment with seeded data.',
        );
      }
      g.__bankFeedProvider = new StubBankFeedProvider({ autoLink: true });
    }
  }
  return g.__bankFeedProvider;
}
