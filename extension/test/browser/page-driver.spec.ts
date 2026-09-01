import { expect, openFixture, test } from './fixtures.js';

/**
 * The full-page driver in plain pages: measurement across doc-height quirks
 * and lazy loading, the computed-style fixed/sticky finder, hide/restore
 * fidelity, instant scrolling under `scroll-behavior: smooth`, and — the one
 * that matters most — restoration when a mid-capture step throws.
 */

test.describe('measurePage', () => {
  test('reports the document extent, viewport, inner size, dpr and scroll position', async ({
    page,
  }) => {
    await openFixture(page, 'long-page');
    await page.evaluate(() => window.scrollTo(0, 1234));
    const m = await page.evaluate(() => window.__stHarness.measurePage(window));
    expect(m).toEqual({
      documentWidth: 1280,
      documentHeight: 12_000,
      viewportWidth: 1280,
      viewportHeight: 720,
      innerWidth: 1280,
      innerHeight: 720,
      devicePixelRatio: 1,
      scrollX: 0,
      scrollY: 1234,
    });
  });

  test('quirks mode: documentElement lies about the height; the max of both is right', async ({
    page,
  }) => {
    await openFixture(page, 'quirks');
    const m = await page.evaluate(() => ({
      mode: document.compatMode,
      htmlScrollHeight: document.documentElement.scrollHeight,
      bodyScrollHeight: document.body.scrollHeight,
      measured: window.__stHarness.measurePage(window).documentHeight,
    }));
    expect(m.mode).toBe('BackCompat');
    expect(m.measured).toBe(4000);
    expect(m.measured).toBe(Math.max(m.htmlScrollHeight, m.bodyScrollHeight));
  });

  test('a lazy-loading page grows as it is scrolled; re-measuring sees it', async ({ page }) => {
    await openFixture(page, 'lazy-load');
    const initial = await page.evaluate(
      () => window.__stHarness.measurePage(window).documentHeight,
    );
    expect(initial).toBe(4 * 602 + 10);
    await page.evaluate(() => {
      const d = new window.__stHarness.PageDriver(window);
      d.begin();
      return d.scrollTo(100_000);
    });
    await expect
      .poll(() => page.evaluate(() => window.__stHarness.measurePage(window).documentHeight))
      .toBeGreaterThan(initial);
    // scrollTo reports where the page really landed, not what was asked for
    // (measured in the same task, before the observer appends yet more).
    const r = await page.evaluate(() => {
      const landed = new window.__stHarness.PageDriver(window).scrollTo(99_999);
      const m = window.__stHarness.measurePage(window);
      return { landed: landed.scrollY, max: m.documentHeight - m.viewportHeight };
    });
    expect(r.landed).toBe(r.max);
    expect(r.landed).toBeGreaterThan(initial - 720);
  });
});

test.describe('fixed/sticky handling', () => {
  test('finds fixed and sticky elements by computed style, including in open shadow roots', async ({
    page,
  }) => {
    await openFixture(page, 'sticky-header');
    const ids = await page.evaluate(() =>
      window.__stHarness.findFixedElements(document).map((el) => el.id),
    );
    expect(ids.sort()).toEqual(['aside', 'footer', 'header', 'inline-visible', 'pinned']);
  });

  test('hideElements sets visibility hidden !important and restores the exact prior inline value', async ({
    page,
  }) => {
    await openFixture(page, 'sticky-header');
    const result = await page.evaluate(() => {
      const els = window.__stHarness.findFixedElements(document);
      const restore = window.__stHarness.hideElements(els);
      const hidden = els.map((el) => [
        el.id,
        getComputedStyle(el).visibility,
        el.style.getPropertyPriority('visibility'),
      ]);
      restore();
      const after = els.map((el) => [
        el.id,
        getComputedStyle(el).visibility,
        el.style.getPropertyValue('visibility'),
      ]);
      return { hidden, after };
    });
    for (const [, visibility, priority] of result.hidden) {
      expect(visibility).toBe('hidden');
      expect(priority).toBe('important');
    }
    for (const [id, visibility, inline] of result.after) {
      expect(visibility).toBe('visible');
      expect(inline).toBe(id === 'inline-visible' ? 'visible' : '');
    }
  });
});

