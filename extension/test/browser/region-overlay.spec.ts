import { expect, openFixture, test } from './fixtures.js';

/**
 * The region overlay mounted in plain pages (no extension APIs): drag returns
 * the right rect, Esc cancels, a click keeps it open, it survives hostile CSS
 * in a closed shadow root, and it is gone — and repainted over — before its
 * promise resolves, so it can never appear in the capture that follows.
 */

/** Start a selection; resolves with the result once the drag/Esc finishes. */
function startSelection(page: Parameters<typeof openFixture>[0]) {
  return page.evaluate(() => {
    window.__stTest['paints'] = [];
    return window.__stHarness.selectRegion(document, {
      onPaint: (rect, readout) => (window.__stTest['paints'] as unknown[]).push({ rect, readout }),
    });
  });
}

const overlayPresent = (page: Parameters<typeof openFixture>[0]) =>
  page.evaluate(() => document.querySelector('snapping-turtle-region') !== null);

test.describe('region overlay', () => {
  test('a drag returns the normalised viewport rect with dpr and viewport sizes', async ({
    page,
  }) => {
    await openFixture(page, 'long-page');
    const result = startSelection(page);
    await expect.poll(() => overlayPresent(page)).toBe(true);

    await page.mouse.move(300, 250);
    await page.mouse.down();
    await page.mouse.move(100, 100, { steps: 5 });
    await page.mouse.up();

    expect(await result).toEqual({
      x: 100,
      y: 100,
      width: 200,
      height: 150,
      devicePixelRatio: 1,
      viewportWidth: 1280,
      viewportHeight: 720,
      innerWidth: 1280,
      innerHeight: 720,
    });
    expect(await overlayPresent(page)).toBe(false);

    // The live readout tracked the drag and ended on the final size.
    const paints = await page.evaluate(
      () => window.__stTest['paints'] as Array<{ rect: unknown; readout: string }>,
    );
    expect(paints.length).toBeGreaterThan(2);
    expect(paints.at(-1)?.readout).toBe('200 × 150');
    expect(paints[0]?.readout).toBe('0 × 0');
  });

  test('the drag is clamped to the viewport', async ({ page }) => {
    await openFixture(page, 'long-page');
    const result = startSelection(page);
    await expect.poll(() => overlayPresent(page)).toBe(true);
    await page.mouse.move(1200, 600);
    await page.mouse.down();
    await page.mouse.move(1279, 719, { steps: 3 });
    await page.mouse.up();
    expect(await result).toMatchObject({ x: 1200, y: 600, width: 79, height: 119 });
  });

  test('Escape cancels and removes the overlay', async ({ page }) => {
    await openFixture(page, 'long-page');
    const result = startSelection(page);
    await expect.poll(() => overlayPresent(page)).toBe(true);
    await page.keyboard.press('Escape');
    expect(await result).toBeNull();
    expect(await overlayPresent(page)).toBe(false);
  });

  test('Escape mid-drag cancels too', async ({ page }) => {
    await openFixture(page, 'long-page');
    const result = startSelection(page);
    await expect.poll(() => overlayPresent(page)).toBe(true);
    await page.mouse.move(100, 100);
    await page.mouse.down();
    await page.mouse.move(400, 300, { steps: 3 });
    await page.keyboard.press('Escape');
    expect(await result).toBeNull();
    expect(await overlayPresent(page)).toBe(false);
  });

  test('a click without a drag keeps the overlay up for another try', async ({ page }) => {
    await openFixture(page, 'long-page');
    const result = startSelection(page);
    await expect.poll(() => overlayPresent(page)).toBe(true);
    await page.mouse.click(200, 200);
    expect(await overlayPresent(page)).toBe(true);
    await page.mouse.move(50, 50);
    await page.mouse.down();
    await page.mouse.move(60, 62);
    await page.mouse.up();
    expect(await result).toMatchObject({ x: 50, y: 50, width: 10, height: 12 });
  });

  test('reports the real devicePixelRatio on a 2× display', async ({ browser }) => {
    const context = await browser.newContext({
      deviceScaleFactor: 2,
      viewport: { width: 800, height: 600 },
    });
    const page = await context.newPage();
    await openFixture(page, 'long-page');
    const result = startSelection(page);
    await expect.poll(() => overlayPresent(page)).toBe(true);
    await page.mouse.move(10, 10);
    await page.mouse.down();
    await page.mouse.move(110, 60, { steps: 2 });
    await page.mouse.up();
    expect(await result).toEqual({
      x: 10,
      y: 10,
      width: 100,
      height: 50,
      devicePixelRatio: 2,
      viewportWidth: 800,
      viewportHeight: 600,
      innerWidth: 800,
      innerHeight: 600,
    });
    await context.close();
  });

  test('is removed and repainted over before the promise resolves (never in its own capture)', async ({
    page,
  }) => {
    await openFixture(page, 'long-page');
    const before = await page.screenshot();
    const result = startSelection(page);
    await expect.poll(() => overlayPresent(page)).toBe(true);
    // Dimmed while mounted…
    const during = await page.screenshot();
    expect(during.equals(before)).toBe(false);
    await page.mouse.move(100, 100);
    await page.mouse.down();
    await page.mouse.move(300, 300, { steps: 2 });
    await page.mouse.up();
    await result;
    // …and pixel-identical to the untouched page once resolved.
    const after = await page.screenshot();
    expect(after.equals(before)).toBe(true);
  });

  test('survives hostile page CSS in a closed shadow root and hides its events from the page', async ({
    page,
  }) => {
    await openFixture(page, 'hostile-css');
    const clip = { x: 600, y: 400, width: 1, height: 1 };
    const beforePixel = await page.screenshot({ clip });
    const result = startSelection(page);
    await expect.poll(() => overlayPresent(page)).toBe(true);

    const host = await page.evaluate(() => {
      const el = document.querySelector('snapping-turtle-region')!;
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        closed: el.shadowRoot === null,
        childCount: el.childNodes.length,
        position: cs.position,
        display: cs.display,
        visibility: cs.visibility,
        opacity: cs.opacity,
        zIndex: cs.zIndex,
        pointerEvents: cs.pointerEvents,
        transform: cs.transform,
        filter: cs.filter,
        width: rect.width,
        height: rect.height,
      };
    });
    expect(host).toEqual({
      closed: true,
      childCount: 0,
      position: 'fixed',
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      zIndex: '2147483647',
      pointerEvents: 'auto',
      transform: 'none',
      filter: 'none',
      width: 1280,
      height: 720,
    });
    // The page is actually dimmed: a pixel of the white page changed.
    expect((await page.screenshot({ clip })).equals(beforePixel)).toBe(false);

    await page.mouse.move(100, 100);
    await page.mouse.down();
    await page.mouse.move(300, 250, { steps: 4 });
    await page.mouse.up();
    expect(await result).toMatchObject({ x: 100, y: 100, width: 200, height: 150 });

    // Bubble-phase page listeners saw none of the pointer/mouse/click traffic.
    const seen = await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen);
    expect(seen).toEqual([]);
  });

  test('Escape does not reach page listeners either', async ({ page }) => {
    await openFixture(page, 'hostile-css');
    const result = startSelection(page);
    await expect.poll(() => overlayPresent(page)).toBe(true);
    await page.keyboard.press('Escape');
    expect(await result).toBeNull();
    const seen = await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen);
    expect(seen).toEqual([]);
  });
});
