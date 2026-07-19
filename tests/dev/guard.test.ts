import { expect, test } from 'vitest';
import { devBootstrapAllowed } from '../../src/dev/guard.js';

test('bootstrap allowed only outside production and off Vercel', () => {
  expect(devBootstrapAllowed({})).toBe(true);
  expect(devBootstrapAllowed({ NODE_ENV: 'development' })).toBe(true);
  expect(devBootstrapAllowed({ NODE_ENV: 'production' })).toBe(false);
  expect(devBootstrapAllowed({ VERCEL_ENV: 'preview' })).toBe(false);
  expect(devBootstrapAllowed({ NODE_ENV: 'test', VERCEL_ENV: 'production' })).toBe(false);
});
