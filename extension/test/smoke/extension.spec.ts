import { defaultOrigin, expect, test } from './fixtures.js';

const FAKE_TOKEN = 'st_FAKEFAKEFAKEFAKEFAKEFAKEFAK';

test.describe('built Chrome extension', () => {
  test('loads with the generated manifest and a live background worker', async ({
    context,
    extensionId,
  }) => {
    expect(extensionId).toMatch(/^[a-p]{32}$/);
    const [worker] = context.serviceWorkers();
    expect(worker?.url()).toBe(`chrome-extension://${extensionId}/background.js`);
  });

  test('popup: three live modes with hints, no console errors', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(`chrome-extension://${extensionId}/popup/index.html`);

    await expect(page.getByRole('heading', { name: 'snapping-turtle' })).toBeVisible();
    const buttons = page.locator('.modes button');
    await expect(buttons).toHaveCount(3);
    await expect(buttons.nth(0)).toContainText('Visible');
    await expect(buttons.nth(1)).toContainText('Region');
    await expect(buttons.nth(1)).toContainText('drag to select');
    await expect(buttons.nth(2)).toContainText('Full page');
    await expect(buttons.nth(2)).toContainText('scrolls the whole page');
    await expect(page.locator('.modes')).not.toContainText('coming in M6');
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();

    // Opened as a tab, the popup's "active tab" is itself (chrome-extension://),
    // which is exactly the restricted-page path: a clear message, every mode disabled.
    await expect(page.locator('#status')).toContainText("Can't capture this page");
    for (let i = 0; i < 3; i++) await expect(buttons.nth(i)).toBeDisabled();
    expect(errors).toEqual([]);
  });

  test('a failure sets the "!" badge and a last error the popup shows once, then clears', async ({
    context,
    extensionId,
  }) => {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options/index.html`);
    // Drive the background exactly as the popup would, against a restricted tab
    // (this options tab). No server or gesture needed: it fails before capture.
    const response = await options.evaluate(async () => {
      const tab = await chrome.tabs.getCurrent();
      return chrome.runtime.sendMessage({
        type: 'capture',
        mode: 'visible',
        tabId: tab!.id,
        windowId: tab!.windowId,
      }) as Promise<{ ok: boolean; message?: string }>;
    });
    expect(response.ok).toBe(false);
    await expect.poll(() => options.evaluate(() => chrome.action.getBadgeText({}))).toBe('!');
    expect(await options.evaluate(() => chrome.action.getTitle({}))).toContain(response.message!);
    const stored = await options.evaluate(() => chrome.storage.local.get(null));
    expect(stored['lastError']).toMatchObject({
      message: response.message,
      at: expect.any(Number),
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await expect(popup.locator('#last-error')).toBeVisible();
    await expect(popup.locator('#last-error')).toHaveText(
      `Last capture failed just now: ${response.message}`,
    );
    await expect.poll(() => popup.evaluate(() => chrome.action.getBadgeText({}))).toBe('');
    expect(await popup.evaluate(() => chrome.action.getTitle({}))).toBe('snapping-turtle');
    await expect
      .poll(() => popup.evaluate(async () => (await chrome.storage.local.get(null))['lastError']))
      .toBeUndefined();

    // Next open: nothing to show.
    await popup.reload();
    await expect(popup.locator('#last-error')).toBeHidden();
  });

  test('options: pre-filled default origin, save round-trips through storage.local', async ({
    context,
    extensionId,
  }) => {
    const origin = defaultOrigin();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(`chrome-extension://${extensionId}/options/index.html`);

    const originInput = page.getByLabel('Server address');
    const tokenInput = page.getByLabel('API token');
    await expect(originInput).toHaveValue(origin);
    await expect(tokenInput).toHaveValue('');
    await expect(tokenInput).toHaveAttribute('type', 'password');
    await expect(page.getByRole('link', { name: 'Open account page' })).toHaveAttribute(
      'href',
      `${origin}/account`,
    );

    // Save with the default origin: already granted, so no permission prompt.
    await tokenInput.fill(FAKE_TOKEN);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#status')).toHaveText(`Saved. Captures will upload to ${origin}.`);

    const stored = await page.evaluate(() => chrome.storage.local.get(null));
    expect(stored).toEqual({ serverOrigin: origin, apiToken: FAKE_TOKEN });
    const synced = await page.evaluate(() => chrome.storage.sync.get(null));
    expect(synced).toEqual({});

    await page.reload();
    await expect(page.getByLabel('Server address')).toHaveValue(origin);
    await expect(page.getByLabel('API token')).toHaveValue(FAKE_TOKEN);

    // The popup now sees a token and stops nagging.
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await expect(popup.locator('#status')).not.toContainText('Set your server address');
    expect(errors).toEqual([]);
  });

  test('options: invalid origins fail closed and leave storage untouched', async ({
    context,
    extensionId,
  }) => {
    const origin = defaultOrigin();
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options/index.html`);
    const originInput = page.getByLabel('Server address');
    const status = page.locator('#status');

    await page.getByLabel('API token').fill(FAKE_TOKEN);
    for (const [bad, pattern] of [
      ['http://shots.example.com', /must use https/],
      ['shots.example.com', /Not a valid URL/],
      ['https://shots.example.com/app', /bare origin/],
      ['', /Enter your server address/],
    ] as const) {
      await originInput.fill(bad);
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(status).toHaveText(pattern);
      expect(await page.evaluate(() => chrome.storage.local.get(null))).toEqual({});
    }

    await originInput.fill(origin);
    await page.getByLabel('API token').fill('');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(status).toContainText('Paste the API token');
    expect(await page.evaluate(() => chrome.storage.local.get(null))).toEqual({});
  });

  test('options: Test connection sends the bearer token to /api/v1/ping and reports 204 / 401', async ({
    context,
    extensionId,
  }) => {
    const origin = defaultOrigin();
    const seen: Array<{ method: string; auth: string | undefined }> = [];
    let nextStatus = 204;
    await context.route(`${origin}/api/v1/ping`, async (route) => {
      const req = route.request();
      seen.push({ method: req.method(), auth: req.headers()['authorization'] });
      await route.fulfill({ status: nextStatus, body: '' });
    });

    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options/index.html`);
    await page.getByLabel('API token').fill(FAKE_TOKEN);
    const status = page.locator('#status');

    await page.getByRole('button', { name: 'Test connection' }).click();
    await expect(status).toHaveText('Connected: the server accepted this token.');
    expect(seen).toEqual([{ method: 'GET', auth: `Bearer ${FAKE_TOKEN}` }]);

    nextStatus = 401;
    await page.getByRole('button', { name: 'Test connection' }).click();
    await expect(status).toContainText('The server rejected this token');

    // Testing does not save.
    expect(await page.evaluate(() => chrome.storage.local.get(null))).toEqual({});
  });
});
