import browser from 'webextension-polyfill';
import type { CaptureMode } from './messages.js';
import type { BrowserTarget } from './origin.js';

/**
 * Extension settings live in storage.local only (PLAN.md §15): the API token
 * is a secret and must never transit sync infrastructure. `storage.sync` is
 * deliberately not referenced anywhere in this package.
 */

/** Baked in at build time from PUBLIC_ORIGIN (extension/scripts/build.ts). */
export const DEFAULT_SERVER_ORIGIN: string = __DEFAULT_SERVER_ORIGIN__;
/** Build target; decides the host-permission pattern shape (lib/origin.ts). */
export const BROWSER_TARGET: BrowserTarget = __BROWSER_TARGET__;

export interface Settings {
  serverOrigin: string;
  apiToken: string;
  lastMode: CaptureMode | null;
  /** "Smart region suggestions" (E7): highlight confident targets in region mode. On unless switched off. */
  regionSuggestions: boolean;
}

const KEYS = ['serverOrigin', 'apiToken', 'lastMode', 'regionSuggestions'] as const;

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
    // Default on: only an explicit `false` turns the assist off.
    regionSuggestions: raw['regionSuggestions'] !== false,
  };
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  await browser.storage.local.set(patch);
}
