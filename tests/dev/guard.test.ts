import { expect, test } from 'vitest';
import { devBootstrapAllowed } from '../../src/dev/guard.js';

test('the opt-in is required, not merely permitted', () => {
  expect(devBootstrapAllowed({})).toBe(false);
  expect(devBootstrapAllowed({ NODE_ENV: 'development' })).toBe(false);
  expect(devBootstrapAllowed({ DEV_ROUTES_ENABLED: '1' })).toBe(true);
  expect(devBootstrapAllowed({ NODE_ENV: 'development', DEV_ROUTES_ENABLED: '1' })).toBe(true);
});

test('only the exact string "1" opts in', () => {
  expect(devBootstrapAllowed({ DEV_ROUTES_ENABLED: 'true' })).toBe(false);
  expect(devBootstrapAllowed({ DEV_ROUTES_ENABLED: '' })).toBe(false);
  expect(devBootstrapAllowed({ DEV_ROUTES_ENABLED: '0' })).toBe(false);
});

test('production and Vercel still veto, even with the opt-in set', () => {
  expect(devBootstrapAllowed({ NODE_ENV: 'production', DEV_ROUTES_ENABLED: '1' })).toBe(false);
  expect(devBootstrapAllowed({ VERCEL_ENV: 'preview', DEV_ROUTES_ENABLED: '1' })).toBe(false);
  expect(devBootstrapAllowed({ NODE_ENV: 'test', VERCEL_ENV: 'production', DEV_ROUTES_ENABLED: '1' })).toBe(false);
});
