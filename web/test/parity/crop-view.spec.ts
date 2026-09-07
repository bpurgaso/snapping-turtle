import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

/**
 * The editor's two views of a crop (E6, PLAN.md §9): collapsed to the crop in
 * normal mode, the whole original in crop mode. Three guarantees, each
 * checked through the real editor under the production CSP:
 *
 * 1. Drawing while collapsed stores original-space coordinates — the test
 *    that guards the E4 invariant against silent document corruption.
 * 2. A shape outside the crop is invisible collapsed, visible in crop mode,
 *    and widening the crop brings it back without any change to the shapes.
 * 3. The crop's interior renders pixel-identically in both views: the
 *    effective-width sizes do not depend on the view, so nothing but the
 *    viewport changes at a transition.
 *
 * Requires DATABASE_URL (the webServer seeds the e2e-owner account).
 */
const hasDb = !!process.env['DATABASE_URL'];
const OWNER = { username: 'e2e-owner', password: 'e2e-owner-password-not-real-1' };
const IMAGE = { width: 800, height: 500 };
const CROP = { x: 200, y: 100, w: 400, h: 300 };
/** A rect wholly outside CROP (left of it), in original-image pixels. */
const OUTSIDE = { id: 'outside', type: 'rect', x: 20, y: 20, w: 120, h: 60 } as const;
/** A rect inside the crop, so both views have something to compare. */
const INSIDE = { id: 'inside', type: 'rect', x: 300, y: 180, w: 160, h: 90 } as const;

type Doc = { rev: number; shapes: Array<Record<string, unknown>>; crop?: typeof CROP };

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

/** Upload an 800×500 capture with visible structure and store `doc` on it through the owner API. */
async function seed(page: Page, context: BrowserContext, name: string, doc: Omit<Doc, 'rev'>) {
  const login = await context.request.post('/api/v1/auth/login', { data: OWNER });
  expect(login.status()).toBe(200);
  const csrf = ((await login.json()) as { csrfToken: string }).csrfToken;
  const tokenRes = await context.request.post('/api/v1/tokens', {
    data: { name },
    headers: { 'x-csrf-token': csrf },
  });
  const token = ((await tokenRes.json()) as { token: string }).token;
  await page.goto('/');
  const dataUrl = await page.evaluate(
    ([w, h]) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d')!;
      const grad = g.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, '#dbe4ff');
      grad.addColorStop(1, '#8fa3d9');
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#333a56';
      for (let i = 0; i < 6; i++) g.fillRect(60 + i * 120, 40 + (i % 3) * 140, 70, 50);
      return c.toDataURL('image/png');
    },
    [IMAGE.width, IMAGE.height] as const,
  );
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
  const path = new URL(((await upload.json()) as { pageUrl: string }).pageUrl).pathname;
  const viewId = path.split('/').pop()!;
  const put = await context.request.put(`/api/v1/captures/${viewId}/annotations`, {
    data: { version: 1, rev: 0, ...doc },
    headers: { 'x-csrf-token': csrf },
  });
  expect(put.status()).toBe(200);
  const getDoc = async (): Promise<Doc> =>
    (await (await context.request.get(`/api/v1/captures/${viewId}/annotations`)).json()) as Doc;
  return { path, viewId, getDoc };
}

/** The lower (scene) canvas as decoded pixels — what the owner sees, controls excluded. */
async function scene(page: Page): Promise<PNG> {
  const dataUrl = await page
    .locator('#editor-root canvas.lower-canvas')
    .evaluate((c) => (c as HTMLCanvasElement).toDataURL('image/png'));
  return PNG.sync.read(Buffer.from(dataUrl.split(',')[1]!, 'base64'));
}

/**
 * The scene once a view transition has rendered: Fabric resizes the canvas
 * synchronously but paints on the next animation frame, so wait for the
 * expected size *and* for annotation ink to be present.
 */
async function settledScene(page: Page, size: [number, number]): Promise<PNG> {
  let png!: PNG;
  await expect
    .poll(
      async () => {
        png = await scene(page);
        return [png.width, png.height, redPixels(png) > 0];
      },
      { timeout: 10_000 },
    )
    .toEqual([size[0], size[1], true]);
  return png;
}

/**
 * Count annotation-red pixels (#e03131) in a region — also under the crop
 * shade, which darkens everything outside the crop by 45% in crop mode: the
 * hue test is red-dominant and dark-green/blue, so a dimmed stroke still
 * counts and a dimmed light background never does.
 */
