/**
 * The auto-linking stub bank feed must never serve a production deployment: it links a
 * fake account and can inject demo transactions into real books. Opting in is positive
 * and explicit — a merely-truthy value is not enough — so that a misconfigured
 * environment fails closed rather than quietly booting the stub.
 */
export function bankFeedStubAllowed(
  env: { NODE_ENV?: string; BANKFEED_ALLOW_STUB?: string },
): boolean {
  if (env.NODE_ENV !== 'production') return true;
  return env.BANKFEED_ALLOW_STUB === '1';
}
