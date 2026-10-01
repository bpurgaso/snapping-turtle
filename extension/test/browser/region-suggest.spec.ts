import type { Page } from '@playwright/test';
import { expect, openFixture, test } from './fixtures.js';

/**
 * Region suggestions (E7) in plain fixture pages — no extension APIs, the M6
 * pattern. The qualifier's rules are unit-tested (test/region-suggest.test.ts);
 * this proves the overlay reads real pages into it correctly: hit-testing
 * through the overlay, real computed styles, real rects, the click/drag/Esc
 * gestures, and that the highlight is gone and repainted over before the
 * promise resolves, so the assist never photographs itself.
 */

interface Painted {
  rect: { x: number; y: number; width: number; height: number };
  kind: string;
  badge: string;
  promoted: boolean;
}
type OverlayEvent = ['suggest', Painted | null] | ['paint', Painted['rect'] | null];

/** Start a selection, logging every highlight change and repaint in order. */
function startSelection(page: Page, options: { suggestions?: boolean } = {}) {
  return page.evaluate((opts) => {
    const events: unknown[] = [];
    window.__stTest['events'] = events;
    window.__stTest['current'] = null;
    return window.__stHarness.selectRegion(
      document,
      {
        onPaint: (rect) => events.push(['paint', rect]),
        onSuggest: (suggestion) => {
          events.push(['suggest', suggestion]);
          window.__stTest['current'] = suggestion;
        },
      },
      opts,
    );
  }, options);
}

const overlayPresent = (page: Page) =>
  page.evaluate(() => document.querySelector('snapping-turtle-region') !== null);

const events = (page: Page) => page.evaluate(() => window.__stTest['events'] as OverlayEvent[]);

/** Two animation frames: the hover evaluation runs on the first one after a move. */
const frames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

/** Move the pointer and return what is highlighted once the hover has been evaluated. */
async function hover(page: Page, x: number, y: number): Promise<Painted | null> {
  await page.mouse.move(x, y);
  await frames(page);
  return page.evaluate(() => window.__stTest['current'] as Painted | null);
}

/**
 * Open a fixture with the overlay mounted. The pending selection comes back
 * wrapped, because returning the promise itself from an async function would
 * wait for the selection to finish.
 */
async function open(page: Page, fixture: string, options: { suggestions?: boolean } = {}) {
  await openFixture(page, fixture);
  const result = startSelection(page, options);
  await expect.poll(() => overlayPresent(page)).toBe(true);
  return { result };
}

/** Esc, and the selection resolves null with the overlay gone. */
async function cancel(page: Page, result: Promise<unknown>): Promise<void> {
  await page.keyboard.press('Escape');
  expect(await result).toBeNull();
  expect(await overlayPresent(page)).toBe(false);
}

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

