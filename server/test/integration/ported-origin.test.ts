import { CSRF_HEADER, VIEW_ID_LENGTH } from '@snapping-turtle/shared';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { users } from '../../src/db/schema.js';
import { seedAdmin } from '../../src/db/seed-admin.js';
import type { App } from '../../src/types.js';
import { makePng } from '../helpers/images.js';

/**
 * PUBLIC_ORIGIN is the single source of truth for every absolute URL the app
 * mints (PLAN.md §14). A deployment on a custom port (PUBLIC_PORT, default
 * 28443) therefore needs no per-route handling: this suite boots the app the
 * way compose does — PUBLIC_ORIGIN carrying the port, PUBLIC_PORT agreeing —
 * and proves the port reaches each generated URL: the upload response, the
 * capture page's copy buttons and image, admin one-time links, the admin
 * capture list, and the Secure flag on the session cookie.
 */
const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests');

const ORIGIN = 'https://shots.test:28443';
const imagesDir = mkdtempSync(join(tmpdir(), 'st-images-'));
const webDist = mkdtempSync(join(tmpdir(), 'st-web-'));
mkdirSync(join(webDist, '.vite'));
writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>t</title>');
writeFileSync(join(webDist, 'reset.html'), '<!doctype html><title>set password</title>');
writeFileSync(
  join(webDist, '.vite', 'manifest.json'),
  JSON.stringify({
    'src/capture.ts': { file: 'assets/capture-h4sh.js', css: [] },
    'src/editor.ts': { file: 'assets/editor-h4sh.js', css: [] },
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
  RATE_BREAKER_INVALID_PER_MIN: '1000000',
});

const ADMIN = { username: 'bootstrap-admin', password: 'integration-test-password-1' };
let handle: DbHandle;
let app: App;
let cookie = '';
let csrf = '';
let setCookie: string[] = [];

beforeAll(async () => {
  handle = createDb(databaseUrl, { max: 2 });
  await handle.sql`drop schema if exists public cascade`;
  await handle.sql`drop schema if exists drizzle cascade`;
  await handle.sql`create schema public`;
  await runMigrations(handle);
  await seedAdmin(handle.db, ADMIN);
  app = await buildApp({ config, db: handle.db, now: () => new Date() });
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: ADMIN });
  expect(res.statusCode).toBe(200);
  const raw = res.headers['set-cookie'];
  setCookie = Array.isArray(raw) ? raw : raw ? [raw] : [];
  cookie = setCookie.map((c) => c.split(';')[0]!).join('; ');
  csrf = res.json().csrfToken;
});
afterAll(async () => {
  await app.close();
  await handle.close();
});

async function upload(): Promise<{ pageUrl: string; imageUrl: string }> {
  const tokenRes = await app.inject({
    method: 'POST',
    url: '/api/v1/tokens',
    payload: { name: `ported-${randomBytes(4).toString('hex')}` },
    headers: { cookie, [CSRF_HEADER]: csrf },
  });
  expect(tokenRes.statusCode).toBe(201);
  const png = await makePng(64, 48);
  const boundary = `----st${randomBytes(8).toString('hex')}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="sourceUrl"\r\n\r\nhttps://example.com/\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="s.png"\r\n` +
        `Content-Type: image/png\r\n\r\n`,
    ),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/captures',
    payload,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      authorization: `Bearer ${tokenRes.json().token}`,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

describe('a ported PUBLIC_ORIGIN reaches every generated URL', () => {
  it('refuses to boot when PUBLIC_PORT disagrees with the origin (drift fails loudly)', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: databaseUrl,
        SESSION_SECRET: 'integration-session-secret-not-real-0123456789',
        PUBLIC_ORIGIN: 'https://shots.test',
        PUBLIC_PORT: '28443',
      }),
    ).toThrow(/PUBLIC_PORT \(28443\) does not match/);
  });

  it('upload response: pageUrl and imageUrl carry the port', async () => {
    const { pageUrl, imageUrl } = await upload();
    expect(pageUrl).toMatch(new RegExp(`^${ORIGIN}/s/[A-Za-z0-9_-]{${VIEW_ID_LENGTH}}$`));
    expect(imageUrl).toBe(`${pageUrl}/image.png`);
    expect(new URL(pageUrl).port).toBe('28443');
  });

  it('capture page: the copy buttons, the data attributes and the <img> all use the ported URLs', async () => {
    const { pageUrl, imageUrl } = await upload();
    const path = new URL(pageUrl).pathname;
    const anon = await app.inject({ method: 'GET', url: path });
    expect(anon.statusCode).toBe(200);
    expect(anon.body).toContain(`data-copy="${pageUrl}"`);
    expect(anon.body).toContain(`data-copy="${imageUrl}"`);
    expect(anon.body).toContain(`src="${imageUrl}"`);
    // Nothing on the page falls back to a port-less origin.
    expect(anon.body).not.toContain('https://shots.test/');
    // The owner's editor page derives from the same origin (data attributes feed the editor).
    const owner = await app.inject({ method: 'GET', url: path, headers: { cookie } });
    expect(owner.statusCode).toBe(200);
    expect(owner.body).toContain(`data-copy="${pageUrl}"`);
    expect(owner.body).toContain(`data-page-url="${pageUrl}"`);
    expect(owner.body).toContain(`data-image-url="${imageUrl}"`);
    expect(owner.body).not.toContain('https://shots.test/');
    // The image route serves at the ported path (the app never sees the port; Caddy does).
    const img = await app.inject({ method: 'GET', url: `${path}/image.png` });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
  });

  it('admin one-time links (setup + reset) carry the port', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      payload: { username: 'ported-user' },
      headers: { cookie, [CSRF_HEADER]: csrf },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().resetUrl).toMatch(
      new RegExp(`^${ORIGIN}/reset/[A-Za-z0-9_-]{${VIEW_ID_LENGTH}}$`),
    );
    const reset = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${created.json().userId}/reset-link`,
      headers: { cookie, [CSRF_HEADER]: csrf },
    });
    expect(reset.statusCode).toBe(201);
    expect(reset.json().resetUrl.startsWith(`${ORIGIN}/reset/`)).toBe(true);
    // The link resolves through the app at its path.
    const page = await app.inject({ method: 'GET', url: new URL(reset.json().resetUrl).pathname });
    expect(page.statusCode).toBe(200);
  });

  it('admin capture search lists the ported capability URL', async () => {
    const { pageUrl } = await upload();
    const [admin] = await handle.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, ADMIN.username));
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/captures?userId=${admin!.id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const urls = (res.json().captures as Array<{ pageUrl: string }>).map((c) => c.pageUrl);
    expect(urls).toContain(pageUrl);
    for (const u of urls) expect(u.startsWith(`${ORIGIN}/s/`)).toBe(true);
  });

  it('the session cookie is Secure: a ported https origin is still https', () => {
    expect(setCookie.some((c) => c.startsWith('st_session=') && /;\s*Secure/i.test(c))).toBe(true);
  });
});
