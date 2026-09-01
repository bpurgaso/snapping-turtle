import { MAX_IMAGE_HEIGHT_PX, MAX_IMAGE_WIDTH_PX, MAX_UPLOAD_BYTES } from '@snapping-turtle/shared';
import { describe, expect, it } from 'vitest';
import {
  cssHeightCap,
  deriveScale,
  drawRectFor,
  fullPageRect,
  normalizeDrag,
  oversizeMessage,
  planTiles,
  progressPercent,
  reconcileFullPageCapture,
  regionToPhysical,
  truncationNotice,
  type PageMetrics,
  type TilePlan,
} from '../src/lib/capture-geometry.js';

const metrics = (over: Partial<PageMetrics> = {}): PageMetrics => ({
  documentWidth: 1280,
  documentHeight: 3000,
  viewportWidth: 1265, // classic scrollbar: 15 px narrower than innerWidth
  viewportHeight: 800,
  innerWidth: 1280,
  innerHeight: 800,
  devicePixelRatio: 1,
  ...over,
});

/** Every row of the composite is covered exactly once, in order, by page row = composite row. */
function assertGapless(plan: TilePlan, documentHeight: number, viewportHeight = 800): void {
  let next = 0;
  for (const tile of plan.tiles) {
    expect(tile.destY).toBe(next);
    expect(tile.height).toBeGreaterThan(0);
    expect(tile.srcY).toBeGreaterThanOrEqual(0);
    // The page rows this tile copies are exactly the composite rows it fills.
    expect(tile.scrollY + tile.srcY).toBe(tile.destY);
    // And they exist within the captured viewport.
    expect(tile.scrollY).toBeLessThanOrEqual(Math.max(0, documentHeight - viewportHeight));
    next = tile.destY + tile.height;
  }
  expect(next).toBe(plan.height);
}

