import {
  ANNOTATION_LIMITS,
  ANNOTATION_STYLE as S,
  ANNOTATION_TEXT_LAYOUT,
  stripAnnotationControlChars,
  type Shape,
} from '@snapping-turtle/shared/annotations';
import { Control, FabricObject, IText, Point, Rect, util } from 'fabric';
import { arrowToShape, newShapeId, rectToShape, textToShape } from './model.js';

/**
 * Fabric objects for the three annotation shapes (§9). Every shape draws the
 * red-with-white-outline double stroke from ANNOTATION_STYLE — white first at
 * strokeWidth + 2·outline, red on top — which M4's SVG renderer reproduces.
 * Rotation is disabled everywhere: the schema has no rotation and the flat
 * renderer must be able to reproduce exactly what the editor can produce.
 */

/** Full width of the white underlay stroke. */
const OUTER = S.strokeWidth + 2 * S.outline;

const idStore = new WeakMap<FabricObject, string>();

export function setShapeId(obj: FabricObject, id: string): void {
  idStore.set(obj, id);
}

export function ensureShapeId(obj: FabricObject): string {
  let id = idStore.get(obj);
  if (!id) {
    id = newShapeId();
    idStore.set(obj, id);
  }
  return id;
}

export class AnnoRect extends Rect {
  constructor(options: { left: number; top: number; width: number; height: number }) {
    super({
      ...options,
      fill: '',
      stroke: S.red,
      strokeWidth: OUTER, // fabric pads its cache and selection box by this
      lockRotation: true,
      lockScalingFlip: true,
    });
    this.setControlsVisibility({ mtr: false });
  }

