import { defaultOrigin, expect, test } from './fixtures.js';

/**
 * M6 region and full-page flows inside the real built extension, driven up to
 * the one step no automation can pass: the activeTab gesture. The fixture
 * page is served on the build-time default origin, for which the manifest
 * carries a host permission, so `scripting.executeScript` and
 * `tabs.sendMessage` work; `captureVisibleTab` then fails exactly where the
 * manual checklist takes over (extension/TESTING.md §5–6). What this proves:
 * the content bundle loads and answers the driver protocol in a real content
 * script, the two-phase region result reaches the background, the full-page
 * run injects, scrolls, fails at capture, restores the page and reports on
 * both channels.
 */
const FAKE_TOKEN = 'st_FAKEFAKEFAKEFAKEFAKEFAKEFAK';

const FIXTURE = `<!doctype html><html><head><style>
  html,body{margin:0} .band{height:400px} .band:nth-child(odd){background:#c33} .band:nth-child(even){background:#39c}
  header{position:fixed;top:0;left:0;right:0;height:50px;background:#222}
</style></head><body><header id="h"></header>${'<div class="band"></div>'.repeat(20)}</body></html>`;

test.describe('M6 flows in the built extension', () => {
  test('content script injects, answers the driver protocol, and restores on st:page:restore', async ({
    context,
    extensionId,
  }) => {
    const origin = defaultOrigin();
    await context.route(`${origin}/m6-fixture`, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE }),
    );
    const target = await context.newPage();
    await target.goto(`${origin}/m6-fixture`);
    await target.evaluate(() => window.scrollTo(0, 777));

    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options/index.html`);
    const r = await options.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      const tabId = tab!.id!;
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      // Injecting twice must not register a second listener (one reply, not two).
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      const begin = await chrome.tabs.sendMessage(tabId, { type: 'st:page:begin' });
      const scrolled = await chrome.tabs.sendMessage(tabId, { type: 'st:page:scroll', y: 1200 });
      const hidden = await chrome.tabs.sendMessage(tabId, { type: 'st:page:hide-fixed' });
      const bogus = await chrome.tabs.sendMessage(tabId, { type: 'st:page:scroll', y: -5 });
      const restored = await chrome.tabs.sendMessage(tabId, { type: 'st:page:restore' });
      const orphan = await chrome.tabs.sendMessage(tabId, { type: 'st:page:scroll', y: 10 });
      return { begin, scrolled, hidden, bogus, restored, orphan };
    }, `${origin}/m6-fixture`);

    expect(r.begin).toMatchObject({
      type: 'st:page:metrics',
      metrics: { documentHeight: 8000, scrollY: 777, devicePixelRatio: 1 },
    });
    expect(r.scrolled).toEqual({
      type: 'st:page:scrolled',
      scrollX: 0,
      scrollY: 1200,
      cancelled: false,
    });
    expect(r.hidden).toEqual({ type: 'st:page:hidden', count: 1 });
    // A malformed command is ignored by the guard: no reply at all.
    expect(r.bogus).toBeUndefined();
    expect(r.restored).toEqual({ type: 'st:page:restored' });
    expect(r.orphan).toEqual({ type: 'st:error', message: 'no capture in progress' });
    expect(await target.evaluate(() => window.scrollY)).toBe(777);
    expect(
      await target.evaluate(() => getComputedStyle(document.getElementById('h')!).visibility),
    ).toBe('visible');
  });

  test('region: overlay mounts, a drag reaches the background, which stops at the gesture boundary', async ({
    context,
    extensionId,
  }) => {
    const origin = defaultOrigin();
    await context.route(`${origin}/m6-fixture`, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE }),
    );
    const target = await context.newPage();
    await target.goto(`${origin}/m6-fixture`);
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options/index.html`);
    await options.evaluate((token) => chrome.storage.local.set({ apiToken: token }), FAKE_TOKEN);
    const started = await options.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      await chrome.scripting.executeScript({ target: { tabId: tab!.id! }, files: ['content.js'] });
      return chrome.tabs.sendMessage(tab!.id!, { type: 'st:region:select' });
    }, `${origin}/m6-fixture`);
    expect(started).toEqual({ type: 'st:region:started' });

    await target.bringToFront();
    await expect
      .poll(() => target.evaluate(() => document.querySelector('snapping-turtle-region') !== null))
      .toBe(true);
    await target.mouse.move(100, 100);
    await target.mouse.down();
    await target.mouse.move(300, 250, { steps: 4 });
    await target.mouse.up();
    await expect
      .poll(() => target.evaluate(() => document.querySelector('snapping-turtle-region') !== null))
      .toBe(false);

    // The selection reached the background; captureVisibleTab is where activeTab bites.
    await expect.poll(() => options.evaluate(() => chrome.action.getBadgeText({}))).toBe('!');
    const stored = await options.evaluate(() => chrome.storage.local.get(null));
    expect(stored['lastError']).toMatchObject({
      message: expect.stringMatching(/^Capture failed: /),
    });
    expect(String((stored['lastError'] as { message: string }).message)).toMatch(
      /activeTab|all_urls/,
    );
  });

  test('full page: a capture request starts the stitch, which fails at the gesture and restores the page', async ({
    context,
    extensionId,
  }) => {
    const origin = defaultOrigin();
    await context.route(`${origin}/m6-fixture`, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE }),
    );
    const target = await context.newPage();
    await target.goto(`${origin}/m6-fixture`);
    await target.evaluate(() => window.scrollTo(0, 555));
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options/index.html`);
    await options.evaluate((token) => chrome.storage.local.set({ apiToken: token }), FAKE_TOKEN);
    await target.bringToFront();

    const response = await options.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      return chrome.runtime.sendMessage({
        type: 'capture',
        mode: 'full',
        tabId: tab!.id,
        windowId: tab!.windowId,
      });
    }, `${origin}/m6-fixture`);
    expect(response).toEqual({ ok: true, status: 'started' });

    await expect
      .poll(() => options.evaluate(() => chrome.action.getBadgeText({})), { timeout: 10_000 })
      .toBe('!');
    const stored = await options.evaluate(() => chrome.storage.local.get(null));
    expect(stored['lastError']).toMatchObject({
      message: expect.stringMatching(/^Full-page capture failed: /),
    });
    expect(stored['lastMode']).toBe('full');
    // The finally path put the page back.
    expect(await target.evaluate(() => window.scrollY)).toBe(555);
    expect(
      await target.evaluate(() => getComputedStyle(document.getElementById('h')!).visibility),
    ).toBe('visible');
    // And the lock was released: a second request is not refused as busy.
    const again = await options.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      return chrome.runtime.sendMessage({
        type: 'capture',
        mode: 'full',
        tabId: tab!.id,
        windowId: tab!.windowId,
      });
    }, `${origin}/m6-fixture`);
    expect(again).toEqual({ ok: true, status: 'started' });
  });
});
