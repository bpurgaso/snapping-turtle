import {
  ANNOTATION_SCHEMA_VERSION,
  ANNOTATION_STYLE,
  CSRF_HEADER,
  REDACTION_STYLE,
  RENDER_VERSION,
  redactionPixelRect,
  type AnnotationDocument,
  type CropRect,
  type RedactShape,
  type Shape,
} from '@snapping-turtle/shared';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { captures, settings, users } from '../../src/db/schema.js';
import { seedAdmin } from '../../src/db/seed-admin.js';
import { NOT_FOUND_HTML } from '../../src/html.js';
import { FlatRenderer } from '../../src/images/flat.js';
import { ImageStore } from '../../src/images/storage.js';
import { flatEtag } from '../../src/routes/secret.js';
import type { App } from '../../src/types.js';
import { makeContrastPng } from '../helpers/images.js';
import { fillLeakPixels, rgbAt, type Rgba } from '../helpers/measure.js';

/**
 * Redaction (E9, PLAN.md §9/§10, threat model at the end of §12) over HTTP.
 * Three things are proven here on real served bytes, not on the SVG:
 *
 * 1. **The pixel leak test.** A high-contrast capture with no black pixel in
 *    it gets a redaction; every pixel the flat route serves inside the block
 *    — the exact edge rows and columns included — is the fill and nothing
 *    else, and the ring just outside is not, across the matrix: a block
 *    alone, with shapes, with a crop, straddling the crop boundary and
 *    running off the image edge. The count of fill-coloured pixels in the
 *    whole output equals the block's visible area, so nothing else went
 *    black either.
 * 2. **The route audit.** Every surface that emits capture pixels is attempted
 *    as an anonymous link-holder, as a different signed-in account and as an
 *    admin: the flat route and the page (its `<img>`, its preview tags, its
 *    copy targets) yield only redacted pixels and markup naming only the flat
 *    URL; the owner-only original and annotation routes are 401/403; anything
 *    else under /s/* is the uniform 404. The original survives for the owner
 *    (which is what makes the redaction deletable), and deleting the block
 *    restores the pixels for viewers.
 * 3. **Cache correctness.** A redaction bumps `annotations_rev` through the
 *    normal save path, the stale pre-redaction flat on disk is never served
 *    (a deliberately staged stale file), the ETag changes, and a browser
 *    revalidating the old tag gets the redacted bytes.
 */
const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests');

const ORIGIN = 'https://shots.test:28443';
const imagesDir = mkdtempSync(join(tmpdir(), 'st-redact-'));
const webDist = mkdtempSync(join(tmpdir(), 'st-redact-web-'));
mkdirSync(join(webDist, '.vite'));
writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>t</title>');
writeFileSync(
  join(webDist, '.vite', 'manifest.json'),
  JSON.stringify({
    'src/capture.ts': { file: 'assets/capture-h4sh.js', css: ['assets/capture-h4sh.css'] },
    'src/editor.ts': { file: 'assets/editor-h4sh.js', css: ['assets/editor-h4sh.css'] },
  }),
);

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: databaseUrl,
  SESSION_SECRET: 'integration-session-secret-not-real-0123456789',
  PUBLIC_ORIGIN: ORIGIN,
  PUBLIC_PORT: '28443',
  IMAGES_DIR: imagesDir,
  WEB_DIST_DIR: webDist,
  RATE_NOT_FOUND_JITTER_MIN_MS: '0',
  RATE_NOT_FOUND_JITTER_MAX_MS: '0',
  RATE_GENERAL_PER_MIN: '100000',
  RATE_INVALID_LOOKUP_BUDGET: '100000',
});

const OWNER = { username: 'redact-owner', password: 'redact-owner-password-not-real-1' };
/** A second admin: not the owner, and the strongest non-owner the app has. */
const ADMIN = { username: 'redact-admin', password: 'redact-admin-password-not-real-1' };
/** An ordinary account that holds the link — the "different authenticated non-owner". */
const VIEWER = { username: 'redact-viewer', password: 'redact-viewer-password-not-real-1' };

const WIDTH = 240;
const HEIGHT = 160;
const FILL = REDACTION_STYLE.fill;
const SOURCE_URL = 'https://example.com/secret-dashboard';

