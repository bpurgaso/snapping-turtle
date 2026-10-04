import type { ParityFixture } from '@snapping-turtle/shared/parity-fixtures';

/**
 * Pixel probes shared by the server golden test and web/test/parity's
 * cross-renderer diff (§9 E1 clamp proofs). Works on RGBA buffers as pngjs
 * decodes them.
 */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array | Buffer;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * Count the longest run of consecutive non-background pixels in the column
 * `x` between `yFrom` and `yTo` — for a rect's top edge, that is the full
 * white-under-red stroke band. "Non-background" is any channel more than
 * `tolerance` away from the fixture background; the tolerance is small
 * because the white rim sits only ~20 levels from the light-grey fixture
 * background, and the band edges are integral so no antialiasing smears them.
 */
export function strokeBandPx(
  png: Rgba,
  probe: { x: number; yFrom: number; yTo: number },
  background: string,
  tolerance = 6,
): number {
  const [br, bg, bb] = hexToRgb(background);
  let best = 0;
  let run = 0;
  for (let y = Math.max(0, probe.yFrom); y < Math.min(png.height, probe.yTo); y++) {
    const i = (y * png.width + probe.x) * 4;
    const differs =
      Math.abs(png.data[i]! - br) > tolerance ||
      Math.abs(png.data[i + 1]! - bg) > tolerance ||
      Math.abs(png.data[i + 2]! - bb) > tolerance;
    run = differs ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

/** The band a fixture promises, measured on one render; null when the fixture has no probe. */
export function measuredStrokeBand(png: Rgba, f: ParityFixture): { px: number; expected: number } | null {
  if (!f.strokeBand) return null;
  return { px: strokeBandPx(png, f.strokeBand, f.background), expected: f.strokeBand.px };
}

export interface InkBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Bounding box of every painted pixel (same background test as strokeBandPx); null when nothing is painted. */
export function inkBBox(png: Rgba, background: string, tolerance = 6): InkBox | null {
  const [br, bg, bb] = hexToRgb(background);
  let x0 = png.width;
  let y0 = png.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      if (
        Math.abs(png.data[i]! - br) > tolerance ||
        Math.abs(png.data[i + 1]! - bg) > tolerance ||
        Math.abs(png.data[i + 2]! - bb) > tolerance
      ) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/** Largest per-edge distance between two ink boxes. */
export function inkBoxDelta(a: InkBox, b: InkBox): number {
  return Math.max(Math.abs(a.x0 - b.x0), Math.abs(a.y0 - b.y0), Math.abs(a.x1 - b.x1), Math.abs(a.y1 - b.y1));
}

/** The RGB triple at one pixel; throws outside the image rather than reading garbage. */
export function rgbAt(png: Rgba, x: number, y: number): [number, number, number] {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) {
    throw new Error(`pixel (${x}, ${y}) is outside a ${png.width}×${png.height} image`);
  }
  const i = (y * png.width + x) * 4;
  return [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!];
}

/**
 * Redaction leak probe (E9, §10): the number of pixels inside `rect` (clipped
 * to the image) that are not *exactly* the fill colour — no tolerance, because
 * a pixel in a redaction that is not the fill is a pixel of the original
 * showing through, a privacy bug rather than rasterization noise. A pixel that
 * is not fully opaque is a leak too: a transparent (0, 0, 0, 0) canvas pixel
 * is "nothing painted yet", never the fill. Returns the first offending pixel
 * for the failure message.
 */
export function fillLeakPixels(
  png: Rgba,
  rect: { x: number; y: number; w: number; h: number },
  fillHex: string,
): { leaked: number; sampled: number; first: { x: number; y: number; rgb: [number, number, number] } | null } {
  const [fr, fg, fb] = hexToRgb(fillHex);
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(png.width, rect.x + rect.w);
  const y1 = Math.min(png.height, rect.y + rect.h);
  let leaked = 0;
  let sampled = 0;
  let first: { x: number; y: number; rgb: [number, number, number] } | null = null;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      sampled++;
      const i = (y * png.width + x) * 4;
      const r = png.data[i]!;
      const g = png.data[i + 1]!;
      const b = png.data[i + 2]!;
      const a = png.data[i + 3]!;
      if (r !== fr || g !== fg || b !== fb || a !== 255) {
        leaked++;
        first ??= { x, y, rgb: [r, g, b] };
      }
    }
  }
  return { leaked, sampled, first };
}
