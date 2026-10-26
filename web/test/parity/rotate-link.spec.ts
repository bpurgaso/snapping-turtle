import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Rotate link (E12, PLAN.md §6/§7) through the real editor under the
 * production CSP: the confirm step, the new link surfaced with a copy button,
 * the header's link fields re-targeted, the address bar rewritten, the old
 * URL dead into the uniform 404 and the new one serving the same image —
 * and a second tab left on the old URL that fails safe on its next save.
 *
 * Requires DATABASE_URL (the webServer seeds the e2e-owner account).
 */
const hasDb = !!process.env['DATABASE_URL'];
const OWNER = { username: 'e2e-owner', password: 'e2e-owner-password-not-real-1' };

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

async function seed(page: Page, context: BrowserContext, name: string) {
  const login = await context.request.post('/api/v1/auth/login', { data: OWNER });
  expect(login.status()).toBe(200);
  const csrf = ((await login.json()) as { csrfToken: string }).csrfToken;
  const tokenRes = await context.request.post('/api/v1/tokens', {
    data: { name },
    headers: { 'x-csrf-token': csrf },
  });
  const token = ((await tokenRes.json()) as { token: string }).token;
  await page.goto('/');
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 200;
    const g = c.getContext('2d')!;
    g.fillStyle = '#dbe4ff';
    g.fillRect(0, 0, 320, 200);
    g.fillStyle = '#333a56';
    g.fillRect(40, 40, 120, 60);
    return c.toDataURL('image/png');
  });
  const png = Buffer.from(dataUrl.split(',')[1]!, 'base64');
  const upload = await context.request.post('/api/v1/captures', {
    headers: { authorization: `Bearer ${token}` },
    multipart: {
      image: { name: 'shot.png', mimeType: 'image/png', buffer: png },
      sourceUrl: `https://example.com/${name}`,
      title: name,
    },
  });
  expect(upload.status()).toBe(201);
  const { pageUrl, imageUrl } = (await upload.json()) as { pageUrl: string; imageUrl: string };
  return { pageUrl, imageUrl, path: new URL(pageUrl).pathname };
}

test.describe('rotate link (E12)', () => {
  test.skip(!hasDb, 'requires DATABASE_URL for a seeded server');

  test('confirm → new link shown with a copy button, header and address re-targeted, old URL is the uniform 404', async ({
    page,
    context,
  }) => {
    const { violations, errors } = watch(page);
    const { pageUrl, imageUrl, path } = await seed(page, context, 'e12-rotate');
    const oldImageBytes = await (await context.request.get(imageUrl)).body();

    await page.goto(path);
    await expect(page.getByRole('button', { name: 'Rotate link' })).toBeVisible();
    await expect(page.locator('input[data-link="page"]')).toHaveValue(pageUrl);

    // Cancel first: nothing changes.
    page.once('dialog', (d) => {
      expect(d.message()).toContain('Everyone with the current link loses access');
      expect(d.message()).toContain('already posted it');
      void d.dismiss();
    });
    await page.getByRole('button', { name: 'Rotate link' }).click();
    await expect(page.locator('.rotated-link')).toBeHidden();
    expect((await context.request.get(path)).status()).toBe(200);

    // Accept: the new link appears once with its copy button.
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'Rotate link' }).click();
    const reveal = page.locator('.rotated-link');
    await expect(reveal).toBeVisible();
    await expect(reveal.getByRole('button', { name: 'Copy new link' })).toBeVisible();
    const newPageUrl = await reveal.locator('input').inputValue();
    expect(newPageUrl).not.toBe(pageUrl);
    expect(newPageUrl).toMatch(/\/s\/[A-Za-z0-9_-]{27}$/);
    await expect(page.locator('.save-state')).toHaveText(/Link rotated/);

    // The header's fields and copy targets, and the address bar, follow.
    await expect(page.locator('input[data-link="page"]')).toHaveValue(newPageUrl);
    await expect(page.locator('input[data-link="image"]')).toHaveValue(`${newPageUrl}/image.png`);
    await expect(page.locator('button[data-link="page"]')).toHaveAttribute('data-copy', newPageUrl);
    expect(page.url()).toBe(newPageUrl);

    // Old URL: uniform 404 on page and image; new URL: 200 with the same image bytes.
    const deadPage = await context.request.get(path);
    const deadImage = await context.request.get(imageUrl);
    expect(deadPage.status()).toBe(404);
    expect(deadImage.status()).toBe(404);
    expect(await deadPage.text()).toContain('There is nothing at this address.');
    const never = await context.request.get(`/s/${'A'.repeat(27)}`);
    expect(await deadPage.text()).toBe(await never.text());
    const newImage = await context.request.get(`${newPageUrl}/image.png`);
    expect(newImage.status()).toBe(200);
    expect((await newImage.body()).equals(oldImageBytes)).toBe(true);

    // The editor keeps working against the new id: a shape drawn now is saved.
    const canvas = page.locator('#editor-root canvas.upper-canvas');
    const box = (await canvas.boundingBox())!;
    await page.getByRole('button', { name: 'Rectangle' }).click();
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 90, { steps: 6 });
    await page.mouse.up();
    await expect(page.locator('.save-state')).toHaveText('Saved', { timeout: 10_000 });
    const newViewId = newPageUrl.slice(newPageUrl.lastIndexOf('/') + 1);
    const doc = (await (
      await context.request.get(`/api/v1/captures/${newViewId}/annotations`)
    ).json()) as {
      shapes: unknown[];
    };
    expect(doc.shapes).toHaveLength(1);

    expect(violations).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('a second tab left on the old URL fails safe: its next save reports the rotation and stops retrying', async ({
    page,
    context,
  }) => {
    const { violations, errors } = watch(page);
    const { path } = await seed(page, context, 'e12-stale-tab');
    await page.goto(path);
    await expect(page.getByRole('button', { name: 'Rectangle' })).toBeVisible();

    // Rotate from "another tab": the API on the same session (a second login
    // would replace the context's cookie and turn this into a CSRF test).
    const me = await context.request.get('/api/v1/auth/me');
    const csrf = ((await me.json()) as { csrfToken: string }).csrfToken;
    const viewId = path.slice('/s/'.length);
    const rotated = await context.request.post(`/api/v1/captures/${viewId}/rotate`, {
      headers: { 'x-csrf-token': csrf },
    });
    expect(rotated.status()).toBe(200);

    // This tab draws: the autosave hits the dead id.
    const canvas = page.locator('#editor-root canvas.upper-canvas');
    const box = (await canvas.boundingBox())!;
    await page.getByRole('button', { name: 'Rectangle' }).click();
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 90, { steps: 6 });
    await page.mouse.up();
    const status = page.locator('.save-state');
    await expect(status).toHaveText(/rotated or the capture was deleted/, { timeout: 10_000 });
    await expect(status).toHaveClass(/gone/);
    // Not "retrying": the message stays put through the retry interval.
    await page.waitForTimeout(6_000);
    await expect(status).toHaveText(/rotated or the capture was deleted/);
    // And the new id's document is untouched by the stale tab.
    const newPageUrl = ((await rotated.json()) as { pageUrl: string }).pageUrl;
    const newViewId = newPageUrl.slice(newPageUrl.lastIndexOf('/') + 1);
    const doc = (await (
      await context.request.get(`/api/v1/captures/${newViewId}/annotations`)
    ).json()) as {
      shapes: unknown[];
    };
    expect(doc.shapes).toHaveLength(0);
    expect(violations).toEqual([]);
    // Chromium reports the 404 the stale save received as a resource error; that is the point.
    expect(errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
  });
});
