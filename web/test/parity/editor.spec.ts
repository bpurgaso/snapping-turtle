import { expect, test, type Page } from '@playwright/test';

/**
 * M3 editor smoke: the owner logs in, opens their capture, drags out a
 * rectangle, autosave fires, and the annotation persists — verified through
 * the API, not the canvas. The whole flow runs under the production CSP
 * (no unsafe-inline / unsafe-eval), so any Fabric CSP violation fails here.
 *
 * Requires DATABASE_URL (the webServer then seeds the e2e-owner account);
 * skipped otherwise so the DB-free specs keep running alone.
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

test.describe('owner editor (M3)', () => {
  test.skip(!hasDb, 'requires DATABASE_URL for a seeded server');

  test('drag a rectangle → autosave → shape persisted via the API', async ({ page, context }) => {
    const { violations, errors } = watch(page);

    // Sign in; context.request shares the cookie jar with the page.
    const login = await context.request.post('/api/v1/auth/login', { data: OWNER });
    expect(login.status()).toBe(200);
    const csrf = ((await login.json()) as { csrfToken: string }).csrfToken;

    const tokenRes = await context.request.post('/api/v1/tokens', {
      data: { name: 'e2e-editor-smoke' },
      headers: { 'x-csrf-token': csrf },
    });
    expect(tokenRes.status()).toBe(201);
    const token = ((await tokenRes.json()) as { token: string }).token;

    // Build a PNG in the browser — no image deps needed in web/.
    await page.goto('/');
    const dataUrl = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 800;
      c.height = 500;
      const g = c.getContext('2d')!;
      g.fillStyle = '#dbe4ff';
      g.fillRect(0, 0, 800, 500);
      g.fillStyle = '#333a56';
      g.fillRect(40, 40, 300, 80);
      return c.toDataURL('image/png');
    });
    const png = Buffer.from(dataUrl.split(',')[1]!, 'base64');

    const upload = await context.request.post('/api/v1/captures', {
      headers: { authorization: `Bearer ${token}` },
      multipart: {
        image: { name: 'shot.png', mimeType: 'image/png', buffer: png },
        sourceUrl: 'https://example.com/e2e-editor',
        title: 'e2e editor smoke',
      },
    });
    expect(upload.status()).toBe(201);
    const pageUrl = ((await upload.json()) as { pageUrl: string }).pageUrl;
    const path = new URL(pageUrl).pathname;
    const viewId = path.split('/').pop()!;

    // The owner sees the editor; Fabric mounts an upper-canvas for interaction.
    await page.goto(path);
    const canvas = page.locator('#editor-root canvas.upper-canvas');
    await expect(canvas).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rectangle' })).toBeVisible();

    await page.getByRole('button', { name: 'Rectangle' }).click();
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + 60, box.y + 60);
    await page.mouse.down();
    await page.mouse.move(box.x + 260, box.y + 180, { steps: 8 });
    await page.mouse.up();

    // Autosave is debounced ~800 ms; poll the API until the shape lands.
    await expect
      .poll(
        async () => {
          const res = await context.request.get(`/api/v1/captures/${viewId}/annotations`);
          if (!res.ok()) return -1;
          return ((await res.json()) as { shapes: unknown[] }).shapes.length;
        },
        { timeout: 10_000 },
      )
      .toBe(1);

    const doc = (await (
      await context.request.get(`/api/v1/captures/${viewId}/annotations`)
    ).json()) as {
      rev: number;
      shapes: Array<{ type: string; w: number; h: number }>;
    };
    expect(doc.rev).toBeGreaterThanOrEqual(1);
    expect(doc.shapes[0]!.type).toBe('rect');
    expect(doc.shapes[0]!.w).toBeGreaterThan(100);
    expect(doc.shapes[0]!.h).toBeGreaterThan(60);

    await expect(page.locator('.save-state')).toHaveText('Saved');

    // Strict CSP held for the whole session (CLAUDE.md rule 6).
    expect(violations).toEqual([]);
    expect(errors).toEqual([]);
  });
});