let handle: DbHandle;
let app: App;
let renderer: FlatRenderer;
const store = new ImageStore(imagesDir);

let owner: { cookie: string; csrf: string };
let admin: { cookie: string; csrf: string };
let viewer: { cookie: string; csrf: string };
let viewId: string;
let captureId: number;
let ownerId: number;
let originalBytes: Buffer;
let original: Rgba;
let rev = 0;

function cookieHeader(setCookie: string | string[] | undefined): string {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return list.map((c) => c.split(';')[0]!).join('; ');
}

async function login(creds: { username: string; password: string }) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: creds });
  expect(res.statusCode).toBe(200);
  return { cookie: cookieHeader(res.headers['set-cookie']), csrf: res.json().csrfToken as string };
}

/** Decode a served PNG to RGBA for the pixel probes. */
async function decode(png: Buffer): Promise<Rgba> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  expect(info.channels).toBe(4);
  return { width: info.width, height: info.height, data };
}

const isFill = (rgb: [number, number, number]): boolean =>
  rgb[0] === 0 && rgb[1] === 0 && rgb[2] === 0;

/** Pixels in the whole image that are exactly the fill. */
function fillCount(png: Rgba): number {
  let n = 0;
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) if (isFill(rgbAt(png, x, y))) n++;
  return n;
}

/** The part of a block visible in the output: clipped to the crop (if any) and the image, in output pixels. */
function visibleRegion(block: RedactShape, crop: CropRect | null) {
  const p = redactionPixelRect(block);
  const view = crop ?? { x: 0, y: 0, w: WIDTH, h: HEIGHT };
  const x0 = Math.max(0, p.x - view.x);
  const y0 = Math.max(0, p.y - view.y);
  const x1 = Math.min(view.w, p.x + p.w - view.x);
  const y1 = Math.min(view.h, p.y + p.h - view.y);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Every pixel of the region is the fill — edges included — with zero tolerance. */
function expectCovered(
  png: Rgba,
  region: { x: number; y: number; w: number; h: number },
  label: string,
) {
  const leak = fillLeakPixels(png, region, FILL);
  expect(leak.sampled, `${label}: region ${JSON.stringify(region)} is empty`).toBe(
    region.w * region.h,
  );
  expect(
    leak.leaked,
    `${label}: ${leak.leaked} of ${leak.sampled} pixels inside the block are not the fill; first ${JSON.stringify(leak.first)}`,
  ).toBe(0);
}

/** The one-pixel ring just outside the region (where it exists) is *not* the fill: the block covers exactly itself. */
function expectRingClear(
  png: Rgba,
  region: { x: number; y: number; w: number; h: number },
  label: string,
) {
  let checked = 0;
  const probe = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
    checked++;
    expect(
      isFill(rgbAt(png, x, y)),
      `${label}: pixel (${x}, ${y}) just outside the block is the fill`,
    ).toBe(false);
  };
  for (let x = region.x - 1; x <= region.x + region.w; x++) {
    probe(x, region.y - 1);
    probe(x, region.y + region.h);
  }
  for (let y = region.y; y < region.y + region.h; y++) {
    probe(region.x - 1, y);
    probe(region.x + region.w, y);
  }
  expect(checked).toBeGreaterThan(0);
}

async function putAnnotations(shapes: Shape[], crop?: CropRect): Promise<void> {
  const doc: AnnotationDocument = { version: ANNOTATION_SCHEMA_VERSION, rev, shapes };
  if (crop) doc.crop = crop;
  const res = await app.inject({
    method: 'PUT',
    url: `/api/v1/captures/${viewId}/annotations`,
    payload: doc,
    headers: { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf },
  });
  expect(res.statusCode).toBe(200);
  rev = res.json().rev;
}

const imagePath = () => `/s/${viewId}/image.png`;

async function fetchImage(headers: Record<string, string> = {}) {
  const res = await app.inject({ method: 'GET', url: imagePath(), headers });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('image/png');
  return { res, png: await decode(res.rawPayload) };
}

