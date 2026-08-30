import { defineConfig } from 'vitest/config';

/** Unit tests across the workspace; each package owns its own vitest config. */
export default defineConfig({
  test: {
    projects: ['shared', 'server', 'web', 'extension'],
  },
});