function redPixels(png: PNG, region = { x: 0, y: 0, w: png.width, h: png.height }): number {
  let n = 0;
  for (let y = region.y; y < region.y + region.h; y++) {
    for (let x = region.x; x < region.x + region.w; x++) {
      const i = (y * png.width + x) * 4;
      const [r, g, b] = [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!];
      if (r > 100 && g < 60 && b < 60 && r > 2 * g) n++;
    }
  }
  return n;
}

const outDir = fileURLToPath(new URL('../../test-results/crop-view-diffs/', import.meta.url));
mkdirSync(outDir, { recursive: true });

test.describe('crop views: collapsed vs crop mode (E6)', () => {
  test.skip(!hasDb, 'requires DATABASE_URL for a seeded server');
  // 800 px fits 1:1 in this viewport in both views, so canvas pixels are image pixels.
  test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

  test('a shape drawn while collapsed is stored in original-space coordinates', async ({
    page,
    context,
  }) => {
    const { violations, errors } = watch(page);
    const { path, getDoc } = await seed(page, context, 'e6-collapsed-draw', {
      shapes: [],
      crop: CROP,
    });
    await page.goto(path);
    const canvas = page.locator('#editor-root canvas.upper-canvas');
    await expect(canvas).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rectangle' })).toBeVisible();

    // Collapsed: the canvas element is crop-sized.
    const box = (await canvas.boundingBox())!;
    expect([Math.round(box.width), Math.round(box.height)]).toEqual([CROP.w, CROP.h]);

    // Drag a rectangle in canvas coordinates (50,40) → (250,200).
    await page.getByRole('button', { name: 'Rectangle' }).click();
    await page.mouse.move(box.x + 50, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 250, box.y + 200, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await getDoc()).shapes.length, { timeout: 10_000 }).toBe(1);
    await expect(page.locator('.save-state')).toHaveText('Saved');

    // Stored in original-image pixels: offset by the crop, never rebased to it.
    const doc = await getDoc();
    const rect = doc.shapes[0] as { type: string; x: number; y: number; w: number; h: number };
    expect(rect.type).toBe('rect');
    expect(Math.abs(rect.x - (CROP.x + 50))).toBeLessThanOrEqual(2);
    expect(Math.abs(rect.y - (CROP.y + 40))).toBeLessThanOrEqual(2);
    expect(Math.abs(rect.w - 200)).toBeLessThanOrEqual(3);
    expect(Math.abs(rect.h - 160)).toBeLessThanOrEqual(3);
    expect(doc.crop).toEqual(CROP); // the crop itself is untouched by drawing
    expect(violations).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('an out-of-crop shape is hidden collapsed, visible in crop mode, and reappears when the crop is widened — shapes unchanged', async ({
    page,
    context,
  }) => {
    const { violations, errors } = watch(page);
    const { path, getDoc } = await seed(page, context, 'e6-widen', {
      shapes: [OUTSIDE, INSIDE],
      crop: CROP,
    });
    const before = await getDoc();
    await page.goto(path);
    const canvas = page.locator('#editor-root canvas.upper-canvas');
    await expect(canvas).toBeVisible();

    // Collapsed: only the inside rect paints; the canvas has no room for the outside one.
    let png = await settledScene(page, [CROP.w, CROP.h]);
    const insideOnCanvas = {
      x: INSIDE.x - CROP.x - 6,
      y: INSIDE.y - CROP.y - 6,
      w: INSIDE.w + 12,
      h: INSIDE.h + 12,
    };
    expect(redPixels(png, insideOnCanvas)).toBeGreaterThan(200);
    expect(redPixels(png)).toBe(redPixels(png, insideOnCanvas)); // no red anywhere else

    // Crop mode: the whole original, the outside rect visible where it lives.
    await page.getByRole('button', { name: 'Crop' }).click();
    await expect(page.getByRole('button', { name: 'Apply crop' })).toBeVisible();
    png = await settledScene(page, [IMAGE.width, IMAGE.height]);
    const outsideRegion = {
      x: OUTSIDE.x - 6,
      y: OUTSIDE.y - 6,
      w: OUTSIDE.w + 12,
      h: OUTSIDE.h + 12,
    };
    expect(redPixels(png, outsideRegion)).toBeGreaterThan(200);
    // Nothing was saved to get here: revision and shapes are as seeded.
    expect(await getDoc()).toEqual(before);

    // Widen: drag the frame's top-left handle from the crop corner to the image corner.
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + CROP.x, box.y + CROP.y);
    await page.mouse.down();
    await page.mouse.move(box.x + 4, box.y + 4, { steps: 10 });
    await page.mouse.up();
    await page.getByRole('button', { name: 'Apply crop' }).click();
    await expect
      .poll(async () => JSON.stringify((await getDoc()).crop), { timeout: 10_000 })
      .not.toBe(JSON.stringify(CROP));
    await expect(page.locator('.save-state')).toHaveText('Saved');

    // The crop grew to include the outside rect; the shapes did not change at all.
    const after = await getDoc();
    expect(after.crop!.x).toBeLessThanOrEqual(OUTSIDE.x);
    expect(after.crop!.y).toBeLessThanOrEqual(OUTSIDE.y);
    expect(after.crop!.x + after.crop!.w).toBe(CROP.x + CROP.w);
    expect(after.crop!.y + after.crop!.h).toBe(CROP.y + CROP.h);
    expect(after.shapes).toEqual(before.shapes);
    expect(after.rev).toBe(before.rev + 1);

    // Collapsed again, now wide enough: the once-hidden rect paints at its original place.
    png = await settledScene(page, [after.crop!.w, after.crop!.h]);
    expect(
      redPixels(png, {
        x: OUTSIDE.x - after.crop!.x - 6,
        y: OUTSIDE.y - after.crop!.y - 6,
        w: OUTSIDE.w + 12,
        h: OUTSIDE.h + 12,
      }),
    ).toBeGreaterThan(200);
    expect(violations).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('the crop interior renders identically in both views (effective-width sizes are view-independent)', async ({
    page,
    context,
  }) => {
    const { violations, errors } = watch(page);
    const { path, getDoc } = await seed(page, context, 'e6-parity', {
      shapes: [
        INSIDE,
        { id: 'arrow', type: 'arrow', x1: 260, y1: 360, x2: 520, y2: 300 },
        { id: 'text', type: 'text', x: 320, y: 300, text: 'Same in both', fontSize: 21 },
      ],
      crop: CROP,
    });
    const before = await getDoc();
    await page.goto(path);
    await expect(page.locator('#editor-root canvas.upper-canvas')).toBeVisible();
    const collapsed = await settledScene(page, [CROP.w, CROP.h]);

    await page.getByRole('button', { name: 'Crop' }).click();
    await expect(page.getByRole('button', { name: 'Apply crop' })).toBeVisible();
    const full = await settledScene(page, [IMAGE.width, IMAGE.height]);

    // Compare the crop's interior, leaving a margin for the frame's chrome:
    // crop mode draws the frame's 2 px border along the crop edge and its
    // 12 px handles centred on the corners and edge midpoints (6 px inward).
    const m = 8;
    const w = CROP.w - 2 * m;
    const h = CROP.h - 2 * m;
    const a = new PNG({ width: w, height: h });
    const b = new PNG({ width: w, height: h });
    PNG.bitblt(collapsed, a, m, m, w, h, 0, 0);
    PNG.bitblt(full, b, CROP.x + m, CROP.y + m, w, h, 0, 0);
    const diff = new PNG({ width: w, height: h });
    const differing = pixelmatch(a.data, b.data, diff.data, w, h, { threshold: 0.1 });
    // Always keep the evidence: both views and the diff, like the parity suite.
    writeFileSync(`${outDir}collapsed.png`, PNG.sync.write(a));
    writeFileSync(`${outDir}crop-mode.png`, PNG.sync.write(b));
    writeFileSync(`${outDir}diff.png`, PNG.sync.write(diff));
    expect(differing, `${differing} of ${w * h} interior pixels differ between views`).toBe(0);
    // Stroke and text ink is present in both (the comparison is not of two blanks).
    expect(redPixels(a)).toBeGreaterThan(500);

    // Cancel returns to the collapsed view; nothing was saved.
    await page.getByRole('button', { name: 'Cancel crop' }).click();
    await settledScene(page, [CROP.w, CROP.h]);
    expect(await getDoc()).toEqual(before);
    expect(violations).toEqual([]);
    expect(errors).toEqual([]);
  });
});
