import { defineConfig } from '@playwright/test';

/**
 * Browser-level smoke tests for the built Chrome extension (dist/chrome):
 * loaded into a persistent context, popup and options pages opened by URL,
 * a settings save round-tripped through storage.local. Capture itself needs
 * a real toolbar gesture for activeTab, so it is covered by
 * test/smoke/capture-e2e.spec.ts only when a local server is provided
 * (see extension/TESTING.md) and by the manual checklist otherwise.
 *
 * Run `pnpm build:chrome` first; `pnpm test:smoke` does not build.
 */
export default defineConfig({
  testDir: './test/smoke',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['github'], ['list']] : 'list',
  timeout: 30_000,
  use: { trace: 'retain-on-failure' },
});
