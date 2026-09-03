import { ANNOTATION_SCHEMA_VERSION } from './constants.js';
import { annotationSizes, type AnnotationDocument, type Shape } from './annotations.js';

/**
 * Fixture annotation documents for the M4 render-parity tests (§10). Consumed
 * by both sides of the contract — web/test/parity diffs the Fabric canvas
 * against the server composite, and server/test keeps golden PNGs of the SVG
 * path alone. Test data only: nothing in the runtime packages imports this
 * module (it has its own export subpath), so it never reaches a bundle.
 *
 * Keep fixtures deterministic and integral-coordinate where possible; the
 * schema stores two-decimal values and both renderers must agree on them.
 *
 * The first six fixtures are 480 px wide (on the §9 curve's floor, scale
 * 0.75) and cover geometry and escaping; `matrixFixtures()` adds one fixture
 * per shape type at each PARITY_WIDTHS entry so the adaptive sizes are
 * proven at the floor, the reference, a proportional width and the ceiling.
 */

export interface ParityFixture {
  name: string;
  width: number;
  height: number;
  /** Neutral background both renderers paint before the shapes. */
  background: string;
  shapes: Shape[];
  /** True when glyph rendering dominates the diff (looser pixel tolerance). */
  hasText: boolean;
  /**
   * Clamp proof (§9 E1): a vertical probe through a rect's top edge where a
   * renderer must paint exactly `px` consecutive non-background pixels — the
   * full white-under-red band, `annotationSizes(width).outerStrokeWidth`.
   * Both renderers are measured against it, so the floor and ceiling are
   * proven on real pixels, not just on the function.
   */
  strokeBand?: { x: number; yFrom: number; yTo: number; px: number };
}

const doc = (shapes: Shape[]): Shape[] => shapes;

/**
 * Width matrix for the adaptive-sizing fixtures (§9 E1): the floor (a region
 * crop), the reference width (exactly the pre-E1 sizes), a retina full-page
 * width in the proportional region, and the ingest width cap on the ceiling.
 */
export const PARITY_WIDTHS = [
  { tag: 'w300', width: 300, height: 220, region: 'floor' },
  { tag: 'w1280', width: 1280, height: 720, region: 'reference' },
  { tag: 'w3200', width: 3200, height: 600, region: 'proportional' },
  { tag: 'w10000', width: 10_000, height: 900, region: 'ceiling' },
] as const;

const BG = '#e9edf2';
const r = Math.round;

/** One fixture per shape type per width, geometry placed by fraction of the image. */
function matrixFixtures(): ParityFixture[] {
  const out: ParityFixture[] = [];
  for (const { tag, width: w, height: h } of PARITY_WIDTHS) {
    const z = annotationSizes(w);
    const rect: Shape = { id: 'r1', type: 'rect', x: r(0.1 * w), y: r(0.15 * h), w: r(0.5 * w), h: r(0.5 * h) };
    out.push({
      name: `rect-${tag}`,
      width: w,
      height: h,
      background: BG,
      hasText: false,
      shapes: doc([rect]),
      // Probe the middle of the top edge: the band starts at the shape's y
      // (Fabric boxes include the stroke) and is outerStrokeWidth tall.
      strokeBand: { x: rect.x + r(rect.w / 2), yFrom: rect.y - 4, yTo: rect.y + z.outerStrokeWidth + 4, px: z.outerStrokeWidth },
    });
    out.push({
      name: `arrow-${tag}`,
      width: w,
      height: h,
      background: BG,
      hasText: false,
      shapes: doc([
        // Long diagonal: full head. Short: exercises the len·0.6 head clamp at the small widths.
        { id: 'a1', type: 'arrow', x1: r(0.1 * w), y1: r(0.85 * h), x2: r(0.8 * w), y2: r(0.15 * h) },
        { id: 'a2', type: 'arrow', x1: r(0.25 * w), y1: r(0.15 * h), x2: r(0.28 * w), y2: r(0.15 * h + 0.03 * w) },
      ]),
    });
    out.push({
      name: `text-${tag}`,
      width: w,
      height: h,
      background: BG,
      hasText: true,
      shapes: doc([
        // What the editor places by default at this width, and a user-resized copy (fontSize stays absolute).
        { id: 't1', type: 'text', x: r(0.1 * w), y: r(0.15 * h), text: 'Look here!', fontSize: z.defaultFontSize },
        { id: 't2', type: 'text', x: r(0.1 * w), y: r(0.35 * h), text: 'two\nlines', fontSize: r(1.3 * z.defaultFontSize) },
      ]),
    });
  }
  return out;
}

