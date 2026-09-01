import {
  MAX_IMAGE_HEIGHT_PX,
  MAX_IMAGE_WIDTH_PX,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_MB,
} from '@snapping-turtle/shared/constants';

/**
 * Pure geometry for region and full-page capture (PLAN.md §15). No browser
 * APIs: everything here takes numbers and returns numbers so the maths that
 * stitching bugs hide in — the final scroll step almost never lands on a tile
 * boundary, classic scrollbars widen the captured image past the content, and
 * devicePixelRatio rounding produces seams — is exhaustively unit-tested
 * before it touches a canvas.
 *
 * Units: "CSS px" are page/viewport coordinates as the DOM reports them;
 * "physical px" are image pixels (CSS × scale). `scale` is normally
 * `devicePixelRatio`, but the Chrome stitcher derives it from the first tile
 * it actually receives (see deriveScale) rather than trusting the page.
 */

/** Everything the content script measures before a full-page capture. */
export interface PageMetrics {
  /** Document extent in CSS px: the max of the documentElement/body scroll
   *  and offset sizes, which disagree in quirks mode and on overflow hacks. */
  documentWidth: number;
  documentHeight: number;
  /** Viewport content box in CSS px (documentElement.clientWidth/Height):
   *  excludes classic scrollbars, so composites at this width have no stripe. */
  viewportWidth: number;
  viewportHeight: number;
  /** window.innerWidth/innerHeight: what captureVisibleTab renders (incl. scrollbars). */
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
}

/** One scroll-and-capture step, in CSS px. */
export interface Tile {
  index: number;
  /** Where the page is scrolled to before capturing. */
  scrollY: number;
  /** Row of the composite this tile's rows land on. */
  destY: number;
  /** Rows to skip from the top of the captured viewport (non-zero only when
   *  the scroll was clamped short, i.e. the last tile overlaps the previous). */
  srcY: number;
  /** Rows to copy. */
  height: number;
}

export interface TilePlan {
  scale: number;
  /** Composite size in CSS px. */
  width: number;
  height: number;
  /** Composite size in physical px (what the canvas is allocated at). */
  canvasWidth: number;
  canvasHeight: number;
  /** True when the document was taller than the cap and only the top was planned. */
  truncated: boolean;
  tiles: Tile[];
}

export interface PlanOptions {
  /** Physical px per CSS px; defaults to metrics.devicePixelRatio. */
  scale?: number;
  /** Physical height cap; defaults to the shared MAX_IMAGE_HEIGHT_PX. */
  maxHeightPx?: number;
  /** Physical width cap; defaults to the shared MAX_IMAGE_WIDTH_PX. */
  maxWidthPx?: number;
}

/** Selections narrower or shorter than this are treated as an accidental click. */
export const MIN_REGION_CSS_PX = 4;

const isPositive = (n: number): boolean => Number.isFinite(n) && n > 0;
const isNonNegative = (n: number): boolean => Number.isFinite(n) && n >= 0;

export function assertMetrics(m: PageMetrics): void {
  for (const key of [
    'documentWidth',
    'documentHeight',
    'viewportWidth',
    'viewportHeight',
    'innerWidth',
    'innerHeight',
    'devicePixelRatio',
  ] as const) {
    if (!isPositive(m[key])) throw new Error(`page metrics: ${key} must be a positive number`);
  }
}

/** Tallest CSS-px extent that fits the physical cap at this scale. */
export function cssHeightCap(scale: number, maxHeightPx: number = MAX_IMAGE_HEIGHT_PX): number {
  if (!isPositive(scale)) throw new Error('scale must be positive');
  return Math.max(1, Math.floor(maxHeightPx / scale));
}

/**
 * Scroll offsets, per-tile crops and the height-cap truncation for a Chrome
 * scroll-and-stitch. Tiles are `viewportHeight` apart; the last one scrolls
 * only as far as the page allows and is crop-composited from `srcY`, never
 * blindly appended. Throws if the composite would be wider than the server
 * accepts (the height is capped instead, per §15).
 */