describe('planTiles', () => {
  it('a page shorter than the viewport is a single, partial tile at scroll 0', () => {
    const plan = planTiles(metrics({ documentHeight: 500 }));
    expect(plan.tiles).toEqual([{ index: 0, scrollY: 0, destY: 0, srcY: 0, height: 500 }]);
    expect(plan).toMatchObject({
      width: 1265,
      height: 500,
      canvasWidth: 1265,
      canvasHeight: 500,
      truncated: false,
    });
  });

  it('a page exactly one viewport tall is one full tile', () => {
    const plan = planTiles(metrics({ documentHeight: 800 }));
    expect(plan.tiles).toEqual([{ index: 0, scrollY: 0, destY: 0, srcY: 0, height: 800 }]);
  });

  it('a page that is an exact multiple of the viewport has no overlap anywhere', () => {
    const plan = planTiles(metrics({ documentHeight: 2400 }));
    expect(plan.tiles.map((t) => [t.scrollY, t.destY, t.srcY, t.height])).toEqual([
      [0, 0, 0, 800],
      [800, 800, 0, 800],
      [1600, 1600, 0, 800],
    ]);
    assertGapless(plan, 2400);
  });

  it('the last tile is crop-composited when the final scroll is clamped short', () => {
    // 3000 tall / 800 viewport: scrolls 0, 800, 1600, then 2400 is clamped to 2200.
    const plan = planTiles(metrics());
    expect(plan.tiles.map((t) => [t.scrollY, t.destY, t.srcY, t.height])).toEqual([
      [0, 0, 0, 800],
      [800, 800, 0, 800],
      [1600, 1600, 0, 800],
      [2200, 2400, 200, 600],
    ]);
    assertGapless(plan, 3000);
  });

  it('a page one pixel taller than a viewport multiple yields a one-row last tile', () => {
    const plan = planTiles(metrics({ documentHeight: 1601 }));
    expect(plan.tiles.at(-1)).toEqual({
      index: 2,
      scrollY: 801,
      destY: 1600,
      srcY: 799,
      height: 1,
    });
    assertGapless(plan, 1601);
  });

  it('composites at the viewport content width, not the scrollbar-inclusive innerWidth', () => {
    const plan = planTiles(metrics({ devicePixelRatio: 2 }));
    expect(plan.canvasWidth).toBe(1265 * 2);
    expect(plan.canvasWidth).not.toBe(1280 * 2);
  });

  it('scales the canvas by devicePixelRatio while tiles stay in CSS px', () => {
    const plan = planTiles(metrics({ documentHeight: 3000, devicePixelRatio: 2 }));
    expect(plan.canvasHeight).toBe(6000);
    expect(plan.tiles.map((t) => t.scrollY)).toEqual([0, 800, 1600, 2200]);
  });

  it('an explicit scale overrides the reported devicePixelRatio', () => {
    const plan = planTiles(metrics({ devicePixelRatio: 2 }), { scale: 1.5 });
    expect(plan.scale).toBe(1.5);
    expect(plan.canvasWidth).toBe(Math.round(1265 * 1.5));
    expect(plan.canvasHeight).toBe(4500);
  });

  it('caps at the shared physical height and reports truncation', () => {
    const plan = planTiles(metrics({ documentHeight: 40_000 }));
    expect(plan.truncated).toBe(true);
    expect(plan.height).toBe(MAX_IMAGE_HEIGHT_PX);
    expect(plan.canvasHeight).toBe(MAX_IMAGE_HEIGHT_PX);
    assertGapless(plan, 40_000);
    // The cap tile is clamped by height, not by scroll: it has srcY 0.
    const last = plan.tiles.at(-1)!;
    expect(last.destY + last.height).toBe(MAX_IMAGE_HEIGHT_PX);
  });

  it('the height cap is in physical px, so at 2× only 16,000 CSS px are planned', () => {
    const plan = planTiles(metrics({ documentHeight: 20_000, devicePixelRatio: 2 }));
    expect(plan.truncated).toBe(true);
    expect(plan.height).toBe(16_000);
    expect(plan.canvasHeight).toBe(MAX_IMAGE_HEIGHT_PX);
    expect(plan.tiles).toHaveLength(20);
  });

  it('exactly at the cap is not truncated; one CSS px over is', () => {
    expect(planTiles(metrics({ documentHeight: 32_000 })).truncated).toBe(false);
    expect(planTiles(metrics({ documentHeight: 32_001 })).truncated).toBe(true);
    expect(planTiles(metrics({ documentHeight: 16_000, devicePixelRatio: 2 })).truncated).toBe(
      false,
    );
    expect(planTiles(metrics({ documentHeight: 16_001, devicePixelRatio: 2 })).truncated).toBe(
      true,
    );
    // Fractional scale: floor(32000 / 1.5) = 21333 CSS px.
    expect(cssHeightCap(1.5)).toBe(21_333);
    expect(planTiles(metrics({ documentHeight: 21_333 }), { scale: 1.5 }).truncated).toBe(false);
    expect(planTiles(metrics({ documentHeight: 21_334 }), { scale: 1.5 }).truncated).toBe(true);
    expect(planTiles(metrics({ documentHeight: 21_334 }), { scale: 1.5 }).canvasHeight).toBe(
      32_000,
    );
  });

  it('the worst case at 1080p is 40 tiles (~24 s at the shared pacing)', () => {
    const plan = planTiles(metrics({ documentHeight: 32_000, viewportHeight: 800 }));
    expect(plan.tiles).toHaveLength(40);
    const plan2 = planTiles(
      metrics({ documentHeight: 32_000, viewportHeight: 900, innerHeight: 900 }),
    );
    expect(plan2.tiles).toHaveLength(36);
  });

  it('honours a custom cap for tests', () => {
    const plan = planTiles(metrics({ documentHeight: 3000 }), { maxHeightPx: 1000 });
    expect(plan.height).toBe(1000);
    expect(plan.truncated).toBe(true);
    expect(plan.tiles.map((t) => [t.scrollY, t.destY, t.srcY, t.height])).toEqual([
      [0, 0, 0, 800],
      [800, 800, 0, 200],
    ]);
  });

  it('refuses a composite wider than the server accepts', () => {
    expect(() =>
      planTiles(metrics({ viewportWidth: MAX_IMAGE_WIDTH_PX / 2 + 1, devicePixelRatio: 2 })),
    ).toThrow(/wide/);
    expect(() =>
      planTiles(metrics({ viewportWidth: MAX_IMAGE_WIDTH_PX / 2, devicePixelRatio: 2 })),
    ).not.toThrow();
  });

  it('rounds fractional CSS metrics (zoomed pages report them) without gaps', () => {
    const plan = planTiles(metrics({ documentHeight: 2345.6, viewportHeight: 733.3 }));
    expect(plan.height).toBe(2346);
    assertGapless(plan, 2346, 733);
    expect(plan.tiles.map((t) => t.scrollY)).toEqual([0, 733, 1466, 1613]);
  });

  it('rejects nonsense metrics instead of planning garbage', () => {
    expect(() => planTiles(metrics({ documentHeight: 0 }))).toThrow(/documentHeight/);
    expect(() => planTiles(metrics({ viewportHeight: NaN }))).toThrow(/viewportHeight/);
    expect(() => planTiles(metrics({ devicePixelRatio: -1 }))).toThrow(/devicePixelRatio/);
    expect(() => planTiles(metrics(), { scale: 0 })).toThrow(/scale/);
  });
});

