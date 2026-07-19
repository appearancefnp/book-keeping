import type { BankFeedProvider } from './provider.js';
import { GoCardlessProvider } from './gocardless.js';
import { StubBankFeedProvider } from './stub.js';

// Module-level state is NOT shared across Next.js route bundles in dev — each
// route would get its own stub with its own in-memory requisitions. Stash the
// singleton on globalThis so every route sees the same provider instance.
const g = globalThis as typeof globalThis & { __bankFeedProvider?: BankFeedProvider };

/**
 * GoCardless when credentials are present, auto-linking stub otherwise (keyless dev).
 * Tests construct StubBankFeedProvider directly.
 */
export function makeBankFeedProvider(): BankFeedProvider {
  if (!g.__bankFeedProvider) {
    const id = process.env.GOCARDLESS_SECRET_ID;
    const key = process.env.GOCARDLESS_SECRET_KEY;
    g.__bankFeedProvider = id && key ? new GoCardlessProvider(id, key) : new StubBankFeedProvider({ autoLink: true });
  }
  return g.__bankFeedProvider;
}
