import { CAPTURE_TILE_INTERVAL_MS } from '@snapping-turtle/shared';
import {
  deriveScale,
  drawRectFor,
  planTiles,
  progressPercent,
  type PageMetrics,
} from './capture-geometry.js';
import type { Composite, TileImage } from './image.js';

/**
 * Chrome scroll-and-stitch (PLAN.md §15), written against interfaces so the
 * sequence — pace every tile by the shared interval, capture the first tile
 * before hiding fixed/sticky elements, crop-composite the clamped last tile,
 * close every bitmap, stop when the user presses Esc or leaves the tab, and
 * restore the page whatever happens — is provable in a unit test with fakes.
 * background.ts binds the real captureVisibleTab, content script and canvas.
 */

export interface StitchPage {
  /** Measure, remember the scroll position, scroll to the top. */
  begin(): Promise<PageMetrics>;
  /** Scroll and report where the page actually landed, and whether Esc was pressed. */
  scrollTo(y: number): Promise<{ scrollY: number; cancelled: boolean }>;
  hideFixed(): Promise<number>;
  restore(): Promise<void>;
}

export interface StitchDeps {
  page: StitchPage;
  /** One captureVisibleTab, decoded. The stitcher closes the image. */
  captureViewport(): Promise<TileImage>;
  createComposite(width: number, height: number): Composite;
  /** False once the user switched tabs: later tiles would show the wrong page. */
  tabStillActive(): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  onProgress?: (percent: number) => void;
  /** Defaults to the shared CAPTURE_TILE_INTERVAL_MS; tests shorten it. */
  tileIntervalMs?: number;
  /** Defaults to the shared MAX_IMAGE_HEIGHT_PX; tests shorten it. */
  maxHeightPx?: number;
}

export interface StitchResult {
  blob: Blob;
  /** Physical px. */
  width: number;
  height: number;
  truncated: boolean;
  tiles: number;
  fixedHidden: number;
}

export class CaptureCancelledError extends Error {
  constructor(message = 'Capture cancelled.') {
    super(message);
    this.name = 'CaptureCancelledError';
  }
}

export async function stitchFullPage(deps: StitchDeps): Promise<StitchResult> {
  const interval = deps.tileIntervalMs ?? CAPTURE_TILE_INTERVAL_MS;
  const progress = (done: number, total: number): void =>
    deps.onProgress?.(progressPercent(done, total));
  const ensureActive = async (): Promise<void> => {
    if (!(await deps.tabStillActive())) {
      throw new CaptureCancelledError('Capture stopped: the tab was switched away mid-capture.');
    }
  };

  const metrics = await deps.page.begin();
  let composite: Composite | null = null;
  try {
    // Let the scroll-to-top settle and respect the throttle for any capture
    // that ran just before us.
    await deps.sleep(interval);
    await ensureActive();
    const first = await deps.captureViewport();
    let plan;
    try {
      const scale = deriveScale(metrics, first);
      plan = planTiles(metrics, {
        scale,
        ...(deps.maxHeightPx !== undefined ? { maxHeightPx: deps.maxHeightPx } : {}),
      });
    } catch (err) {
      first.close();
      throw err;
    }
    const total = plan.tiles.length;
    composite = deps.createComposite(plan.canvasWidth, plan.canvasHeight);
    const draw = (tileIndex: number, actualScrollY: number, image: TileImage): void => {
      const tile = plan.tiles[tileIndex]!;
      const rect = drawRectFor(tile, actualScrollY, plan, metrics.viewportHeight, image);
      if (rect) composite!.draw(image, rect);
      else image.close();
    };

    progress(0, total);
    draw(0, 0, first);
    progress(1, total);

    let fixedHidden = 0;
    if (total > 1) fixedHidden = await deps.page.hideFixed();

    for (let i = 1; i < total; i++) {
      const tile = plan.tiles[i]!;
      const { scrollY, cancelled } = await deps.page.scrollTo(tile.scrollY);
      if (cancelled) throw new CaptureCancelledError('Full-page capture cancelled.');
      await deps.sleep(interval);
      await ensureActive();
      const image = await deps.captureViewport();
      draw(i, scrollY, image);
      progress(i + 1, total);
    }

    const blob = await composite.toBlob();
    return {
      blob,
      width: plan.canvasWidth,
      height: plan.canvasHeight,
      truncated: plan.truncated,
      tiles: total,
      fixedHidden,
    };
  } finally {
    composite?.dispose();
    try {
      await deps.page.restore();
    } catch (err) {
      // Never mask the original failure with a restore failure; the content
      // script's own watchdog is the second line of defence.
      console.warn('page restore failed', err instanceof Error ? err.message : String(err));
    }
  }
}