describe('drawRectFor', () => {
  const plan = { scale: 1, canvasWidth: 1265, canvasHeight: 3000 };
  const tileImage = { width: 1280, height: 800 };

  it('a full tile at its planned position copies the whole viewport at content width', () => {
    const tile = { index: 1, scrollY: 800, destY: 800, srcY: 0, height: 800 };
    expect(drawRectFor(tile, 800, plan, 800, tileImage)).toEqual({
      sx: 0,
      sy: 0,
      sw: 1265,
      sh: 800,
      dx: 0,
      dy: 800,
      dw: 1265,
      dh: 800,
    });
  });

  it('the clamped last tile copies only its bottom rows', () => {
    const tile = { index: 3, scrollY: 2200, destY: 2400, srcY: 200, height: 600 };
    expect(drawRectFor(tile, 2200, plan, 800, tileImage)).toMatchObject({
      sy: 200,
      sh: 600,
      dy: 2400,
      dh: 600,
    });
  });

  it('scales source and destination by the plan scale, rounding edges not heights', () => {
    const p = { scale: 1.5, canvasWidth: 1898, canvasHeight: 4500 };
    const img = { width: 1920, height: 1200 };
    // destY 2400 → 3600; bottom 3000 → 4500; srcY 200 → 300.
    const tile = { index: 3, scrollY: 2200, destY: 2400, srcY: 200, height: 600 };
    expect(drawRectFor(tile, 2200, p, 800, img)).toEqual({
      sx: 0,
      sy: 300,
      sw: 1898,
      sh: 900,
      dx: 0,
      dy: 3600,
      dw: 1898,
      dh: 900,
    });
    // Adjacent tiles at 1.25 meet exactly: tile 0 ends where tile 1 starts.
    const p125 = { scale: 1.25, canvasWidth: 1581, canvasHeight: 1001 };
    const a = drawRectFor({ index: 0, scrollY: 0, destY: 0, srcY: 0, height: 733 }, 0, p125, 733, {
      width: 1600,
      height: 916,
    })!;
    const b = drawRectFor(
      { index: 1, scrollY: 68, destY: 733, srcY: 665, height: 68 },
      68,
      p125,
      733,
      { width: 1600, height: 916 },
    )!;
    expect(a.dy + a.dh).toBe(b.dy);
    expect(b.dy + b.dh).toBe(1001);
  });

  it('when the page scrolled less than asked (it shrank), only the overlapping rows are drawn', () => {
    // Planned scroll 1600 but the page only reached 1400: the tile shows 1400–2200,
    // the plan wanted 1600–2400 → draw 1600–2200 from rows 200–800 of the tile.
    const tile = { index: 2, scrollY: 1600, destY: 1600, srcY: 0, height: 800 };
    expect(drawRectFor(tile, 1400, plan, 800, tileImage)).toEqual({
      sx: 0,
      sy: 200,
      sw: 1265,
      sh: 600,
      dx: 0,
      dy: 1600,
      dw: 1265,
      dh: 600,
    });
  });

  it('when the page scrolled further than asked, the tile still contributes what it can', () => {
    const tile = { index: 1, scrollY: 800, destY: 800, srcY: 0, height: 800 };
    // Landed on 900: tile shows 900–1700; wanted 800–1600 → draw 900–1600 from rows 0–700.
    expect(drawRectFor(tile, 900, plan, 800, tileImage)).toMatchObject({
      sy: 0,
      sh: 700,
      dy: 900,
      dh: 700,
    });
  });

  it('returns null when the tile shows none of the rows it was meant to cover', () => {
    const tile = { index: 3, scrollY: 2400, destY: 2400, srcY: 0, height: 600 };
    expect(drawRectFor(tile, 0, plan, 800, tileImage)).toBeNull();
  });

  it('never draws past the canvas bottom or the tile image bottom', () => {
    const shortImage = { width: 1280, height: 500 };
    const tile = { index: 0, scrollY: 0, destY: 0, srcY: 0, height: 800 };
    expect(drawRectFor(tile, 0, plan, 800, shortImage)).toMatchObject({ sh: 500, dh: 500 });
    const capped = { scale: 1, canvasWidth: 1265, canvasHeight: 1000 };
    const t2 = { index: 1, scrollY: 800, destY: 800, srcY: 0, height: 200 };
    expect(drawRectFor(t2, 800, capped, 800, tileImage)).toMatchObject({ dy: 800, dh: 200 });
  });

  it('rejects a negative scroll position', () => {
    const tile = { index: 0, scrollY: 0, destY: 0, srcY: 0, height: 800 };
    expect(() => drawRectFor(tile, -1, plan, 800, tileImage)).toThrow(/actualScrollY/);
  });
});