test.describe('PageDriver', () => {
  test('begin scrolls to the top instantly despite scroll-behavior: smooth, scrollTo reports the landing spot, restore puts it back', async ({
    page,
  }) => {
    await openFixture(page, 'sticky-header');
    await page.evaluate(() => window.scrollTo({ top: 1234, behavior: 'instant' }));
    const r = await page.evaluate(() => {
      const d = new window.__stHarness.PageDriver(window);
      const metrics = d.begin();
      const atTop = window.scrollY;
      const mid = d.scrollTo(800);
      const clamped = d.scrollTo(1_000_000);
      const hidden = d.hideFixed();
      const headerHidden = getComputedStyle(document.getElementById('header')!).visibility;
      d.restore();
      d.restore(); // idempotent
      return {
        originalScrollY: metrics.scrollY,
        atTop,
        mid: mid.scrollY,
        clamped: clamped.scrollY,
        max: document.documentElement.scrollHeight - document.documentElement.clientHeight,
        hidden,
        headerHidden,
        restoredScrollY: window.scrollY,
        headerAfter: getComputedStyle(document.getElementById('header')!).visibility,
      };
    });
    expect(r.originalScrollY).toBe(1234);
    expect(r.atTop).toBe(0);
    expect(r.mid).toBe(800);
    expect(r.clamped).toBe(r.max);
    expect(r.hidden).toBe(5);
    expect(r.headerHidden).toBe('hidden');
    expect(r.restoredScrollY).toBe(1234);
    expect(r.headerAfter).toBe('visible');
  });

  test('withPageDriver restores scroll and hidden elements when a mid-capture step throws', async ({
    page,
  }) => {
    await openFixture(page, 'sticky-header');
    await page.evaluate(() => window.scrollTo({ top: 900, behavior: 'instant' }));
    const r = await page.evaluate(async () => {
      let midState: { scrollY: number; header: string } | null = null;
      let error = '';
      try {
        await window.__stHarness.withPageDriver(window, async (d) => {
          d.begin();
          d.scrollTo(2000);
          d.hideFixed();
          midState = {
            scrollY: window.scrollY,
            header: getComputedStyle(document.getElementById('header')!).visibility,
          };
          throw new Error('boom mid-capture');
        });
      } catch (err) {
        error = (err as Error).message;
      }
      return {
        error,
        midState,
        scrollY: window.scrollY,
        header: getComputedStyle(document.getElementById('header')!).visibility,
        aside: getComputedStyle(document.getElementById('aside')!).visibility,
        inlineVisible: document
          .getElementById('inline-visible')!
          .style.getPropertyValue('visibility'),
      };
    });
    expect(r.error).toBe('boom mid-capture');
    expect(r.midState).toEqual({ scrollY: 2000, header: 'hidden' });
    expect(r.scrollY).toBe(900);
    expect(r.header).toBe('visible');
    expect(r.aside).toBe('visible');
    expect(r.inlineVisible).toBe('visible');
  });

  test('withPageDriver restores on success and on a rejected promise alike', async ({ page }) => {
    await openFixture(page, 'sticky-header');
    await page.evaluate(() => window.scrollTo({ top: 300, behavior: 'instant' }));
    const r = await page.evaluate(async () => {
      const value = await window.__stHarness.withPageDriver(window, (d) => {
        d.begin();
        d.scrollTo(1500);
        d.hideFixed();
        return 'ok';
      });
      const afterSuccess = window.scrollY;
      let rejected = '';
      await window.__stHarness
        .withPageDriver(window, (d) => {
          d.begin();
          d.hideFixed();
          return Promise.reject(new Error('rejected'));
        })
        .catch((err: Error) => (rejected = err.message));
      return {
        value,
        afterSuccess,
        rejected,
        afterReject: window.scrollY,
        footer: getComputedStyle(document.getElementById('footer')!).visibility,
      };
    });
    expect(r).toEqual({
      value: 'ok',
      afterSuccess: 300,
      rejected: 'rejected',
      afterReject: 300,
      footer: 'visible',
    });
  });
});
