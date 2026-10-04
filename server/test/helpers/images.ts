import { crc32, deflateSync } from 'node:zlib';
import sharp from 'sharp';

/** Test image fixtures. Generated at runtime so no binary blobs live in git. */

export async function makePng(width = 64, height = 48): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .png()
    .toBuffer();
}

/**
 * A high-contrast capture for the redaction leak tests (E9, §10): a 1 px
 * checkerboard of white and orange with a blue diagonal, so every pixel has
 * at least one channel at 255 and **no pixel is black** — any black pixel in
 * a served render is the redaction fill and nothing else, and any non-black
 * pixel inside a block is the original showing through. The 1 px alternation
 * means an edge row or column off by one is never hidden by a uniform area.
 */
export async function makeContrastPng(width = 240, height = 160): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const onDiagonal = Math.abs(x - y) < 3;
      const checker = (x + y) & 1;
      const [r, g, b] = onDiagonal ? [40, 90, 255] : checker ? [255, 255, 255] : [255, 120, 0];
      raw[i] = r!;
      raw[i + 1] = g!;
      raw[i + 2] = b!;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

/** A JPEG carrying EXIF (and an ICC profile) — what a camera or editor would emit. */
export async function makeJpegWithExif(width = 64, height = 48): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 30, b: 200 } },
  })
    .jpeg({ quality: 80 })
    .withMetadata({
      exif: { IFD0: { Copyright: 'snapping-turtle test fixture', ImageDescription: 'exif' } },
      icc: 'srgb',
    })
    .toBuffer();
}

export const SVG_BYTES = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
);

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData) >>> 0);
  return Buffer.concat([len, typeAndData, crc]);
}

/**
 * A structurally valid 8-bit greyscale PNG of arbitrary dimensions whose pixel
 * data is all zeros — a decompression bomb: a few hundred KB on the wire that
 * would decode to width×height bytes. The raw scanline buffer is allocated
 * (zeros are cheap) but never decoded.
 */
export function craftPngBomb(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // no interlace
  // One filter byte + `width` zero bytes per row.
  const raw = Buffer.alloc((width + 1) * height);
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
