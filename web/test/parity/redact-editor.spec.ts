import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { REDACTION_STYLE } from '@snapping-turtle/shared/annotations';
import { PNG } from 'pngjs';
import { fillLeakPixels, rgbAt } from '../../../server/test/helpers/measure.js';

/**
 * The Redact tool in the real editor (E9, PLAN.md §7/§9), under the
 * production CSP, on a capture with a crop so both E6 views are exercised:
 *
 * 1. A block drawn on the collapsed crop view is stored in original-image
 *    pixels as integers (the E6 coordinate invariant plus E9's outward
 *    rounding) and is listed under a rect drawn *before* it — the canvas
 *    stacking is the render order, so the rect's stroke shows over the block.
 * 2. WYSIWYG: while being drawn the block is translucent; on release it is
 *    exactly the fill, pixel for pixel, in the collapsed view and in crop mode
 *    alike, and so is what the flat route serves to everyone.
 * 3. Deleting the block like any other shape restores the pixels for viewers.
 *
 * Requires DATABASE_URL (the webServer seeds the e2e-owner account).
 */
const hasDb = !!process.env['DATABASE_URL'];
const OWNER = { username: 'e2e-owner', password: 'e2e-owner-password-not-real-1' };
const IMAGE = { width: 800, height: 500 };
const CROP = { x: 200, y: 100, w: 400, h: 300 };
const FILL = REDACTION_STYLE.fill;

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

/** Upload an 800×500 capture with no black pixel in it, and a crop, through the owner API. */
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
  const dataUrl = await page.evaluate(
    ([w, h]) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d')!;
      // Light checkerboard: every pixel far from black, 8 px cells.
      for (let y = 0; y < h; y += 8) {
        for (let x = 0; x < w; x += 8) {
          g.fillStyle = ((x + y) / 8) % 2 ? '#ffffff' : '#ffb070';
          g.fillRect(x, y, 8, 8);
        }
      }
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
    data: { version: 1, rev: 0, shapes: [], crop: CROP },
    headers: { 'x-csrf-token': csrf },
  });
  expect(put.status()).toBe(200);
  const getDoc = async (): Promise<Doc> =>
    (await (await context.request.get(`/api/v1/captures/${viewId}/annotations`)).json()) as Doc;
  const getFlat = async (): Promise<PNG> =>
    PNG.sync.read(await (await context.request.get(`${path}/image.png`)).body());
  return { path, viewId, getDoc, getFlat };
}

/** The lower (scene) canvas as decoded pixels — what the owner sees, controls excluded. */
async function scene(page: Page): Promise<PNG> {
  const dataUrl = await page
    .locator('#editor-root canvas.lower-canvas')
    .evaluate((c) => (c as HTMLCanvasElement).toDataURL('image/png'));
  return PNG.sync.read(Buffer.from(dataUrl.split(',')[1]!, 'base64'));
}

async function settledScene(
  page: Page,
  size: [number, number],
  ready: (png: PNG) => boolean,
): Promise<PNG> {
  let png!: PNG;
  await expect
    .poll(
      async () => {
        png = await scene(page);
        return [png.width, png.height, ready(png)];
      },
      { timeout: 10_000 },
    )
    .toEqual([size[0], size[1], true]);
  return png;
}

/** Exactly the fill *and* opaque: a transparent canvas pixel is "not painted yet", never the fill. */
const isFill = (png: PNG, x: number, y: number) => {
  const i = (y * png.width + x) * 4;
  return (
    png.data[i] === 0 && png.data[i + 1] === 0 && png.data[i + 2] === 0 && png.data[i + 3] === 255
  );
};
const isRed = (rgb: [number, number, number]) => rgb[0] === 224 && rgb[1] === 49 && rgb[2] === 49;

