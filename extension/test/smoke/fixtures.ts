import { chromium, test as base, type BrowserContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const distDir = fileURLToPath(new URL('../../dist/chrome/', import.meta.url));

export interface BuiltManifest {
  host_permissions: string[];
  version: string;
}

export function readBuiltManifest(): BuiltManifest {
  return JSON.parse(readFileSync(join(distDir, 'manifest.json'), 'utf8')) as BuiltManifest;
}

/** The build-time default server, recovered from the generated manifest. */
export function defaultOrigin(): string {
  const [pattern] = readBuiltManifest().host_permissions;
  if (!pattern?.endsWith('/*')) throw new Error(`unexpected host_permissions: ${pattern}`);
  return pattern.slice(0, -2);
}

/**
 * Persistent Chromium context with dist/chrome loaded. `channel: 'chromium'`
 * selects the full Chromium build (new headless) — extensions do not load in
 * the headless shell. Each test gets a fresh profile, so storage.local is empty.
 */
export const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'st-ext-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      args: [`--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`],
    });
    await use(context);
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  },
  extensionId: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    await use(new URL(worker.url()).hostname);
  },
});

export const expect = test.expect;
