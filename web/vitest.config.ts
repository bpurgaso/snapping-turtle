import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'web',
    include: ['test/**/*.test.ts'],
    exclude: ['test/parity/**'],
    testTimeout: 60_000,
  },
});
