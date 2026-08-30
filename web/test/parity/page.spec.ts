import { expect, test } from '@playwright/test';

test.describe('placeholder page under production CSP', () => {
  test('renders from the server bundle with no CSP violations', async ({ page }) => {
    const violations: string[] = [];
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
      if (/Content Security Policy/i.test(msg.text())) violations.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(err.message));

    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
    expect(response?.headers()['content-security-policy']).toContain("default-src 'self'");
    expect(response?.headers()['referrer-policy']).toBe('no-referrer');
    expect(response?.headers()['x-robots-tag']).toBe('noindex, nofollow');

    // The script executed (DOM populated from shared constants) and CSS applied.
    await expect(page.getByRole('heading', { name: 'snapping-turtle' })).toBeVisible();
    await expect(page.locator('.meta')).toContainText('annotation schema v1');
    await expect(page.locator('.meta')).toContainText('32,000 px');
    const display = await page.locator('body').evaluate((b) => getComputedStyle(b).display);
    expect(display).toBe('grid');

    expect(violations).toEqual([]);
    expect(errors).toEqual([]);
  });
});
