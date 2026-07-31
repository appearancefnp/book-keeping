import { expect, test } from 'vitest';
import { bankFeedStubAllowed } from '../../src/bankfeed/stub-allowed.js';

test('stub allowed outside production, and inside only with an explicit opt-in', () => {
  expect(bankFeedStubAllowed({})).toBe(true);
  expect(bankFeedStubAllowed({ NODE_ENV: 'development' })).toBe(true);
  expect(bankFeedStubAllowed({ NODE_ENV: 'test' })).toBe(true);
  expect(bankFeedStubAllowed({ NODE_ENV: 'production' })).toBe(false);
  expect(bankFeedStubAllowed({ NODE_ENV: 'production', BANKFEED_ALLOW_STUB: '1' })).toBe(true);
});

test('only the exact string "1" opts in — no truthy-string surprises', () => {
  expect(bankFeedStubAllowed({ NODE_ENV: 'production', BANKFEED_ALLOW_STUB: 'true' })).toBe(false);
  expect(bankFeedStubAllowed({ NODE_ENV: 'production', BANKFEED_ALLOW_STUB: 'yes' })).toBe(false);
  expect(bankFeedStubAllowed({ NODE_ENV: 'production', BANKFEED_ALLOW_STUB: '0' })).toBe(false);
  expect(bankFeedStubAllowed({ NODE_ENV: 'production', BANKFEED_ALLOW_STUB: '' })).toBe(false);
});
