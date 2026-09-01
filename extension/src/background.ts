import { CAPTURE_TILE_INTERVAL_MS } from '@snapping-turtle/shared';
import browser, { type Runtime, type Tabs } from 'webextension-polyfill';
import { uploadCapture } from './lib/api.js';
import { clearBadge, showProgress } from './lib/badge.js';
import {
  deriveScale,
  fullPageRect,
  oversizeMessage,
  reconcileFullPageCapture,
  regionToPhysical,
  truncationNotice,
} from './lib/capture-geometry.js';
import { busyMessage, createCaptureLock } from './lib/capture-lock.js';
import {
  CONTENT_SCRIPT_FILE,
  isContentReply,
  isRegionResult,
  type ContentCommand,
  type ContentReply,
  type RegionResultMessage,
} from './lib/content-protocol.js';
import { dataUrlToBlob } from './lib/data-url.js';
import { clearFailureFlag, flagFailure } from './lib/failure-flag.js';
import { createComposite, cropBitmap, decodeDataUrl } from './lib/image.js';
import {
  isCaptureRequest,
  type CaptureFailureCode,
  type CaptureMode,
  type CaptureResponse,
} from './lib/messages.js';
import { restrictedReason } from './lib/restricted.js';
import { BROWSER_TARGET, loadSettings, saveSettings, type Settings } from './lib/settings.js';
import { CaptureCancelledError, stitchFullPage } from './lib/stitch.js';
import type { RegionSelection } from './content/region-overlay.js';

/**
 * Background (Chrome service worker / Firefox event page). Owns every capture
 * flow from PLAN.md §15 so it survives the popup closing:
 *
 *   visible  gesture → captureVisibleTab → upload → open pageUrl
 *   region   gesture → inject content script → overlay … (user drags) …
 *            → content sends st:region:selected → captureVisibleTab → crop → upload
 *   full     Firefox: measure → one tabs.captureTab({rect, scale}) → upload
 *            Chrome:  scroll-and-stitch via lib/stitch.ts, badge shows progress
 *
 * Failures become a browser notification AND a "!" badge + stored last error
 * (the OS may swallow notifications; the popup shows the stored error on next
 * open); a 401 (or no token yet) opens the options page. The API token is read
 * from storage.local for the request and never logged or echoed (CLAUDE.md
 * rule 3). One capture runs at a time (lib/capture-lock.ts).
 */

const COMMANDS: Readonly<Record<string, CaptureMode>> = {
  'capture-visible': 'visible',
  'capture-region': 'region',
  'capture-full': 'full',
};

/** How long one content-script command may take before the run is abandoned. */
const CONTENT_COMMAND_TIMEOUT_MS = 10_000;

/** chrome-extension://<id>/ or moz-extension://<uuid>/: where our own pages live. */
const OWN_PAGE_PREFIX = browser.runtime.getURL('');

const lock = createCaptureLock();
/** Region selections in flight, by tab; releases the lock when the result arrives. */
const pendingRegions = new Map<number, { release: () => void; settings: Settings }>();

browser.runtime.onInstalled.addListener((details) => {
  console.info(`snapping-turtle installed (${details.reason})`);
});

browser.runtime.onMessage.addListener((message: unknown, sender: Runtime.MessageSender) => {
  if (sender.id !== browser.runtime.id) return undefined;
  // Capture requests come from our own pages (popup, options — the latter
  // lives in a tab, so sender.tab is no discriminator); region results come
  // from our content script running inside a web page, which always has a tab.
  const fromOwnPage = typeof sender.url === 'string' && sender.url.startsWith(OWN_PAGE_PREFIX);
  if (fromOwnPage && isCaptureRequest(message)) {
    return startCapture(message.mode, message.tabId, message.windowId);
  }
  if (!fromOwnPage && sender.tab?.id !== undefined && isRegionResult(message)) {
    return handleRegionResult(message, sender.tab);
  }
  return undefined;
});

