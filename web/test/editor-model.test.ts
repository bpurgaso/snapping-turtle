import type { ArrowShape, RectShape, TextShape } from '@snapping-turtle/shared/annotations';
import { describe, expect, it } from 'vitest';
import {
  arrowGeom,
  arrowToShape,
  newShapeId,
  rectGeom,
  rectToShape,
  round2,
  textGeom,
  textToShape,
} from '../src/editor/model.js';

/**
 * The persistence round trip (§9): our JSON -> editor geometry -> our JSON
 * must be lossless. These are the exact functions the canvas objects use, so
 * a drift here is a drift in what gets saved.
 */
describe('editor geometry round trip', () => {
  const rect: RectShape = { id: 'r1', type: 'rect', x: 120.25, y: 80.5, w: 300, h: 140.75 };
  const arrow: ArrowShape = { id: 'a1', type: 'arrow', x1: 40, y1: 400.2, x2: 210.4, y2: 260 };
  const text: TextShape = {
    id: 't1',
    type: 'text',
    x: 500,
    y: 60.31,
    text: 'look\nhere — twice',
    fontSize: 28.5,
  };

  it('rect survives shape -> geom -> shape', () => {
    expect(rectToShape(rect.id, rectGeom(rect))).toEqual(rect);
  });

  it('arrow survives shape -> geom -> shape', () => {
    expect(arrowToShape(arrow.id, arrowGeom(arrow))).toEqual(arrow);
  });

  it('text survives shape -> geom -> shape', () => {
    expect(textToShape(text.id, textGeom(text))).toEqual(text);
  });

  it('a whole document of shapes round-trips losslessly', () => {
    const doc = { version: 1, rev: 7, shapes: [rect, arrow, text] };
    const roundTripped = {
      version: 1,
      rev: 7,
      shapes: doc.shapes.map((s) => {
        switch (s.type) {
          case 'rect':
            return rectToShape(s.id, rectGeom(s));
          case 'arrow':
            return arrowToShape(s.id, arrowGeom(s));
          case 'text':
            return textToShape(s.id, textGeom(s));
        }
      }),
    };
    expect(roundTripped).toEqual(doc);
    expect(JSON.parse(JSON.stringify(roundTripped))).toEqual(doc);
  });

  it('rounds float noise to two decimals without moving real values', () => {
    expect(round2(100.000000001)).toBe(100);
    expect(round2(99.995)).toBe(100);
    expect(round2(120.25)).toBe(120.25);
    const noisy = rectToShape('n', { left: 10.000000001, top: 5, width: 20.129999999, height: 7 });
    expect(noisy).toEqual({ id: 'n', type: 'rect', x: 10, y: 5, w: 20.13, h: 7 });
  });

  it('generates schema-conforming shape ids', () => {
    const id = newShapeId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(newShapeId()).not.toBe(id);
  });
});