test.describe('region suggestions: images and media', () => {
  test('every image in a grid suggests exactly its own bounds; the gaps suggest nothing', async ({
    page,
  }) => {
    const { result } = await open(page, 'suggest-images');
    const grid = [
      [40, 100],
      [280, 100],
      [520, 100],
      [40, 290],
      [280, 290],
      [520, 290],
    ] as const;
    for (const [x, y] of grid) {
      expect(await hover(page, x + 100, y + 75), `image at ${x},${y}`).toEqual({
        rect: rect(x, y, 200, 150),
        kind: 'media',
        badge: '200 × 150',
        promoted: false,
      });
      // The 40 px gutter to the right of each image is plain page.
      expect(await hover(page, x + 220, y + 75), `gutter after ${x},${y}`).toBeNull();
    }
    // The first and last pixel of an image are the image; one pixel out is not.
    expect(await hover(page, 40, 100)).toMatchObject({ rect: rect(40, 100, 200, 150) });
    expect(await hover(page, 239, 249)).toMatchObject({ rect: rect(40, 100, 200, 150) });
    expect(await hover(page, 39, 175)).toBeNull();
    await cancel(page, result);
  });

  test('video, canvas, svg (through its children) and picture are media too', async ({ page }) => {
    const { result } = await open(page, 'suggest-images');
    expect(await hover(page, 900, 160)).toMatchObject({
      rect: rect(800, 100, 240, 135),
      kind: 'media',
    });
    expect(await hover(page, 900, 330)).toMatchObject({
      rect: rect(800, 280, 200, 100),
      kind: 'media',
    });
    // The pointer is on the <circle>; the suggestion is its <svg>.
    expect(
      await page.evaluate(
        () =>
          document
            .elementsFromPoint(1120, 160)
            .find((e) => e.localName !== 'snapping-turtle-region')?.id,
      ),
    ).toBe('circle');
    expect(await hover(page, 1120, 160)).toMatchObject({
      rect: rect(1060, 100, 120, 120),
      kind: 'media',
    });
    expect(await hover(page, 1140, 340)).toMatchObject({
      rect: rect(1060, 280, 160, 120),
      kind: 'media',
    });
    await cancel(page, result);
  });

  test('tiny icons are skipped: 16, 24 and 31 px suggest nothing, 32 px does', async ({ page }) => {
    const { result } = await open(page, 'suggest-images');
    expect(await hover(page, 28, 28)).toBeNull();
    expect(await hover(page, 72, 28)).toBeNull();
    expect(await hover(page, 115, 27)).toBeNull();
    expect(await hover(page, 166, 28)).toEqual({
      rect: rect(150, 12, 32, 32),
      kind: 'media',
      badge: '32 × 32',
      promoted: false,
    });
    await cancel(page, result);
  });

  test('an invisible image and plain text suggest nothing', async ({ page }) => {
    const { result } = await open(page, 'suggest-images');
    // #ghost is a 200 × 150 <img> with opacity 0.
    expect(await hover(page, 400, 575)).toBeNull();
    expect(await hover(page, 600, 530)).toBeNull();
    expect((await events(page)).filter(([type]) => type === 'suggest')).toEqual([]);
    await cancel(page, result);
  });

  test('fractional bounds round outward and off-screen bounds clamp to the viewport', async ({
    page,
  }) => {
    const { result } = await open(page, 'suggest-images');
    const bounds = await page.evaluate(() => {
      const r = document.getElementById('fractional')!.getBoundingClientRect();
      return [r.left, r.top, r.right, r.bottom].map((n) => Math.round(n * 100) / 100);
    });
    // The page really does put it on fractional pixels…
    expect(bounds[0]).toBeGreaterThan(40);
    expect(bounds[2]).toBeGreaterThan(140);
    expect(bounds[3]).toBeGreaterThan(560);
    // …and the suggestion contains all of it: nothing shaved.
    expect(await hover(page, 90, 530)).toEqual({
      rect: rect(40, 500, 101, 61),
      kind: 'media',
      badge: '101 × 61',
      promoted: false,
    });
    // #offscreen is 200 × 150 at 1200,650 in a 1280 × 720 viewport.
    expect(await hover(page, 1240, 690)).toEqual({
      rect: rect(1200, 650, 80, 70),
      kind: 'media',
      badge: '80 × 70',
      promoted: false,
    });
    await cancel(page, result);
  });

  test('the highlight follows the page when it scrolls under a resting pointer', async ({
    page,
  }) => {
    const { result } = await open(page, 'suggest-images');
    expect(await hover(page, 100, 430)).toMatchObject({ rect: rect(40, 290, 200, 150) });
    await page.evaluate(() => window.scrollBy(0, 60));
    await expect.poll(() => page.evaluate(() => window.__stTest['current'])).toBeNull();
    await page.evaluate(() => window.scrollBy(0, -60));
    await expect
      .poll(() => page.evaluate(() => window.__stTest['current']))
      .toMatchObject({ rect: rect(40, 290, 200, 150) });
    await cancel(page, result);
  });
});

