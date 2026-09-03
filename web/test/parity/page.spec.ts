import { expect, test, type Page } from '@playwright/test';

/**
 * Pages served by the real server against the built bundle, under the
 * production CSP. No database is needed: `/` (server-rendered from
 * updates.json and config, E2), `/login` and a signed-out `/account` (whose
 * /me call is answered 401 before any query) never touch it.
 */
function watch(page: Page) {
  const violations: string[] = [];
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
    if (/Content Security Policy/i.test(msg.text())) violations.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return { violations, errors };
}

test.describe('static pages under production CSP', () => {
  test('home renders both install cards with no CSP violations, emphasising the visitor\'s browser', async ({
    page,
  }) => {
    const { violations, errors } = watch(page);
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
    expect(response?.headers()['content-security-policy']).toContain("default-src 'self'");
    expect(response?.headers()['referrer-policy']).toBe('no-referrer');
    expect(response?.headers()['x-robots-tag']).toBe('noindex, nofollow');

    await expect(page.getByRole('heading', { name: 'snapping-turtle' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Install the extension' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    const display = await page.locator('body').evaluate((b) => getComputedStyle(b).display);
    expect(display).toBe('grid');

    // Both cards are always present, whatever is published or configured (E2).
    const firefox = page.locator('.browser[data-browser="firefox"]');
    const chrome = page.locator('.browser[data-browser="chrome"]');
    await expect(firefox).toBeVisible();
    await expect(chrome).toBeVisible();
    // The e2e server has no CHROME_EXTENSION_URL; Firefox depends on deploy/ext locally.
    await expect(chrome).toContainText('Coming soon');
    const firefoxLink = firefox.getByRole('link', { name: 'Install for Firefox' });
    if ((await firefoxLink.count()) > 0) {
      await expect(firefoxLink).toHaveAttribute('href', '/ext/firefox-latest');
    } else {
      await expect(firefox).toContainText('Not yet published');
    }

    // Chromium is the test browser: its card gets the emphasis, Firefox's stays visible.
    await expect(chrome).toHaveClass(/\byours\b/);
    await expect(chrome.locator('.badge')).toHaveText('your browser');
    await expect(firefox).not.toHaveClass(/\byours\b/);
    await expect(firefox.locator('.badge')).toHaveCount(0);
    const chromeBorder = await chrome.evaluate((el) => getComputedStyle(el).borderTopColor);
    const firefoxBorder = await firefox.evaluate((el) => getComputedStyle(el).borderTopColor);
    expect(chromeBorder).not.toBe(firefoxBorder);

    expect(violations).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('login page builds its form from script (no inline handlers)', async ({ page }) => {
    const { violations, errors } = watch(page);
    const response = await page.goto('/login');
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByLabel('Username')).toBeVisible();
    await expect(page.getByLabel('Password')).toHaveAttribute('type', 'password');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled();
    expect(violations).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('signed-out account page redirects to login', async ({ page }) => {
    const { violations } = watch(page);
    await page.goto('/account');
    await page.waitForURL('**/login');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    expect(violations).toEqual([]);
  });

  test('signed-out admin page carries the same headers and redirects to login', async ({
    page,
  }) => {
    const { violations } = watch(page);
    const response = await page.goto('/admin');
    expect(response?.status()).toBe(200);
    expect(response?.headers()['content-security-policy']).toContain("default-src 'self'");
    expect(response?.headers()['referrer-policy']).toBe('no-referrer');
    expect(response?.headers()['x-robots-tag']).toBe('noindex, nofollow');
    expect(response?.headers()['cache-control']).toBe('private, no-store');
    await page.waitForURL('**/login');
    expect(violations).toEqual([]);
  });
});
