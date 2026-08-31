import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import {
  ANNOTATION_LIMITS,
  ANNOTATION_SCHEMA_VERSION,
  AnnotationDocument,
  emptyAnnotationDocument,
  type Shape,
} from '../src/index.js';

const rect: Shape = { id: 'a1', type: 'rect', x: 120, y: 80, w: 300, h: 140 };
const arrow: Shape = { id: 'a2', type: 'arrow', x1: 40, y1: 400, x2: 210, y2: 260 };
const text: Shape = { id: 'a3', type: 'text', x: 500, y: 60, text: 'look here', fontSize: 28 };

describe('AnnotationDocument schema', () => {
  it('accepts the PLAN.md §9 example document', () => {
    const doc = { version: 1, rev: 12, shapes: [rect, arrow, text] };
    expect(Value.Check(AnnotationDocument, doc)).toBe(true);
  });

  it('accepts an empty document at rev 0', () => {
    expect(Value.Check(AnnotationDocument, emptyAnnotationDocument())).toBe(true);
    expect(emptyAnnotationDocument().version).toBe(ANNOTATION_SCHEMA_VERSION);
  });

  it('rejects more than the maximum number of shapes', () => {
    const shapes = Array.from({ length: ANNOTATION_LIMITS.maxShapes + 1 }, (_, i) => ({
      ...rect,
      id: `r${i}`,
    }));
    expect(Value.Check(AnnotationDocument, { version: 1, rev: 0, shapes })).toBe(false);
    expect(
      Value.Check(AnnotationDocument, { version: 1, rev: 0, shapes: shapes.slice(0, -1) }),
    ).toBe(true);
  });

  it('rejects text longer than the per-shape cap', () => {
    const tooLong = { ...text, text: 'x'.repeat(ANNOTATION_LIMITS.maxTextLength + 1) };
    expect(Value.Check(AnnotationDocument, { version: 1, rev: 0, shapes: [tooLong] })).toBe(false);
  });

  it('rejects unknown shape types, unknown keys and negative sizes', () => {
    const bad = (shape: unknown) =>
      Value.Check(AnnotationDocument, { version: 1, rev: 0, shapes: [shape] });
    expect(bad({ id: 'z', type: 'ellipse', x: 0, y: 0, w: 1, h: 1 })).toBe(false);
    expect(bad({ ...rect, onclick: 'alert(1)' })).toBe(false);
    expect(bad({ ...rect, w: -5 })).toBe(false);
    expect(bad({ ...text, fontSize: 0 })).toBe(false);
  });

  it('rejects the wrong schema version, non-integer revs and non-finite numbers', () => {
    expect(Value.Check(AnnotationDocument, { version: 2, rev: 0, shapes: [] })).toBe(false);
    expect(Value.Check(AnnotationDocument, { version: 1, rev: 1.5, shapes: [] })).toBe(false);
    expect(Value.Check(AnnotationDocument, { version: 1, rev: -1, shapes: [] })).toBe(false);
    expect(
      Value.Check(AnnotationDocument, { version: 1, rev: 0, shapes: [{ ...rect, x: NaN }] }),
    ).toBe(false);
  });

  it('rejects shape ids that are empty or contain markup-capable characters', () => {
    const bad = (id: string) =>
      Value.Check(AnnotationDocument, { version: 1, rev: 0, shapes: [{ ...rect, id }] });
    expect(bad('')).toBe(false);
    expect(bad('<img>')).toBe(false);
    expect(bad('ok_id-1')).toBe(true);
  });
});

// ---- M3 additions: bounds, control characters, full validation (S9) ---------

import {
  ANNOTATION_BOUNDS_MARGIN_PX,
  ANNOTATION_STYLE,
  MAX_ANNOTATION_DOC_BYTES,
  annotationBoundsError,
  stripAnnotationControlChars,
  validateAnnotationDocument,
} from '../src/index.js';

const IMG = { width: 800, height: 600 };
const M = ANNOTATION_BOUNDS_MARGIN_PX;
const doc = (shapes: unknown[]) => ({ version: 1, rev: 3, shapes });