test.describe('redact tool (E9)', () => {
  test.skip(!hasDb, 'requires DATABASE_URL for a seeded server');

  test('draw under a rect on the collapsed view → integer original-space block, opaque in both views, deletable', async ({
    page,
    context,
  }) => {
    const { violations, errors } = watch(page);
    const { path, getDoc, getFlat } = await seed(page, context, 'e9-redact');
    await page.goto(path);
    const canvas = page.locator('#editor-root canvas.upper-canvas');
    await expect(canvas).toBeVisible();
    await expect(page.getByRole('button', { name: 'Redact' })).toBeVisible();
    // Collapsed to the crop at 1:1 (the viewport is wider than 400 px).
    await settledScene(page, [CROP.w, CROP.h], () => true);
    const box = (await canvas.boundingBox())!;
    expect(box.width).toBe(CROP.w);
    // Fabric paints the active object's selection controls on the scene
    // canvas; click an empty corner in Select mode to drop the selection
    // before sampling pixels. (590, 390) in the original is clear of everything.
    const deselect = async () => {
      await page.getByRole('button', { name: 'Select' }).click();
      const b = (await canvas.boundingBox())!;
      await page.mouse.click(b.x + b.width - 10, b.y + b.height - 10);
    };

    // 1. A rectangle first, so the block drawn afterwards must go *under* it.
    //    Canvas (30,70)–(200,150) → scene ≈ (230,170)–(400,250).
    await page.getByRole('button', { name: 'Rectangle' }).click();
    await page.mouse.move(box.x + 30, box.y + 70);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, box.y + 150, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await getDoc()).shapes.length, { timeout: 10_000 }).toBe(1);
    await expect(page.locator('.save-state')).toHaveText('Saved');
    await deselect();
    const rect = (await getDoc()).shapes.find((s) => s['type'] === 'rect')! as {
      x: number;
      y: number;
      w: number;
      h: number;
    };
    expect(rect).toBeDefined();
    // The rect's top edge in canvas rows: path at y + 3 (floor sizes at the 400 px effective width),
    // the white rim 3 px either side. A pointer lands on fractional scene coordinates, so the
    // stroke is antialiased across rows; a 3 px red core always has at least one fully covered row.
    const bandCenter = rect.y + 3 - CROP.y;
    const bandRows = { from: Math.floor(bandCenter - 5), to: Math.ceil(bandCenter + 5) }; // exclusive `to`
    const hasRedRow = (png: PNG, x: number, oy = 0) => {
      for (let y = bandRows.from + oy; y < bandRows.to + oy; y++)
        if (isRed(rgbAt(png, x, y))) return true;
      return false;
    };
    const beforeBlock = await settledScene(page, [CROP.w, CROP.h], (p) => hasRedRow(p, 100));

    // 2. The block: canvas (50,40)–(150,100) → scene ≈ (250,140)–(350,200), crossing the rect's top edge.
    await page.getByRole('button', { name: 'Redact' }).click();
    await page.mouse.move(box.x + 50, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 150, box.y + 100, { steps: 10 });
    // Mid-drag: translucent — the pixel inside is neither the fill nor what was there.
    const during = await settledScene(page, [CROP.w, CROP.h], (p) => {
      const rgb = rgbAt(p, 100, 55);
      const was = rgbAt(beforeBlock, 100, 55);
      return !isFill(p, 100, 55) && (rgb[0] !== was[0] || rgb[1] !== was[1] || rgb[2] !== was[2]);
    });
    expect(isFill(during, 100, 55)).toBe(false);
    await page.mouse.up();

    // Stored: an integer block in original-image pixels, offset by the crop, never rebased.
    await expect.poll(async () => (await getDoc()).shapes.length, { timeout: 10_000 }).toBe(2);
    await expect(page.locator('.save-state')).toHaveText('Saved');
    await deselect();
    const doc = await getDoc();
    const block = doc.shapes.find((s) => s['type'] === 'redact')! as {
      x: number;
      y: number;
      w: number;
      h: number;
    };
    expect(block).toBeDefined();
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(Number.isInteger(block[k]), k).toBe(true);
    expect(Math.abs(block.x - (CROP.x + 50))).toBeLessThanOrEqual(2);
    expect(Math.abs(block.y - (CROP.y + 40))).toBeLessThanOrEqual(2);
    expect(block.w).toBeGreaterThanOrEqual(100);
    expect(block.w).toBeLessThanOrEqual(102);
    expect(block.h).toBeGreaterThanOrEqual(60);
    expect(block.h).toBeLessThanOrEqual(62);
    // Covers at least the dragged rectangle (outward rounding, E9 §9).
    expect(block.x).toBeLessThanOrEqual(rect.x + 20 + 1);

    // Opaque at rest and under the rect: pure fill everywhere in the block except
    // the rect's stroke band, where the red core shows over it. Edges included.
    const bx = block.x - CROP.x;
    const by = block.y - CROP.y;
    const checkOpaque = (png: PNG, ox: number, oy: number, label: string) => {
      const regions = [
        { x: bx + ox, y: by + oy, w: block.w, h: bandRows.from - by }, // above the band
        { x: bx + ox, y: bandRows.to + oy, w: block.w, h: by + block.h - bandRows.to }, // below the band
      ];
      for (const region of regions) {
        expect(region.h).toBeGreaterThan(10);
        const leak = fillLeakPixels(png, region, FILL);
        expect(
          leak.leaked,
          `${label}: ${leak.leaked} leaked in ${JSON.stringify(region)}, first ${JSON.stringify(leak.first)}`,
        ).toBe(0);
      }
      expect(hasRedRow(png, 100 + ox, oy), `${label}: rect stroke over the block`).toBe(true);
      // Just outside the block is the picture, not the fill.
      expect(isFill(png, bx - 1 + ox, by + 5 + oy), label).toBe(false);
      expect(isFill(png, bx + block.w + ox, by + 5 + oy), label).toBe(false);
      expect(isFill(png, bx + 5 + ox, by - 1 + oy), label).toBe(false);
      expect(isFill(png, bx + 5 + ox, by + block.h + oy), label).toBe(false);
    };
    const inside = { x: bx + 10, y: by + 5 };
    const collapsed = await settledScene(page, [CROP.w, CROP.h], (p) =>
      isFill(p, inside.x, inside.y),
    );
    checkOpaque(collapsed, 0, 0, 'collapsed');

    // Crop mode: the whole original; the block is where it lives, still opaque, still under the rect.
    await page.getByRole('button', { name: 'Crop' }).click();
    await expect(page.getByRole('button', { name: 'Apply crop' })).toBeVisible();
    const full = await settledScene(page, [IMAGE.width, IMAGE.height], (p) =>
      isFill(p, inside.x + CROP.x, inside.y + CROP.y),
    );
    checkOpaque(full, CROP.x, CROP.y, 'crop mode');
    await page.getByRole('button', { name: 'Cancel crop' }).click();
    await settledScene(page, [CROP.w, CROP.h], (p) => isFill(p, inside.x, inside.y));

    // What everyone gets: the flat render, redacted the same way (cropped output).
    const served = await getFlat();
    expect([served.width, served.height]).toEqual([CROP.w, CROP.h]);
    checkOpaque(served, 0, 0, 'served flat');

    // A reload rebuilds the canvas through renderOrder(): same stacking, same pixels.
    await page.reload();
    await expect(canvas).toBeVisible();
    const reloaded = await settledScene(page, [CROP.w, CROP.h], (p) =>
      isFill(p, inside.x, inside.y),
    );
    checkOpaque(reloaded, 0, 0, 'after reload');

    // 3. Delete it like any shape: click inside the block but above the rect's box.
    const box2 = (await canvas.boundingBox())!;
    await page.mouse.click(box2.x + bx + 50, box2.y + by + 10);
    await page.getByRole('button', { name: 'Delete shape' }).click();
    await expect.poll(async () => (await getDoc()).shapes.length, { timeout: 10_000 }).toBe(1);
    await expect(page.locator('.save-state')).toHaveText('Saved');
    expect((await getDoc()).shapes[0]!['type']).toBe('rect');
    const restored = await getFlat();
    const top = { x: bx, y: by, w: block.w, h: bandRows.from - by };
    expect(fillLeakPixels(restored, top, FILL).leaked).toBe(top.w * top.h);
    const scene2 = await settledScene(
      page,
      [CROP.w, CROP.h],
      (p) => !isFill(p, inside.x, inside.y),
    );
    expect(isFill(scene2, inside.x, inside.y)).toBe(false);

    // Undo brings the block back — an ordinary shape, an ordinary undo step.
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await getDoc()).shapes.length, { timeout: 10_000 }).toBe(2);
    await settledScene(page, [CROP.w, CROP.h], (p) => isFill(p, inside.x, inside.y));

    expect(violations).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('a drag below the minimum size stores nothing', async ({ page, context }) => {
    const { violations, errors } = watch(page);
    const { path, getDoc } = await seed(page, context, 'e9-redact-tiny');
    await page.goto(path);
    const canvas = page.locator('#editor-root canvas.upper-canvas');
    await expect(canvas).toBeVisible();
    await settledScene(page, [CROP.w, CROP.h], () => true);
    const box = (await canvas.boundingBox())!;
    await page.getByRole('button', { name: 'Redact' }).click();
    await page.mouse.move(box.x + 80, box.y + 80);
    await page.mouse.down();
    await page.mouse.move(box.x + 82, box.y + 82, { steps: 2 });
    await page.mouse.up();
    // The tool returns to Select; nothing was committed and nothing is saved.
    await expect(page.getByRole('button', { name: 'Select' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.waitForTimeout(1500); // longer than the autosave debounce
    expect((await getDoc()).shapes).toEqual([]);
    await expect(page.locator('.save-state')).toHaveText('Saved');
    expect(violations).toEqual([]);
    expect(errors).toEqual([]);
  });
});
