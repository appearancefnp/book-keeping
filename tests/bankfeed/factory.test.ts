import { afterEach, beforeEach, expect, test } from 'vitest';
import { makeBankFeedProvider } from '../../src/bankfeed/factory.js';
import { StubBankFeedProvider } from '../../src/bankfeed/stub.js';

const SAVED = {
  GOCARDLESS_SECRET_ID: process.env.GOCARDLESS_SECRET_ID,
  GOCARDLESS_SECRET_KEY: process.env.GOCARDLESS_SECRET_KEY,
  NODE_ENV: process.env.NODE_ENV,
  BANKFEED_ALLOW_STUB: process.env.BANKFEED_ALLOW_STUB,
};

beforeEach(() => {
  delete (globalThis as any).__bankFeedProvider;
  for (const key of Object.keys(SAVED)) delete process.env[key];
});

afterEach(() => {
  delete (globalThis as any).__bankFeedProvider;
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('returns a StubBankFeedProvider without GoCardless credentials', () => {
  expect(makeBankFeedProvider()).toBeInstanceOf(StubBankFeedProvider);
});

test('repeated calls return the same instance', () => {
  const first = makeBankFeedProvider();
  const second = makeBankFeedProvider();
  expect(second).toBe(first);
});

test('the singleton is stashed on globalThis under __bankFeedProvider', () => {
  const instance = makeBankFeedProvider();
  expect((globalThis as any).__bankFeedProvider).toBe(instance);
});

test('throws in production when GoCardless credentials are missing', () => {
  process.env.NODE_ENV = 'production';
  expect(() => makeBankFeedProvider()).toThrow(/GOCARDLESS_SECRET_ID/);
});

test('caches nothing when it throws, so a later fixed env still works', () => {
  process.env.NODE_ENV = 'production';
  expect(() => makeBankFeedProvider()).toThrow();
  expect((globalThis as any).__bankFeedProvider).toBeUndefined();
  process.env.BANKFEED_ALLOW_STUB = '1';
  expect(makeBankFeedProvider()).toBeInstanceOf(StubBankFeedProvider);
});