describe('stripAnnotationControlChars', () => {
  it('keeps newlines and tabs, normalises CRLF, strips other controls', () => {
    expect(stripAnnotationControlChars('a\r\nb\rc')).toBe('a\nb\nc');
    expect(stripAnnotationControlChars('keep\nthis\tone')).toBe('keep\nthis\tone');
    expect(stripAnnotationControlChars('a\u0000b\u0007c\u001bd\u007fe\u009bf')).toBe('abcdef');
    expect(stripAnnotationControlChars('plain')).toBe('plain');
  });
});

describe('annotationBoundsError', () => {
  it('accepts shapes inside the image and within the margin', () => {
    expect(annotationBoundsError(rect, IMG)).toBeNull();
    expect(annotationBoundsError({ ...rect, x: -M, y: -M }, IMG)).toBeNull();
    expect(
      annotationBoundsError({ ...rect, x: IMG.width + M - 1, y: 0, w: 1, h: 1 }, IMG),
    ).toBeNull();
    expect(annotationBoundsError(arrow, IMG)).toBeNull();
    expect(
      annotationBoundsError({ ...arrow, x2: IMG.width + M, y2: IMG.height + M }, IMG),
    ).toBeNull();
    expect(annotationBoundsError({ ...text, x: -M, y: IMG.height + M }, IMG)).toBeNull();
  });

  it('rejects each shape type beyond the margin, naming the shape id', () => {
    expect(annotationBoundsError({ ...rect, x: -M - 1 }, IMG)).toBe(
      'shape a1 is outside the image bounds',
    );
    // a rect whose far edge overhangs too much is out even when x/y are fine
    expect(annotationBoundsError({ ...rect, x: IMG.width, w: M + 1, h: 10 }, IMG)).toMatch(
      /outside the image bounds/,
    );
    expect(annotationBoundsError({ ...arrow, x1: IMG.width + M + 1 }, IMG)).toMatch(/a2/);
    expect(annotationBoundsError({ ...text, y: -M - 0.5 }, IMG)).toMatch(/a3/);
  });
});

describe('validateAnnotationDocument', () => {
  it('accepts a valid document and returns a sanitised copy', () => {
    const dirty = { ...text, text: 'look\u0000 here\r\nplease' };
    const res = validateAnnotationDocument(doc([rect, arrow, dirty]), IMG);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.doc.rev).toBe(3);
      expect(res.doc.shapes[2]).toEqual({ ...text, text: 'look here\nplease' });
      // sanitised copy, not the input object
      expect(res.doc.shapes[0]).not.toBe(rect);
    }
  });

  it('rejects schema violations: shape count, text length, bad types', () => {
    const many = Array.from({ length: ANNOTATION_LIMITS.maxShapes + 1 }, (_, i) => ({
      ...rect,
      id: `r${i}`,
    }));
    expect(validateAnnotationDocument(doc(many), IMG).ok).toBe(false);
    const long = { ...text, text: 'x'.repeat(ANNOTATION_LIMITS.maxTextLength + 1) };
    expect(validateAnnotationDocument(doc([long]), IMG).ok).toBe(false);
    expect(validateAnnotationDocument(doc([{ id: 'e', type: 'ellipse' }]), IMG).ok).toBe(false);
    expect(validateAnnotationDocument('nonsense', IMG).ok).toBe(false);
    expect(validateAnnotationDocument(null, IMG).ok).toBe(false);
  });

  it('rejects out-of-bounds coordinates with the shape id in the reason', () => {
    const res = validateAnnotationDocument(doc([{ ...arrow, y2: IMG.height + M + 1 }]), IMG);
    expect(res).toEqual({ ok: false, reason: 'shape a2 is outside the image bounds' });
  });

  it('exposes coherent style and size constants for both renderers', () => {
    expect(ANNOTATION_STYLE.strokeWidth + 2 * ANNOTATION_STYLE.outline).toBe(8);
    expect(MAX_ANNOTATION_DOC_BYTES).toBeGreaterThan(1024 * 1024);
  });
});