describe('deriveScale', () => {
  const m = { innerWidth: 1280, innerHeight: 800, devicePixelRatio: 2 };
  it('reads the scale off the first tile', () => {
    expect(deriveScale(m, { width: 2560, height: 1600 })).toBe(2);
    expect(deriveScale(m, { width: 1280, height: 800 })).toBe(1);
    expect(deriveScale(m, { width: 1600, height: 1000 })).toBe(1.25);
  });
  it('falls back to devicePixelRatio when the axes disagree or the image is empty', () => {
    expect(deriveScale(m, { width: 2560, height: 800 })).toBe(2);
    expect(deriveScale(m, { width: 0, height: 0 })).toBe(2);
  });
});

describe('fullPageRect (Firefox captureTab)', () => {
  it('asks for the whole document at the viewport content width, scale = dpr', () => {
    const r = fullPageRect(metrics({ documentHeight: 5000, devicePixelRatio: 2 }));
    expect(r).toEqual({
      rect: { x: 0, y: 0, width: 1265, height: 5000 },
      scale: 2,
      truncated: false,
      expectedWidthPx: 2530,
      expectedHeightPx: 10_000,
    });
  });
  it('caps the rect so the physical height honours the shared limit', () => {
    const r = fullPageRect(metrics({ documentHeight: 20_000, devicePixelRatio: 2 }));
    expect(r.rect.height).toBe(16_000);
    expect(r.expectedHeightPx).toBe(MAX_IMAGE_HEIGHT_PX);
    expect(r.truncated).toBe(true);
  });
  it('refuses an over-wide page', () => {
    expect(() =>
      fullPageRect(metrics({ viewportWidth: MAX_IMAGE_WIDTH_PX + 1, innerWidth: 10_016 })),
    ).toThrow(/wide/);
  });
});

describe('reconcileFullPageCapture', () => {
  const expected = fullPageRect(metrics({ documentHeight: 5000, devicePixelRatio: 2 }));
  it('a capture at the requested scale needs nothing', () => {
    expect(reconcileFullPageCapture(expected, { width: 2530, height: 10_000 })).toEqual({
      effectiveScale: 2,
      cropHeightPx: null,
      scaleMismatch: false,
    });
  });
  it('a browser that scaled by dpr again is detected and cropped to the cap', () => {
    // 2530×10000 asked; got 5060×20000 (scale applied twice) — still over the cap? no; but a
    // 16000-CSS-px page at 4× would be 64000 rows: cropped to 32000.
    const tall = fullPageRect(metrics({ documentHeight: 20_000, devicePixelRatio: 2 }));
    const r = reconcileFullPageCapture(tall, { width: 5060, height: 64_000 });
    expect(r.scaleMismatch).toBe(true);
    expect(r.effectiveScale).toBe(4);
    expect(r.cropHeightPx).toBe(MAX_IMAGE_HEIGHT_PX);
  });
  it('an image within a rounding pixel of the request is not a mismatch', () => {
    expect(reconcileFullPageCapture(expected, { width: 2531, height: 10_001 }).scaleMismatch).toBe(
      false,
    );
  });
  it('rejects an empty image', () => {
    expect(() => reconcileFullPageCapture(expected, { width: 0, height: 0 })).toThrow(/empty/);
  });
});

