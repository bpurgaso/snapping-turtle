import {
  ANNOTATION_STYLE as S,
  ANNOTATION_TEXT_LAYOUT as T,
  REDACTION_STYLE as R,
  annotationSizes,
  redactionPixelRect,
  type Shape,
  type TextShape,
} from '@snapping-turtle/shared';
import { describe, expect, it } from 'vitest';
import { buildOverlaySvg, escapeXml } from '../../src/images/svg-overlay.js';

const overlay = (shapes: Shape[], width = 480, height = 360): string =>
  buildOverlaySvg({ shapes }, { width, height });

/** The sizes the default 480 px-wide test overlay draws with (floor of the §9 curve: scale 0.75). */
const Z = annotationSizes(480);

const text = (t: string, extra: Partial<TextShape> = {}): TextShape => ({
  id: 't1',
  type: 'text',
  x: 40,
  y: 60,
  text: t,
  fontSize: 28,
  ...extra,
});

describe('escapeXml', () => {
  it('escapes every XML metacharacter', () => {
    expect(escapeXml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('escapes & first so entities are not double-produced', () => {
    expect(escapeXml('&lt;')).toBe('&amp;lt;');
  });
});

describe('annotation text is data, never markup (CLAUDE.md rule 5)', () => {
  it('a closing-tag + script payload never lands unescaped', () => {
    const svg = overlay([text('</text><script>alert(1)</script>')]);
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('</text><script>');
    expect(svg).toContain('&lt;/text&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    // Exactly the one generated <text> element pair, nothing injected.
    expect(svg.match(/<text /g)).toHaveLength(1);
    expect(svg.match(/<\/text>/g)).toHaveLength(1);
  });

  it('quotes cannot break out of attribute or element context', () => {
    const svg = overlay([text(`" onload="x" '`)]);
    expect(svg).toContain('&quot; onload=&quot;x&quot; &#39;');
    expect(svg).not.toContain('"" onload');
  });

  it('ampersands and CDATA terminators are inert', () => {
    const svg = overlay([text('fish & chips ]]> <![CDATA[')]);
    expect(svg).toContain('fish &amp; chips ]]&gt; &lt;![CDATA[');
    expect(svg).not.toContain('<![CDATA[');
  });

  it('pre-escaped-looking input is escaped again, not passed through', () => {
    const svg = overlay([text('&amp; &#x27;')]);
    expect(svg).toContain('&amp;amp; &amp;#x27;');
  });
});

describe('rect geometry', () => {
  it('draws white-under-red at Fabric’s stroke-inclusive position', () => {
    const outer = Z.outerStrokeWidth;
    const svg = overlay([{ id: 'r', type: 'rect', x: 96, y: 72, w: 240, h: 150 }]);
    const rects = svg.match(/<rect [^>]+>/g)!;
    expect(rects).toHaveLength(2);
    // Path sits at x + strokeWidth/2 because Fabric dimensions include stroke.
    for (const r of rects) {
      expect(r).toContain(`x="${96 + outer / 2}"`);
      expect(r).toContain(`y="${72 + outer / 2}"`);
      expect(r).toContain('width="240"');
      expect(r).toContain('fill="none"');
      expect(r).toContain('stroke-linejoin="round"');
    }
    expect(rects[0]).toContain(`stroke="${S.white}"`);
    expect(rects[0]).toContain(`stroke-width="${outer}"`);
    expect(rects[1]).toContain(`stroke="${S.red}"`);
    expect(rects[1]).toContain(`stroke-width="${Z.strokeWidth}"`);
  });

  it('takes every size from annotationSizes(width): floor, reference and ceiling', () => {
    const rect: Shape = { id: 'r', type: 'rect', x: 10, y: 10, w: 50, h: 40 };
    for (const width of [300, 1280, 3200, 10_000]) {
      const z = annotationSizes(width);
      const [white, red] = overlay([rect], width, 200).match(/<rect [^>]+>/g)!;
      expect(white).toContain(`stroke-width="${z.outerStrokeWidth}"`);
      expect(red).toContain(`stroke-width="${z.strokeWidth}"`);
      expect(red).toContain(`x="${10 + z.outerStrokeWidth / 2}"`);
    }
    // Concretely: 3 px red on a 300 px crop, 4 px at 1,280, 24 px at the 10,000 px cap.
    expect(overlay([rect], 300, 200)).toContain('stroke-width="3"/>');
    expect(overlay([rect], 1280, 200)).toContain('stroke-width="4"/>');
    expect(overlay([rect], 10_000, 200)).toContain('stroke-width="24"/>');
  });
});

describe('arrow geometry', () => {
  it('shortens the shaft to the head base and clamps short heads', () => {
    // Horizontal arrow of length 20: head = min(16.5 at this width, 12) = 12.
    expect(Z.arrowHeadLength).toBe(16.5);
    const svg = overlay([{ id: 'a', type: 'arrow', x1: 100, y1: 50, x2: 120, y2: 50 }]);
    const lines = svg.match(/<line [^>]+>/g)!;
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l).toContain('x2="108"'); // 120 - 12
    const paths = svg.match(/<path [^>]+>/g)!;
    expect(paths).toHaveLength(2);
    expect(paths[0]).toContain(`fill="${S.white}"`);
    expect(paths[0]).toContain(`stroke-width="${2 * Z.outline}"`);
    expect(paths[1]).toContain(`fill="${S.red}"`);
    expect(paths[1]).not.toContain('stroke=');
    // Canvas draw order: white shaft, white head, red shaft, red head.
    expect(svg).toMatch(
      new RegExp(
        `<line [^>]*${S.white}[^>]*/><path [^>]*${S.white}[^>]*/>` +
          `<line [^>]*${S.red}[^>]*/><path [^>]*${S.red}[^>]*/>`,
      ),
    );
  });

  it('places head corners perpendicular to the shaft', () => {
    const hw = Z.arrowHeadWidth / 2;
    const base = 200 - Z.arrowHeadLength;
    const svg = overlay([{ id: 'a', type: 'arrow', x1: 0, y1: 100, x2: 200, y2: 100 }]);
    // Full-length head: base at x2 - headLength (183.5 at 480 px), corners at y ± 6.75.
    expect(svg).toContain(`M 200 100 L ${base} ${100 - hw} L ${base} ${100 + hw} Z`);
    // At the 1,280 px reference the pre-E1 numbers come back exactly: 178 and ± 9.
    const ref = overlay([{ id: 'a', type: 'arrow', x1: 0, y1: 100, x2: 200, y2: 100 }], 1280, 360);
    expect(ref).toContain('M 200 100 L 178 91 L 178 109 Z');
  });
});

describe('text geometry', () => {
  it('derives the baseline from the shared Fabric metrics', () => {
    const fs = 28;
    const svg = overlay([text('hello', { fontSize: fs })]);
    const baseline = 60 + Z.textStrokeWidth / 2 + fs * T.fontSizeMult * (1 - T.fontSizeFraction);
    expect(svg).toContain(`y="${Math.round(baseline * 100) / 100}"`);
    expect(svg).toContain(`x="${40 + Z.textStrokeWidth / 2}"`);
    expect(svg).toContain('style="paint-order: stroke"');
    expect(svg).toContain('xml:space="preserve"');
    expect(svg).toContain(`stroke-width="${Z.textStrokeWidth}"`);
  });

  it('keeps the stored fontSize absolute; only the white underlay follows the width', () => {
    // Schema v1: fontSize is pixels as persisted, at every capture width.
    for (const width of [300, 1280, 10_000]) {
      const svg = overlay([text('hi', { fontSize: 28 })], width, 200);
      expect(svg).toContain('font-size="28"');
      expect(svg).toContain(`stroke-width="${annotationSizes(width).textStrokeWidth}"`);
    }
  });

  it('advances lines by fontSize · mult · lineHeight and skips empty lines', () => {
    const fs = 20;
    const svg = overlay([text('a\n\nb', { fontSize: fs })]);
    const els = svg.match(/<text [^>]+>/g)!;
    expect(els).toHaveLength(2); // the blank middle line renders nothing
    const first = 60 + Z.textStrokeWidth / 2 + fs * T.fontSizeMult * (1 - T.fontSizeFraction);
    const advance = fs * T.fontSizeMult * T.lineHeight;
    expect(els[0]).toContain(`y="${Math.round(first * 100) / 100}"`);
    expect(els[1]).toContain(`y="${Math.round((first + 2 * advance) * 100) / 100}"`);
  });
});

describe('buildOverlaySvg envelope', () => {
  it('sizes the overlay to the image, 1:1', () => {
    const svg = overlay([], 800, 600);
    expect(svg).toContain('width="800" height="600" viewBox="0 0 800 600"');
  });

  it('rejects invalid dimensions and non-finite coordinates', () => {
    expect(() => overlay([], 0, 100)).toThrow('invalid overlay dimensions');
    const bad = { id: 'r', type: 'rect', x: Number.NaN, y: 0, w: 10, h: 10 } as Shape;
    expect(() => overlay([bad])).toThrow('non-finite');
  });
});

describe('crop viewport (E4, §10)', () => {
  const shapes: Shape[] = [
    { id: 'in', type: 'rect', x: 120, y: 120, w: 100, h: 60 },
    { id: 'straddle', type: 'rect', x: 20, y: 20, w: 200, h: 200 },
  ];
  const crop = { x: 100, y: 100, w: 300, h: 200 };

  it('without a crop the SVG is image-sized with the identity viewBox (pre-E4 output)', () => {
    const svg = buildOverlaySvg({ shapes }, { width: 1280, height: 720 });
    expect(svg).toContain('width="1280" height="720" viewBox="0 0 1280 720"');
  });

  it('with a crop the SVG is crop-sized and its viewBox is the crop rect — shapes keep original coordinates', () => {
    const svg = buildOverlaySvg({ shapes, crop }, { width: 1280, height: 720 });
    expect(svg).toContain('width="300" height="200" viewBox="100 100 300 200"');
    // The straddling rect is still authored at x=20 (original space): the
    // viewBox clips it; nothing is translated or dropped by the builder.
    expect(svg.match(/<rect /g)).toHaveLength(4);
    const z = annotationSizes(300);
    expect(svg).toContain(`x="${20 + z.outerStrokeWidth / 2}" y="${20 + z.outerStrokeWidth / 2}"`);
  });

  it('sizes come from the effective width: a narrow crop of a wide capture draws the narrow strokes', () => {
    const wide = { width: 2560, height: 1440 };
    const full = buildOverlaySvg({ shapes }, wide);
    const narrow = buildOverlaySvg({ shapes, crop: { x: 0, y: 0, w: 300, h: 200 } }, wide);
    expect(full).toContain(`stroke-width="${annotationSizes(2560).strokeWidth}"`);
    expect(narrow).toContain(`stroke-width="${annotationSizes(300).strokeWidth}"`);
    expect(narrow).not.toContain(`stroke-width="${annotationSizes(2560).strokeWidth}"`);
    expect(annotationSizes(2560).strokeWidth).not.toBe(annotationSizes(300).strokeWidth);
  });

  it('refuses a crop outside the image (defence in depth: validated on write)', () => {
    expect(() =>
      buildOverlaySvg(
        { shapes, crop: { x: 1000, y: 0, w: 300, h: 200 } },
        { width: 1280, height: 720 },
      ),
    ).toThrow(/crop outside the image/);
  });
});

describe('redaction (E9, §9/§10)', () => {
  const block: Shape = { id: 'b1', type: 'redact', x: 100, y: 50, w: 200, h: 80 };

  it('is one opaque crisp-edged rect at the integer pixel rect, with no stroke', () => {
    const svg = overlay([block]);
    const rects = svg.match(/<rect [^>]+>/g)!;
    expect(rects).toHaveLength(1);
    expect(rects[0]).toBe(
      `<rect x="100" y="50" width="200" height="80" fill="${R.fill}" shape-rendering="crispEdges"/>`,
    );
    expect(rects[0]).not.toContain('stroke');
    expect(rects[0]).not.toContain('opacity');
    expect(rects[0]).not.toContain('filter');
  });

  it('is identical at every capture width: no size from the curve touches it', () => {
    const at = (w: number) => overlay([block], w, 200).match(/<rect [^>]+>/g)![0];
    expect(at(300)).toBe(at(1280));
    expect(at(1280)).toBe(at(10_000));
  });

  it('goes through redactionPixelRect: an in-process float block rounds outward', () => {
    // The schema only admits integers, but the renderer does not rely on it.
    const svg = buildOverlaySvg(
      { shapes: [{ ...block, x: 10.4, y: 20.6, w: 30.2, h: 5.1 } as Shape] },
      { width: 480, height: 360 },
    );
    expect(svg).toContain(`<rect x="10" y="20" width="31" height="6" fill="${R.fill}"`);
    expect(svg).toContain(`x="10" y="20" width="31" height="6"`);
    expect(redactionPixelRect({ x: 10.4, y: 20.6, w: 30.2, h: 5.1 })).toEqual({
      x: 10,
      y: 20,
      w: 31,
      h: 6,
    });
  });

  it('draws every block before every other shape whatever the document order', () => {
    const rect: Shape = { id: 'r', type: 'rect', x: 96, y: 72, w: 240, h: 150 };
    const arrow: Shape = { id: 'a', type: 'arrow', x1: 0, y1: 100, x2: 200, y2: 100 };
    const b2: Shape = { id: 'b2', type: 'redact', x: 0, y: 0, w: 10, h: 10 };
    const svg = overlay([rect, block, text('over'), arrow, b2]);
    const inner = svg.slice(svg.indexOf('>') + 1, svg.lastIndexOf('</svg>'));
    const elements = inner.match(/<(rect|line|path|text) [^>]*>/g)!;
    // Two crisp-edged fills first (b1 then b2 — document order within the group),
    // then the rect's white+red pair, the text, and the arrow's four parts.
    expect(elements[0]).toContain(`x="100" y="50" width="200" height="80" fill="${R.fill}"`);
    expect(elements[1]).toContain(`x="0" y="0" width="10" height="10" fill="${R.fill}"`);
    expect(elements.slice(2).some((e) => e.includes(R.fill) && e.includes('crispEdges'))).toBe(
      false,
    );
    expect(elements[2]).toContain(`stroke="${S.white}"`);
    expect(elements[3]).toContain(`stroke="${S.red}"`);
    expect(elements[4]).toMatch(/^<text /);
    expect(elements[5]).toMatch(/^<line /);
    expect(elements).toHaveLength(2 + 2 + 1 + 4);
  });

  it('clips by the crop viewBox like everything else (no special casing)', () => {
    const svg = buildOverlaySvg(
      { shapes: [block], crop: { x: 150, y: 60, w: 100, h: 100 } },
      { width: 480, height: 360 },
    );
    expect(svg).toContain('viewBox="150 60 100 100"');
    expect(svg).toContain(`<rect x="100" y="50" width="200" height="80" fill="${R.fill}"`);
  });
});
