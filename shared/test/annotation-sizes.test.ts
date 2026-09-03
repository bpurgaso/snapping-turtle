import { describe, expect, it } from 'vitest';
import {
  ANNOTATION_LIMITS,
  ANNOTATION_SIZE_CURVE,
  MAX_IMAGE_WIDTH_PX,
  RENDER_VERSION,
  annotationScale,
  annotationSizeCurve,
  annotationSizes,
  type AnnotationSizes,
} from '../src/index.js';

/**
 * The adaptive sizing curve (§9, E1), pinned at the widths that matter: a
 * ~300 px region crop (floor engaged), the 1,280 px reference (exactly the
 * pre-E1 fixed sizes), a 3,200 px retina capture (proportional region) and
 * the 10,000 px ingest width cap (ceiling engaged). The table below is the
 * one PLAN.md §9 documents; change both together.
 */
const sizes = (
  strokeWidth: number,
  outline: number,
  arrowHeadLength: number,
  arrowHeadWidth: number,
  textStrokeWidth: number,
  defaultFontSize: number,
): AnnotationSizes => ({
  strokeWidth,
  outline,
  outerStrokeWidth: strokeWidth + 2 * outline,
  arrowHeadLength,
  arrowHeadWidth,
  textStrokeWidth,
  defaultFontSize,
});

const TABLE: Array<[width: number, scale: number, expected: AnnotationSizes]> = [
  [300, 0.75, sizes(3, 1.5, 16.5, 13.5, 3, 21)], // floor: a region crop at natural size
  [640, 0.75, sizes(3, 1.5, 16.5, 13.5, 3, 21)], // still on the floor
  [960, 0.75, sizes(3, 1.5, 16.5, 13.5, 3, 21)], // floor boundary
  [1280, 1, sizes(4, 2, 22, 18, 4, 28)], // reference: the pre-E1 fixed values
  [1920, 1.5, sizes(6, 3, 33, 27, 6, 42)],
  [2560, 2, sizes(8, 4, 44, 36, 8, 56)], // 1,280 CSS px at 2× DPR
  [3200, 2.5, sizes(10, 5, 55, 45, 10, 70)],
  [5120, 4, sizes(16, 8, 88, 72, 16, 112)],
  [7680, 6, sizes(24, 12, 132, 108, 24, 168)], // ceiling boundary
  [10_000, 6, sizes(24, 12, 132, 108, 24, 168)], // ceiling: the ingest width cap
];

describe('annotationSizes(width) — the §9 curve', () => {
  it.each(TABLE)('width %i → scale %s', (width, scale, expected) => {
    expect(annotationScale(width)).toBeCloseTo(scale, 10);
    expect(annotationSizes(width)).toEqual(expected);
  });

  it('the reference width reproduces the fixed pre-E1 sizes exactly', () => {
    expect(annotationSizes(ANNOTATION_SIZE_CURVE.referenceWidth)).toEqual({
      ...ANNOTATION_SIZE_CURVE.base,
      outerStrokeWidth: 8,
    });
  });

  it('floor and ceiling engage at minScale·reference and maxScale·reference', () => {
    const { referenceWidth: ref, minScale, maxScale } = ANNOTATION_SIZE_CURVE;
    expect(minScale * ref).toBe(960);
    expect(maxScale * ref).toBe(7680);
    expect(annotationScale(1)).toBe(minScale);
    expect(annotationScale(minScale * ref - 1)).toBe(minScale);
    expect(annotationScale(minScale * ref + 64)).toBeGreaterThan(minScale);
    expect(annotationScale(maxScale * ref - 64)).toBeLessThan(maxScale);
    expect(annotationScale(maxScale * ref + 1)).toBe(maxScale);
    expect(annotationScale(MAX_IMAGE_WIDTH_PX)).toBe(maxScale);
  });

  it('is monotonic non-decreasing in width and every size stays positive', () => {
    let prev = annotationSizes(1);
    for (let w = 2; w <= MAX_IMAGE_WIDTH_PX; w += 97) {
      const cur = annotationSizes(w);
      for (const k of Object.keys(cur) as Array<keyof AnnotationSizes>) {
        expect(cur[k]).toBeGreaterThan(0);
        expect(cur[k]).toBeGreaterThanOrEqual(prev[k]);
      }
      prev = cur;
    }
  });

  it('expresses each size as clamp(k · width, min, max)', () => {
    for (const name of Object.keys(ANNOTATION_SIZE_CURVE.base) as Array<
      keyof typeof ANNOTATION_SIZE_CURVE.base
    >) {
      const { k, min, max } = annotationSizeCurve(name);
      for (const w of [300, 1280, 3200, 10_000]) {
        const direct = Math.min(max, Math.max(min, k * w));
        expect(annotationSizes(w)[name]).toBeCloseTo(direct, 2);
      }
    }
    // The documented slope: 1 px of red stroke per 320 px of image width.
    expect(annotationSizeCurve('strokeWidth')).toEqual({ k: 4 / 1280, min: 3, max: 24 });
  });

  it('the derived default font size always satisfies the wire schema', () => {
    // Stored fontSize stays absolute pixels (schema version 1, unchanged);
    // the default must be storable at every width.
    for (const w of [1, 300, 1280, 3200, 10_000]) {
      const fs = annotationSizes(w).defaultFontSize;
      expect(fs).toBeGreaterThanOrEqual(ANNOTATION_LIMITS.minFontSize);
      expect(fs).toBeLessThanOrEqual(ANNOTATION_LIMITS.maxFontSize);
    }
  });

  it('rejects widths that are not positive finite numbers', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => annotationSizes(bad)).toThrow('positive width');
    }
  });

  it('RENDER_VERSION is a positive integer (0 marks pre-versioning renders)', () => {
    expect(Number.isInteger(RENDER_VERSION)).toBe(true);
    expect(RENDER_VERSION).toBeGreaterThanOrEqual(1);
  });
});
