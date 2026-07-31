/**
 * The stub extractor must never serve a production deployment: with no AI key configured
 * it returns a hard-coded canned invoice, and a real uploaded supplier document would be
 * persisted as a fabricated extraction — plus a posting proposal built from it — with no
 * error anywhere. Opting in is positive and explicit — a merely-truthy value is not
 * enough — so that a misconfigured environment fails closed rather than quietly booting
 * the stub.
 */
export function stubExtractorAllowed(
  env: { NODE_ENV?: string; INTAKE_ALLOW_STUB_EXTRACTOR?: string },
): boolean {
  if (env.NODE_ENV !== 'production') return true;
  return env.INTAKE_ALLOW_STUB_EXTRACTOR === '1';
}
