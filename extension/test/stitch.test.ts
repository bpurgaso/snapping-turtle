import { CAPTURE_TILE_INTERVAL_MS } from '@snapping-turtle/shared';
import { describe, expect, it } from 'vitest';
import type { DrawRect, PageMetrics } from '../src/lib/capture-geometry.js';
import type { Composite, TileImage } from '../src/lib/image.js';
import { CaptureCancelledError, stitchFullPage, type StitchDeps } from '../src/lib/stitch.js';

/**
 * The Chrome stitcher against fakes: proves the call sequence (first tile
 * before hiding fixed elements, pacing between every capture, the clamped
 * last tile crop-composited), that every bitmap is closed, that Esc / a tab
 * switch / a throwing step all end in `restore()`, and that progress reaches
 * 100 %.
 */

const metrics: PageMetrics = {
  documentWidth: 1280,
  documentHeight: 3000,
  viewportWidth: 1265,
  viewportHeight: 800,
  innerWidth: 1280,
  innerHeight: 800,
  devicePixelRatio: 2,
};

interface Harness {
  deps: StitchDeps;
  log: string[];
  images: Array<TileImage & { closed: boolean }>;
  draws: DrawRect[];
  progress: number[];
  sleeps: number[];
  composite: { width: number; height: number; disposed: boolean } | null;
}

function harness(
  over: Partial<StitchDeps> & { pageHeight?: number; scrollCap?: number } = {},
): Harness {
  const log: string[] = [];
  const images: Harness['images'] = [];
  const draws: DrawRect[] = [];
  const progress: number[] = [];
  const sleeps: number[] = [];
  const h: Harness = { deps: null!, log, images, draws, progress, sleeps, composite: null };
  const pageHeight = over.pageHeight ?? metrics.documentHeight;
  const scrollCap = over.scrollCap ?? Math.max(0, pageHeight - metrics.viewportHeight);
  const page: StitchDeps['page'] = {
    begin: async () => {
      log.push('begin');
      return { ...metrics, documentHeight: pageHeight };
    },
    scrollTo: async (y) => {
      log.push(`scroll:${y}`);
      return { scrollY: Math.min(y, scrollCap), cancelled: false };
    },
    hideFixed: async () => {
      log.push('hide');
      return 2;
    },
    restore: async () => {
      log.push('restore');
    },
  };
  h.deps = {
    page,
    captureViewport: async () => {
      log.push('capture');
      const img = {
        width: metrics.innerWidth * 2,
        height: metrics.innerHeight * 2,
        closed: false,
        close() {
          this.closed = true;
        },
      };
      images.push(img);
      return img;
    },
    createComposite: (width, height) => {
      log.push(`composite:${width}x${height}`);
      h.composite = { width, height, disposed: false };
      const composite: Composite = {
        draw: (image, rect) => {
          log.push(`draw:${rect.dy}`);
          draws.push(rect);
          image.close();
        },
        toBlob: async () => new Blob(['png'], { type: 'image/png' }),
        dispose: () => {
          h.composite!.disposed = true;
        },
      };
      return composite;
    },
    tabStillActive: async () => true,
    sleep: async (ms) => {
      sleeps.push(ms);
      log.push('sleep');
    },
    onProgress: (p) => progress.push(p),
    tileIntervalMs: 5,
    ...over,
  };
  return h;
}

