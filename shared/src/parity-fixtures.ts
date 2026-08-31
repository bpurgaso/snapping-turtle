import { ANNOTATION_SCHEMA_VERSION } from './constants.js';
import type { AnnotationDocument, Shape } from './annotations.js';

/**
 * Fixture annotation documents for the M4 render-parity tests (§10). Consumed
 * by both sides of the contract — web/test/parity diffs the Fabric canvas
 * against the server composite, and server/test keeps golden PNGs of the SVG
 * path alone. Test data only: nothing in the runtime packages imports this
 * module (it has its own export subpath), so it never reaches a bundle.
 *
 * Keep fixtures deterministic and integral-coordinate where possible; the
 * schema stores two-decimal values and both renderers must agree on them.
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
}

const doc = (shapes: Shape[]): Shape[] => shapes;

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
];

export function fixtureDocument(f: ParityFixture): AnnotationDocument {
  return { version: ANNOTATION_SCHEMA_VERSION, rev: 1, shapes: f.shapes };
}
