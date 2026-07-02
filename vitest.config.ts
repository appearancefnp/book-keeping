import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    hookTimeout: 30000,
    testTimeout: 30000,
    setupFiles: ['tests/setup.ts'],
  },
});
