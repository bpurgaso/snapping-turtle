import browser from 'webextension-polyfill';
import { LAST_ERROR_KEY, parseLastError, type LastError } from './last-error.js';

/**
 * Second channel for failures, alongside notifications (PLAN.md §15): a "!"
 * badge on the toolbar icon with the message as its tooltip, plus the message
 * in storage.local. The popup shows it on next open and clears both; a
 * successful capture clears both too. Needs no extra permission.
 */

const BADGE_COLOR = '#b42318';
const DEFAULT_TITLE = 'snapping-turtle';

export async function flagFailure(message: string, now: number = Date.now()): Promise<void> {
  const entry: LastError = { message, at: now };
  await Promise.all([
    browser.storage.local.set({ [LAST_ERROR_KEY]: entry }),
    setBadge('!', `${DEFAULT_TITLE} — ${message}`),
  ]);
}

export async function clearFailureFlag(): Promise<void> {
  await Promise.all([browser.storage.local.remove(LAST_ERROR_KEY), setBadge('', DEFAULT_TITLE)]);
}

export async function readLastError(): Promise<LastError | null> {
  const raw = await browser.storage.local.get(LAST_ERROR_KEY);
  return parseLastError(raw[LAST_ERROR_KEY]);
}

async function setBadge(text: string, title: string): Promise<void> {
  try {
    await browser.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
    await browser.action.setBadgeText({ text });
    await browser.action.setTitle({ title });
  } catch (err) {
    console.warn('badge update failed', err instanceof Error ? err.message : String(err));
  }
}
