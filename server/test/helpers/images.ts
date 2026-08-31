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
