import { defineConfig } from '@playwright/test';

/**
 * Two projects:
 *
 *  browser/  the region overlay and full-page driver mounted in plain fixture
 *            pages via a Vite-built harness (globalSetup) — no extension APIs,
 *            no gesture needed, plain headless Chromium.
 *  smoke/    the built Chrome extension (dist/chrome) loaded into a persistent
 *            context: popup and options pages opened by URL, a settings save
 *            round-tripped through storage.local. Capture itself needs a real
 *            toolbar gesture for activeTab, so it is covered by
 *            test/smoke/capture-e2e.spec.ts only when a local server is
 *            provided (see extension/TESTING.md) and by the manual checklist.
 *
 * Run `pnpm build:chrome` first for smoke/; `pnpm test:smoke` does not build.
 *
 * Opt-in third project, `ST_GECKO=1 pnpm test:smoke --project=browser-gecko`:
 * the same browser/ specs in Playwright's Firefox (`playwright install
 * firefox` first). Playwright cannot load an extension into Firefox, but the
 * overlay and the region suggestions (E7) are plain DOM code — hit-testing,
 * computed-style strings, rects — and that is exactly what differs between
 * engines. Not in CI; the result of each run is recorded in TESTING.md.
 */
const gecko = process.env['ST_GECKO']
  ? [
      {
        name: 'browser-gecko',
        testMatch: /browser\/.*\.spec\.ts$/,
        use: { browserName: 'firefox' as const },
      },
    ]
  : [];

export default defineConfig({
  testDir: './test',
  globalSetup: './test/browser/build-harness.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  // No retries anywhere: a test that needs a second attempt is a bug report, not noise.
  retries: 0,
  reporter: process.env['CI'] ? [['github'], ['list']] : 'list',
  timeout: 30_000,
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'browser', testMatch: /browser\/.*\.spec\.ts$/ },
    { name: 'smoke', testMatch: /smoke\/.*\.spec\.ts$/ },
    ...gecko,
  ],
});