describe('normalizeDrag', () => {
  const viewport = { width: 1000, height: 600 };
  it('orders corners and clamps to the viewport', () => {
    expect(normalizeDrag({ x: 300, y: 250 }, { x: 100, y: 100 }, viewport)).toEqual({
      x: 100,
      y: 100,
      width: 200,
      height: 150,
    });
    expect(normalizeDrag({ x: -50, y: 10 }, { x: 1200, y: 700 }, viewport)).toEqual({
      x: 0,
      y: 10,
      width: 1000,
      height: 590,
    });
  });
  it('treats a click or a hairline drag as no selection', () => {
    expect(normalizeDrag({ x: 10, y: 10 }, { x: 10, y: 10 }, viewport)).toBeNull();
    expect(normalizeDrag({ x: 10, y: 10 }, { x: 13, y: 200 }, viewport)).toBeNull();
    expect(normalizeDrag({ x: 10, y: 10 }, { x: 14, y: 14 }, viewport)).toEqual({
      x: 10,
      y: 10,
      width: 4,
      height: 4,
    });
  });
});

describe('regionToPhysical', () => {
  it('scales by devicePixelRatio', () => {
    expect(
      regionToPhysical({ x: 100, y: 50, width: 200, height: 150 }, 2, {
        width: 2560,
        height: 1600,
      }),
    ).toEqual({ x: 200, y: 100, width: 400, height: 300 });
  });
  it('rounds edges independently so fractional scales never overrun the image', () => {
    expect(
      regionToPhysical({ x: 1, y: 1, width: 3, height: 3 }, 1.5, { width: 6, height: 6 }),
    ).toEqual({ x: 2, y: 2, width: 4, height: 4 });
    expect(
      regionToPhysical({ x: 0, y: 0, width: 1265, height: 800 }, 1.25, {
        width: 1581,
        height: 1000,
      }),
    ).toEqual({ x: 0, y: 0, width: 1581, height: 1000 });
  });
  it('clamps to the image and returns null when nothing is left', () => {
    expect(
      regionToPhysical({ x: 900, y: 500, width: 400, height: 400 }, 1, {
        width: 1000,
        height: 600,
      }),
    ).toEqual({ x: 900, y: 500, width: 100, height: 100 });
    expect(
      regionToPhysical({ x: 1000, y: 0, width: 10, height: 10 }, 1, { width: 1000, height: 600 }),
    ).toBeNull();
    expect(
      regionToPhysical({ x: -20, y: -20, width: 10, height: 10 }, 1, { width: 1000, height: 600 }),
    ).toBeNull();
  });
  it('rejects non-finite input', () => {
    expect(() =>
      regionToPhysical({ x: NaN, y: 0, width: 1, height: 1 }, 1, { width: 10, height: 10 }),
    ).toThrow(/finite/);
    expect(() =>
      regionToPhysical({ x: 0, y: 0, width: 1, height: 1 }, 0, { width: 10, height: 10 }),
    ).toThrow(/scale/);
  });
});

describe('size honesty and notices', () => {
  it('oversizeMessage fires only above the shared cap and suggests region capture', () => {
    expect(oversizeMessage(MAX_UPLOAD_BYTES)).toBeNull();
    expect(oversizeMessage(0)).toBeNull();
    const msg = oversizeMessage(MAX_UPLOAD_BYTES + 1);
    expect(msg).toMatch(/30 MB the server accepts/);
    expect(msg).toMatch(/region/i);
    expect(oversizeMessage(41.26 * 1024 * 1024)).toMatch(/^The capture is 41\.3 MB/);
    expect(() => oversizeMessage(-1)).toThrow();
  });
  it('truncationNotice names the shared cap and the captured height', () => {
    expect(truncationNotice(32_000)).toBe(
      'This page is taller than the 32,000 px limit, so the top 32,000 px were captured.',
    );
  });
  it('progressPercent is a clamped whole number', () => {
    expect(progressPercent(0, 36)).toBe(0);
    expect(progressPercent(1, 36)).toBe(3);
    expect(progressPercent(36, 36)).toBe(100);
    expect(progressPercent(40, 36)).toBe(100);
    expect(progressPercent(1, 0)).toBe(0);
  });
});
