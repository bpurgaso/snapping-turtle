import {
  ANNOTATION_STYLE as S,
  ANNOTATION_TEXT_LAYOUT as T,
  annotationSizes,
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
