import { expect, openFixture, test } from './fixtures.js';
import {
  cancel,
  current,
  drag,
  events,
  frames,
  hover,
  lastPaint,
  lastSnap,
  metrics,
  NO_SNAP,
  open,
  overlayPresent,
  percentile,
  rect,
  scanned,
  startSelection,
} from './suggest-helpers.js';
import {
  HOVER_RESOLVE_BUDGET_MS,
  SCAN_NODE_CAP,
  SCAN_TIME_BUDGET_MS,
  SNAP_DISTANCE_CSS_PX,
} from '../../src/lib/structure-scan.js';

/**
 * The structure pre-scan (E11) in plain fixture pages — no extension APIs,
 * the M6/E7 pattern. The engine's rules are unit-tested
 * (test/structure-scan.test.ts); this proves the overlay reads real pages
 * into it: each candidate source, each precedence rule, the occlusion filter,
 * the dynamic rescan, the budgets on a heavy page (numbers printed), and
 * magnetic drag edges with their Alt escape. E7's own specs
 * (region-suggest.spec.ts) run unchanged against the same overlay — including
 * the plain-text page that must still yield zero.
 */

test.describe('structure: semantic units (zero visual styling)', () => {
  test('article, figure, table, pre, blockquote, aside and the ARIA equivalents are suggested from their text', async ({
    page,
  }) => {
    const { result } = await open(page, 'suggest-semantic');
    const semantic = (x: number, y: number, w: number, h: number) => ({
      rect: rect(x, y, w, h),
      kind: 'semantic',
      badge: `${w} × ${h}`,
      promoted: false,
    });
    expect(await hover(page, 100, 100), 'article').toEqual(semantic(40, 40, 360, 160));
    expect(await hover(page, 500, 215), 'figure, from its caption').toEqual(
      semantic(440, 40, 300, 200),
    );
    expect(await hover(page, 850, 100), 'table').toEqual(semantic(780, 40, 300, 120));
    expect(await hover(page, 100, 290), 'pre').toEqual(semantic(40, 240, 360, 100));
    expect(await hover(page, 500, 290), 'blockquote').toEqual(semantic(440, 240, 300, 100));
    expect(await hover(page, 850, 290), 'section with its own heading').toEqual(
      semantic(780, 240, 300, 100),
    );
    expect(await hover(page, 500, 430), 'section with an aria-label').toEqual(
      semantic(440, 380, 300, 100),
    );
    expect(await hover(page, 850, 430), 'named role=region').toEqual(semantic(780, 380, 300, 100));
    expect(await hover(page, 850, 540), 'aside').toEqual(semantic(780, 500, 300, 80));
    expect(await hover(page, 1150, 300), 'role=article').toEqual(semantic(1100, 260, 160, 100));
    await cancel(page, result);
  });

  test('the image in a figure is the image; its caption is the figure (smallest wins, media first)', async ({
    page,
  }) => {
    const { result } = await open(page, 'suggest-semantic');
    expect(await hover(page, 590, 125)).toEqual({
      rect: rect(460, 50, 260, 150),
      kind: 'media',
      badge: '260 × 150',
      promoted: false,
    });
    expect(await hover(page, 500, 215)).toMatchObject({ rect: rect(440, 40, 300, 200) });
    // A click on the table captures exactly the table.
    expect(await hover(page, 850, 100)).toMatchObject({ rect: rect(780, 40, 300, 120) });
    await page.mouse.down();
    await page.mouse.up();
    expect(await result).toMatchObject({ x: 780, y: 40, width: 300, height: 120 });
  });

  test('page chrome, a headless section, an unnamed region, a layout table and a bare div yield nothing', async ({
    page,
  }) => {
    const { result } = await open(page, 'suggest-semantic');
    expect(await hover(page, 100, 630), 'nav').toBeNull();
    expect(await hover(page, 500, 630), 'header').toBeNull();
    expect(await hover(page, 850, 630), 'footer').toBeNull();
    expect(await hover(page, 100, 430), 'section without a heading').toBeNull();
    expect(await hover(page, 100, 540), 'role=region without a name').toBeNull();
    expect(await hover(page, 500, 540), 'table role=presentation').toBeNull();
    expect(await hover(page, 1150, 100), 'a bare div of text').toBeNull();
    expect((await events(page)).filter(([type]) => type === 'suggest')).toEqual([]);
    await cancel(page, result);
  });

  test('a section owns only the headings whose nearest section it is', async ({ page }) => {
    const { result } = await open(page, 'suggest-semantic');
    const outer = { rect: rect(1100, 380, 160, 200), kind: 'semantic' };
    expect(await hover(page, 1150, 430)).toMatchObject(outer);
    // The inner section has no heading of its own: hovering it finds the outer one.
    expect(await hover(page, 1150, 530)).toMatchObject(outer);
    await cancel(page, result);
  });

  test('occlusion: what a fixed, transparent cover hides is never suggested', async ({ page }) => {
    const { result } = await open(page, 'suggest-semantic');
    expect(await hover(page, 100, 100)).toMatchObject({ rect: rect(40, 40, 360, 160) });
    // The right half of the article sits under #cover: the hit path is cover → body → html.
    expect(
      await page.evaluate(
        () =>
          document.elementsFromPoint(300, 100).find((e) => e.localName !== 'snapping-turtle-region')
            ?.id,
      ),
    ).toBe('cover');
    expect(await hover(page, 300, 100)).toBeNull();
    await cancel(page, result);
  });
});

