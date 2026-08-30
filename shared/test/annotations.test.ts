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
