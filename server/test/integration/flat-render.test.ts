import {
  ANNOTATION_SCHEMA_VERSION,
  CSRF_HEADER,
  type AnnotationDocument,
  type Shape,
} from '@snapping-turtle/shared';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { captures } from '../../src/db/schema.js';
import { seedAdmin } from '../../src/db/seed-admin.js';
import { FlatRenderer, type EnsureResult } from '../../src/images/flat.js';
import { ImageStore } from '../../src/images/storage.js';
import type { App } from '../../src/types.js';
import { makePng } from '../helpers/images.js';

/**
 * M4 flat renderer over HTTP (§10): the unchanged image.png URL now serves
 * the composite, cached one-file-per-capture and keyed by flat_rev, with
 * rev-derived ETags and single-flight render coalescing. Requires
 * DATABASE_URL pointing at a throwaway database (schema is reset).
 */
const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests');

const ORIGIN = 'https://shots.test';
const imagesDir = mkdtempSync(join(tmpdir(), 'st-flat-'));
const webDist = mkdtempSync(join(tmpdir(), 'st-flat-web-'));
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
  IMAGES_DIR: imagesDir,
  WEB_DIST_DIR: webDist,
  RATE_NOT_FOUND_JITTER_MIN_MS: '0',
  RATE_NOT_FOUND_JITTER_MAX_MS: '1',
  // Anonymous image fetches in this suite must never hit the general cap;
  // the M5 guard suite exercises the real thresholds.
  RATE_GENERAL_PER_MIN: '100000',
  RATE_INVALID_LOOKUP_BUDGET: '100000',
});

const OWNER = { username: 'flat-owner', password: 'flat-owner-password-not-real-1' };

/**
 * The production renderer with two test-only seams: a render can be held open
 * until the test says so, and the test can wait until N viewers have provably
 * entered `ensure()`. Together they make the stampede assertion exact — the
 * old burst test raced 8 HTTP lookups against one ~10 ms sharp composite and
 * lost that race on a loaded CI box (`gate.started` 4 vs 3).
 */
class HeldRenderer extends FlatRenderer {
  private hold: Promise<void> | null = null;
  private ensureCalls = 0;
  private arrival: { n: number; resolve: () => void } | null = null;

  /** Every render started while `until` is pending waits for it. */
  holdRenders(until: Promise<void>): void {
    this.hold = until.finally(() => {
      this.hold = null;
    });
  }

  /** Resolves once `n` further calls to `ensure()` have been made. */
  ensureCallsReach(n: number): Promise<void> {
    this.ensureCalls = 0;
    return new Promise((resolve) => {
      this.arrival = { n, resolve };
    });
  }

  override ensure(captureId: number): Promise<EnsureResult> {
    this.ensureCalls += 1;
    if (this.arrival && this.ensureCalls >= this.arrival.n) {
      this.arrival.resolve();
      this.arrival = null;
    }
    return super.ensure(captureId);
  }

  protected override async render(captureId: number): Promise<EnsureResult> {
    if (this.hold) await this.hold;
    return super.render(captureId);
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let handle: DbHandle;
let app: App;
let renderer: HeldRenderer;
const store = new ImageStore(imagesDir);

let cookie: string;
let csrf: string;
let viewId: string;
let captureId: number;
let originalBytes: Buffer;
let rev = 0;

const WIDTH = 300;
const HEIGHT = 200;

beforeAll(async () => {
  handle = createDb(databaseUrl, { max: 4 });
  await handle.sql`drop schema if exists public cascade`;
  await handle.sql`drop schema if exists drizzle cascade`;
  await handle.sql`create schema public`;
  await runMigrations(handle);
  await seedAdmin(handle.db, OWNER);
  renderer = new HeldRenderer({ db: handle.db, store, concurrency: 2 });
  app = await buildApp({ config, db: handle.db, flat: renderer });

  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: OWNER });
  expect(login.statusCode).toBe(200);
  const setCookie = login.headers['set-cookie'];
  const list = Array.isArray(setCookie) ? setCookie : [setCookie as string];
  cookie = list.map((c) => c.split(';')[0]!).join('; ');
  csrf = login.json().csrfToken;

  const tok = await app.inject({
    method: 'POST',
    url: '/api/v1/tokens',
    payload: { name: 'flat-tests' },
    headers: { cookie, [CSRF_HEADER]: csrf },
  });
  expect(tok.statusCode).toBe(201);

  const boundary = `----st${randomBytes(8).toString('hex')}`;
  const png = await makePng(WIDTH, HEIGHT);
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="sourceUrl"\r\n\r\nhttps://example.com/x\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nflat tests\r\n` +
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
});
afterAll(async () => {
  await app.close();
  await handle.close();
});

