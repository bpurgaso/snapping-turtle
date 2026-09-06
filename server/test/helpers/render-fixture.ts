import type { ParityFixture } from '@snapping-turtle/shared/parity-fixtures';
import sharp from 'sharp';
import { pinRendererFonts } from '../../src/images/fonts.js';
import { buildOverlaySvg } from '../../src/images/svg-overlay.js';

/**
 * Render one parity fixture exactly the way the M4 route does — SVG overlay
 * composited by sharp — but over a generated solid background instead of an
 * uploaded capture, so the output is fully deterministic. Used by the server
 * golden tests and, via relative import, by web/test/parity's cross-renderer
 * diff (the Fabric harness paints the same background color).
 */
pinRendererFonts();

export async function renderFixturePng(f: ParityFixture): Promise<Buffer> {
  // Same pipeline shape as FlatRenderer (§10 E4): the overlay is authored in
  // original space with the crop as its viewBox; sharp extracts the crop
  // from the image, then composites the overlay at (0, 0).
  const overlay = buildOverlaySvg(
    { shapes: f.shapes, ...(f.crop ? { crop: f.crop } : {}) },
    { width: f.width, height: f.height },
  );
  let pipeline = sharp({
    create: { width: f.width, height: f.height, channels: 3, background: f.background },
  });
  if (f.crop) {
    pipeline = pipeline.extract({
      left: f.crop.x,
      top: f.crop.y,
      width: f.crop.w,
      height: f.crop.h,
    });
  }
  return pipeline
    .composite([{ input: Buffer.from(overlay, 'utf8'), left: 0, top: 0 }])
    .png()
    .toBuffer();
}
