import browser from 'webextension-polyfill';
import type { CaptureMode } from './messages.js';

/**
 * Extension settings live in storage.local only (PLAN.md §15): the API token
 * is a secret and must never transit sync infrastructure. `storage.sync` is
 * deliberately not referenced anywhere in this package.
 */

/** Baked in at build time from PUBLIC_ORIGIN (extension/scripts/build.ts). */
export const DEFAULT_SERVER_ORIGIN: string = __DEFAULT_SERVER_ORIGIN__;

export interface Settings {
  serverOrigin: string;
  apiToken: string;
  lastMode: CaptureMode | null;
}

const KEYS = ['serverOrigin', 'apiToken', 'lastMode'] as const;

export async function loadSettings(): Promise<Settings> {
  const raw = await browser.storage.local.get([...KEYS]);
  return {
    serverOrigin:
      typeof raw['serverOrigin'] === 'string' && raw['serverOrigin']
        ? raw['serverOrigin']
        : DEFAULT_SERVER_ORIGIN,
    apiToken: typeof raw['apiToken'] === 'string' ? raw['apiToken'] : '',
    lastMode:
      raw['lastMode'] === 'visible' || raw['lastMode'] === 'region' || raw['lastMode'] === 'full'
        ? raw['lastMode']
        : null,
  };
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  await browser.storage.local.set(patch);
}
