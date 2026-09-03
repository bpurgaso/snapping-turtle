import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
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

// ---- Shared drawing style (S9, S10) -----------------------------------------

/**
 * The red-with-white-outline double-stroke style, defined once so the Fabric
 * editor (web/) and the SVG renderer (server/) cannot drift. The white pass is
 * drawn first at `strokeWidth + 2 * outline`, then red at `strokeWidth` on
 * top - leaving `outline` px of white visible on each side. Text draws a
 * white stroke under a red fill (`paintFirst: 'stroke'` / SVG
 * `paint-order: stroke`).
 *
 * Colors and the font are fixed; every *size* is a function of the capture's
 * width — see `annotationSizes()` below. Nothing outside shared/ may carry a
 * literal stroke or font size (shared/test/style-literals.test.ts enforces it).
 */
export const ANNOTATION_STYLE = {
  red: '#e03131',
  white: '#ffffff',
  /**
   * Both renderers resolve this to the single pinned font file vendored at
   * `shared/fonts/Inter-Regular.ttf` (v4.1, SIL OFL): the editor via
   * @font-face, the server via the fontconfig config in `server/fontconfig/`.
   */
  fontFamily: 'Inter, system-ui, sans-serif',
} as const;

/**
 * Adaptive sizing (§9, E1): annotation sizes scale with the capture's width
 * so they keep the same apparent size on everything from a 300 px region
 * crop to a 10,000 px retina full-page capture. Width alone drives it —
 * viewing is fit-to-width, so width-proportional means constant apparent
 * size, and a tall page must not get giant strokes. Each size is
 *
 *     size(width) = clamp(k · width, min, max)
 *
 * with k = base / referenceWidth, min = base · minScale, max = base · maxScale;
 * i.e. one scale factor `clamp(width / referenceWidth, minScale, maxScale)`
 * multiplies every base size. `base` is what a 1,280 px capture gets (the
 * pre-E1 fixed values, so the reference width renders exactly as before).
 * The floor engages below `minScale · referenceWidth` = 960 px — small crops
 * display at natural size and keep legible strokes; the ceiling engages above
 * `maxScale · referenceWidth` = 7,680 px so extreme widths stop growing.
 * The persisted document never stores any of these: stored `fontSize` stays
 * absolute pixels; only the default for *newly placed* text derives from
 * width. Changing anything here changes the drawn output of an unchanged
 * document: bump RENDER_VERSION and regenerate the parity goldens.
 */
export const ANNOTATION_SIZE_CURVE = {
  referenceWidth: 1280,
  minScale: 0.75,
  maxScale: 6,
  /** Sizes at `referenceWidth`, in image pixels. */
  base: {
    /** Red stroke width for rect and arrow shafts. */
    strokeWidth: 4,
    /** Visible white rim on each side of a red stroke. */
    outline: 2,
    /** Arrowhead: filled triangle, tip at (x2, y2). */
    arrowHeadLength: 22,
    arrowHeadWidth: 18,
    /** White stroke under the red text fill. */
    textStrokeWidth: 4,
    /** Font size given to newly placed text (stored absolute thereafter). */
    defaultFontSize: 28,
  },
} as const;

export type AnnotationSizeName = keyof typeof ANNOTATION_SIZE_CURVE.base;

/** The concrete sizes both renderers draw with for one capture width. */
export interface AnnotationSizes extends Record<AnnotationSizeName, number> {
  /** Full width of the white underlay stroke: strokeWidth + 2 · outline. */
  outerStrokeWidth: number;
}

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The scale factor applied to every base size for a capture `width` px wide:
 * `clamp(width / referenceWidth, minScale, maxScale)`. Exported so the curve
 * can be documented and tested at its boundaries.
 */
export function annotationScale(width: number): number {
  if (!Number.isFinite(width) || width <= 0) throw new Error('annotation scale needs a positive width');
  const c = ANNOTATION_SIZE_CURVE;
  return clamp(width / c.referenceWidth, c.minScale, c.maxScale);
}

/** `clamp(k · width, min, max)` parameters for one size — the curve in the form PLAN.md §9 tabulates. */
export function annotationSizeCurve(name: AnnotationSizeName): { k: number; min: number; max: number } {
  const c = ANNOTATION_SIZE_CURVE;
  const base = c.base[name];
  return { k: base / c.referenceWidth, min: base * c.minScale, max: base * c.maxScale };
}

/**
 * Every drawing size for a capture of the given width, rounded to the schema's
 * two-decimal precision so the Fabric canvas and the SVG overlay receive the
 * identical numbers. Pure and cheap; call it once per capture, not per shape.
 */
export function annotationSizes(width: number): AnnotationSizes {
  const s = annotationScale(width);
  const b = ANNOTATION_SIZE_CURVE.base;
  const strokeWidth = round2(b.strokeWidth * s);
  const outline = round2(b.outline * s);
  return {
    strokeWidth,
    outline,
    outerStrokeWidth: round2(strokeWidth + 2 * outline),
    arrowHeadLength: round2(b.arrowHeadLength * s),
    arrowHeadWidth: round2(b.arrowHeadWidth * s),
    textStrokeWidth: round2(b.textStrokeWidth * s),
    defaultFontSize: round2(b.defaultFontSize * s),
  };
}

/**
 * Version of the flat renderer's *output* for an unchanged document (§10).
 * The flat cache is valid only while the stored render version equals this
 * constant, so bumping it lazily re-renders every capture on its next view
 * with no mass job. Bump it whenever the drawn result of a document changes
 * without the document changing: a size-curve retune, a color, the font,
 * a geometry fix. Rows rendered before versioning existed carry 0.
 */