browser.commands.onCommand.addListener((command, tab) => {
  const mode = COMMANDS[command];
  if (!mode) return;
  void (async () => {
    const target = tab ?? (await browser.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (target?.id === undefined || target.windowId === undefined) {
      await notify("Can't capture: there is no active tab.");
      return;
    }
    await startCapture(mode, target.id, target.windowId);
  })();
});

const fail = (code: CaptureFailureCode, message: string): CaptureResponse => ({
  ok: false,
  code,
  message,
});

/** Surface a final outcome on both channels; `started` is not final. */
async function report(response: CaptureResponse): Promise<CaptureResponse> {
  if (response.ok) {
    if (response.status === 'uploaded') await clearFailureFlag();
  } else {
    await Promise.all([notify(response.message), flagFailure(response.message)]);
  }
  return response;
}

interface Ready {
  tab: Tabs.Tab & { url: string };
  settings: Settings;
}

/** Everything every mode checks before touching the page. */
async function prepare(tabId: number): Promise<Ready | CaptureResponse> {
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
  return { tab: tab as Ready['tab'], settings };
}

async function startCapture(
  mode: CaptureMode,
  tabId: number,
  windowId: number,
): Promise<CaptureResponse> {
  const ready = await prepare(tabId);
  if ('ok' in ready) return report(ready);
  void saveSettings({ lastMode: mode });
  const { tab, settings } = ready;

  switch (mode) {
    case 'visible':
      return report(await captureVisible(windowId, tab, settings));
    case 'region': {
      const release = lock.acquire('region');
      if (!release) return report(fail('busy', busyMessage(lock.current() ?? 'another')));
      try {
        await injectContentScript(tabId);
        await sendToContent(tabId, { type: 'st:region:select' }, 'st:region:started');
      } catch (err) {
        release();
        return report(fail('failed', `Could not start region selection: ${errorText(err)}`));
      }
      pendingRegions.set(tabId, { release, settings });
      return { ok: true, status: 'started' };
    }
    case 'full': {
      const release = lock.acquire('full page');
      if (!release) return report(fail('busy', busyMessage(lock.current() ?? 'another')));
      void runFullPage(tab, windowId, settings, release);
      return { ok: true, status: 'started' };
    }
  }
}

// ---- visible ------------------------------------------------------------------

async function captureVisible(
  windowId: number,
  tab: Ready['tab'],
  settings: Settings,
): Promise<CaptureResponse> {
  let dataUrl: string;
  try {
    dataUrl = await captureVisibleTab(windowId);
  } catch (err) {
    return fail('failed', `Capture failed: ${errorText(err)}`);
  }
  return upload(dataUrlToBlob(dataUrl), tab, settings);
}

// ---- region -------------------------------------------------------------------

async function handleRegionResult(
  message: RegionResultMessage,
  tab: Tabs.Tab,
): Promise<CaptureResponse> {
  const pending = pendingRegions.get(tab.id!);
  pendingRegions.delete(tab.id!);
  pending?.release();
  if (message.type === 'st:region:cancelled') return { ok: false, code: 'cancelled', message: '' };

  // The service worker may have restarted while the user was dragging, so
  // re-derive everything from the sender tab and storage rather than memory.
  const restricted = restrictedReason(tab.url);
  if (restricted || !tab.url || tab.windowId === undefined) {
    return report(fail('restricted', restricted ?? "Can't capture this page."));
  }
  const settings = pending?.settings ?? (await loadSettings());
  if (!settings.apiToken) {
    return report(fail('no_token', 'Add your API token in the extension settings first.'));
  }
  return report(await captureRegion(message.selection, tab as Ready['tab'], settings));
}

async function captureRegion(
  selection: RegionSelection,
  tab: Ready['tab'],
  settings: Settings,
): Promise<CaptureResponse> {
  let blob: Blob;
  try {
    const dataUrl = await captureVisibleTab(tab.windowId!);
    const bitmap = await decodeDataUrl(dataUrl);
    try {
      const scale = deriveScale(selection, bitmap);
      const rect = regionToPhysical(selection, scale, bitmap);
      if (!rect) return fail('failed', 'The selected region was outside the visible page.');
      blob = await cropBitmap(bitmap, rect);
    } finally {
      bitmap.close();
    }
  } catch (err) {
    return fail('failed', `Capture failed: ${errorText(err)}`);
  }
  return upload(blob, tab, settings);
}

// ---- full page ----------------------------------------------------------------

async function runFullPage(
  tab: Ready['tab'],
  windowId: number,
  settings: Settings,
  release: () => void,
): Promise<void> {
  try {
    const result =
      BROWSER_TARGET === 'firefox'
        ? await captureFullPageFirefox(tab)
        : await captureFullPageChrome(tab, windowId);
    const response = await upload(result.blob, tab, settings);
    if (response.ok && result.truncated) await notify(truncationNotice(result.heightPx));
    await report(response);
  } catch (err) {
    if (err instanceof CaptureCancelledError) await report(fail('cancelled', err.message));
    else await report(fail('failed', `Full-page capture failed: ${errorText(err)}`));
  } finally {
    release();
    await clearBadgeIfProgress();
  }
}

interface FullPageResult {
  blob: Blob;
  heightPx: number;
  truncated: boolean;
}

/** Firefox: the whole document in one native call (PLAN.md §15). */
async function captureFullPageFirefox(tab: Ready['tab']): Promise<FullPageResult> {
  await injectContentScript(tab.id!);
  const reply = await sendToContent(tab.id!, { type: 'st:page:measure' }, 'st:page:metrics');
  const spec = fullPageRect(reply.metrics);
  const dataUrl = await browser.tabs.captureTab(tab.id!, {
    format: 'png',
    rect: spec.rect,
    scale: spec.scale,
    resetScrollPosition: true,
  });
  const bitmap = await decodeDataUrl(dataUrl);
  try {
    const rec = reconcileFullPageCapture(spec, bitmap);
    if (rec.scaleMismatch) {
      console.info(
        `captureTab rendered at ${rec.effectiveScale.toFixed(3)}× (asked ${spec.scale}); cropping to the cap if needed`,
      );
    }
    if (rec.cropHeightPx !== null) {
      const blob = await cropBitmap(bitmap, {
        x: 0,
        y: 0,
        width: bitmap.width,
        height: rec.cropHeightPx,
      });
      return { blob, heightPx: rec.cropHeightPx, truncated: true };
    }
    return { blob: dataUrlToBlob(dataUrl), heightPx: bitmap.height, truncated: spec.truncated };
  } finally {
    bitmap.close();
  }
}

/** Chrome: scroll-and-stitch via lib/stitch.ts against the injected page driver. */
async function captureFullPageChrome(tab: Ready['tab'], windowId: number): Promise<FullPageResult> {
  const tabId = tab.id!;
  await injectContentScript(tabId);
  const result = await stitchFullPage({
    page: {
      begin: async () =>
        (await sendToContent(tabId, { type: 'st:page:begin' }, 'st:page:metrics')).metrics,
      scrollTo: async (y) => {
        const r = await sendToContent(tabId, { type: 'st:page:scroll', y }, 'st:page:scrolled');
        return { scrollY: r.scrollY, cancelled: r.cancelled };
      },
      hideFixed: async () =>
        (await sendToContent(tabId, { type: 'st:page:hide-fixed' }, 'st:page:hidden')).count,
      restore: async () => {
        await sendToContent(tabId, { type: 'st:page:restore' }, 'st:page:restored');
      },
    },
    captureViewport: async () => decodeDataUrl(await captureVisibleTab(windowId)),
    createComposite,
    tabStillActive: async () => {
      try {
        const current = await browser.tabs.get(tabId);
        return current.active === true && current.windowId === windowId;
      } catch {
        return false;
      }
    },
    sleep,
    onProgress: (percent) => void showProgress(percent),
  });
  return { blob: result.blob, heightPx: result.height, truncated: result.truncated };
}

// ---- shared plumbing ----------------------------------------------------------

async function upload(blob: Blob, tab: Ready['tab'], settings: Settings): Promise<CaptureResponse> {
  const oversize = oversizeMessage(blob.size);
  if (oversize) return fail('oversize', oversize);

  const outcome = await uploadCapture({
    origin: settings.serverOrigin,
    token: settings.apiToken,
    image: blob,
    sourceUrl: tab.url,
    title: tab.title ?? '',
  });
  switch (outcome.kind) {
    case 'created':
      await openPage(outcome.pageUrl, tab);
      return { ok: true, status: 'uploaded', pageUrl: outcome.pageUrl };
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

const THROTTLE_ERROR = 'MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND';

/** captureVisibleTab as PNG; one retry after the shared interval if Chrome's throttle bites. */
async function captureVisibleTab(windowId: number): Promise<string> {
  try {
    return await browser.tabs.captureVisibleTab(windowId, { format: 'png' });
  } catch (err) {
    if (!errorText(err).includes(THROTTLE_ERROR)) throw err;
    await sleep(CAPTURE_TILE_INTERVAL_MS);
    return browser.tabs.captureVisibleTab(windowId, { format: 'png' });
  }
}

async function injectContentScript(tabId: number): Promise<void> {
  await browser.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT_FILE] });
}

type ReplyOf<T extends ContentReply['type']> = Extract<ContentReply, { type: T }>;

/** Send one command and insist on the expected reply type, within a timeout. */
async function sendToContent<T extends ContentReply['type']>(
  tabId: number,
  command: ContentCommand,
  expected: T,
): Promise<ReplyOf<T>> {
  const reply = await withTimeout(
    browser.tabs.sendMessage(tabId, command),
    CONTENT_COMMAND_TIMEOUT_MS,
    `the page did not answer "${command.type}" in time`,
  );
  if (!isContentReply(reply)) throw new Error(`unexpected reply to "${command.type}"`);
  if (reply.type === 'st:error') throw new Error(reply.message);
  if (reply.type !== expected) throw new Error(`unexpected "${reply.type}" for "${command.type}"`);
  return reply as ReplyOf<T>;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(what)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

async function clearBadgeIfProgress(): Promise<void> {
  try {
    const text = await browser.action.getBadgeText({});
    if (text.endsWith('%')) await clearBadge();
  } catch {
    // Badge state is cosmetic.
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
  if (!message) return;
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
