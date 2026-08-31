import {
  ANNOTATION_STYLE as S,
  ANNOTATION_TEXT_LAYOUT as T,
  type AnnotationDocument,
  type ArrowShape,
  type RectShape,
  type Shape,
  type TextShape,
} from '@snapping-turtle/shared';

/**
 * SVG overlay renderer (PLAN.md §10): a pure function from an annotation
 * document plus image dimensions to an SVG string, drawn to match the Fabric
 * editor stroke for stroke. Every geometric rule here mirrors a verified
 * Fabric 6.9.1 behavior (see web/src/editor/shapes.ts and
 * ANNOTATION_TEXT_LAYOUT in shared/): rect and text boxes include their
 * strokeWidth, so paths sit at +strokeWidth/2; arrows draw at absolute
 * endpoint coordinates; element order is exactly canvas draw order.
 *
 * Annotation text is data, never markup (CLAUDE.md rule 5): everything
 * interpolated into the SVG goes through xml escaping, and numbers are
 * re-validated as finite even though M3 validates on write.
 */

/** Full width of the white underlay stroke (kept in step with shapes.ts). */
const OUTER = S.strokeWidth + 2 * S.outline;

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch] as string);
}

/** Serialize a coordinate: finite, at most 2 decimals (schema precision). */
function num(n: number): string {
  if (!Number.isFinite(n)) throw new Error('non-finite coordinate in annotation document');
  return String(Math.round(n * 100) / 100);
}

function rectSvg(s: RectShape): string {
  // Fabric positions the w×h path at left + strokeWidth/2 (dimensions include
  // the stroke); white pass first at OUTER, red on top, both round-joined.
  const attrs =
    `x="${num(s.x + OUTER / 2)}" y="${num(s.y + OUTER / 2)}" ` +
    `width="${num(s.w)}" height="${num(s.h)}" fill="none" stroke-linejoin="round"`;
  return (
    `<rect ${attrs} stroke="${S.white}" stroke-width="${OUTER}"/>` +
    `<rect ${attrs} stroke="${S.red}" stroke-width="${S.strokeWidth}"/>`
  );
}

function arrowSvg(s: ArrowShape): string {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const headLen = Math.min(S.arrowHeadLength, len * 0.6);
  const bx = s.x2 - ux * headLen;
  const by = s.y2 - uy * headLen;
  const hw = S.arrowHeadWidth / 2;

  const shaft = (color: string, width: number): string =>
    `<line x1="${num(s.x1)}" y1="${num(s.y1)}" x2="${num(bx)}" y2="${num(by)}" ` +
    `stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`;
  const headPath =
    `M ${num(s.x2)} ${num(s.y2)} ` +
    `L ${num(bx + uy * hw)} ${num(by - ux * hw)} ` +
    `L ${num(bx - uy * hw)} ${num(by + ux * hw)} Z`;

  // Canvas draw order: white shaft, white head (fill + stroke widens it by
  // 2·outline), red shaft over the head base, red head fill only.
  return (
    shaft(S.white, OUTER) +
    `<path d="${headPath}" fill="${S.white}" stroke="${S.white}" ` +
    `stroke-width="${2 * S.outline}" stroke-linejoin="round" stroke-linecap="round"/>` +
    shaft(S.red, S.strokeWidth) +
    `<path d="${headPath}" fill="${S.red}"/>`
  );
}

function textSvg(s: TextShape): string {
  const fs = s.fontSize;
  const lineBox = fs * T.fontSizeMult;
  const lineAdvance = lineBox * T.lineHeight;
  const x = num(s.x + S.textStrokeWidth / 2);
  const firstBaseline = s.y + S.textStrokeWidth / 2 + lineBox * (1 - T.fontSizeFraction);
  const lines = s.text.split('\n');
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line === '') continue; // empty lines only advance the baseline
    out +=
      `<text x="${x}" y="${num(firstBaseline + i * lineAdvance)}" ` +
      `font-family="${escapeXml(S.fontFamily)}" font-size="${num(fs)}" ` +
      `fill="${S.red}" stroke="${S.white}" stroke-width="${S.textStrokeWidth}" ` +
      `style="paint-order: stroke" xml:space="preserve">${escapeXml(line)}</text>`;
  }
  return out;
}

function shapeSvg(s: Shape): string {
  switch (s.type) {
    case 'rect':
      return rectSvg(s);
    case 'arrow':
      return arrowSvg(s);
    case 'text':
      return textSvg(s);
  }
}

/**
 * Build the transparent overlay for one annotation document. The width and
 * height come from the capture row, never from the document, so the overlay
 * always rasterizes 1:1 onto the original for `sharp().composite()`.
 */
export function buildOverlaySvg(
  doc: Pick<AnnotationDocument, 'shapes'>,
  image: { width: number; height: number },
): string {
  const w = Math.trunc(image.width);
  const h = Math.trunc(image.height);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
    throw new Error('invalid overlay dimensions');
  }
  const body = doc.shapes.map(shapeSvg).join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" ` +
    `viewBox="0 0 ${w} ${h}">${body}</svg>`
  );
}
