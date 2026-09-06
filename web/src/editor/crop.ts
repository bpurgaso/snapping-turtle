import type { CropRect } from '@snapping-turtle/shared/annotations';
import { FabricObject, Rect } from 'fabric';

/**
 * Editor chrome for the crop viewport (E4, §9): two Fabric objects that are
 * never persisted and never rendered by the server. Screen-space styling —
 * pixel sizes here are chrome (like the arrow's endpoint handles), not
 * annotation geometry, so they deliberately do not follow the §9 curve and
 * are divided by the zoom to stay constant on screen.
 */
export const CROP_CHROME = {
  /** Dim over everything outside the crop. */
  shade: 'rgba(0, 0, 0, 0.45)',
  /** The frame's border, in screen pixels. */
  borderPx: 2,
  dashPx: 8,
  border: '#ffffff',
  borderShadow: 'rgba(0, 0, 0, 0.6)',
  handleColor: '#ffffff',
  handleBorder: '#1c1c1c',
  handleSizePx: 12,
  /** The frame draws its own border in _render; Fabric's stroke is off so left/top/width/height are the crop exactly. */
  fabricStrokeWidth: 0,
} as const;

/**
 * Dims everything outside the current crop. Covers the whole image, sits on
 * top of every shape, ignores the pointer, and asks `current()` for the rect
 * on every frame (the persisted crop, or the live frame while adjusting) —
 * so it is never cached and needs no bookkeeping when the frame moves.
 */
export class CropShade extends FabricObject {
  constructor(
    image: { width: number; height: number },
    private readonly current: () => CropRect | null,
  ) {
    super({
      left: 0,
      top: 0,
      width: image.width,
      height: image.height,
      selectable: false,
      evented: false,
      hasControls: false,
      hasBorders: false,
      objectCaching: false,
      excludeFromExport: true,
    });
  }

  override _render(ctx: CanvasRenderingContext2D): void {
    const crop = this.current();
    if (!crop) return;
    const ox = -this.width / 2;
    const oy = -this.height / 2;
    ctx.save();
    ctx.fillStyle = CROP_CHROME.shade;
    ctx.beginPath();
    ctx.rect(ox, oy, this.width, this.height);
    ctx.rect(ox + crop.x, oy + crop.y, crop.w, crop.h);
    ctx.fill('evenodd');
    ctx.restore();
  }
}

/**
 * The adjustable crop rectangle in crop mode: draggable by its interior,
 * resizable by Fabric's corner and edge handles, never rotated. It carries no
 * Fabric stroke, so `left/top/width/height` *are* the crop in image pixels
 * (scale is baked back into width/height by the editor after each gesture).
 */
export class CropFrame extends Rect {
  constructor(geom: { left: number; top: number; width: number; height: number }) {
    super({
      ...geom,
      fill: '',
      strokeWidth: CROP_CHROME.fabricStrokeWidth,
      objectCaching: false,
      excludeFromExport: true,
      lockRotation: true,
      lockScalingFlip: true,
      hasBorders: false,
      transparentCorners: false,
      cornerColor: CROP_CHROME.handleColor,
      cornerStrokeColor: CROP_CHROME.handleBorder,
      cornerSize: CROP_CHROME.handleSizePx,
      cornerStyle: 'rect',
      hoverCursor: 'move',
    });
    this.setControlsVisibility({ mtr: false });
  }

  /** Live geometry with any in-progress scale applied. */
  geom(): { left: number; top: number; width: number; height: number } {
    return {
      left: this.left,
      top: this.top,
      width: this.width * this.scaleX,
      height: this.height * this.scaleY,
    };
  }

  override _render(ctx: CanvasRenderingContext2D): void {
    // ctx is in object space (scaled by scaleX/scaleY mid-gesture): keep the
    // border a constant screen width by dividing out the zoom and the scale.
    const zoom = this.canvas?.getZoom() ?? 1;
    const w = this.width;
    const h = this.height;
    ctx.save();
    ctx.lineJoin = 'miter';
    ctx.lineWidth = CROP_CHROME.borderPx / (zoom * Math.max(this.scaleX, this.scaleY));
    ctx.strokeStyle = CROP_CHROME.borderShadow;
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    ctx.strokeStyle = CROP_CHROME.border;
    ctx.setLineDash([CROP_CHROME.dashPx / zoom, CROP_CHROME.dashPx / zoom]);
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    ctx.restore();
  }
}
