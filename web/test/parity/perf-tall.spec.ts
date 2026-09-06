import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

/**
 * Tall-canvas performance spike (§9, M3): load the maximum-dimension fixture
 * in the editor and measure load time, drag frame pacing, and JS heap.
 * Not part of the regular suites — run explicitly with:
 *   ST_PERF_FIXTURE=/path/tall.png DATABASE_URL=… pnpm --filter web test:parity
 * Findings are recorded in docs/perf-tall-canvas.md. ST_PERF_CROP=1 (E4)
 * stores a crop on the capture before the page loads, so the shade that dims
 * outside it is on the canvas for every measured frame.
 */
const fixture = process.env['ST_PERF_FIXTURE'];
const withCrop = process.env['ST_PERF_CROP'] === '1';
const hasDb = !!process.env['DATABASE_URL'];
const OWNER = { username: 'e2e-owner', password: 'e2e-owner-password-not-real-1' };

interface FrameStats {
  frames: number;
  avgMs: number;
  p95Ms: number;
  maxMs: number;
}

function stats(frames: number[]): FrameStats {
  const sorted = [...frames].sort((a, b) => a - b);
  const avg = frames.reduce((s, f) => s + f, 0) / Math.max(1, frames.length);
  return {
    frames: frames.length,
    avgMs: +avg.toFixed(1),
    p95Ms: +(sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(1),
    maxMs: +(sorted[sorted.length - 1] ?? 0).toFixed(1),
  };
}

test.use({
  // ST_PERF_DPR=2 measures the retina cost: canvas backing stores scale by dpr^2.
  deviceScaleFactor: Number(process.env['ST_PERF_DPR'] ?? 1),
  viewport: { width: 1280, height: 720 },
});

test.describe('tall canvas perf spike (manual)', () => {
  test.skip(!fixture || !hasDb, 'set ST_PERF_FIXTURE and DATABASE_URL to run the spike');

  test('load and drag on the max-dimension capture', async ({ page, context }) => {
    test.setTimeout(300_000);
    const login = await context.request.post('/api/v1/auth/login', { data: OWNER });
    expect(login.status()).toBe(200);
    const csrf = ((await login.json()) as { csrfToken: string }).csrfToken;
    const tokenRes = await context.request.post('/api/v1/tokens', {
      data: { name: 'perf-spike' },
      headers: { 'x-csrf-token': csrf },
    });
    const token = ((await tokenRes.json()) as { token: string }).token;

    const png = readFileSync(fixture!);
    const uploadStart = Date.now();
    const upload = await context.request.post('/api/v1/captures', {
      headers: { authorization: `Bearer ${token}` },
      multipart: {
        image: { name: 'tall.png', mimeType: 'image/png', buffer: png },
        sourceUrl: 'https://example.com/perf-tall',
        title: 'tall perf fixture',
      },
      timeout: 240_000,
    });
    expect(upload.status()).toBe(201);
    const uploadMs = Date.now() - uploadStart;
    const path = new URL(((await upload.json()) as { pageUrl: string }).pageUrl).pathname;

    if (withCrop) {
      // A crop well inside the image (PNG IHDR gives the size), stored through
      // the same PUT the editor uses; the editor then mounts with the shade.
      const width = png.readUInt32BE(16);
      const height = png.readUInt32BE(20);
      const crop = { x: 200, y: 400, w: width - 400, h: Math.min(3000, height - 800) };
      const put = await context.request.put(
        `/api/v1/captures/${path.split('/').pop()}/annotations`,
        {
          data: { version: 1, rev: 0, shapes: [], crop },
          headers: { 'x-csrf-token': csrf },
        },
      );
      expect(put.status()).toBe(200);
    }

    // Load: navigation until the interactive canvas exists and the original
    // image request has completed (the background is drawn from it, E4).
    const t0 = Date.now();
    const imageDone = page.waitForResponse((r) => r.url().endsWith('/original'), {
      timeout: 240_000,
    });
    await page.goto(path);
    const canvas = page.locator('#editor-root canvas.upper-canvas');
    await expect(canvas).toBeVisible({ timeout: 240_000 });
    await imageDone;
    await page.waitForTimeout(1000); // decode + first paint settle
    const loadMs = Date.now() - t0;

    const heap = () =>
      page.evaluate(
        () =>
          (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
            ?.usedJSHeapSize ?? 0,
      );
    const heapAfterLoad = await heap();

    // Frame pacing while drawing a rectangle across the visible slice.
    await page.getByRole('button', { name: 'Rectangle' }).click();
    await page.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __stop: boolean };
      w.__frames = [];
      w.__stop = false;
      let last = performance.now();
      const loop = (t: number) => {
        w.__frames.push(t - last);
        last = t;
        if (!w.__stop) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + 40, 120);
    await page.mouse.down();
    await page.mouse.move(box.x + Math.min(1000, box.width - 40), 600, { steps: 40 });
    await page.mouse.up();
    const drawFrames = await page.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __stop: boolean };
      w.__stop = true;
      return w.__frames;
    });

    // Frame pacing while dragging the finished rectangle around.
    await page.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __stop: boolean };
      w.__frames = [];
      w.__stop = false;
      let last = performance.now();
      const loop = (t: number) => {
        w.__frames.push(t - last);
        last = t;
        if (!w.__stop) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    await page.mouse.move(box.x + 400, 350);
    await page.mouse.down();
    await page.mouse.move(box.x + 700, 500, { steps: 40 });
    await page.mouse.move(box.x + 300, 250, { steps: 40 });
    await page.mouse.up();
    const dragFrames = await page.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __stop: boolean };
      w.__stop = true;
      return w.__frames;
    });
    const heapAfterDrag = await heap();

    const report = {
      crop: withCrop,
      fixtureBytes: png.length,
      uploadMs,
      loadMs,
      heapAfterLoadMB: +(heapAfterLoad / 1048576).toFixed(1),
      heapAfterDragMB: +(heapAfterDrag / 1048576).toFixed(1),
      draw: stats(drawFrames),
      drag: stats(dragFrames),
    };
    console.log(`PERF-SPIKE ${JSON.stringify(report, null, 2)}`);
  });
});
