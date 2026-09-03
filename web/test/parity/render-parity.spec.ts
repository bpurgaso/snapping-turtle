import { expect, test } from '@playwright/test';
import {
  PARITY_FIXTURES,
  type ParityFixture,
} from '@snapping-turtle/shared/parity-fixtures';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { inkBBox, inkBoxDelta, measuredStrokeBand } from '../../../server/test/helpers/measure.js';
import { renderFixturePng } from '../../../server/test/helpers/render-fixture.js';

/**
 * Render-parity golden test (§10, CLAUDE.md "Renderer parity"): every fixture
 * document is rendered by the real Fabric editor code (harness page, Chromium)
 * and by the real server path (sharp compositing the SVG overlay, same pinned
 * Inter), then compared two ways:
 *
 * 1. **Painted extent** — the bounding box of every non-background pixel must
 *    agree within `maxInkBoxDeltaPx` (1 px). Dimension-independent, and the
 *    check that catches displacement: a 2 px rect shift or a 3 px text
 *    baseline shift moves the box by 2–4 px on every fixture, floor to ceiling.
 * 2. **Pixel ratio over ink** — pixelmatch differences (per-pixel threshold
 *    0.1) divided by the pixels either renderer painted, capped at
 *    `maxInkDiffRatio` (30%). A ratio over the *whole image* dilutes with
 *    fixture area (the 10,000 px fixtures are >99% background) and could not
 *    see a shifted glyph run; over ink it is comparable across sizes.
 *
 * Calibration (E1, 2026-09-02, sharp 0.35.4 / Playwright 1.62 Chromium,
 * macOS arm64), with the harness rendering real Inter: box delta 0–1 px on all
 * 18 fixtures; ink ratio 0–15.9% for shapes (the 480/300 px fixtures sit on
 * the §9 floor with 1.5 px white rims, all edge pixels) and 0.01–15.1% for
 * text. Deliberate faults: +2 px rect → box delta 2 everywhere, ratio 16–37%
 * below 3,200 px; +3 px text baseline → box delta 2–4, ratio 9–44%.
 *
 * History: until E1 the harness never loaded Inter (`document.fonts.check`
 * is true when no such face exists) and compared Chromium's fallback font
 * against the server's Inter — text ran ~11% narrower — under a 5%-of-image
 * tolerance that passed anyway. The M4 text numbers in PLAN.md §10 (1.2–3.8%)
 * measured that mismatch, not Skia-vs-librsvg antialiasing.
 */
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const fontDataUrl = `data:font/ttf;base64,${readFileSync(
  here('../../../shared/fonts/Inter-Regular.ttf'),
).toString('base64')}`;

const PER_PIXEL_THRESHOLD = 0.1;
/** Tolerance as a share of painted ("ink") pixels; see the header for the calibration. */
const maxInkDiffRatio = (_f: ParityFixture): number => 0.3;
/** Largest allowed per-edge difference of the painted extent, in pixels. */
const maxInkBoxDeltaPx = (_f: ParityFixture): number => 1;

/** Pixels either renderer painted (differs from the fixture background in any channel by > 6). */
function inkPixels(a: PNG, b: PNG, background: string): number {
  const n = Number.parseInt(background.slice(1), 16);
  const bg = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  let ink = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const painted = (d: Buffer) =>
      Math.abs(d[i]! - bg[0]!) > 6 || Math.abs(d[i + 1]! - bg[1]!) > 6 || Math.abs(d[i + 2]! - bg[2]!) > 6;
    if (painted(a.data) || painted(b.data)) ink++;
  }
  return ink;
}

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

    // Clamp proof (§9 E1): both renderers paint the promised stroke band —
    // the floor's 6 px on a 300 px crop, the ceiling's 48 px at 10,000 px.
    const editorBand = measuredStrokeBand(editor, fixture);
    const serverBand = measuredStrokeBand(server, fixture);
    if (editorBand && serverBand) {
      expect(editorBand.px, `editor stroke band for ${fixture.name}`).toBe(editorBand.expected);
      expect(serverBand.px, `server stroke band for ${fixture.name}`).toBe(serverBand.expected);
    }

    const diff = new PNG({ width: fixture.width, height: fixture.height });
    const differing = pixelmatch(
      editor.data,
      server.data,
      diff.data,
      fixture.width,
      fixture.height,
      { threshold: PER_PIXEL_THRESHOLD },
    );
    // Ink-relative ratio: differing pixels over the pixels either renderer
    // painted. The whole-image ratio dilutes with fixture area (a 10,000 px
    // fixture is mostly background), so it cannot see a shifted glyph or a
    // displaced stroke; the ink ratio is dimension-independent and was
    // calibrated against deliberate 3 px displacements (see the header).
    const ink = inkPixels(editor, server, fixture.background);
    const imageRatio = differing / (fixture.width * fixture.height);
    const inkRatio = differing / Math.max(1, ink);
    const limit = maxInkDiffRatio(fixture);
    // Structural check: the extent of everything painted must agree. This is
    // what catches a displaced stroke or a shifted/misfit glyph run at any
    // fixture size, where a pixel ratio saturates or dilutes.
    const editorBox = inkBBox(editor, fixture.background);
    const serverBox = inkBBox(server, fixture.background);
    const boxDelta = editorBox && serverBox ? inkBoxDelta(editorBox, serverBox) : Number.POSITIVE_INFINITY;
    const boxLimit = maxInkBoxDeltaPx(fixture);

    // Always record the measurements — the calibration trail for tolerances —
    // and both renders, so a tolerance change can be re-derived offline.
    writeFileSync(
      `${outDir}/${fixture.name}.ratio.txt`,
      `${(inkRatio * 100).toFixed(2)}% of ink differing (limit ${limit * 100}%); ` +
        `ink box delta ${boxDelta}px (limit ${boxLimit}px); ` +
        `${differing} px differ of ${ink} ink px; ${(imageRatio * 100).toFixed(3)}% of image\n`,
    );
    writeFileSync(`${outDir}/${fixture.name}-editor.png`, PNG.sync.write(editor));
    writeFileSync(`${outDir}/${fixture.name}-server.png`, PNG.sync.write(server));
    if (inkRatio > limit || boxDelta > boxLimit) {
      writeFileSync(`${outDir}/${fixture.name}-diff.png`, PNG.sync.write(diff));
    }
    expect(
      boxDelta,
      `painted extent differs by ${boxDelta}px between renderers (limit ${boxLimit}px): ` +
        `${JSON.stringify(editorBox)} vs ${JSON.stringify(serverBox)}`,
    ).toBeLessThanOrEqual(boxLimit);
    expect(
      inkRatio,
      `${(inkRatio * 100).toFixed(2)}% of painted pixels differ (limit ${limit * 100}%); ` +
        `artifacts in test-results/parity-diffs/`,
    ).toBeLessThanOrEqual(limit);
  });
}