test.describe('structure: repetition (grid and flex sets)', () => {
  test('an item suggests the item; the gutter and the padding suggest the set', async ({
    page,
  }) => {
    const { result } = await open(page, 'suggest-grid');
    const set = { rect: rect(40, 40, 680, 336), kind: 'set', badge: '680 × 336', promoted: false };
    expect(await hover(page, 100, 100)).toEqual({
      rect: rect(56, 56, 200, 140),
      kind: 'item',
      badge: '200 × 140',
      promoted: false,
    });
    expect(await hover(page, 380, 290)).toMatchObject({
      rect: rect(280, 220, 200, 140),
      kind: 'item',
    });
    expect(await hover(page, 268, 120), 'the column gap').toEqual(set);
    expect(await hover(page, 150, 208), 'the row gap').toEqual(set);
    expect(await hover(page, 48, 120), 'the padding').toEqual(set);
    // A click on an item captures the item.
    expect(await hover(page, 100, 100)).toMatchObject({ kind: 'item' });
    await page.mouse.down();
    await page.mouse.up();
    expect(await result).toMatchObject({ x: 56, y: 56, width: 200, height: 140 });
  });

  test('a flex row is a set too, exactly its items plus the gaps', async ({ page }) => {
    const { result } = await open(page, 'suggest-grid');
    expect(await hover(page, 140, 480)).toMatchObject({
      rect: rect(40, 420, 200, 120),
      kind: 'item',
    });
    expect(await hover(page, 250, 480)).toMatchObject({
      rect: rect(40, 420, 648, 120),
      kind: 'set',
    });
    await cancel(page, result);
  });

  test('edge promotion carries over: an image filling an item leaves the item reachable at its edge', async ({
    page,
  }) => {
    const { result } = await open(page, 'suggest-grid');
    expect(await hover(page, 604, 290)).toEqual({
      rect: rect(504, 220, 200, 140),
      kind: 'media',
      badge: '200 × 140',
      promoted: false,
    });
    // The image and the item share a box; 4 px inside the edge the item wins by promotion.
    expect(await hover(page, 508, 290)).toEqual({
      rect: rect(504, 220, 200, 140),
      kind: 'item',
      badge: '200 × 140',
      promoted: true,
    });
    await cancel(page, result);
  });

  test('two children, ragged children and a block container are not sets; in a mixed set only the uniform children are items', async ({
    page,
  }) => {
    const { result } = await open(page, 'suggest-grid');
    expect(await hover(page, 860, 100), 'two items').toBeNull();
    expect(await hover(page, 860, 260), 'ragged').toBeNull();
    expect(await hover(page, 960, 260), 'ragged').toBeNull();
    expect(await hover(page, 900, 350), 'block container').toBeNull();
    expect(await hover(page, 900, 410), 'block container').toBeNull();
    expect((await events(page)).filter(([type]) => type === 'suggest')).toEqual([]);
    expect(await hover(page, 815, 590)).toMatchObject({
      rect: rect(760, 540, 110, 100),
      kind: 'item',
    });
    expect(await hover(page, 1175, 560), 'the odd child falls to the set').toMatchObject({
      rect: rect(760, 540, 470, 100),
      kind: 'set',
    });
    await cancel(page, result);
  });
});

