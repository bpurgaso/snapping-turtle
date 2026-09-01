import browser, { type Runtime } from 'webextension-polyfill';
import {
  isContentCommand,
  type ContentCommand,
  type ContentReply,
  type RegionResultMessage,
} from '../lib/content-protocol.js';
import { PageDriver } from './page-driver.js';
import { selectRegion } from './region-overlay.js';

/**
 * Content script injected on demand with `scripting.executeScript` (needs the
 * activeTab gesture, PLAN.md §15). Idempotent: a flag in the isolated world —
 * invisible to the page — stops a second injection registering a second
 * listener. It is a thin dispatcher over region-overlay.ts and page-driver.ts.
 *
 * Region selection is two-phase so Chrome's service worker can die while the
 * user is still dragging: the command returns `started` at once and the
 * result travels as a fresh runtime message, which wakes the worker.
 *
 * Full-page stitching keeps a driver alive between commands. A watchdog
 * restores the page if the background falls silent (crash, tab switch,
 * worker termination), and Esc marks the run cancelled so the next scroll
 * command reports it and the background stops and restores.
 */

declare global {
  var __snappingTurtleContent: true | undefined;
}

/** Restore on our own if the background goes quiet for this long. */
export const DRIVER_WATCHDOG_MS = 15_000;

if (!globalThis.__snappingTurtleContent) {
  globalThis.__snappingTurtleContent = true;
  install();
}

function install(): void {
  let driver: PageDriver | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;

  const onEscape = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' || event.key === 'Esc') cancelled = true;
  };

  const armWatchdog = (): void => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      console.warn('snapping-turtle: capture went quiet; restoring the page');
      teardown();
    }, DRIVER_WATCHDOG_MS);
  };

  const teardown = (): void => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
    window.removeEventListener('keydown', onEscape, true);
    try {
      driver?.restore();
    } finally {
      driver = null;
      cancelled = false;
    }
  };

  const handle = (command: ContentCommand): ContentReply => {
    switch (command.type) {
      case 'st:region:select': {
        void selectRegion(document).then(
          (selection) => {
            const result: RegionResultMessage = selection
              ? { type: 'st:region:selected', selection }
              : { type: 'st:region:cancelled' };
            return browser.runtime.sendMessage(result);
          },
          (err: unknown) => console.warn('snapping-turtle: region overlay failed', err),
        );
        return { type: 'st:region:started' };
      }
      case 'st:page:measure':
        return { type: 'st:page:metrics', metrics: new PageDriver(window).measure() };
      case 'st:page:begin': {
        teardown();
        driver = new PageDriver(window);
        cancelled = false;
        window.addEventListener('keydown', onEscape, true);
        armWatchdog();
        return { type: 'st:page:metrics', metrics: driver.begin() };
      }
      case 'st:page:scroll': {
        if (!driver) return { type: 'st:error', message: 'no capture in progress' };
        armWatchdog();
        const { scrollX, scrollY } = driver.scrollTo(command.y);
        return { type: 'st:page:scrolled', scrollX, scrollY, cancelled };
      }
      case 'st:page:hide-fixed': {
        if (!driver) return { type: 'st:error', message: 'no capture in progress' };
        armWatchdog();
        return { type: 'st:page:hidden', count: driver.hideFixed() };
      }
      case 'st:page:restore':
        teardown();
        return { type: 'st:page:restored' };
    }
  };

  browser.runtime.onMessage.addListener((message: unknown, sender: Runtime.MessageSender) => {
    // Only our own extension may drive this page: web pages cannot reach
    // runtime.onMessage with our id, and content scripts have no tabs.sendMessage.
    if (sender.id !== browser.runtime.id || !isContentCommand(message)) return undefined;
    try {
      return Promise.resolve(handle(message));
    } catch (err) {
      const reply: ContentReply = {
        type: 'st:error',
        message: err instanceof Error ? err.message : String(err),
      };
      return Promise.resolve(reply);
    }
  });
}
