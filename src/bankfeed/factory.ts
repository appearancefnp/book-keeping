import type { BankFeedProvider } from './provider.js';
import { GoCardlessProvider } from './gocardless.js';
import { StubBankFeedProvider } from './stub.js';

let instance: BankFeedProvider | null = null;

/**
 * GoCardless when credentials are present, auto-linking stub otherwise (keyless dev).
 * Singleton so the stub's in-memory requisitions survive across route invocations
 * within one dev server process. Tests construct StubBankFeedProvider directly.
 */
export function makeBankFeedProvider(): BankFeedProvider {
  if (!instance) {
    const id = process.env.GOCARDLESS_SECRET_ID;
    const key = process.env.GOCARDLESS_SECRET_KEY;
    instance = id && key ? new GoCardlessProvider(id, key) : new StubBankFeedProvider({ autoLink: true });
  }
  return instance;
}