export const PARITY_FIXTURES: ParityFixture[] = [
  {
    name: 'rect',
    width: 480,
    height: 360,
    background: '#e9edf2',
    hasText: false,
    shapes: doc([{ id: 'r1', type: 'rect', x: 96, y: 72, w: 240, h: 150 }]),
  },
  {
    name: 'arrow',
    width: 480,
    height: 360,
    background: '#e9edf2',
    hasText: false,
    shapes: doc([
      // Long diagonal: full 22 px head. Short: exercises the len·0.6 head clamp.
      { id: 'a1', type: 'arrow', x1: 60, y1: 300, x2: 380, y2: 80 },
      { id: 'a2', type: 'arrow', x1: 120, y1: 60, x2: 145, y2: 82 },
    ]),
  },
  {
    name: 'text',
    width: 480,
    height: 360,
    background: '#e9edf2',
    hasText: true,
    shapes: doc([
      { id: 't1', type: 'text', x: 48, y: 60, text: 'Look here!', fontSize: 28 },
      { id: 't2', type: 'text', x: 48, y: 160, text: 'two\nlines', fontSize: 36 },
    ]),
  },
  {
    name: 'text-special-chars',
    width: 480,
    height: 360,
    background: '#e9edf2',
    hasText: true,
    shapes: doc([
      {
        id: 't1',
        type: 'text',
        x: 24,
        y: 48,
        text: '</text><script>alert(1)</script>',
        fontSize: 24,
      },
      { id: 't2', type: 'text', x: 24, y: 140, text: `& "double" 'single' ]]>`, fontSize: 24 },
      { id: 't3', type: 'text', x: 24, y: 230, text: '<![CDATA[ &amp; &#x27;', fontSize: 24 },
    ]),
  },
  {
    name: 'combined',
    width: 480,
    height: 360,
    background: '#dde3ea',
    hasText: true,
    shapes: doc([
      { id: 'c1', type: 'rect', x: 60, y: 90, w: 220, h: 140 },
      { id: 'c2', type: 'arrow', x1: 420, y1: 40, x2: 300, y2: 140 },
      { id: 'c3', type: 'text', x: 90, y: 250, text: 'overlap & order', fontSize: 30 },
    ]),
  },
  {
    name: 'edges',
    width: 480,
    height: 360,
    background: '#e9edf2',
    hasText: false,
    shapes: doc([
      // Overhangs are legal within ANNOTATION_BOUNDS_MARGIN_PX; both renderers
      // must clip identically at the image border.
      { id: 'e1', type: 'rect', x: -40, y: -40, w: 160, h: 120 },
      { id: 'e2', type: 'rect', x: 400, y: 300, w: 140, h: 120 },
      { id: 'e3', type: 'arrow', x1: 240, y1: 400, x2: 240, y2: 180 },
      { id: 'e4', type: 'arrow', x1: -20, y1: 180, x2: 200, y2: 340 },
    ]),
  },
  ...matrixFixtures(),
];

export function fixtureDocument(f: ParityFixture): AnnotationDocument {
  return { version: ANNOTATION_SCHEMA_VERSION, rev: 1, shapes: f.shapes };
}
