import type { ArrowShape, RectShape, TextShape } from '@snapping-turtle/shared/annotations';
import { describe, expect, it } from 'vitest';
import { MIN_CROP_PX } from '@snapping-turtle/shared/constants';
import {
  arrowGeom,
  arrowToShape,
  canvasToScene,
  cropGeom,
  editorViewport,
  isWholeImage,
  newShapeId,
  normalizeCrop,
  rectGeom,
  rectToShape,
  round2,
  sceneToCanvas,
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

/**
 * The collapsed view (E6): with an accepted crop the canvas is crop-sized and
 * the viewport pans to the crop; in crop mode (or without a crop) the whole
 * image is shown. Either way the transform is pure view state — a pointer
 * position maps back to the same original-image coordinates the document
 * stores, which is the invariant the Playwright collapsed-drawing test
 * checks end to end.
 */
describe('editor viewport (E6)', () => {
  const image = { width: 800, height: 500 };
  const crop = { x: 200, y: 100, w: 400, h: 300 };

  it('collapsed: canvas is crop-sized and the crop origin lands at the canvas origin', () => {
    const v = editorViewport(crop, image, 1160);
    expect([v.width, v.height, v.zoom]).toEqual([400, 300, 1]);
    expect(v.vpt).toEqual([1, 0, 0, 1, -200, -100]);
    expect(sceneToCanvas(v, { x: 200, y: 100 })).toEqual({ x: 0, y: 0 });
    expect(sceneToCanvas(v, { x: 600, y: 400 })).toEqual({ x: 400, y: 300 });
  });

  it('a pointer on the collapsed canvas maps to original-space coordinates', () => {
    const v = editorViewport(crop, image, 1160);
    expect(canvasToScene(v, { x: 50, y: 40 })).toEqual({ x: 250, y: 140 });
    // Round trip at a non-unit zoom too (a 400 px crop in the 320 px floor: 0.8).
    const zoomed = editorViewport(crop, image, 200);
    expect(zoomed.zoom).toBe(0.8);
    const back = canvasToScene(zoomed, sceneToCanvas(zoomed, { x: 333, y: 222 }));
    expect(back.x).toBeCloseTo(333, 9);
    expect(back.y).toBeCloseTo(222, 9);
  });

  it('full view: whole image, no pan; fit-to-width capped at 1:1 (§9)', () => {
    expect(editorViewport(null, image, 1160)).toEqual({
      width: 800,
      height: 500,
      zoom: 1,
      vpt: [1, 0, 0, 1, 0, 0],
    });
    const narrow = editorViewport(null, image, 400);
    expect(narrow).toEqual({ width: 400, height: 250, zoom: 0.5, vpt: [0.5, 0, 0, 0.5, 0, 0] });
  });

  it('fit-to-width follows what is shown: a narrow crop of a wide capture displays at natural size', () => {
    const wide = { width: 2560, height: 1440 };
    const full = editorViewport(null, wide, 1160);
    const collapsed = editorViewport({ x: 600, y: 300, w: 800, h: 500 }, wide, 1160);
    expect(full.zoom).toBeCloseTo(1160 / 2560, 6);
    expect(collapsed.zoom).toBe(1);
    expect([collapsed.width, collapsed.height]).toEqual([800, 500]);
  });

  it('never fits narrower than the 320 px floor', () => {
    expect(editorViewport(null, image, 100).zoom).toBe(0.4);
  });
});
