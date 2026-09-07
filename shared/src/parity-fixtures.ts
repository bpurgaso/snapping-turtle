import { ANNOTATION_SCHEMA_VERSION } from './constants.js';
import {
  annotationSizes,
  effectiveWidth,
  type AnnotationDocument,
  type CropRect,
  type Shape,
} from './annotations.js';

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
 * proven at the floor, the reference, a proportional width and the ceiling;
 * `cropFixtures()` (E4) adds the crop viewport: the same document with and
 * without a narrow crop (the sizes must follow the *effective* width, §9),
 * and shapes inside, outside and straddling the crop edge (the clip must be
 * identical in both renderers). A fixture with `crop` renders `crop.w × crop.h`.
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
   * Crop viewport (E4): shapes stay in original coordinates; both renderers
   * output exactly this rect, drawn with `annotationSizes(crop.w)`. The
   * `strokeBand` probe, when present, is in *output* (cropped) coordinates.
   */
  crop?: CropRect;
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

/**
 * Crop fixtures (E4). `crop-none` and `crop-narrow` are one document — a
 * 1,280 px capture (reference sizes) with a rect, an arrow and a text at the
 * stored default size — rendered once whole and once through a 300 px crop:
 * the stroke-band probes promise 8 px whole and 6 px cropped (the §9 floor),
 * on both renderers, so the effective-width rule is proven on pixels rather
 * than in the function. `crop-clip` puts a rect fully inside, one fully
 * outside, one straddling each of two edges, an arrow entering from outside
 * and a text run leaving through the right edge. `crop-only` (E6) is the
 * fourth state of the served-image matrix — a crop with *no* shapes — so the
 * renderer's extract-without-composite branch has a golden and a parity
 * fixture like every other branch: an unannotated cropped capture must
 * come out crop-sized, never as the untouched original (§10).
 */
function cropFixtures(): ParityFixture[] {
  const width = 1280;
  const height = 720;
  const crop: CropRect = { x: 400, y: 200, w: 300, h: 220 };
  const rect: Shape = { id: 'r1', type: 'rect', x: 430, y: 230, w: 160, h: 90 };
  const shared: Shape[] = [
    rect,
    { id: 'a1', type: 'arrow', x1: 440, y1: 400, x2: 660, y2: 340 },
    { id: 't1', type: 'text', x: 450, y: 335, text: 'Crop me', fontSize: annotationSizes(width).defaultFontSize },
  ];
  const probeX = rect.x + r(rect.w / 2);
  const whole = annotationSizes(width);
  const narrow = annotationSizes(effectiveWidth({ width }, crop));
  return [
    {
      name: 'crop-none',
      width,
      height,
      background: BG,
      hasText: true,
      shapes: shared,
      strokeBand: { x: probeX, yFrom: rect.y - 4, yTo: rect.y + whole.outerStrokeWidth + 4, px: whole.outerStrokeWidth },
    },
    {
      name: 'crop-narrow',
      width,
      height,
      background: BG,
      hasText: true,
      shapes: shared,
      crop,
      strokeBand: {
        x: probeX - crop.x,
        yFrom: rect.y - crop.y - 4,
        yTo: rect.y - crop.y + narrow.outerStrokeWidth + 4,
        px: narrow.outerStrokeWidth,
      },
    },
    {
      name: 'crop-clip',
      width,
      height,
      background: BG,
      hasText: true,
      shapes: [
        { id: 'inside', type: 'rect', x: 460, y: 250, w: 120, h: 60 },
        { id: 'outside', type: 'rect', x: 40, y: 40, w: 200, h: 100 },
        { id: 'straddle-left-top', type: 'rect', x: 320, y: 140, w: 200, h: 120 },
        { id: 'straddle-right-bottom', type: 'rect', x: 600, y: 350, w: 200, h: 150 },
        { id: 'arrow-in', type: 'arrow', x1: 200, y1: 600, x2: 520, y2: 380 },
        { id: 'text-out', type: 'text', x: 600, y: 240, text: 'leaving the crop', fontSize: annotationSizes(width).defaultFontSize },
      ],
      crop: { x: 400, y: 200, w: 300, h: 220 },
    },
    {
      name: 'crop-only',
      width,
      height,
      background: BG,
      hasText: false,
      shapes: [],
      crop,
    },
  ];
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
  ...cropFixtures(),
];

/** Output size of a fixture: the crop when it has one (E4), else the image. */
export function fixtureOutputSize(f: ParityFixture): { width: number; height: number } {
  return f.crop ? { width: f.crop.w, height: f.crop.h } : { width: f.width, height: f.height };
}

export function fixtureDocument(f: ParityFixture): AnnotationDocument {
  const doc: AnnotationDocument = { version: ANNOTATION_SCHEMA_VERSION, rev: 1, shapes: f.shapes };
  if (f.crop) doc.crop = f.crop;
  return doc;
}
