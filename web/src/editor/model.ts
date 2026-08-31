import type { ArrowShape, RectShape, Shape, TextShape } from '@snapping-turtle/shared/annotations';

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

/** CSPRNG-backed id; matches the schema's [A-Za-z0-9_-] pattern (rule 1). */
export function newShapeId(): string {
  return crypto.randomUUID();
}

export type { Shape };
