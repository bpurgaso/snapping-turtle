import { expect, test } from '@playwright/test';
import {
  PARITY_FIXTURES,
  type ParityFixture,
} from '@snapping-turtle/shared/parity-fixtures';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { renderFixturePng } from '../../../server/test/helpers/render-fixture.js';

/**
 * Render-parity golden test (§10, CLAUDE.md "Renderer parity"): every fixture
 * document is rendered by the real Fabric editor code (harness page, Chromium)
 * and by the real server path (sharp compositing the SVG overlay, same pinned
 * Inter), then diffed with pixelmatch.
 *
 * Tolerances (settled empirically on sharp 0.35.4 / Chromium via Playwright
 * 1.62): shape-only fixtures differ only along antialiased stroke edges —
 * observed ≤ 0.4% of pixels at pixelmatch threshold 0.1, capped at 1%. Text
 * fixtures add glyph rasterization differences (Skia hinting/AA vs
 * librsvg/cairo, identical font file) — capped at 5% with the same per-pixel
 * threshold. A structural fallback (glyph bounding boxes + color sampling)
 * stays documented in PLAN.md §10 in case a platform pushes text past that.
 */
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const fontDataUrl = `data:font/ttf;base64,${readFileSync(
  here('../../../shared/fonts/Inter-Regular.ttf'),
).toString('base64')}`;

const PER_PIXEL_THRESHOLD = 0.1;
const maxDiffRatio = (f: ParityFixture): number => (f.hasText ? 0.05 : 0.01);

const outDir = here('../../test-results/parity-diffs');
mkdirSync(outDir, { recursive: true });

for (const fixture of PARITY_FIXTURES) {
  test(`editor and server render "${fixture.name}" alike`, async ({ page }) => {
    await page.goto('about:blank');
    await page.addScriptTag({ path: here('../../test-results/parity-harness/harness.js') });

    const dataUrl = await page.evaluate(
      ([f, font]) => window.__parity.render(f as ParityFixture, font as string),
      [fixture, fontDataUrl] as const,
    );
    const editor = PNG.sync.read(Buffer.from(dataUrl.split(',')[1]!, 'base64'));
    const server = PNG.sync.read(await renderFixturePng(fixture));

    expect([editor.width, editor.height]).toEqual([fixture.width, fixture.height]);
    expect([server.width, server.height]).toEqual([fixture.width, fixture.height]);

    const diff = new PNG({ width: fixture.width, height: fixture.height });
    const differing = pixelmatch(
      editor.data,
      server.data,
      diff.data,
      fixture.width,
      fixture.height,
      { threshold: PER_PIXEL_THRESHOLD },
    );
    const ratio = differing / (fixture.width * fixture.height);

    // Always record the measured ratio — the calibration trail for tolerances.
    writeFileSync(
      `${outDir}/${fixture.name}.ratio.txt`,
      `${(ratio * 100).toFixed(3)}% differing (limit ${maxDiffRatio(fixture) * 100}%)\n`,
    );
    if (ratio > maxDiffRatio(fixture)) {
      writeFileSync(`${outDir}/${fixture.name}-editor.png`, PNG.sync.write(editor));
      writeFileSync(`${outDir}/${fixture.name}-server.png`, PNG.sync.write(server));
      writeFileSync(`${outDir}/${fixture.name}-diff.png`, PNG.sync.write(diff));
    }
    expect(
      ratio,
      `${(ratio * 100).toFixed(2)}% of pixels differ (limit ${maxDiffRatio(fixture) * 100}%); ` +
        `artifacts in test-results/parity-diffs/ when over`,
    ).toBeLessThanOrEqual(maxDiffRatio(fixture));
  });
}
