import { PARITY_FIXTURES } from '@snapping-turtle/shared/parity-fixtures';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { measuredStrokeBand } from '../helpers/measure.js';
import { renderFixturePng } from '../helpers/render-fixture.js';

/**
 * Server-renderer goldens (§10): the SVG-overlay + sharp composite path
 * rendered against committed PNGs, catching server-only regressions without
 * booting a browser and making diffs reviewable in PRs. The goldens were
 * rendered by this same code (sharp 0.35.4's bundled libvips/librsvg with the
 * pinned Inter); the small pixel tolerance absorbs cross-platform
 * rasterization noise (macOS arm64 vs CI linux x64 builds of the same libs).
 *
 * Regenerate deliberately with:  UPDATE_GOLDENS=1 pnpm --filter server test
 */
const goldenDir = fileURLToPath(new URL('../golden/', import.meta.url));
const update = process.env['UPDATE_GOLDENS'] === '1';

describe('flat renderer goldens', () => {
  for (const fixture of PARITY_FIXTURES) {
    it(`matches golden: ${fixture.name}`, async () => {
      const rendered = await renderFixturePng(fixture);
      // Clamp proof (§9 E1): the rect fixtures promise a stroke band of
      // exactly annotationSizes(width).outerStrokeWidth pixels — 6 on the
      // 300 px floor, 48 on the 10,000 px ceiling — measured on real pixels.
      const band = measuredStrokeBand(PNG.sync.read(rendered), fixture);
      if (band) {
        expect(band.px, `${fixture.name}: stroke band ${band.px}px, expected ${band.expected}px`).toBe(
          band.expected,
        );
      }
      const goldenPath = `${goldenDir}${fixture.name}.png`;
      if (update || !existsSync(goldenPath)) {
        mkdirSync(goldenDir, { recursive: true });
        writeFileSync(goldenPath, rendered);
        return;
      }
      const actual = PNG.sync.read(rendered);
      const golden = PNG.sync.read(readFileSync(goldenPath));
      expect([actual.width, actual.height]).toEqual([golden.width, golden.height]);
      const differing = pixelmatch(actual.data, golden.data, undefined, actual.width, actual.height, {
        threshold: 0.1,
      });
      const ratio = differing / (actual.width * actual.height);
      const limit = fixture.hasText ? 0.02 : 0.005;
      expect(
        ratio,
        `${(ratio * 100).toFixed(3)}% of pixels differ from ${fixture.name}.png ` +
          `(limit ${limit * 100}%); regenerate deliberately with UPDATE_GOLDENS=1`,
      ).toBeLessThanOrEqual(limit);
    });
  }
});