/** A block well inside the image, away from the edges. */
const A: RedactShape = { id: 'a', type: 'redact', x: 40, y: 30, w: 100, h: 60 };
/** A block running off the bottom of the image (within the margin) and across the crop's right edge. */
const B: RedactShape = { id: 'b', type: 'redact', x: 120, y: 80, w: 100, h: 100 };
const CROP: CropRect = { x: 20, y: 10, w: 160, h: 120 };
/** Shapes that point at A without touching it: a rect to its right, an arrow aimed at it, a text beside it. */
const POINTING: Shape[] = [
  { id: 'r', type: 'rect', x: 150, y: 20, w: 60, h: 40 },
  { id: 'ar', type: 'arrow', x1: 200, y1: 140, x2: 120, y2: 100 },
  { id: 't', type: 'text', x: 150, y: 100, text: 'see', fontSize: 20 },
];
/** A rect whose top stroke crosses A: it must be drawn *over* the block. */
const CROSSING: Shape = { id: 'x', type: 'rect', x: 20, y: 50, w: 200, h: 80 };

beforeAll(async () => {
  handle = createDb(databaseUrl, { max: 4 });
  await handle.sql`drop schema if exists public cascade`;
  await handle.sql`drop schema if exists drizzle cascade`;
  await handle.sql`create schema public`;
  await runMigrations(handle);
  await seedAdmin(handle.db, OWNER);
  await seedAdmin(handle.db, ADMIN);
  renderer = new FlatRenderer({ db: handle.db, store, concurrency: 2 });
  app = await buildApp({ config, db: handle.db, flat: renderer });

  owner = await login(OWNER);
  admin = await login(ADMIN);
  // A plain (non-admin) account through the real signup path.
  await handle.db
    .update(settings)
    .set({ value: true })
    .where(eq(settings.key, 'registration_enabled'));
  const signup = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: VIEWER });
  expect(signup.statusCode).toBe(201);
  await handle.db
    .update(settings)
    .set({ value: false })
    .where(eq(settings.key, 'registration_enabled'));
  viewer = await login(VIEWER);
  const [ownerRow] = await handle.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, OWNER.username));
  ownerId = ownerRow!.id;

  const tok = await app.inject({
    method: 'POST',
    url: '/api/v1/tokens',
    payload: { name: 'redaction-tests' },
    headers: { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf },
  });
  expect(tok.statusCode).toBe(201);

  const boundary = `----st${randomBytes(8).toString('hex')}`;
  const png = await makeContrastPng(WIDTH, HEIGHT);
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="sourceUrl"\r\n\r\n${SOURCE_URL}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nredaction tests\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="shot.png"\r\n` +
        `Content-Type: image/png\r\n\r\n`,
    ),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const up = await app.inject({
    method: 'POST',
    url: '/api/v1/captures',
    payload,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      authorization: `Bearer ${tok.json().token}`,
    },
  });
  expect(up.statusCode).toBe(201);
  viewId = (up.json().pageUrl as string).slice(`${ORIGIN}/s/`.length);
  const [row] = await handle.db
    .select({ id: captures.id })
    .from(captures)
    .where(eq(captures.viewId, viewId));
  captureId = row!.id;
  originalBytes = readFileSync(store.pathFor(captureId));
  original = await decode(originalBytes);
  // The fixture's premise: not one black pixel in the stored original.
  expect(fillCount(original)).toBe(0);
});
afterAll(async () => {
  await app.close();
  await handle.close();
});

describe('the pixel leak test (E9, §10)', () => {
  it('redaction alone: every pixel inside the block is the fill, the ring outside is not, nothing else is', async () => {
    await putAnnotations([A]);
    const { res, png } = await fetchImage();
    expect([png.width, png.height]).toEqual([WIDTH, HEIGHT]);
    expect(res.rawPayload.equals(originalBytes)).toBe(false);
    const region = visibleRegion(A, null);
    expectCovered(png, region, 'alone');
    expectRingClear(png, region, 'alone');
    expect(fillCount(png)).toBe(A.w * A.h);
    // Pixels far from the block are the original's.
    expect(rgbAt(png, 5, 5)).toEqual(rgbAt(original, 5, 5));
    expect(rgbAt(png, WIDTH - 1, HEIGHT - 1)).toEqual(rgbAt(original, WIDTH - 1, HEIGHT - 1));
  });

  it('redaction + shapes: shapes that point at the block leave it fully covered', async () => {
    await putAnnotations([A, ...POINTING]);
    const { png } = await fetchImage();
    const region = visibleRegion(A, null);
    expectCovered(png, region, 'with shapes');
    expectRingClear(png, region, 'with shapes');
    expect(fillCount(png)).toBe(A.w * A.h);
    // The shapes did render (the rect's red core is where E1's floor sizes put it: path at y = 20 + 3).
    expect(rgbAt(png, 180, 23)).toEqual([224, 49, 49]);
  });

  it('rendering order: a shape crossing the block is drawn over it, whatever the document order', async () => {
    const n = (hex: string) => Number.parseInt(hex.slice(1), 16);
    const red: [number, number, number] = [
      (n(ANNOTATION_STYLE.red) >> 16) & 0xff,
      (n(ANNOTATION_STYLE.red) >> 8) & 0xff,
      n(ANNOTATION_STYLE.red) & 0xff,
    ];
    for (const shapes of [
      [A, CROSSING],
      [CROSSING, A],
    ]) {
      await putAnnotations(shapes);
      const { png } = await fetchImage();
      // CROSSING's top edge path sits at y = 50 + 3 (floor sizes at 240 px), red core 51.5–54.5: inside A.
      expect(rgbAt(png, 90, 53), `document order ${shapes.map((s) => s.id).join(',')}`).toEqual(
        red,
      );
      // Away from the stroke (y 30–47 is above its white rim at 50), A is the fill — edges included.
      expectCovered(png, { x: A.x, y: A.y, w: A.w, h: 17 }, 'above the stroke');
      expectCovered(png, { x: A.x, y: 60, w: A.w, h: A.y + A.h - 60 }, 'below the stroke');
      // And the block never covers the shape: the whole top edge band is painted across A.
      for (let x = A.x; x < A.x + A.w; x += 10) expect(isFill(rgbAt(png, x, 53))).toBe(false);
    }
  });

  it('redaction + crop: the block is covered at the crop offset, at crop size', async () => {
    await putAnnotations([A], CROP);
    const { png } = await fetchImage();
    expect([png.width, png.height]).toEqual([CROP.w, CROP.h]);
    const region = visibleRegion(A, CROP);
    expect(region).toEqual({ x: A.x - CROP.x, y: A.y - CROP.y, w: A.w, h: A.h });
    expectCovered(png, region, 'cropped');
    expectRingClear(png, region, 'cropped');
    expect(fillCount(png)).toBe(A.w * A.h);
  });

  it('a block straddling the crop boundary covers exactly its visible part, through to the crop edge', async () => {
    await putAnnotations([B], CROP);
    const { png } = await fetchImage();
    expect([png.width, png.height]).toEqual([CROP.w, CROP.h]);
    const region = visibleRegion(B, CROP);
    expect(region).toEqual({ x: 100, y: 70, w: 60, h: 50 }); // clipped on the right and the bottom
    expectCovered(png, region, 'straddling');
    expectRingClear(png, region, 'straddling'); // only the left and top rings exist
    expect(fillCount(png)).toBe(60 * 50);
    // The last column and row of the output are fill: the block runs through the edge.
    expect(isFill(rgbAt(png, CROP.w - 1, CROP.h - 1))).toBe(true);
    expect(isFill(rgbAt(png, CROP.w - 1, 70))).toBe(true);
    expect(isFill(rgbAt(png, 100, CROP.h - 1))).toBe(true);
  });

  it('a block running off the image edge (within the margin) covers through to the edge', async () => {
    await putAnnotations([B]);
    const { png } = await fetchImage();
    const region = visibleRegion(B, null);
    expect(region).toEqual({ x: 120, y: 80, w: 100, h: 80 }); // clipped at the image bottom
    expectCovered(png, region, 'overhang');
    expectRingClear(png, region, 'overhang');
    expect(fillCount(png)).toBe(100 * 80);
  });

  it('two overlapping blocks, together with a crop, cover their union', async () => {
    const C: RedactShape = { id: 'c', type: 'redact', x: 100, y: 60, w: 60, h: 60 };
    await putAnnotations([A, C], CROP);
    const { png } = await fetchImage();
    expectCovered(png, visibleRegion(A, CROP), 'A of the union');
    expectCovered(png, visibleRegion(C, CROP), 'C of the union');
    // |A ∪ C| = |A| + |C| − |A ∩ C|; A ∩ C = x 100–140 × y 60–90 = 40 × 30.
    expect(fillCount(png)).toBe(A.w * A.h + C.w * C.h - 40 * 30);
  });
});

describe('the route audit (E9, §12): every surface that emits capture pixels', () => {
  beforeAll(async () => {
    await putAnnotations([A, ...POINTING]);
  });

  const identities = () =>
    [
      ['anonymous', {}],
      ['a different signed-in account', { cookie: viewer.cookie }],
      ['an admin who is not the owner', { cookie: admin.cookie }],
    ] as const;

  it('GET /s/:viewId/image.png — the flat render and the og:image target: only redacted pixels, identical bytes for everyone', async () => {
    const anon = await fetchImage();
    expectCovered(anon.png, visibleRegion(A, null), 'anonymous');
    for (const [who, headers] of identities()) {
      const { res, png } = await fetchImage(headers);
      expectCovered(png, visibleRegion(A, null), who);
      expect(res.rawPayload.equals(anon.res.rawPayload), who).toBe(true);
    }
  });

  it('GET /s/:viewId — the page: markup names only the flat URL; no original route, no document, no editor', async () => {
    for (const [who, headers] of identities()) {
      const res = await app.inject({ method: 'GET', url: `/s/${viewId}`, headers });
      expect(res.statusCode, who).toBe(200);
      const body = res.body;
      expect(body, who).not.toContain('/original');
      expect(body, who).not.toContain('editor-root');
      expect(body, who).not.toContain('data-original-url');
      expect(body, who).not.toContain('annotations');
      expect(body, who).not.toContain('"redact"');
      expect(body, who).toContain(`<meta property="og:image" content="${ORIGIN}${imagePath()}" />`);
      expect(body, who).toMatch(new RegExp(`<img[^>]*src="${ORIGIN}${imagePath()}"`));
      const copyTargets = [...body.matchAll(/data-copy="([^"]+)"/g)].map((m) => m[1]);
      expect(copyTargets, who).toEqual([`${ORIGIN}/s/${viewId}`, `${ORIGIN}${imagePath()}`]);
      // Every absolute URL a link-holder receives is one of three: the page, the flat image, the source page.
      const urls = new Set([...body.matchAll(/https?:\/\/[^"'\s<>]+/g)].map((m) => m[0]));
      expect([...urls].sort(), who).toEqual(
        [`${ORIGIN}/s/${viewId}`, `${ORIGIN}${imagePath()}`, SOURCE_URL].sort(),
      );
      // Secret-page posture unchanged (rule 10).
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
      expect(res.headers['cache-control']).toBe('private, no-store');
    }
    // The owner's page is the one that names the original route (the editor's canvas source).
    const ownerPage = await app.inject({
      method: 'GET',
      url: `/s/${viewId}`,
      headers: { cookie: owner.cookie },
    });
    expect(ownerPage.body).toContain(`data-original-url="/api/v1/captures/${viewId}/original"`);
  });

  it('the preview targets fetch the same redacted bytes', async () => {
    const page = await app.inject({ method: 'GET', url: `/s/${viewId}` });
    const og = /<meta property="og:image" content="([^"]+)" \/>/.exec(page.body)![1]!;
    const path = new URL(og).pathname;
    const res = await app.inject({ method: 'GET', url: path });
    expect(res.statusCode).toBe(200);
    expectCovered(await decode(res.rawPayload), visibleRegion(A, null), 'og:image');
  });

  it('GET /api/v1/captures/:viewId/original — owner only: 401 anonymous, 403 another account, 403 an admin; the owner gets the unredacted original', async () => {
    const url = `/api/v1/captures/${viewId}/original`;
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url, headers: { cookie: viewer.cookie } })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: 'GET', url, headers: { cookie: admin.cookie } })).statusCode,
    ).toBe(403);
    const mine = await app.inject({ method: 'GET', url, headers: { cookie: owner.cookie } });
    expect(mine.statusCode).toBe(200);
    expect(mine.rawPayload.equals(originalBytes)).toBe(true);
    // The pixels under the block are still there for the owner: that is what makes the redaction deletable.
    const png = await decode(mine.rawPayload);
    expect(fillLeakPixels(png, visibleRegion(A, null), FILL).leaked).toBe(A.w * A.h);
    // Neither 401 nor 403 carries pixels.
    for (const headers of [{}, { cookie: viewer.cookie }, { cookie: admin.cookie }]) {
      const res = await app.inject({ method: 'GET', url, headers });
      expect(res.headers['content-type']).not.toContain('image/');
      expect(res.rawPayload.length).toBeLessThan(512);
    }
  });

  it('GET /api/v1/captures/:viewId/annotations — the block geometry is owner-only too', async () => {
    const url = `/api/v1/captures/${viewId}/annotations`;
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url, headers: { cookie: viewer.cookie } })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: 'GET', url, headers: { cookie: admin.cookie } })).statusCode,
    ).toBe(403);
    const mine = await app.inject({ method: 'GET', url, headers: { cookie: owner.cookie } });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().shapes[0]).toEqual(A);
  });

  it('anything else under /s/:viewId/ is the uniform 404 (rule 2)', async () => {
    for (const suffix of [
      'original',
      'original.png',
      'image.png/original',
      'flat.png',
      'raw',
      'annotations',
    ]) {
      for (const [who, headers] of identities()) {
        const res = await app.inject({ method: 'GET', url: `/s/${viewId}/${suffix}`, headers });
        expect(res.statusCode, `${who} ${suffix}`).toBe(404);
        expect(res.body, `${who} ${suffix}`).toBe(NOT_FOUND_HTML);
      }
    }
  });

  it('the admin capture list carries metadata and the page URL, never pixels or the original route', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/captures?userId=${ownerId}`,
      headers: { cookie: admin.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const row = (res.json().captures as Array<Record<string, unknown>>).find(
      (c) => c['id'] === captureId,
    )!;
    expect(row['pageUrl']).toBe(`${ORIGIN}/s/${viewId}`);
    expect(res.body).not.toContain('/original');
    expect(res.body).not.toContain('image.png');
    // The admin's view of the capture page is the view-only page like anyone else's (covered above).
  });

  it('the image directory is not mounted: the original and the flat file are unreachable by path', async () => {
    for (const url of [
      `/images/${captureId}.png`,
      `/data/images/${captureId}.png`,
      `/assets/../${captureId}.png`,
      `/${captureId}.png`,
      `/${captureId}.flat.png`,
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['content-type'], url).not.toContain('image/');
    }
  });

  it('deleting the redaction restores the pixels for every link-holder (requirement two)', async () => {
    await putAnnotations([...POINTING]);
    const { png } = await fetchImage();
    expect(fillLeakPixels(png, visibleRegion(A, null), FILL).leaked).toBe(A.w * A.h);
    expect(fillCount(png)).toBe(0);
    expect(rgbAt(png, 90, 60)).toEqual(rgbAt(original, 90, 60));
    await putAnnotations([A, ...POINTING]); // back on for the cache tests
  });
});

