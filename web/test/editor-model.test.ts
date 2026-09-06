import type { ArrowShape, RectShape, TextShape } from '@snapping-turtle/shared/annotations';
import { describe, expect, it } from 'vitest';
import { MIN_CROP_PX } from '@snapping-turtle/shared/constants';
import {
  arrowGeom,
  arrowToShape,
  cropGeom,
  isWholeImage,
  newShapeId,
  normalizeCrop,
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

/**
 * The crop frame → schema rect mapping (E4): whatever the pointer or the
 * handles produced becomes an integer rect inside the image of at least
 * MIN_CROP_PX per side — the validator's exact acceptance set.
 */
describe('crop normalisation (E4)', () => {
  const image = { width: 800, height: 500 };

  it('rounds a clean drag to whole pixels and round-trips through cropGeom', () => {
    const c = normalizeCrop({ left: 100.4, top: 80.6, width: 400.2, height: 299.7 }, image);
    expect(c).toEqual({ x: 100, y: 81, w: 401, h: 299 }); // edges round independently: 500.6 → 501
    expect(normalizeCrop(cropGeom(c!), image)).toEqual(c);
  });

  it('clamps to the image on every side', () => {
    expect(normalizeCrop({ left: -50, top: -20, width: 200, height: 100 }, image)).toEqual({
      x: 0,
      y: 0,
      w: 150,
      h: 80,
    });
    expect(normalizeCrop({ left: 700, top: 450, width: 300, height: 300 }, image)).toEqual({
      x: 700,
      y: 450,
      w: 100,
      h: 50,
    });
  });

  it('normalises a drag that ended up-left of its origin', () => {
    expect(normalizeCrop({ left: 300, top: 200, width: -100, height: -50 }, image)).toEqual({
      x: 200,
      y: 150,
      w: 100,
      h: 50,
    });
  });

  it('grows a too-small frame to the minimum, pulling back from the image edge', () => {
    expect(normalizeCrop({ left: 10, top: 10, width: 3, height: 3 }, image)).toEqual({
      x: 10,
      y: 10,
      w: MIN_CROP_PX,
      h: MIN_CROP_PX,
    });
    const atEdge = normalizeCrop({ left: 795, top: 498, width: 2, height: 1 }, image)!;
    expect(atEdge).toEqual({
      x: 800 - MIN_CROP_PX,
      y: 500 - MIN_CROP_PX,
      w: MIN_CROP_PX,
      h: MIN_CROP_PX,
    });
    expect(atEdge.x + atEdge.w).toBeLessThanOrEqual(image.width);
  });

  it('an image smaller than the minimum cannot be cropped', () => {
    expect(
      normalizeCrop({ left: 0, top: 0, width: 10, height: 10 }, { width: 10, height: 10 }),
    ).toBeNull();
  });

  it('a whole-image crop is recognised as no crop', () => {
    const whole = normalizeCrop({ left: -10, top: -10, width: 900, height: 600 }, image)!;
    expect(whole).toEqual({ x: 0, y: 0, w: 800, h: 500 });
    expect(isWholeImage(whole, image)).toBe(true);
    expect(isWholeImage({ x: 0, y: 0, w: 799, h: 500 }, image)).toBe(false);
  });
});
