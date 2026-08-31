import { writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { MAX_IMAGE_HEIGHT_PX, MAX_IMAGE_PIXELS } from '@snapping-turtle/shared';

/**
 * Generate the tall-canvas perf fixture (§9 spike): the largest image the
 * ingest pipeline legitimately admits at full height. Note 10,000 × 32,000
 * would be 320 MP — over the 150 MP decompression-bomb cap — so the true
 * ceiling at max height is width = floor(150 MP / 32,000).
 * Usage: tsx test/helpers/make-tall-fixture.ts /path/out.png
 */
const height = MAX_IMAGE_HEIGHT_PX;
const width = Math.floor(MAX_IMAGE_PIXELS / height / 8) * 8; // 4,680
const out = process.argv[2];
if (!out) throw new Error('usage: make-tall-fixture.ts <out.png>');

// Page-like content: banded background, grid lines, and marker blocks so
// scrolling/zooming has visible structure. SVG keeps generation cheap and the
// PNG compressible enough to clear the 30 MB upload cap.
const bands: string[] = [];
for (let y = 0; y < height; y += 400) {
  const hue = (y / 400) % 2 === 0 ? '#f4f6fb' : '#e8edf7';
  bands.push(`<rect x="0" y="${y}" width="${width}" height="400" fill="${hue}"/>`);
  bands.push(`<rect x="40" y="${y + 40}" width="${width - 80}" height="120" rx="8" fill="#c7d3ea"/>`);
  bands.push(`<rect x="40" y="${y + 200}" width="${Math.round(width * 0.6)}" height="60" rx="6" fill="#93a8d4"/>`);
  bands.push(`<rect x="0" y="${y}" width="${width}" height="2" fill="#7e8bb0"/>`);
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${bands.join('')}</svg>`;

const png = await sharp(Buffer.from(svg), { limitInputPixels: false })
  .png({ compressionLevel: 9 })
  .toBuffer();
writeFileSync(out, png);
console.log(JSON.stringify({ out, width, height, bytes: png.length, mb: +(png.length / 1048576).toFixed(1) }));
