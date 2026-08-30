import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

/**
 * Browser-level tests. From M4 this hosts the editor <-> server render
 * parity golden tests; in M0 it boots the real server against the built
 * bundle and checks the page renders under the production CSP.
 *
 * The server needs a DATABASE_URL to boot but `/` never touches the DB, so a
 * placeholder is fine here. Set PLAYWRIGHT_PORT to avoid clashes.
 */
const port = Number(process.env['PLAYWRIGHT_PORT'] ?? 3117);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  testDir: './test/parity',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'pnpm --filter @snapping-turtle/server exec tsx src/main.ts',
    cwd: repoRoot,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      LOG_LEVEL: 'warn',
      DATABASE_URL: process.env['DATABASE_URL'] ?? 'postgres://unused:unused@127.0.0.1:1/unused',
      SESSION_SECRET: 'playwright-session-secret-not-real-0123456789',
    },
  },
});