test.describe('structure: visual distinctness, judged once', () => {
  test('a background that differs from what is behind it, a gradient, a rounded shadowed box', async ({
    page,
  }) => {
    const { result } = await open(page, 'suggest-borderless');
    const bg = (x: number, y: number, w: number, h: number) => ({
      rect: rect(x, y, w, h),
      kind: 'background',
      badge: `${w} × ${h}`,
      promoted: false,
    });
    expect(await hover(page, 190, 130), 'a tinted card on white').toEqual(bg(40, 40, 300, 180));
    expect(await hover(page, 890, 140), 'a white card on a grey section').toEqual(
      bg(740, 60, 300, 160),
    );
    expect(await hover(page, 800, 270), 'the grey section itself').toEqual(bg(720, 40, 500, 300));
    expect(await hover(page, 530, 480), 'a gradient').toEqual(bg(380, 420, 300, 120));
    expect(await hover(page, 890, 480), 'a dark card on a dark section').toEqual(
      bg(740, 400, 300, 160),
    );
    expect(await hover(page, 800, 610), 'the dark section').toEqual(bg(720, 380, 500, 300));
    expect(await hover(page, 530, 630), 'a three-percent wash').toEqual(bg(380, 580, 300, 100));
    expect(await hover(page, 190, 320), 'radius plus an offset-only shadow').toEqual({
      rect: rect(40, 260, 300, 120),
      kind: 'rounded',
      badge: '300 × 120',
      promoted: false,
    });
    await cancel(page, result);
  });

  test('too faint, white on white, a radius alone and an offset-only shadow alone yield nothing', async ({
    page,
  }) => {
    const { result } = await open(page, 'suggest-borderless');
    expect(await hover(page, 530, 130), 'two shades off white').toBeNull();
    expect(await hover(page, 190, 630), 'white on white').toBeNull();
    expect(await hover(page, 530, 320), 'radius only').toBeNull();
    expect(await hover(page, 190, 480), 'offset-only shadow (E7)').toBeNull();
    expect(await hover(page, 1180, 90), 'a one-percent wash').toBeNull();
    expect((await events(page)).filter(([type]) => type === 'suggest')).toEqual([]);
    await cancel(page, result);
  });
});

test.describe('structure: the limits', () => {
  test('a canvas application yields zero suggestions: pixels, not elements', async ({ page }) => {
    const { result } = await open(page, 'suggest-canvas');
    for (let y = 40; y < 720; y += 80) {
      for (let x = 40; x < 1280; x += 80) await page.mouse.click(x, y);
    }
    await frames(page);
    for (let x = 60; x < 1280; x += 120) expect(await hover(page, x, 180)).toBeNull();
    expect(await overlayPresent(page)).toBe(true);
    const log = await events(page);
    expect(log.filter(([type]) => type === 'suggest')).toEqual([]);
    expect(log.filter(([type, value]) => type === 'paint' && value === null).length).toBe(144);
    // The one candidate the scan admits is the canvas itself (media, the floor
    // is applied at admission); the near-viewport ceiling rejects it at lookup.
    expect((await metrics(page))!.scan!.candidates).toBe(1);
    await cancel(page, result);
  });
});

test.describe('structure: dynamic pages', () => {
  test('cards appended, an article appended, a card removed and a class toggled all reach the index without leaving region mode', async ({
    page,
  }) => {
    const { result } = await open(page, 'suggest-feed');
    const scansBefore = (await metrics(page))!.scans;
    expect(await hover(page, 300, 100)).toMatchObject({
      rect: rect(40, 40, 600, 120),
      kind: 'item',
    });
    expect(await hover(page, 300, 500), 'below the third card: empty').toBeNull();

    // Append: the new card is an item within the throttle plus one scan.
    await page.evaluate(() => window.__feed.append(1));
    await page.mouse.move(300, 500);
    await expect
      .poll(() => current(page), { message: 'the appended card becomes suggestible' })
      .toMatchObject({ rect: rect(40, 448, 600, 120), kind: 'item' });

    // An article of another size is a semantic unit, not an item.
    await page.evaluate(() => window.__feed.appendArticle());
    await page.mouse.move(300, 620);
    await expect
      .poll(() => current(page))
      .toMatchObject({ rect: rect(40, 584, 600, 90), kind: 'semantic' });

    // Removal shifts everything up: the old rects are gone, the new ones found.
    await page.evaluate(() => window.__feed.remove('card-1'));
    await page.mouse.move(300, 500);
    await expect
      .poll(() => current(page), { message: 'the article moved up into the pointer' })
      .toMatchObject({ rect: rect(40, 448, 600, 90), kind: 'semantic' });
    await page.mouse.move(300, 620);
    await expect.poll(() => current(page)).toBeNull();

    // An attribute mutation re-reads the element's style.
    expect(await hover(page, 900, 150)).toBeNull();
    await page.evaluate(() => window.__feed.tint(true));
    await page.mouse.move(900, 150);
    await expect
      .poll(() => current(page))
      .toMatchObject({ rect: rect(700, 40, 400, 200), kind: 'background' });
    await page.evaluate(() => window.__feed.tint(false));
    await page.mouse.move(900, 150);
    await expect.poll(() => current(page)).toBeNull();

    const after = (await metrics(page))!;
    expect(after.scans).toBeGreaterThan(scansBefore);
    expect(after.scan).toMatchObject({ status: 'done' });
    expect(after.scan!.wallMs).toBeLessThanOrEqual(SCAN_TIME_BUDGET_MS);
    console.log(`[feed] rescans=${after.scans - scansBefore} last: ${JSON.stringify(after.scan)}`);
    await cancel(page, result);
  });
});

