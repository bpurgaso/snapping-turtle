import type { DrawRect, PhysicalRect } from './capture-geometry.js';
import { dataUrlToBlob } from './data-url.js';

/**
 * Canvas plumbing shared by region cropping and full-page stitching.
 * Chrome's service worker has OffscreenCanvas; Firefox's event page has a
 * DOM document (and, since 105, OffscreenCanvas too) — `createCanvas` takes
 * whichever exists. Every ImageBitmap is closed as soon as it is drawn: a
 * worst-case stitch is ~36 tiles of several MB each, which must not pile up
 * beside a ~400 MB composite (PLAN.md §15).
 */

export type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
export type AnyContext = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export function createCanvas(
  width: number,
  height: number,
): { canvas: AnyCanvas; ctx: AnyContext } {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`cannot create a ${width}×${height} canvas`);
  }
  let canvas: AnyCanvas;
  if (typeof OffscreenCanvas === 'function') {
    canvas = new OffscreenCanvas(width, height);
  } else if (typeof document !== 'undefined') {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
  } else {
    throw new Error('no canvas implementation available');
  }
  const ctx = canvas.getContext('2d') as AnyContext | null;
  if (!ctx) throw new Error('2d canvas context unavailable');
  return { canvas, ctx };
}

export function canvasToBlob(canvas: AnyCanvas): Promise<Blob> {
  if (canvas instanceof OffscreenCanvas) return canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('canvas.toBlob produced nothing'));
    }, 'image/png');
  });
}

/** Release the canvas's backing store eagerly instead of waiting for GC. */
export function disposeCanvas(canvas: AnyCanvas): void {
  canvas.width = 0;
  canvas.height = 0;
}

export function decodeDataUrl(dataUrl: string): Promise<ImageBitmap> {
  return createImageBitmap(dataUrlToBlob(dataUrl));
}

/** Crop a captured data URL to a physical-pixel rect; the bitmap is closed afterwards. */
export async function cropDataUrl(dataUrl: string, rect: PhysicalRect): Promise<Blob> {
  const bitmap = await decodeDataUrl(dataUrl);
  try {
    return await cropBitmap(bitmap, rect);
  } finally {
    bitmap.close();
  }
}

export async function cropBitmap(bitmap: ImageBitmap, rect: PhysicalRect): Promise<Blob> {
  const { canvas, ctx } = createCanvas(rect.width, rect.height);
  try {
    ctx.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    return await canvasToBlob(canvas);
  } finally {
    disposeCanvas(canvas);
  }
}

/** Anything drawImage accepts that also knows its size and can be released. */
export interface TileImage {
  readonly width: number;
  readonly height: number;
  close(): void;
}

/** A composite under construction; see stitch.ts for the driver. */
export interface Composite {
  draw(image: TileImage, rect: DrawRect): void;
  toBlob(): Promise<Blob>;
  dispose(): void;
}

export function createComposite(width: number, height: number): Composite {
  const { canvas, ctx } = createCanvas(width, height);
  return {
    draw(image, rect) {
      try {
        ctx.drawImage(
          image as unknown as CanvasImageSource,
          rect.sx,
          rect.sy,
          rect.sw,
          rect.sh,
          rect.dx,
          rect.dy,
          rect.dw,
          rect.dh,
        );
      } finally {
        image.close();
      }
    },
    toBlob: () => canvasToBlob(canvas),
    dispose: () => disposeCanvas(canvas),
  };
}
