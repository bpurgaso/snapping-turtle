import { MAX_IMAGE_HEIGHT_PX, MAX_IMAGE_PIXELS, MAX_IMAGE_WIDTH_PX } from '@snapping-turtle/shared';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../../src/errors.js';
import { exceedsCaps, ingestImage, sniffImageKind } from '../../src/images/ingest.js';
import { craftPngBomb, makeJpegWithExif, makePng, SVG_BYTES } from '../helpers/images.js';

async function rejection(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
  throw new Error('expected rejection');
}

describe('sniffImageKind', () => {
  it('recognises PNG and JPEG by magic bytes only', async () => {
    expect(sniffImageKind(await makePng())).toBe('png');
    expect(sniffImageKind(await makeJpegWithExif())).toBe('jpeg');
    expect(sniffImageKind(SVG_BYTES)).toBeNull();
    expect(sniffImageKind(Buffer.from('GIF89a'))).toBeNull();
    expect(sniffImageKind(Buffer.alloc(0))).toBeNull();
    expect(sniffImageKind(Buffer.from([0x89, 0x50]))).toBeNull();
  });
});

describe('ingestImage (§12 pipeline)', () => {
  it('re-encodes a PNG and reports dimensions and sha256', async () => {
    const res = await ingestImage(await makePng(40, 30));
    expect(res).toMatchObject({ width: 40, height: 30, sourceKind: 'png' });
    expect(sniffImageKind(res.png)).toBe('png');
    expect(res.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('converts JPEG to PNG and strips EXIF and ICC metadata', async () => {
    const jpeg = await makeJpegWithExif();
    const before = await sharp(jpeg).metadata();
    expect(before.exif).toBeInstanceOf(Buffer); // the fixture really carries EXIF
    expect(before.icc).toBeInstanceOf(Buffer);

    const res = await ingestImage(jpeg);
    const after = await sharp(res.png).metadata();
    expect(after.format).toBe('png');
    expect(after.exif).toBeUndefined();
    expect(after.icc).toBeUndefined();
    expect(after.xmp).toBeUndefined();
    expect(res.png.includes(Buffer.from('snapping-turtle test fixture'))).toBe(false);
  });

  it('rejects SVG with 415 — never decoded', async () => {
    const err = await rejection(ingestImage(SVG_BYTES));
    expect(err.statusCode).toBe(415);
    expect(err.code).toBe('unsupported_media_type');
  });

  it('rejects a PNG signature glued onto other content', async () => {
    const fake = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      SVG_BYTES,
    ]);
    const err = await rejection(ingestImage(fake));
    expect([415, 422]).toContain(err.statusCode);
  });

  it('rejects over-width, over-height and over-megapixel images by header (bomb-safe)', async () => {
    const tooWide = craftPngBomb(MAX_IMAGE_WIDTH_PX + 1, 1);
    const tooTall = craftPngBomb(1, MAX_IMAGE_HEIGHT_PX + 1);
    // Within both linear caps but over the pixel budget: 10,000 × 16,000 = 160 MP.
    const bomb = craftPngBomb(MAX_IMAGE_WIDTH_PX, 16_000);
    expect(bomb.length).toBeLessThan(1024 * 1024); // tiny on the wire
    for (const bytes of [tooWide, tooTall, bomb]) {
      const started = Date.now();
      const err = await rejection(ingestImage(bytes));
      expect(err.statusCode).toBe(422);
      expect(err.code).toBe('image_too_large');
      expect(Date.now() - started).toBeLessThan(2000); // refused without decoding
    }
  });

  it('accepts an image right at the height cap when the pixel budget allows', async () => {
    const tall = craftPngBomb(4, MAX_IMAGE_HEIGHT_PX);
    const res = await ingestImage(tall);
    expect(res.height).toBe(MAX_IMAGE_HEIGHT_PX);
  });

  it('exceedsCaps mirrors the shared constants', () => {
    expect(exceedsCaps(MAX_IMAGE_WIDTH_PX, 1)).toBe(false);
    expect(exceedsCaps(MAX_IMAGE_WIDTH_PX + 1, 1)).toBe(true);
    expect(exceedsCaps(1, MAX_IMAGE_HEIGHT_PX + 1)).toBe(true);
    expect(exceedsCaps(Math.ceil(MAX_IMAGE_PIXELS / 10_000) + 1, 10_000)).toBe(true);
    expect(exceedsCaps(0, 10)).toBe(true);
  });
});
