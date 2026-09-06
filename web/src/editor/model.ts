import type { ArrowShape, CropRect, RectShape, Shape, TextShape } from '@snapping-turtle/shared/annotations';
import { MIN_CROP_PX } from '@snapping-turtle/shared/constants';

/**
 * Pure geometry <-> schema mapping (§9). The editor's canvas objects and the
 * persisted JSON meet only through these functions, and the round-trip test
 * in web/test proves the mapping is lossless. Nothing here touches Fabric —
 * the functions work on plain geometry so they run in any test environment.
 */

export interface RectGeom {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ArrowGeom {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface TextGeom {
  left: number;
  top: number;
  text: string;
  fontSize: number;
}

/** Two decimal places: stable JSON without accumulating float noise. */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

export function rectToShape(id: string, g: RectGeom): RectShape {
  return { id, type: 'rect', x: round2(g.left), y: round2(g.top), w: round2(g.width), h: round2(g.height) };
}

export function rectGeom(s: RectShape): RectGeom {
  return { left: s.x, top: s.y, width: s.w, height: s.h };
}

export function arrowToShape(id: string, g: ArrowGeom): ArrowShape {
  return { id, type: 'arrow', x1: round2(g.x1), y1: round2(g.y1), x2: round2(g.x2), y2: round2(g.y2) };
}

export function arrowGeom(s: ArrowShape): ArrowGeom {
  return { x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 };
}

export function textToShape(id: string, g: TextGeom): TextShape {
  return { id, type: 'text', x: round2(g.left), y: round2(g.top), text: g.text, fontSize: round2(g.fontSize) };
}

export function textGeom(s: TextShape): TextGeom {
  return { left: s.x, top: s.y, text: s.text, fontSize: s.fontSize };
}

// ---- Crop viewport (E4) -------------------------------------------------------

export interface CropGeom {
  left: number;
  top: number;
  width: number;
  height: number;
}

const clampInt = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(v)));

/**
 * Turn a dragged or handle-adjusted crop frame into the schema's rect: whole
 * pixels, entirely inside the image, at least MIN_CROP_PX per side (a frame
 * dragged smaller grows to the minimum, pulled back from the image edge if
 * it has to). A negative width or height (a drag that ended up-left of its
 * origin) is normalised like any other. Returns null only when the image
 * itself is smaller than the minimum crop — nothing can be cropped then.
 */
export function normalizeCrop(
  g: CropGeom,
  image: { width: number; height: number },
): CropRect | null {
  if (image.width < MIN_CROP_PX || image.height < MIN_CROP_PX) return null;
  const side = (from: number, size: number, max: number): [number, number] => {
    let a = clampInt(from, 0, max);
    let b = clampInt(from + size, 0, max);
    if (b < a) [a, b] = [b, a];
    let len = b - a;
    if (len < MIN_CROP_PX) {
      len = MIN_CROP_PX;
      a = Math.min(a, max - len);
    }
    return [a, len];
  };
  const [x, w] = side(g.left, g.width, image.width);
  const [y, h] = side(g.top, g.height, image.height);
  return { x, y, w, h };
}

/** A crop covering the whole image is no crop at all: the editor stores none. */
export function isWholeImage(c: CropRect, image: { width: number; height: number }): boolean {
  return c.x === 0 && c.y === 0 && c.w === image.width && c.h === image.height;
}

export function cropGeom(c: CropRect): CropGeom {
  return { left: c.x, top: c.y, width: c.w, height: c.h };
}

/** CSPRNG-backed id; matches the schema's [A-Za-z0-9_-] pattern (rule 1). */
export function newShapeId(): string {
  return crypto.randomUUID();
}

export type { Shape };
