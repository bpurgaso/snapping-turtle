import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __DEFAULT_SERVER_ORIGIN__: JSON.stringify('https://shots.example.com') },
  test: {
    name: 'extension',
    include: ['test/**/*.test.ts'],
  },
});
