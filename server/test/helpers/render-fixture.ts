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
  const overlay = buildOverlaySvg({ shapes: f.shapes }, { width: f.width, height: f.height });
  return sharp({
    create: { width: f.width, height: f.height, channels: 3, background: f.background },
  })
    .composite([{ input: Buffer.from(overlay, 'utf8') }])
    .png()
    .toBuffer();
}
