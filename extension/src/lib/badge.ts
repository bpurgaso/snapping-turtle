import browser from 'webextension-polyfill';

/**
 * Toolbar badge: a red "!" for the last failure (failure-flag.ts) and a
 * percentage while a full-page stitch runs (PLAN.md §15). `action.setBadge*`
 * needs no extra permission on either browser.
 */

export const DEFAULT_TITLE = 'snapping-turtle';
export const FAILURE_COLOR = '#b42318';
export const PROGRESS_COLOR = '#1f5fbf';

export async function setBadge(text: string, title: string, color: string): Promise<void> {
  try {
    await browser.action.setBadgeBackgroundColor({ color });
    await browser.action.setBadgeText({ text });
    await browser.action.setTitle({ title });
  } catch (err) {
    console.warn('badge update failed', err instanceof Error ? err.message : String(err));
  }
}

export function showProgress(percent: number): Promise<void> {
  const pct = Math.min(100, Math.max(0, Math.round(percent)));
  return setBadge(`${pct}%`, `${DEFAULT_TITLE} — capturing full page… ${pct}%`, PROGRESS_COLOR);
}

export function clearBadge(): Promise<void> {
  return setBadge('', DEFAULT_TITLE, FAILURE_COLOR);
}