  override _render(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.beginPath();
    ctx.rect(-this.width / 2, -this.height / 2, this.width, this.height);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = S.white;
    ctx.lineWidth = OUTER;
    ctx.stroke();
    ctx.strokeStyle = S.red;
    ctx.lineWidth = S.strokeWidth;
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * Arrow with two endpoint handles (§9): a custom control per endpoint instead
 * of Fabric's bounding-box scaling, which would distort the arrowhead. The
 * endpoints are stored relative to the object's center, so plain dragging
 * (which moves the center) needs no bookkeeping.
 */
export class AnnoArrow extends FabricObject {
  rx1 = 0;
  ry1 = 0;
  rx2 = 0;
  ry2 = 0;

  constructor(x1: number, y1: number, x2: number, y2: number) {
    super({
      originX: 'center',
      originY: 'center',
      fill: '',
      stroke: S.red,
      strokeWidth: OUTER,
      lockScalingX: true,
      lockScalingY: true,
      lockRotation: true,
      hasBorders: false,
      perPixelTargetFind: true,
    });
    this.controls = { p1: endpointControl(1), p2: endpointControl(2) };
    this.setEndpoints(x1, y1, x2, y2);
  }

  setEndpoints(x1: number, y1: number, x2: number, y2: number): void {
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    this.rx1 = x1 - cx;
    this.ry1 = y1 - cy;
    this.rx2 = x2 - cx;
    this.ry2 = y2 - cy;
    const pad = S.arrowHeadWidth + OUTER;
    this.set({
      left: cx,
      top: cy,
      width: Math.abs(x2 - x1) + 2 * pad,
      height: Math.abs(y2 - y1) + 2 * pad,
    });
    this.setCoords();
    this.dirty = true;
  }

  getEndpoints(): { x1: number; y1: number; x2: number; y2: number } {
    const c = this.getCenterPoint();
    return { x1: c.x + this.rx1, y1: c.y + this.ry1, x2: c.x + this.rx2, y2: c.y + this.ry2 };
  }

  override _render(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    this.drawArrow(ctx, S.white, OUTER, 2 * S.outline);
    this.drawArrow(ctx, S.red, S.strokeWidth, 0);
    ctx.restore();
  }

  private drawArrow(
    ctx: CanvasRenderingContext2D,
    color: string,
    shaftWidth: number,
    headStroke: number,
  ): void {
    const { rx1, ry1, rx2, ry2 } = this;
    const dx = rx2 - rx1;
    const dy = ry2 - ry1;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const headLen = Math.min(S.arrowHeadLength, len * 0.6);
    const bx = rx2 - ux * headLen;
    const by = ry2 - uy * headLen;
    const hw = S.arrowHeadWidth / 2;

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(rx1, ry1);
    ctx.lineTo(bx, by);
    ctx.lineWidth = shaftWidth;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(rx2, ry2);
    ctx.lineTo(bx - uy * -hw, by + ux * -hw);
    ctx.lineTo(bx - uy * hw, by + ux * hw);
    ctx.closePath();
    if (headStroke > 0) {
      ctx.lineWidth = headStroke;
      ctx.stroke();
    }
    ctx.fill();
  }
}

function endpointControl(which: 1 | 2): Control {
  return new Control({
    actionName: 'moveEndpoint',
    cursorStyle: 'crosshair',
    positionHandler(_dim, finalMatrix, obj) {
      const a = obj as AnnoArrow;
      const p = which === 1 ? new Point(a.rx1, a.ry1) : new Point(a.rx2, a.ry2);
      return util.transformPoint(p, finalMatrix);
    },
    actionHandler(_e, transform, x, y) {
      const a = transform.target as AnnoArrow;
      const p = a.getEndpoints();
      if (which === 1) a.setEndpoints(x, y, p.x2, p.y2);
      else a.setEndpoints(p.x1, p.y1, x, y);
      return true;
    },
    render(ctx, left, top) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(left, top, 6, 0, 2 * Math.PI);
      ctx.fillStyle = S.white;
      ctx.strokeStyle = S.red;
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    },
  });
}

/** IText in the shared style; resizing scales the font (normalised on modify). */
export function makeText(
  text: string,
  opts: { left: number; top: number; fontSize: number },
): IText {
  const t = new IText(text, {
    ...opts,
    fontFamily: S.fontFamily,
    fill: S.red,
    stroke: S.white,
    strokeWidth: S.textStrokeWidth,
    paintFirst: 'stroke',
    lineHeight: ANNOTATION_TEXT_LAYOUT.lineHeight,
    lockRotation: true,
    lockScalingFlip: true,
  });
  // Pin Fabric's private text metrics to the shared values the SVG renderer is
  // built against, so a Fabric upgrade cannot silently move glyph baselines.
  Object.assign(t as unknown as Record<string, number>, {
    _fontSizeMult: ANNOTATION_TEXT_LAYOUT.fontSizeMult,
    _fontSizeFraction: ANNOTATION_TEXT_LAYOUT.fontSizeFraction,
  });
  t.initDimensions();
  t.setControlsVisibility({ mtr: false, ml: false, mr: false, mt: false, mb: false });
  return t;
}

const clampFont = (n: number): number =>
  Math.min(ANNOTATION_LIMITS.maxFontSize, Math.max(ANNOTATION_LIMITS.minFontSize, n));

/** Bake any in-progress scale into real geometry so the schema stays scale-free. */
export function normalizeScaling(obj: FabricObject): void {
  if (obj instanceof AnnoArrow) return; // scaling is locked; endpoints are the geometry
  if (obj instanceof AnnoRect) {
    obj.set({
      width: Math.max(1, obj.width * obj.scaleX),
      height: Math.max(1, obj.height * obj.scaleY),
      scaleX: 1,
      scaleY: 1,
    });
    obj.setCoords();
    return;
  }
  if (obj instanceof IText && (obj.scaleX !== 1 || obj.scaleY !== 1)) {
    obj.set({ fontSize: clampFont(obj.fontSize * obj.scaleY), scaleX: 1, scaleY: 1 });
    obj.setCoords();
  }
}

/** Canvas object -> schema shape; null for anything we do not persist. */
export function shapeOf(obj: FabricObject): Shape | null {
  if (obj instanceof AnnoArrow) return arrowToShape(ensureShapeId(obj), obj.getEndpoints());
  if (obj instanceof AnnoRect) {
    return rectToShape(ensureShapeId(obj), {
      left: obj.left,
      top: obj.top,
      width: obj.width * obj.scaleX,
      height: obj.height * obj.scaleY,
    });
  }
  if (obj instanceof IText) {
    const text = stripAnnotationControlChars(obj.text ?? '').slice(
      0,
      ANNOTATION_LIMITS.maxTextLength,
    );
    return textToShape(ensureShapeId(obj), {
      left: obj.left,
      top: obj.top,
      text,
      fontSize: clampFont(obj.fontSize * obj.scaleY),
    });
  }
  return null;
}

/** Schema shape -> canvas object (the load half of the round trip). */
export function objectFromShape(s: Shape): FabricObject {
  switch (s.type) {
    case 'rect': {
      const r = new AnnoRect({ left: s.x, top: s.y, width: s.w, height: s.h });
      setShapeId(r, s.id);
      return r;
    }
    case 'arrow': {
      const a = new AnnoArrow(s.x1, s.y1, s.x2, s.y2);
      setShapeId(a, s.id);
      return a;
    }
    case 'text': {
      const t = makeText(s.text, { left: s.x, top: s.y, fontSize: s.fontSize });
      setShapeId(t, s.id);
      return t;
    }
  }
}
