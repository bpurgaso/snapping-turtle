import { Type, type Static } from '@sinclair/typebox';
import { ANNOTATION_SCHEMA_VERSION } from './constants.js';

/**
 * Versioned annotation document (PLAN.md §9). This is our own persistence
 * format, deliberately independent of Fabric.js serialization. Both renderers
 * (Fabric in web/, SVG in server/) consume exactly this shape.
 *
 * Schema-level caps (shape count, text length) live here. Image-bound checks
 * and control-character stripping are server-side validation on top of this.
 */

export const ANNOTATION_LIMITS = {
  maxShapes: 500,
  maxTextLength: 2000,
  maxShapeIdLength: 64,
  minFontSize: 4,
  maxFontSize: 512,
} as const;

const Coordinate = Type.Number({ description: 'Image-space pixel coordinate' });
const Length = Type.Number({ minimum: 0, description: 'Image-space pixel length' });

export const ShapeId = Type.String({
  minLength: 1,
  maxLength: ANNOTATION_LIMITS.maxShapeIdLength,
  pattern: '^[A-Za-z0-9_-]+$',
});

export const RectShape = Type.Object(
  {
    id: ShapeId,
    type: Type.Literal('rect'),
    x: Coordinate,
    y: Coordinate,
    w: Length,
    h: Length,
  },
  { additionalProperties: false, $id: 'RectShape' },
);

export const ArrowShape = Type.Object(
  {
    id: ShapeId,
    type: Type.Literal('arrow'),
    /** tail */
    x1: Coordinate,
    y1: Coordinate,
    /** head */
    x2: Coordinate,
    y2: Coordinate,
  },
  { additionalProperties: false, $id: 'ArrowShape' },
);

export const TextShape = Type.Object(
  {
    id: ShapeId,
    type: Type.Literal('text'),
    x: Coordinate,
    y: Coordinate,
    text: Type.String({ maxLength: ANNOTATION_LIMITS.maxTextLength }),
    fontSize: Type.Number({
      minimum: ANNOTATION_LIMITS.minFontSize,
      maximum: ANNOTATION_LIMITS.maxFontSize,
    }),
  },
  { additionalProperties: false, $id: 'TextShape' },
);

export const Shape = Type.Union([RectShape, ArrowShape, TextShape], { $id: 'Shape' });

export const AnnotationDocument = Type.Object(
  {
    version: Type.Literal(ANNOTATION_SCHEMA_VERSION),
    /** Monotonic revision; PUT with a stale rev is rejected with 409 (§9). */
    rev: Type.Integer({ minimum: 0 }),
    shapes: Type.Array(Shape, { maxItems: ANNOTATION_LIMITS.maxShapes }),
  },
  { additionalProperties: false, $id: 'AnnotationDocument' },
);

export type RectShape = Static<typeof RectShape>;
export type ArrowShape = Static<typeof ArrowShape>;
export type TextShape = Static<typeof TextShape>;
export type Shape = Static<typeof Shape>;
export type AnnotationDocument = Static<typeof AnnotationDocument>;

/** An empty document at revision 0 — what a fresh capture starts with. */
export function emptyAnnotationDocument(): AnnotationDocument {
  return { version: ANNOTATION_SCHEMA_VERSION, rev: 0, shapes: [] };
}
