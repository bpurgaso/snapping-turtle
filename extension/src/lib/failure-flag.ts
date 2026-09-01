import browser from 'webextension-polyfill';
import { clearBadge, DEFAULT_TITLE, FAILURE_COLOR, setBadge } from './badge.js';
import { LAST_ERROR_KEY, parseLastError, type LastError } from './last-error.js';

/**
 * Second channel for failures, alongside notifications (PLAN.md §15): a "!"
 * badge on the toolbar icon with the message as its tooltip, plus the message
 * in storage.local. The popup shows it on next open and clears both; a
 * successful capture clears both too. Needs no extra permission.
 */

export async function flagFailure(message: string, now: number = Date.now()): Promise<void> {
  const entry: LastError = { message, at: now };
  await Promise.all([
    browser.storage.local.set({ [LAST_ERROR_KEY]: entry }),
    setBadge('!', `${DEFAULT_TITLE} — ${message}`, FAILURE_COLOR),
  ]);
}

export async function clearFailureFlag(): Promise<void> {
  await Promise.all([browser.storage.local.remove(LAST_ERROR_KEY), clearBadge()]);
}

export async function readLastError(): Promise<LastError | null> {
  const raw = await browser.storage.local.get(LAST_ERROR_KEY);
  return parseLastError(raw[LAST_ERROR_KEY]);
}