describe('cache correctness (E9, §10)', () => {
  it('adding a redaction bumps annotations_rev, changes the ETag, and the stale pre-redaction flat is never served', async () => {
    // Start from a rendered, cached, *unredacted* flat.
    await putAnnotations([...POINTING]);
    const before = await fetchImage();
    const oldTag = before.res.headers['etag'] as string;
    expect(oldTag).toBe(flatEtag(rev));
    const unredacted = readFileSync(store.pathFor(captureId, 'flat'));
    expect(unredacted.equals(before.res.rawPayload)).toBe(true);
    let [row] = await handle.db
      .select({ flatRev: captures.flatRev })
      .from(captures)
      .where(eq(captures.id, captureId));
    expect(row!.flatRev).toBe(rev);

    // The owner redacts through the normal save path.
    const revBefore = rev;
    await putAnnotations([A, ...POINTING]);
    expect(rev).toBe(revBefore + 1);
    // On disk, right now, the flat file is still the unredacted one with flat_rev one behind.
    expect(readFileSync(store.pathFor(captureId, 'flat')).equals(unredacted)).toBe(true);
    [row] = await handle.db
      .select({ flatRev: captures.flatRev })
      .from(captures)
      .where(eq(captures.id, captureId));
    expect(row!.flatRev).toBe(revBefore);

    // A browser revalidating the pre-redaction tag must get the redacted bytes, not a 304.
    const started = renderer.gate.started;
    const after = await app.inject({
      method: 'GET',
      url: imagePath(),
      headers: { 'if-none-match': oldTag },
    });
    expect(after.statusCode).toBe(200);
    expect(after.headers['etag']).toBe(flatEtag(rev));
    expect(after.headers['etag']).not.toBe(oldTag);
    expect(after.rawPayload.equals(unredacted)).toBe(false);
    expect(renderer.gate.started).toBe(started + 1);
    expectCovered(await decode(after.rawPayload), visibleRegion(A, null), 'after revalidation');
    // And the new tag does 304.
    const fresh = await app.inject({
      method: 'GET',
      url: imagePath(),
      headers: { 'if-none-match': flatEtag(rev) },
    });
    expect(fresh.statusCode).toBe(304);
  });

  it('a deliberately staged stale flat (unredacted bytes, flat_rev one behind) is never served', async () => {
    // Render the unredacted document once more to get its bytes, then redact.
    await putAnnotations([...POINTING]);
    const unredacted = (await fetchImage()).res.rawPayload;
    await putAnnotations([A, ...POINTING]);
    expect((await fetchImage()).res.rawPayload.equals(unredacted)).toBe(false);
    // Now plant the unredacted bytes as the flat file and point flat_rev one revision back —
    // exactly what a crash between a save and its render would leave behind.
    await store.write(captureId, unredacted, 'flat');
    await handle.db
      .update(captures)
      .set({ flatRev: rev - 1 })
      .where(eq(captures.id, captureId));
    const started = renderer.gate.started;
    const { res, png } = await fetchImage();
    expect(res.rawPayload.equals(unredacted)).toBe(false);
    expect(renderer.gate.started).toBe(started + 1);
    expectCovered(png, visibleRegion(A, null), 'staged stale file');
    const [row] = await handle.db
      .select({ flatRev: captures.flatRev, flatRenderVersion: captures.flatRenderVersion })
      .from(captures)
      .where(eq(captures.id, captureId));
    expect(row).toEqual({ flatRev: rev, flatRenderVersion: RENDER_VERSION });
  });

  it('a stale flat stamped current by an older renderer version is re-rendered redacted', async () => {
    await putAnnotations([...POINTING]);
    const unredacted = (await fetchImage()).res.rawPayload;
    await putAnnotations([A, ...POINTING]);
    await store.write(captureId, unredacted, 'flat');
    await handle.db
      .update(captures)
      .set({ flatRev: rev, flatRenderVersion: RENDER_VERSION - 1 })
      .where(eq(captures.id, captureId));
    const { res, png } = await fetchImage();
    expect(res.rawPayload.equals(unredacted)).toBe(false);
    expectCovered(png, visibleRegion(A, null), 'older render version');
  });

  it('moving a block is a revision like any other: the old ETag misses and the new position is what is served', async () => {
    // Up and left, away from every pointing shape (none may overlap it for the whole-block check).
    const moved: RedactShape = { ...A, x: A.x - 30, y: A.y - 10 };
    const oldTag = flatEtag(rev);
    await putAnnotations([moved, ...POINTING]);
    const res = await app.inject({
      method: 'GET',
      url: imagePath(),
      headers: { 'if-none-match': oldTag },
    });
    expect(res.statusCode).toBe(200);
    const png = await decode(res.rawPayload);
    expectCovered(png, visibleRegion(moved, null), 'moved');
    expect(fillCount(png)).toBe(moved.w * moved.h);
    // The old position's now-uncovered strip is the original again.
    expect(isFill(rgbAt(png, 130, 85))).toBe(false);
  });
});
