import { readBuiltManifest, expect, test } from './fixtures.js';

/**
 * Against a real local server. Skipped unless both are set:
 *   ST_E2E_ORIGIN  the running server, and the origin dist/chrome was built for
 *                  (PUBLIC_ORIGIN=http://localhost:3000 pnpm build:chrome)
 *   ST_E2E_TOKEN   a live API token on that server
 *
 * What this proves: the options page talks to the real GET /api/v1/ping with
 * the real token (204 → connected, corrupted token → 401 → rejected), and a
 * popup capture request reaches the background, resolves the tab, passes the
 * restricted-page check and loads the saved settings. What it cannot prove:
 * `captureVisibleTab` itself — Chrome requires activeTab (a toolbar click or
 * keyboard shortcut) or <all_urls>; a specific host permission is not enough,
 * and Playwright cannot produce that gesture. So the last assertion pins the
 * flow to exactly that boundary; the gesture path is extension/TESTING.md §2.
 */
const origin = process.env['ST_E2E_ORIGIN'];
const token = process.env['ST_E2E_TOKEN'];

test.describe('against a local server', () => {
  test.skip(!origin || !token, 'set ST_E2E_ORIGIN and ST_E2E_TOKEN to run');

  test('Test connection hits the real ping endpoint: live token 204, corrupted token 401', async ({
    context,
    extensionId,
  }) => {
    expect(readBuiltManifest().host_permissions, `rebuild with PUBLIC_ORIGIN=${origin}`).toEqual([
      `${origin}/*`,
    ]);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options/index.html`);
    await expect(page.getByLabel('Server address')).toHaveValue(origin!);
    const status = page.locator('#status');

    await page.getByLabel('API token').fill(token!);
    await page.getByRole('button', { name: 'Test connection' }).click();
    await expect(status).toHaveText('Connected: the server accepted this token.');

    await page
      .getByLabel('API token')
      .fill(token!.slice(0, -1) + (token!.endsWith('A') ? 'B' : 'A'));
    await page.getByRole('button', { name: 'Test connection' }).click();
    await expect(status).toContainText('The server rejected this token');
  });

  test('a capture request is routed to the background and stops only at the activeTab gesture', async ({
    context,
    extensionId,
  }) => {
    const target = await context.newPage();
    await target.goto(`${origin}/login`);
    await expect(target.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options/index.html`);
    await options.getByLabel('API token').fill(token!);
    await options.getByRole('button', { name: 'Save' }).click();
    await expect(options.locator('#status')).toContainText('Saved.');

    await target.bringToFront();
    const response = await options.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url: `${url}/login` });
      return chrome.runtime.sendMessage({
        type: 'capture',
        mode: 'visible',
        tabId: tab!.id,
        windowId: tab!.windowId,
      }) as Promise<{ ok: boolean; pageUrl?: string; code?: string; message?: string }>;
    }, origin);

    if (response.ok) {
      // Only reachable with a real gesture; keep the strong assertions for that case.
      expect(response.pageUrl).toMatch(new RegExp(`^${origin}/s/[A-Za-z0-9_-]{27}$`));
      return;
    }
    // No gesture available to Playwright: everything before captureVisibleTab passed
    // (tab lookup, restricted check, settings/token), and the error is Chrome's own.
    expect(response.code).toBe('failed');
    expect(response.message).toMatch(/^Capture failed: .*activeTab/);
    expect(response.message).not.toContain(token!);
  });

  test('a restricted tab is refused before any capture or upload is attempted', async ({
    context,
    extensionId,
  }) => {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options/index.html`);
    await options.getByLabel('API token').fill(token!);
    await options.getByRole('button', { name: 'Save' }).click();
    await expect(options.locator('#status')).toContainText('Saved.');
    // The options tab itself is chrome-extension:// — a restricted page.
    const response = await options.evaluate(async () => {
      const tab = await chrome.tabs.getCurrent();
      return chrome.runtime.sendMessage({
        type: 'capture',
        mode: 'visible',
        tabId: tab!.id,
        windowId: tab!.windowId,
      }) as Promise<{ ok: boolean; code?: string; message?: string }>;
    });
    expect(response).toMatchObject({ ok: false, code: 'restricted' });
    expect(response.message).toMatch(/^Can't capture this page/);
  });
});
