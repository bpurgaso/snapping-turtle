import { expect, test, type Page } from '@playwright/test';

/**
 * Pages served by the real server against the built bundle, under the
 * production CSP. No database is needed: `/`, `/login` and a signed-out
 * `/account` (whose /me call is answered 401 before any query) never touch it.
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
  test('home renders from the server bundle with no CSP violations', async ({ page }) => {
    const { violations, errors } = watch(page);
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
    expect(response?.headers()['content-security-policy']).toContain("default-src 'self'");
    expect(response?.headers()['referrer-policy']).toBe('no-referrer');
    expect(response?.headers()['x-robots-tag']).toBe('noindex, nofollow');

    await expect(page.getByRole('heading', { name: 'snapping-turtle' })).toBeVisible();
    await expect(page.locator('.meta')).toContainText('annotation schema v1');
    await expect(page.locator('.meta')).toContainText('32,000 px');
    await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    const display = await page.locator('body').evaluate((b) => getComputedStyle(b).display);
    expect(display).toBe('grid');

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