describe('stitchFullPage', () => {
  it('captures the first tile before hiding fixed elements, paces every tile, restores at the end', async () => {
    const h = harness();
    const result = await stitchFullPage(h.deps);
    expect(h.log).toEqual([
      'begin',
      'sleep',
      'capture',
      'composite:2530x6000',
      'draw:0',
      'hide',
      'scroll:800',
      'sleep',
      'capture',
      'draw:1600',
      'scroll:1600',
      'sleep',
      'capture',
      'draw:3200',
      'scroll:2200',
      'sleep',
      'capture',
      'draw:4800',
      'restore',
    ]);
    expect(result).toMatchObject({
      width: 2530,
      height: 6000,
      truncated: false,
      tiles: 4,
      fixedHidden: 2,
    });
    expect(result.blob.type).toBe('image/png');
    expect(h.composite?.disposed).toBe(true);
  });

  it('crop-composites the clamped last tile instead of appending it', async () => {
    const h = harness();
    await stitchFullPage(h.deps);
    // Asked for 2400, the page stops at 2200: copy rows 200–800 (×2) to 4800–6000.
    expect(h.draws.at(-1)).toEqual({
      sx: 0,
      sy: 400,
      sw: 2530,
      sh: 1200,
      dx: 0,
      dy: 4800,
      dw: 2530,
      dh: 1200,
    });
    // And the composite is exactly full: last draw ends at the canvas bottom.
    const last = h.draws.at(-1)!;
    expect(last.dy + last.dh).toBe(6000);
  });

  it('closes every bitmap, including ones that contribute nothing', async () => {
    // The page collapsed to one viewport after begin(): later scrolls all land on 0.
    const h = harness({ scrollCap: 0 });
    await stitchFullPage(h.deps);
    expect(h.images).toHaveLength(4);
    expect(h.images.every((i) => i.closed)).toBe(true);
    // Tiles 2–4 show rows 0–800 which the plan already has: nothing drawn for them.
    expect(h.draws).toHaveLength(1);
  });

  it('uses the shared pacing constant unless a test shortens it', async () => {
    const h = harness();
    delete (h.deps as { tileIntervalMs?: number }).tileIntervalMs;
    await stitchFullPage(h.deps);
    expect(h.sleeps).toEqual(Array(4).fill(CAPTURE_TILE_INTERVAL_MS));
  });

  it('derives the scale from the first tile, not from the reported devicePixelRatio', async () => {
    const h = harness();
    h.deps.captureViewport = async () => ({
      width: metrics.innerWidth,
      height: metrics.innerHeight,
      close() {},
    });
    const result = await stitchFullPage(h.deps);
    expect(result.width).toBe(1265);
    expect(result.height).toBe(3000);
  });

  it('reports progress from 0 to 100 in tile steps', async () => {
    const h = harness();
    await stitchFullPage(h.deps);
    expect(h.progress).toEqual([0, 25, 50, 75, 100]);
  });

  it('stops at the shared height cap and says so', async () => {
    const h = harness({ pageHeight: 40_000, maxHeightPx: 4000 });
    const result = await stitchFullPage(h.deps);
    // 4000 physical / scale 2 = 2000 CSS px → tiles at 0, 800, 1600 (last is 400 tall).
    expect(result).toMatchObject({ height: 4000, truncated: true, tiles: 3 });
    expect(h.draws.at(-1)).toMatchObject({ dy: 3200, dh: 800 });
    expect(h.log.filter((l) => l === 'capture')).toHaveLength(3);
  });

  it('Esc mid-run cancels, restores the page and disposes the composite', async () => {
    const h = harness();
    let scrolls = 0;
    const scrollTo = h.deps.page.scrollTo;
    h.deps.page.scrollTo = async (y) => {
      scrolls++;
      const r = await scrollTo(y);
      return { ...r, cancelled: scrolls === 2 };
    };
    await expect(stitchFullPage(h.deps)).rejects.toBeInstanceOf(CaptureCancelledError);
    expect(h.log.at(-1)).toBe('restore');
    expect(h.log.filter((l) => l === 'capture')).toHaveLength(2);
    expect(h.composite?.disposed).toBe(true);
    expect(h.images.every((i) => i.closed)).toBe(true);
  });

  it('a tab switch mid-run aborts before capturing the wrong page, and restores', async () => {
    const h = harness();
    let checks = 0;
    h.deps.tabStillActive = async () => ++checks < 3;
    await expect(stitchFullPage(h.deps)).rejects.toThrow(/switched away/);
    expect(h.log.filter((l) => l === 'capture')).toHaveLength(2);
    expect(h.log.at(-1)).toBe('restore');
  });

  it('a throwing capture step still restores the page (finally path)', async () => {
    const h = harness();
    let captures = 0;
    const capture = h.deps.captureViewport;
    h.deps.captureViewport = async () => {
      if (++captures === 3) throw new Error('boom');
      return capture();
    };
    await expect(stitchFullPage(h.deps)).rejects.toThrow('boom');
    expect(h.log.at(-1)).toBe('restore');
    expect(h.composite?.disposed).toBe(true);
    expect(h.images.every((i) => i.closed)).toBe(true);
  });

  it('a failing restore does not mask the original error', async () => {
    const h = harness();
    h.deps.page.hideFixed = async () => {
      throw new Error('original');
    };
    h.deps.page.restore = async () => {
      throw new Error('restore broke too');
    };
    await expect(stitchFullPage(h.deps)).rejects.toThrow('original');
  });

  it('an over-wide page is refused before any canvas is allocated, and the first tile is closed', async () => {
    const h = harness();
    h.deps.page.begin = async () => ({ ...metrics, viewportWidth: 6000, innerWidth: 6000 });
    h.deps.captureViewport = async () => {
      const img = {
        width: 12_000,
        height: 1600,
        closed: false,
        close: () => void (img.closed = true),
      };
      h.images.push(img);
      return img;
    };
    await expect(stitchFullPage(h.deps)).rejects.toThrow(/wide/);
    expect(h.composite).toBeNull();
    expect(h.images[0]?.closed).toBe(true);
    expect(h.log.at(-1)).toBe('restore');
  });
});
