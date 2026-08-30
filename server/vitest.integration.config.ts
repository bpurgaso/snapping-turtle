import { defineConfig } from 'vitest/config';

/**
 * Integration tests need a real Postgres (DATABASE_URL). They run serially
 * because they share one database and run migrations against it.
 */
export default defineConfig({
  test: {
    name: 'server:integration',
    include: ['test/integration/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