export const RENDER_VERSION = 1;

/**
 * Fabric.js text-layout constants, pinned here so the M4 SVG renderer can
 * reproduce the editor's text geometry exactly (§10). `lineHeight` is public
 * Fabric API; `fontSizeMult`/`fontSizeFraction` mirror Fabric 6.9.1's private
 * `_fontSizeMult`/`_fontSizeFraction`, which the editor re-asserts on every
 * text object so a Fabric upgrade cannot silently move glyphs. Derived facts
 * (Fabric `_renderTextCommon`/`_renderChars`, dimensions include strokeWidth):
 *
 *   line box height  = fontSize · fontSizeMult · lineHeight   (last line: no lineHeight)
 *   first baseline y = shape.y + strokeWidth/2 + fontSize · fontSizeMult · (1 − fontSizeFraction)
 *   first glyph x    = shape.x + strokeWidth/2
 */
export const ANNOTATION_TEXT_LAYOUT = {
  lineHeight: 1.16,
  fontSizeMult: 1.13,
  fontSizeFraction: 0.222,
} as const;

// ---- Server-side validation on top of the schema (S9) -----------------------

/** Coordinates may overhang the image by this many pixels on every side. */
export const ANNOTATION_BOUNDS_MARGIN_PX = 100;

/**
 * Strip control characters from annotation text (S9): CR/LF normalised to
 * LF, tab and newline kept (multiline text is legitimate), every other
 * C0/C1 control removed. Applied server-side before persisting and mirrored
 * client-side so the editor never even sends them.
 */
export function stripAnnotationControlChars(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
}

const inRange = (v: number, min: number, max: number): boolean => v >= min && v <= max;

/**
 * Bounds check for one shape against the image dimensions +/- margin.
 * Returns a human-readable reason (safe to echo: ids are pattern-limited),
 * or null when the shape fits.
 */
export function annotationBoundsError(
  shape: Shape,
  image: { width: number; height: number },
): string | null {
  const m = ANNOTATION_BOUNDS_MARGIN_PX;
  const okX = (v: number) => inRange(v, -m, image.width + m);
  const okY = (v: number) => inRange(v, -m, image.height + m);
  switch (shape.type) {
    case 'rect':
      if (okX(shape.x) && okY(shape.y) && okX(shape.x + shape.w) && okY(shape.y + shape.h)) {
        return null;
      }
      break;
    case 'arrow':
      if (okX(shape.x1) && okY(shape.y1) && okX(shape.x2) && okY(shape.y2)) return null;
      break;
    case 'text':
      if (okX(shape.x) && okY(shape.y)) return null;
      break;
  }
  return `shape ${shape.id} is outside the image bounds`;
}

export type AnnotationValidation =
  | { ok: true; doc: AnnotationDocument }
  | { ok: false; reason: string };

/**
 * Schema-level check of an untrusted document, with two rules the wire
 * contract fixes independently of the validator library (they changed between
 * TypeBox 0.34 and 1.x, and `test/fixtures/annotation-corpus.ts` pins them):
 *
 * - `maxTextLength` counts UTF-16 code units (`String.length`), which is what
 *   the editor truncates to (`web/src/editor/shapes.ts`) — the server must
 *   never accept a text the editor could not have produced.
 * - a sparse `shapes` array (a hole) is invalid, not "a shape that is skipped";
 *   JSON cannot express one, but in-process callers can.
 *
 * Returns null when the document is valid, else the reason (with the
 * validator's error path where it reports one).
 */
export function annotationSchemaError(input: unknown): string | null {
  if (!Value.Check(AnnotationDocument, input)) {
    const [first] = Value.Errors(AnnotationDocument, input);
    const where = first?.instancePath ? ` at ${first.instancePath}` : '';
    return `invalid annotation document${where}`;
  }
  for (let i = 0; i < input.shapes.length; i++) {
    const shape = input.shapes[i];
    if (!(i in input.shapes) || shape === undefined) {
      return `invalid annotation document at /shapes/${i}`;
    }
    if (shape.type === 'text' && shape.text.length > ANNOTATION_LIMITS.maxTextLength) {
      return `invalid annotation document at /shapes/${i}`;
    }
  }
  return null;
}

/** `annotationSchemaError(input) === null`, as a type guard. */
export function isAnnotationDocument(input: unknown): input is AnnotationDocument {
  return annotationSchemaError(input) === null;
}

/**
 * Full server-side validation of an untrusted annotation document (S9):
 * schema (shape count, text length, finite coordinates, unknown keys),
 * then control-character stripping, then image-bounds checks. The returned
 * document is a sanitised copy - persist that, never the input.
 */
export function validateAnnotationDocument(
  input: unknown,
  image: { width: number; height: number },
): AnnotationValidation {
  const schemaError = annotationSchemaError(input);
  if (schemaError !== null || !isAnnotationDocument(input)) {
    return { ok: false, reason: schemaError ?? 'invalid annotation document' };
  }
  const shapes = input.shapes.map((s) =>
    s.type === 'text' ? { ...s, text: stripAnnotationControlChars(s.text) } : { ...s },
  );
  for (const shape of shapes) {
    const err = annotationBoundsError(shape, image);
    if (err) return { ok: false, reason: err };
  }
  return { ok: true, doc: { version: input.version, rev: input.rev, shapes } };
}