export function planTiles(metrics: PageMetrics, opts: PlanOptions = {}): TilePlan {
  assertMetrics(metrics);
  const scale = opts.scale ?? metrics.devicePixelRatio;
  if (!isPositive(scale)) throw new Error('scale must be positive');
  const maxHeightPx = opts.maxHeightPx ?? MAX_IMAGE_HEIGHT_PX;
  const maxWidthPx = opts.maxWidthPx ?? MAX_IMAGE_WIDTH_PX;

  const { documentHeight, viewportWidth, viewportHeight } = metrics;
  const cap = cssHeightCap(scale, maxHeightPx);
  const truncated = documentHeight > cap;
  const height = Math.max(1, Math.round(truncated ? cap : documentHeight));
  const width = Math.round(viewportWidth);
  const canvasWidth = Math.round(width * scale);
  const canvasHeight = Math.round(height * scale);
  if (canvasWidth > maxWidthPx) {
    throw new Error(
      `This page is ${canvasWidth} px wide at the current zoom, more than the ${maxWidthPx} px the server accepts. Zoom out or capture a region instead.`,
    );
  }

  const step = Math.max(1, Math.round(viewportHeight));
  const maxScroll = Math.max(0, Math.round(documentHeight) - step);
  const tiles: Tile[] = [];
  for (let y = 0; y < height; y += step) {
    const scrollY = Math.min(y, maxScroll);
    tiles.push({
      index: tiles.length,
      scrollY,
      destY: y,
      srcY: y - scrollY,
      height: Math.min(step, height - y),
    });
  }
  return { scale, width, height, canvasWidth, canvasHeight, truncated, tiles };
}

/** Physical-pixel drawImage arguments for one tile. */
export interface DrawRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/**
 * Where a captured viewport lands on the composite, given where the page
 * *actually* scrolled to (pages shrink, grow, or refuse a scroll position
 * mid-capture). The rows the plan wanted are intersected with the rows the
 * tile really shows; null means this tile contributes nothing. Boundaries are
 * rounded from CSS edges, not from heights, so adjacent tiles meet without a
 * seam at fractional scales like 1.25 or 1.5.
 */
export function drawRectFor(
  tile: Tile,
  actualScrollY: number,
  plan: Pick<TilePlan, 'scale' | 'canvasWidth' | 'canvasHeight'>,
  viewportHeight: number,
  tileImage: { width: number; height: number },
): DrawRect | null {
  if (!isNonNegative(actualScrollY)) throw new Error('actualScrollY must be a non-negative number');
  const wantTop = tile.destY;
  const wantBottom = tile.destY + tile.height;
  const haveTop = actualScrollY;
  const haveBottom = actualScrollY + viewportHeight;
  const top = Math.max(wantTop, haveTop);
  const bottom = Math.min(wantBottom, haveBottom);
  if (bottom <= top) return null;

  const { scale } = plan;
  const dy = Math.round(top * scale);
  const dh = Math.min(Math.round(bottom * scale), plan.canvasHeight) - dy;
  const sy = Math.round((top - actualScrollY) * scale);
  const sh = Math.min(dh, tileImage.height - sy);
  const sw = Math.min(plan.canvasWidth, tileImage.width);
  if (dh <= 0 || sh <= 0 || sw <= 0) return null;
  return { sx: 0, sy, sw, sh, dx: 0, dy, dw: sw, dh: sh };
}

/**
 * Physical px per CSS px, from the first tile Chrome actually returned:
 * captureVisibleTab renders window.innerWidth × innerHeight at the device
 * scale, so the ratio is exact up to rounding. Falls back to the reported
 * devicePixelRatio when the image does not look like that viewport at all.
 */
export function deriveScale(
  metrics: Pick<PageMetrics, 'innerWidth' | 'innerHeight' | 'devicePixelRatio'>,
  image: { width: number; height: number },
): number {
  const byWidth = image.width / metrics.innerWidth;
  const byHeight = image.height / metrics.innerHeight;
  if (!isPositive(byWidth) || !isPositive(byHeight)) return metrics.devicePixelRatio;
  // Both axes must agree (a stray scrollbar is well under 2% of a viewport).
  if (Math.abs(byWidth - byHeight) / byWidth > 0.02) return metrics.devicePixelRatio;
  return byWidth;
}

// ---- Firefox: one native captureTab over a page-coordinate rect --------------

export interface FullPageRect {
  rect: { x: number; y: number; width: number; height: number };
  /** Passed explicitly as `scale` so the output size is deterministic. */
  scale: number;
  truncated: boolean;
  expectedWidthPx: number;
  expectedHeightPx: number;
}

/** The rect for `tabs.captureTab(tabId, { rect, scale })`, height-capped in physical px. */
export function fullPageRect(metrics: PageMetrics, opts: PlanOptions = {}): FullPageRect {
  assertMetrics(metrics);
  const scale = opts.scale ?? metrics.devicePixelRatio;
  const maxHeightPx = opts.maxHeightPx ?? MAX_IMAGE_HEIGHT_PX;
  const maxWidthPx = opts.maxWidthPx ?? MAX_IMAGE_WIDTH_PX;
  const cap = cssHeightCap(scale, maxHeightPx);
  const truncated = metrics.documentHeight > cap;
  const height = Math.max(1, Math.round(truncated ? cap : metrics.documentHeight));
  const width = Math.round(metrics.viewportWidth);
  const expectedWidthPx = Math.round(width * scale);
  if (expectedWidthPx > maxWidthPx) {
    throw new Error(
      `This page is ${expectedWidthPx} px wide at the current zoom, more than the ${maxWidthPx} px the server accepts. Zoom out or capture a region instead.`,
    );
  }
  return {
    rect: { x: 0, y: 0, width, height },
    scale,
    truncated,
    expectedWidthPx,
    expectedHeightPx: Math.round(height * scale),
  };
}

