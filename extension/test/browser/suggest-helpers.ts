import type { Page } from '@playwright/test';
import { expect, openFixture } from './fixtures.js';

/**
 * Shared driving code for the suggestion specs (E11): mount the overlay in a
 * fixture with every hook recording into `window.__stTest`, hover, read the
 * highlight, the snap state and the metrics, cancel.
 */

export interface Painted {
  rect: { x: number; y: number; width: number; height: number };
  kind: string;
  badge: string;
  promoted: boolean;
}
export interface Snapped {
  left: boolean;
  top: boolean;
  right: boolean;
  bottom: boolean;
}
export interface Metrics {
  scan: {
    status: string;
    examined: number;
    peeked: number;
    hidden: number;
    candidates: number;
    slices: number;
    workMs: number;
    wallMs: number;
  } | null;
  scans: number;
  hover: { count: number; totalMs: number; maxMs: number; samples: number[] };
}
export type OverlayEvent =
  ['suggest', Painted | null] | ['paint', Painted['rect'] | null] | ['snap', Snapped];

export const rect = (x: number, y: number, width: number, height: number) => ({
  x,
  y,
  width,
  height,
});

/** Start a selection, logging every highlight change, repaint and snap in order. */
export function startSelection(page: Page, options: { suggestions?: boolean } = {}) {
  return page.evaluate((opts) => {
    const events: unknown[] = [];
    window.__stTest['events'] = events;
    window.__stTest['current'] = null;
    window.__stTest['snap'] = null;
    window.__stTest['metrics'] = null;
    window.__stTest['lastPaint'] = null;
    return window.__stHarness.selectRegion(
      document,
      {
        onPaint: (r) => {
          events.push(['paint', r]);
          window.__stTest['lastPaint'] = r;
        },
        onSuggest: (suggestion) => {
          events.push(['suggest', suggestion]);
          window.__stTest['current'] = suggestion;
        },
        onSnap: (edges) => {
          events.push(['snap', edges]);
          window.__stTest['snap'] = edges;
        },
        onMetrics: (metrics) => {
          window.__stTest['metrics'] = metrics;
        },
      },
      opts,
    );
  }, options);
}

export const overlayPresent = (page: Page) =>
  page.evaluate(() => document.querySelector('snapping-turtle-region') !== null);

export const events = (page: Page) =>
  page.evaluate(() => window.__stTest['events'] as OverlayEvent[]);

export const current = (page: Page) =>
  page.evaluate(() => window.__stTest['current'] as Painted | null);

export const lastSnap = (page: Page) =>
  page.evaluate(() => window.__stTest['snap'] as Snapped | null);

export const lastPaint = (page: Page) =>
  page.evaluate(() => window.__stTest['lastPaint'] as Painted['rect'] | null);

export const metrics = (page: Page) =>
  page.evaluate(() => window.__stTest['metrics'] as Metrics | null);

/** Two animation frames: the hover evaluation runs on the first one after a move. */
export const frames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

/** Move the pointer and return what is highlighted once the hover has been evaluated. */
export async function hover(page: Page, x: number, y: number): Promise<Painted | null> {
  await page.mouse.move(x, y);
  await frames(page);
  return current(page);
}

/** Wait for the first scan to complete (hover answers are partial until then). */
export async function scanned(page: Page): Promise<Metrics> {
  await expect.poll(() => metrics(page).then((m) => m?.scans ?? 0)).toBeGreaterThan(0);
  return (await metrics(page))!;
}

/**
 * Open a fixture with the overlay mounted and the first scan complete. The
 * pending selection comes back wrapped, because returning the promise itself
 * from an async function would wait for the selection to finish.
 */
export async function open(page: Page, fixture: string, options: { suggestions?: boolean } = {}) {
  await openFixture(page, fixture);
  const result = startSelection(page, options);
  await expect.poll(() => overlayPresent(page)).toBe(true);
  if (options.suggestions !== false) await scanned(page);
  return { result };
}

/** Esc, and the selection resolves null with the overlay gone. */
export async function cancel(page: Page, result: Promise<unknown>): Promise<void> {
  await page.keyboard.press('Escape');
  expect(await result).toBeNull();
  expect(await overlayPresent(page)).toBe(false);
}

/** Drag from one point to another in a few steps. */
export async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await frames(page);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

export const NO_SNAP: Snapped = { left: false, top: false, right: false, bottom: false };

/** Percentile of a sample, nearest-rank. */
export function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}