test.describe('structure: performance on a heavy DOM', () => {
  test('the scan completes within its budgets and a hover stays under the per-move budget (numbers printed)', async ({
    page,
  }) => {
    await openFixture(page, 'suggest-heavy');
    const shape = await page.evaluate(() => window.__heavy);
    expect(shape.elements).toBeGreaterThan(5000);
    expect(shape.inViewport).toBeGreaterThan(2000);

    const result = startSelection(page);
    await expect.poll(() => overlayPresent(page)).toBe(true);
    const first = await scanned(page);
    const scan = first.scan!;
    console.log(
      `[heavy] page: ${shape.elements} elements, ${shape.inViewport} in the viewport; ` +
        `first scan: ${JSON.stringify(scan)}`,
    );
    expect(scan.status).toBe('done');
    expect(scan.examined).toBeGreaterThan(2000);
    expect(scan.examined).toBeLessThanOrEqual(SCAN_NODE_CAP);
    // The feed's first post crosses the fold and is read; the other 299 are peeked, their 14 lines each never visited.
    expect(scan.peeked).toBeGreaterThanOrEqual(299);
    expect(scan.hidden).toBe(1);
    expect(scan.wallMs).toBeLessThanOrEqual(SCAN_TIME_BUDGET_MS);

    // What it found: every tile is an item, the dashboard is the set, the table a unit.
    expect(await hover(page, 100, 60)).toMatchObject({ rect: rect(44, 24, 112, 72), kind: 'item' });
    expect(await hover(page, 40, 200)).toMatchObject({
      rect: rect(36, 16, 1208, 488),
      kind: 'set',
    });
    expect(await hover(page, 600, 600)).toMatchObject({
      rect: expect.objectContaining({ x: 36, y: 500, width: 1200 }),
      kind: 'semantic',
    });

    // 120 hover evaluations across the dashboard, one per frame.
    for (let i = 0; i < 120; i++) {
      await page.mouse.move(60 + (i % 20) * 60, 30 + Math.floor(i / 20) * 80);
      await frames(page);
    }
    const after = (await metrics(page))!;
    const samples = after.hover.samples.slice(-120);
    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);
    const max = Math.max(...samples);
    console.log(
      `[heavy] hover: n=${samples.length} p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms max=${max.toFixed(3)}ms (budget ${HOVER_RESOLVE_BUDGET_MS}ms)`,
    );
    expect(samples.length).toBeGreaterThanOrEqual(100);
    expect(p95).toBeLessThanOrEqual(HOVER_RESOLVE_BUDGET_MS);

    // A rescan (after a scroll) reuses the cached styles and must also finish inside the budget.
    const scansBefore = after.scans;
    await page.evaluate(() => window.scrollBy(0, 200));
    await expect.poll(() => metrics(page).then((m) => m!.scans)).toBeGreaterThan(scansBefore);
    const rescan = (await metrics(page))!.scan!;
    console.log(`[heavy] rescan after scroll: ${JSON.stringify(rescan)}`);
    expect(rescan.status).toBe('done');
    expect(rescan.wallMs).toBeLessThanOrEqual(SCAN_TIME_BUDGET_MS);
    await cancel(page, result);
  });
});