export interface CaptureReconciliation {
  /** Physical px per CSS px the browser really used. */
  effectiveScale: number;
  /** The output must be cropped to this many rows to honour the cap (null: fits). */
  cropHeightPx: number | null;
  /** True when the browser rendered at a different scale than requested. */
  scaleMismatch: boolean;
}

/**
 * Compare what captureTab returned with what was asked for. Firefox documents
 * `scale` as "defaults to devicePixelRatio", so the explicit scale should be
 * honoured exactly — but the height cap is enforced on the real image either
 * way, so a browser that multiplies by devicePixelRatio again can never push
 * an over-cap image into the upload.
 */
export function reconcileFullPageCapture(
  expected: FullPageRect,
  actual: { width: number; height: number },
  maxHeightPx: number = MAX_IMAGE_HEIGHT_PX,
): CaptureReconciliation {
  if (!isPositive(actual.width) || !isPositive(actual.height)) {
    throw new Error('captureTab returned an empty image');
  }
  const effectiveScale = actual.width / expected.rect.width;
  const scaleMismatch = Math.abs(effectiveScale - expected.scale) / expected.scale > 0.02;
  const cropHeightPx = actual.height > maxHeightPx ? maxHeightPx : null;
  return { effectiveScale, cropHeightPx, scaleMismatch };
}

// ---- Region selection ---------------------------------------------------------

export interface CssRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Two drag corners → a normalised rect clamped to the viewport, or null if it is a click. */
export function normalizeDrag(
  start: { x: number; y: number },
  end: { x: number; y: number },
  viewport: { width: number; height: number },
): CssRect | null {
  const clampX = (v: number): number => Math.min(Math.max(v, 0), viewport.width);
  const clampY = (v: number): number => Math.min(Math.max(v, 0), viewport.height);
  const x0 = clampX(start.x);
  const x1 = clampX(end.x);
  const y0 = clampY(start.y);
  const y1 = clampY(end.y);
  const rect = {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
  if (rect.width < MIN_REGION_CSS_PX || rect.height < MIN_REGION_CSS_PX) return null;
  return rect;
}

export interface PhysicalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Scale a CSS-px viewport rect onto the captured image, clamped to its
 * bounds. Edges are rounded independently so the crop never lands a pixel
 * outside the image at fractional scales. Null when nothing is left.
 */
export function regionToPhysical(
  rect: CssRect,
  scale: number,
  image: { width: number; height: number },
): PhysicalRect | null {
  if (!isPositive(scale)) throw new Error('scale must be positive');
  for (const v of [rect.x, rect.y, rect.width, rect.height]) {
    if (!Number.isFinite(v)) throw new Error('region rect must be finite');
  }
  const left = Math.min(Math.max(Math.round(rect.x * scale), 0), image.width);
  const top = Math.min(Math.max(Math.round(rect.y * scale), 0), image.height);
  const right = Math.min(Math.max(Math.round((rect.x + rect.width) * scale), 0), image.width);
  const bottom = Math.min(Math.max(Math.round((rect.y + rect.height) * scale), 0), image.height);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

// ---- Size honesty and user-facing notices ------------------------------------

/** Set when a capture is bigger than the server's upload cap; null when it fits. */
export function oversizeMessage(
  bytes: number,
  maxBytes: number = MAX_UPLOAD_BYTES,
  maxMb: number = MAX_UPLOAD_MB,
): string | null {
  if (!isNonNegative(bytes)) throw new Error('bytes must be a non-negative number');
  if (bytes <= maxBytes) return null;
  const mb = Math.round((bytes / (1024 * 1024)) * 10) / 10;
  return `The capture is ${mb} MB, more than the ${maxMb} MB the server accepts. Capture a region of the part you need instead.`;
}

/** Notice for a page that was taller than the physical cap. */
export function truncationNotice(
  capturedHeightPx: number,
  maxHeightPx: number = MAX_IMAGE_HEIGHT_PX,
): string {
  return `This page is taller than the ${maxHeightPx.toLocaleString('en-US')} px limit, so the top ${capturedHeightPx.toLocaleString('en-US')} px were captured.`;
}

/** Whole-number percentage for the toolbar badge, clamped to 0–100. */
export function progressPercent(done: number, total: number): number {
  if (!isPositive(total) || !isNonNegative(done)) return 0;
  return Math.min(100, Math.max(0, Math.round((done / total) * 100)));
}
