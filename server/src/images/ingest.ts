import { MAX_IMAGE_HEIGHT_PX, MAX_IMAGE_PIXELS, MAX_IMAGE_WIDTH_PX } from '@snapping-turtle/shared';
import sharp from 'sharp';
import { HttpError } from '../errors.js';
import { sha256Hex } from '../ids.js';

/**
 * Upload pipeline (PLAN.md §12, CLAUDE.md rule 4):
 *   magic bytes (PNG/JPEG only, never SVG) → header dimension caps →
 *   sharp decode under limitInputPixels → re-encode to PNG.
 * The caller persists only the returned PNG — never the uploaded bytes.
 * Re-encoding drops every metadata chunk (EXIF, XMP, ICC, text) and any
 * trailing polyglot payload.
 */

export type ImageKind = 'png' | 'jpeg';

export interface IngestResult {
  png: Buffer;
  width: number;
  height: number;
  sha256: string;
  sourceKind: ImageKind;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/** Decide by leading bytes alone; declared content types are ignored. */
export function sniffImageKind(bytes: Uint8Array): ImageKind | null {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length >= PNG_MAGIC.length && buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return 'png';
  }
  if (buf.length >= JPEG_MAGIC.length && buf.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) {
    return 'jpeg';
  }
  return null;
}

export function exceedsCaps(width: number, height: number): boolean {
  return (
    width < 1 ||
    height < 1 ||
    width > MAX_IMAGE_WIDTH_PX ||
    height > MAX_IMAGE_HEIGHT_PX ||
    width * height > MAX_IMAGE_PIXELS
  );
}

const tooLarge = (): HttpError =>
  new HttpError(
    422,
    'image_too_large',
    `image exceeds ${MAX_IMAGE_WIDTH_PX}×${MAX_IMAGE_HEIGHT_PX} px or ${MAX_IMAGE_PIXELS / 1e6} MP`,
  );

export async function ingestImage(input: Buffer): Promise<IngestResult> {
  const sourceKind = sniffImageKind(input);
  if (!sourceKind) {
    throw new HttpError(415, 'unsupported_media_type', 'only PNG and JPEG images are accepted');
  }

  const decoder = sharp(input, {
    limitInputPixels: MAX_IMAGE_PIXELS,
    sequentialRead: true,
    animated: false,
    unlimited: false,
  });

  let width: number;
  let height: number;
  try {
    const meta = await decoder.metadata();
    if (meta.format !== sourceKind) {
      throw new HttpError(415, 'unsupported_media_type', 'image header does not match its content');
    }
    width = meta.width;
    height = meta.height;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // sharp applies limitInputPixels while reading the header, ahead of our own caps.
    if (/pixel limit/i.test((err as Error).message ?? '')) throw tooLarge();
    throw new HttpError(422, 'invalid_image', 'image could not be decoded');
  }

  // Header-level check first so a decompression bomb is refused before any
  // pixel is decoded; limitInputPixels above is the backstop.
  if (exceedsCaps(width, height)) throw tooLarge();

  let png: Buffer;
  try {
    // No withMetadata(): the output carries no EXIF/ICC/XMP/text chunks.
    png = await decoder.png({ compressionLevel: 6 }).toBuffer();
  } catch {
    throw new HttpError(422, 'invalid_image', 'image could not be decoded');
  }

  return { png, width, height, sha256: sha256Hex(png), sourceKind };
}