test.describe('structure: magnetic drag edges', () => {
  test('the moving corner snaps to a candidate edge within the snap distance, and the result is the snapped rect', async ({
    page,
  }) => {
    const { result } = await open(page, 'suggest-cards');
    // #bordered is 40,40 300 × 200. The end point is 5 px past its right and bottom edges.
    expect(SNAP_DISTANCE_CSS_PX).toBe(6);
    await drag(page, { x: 30, y: 30 }, { x: 345, y: 245 });
    expect(await result).toMatchObject({ x: 30, y: 30, width: 310, height: 210 });
    expect(await lastSnap(page)).toEqual({ ...NO_SNAP, right: true, bottom: true });
  });

  test('the anchor corner snaps too, and edges beyond the distance do not', async ({ page }) => {
    const { result } = await open(page, 'suggest-cards');
    await drag(page, { x: 44, y: 44 }, { x: 600, y: 500 });
    expect(await result).toMatchObject({ x: 40, y: 40, width: 560, height: 460 });
    expect(await lastSnap(page)).toEqual({ ...NO_SNAP, left: true, top: true });
  });

  test('Alt held before the drag suppresses snapping entirely', async ({ page }) => {
    const { result } = await open(page, 'suggest-cards');
    await page.keyboard.down('Alt');
    await drag(page, { x: 30, y: 30 }, { x: 345, y: 245 });
    await page.keyboard.up('Alt');
    expect(await result).toMatchObject({ x: 30, y: 30, width: 315, height: 215 });
    expect(await lastSnap(page)).toEqual(NO_SNAP);
  });

  test('Alt pressed mid-drag releases the snapped edges at once, and releasing Alt snaps them again', async ({
    page,
  }) => {
    const { result } = await open(page, 'suggest-cards');
    await page.mouse.move(30, 30);
    await frames(page);
    await page.mouse.down();
    await page.mouse.move(345, 245, { steps: 4 });
    expect(await lastPaint(page)).toEqual(rect(30, 30, 310, 210));
    expect(await lastSnap(page)).toEqual({ ...NO_SNAP, right: true, bottom: true });
    await page.keyboard.down('Alt');
    expect(await lastPaint(page)).toEqual(rect(30, 30, 315, 215));
    expect(await lastSnap(page)).toEqual(NO_SNAP);
    await page.keyboard.up('Alt');
    expect(await lastPaint(page)).toEqual(rect(30, 30, 310, 210));
    await page.mouse.up();
    expect(await result).toMatchObject({ x: 30, y: 30, width: 310, height: 210 });
  });

  test('the M6 clamp drag on long-page: the edge at 1279 snaps to the band at 1280, unless Alt is held', async ({
    page,
  }) => {
    const first = await open(page, 'long-page');
    await drag(page, { x: 1200, y: 600 }, { x: 1279, y: 719 });
    expect(await first.result).toMatchObject({ x: 1200, y: 600, width: 80, height: 119 });
    expect(await lastSnap(page)).toEqual({ ...NO_SNAP, right: true });

    const second = await open(page, 'long-page');
    await page.keyboard.down('Alt');
    await drag(page, { x: 1200, y: 600 }, { x: 1279, y: 719 });
    await page.keyboard.up('Alt');
    expect(await second.result).toMatchObject({ x: 1200, y: 600, width: 79, height: 119 });
  });

  test('with the assist off nothing snaps and nothing is scanned', async ({ page }) => {
    const { result } = await open(page, 'suggest-cards', { suggestions: false });
    await drag(page, { x: 30, y: 30 }, { x: 345, y: 245 });
    expect(await result).toMatchObject({ x: 30, y: 30, width: 315, height: 215 });
    expect(await lastSnap(page)).toEqual(NO_SNAP);
    expect(await metrics(page)).toBeNull();
  });

  test('a snapped drag that covers a card exactly equals the card’s own suggestion rect', async ({
    page,
  }) => {
    const { result } = await open(page, 'suggest-cards');
    // Same outward-rounded boundaries both ways: #shadowed is 380,40 300 × 200.
    expect(await hover(page, 500, 100)).toMatchObject({ rect: rect(380, 40, 300, 200) });
    await drag(page, { x: 376, y: 36 }, { x: 684, y: 244 });
    expect(await result).toMatchObject({ x: 380, y: 40, width: 300, height: 200 });
    expect(await lastSnap(page)).toEqual({ left: true, top: true, right: true, bottom: true });
  });
});
