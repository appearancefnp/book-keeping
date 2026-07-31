import { expect, test } from 'vitest';
import { stubExtractorAllowed } from '../../src/intake/stub-extractor-allowed.js';

test('stub allowed outside production, and inside only with an explicit opt-in', () => {
  expect(stubExtractorAllowed({})).toBe(true);
  expect(stubExtractorAllowed({ NODE_ENV: 'development' })).toBe(true);
  expect(stubExtractorAllowed({ NODE_ENV: 'test' })).toBe(true);
  expect(stubExtractorAllowed({ NODE_ENV: 'production' })).toBe(false);
  expect(stubExtractorAllowed({ NODE_ENV: 'production', INTAKE_ALLOW_STUB_EXTRACTOR: '1' })).toBe(true);
});

test('only the exact string "1" opts in — no truthy-string surprises', () => {
  expect(stubExtractorAllowed({ NODE_ENV: 'production', INTAKE_ALLOW_STUB_EXTRACTOR: 'true' })).toBe(false);
  expect(stubExtractorAllowed({ NODE_ENV: 'production', INTAKE_ALLOW_STUB_EXTRACTOR: 'yes' })).toBe(false);
  expect(stubExtractorAllowed({ NODE_ENV: 'production', INTAKE_ALLOW_STUB_EXTRACTOR: '0' })).toBe(false);
  expect(stubExtractorAllowed({ NODE_ENV: 'production', INTAKE_ALLOW_STUB_EXTRACTOR: '' })).toBe(false);
});