const imagePath = () => `/s/${viewId}/image.png`;

async function putAnnotations(shapes: Shape[]): Promise<void> {
  const doc: AnnotationDocument = { version: ANNOTATION_SCHEMA_VERSION, rev, shapes };
  const res = await app.inject({
    method: 'PUT',
    url: `/api/v1/captures/${viewId}/annotations`,
    payload: doc,
    headers: { cookie, [CSRF_HEADER]: csrf },
  });
  expect(res.statusCode).toBe(200);
  rev = res.json().rev;
}

const SHAPES: Shape[] = [
  { id: 's1', type: 'rect', x: 40, y: 30, w: 120, h: 80 },
  { id: 's2', type: 'arrow', x1: 260, y1: 180, x2: 180, y2: 90 },
  { id: 's3', type: 'text', x: 60, y: 130, text: '</text>&"look"', fontSize: 24 },
];

describe('GET /s/:viewId/image.png (§10)', () => {
  it('zero annotations: serves the original untouched, revalidatable at "r0"', async () => {
    const res = await app.inject({ method: 'GET', url: imagePath() });
    expect(res.statusCode).toBe(200);
    expect(res.headers['etag']).toBe('"r0"');
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(res.rawPayload.equals(originalBytes)).toBe(true);
    expect(existsSync(store.pathFor(captureId, 'flat'))).toBe(false); // no pointless composite

    const cached = await app.inject({
      method: 'GET',
      url: imagePath(),
      headers: { 'if-none-match': '"r0"' },
    });
    expect(cached.statusCode).toBe(304);
    expect(cached.headers['etag']).toBe('"r0"');
    expect(cached.body).toBe('');
  });

  it('after a save, renders the composite, records flat_rev and bumps the ETag', async () => {
    await putAnnotations(SHAPES);
    expect(rev).toBe(1);

    const res = await app.inject({ method: 'GET', url: imagePath() });
    expect(res.statusCode).toBe(200);
    expect(res.headers['etag']).toBe('"r1"');
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.rawPayload.equals(originalBytes)).toBe(false); // annotations are visible

    const meta = await sharp(res.rawPayload).metadata();
    expect([meta.width, meta.height]).toEqual([WIDTH, HEIGHT]);

    // The annotated pixels really changed where the shapes sit: the fixture
    // background is uniform red-ish (makePng), so white outline pixels prove
    // the rect and the text actually rasterized.
    const raw = await sharp(res.rawPayload).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => {
      const i = (y * WIDTH + x) * raw.info.channels;
      return [raw.data[i]!, raw.data[i + 1]!, raw.data[i + 2]!];
    };
    // The rect's top edge path sits at y = 30+4 = 34: red core covers 32–36,
    // the white underlay ring shows at 30–32 and 36–38. Probe both bands.
    expect(px(104, 34)).toEqual([224, 49, 49]); // #e03131
    expect(px(104, 31)).toEqual([255, 255, 255]);
    // Somewhere in the text's glyph box (x 60…, first baseline ≈ 153 for a
    // 24 px shape at y=130) there are white outline pixels.
    let hasWhite = false;
    for (let y = 132; y < 158 && !hasWhite; y++) {
      for (let x = 60; x < 240 && !hasWhite; x++) {
        const [r, g, b] = px(x, y);
        hasWhite = r! > 240 && g! > 240 && b! > 240;
      }
    }
    expect(hasWhite).toBe(true);

    const [row] = await handle.db
      .select({ flatRev: captures.flatRev })
      .from(captures)
      .where(eq(captures.id, captureId));
    expect(row!.flatRev).toBe(1);
    expect(existsSync(store.pathFor(captureId, 'flat'))).toBe(true);
    expect(readFileSync(store.pathFor(captureId, 'flat')).equals(res.rawPayload)).toBe(true);
  });

  it('serves the cache while flat_rev is current (no re-render)', async () => {
    // Plant a sentinel file: if the route re-rendered, it would overwrite it.
    const sentinel = await sharp({
      create: { width: 5, height: 5, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    await store.write(captureId, sentinel, 'flat');
    const started = renderer.gate.started;

    const res = await app.inject({ method: 'GET', url: imagePath() });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(sentinel)).toBe(true);
    expect(renderer.gate.started).toBe(started);

    const revalidated = await app.inject({
      method: 'GET',
      url: imagePath(),
      headers: { 'if-none-match': '"r1"' },
    });
    expect(revalidated.statusCode).toBe(304);
    expect(renderer.gate.started).toBe(started);
  });

  it('a stale ETag misses and a fresh save re-renders over the old cache file', async () => {
    await putAnnotations(SHAPES.slice(0, 2)); // rev 2, drops the text
    const res = await app.inject({
      method: 'GET',
      url: imagePath(),
      headers: { 'if-none-match': '"r1"' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['etag']).toBe('"r2"');
    const [row] = await handle.db
      .select({ flatRev: captures.flatRev })
      .from(captures)
      .where(eq(captures.id, captureId));
    expect(row!.flatRev).toBe(2);
  });

  it('a revalidation of the current revision short-circuits before rendering', async () => {
    await putAnnotations(SHAPES); // rev 3; flat_rev still 2
    const started = renderer.gate.started;
    const res = await app.inject({
      method: 'GET',
      url: imagePath(),
      headers: { 'if-none-match': `"r${rev}"` },
    });
    expect(res.statusCode).toBe(304);
    expect(renderer.gate.started).toBe(started); // no render for a 304
  });

  it('coalesces a burst of viewers onto one render (§10 stampede control)', async () => {
    // Deterministic by construction: the first render is held open until all
    // N viewers have looked the row up and called ensure(), so every one of
    // them provably arrives while it is in flight. No timing assumption, and
    // the assertion is exact — one job for N viewers, never "at most".
    const N = 8;
    const started = renderer.gate.started;
    const gateOpen = deferred();
    renderer.holdRenders(gateOpen.promise);
    const allInside = renderer.ensureCallsReach(N);

    const burst = Promise.all(
      Array.from({ length: N }, () => app.inject({ method: 'GET', url: imagePath() })),
    );
    await allInside;
    expect(renderer.gate.started).toBe(started + 1); // one render running, N-1 coalesced

    gateOpen.resolve();
    const responses = await burst;
    for (const res of responses) {
      expect(res.statusCode).toBe(200);
      expect(res.headers['etag']).toBe(`"r${rev}"`);
      expect(res.rawPayload.equals(responses[0]!.rawPayload)).toBe(true);
    }
    expect(renderer.gate.started).toBe(started + 1);
    const [row] = await handle.db
      .select({ flatRev: captures.flatRev })
      .from(captures)
      .where(eq(captures.id, captureId));
    expect(row!.flatRev).toBe(rev);
  });

  it('deleting every annotation goes back to serving the original', async () => {
    await putAnnotations([]);
    const res = await app.inject({ method: 'GET', url: imagePath() });
    expect(res.statusCode).toBe(200);
    expect(res.headers['etag']).toBe(`"r${rev}"`);
    expect(res.rawPayload.equals(originalBytes)).toBe(true);
  });

  it('the non-owner page needed no markup change: same <img>, now annotated', async () => {
    await putAnnotations(SHAPES);
    const res = await app.inject({ method: 'GET', url: `/s/${viewId}` });
    expect(res.statusCode).toBe(200);
    // The M1 view-only page: plain <img> pointing at the stable image URL,
    // no editor mount for anonymous viewers.
    expect(res.body).toContain(`src="${ORIGIN}/s/${viewId}/image.png"`);
    expect(res.body).not.toContain('editor-root');
  });

  it('deleting the capture removes the flat render with the original', async () => {
    // Materialise the cache first, then delete.
    expect((await app.inject({ method: 'GET', url: imagePath() })).statusCode).toBe(200);
    expect(existsSync(store.pathFor(captureId, 'flat'))).toBe(true);

    const del = await app.inject({
      method: 'PATCH',
      url: `/api/v1/captures/${viewId}`,
      payload: { delete: true },
      headers: { cookie, [CSRF_HEADER]: csrf },
    });
    expect(del.statusCode).toBe(204);
    expect(existsSync(store.pathFor(captureId))).toBe(false);
    expect(existsSync(store.pathFor(captureId, 'flat'))).toBe(false);
    expect((await app.inject({ method: 'GET', url: imagePath() })).statusCode).toBe(404);
  });
});
