import browser, { type Runtime, type Tabs } from 'webextension-polyfill';
import { uploadCapture } from './lib/api.js';
import { dataUrlToBlob } from './lib/data-url.js';
import { clearFailureFlag, flagFailure } from './lib/failure-flag.js';
import {
  ENABLED_MODES,
  isCaptureRequest,
  type CaptureFailureCode,
  type CaptureMode,
  type CaptureResponse,
} from './lib/messages.js';
import { restrictedReason } from './lib/restricted.js';
import { loadSettings, saveSettings } from './lib/settings.js';

/**
 * Background (Chrome service worker / Firefox event page). Owns the capture
 * flow from PLAN.md §15 so it survives the popup closing:
 *   gesture → captureVisibleTab → blob → POST /api/v1/captures → open pageUrl.
 * Failures become a browser notification AND a "!" badge + stored last error
 * (the OS may swallow notifications; the popup shows the stored error on next
 * open); a 401 (or no token yet) opens the options page. The API token is read
 * from storage.local for the request and never logged or echoed (CLAUDE.md
 * rule 3).
 */

const COMMAND_VISIBLE = 'capture-visible';

browser.runtime.onInstalled.addListener((details) => {
  console.info(`snapping-turtle installed (${details.reason})`);
});

browser.runtime.onMessage.addListener((message: unknown, sender: Runtime.MessageSender) => {
  // Only our own pages (popup) may drive captures; content scripts do not exist yet.
  if (sender.id !== browser.runtime.id || !isCaptureRequest(message)) return undefined;
  return captureAndUpload(message.mode, message.tabId, message.windowId);
});

browser.commands.onCommand.addListener((command, tab) => {
  if (command !== COMMAND_VISIBLE) return;
  void (async () => {
    const target = tab ?? (await browser.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (target?.id === undefined || target.windowId === undefined) {
      await notify("Can't capture: there is no active tab.");
      return;
    }
    await captureAndUpload('visible', target.id, target.windowId);
  })();
});

const fail = (code: CaptureFailureCode, message: string): CaptureResponse => ({
  ok: false,
  code,
  message,
});

async function captureAndUpload(
  mode: CaptureMode,
  tabId: number,
  windowId: number,
): Promise<CaptureResponse> {
  const response = await run(mode, tabId, windowId);
  // The popup may already be closed (or the trigger was a shortcut), so every
  // failure is also surfaced as a notification and as a toolbar badge.
  if (response.ok) await clearFailureFlag();
  else await Promise.all([notify(response.message), flagFailure(response.message)]);
  return response;
}

async function run(mode: CaptureMode, tabId: number, windowId: number): Promise<CaptureResponse> {
  if (!ENABLED_MODES.has(mode)) {
    return fail('unsupported', 'Region and full-page capture arrive in a later release (M6).');
  }
  void saveSettings({ lastMode: mode });

  let tab: Tabs.Tab;
  try {
    tab = await browser.tabs.get(tabId);
  } catch {
    return fail('failed', 'The tab to capture is no longer open.');
  }
  const restricted = restrictedReason(tab.url);
  if (restricted || !tab.url) return fail('restricted', restricted ?? "Can't capture this page.");

  const settings = await loadSettings();
  if (!settings.apiToken) {
    await browser.runtime.openOptionsPage();
    return fail(
      'no_token',
      'Add your server address and API token in the extension settings first.',
    );
  }

  let dataUrl: string;
  try {
    dataUrl = await browser.tabs.captureVisibleTab(windowId, { format: 'png' });
  } catch (err) {
    return fail('failed', `Capture failed: ${errorText(err)}`);
  }

  const outcome = await uploadCapture({
    origin: settings.serverOrigin,
    token: settings.apiToken,
    image: dataUrlToBlob(dataUrl),
    sourceUrl: tab.url,
    title: tab.title ?? '',
  });
  switch (outcome.kind) {
    case 'created':
      await openPage(outcome.pageUrl, tab);
      return { ok: true, pageUrl: outcome.pageUrl };
    case 'unauthorized':
      await browser.runtime.openOptionsPage();
      return fail(
        'unauthorized',
        'The server rejected the API token. Paste a current one in the extension settings.',
      );
    case 'failed':
      return fail('failed', outcome.message);
  }
}

async function openPage(url: string, source: Tabs.Tab): Promise<void> {
  try {
    await browser.tabs.create({
      url,
      active: true,
      index: source.index + 1,
      ...(source.windowId !== undefined ? { windowId: source.windowId } : {}),
      ...(source.id !== undefined ? { openerTabId: source.id } : {}),
    });
  } catch {
    await browser.tabs.create({ url, active: true });
  }
}

async function notify(message: string): Promise<void> {
  try {
    await browser.notifications.create({
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/icon-128.png'),
      title: 'snapping-turtle',
      message,
    });
  } catch (err) {
    console.warn('notification failed', errorText(err));
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
