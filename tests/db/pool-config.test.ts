import { expect, test } from 'vitest';
import { appPool, adminPool } from '../../src/db/pool.js';

test('pools are tuned for serverless (bounded, with timeouts)', () => {
  for (const pool of [appPool, adminPool]) {
    expect(pool.options.max).toBe(5);
    expect(pool.options.connectionTimeoutMillis).toBe(10_000);
    expect(pool.options.idleTimeoutMillis).toBe(30_000);
  }
});
