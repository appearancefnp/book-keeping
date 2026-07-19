import { afterEach, beforeEach, expect, test } from 'vitest';
import { makeBankFeedProvider } from '../../src/bankfeed/factory.js';
import { StubBankFeedProvider } from '../../src/bankfeed/stub.js';

const savedId = process.env.GOCARDLESS_SECRET_ID;
const savedKey = process.env.GOCARDLESS_SECRET_KEY;

beforeEach(() => {
  delete (globalThis as any).__bankFeedProvider;
  delete process.env.GOCARDLESS_SECRET_ID;
  delete process.env.GOCARDLESS_SECRET_KEY;
});

afterEach(() => {
  delete (globalThis as any).__bankFeedProvider;
  if (savedId === undefined) delete process.env.GOCARDLESS_SECRET_ID;
  else process.env.GOCARDLESS_SECRET_ID = savedId;
  if (savedKey === undefined) delete process.env.GOCARDLESS_SECRET_KEY;
  else process.env.GOCARDLESS_SECRET_KEY = savedKey;
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