test.describe('region suggestions: gestures', () => {
  test('a click on a highlighted image captures exactly the suggested rect', async ({ page }) => {
    const { result } = await open(page, 'suggest-images');
    expect(await hover(page, 380, 175)).toMatchObject({ rect: rect(280, 100, 200, 150) });
    await page.mouse.down();
    await page.mouse.up();
    expect(await result).toEqual({
      x: 280,
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
    // Never a drag: the drag rect was not painted at any point.
    expect((await events(page)).filter(([type]) => type === 'paint')).toEqual([]);
  });

  test('a click that lands before the hover frame has run still captures what is under it', async ({
    page,
  }) => {
    const { result } = await open(page, 'suggest-images');
    // move + down + up with no frame in between
    await page.mouse.click(620, 365);
    expect(await result).toMatchObject({ x: 520, y: 290, width: 200, height: 150 });
  });

  test('a press that wobbles inside the click slop is still a click', async ({ page }) => {
    const { result } = await open(page, 'suggest-images');
    await page.mouse.move(380, 175);
    await page.mouse.down();
    await page.mouse.move(382, 173);
    await page.mouse.up();
    expect(await result).toMatchObject({ x: 280, y: 100, width: 200, height: 150 });
  });

  test('is removed and repainted over before the promise resolves (the highlight is never in its own capture)', async ({
    page,
  }) => {
    await openFixture(page, 'suggest-images');
    const before = await page.screenshot();
    const result = startSelection(page);
    await expect.poll(() => overlayPresent(page)).toBe(true);
    const dimmed = await page.screenshot();
    expect(dimmed.equals(before)).toBe(false);
    expect(await hover(page, 380, 175)).toMatchObject({ rect: rect(280, 100, 200, 150) });
    // Highlighted: neither the untouched page nor the plain dim.
    const highlighted = await page.screenshot();
    expect(highlighted.equals(before)).toBe(false);
    expect(highlighted.equals(dimmed)).toBe(false);
    await page.mouse.down();
    await page.mouse.up();
    await result;
    // …and pixel-identical to the untouched page once resolved.
    const after = await page.screenshot();
    expect(after.equals(before)).toBe(true);
  });

  test('a drag that starts on a highlighted image dismisses the highlight and selects manually', async ({
    page,
  }) => {
    const { result } = await open(page, 'suggest-images');
    expect(await hover(page, 60, 120)).toMatchObject({ rect: rect(40, 100, 200, 150) });
    await page.mouse.down();
    // Pressed, not yet a drag: the highlight is still up.
    expect(await page.evaluate(() => window.__stTest['current'])).not.toBeNull();
    await page.mouse.move(64, 120);
    // The first move past the slop dismissed it — synchronously, no frame awaited —
    // and only then did the drag rect appear.
    const log = await events(page);
    const dismissed = log.findIndex(([type, value]) => type === 'suggest' && value === null);
    const firstPaint = log.findIndex(([type]) => type === 'paint');
    expect(dismissed).toBeGreaterThan(-1);
    expect(firstPaint).toBe(dismissed + 1);
    expect(log[firstPaint]).toEqual(['paint', rect(60, 120, 4, 0)]);

    await page.mouse.move(700, 400, { steps: 6 });
    await page.mouse.up();
    // The manual rect, from the press point — not the image's bounds.
    expect(await result).toMatchObject({ x: 60, y: 120, width: 640, height: 280 });
    // Nothing was highlighted again while dragging across the other images.
    const after = await events(page);
    expect(after.slice(dismissed + 1).filter(([type]) => type === 'suggest')).toEqual([]);
  });

  test('a drag that starts on plain page behaves exactly as before, over images or not', async ({
    page,
  }) => {
    const { result } = await open(page, 'suggest-images');
    await page.mouse.move(250, 260); // the gutter between the two image rows
    await frames(page);
    await page.mouse.down();
    await page.mouse.move(600, 470, { steps: 5 });
    await page.mouse.up();
    expect(await result).toMatchObject({ x: 250, y: 260, width: 350, height: 210 });
    const log = await events(page);
    expect(log[0]).toEqual(['paint', rect(250, 260, 0, 0)]);
    expect(log.filter(([type]) => type === 'suggest')).toEqual([]);
  });

  test('a click with no highlight is a no-op; Esc then cancels', async ({ page }) => {
    const { result } = await open(page, 'suggest-images');
    await page.mouse.click(600, 530); // the caption
    await page.mouse.click(250, 260); // a gutter
    await page.mouse.click(28, 28); // a 16 px icon
    await frames(page);
    expect(await overlayPresent(page)).toBe(true);
    await cancel(page, result);
  });

  test('Esc cancels with a highlight showing', async ({ page }) => {
    await openFixture(page, 'suggest-images');
    const before = await page.screenshot();
    const result = startSelection(page);
    await expect.poll(() => overlayPresent(page)).toBe(true);
    expect(await hover(page, 380, 175)).not.toBeNull();
    await page.keyboard.press('Escape');
    expect(await result).toBeNull();
    expect(await overlayPresent(page)).toBe(false);
    expect((await page.screenshot()).equals(before)).toBe(true);
  });

  test('an abandoned drag puts the highlight back under the pointer', async ({ page }) => {
    const { result } = await open(page, 'suggest-images');
    expect(await hover(page, 380, 175)).not.toBeNull();
    await page.mouse.down();
    await page.mouse.move(500, 176, { steps: 3 }); // 120 px wide, 1 px tall: too thin to be a region
    expect(await page.evaluate(() => window.__stTest['current'])).toBeNull();
    await page.mouse.up();
    await frames(page);
    expect(await overlayPresent(page)).toBe(true);
    // The pointer came to rest in the gutter between two images: still nothing…
    expect(await page.evaluate(() => window.__stTest['current'])).toBeNull();
    // …and back over the image, the highlight returns.
    expect(await hover(page, 380, 175)).toMatchObject({ rect: rect(280, 100, 200, 150) });
    await cancel(page, result);
  });

  test('reports CSS px and the real devicePixelRatio on a 2× display', async ({ browser }) => {
    const context = await browser.newContext({
      deviceScaleFactor: 2,
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();
    const { result } = await open(page, 'suggest-images');
    await page.mouse.click(90, 530); // the fractional image
    expect(await result).toEqual({
      x: 40,
      y: 500,
      width: 101,
      height: 61,
      devicePixelRatio: 2,
      viewportWidth: 1280,
      viewportHeight: 720,
      innerWidth: 1280,
      innerHeight: 720,
    });
    await context.close();
  });

  test('with suggestions off nothing is highlighted, a click is a no-op and a drag works', async ({
    page,
  }) => {
    const { result } = await open(page, 'suggest-images', { suggestions: false });
    expect(await hover(page, 380, 175)).toBeNull();
    await page.mouse.click(380, 175);
    await frames(page);
    expect(await overlayPresent(page)).toBe(true);
    expect((await events(page)).filter(([type]) => type === 'suggest')).toEqual([]);
    await page.mouse.move(300, 120);
    await page.mouse.down();
    await page.mouse.move(400, 200, { steps: 3 });
    await page.mouse.up();
    expect(await result).toMatchObject({ x: 300, y: 120, width: 100, height: 80 });
  });
});

test.describe('region suggestions: cards', () => {
  test('a bordered card and a shadowed card are suggested from their text and padding', async ({
    page,
  }) => {
    const { result } = await open(page, 'suggest-cards');
    const bordered = { rect: rect(40, 40, 300, 200), kind: 'border', badge: '300 × 200' };
    expect(await hover(page, 120, 70)).toMatchObject(bordered); // the heading text
    expect(await hover(page, 48, 200)).toMatchObject(bordered); // the padding
    expect(await hover(page, 40, 140)).toMatchObject(bordered); // the border itself
    const shadowed = { rect: rect(380, 40, 300, 200), kind: 'shadow', badge: '300 × 200' };
    expect(await hover(page, 460, 100)).toMatchObject(shadowed);
    expect(await hover(page, 670, 230)).toMatchObject(shadowed);
    // Between the two cards: plain page.
    expect(await hover(page, 360, 140)).toBeNull();
    await cancel(page, result);
  });

  test('look-alikes are not boxes: an underline, top-and-bottom rules, a transparent border, a transparent shadow', async ({
    page,
  }) => {
    const { result } = await open(page, 'suggest-cards');
    expect(await hover(page, 100, 310)).toBeNull(); // #underlined
    expect(await hover(page, 100, 390)).toBeNull(); // #sided
    expect(await hover(page, 460, 310)).toBeNull(); // #ghost-border
    expect(await hover(page, 460, 390)).toBeNull(); // #ghost-shadow
    expect(await hover(page, 300, 610)).toBeNull(); // #tabbar: an offset-only shadow is a rule
    expect((await events(page)).filter(([type]) => type === 'suggest')).toEqual([]);
    await cancel(page, result);
  });

  test('bordered controls under the 48 px box floor are skipped for the card around them', async ({
    page,
  }) => {
    const { result } = await open(page, 'suggest-cards');
    const sizes = await page.evaluate(() =>
      ['card-button', 'card-input'].map((id) => {
        const r = document.getElementById(id)!.getBoundingClientRect();
        const cs = getComputedStyle(document.getElementById(id)!);
        return [r.width, r.height, cs.borderTopWidth, cs.borderTopStyle];
      }),
    );
    // Both really are bordered boxes; they are just control-sized.
    expect(sizes).toEqual([
      [90, 32, '1px', 'solid'],
      [160, 36, '1px', 'solid'],
    ]);
    const card = { rect: rect(40, 40, 300, 200), kind: 'border', promoted: false };
    expect(await hover(page, 100, 176)).toMatchObject(card); // on the button
    expect(await hover(page, 240, 176)).toMatchObject(card); // on the input
    await cancel(page, result);
  });

  test('a faint hairline and a three-sided panel are boxes', async ({ page }) => {
    const { result } = await open(page, 'suggest-cards');
    expect(await hover(page, 100, 500)).toMatchObject({
      rect: rect(40, 460, 300, 80),
      kind: 'border',
    });
    expect(await hover(page, 460, 500)).toMatchObject({
      rect: rect(380, 460, 300, 80),
      kind: 'border',
    });
    await cancel(page, result);
  });

  test('ancestor rule: an image with room around it suggests itself, its card’s padding the card', async ({
    page,
  }) => {
    const { result } = await open(page, 'suggest-cards');
    // #padded: card 720,280 300 × 200, 1 px border + 20 px padding → image at 741,301 200 × 120.
    expect(await hover(page, 840, 360)).toEqual({
      rect: rect(741, 301, 200, 120),
      kind: 'media',
      badge: '200 × 120',
      promoted: false,
    });
    expect(await hover(page, 980, 450)).toEqual({
      rect: rect(720, 280, 300, 200),
      kind: 'border',
      badge: '300 × 200',
      promoted: false,
    });
    await cancel(page, result);
  });

  test('edge promotion: an image filling its card leaves the card reachable within 8 px of its edge', async ({
    page,
  }) => {
    const { result } = await open(page, 'suggest-cards');
    // #flush: card 720,40 302 × 202 with a 1 px border; the image fills 721,41 300 × 200.
    const image = { rect: rect(721, 41, 300, 200), kind: 'media', promoted: false };
    const card = { rect: rect(720, 40, 302, 202), kind: 'border', promoted: true };
    // Without the rule the card's only hover area would be its own 1 px border:
    expect(
      await page.evaluate(() =>
        [721, 728, 870].map(
          (x) =>
            document.elementsFromPoint(x, 140).find((e) => e.localName !== 'snapping-turtle-region')
              ?.id,
        ),
      ),
    ).toEqual(['flush-img', 'flush-img', 'flush-img']);
    expect(await hover(page, 870, 140)).toMatchObject(image); // centre
    expect(await hover(page, 724, 140)).toMatchObject(card); // 4 px in from the left
    expect(await hover(page, 728, 140)).toMatchObject(card); // exactly 8 px
    expect(await hover(page, 729, 140)).toMatchObject(image); // 9 px: the image again
    expect(await hover(page, 1018, 140)).toMatchObject(card); // right
    expect(await hover(page, 870, 44)).toMatchObject(card); // top
    expect(await hover(page, 870, 238)).toMatchObject(card); // bottom
    expect(await hover(page, 870, 232)).toMatchObject(image);
    // And a click in the band captures the card.
    await page.mouse.click(724, 140);
    expect(await result).toMatchObject({ x: 720, y: 40, width: 302, height: 202 });
  });

  test('a card scrolled partly out of its pane suggests only the part that shows', async ({
    page,
  }) => {
    const { result } = await open(page, 'suggest-cards');
    const full = await page.evaluate(() => {
      const r = document.getElementById('pane-card')!.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    });
    expect(full).toEqual({ top: -10, bottom: 390 }); // the element's own box runs past the pane
    expect(await hover(page, 1150, 140)).toMatchObject({
      rect: rect(1070, 40, 160, 200),
      kind: 'border',
    });
    await cancel(page, result);
  });
});

test.describe('region suggestions: the conservative contract', () => {
  test('a plain-text page yields zero suggestions, and no click anywhere on it captures', async ({
    page,
  }) => {
    const { result } = await open(page, 'suggest-plain');
    // Every 40 px across the whole viewport: 32 × 18 = 576 points. A press
    // evaluates the point synchronously, so each one is really decided.
    for (let y = 20; y < 720; y += 40) {
      for (let x = 20; x < 1280; x += 40) await page.mouse.click(x, y);
    }
    await frames(page);
    // And a hover pass over the text column.
    for (let y = 30; y < 720; y += 30) expect(await hover(page, 640, y)).toBeNull();
    expect(await overlayPresent(page)).toBe(true);
    const log = await events(page);
    expect(log.filter(([type]) => type === 'suggest')).toEqual([]);
    // Every click was the old "click without a drag": the overlay stayed up.
    expect(log.filter(([type, value]) => type === 'paint' && value === null).length).toBe(576);
    await cancel(page, result);
  });

  test('a near-viewport container is skipped; a card inside it is still suggested', async ({
    page,
  }) => {
    const { result } = await open(page, 'suggest-frame');
    const coverage = await page.evaluate(() => {
      const r = document.getElementById('frame')!.getBoundingClientRect();
      return (r.width * r.height) / (innerWidth * innerHeight);
    });
    expect(coverage).toBeGreaterThan(0.9);
    expect(await hover(page, 100, 50)).toBeNull(); // the wrapper's own text
    expect(await hover(page, 900, 600)).toBeNull(); // the wrapper's empty space
    expect(await hover(page, 12, 300)).toBeNull(); // the wrapper's border
    expect(await hover(page, 300, 240)).toEqual({
      rect: rect(212, 212, 320, 180),
      kind: 'border',
      badge: '320 × 180',
      promoted: false,
    });
    await cancel(page, result);
  });
});

test.describe('region suggestions: hostile page CSS', () => {
  test('the highlight renders inside the closed shadow root regardless, and a click captures', async ({
    page,
  }) => {
    await openFixture(page, 'hostile-css');
    // One pixel inside the card and one on the highlight's outline, just right of the card.
    const inside = { x: 150, y: 450, width: 1, height: 1 };
    const outline = { x: 301, y: 450, width: 1, height: 1 };
    const pageInside = await page.screenshot({ clip: inside });
    const pageOutline = await page.screenshot({ clip: outline });

    const result = startSelection(page);
    await expect.poll(() => overlayPresent(page)).toBe(true);
    const dimInside = await page.screenshot({ clip: inside });
    const dimOutline = await page.screenshot({ clip: outline });
    expect(dimInside.equals(pageInside)).toBe(false);
    expect(dimOutline.equals(pageOutline)).toBe(false);

    expect(await hover(page, 150, 450)).toEqual({
      rect: rect(0, 350, 300, 200),
      kind: 'border',
      badge: '300 × 200',
      promoted: false,
    });
    // The dim lifts inside the suggestion: the card looks exactly as on the bare page…
    expect((await page.screenshot({ clip: inside })).equals(pageInside)).toBe(true);
    // …and its outline is drawn: neither the bare page nor the plain dim.
    const highlightOutline = await page.screenshot({ clip: outline });
    expect(highlightOutline.equals(pageOutline)).toBe(false);
    expect(highlightOutline.equals(dimOutline)).toBe(false);
    // Nothing of ours is reachable from the page.
    expect(
      await page.evaluate(() => {
        const host = document.querySelector('snapping-turtle-region')!;
        return { closed: host.shadowRoot === null, children: host.childNodes.length };
      }),
    ).toEqual({ closed: true, children: 0 });

    await page.mouse.down();
    await page.mouse.up();
    expect(await result).toMatchObject({ x: 0, y: 350, width: 300, height: 200 });
    expect((await page.screenshot({ clip: inside })).equals(pageInside)).toBe(true);
    expect((await page.screenshot({ clip: outline })).equals(pageOutline)).toBe(true);
    // Bubble-phase page listeners saw none of the hover or the click.
    const seen = await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen);
    expect(seen).toEqual([]);
  });
});
