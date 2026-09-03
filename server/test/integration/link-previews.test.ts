import { CSRF_HEADER } from '@snapping-turtle/shared';
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
import { captures } from '../../src/db/schema.js';
import { seedAdmin } from '../../src/db/seed-admin.js';
import { NOT_FOUND_HTML } from '../../src/html.js';
import type { App } from '../../src/types.js';
import { makePng } from '../helpers/images.js';

/**
 * Link previews (E3, PLAN.md §6/§7): valid capture pages carry Open Graph +
 * Twitter card tags whose absolute URLs derive from PUBLIC_ORIGIN (port
 * included); the title is escaped as attribute data; the secret-page header
 * posture is unchanged and coexists with the tags; every not-found state is
 * still the tagless uniform 404; and a preview bot's user agent buys it
 * nothing at the guard (CLAUDE.md rule 9).
 */
const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests');

const ORIGIN = 'https://shots.test:28443';
const BUDGET = 2;
const imagesDir = mkdtempSync(join(tmpdir(), 'st-images-'));
const webDist = mkdtempSync(join(tmpdir(), 'st-web-'));
mkdirSync(join(webDist, '.vite'));
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
  RATE_INVALID_LOOKUP_BUDGET: String(BUDGET),
  RATE_BREAKER_INVALID_PER_MIN: '1000000',
});

const ADMIN = { username: 'bootstrap-admin', password: 'integration-test-password-1' };
let handle: DbHandle;
let app: App;
let cookie = '';
let csrf = '';
let bearer = '';

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
  cookie = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((c) => c.split(';')[0]!).join('; ');
  csrf = res.json().csrfToken;
  const tokenRes = await app.inject({
    method: 'POST',
    url: '/api/v1/tokens',
    payload: { name: 'previews' },
    headers: { cookie, [CSRF_HEADER]: csrf },
  });
  expect(tokenRes.statusCode).toBe(201);
  bearer = tokenRes.json().token;
});
afterAll(async () => {
  await app.close();
  await handle.close();
});

async function upload(title: string, width = 64, height = 48): Promise<{ viewId: string; pageUrl: string; imageUrl: string }> {
  const png = await makePng(width, height);
  const boundary = `----st${randomBytes(8).toString('hex')}`;
  const field = (name: string, value: string) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const payload = Buffer.concat([
    Buffer.from(
      field('sourceUrl', 'https://example.com/docs?x=1') +
        field('title', title) +
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
      authorization: `Bearer ${bearer}`,
    },
  });
  expect(res.statusCode).toBe(201);
  const { pageUrl, imageUrl } = res.json() as { pageUrl: string; imageUrl: string };
  return { viewId: new URL(pageUrl).pathname.slice('/s/'.length), pageUrl, imageUrl };
}

const meta = (body: string, key: string): string | undefined =>
  new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)" />`).exec(body)?.[1];

const page = (viewId: string, extra: Record<string, unknown> = {}) =>
  app.inject({ method: 'GET', url: `/s/${viewId}`, ...extra });

describe('valid capture pages carry preview tags (E3)', () => {
  it('every tag is present; absolute URLs carry the ported origin; dimensions come from the row', async () => {
    const { viewId, pageUrl, imageUrl } = await upload('Release notes', 120, 90);
    const res = await page(viewId);
    expect(res.statusCode).toBe(200);
    expect(meta(res.body, 'og:type')).toBe('website');
    expect(meta(res.body, 'og:site_name')).toBe('snapping-turtle');
    expect(meta(res.body, 'og:title')).toBe('Release notes');
    expect(meta(res.body, 'og:description')).toBe('Annotated screenshot');
    expect(meta(res.body, 'og:url')).toBe(pageUrl);
    expect(meta(res.body, 'og:image')).toBe(imageUrl);
    expect(meta(res.body, 'og:image:type')).toBe('image/png');
    expect(meta(res.body, 'og:image:width')).toBe('120');
    expect(meta(res.body, 'og:image:height')).toBe('90');
    expect(meta(res.body, 'twitter:card')).toBe('summary_large_image');
    // Derived from PUBLIC_ORIGIN, so the port is there without per-route code (§14).
    expect(meta(res.body, 'og:url')).toBe(`${ORIGIN}/s/${viewId}`);
    expect(meta(res.body, 'og:image')).toBe(`${ORIGIN}/s/${viewId}/image.png`);
    expect(new URL(meta(res.body, 'og:image')!).port).toBe('28443');
    // ...and the image the tag points at is the flat PNG this server serves.
    const img = await app.inject({ method: 'GET', url: new URL(imageUrl).pathname });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
  });

  it('a hostile title is attribute data in the raw HTML, never markup (rule 5)', async () => {
    const hostile = `Q&A "quoted" <b>bold</b> 'single' &amp; "><script>alert(1)</script>`;
    const { viewId } = await upload(hostile);
    const res = await page(viewId);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(
      '<meta property="og:title" content="Q&amp;A &quot;quoted&quot; &lt;b&gt;bold&lt;/b&gt; &#39;single&#39; &amp;amp; &quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;" />',
    );
    expect(res.body).not.toContain('<script>alert');
    expect(res.body).not.toContain('<b>bold');
    expect(res.body).not.toContain(hostile);
    for (const [, value] of res.body.matchAll(/content="([^"]*)"/g)) {
      expect(value).not.toMatch(/[<>"]/);
    }
    // The stored title is what the page shows (escaped), so the DB holds the raw text.
    const [row] = await handle.db
      .select({ pageTitle: captures.pageTitle })
      .from(captures)
      .where(eq(captures.viewId, viewId));
    expect(row!.pageTitle).toBe(hostile);
  });

  it('coexists with the secret-page headers (rule 10) on the same response', async () => {
    const { viewId } = await upload('Headers');
    const res = await page(viewId);
    expect(meta(res.body, 'og:image')).toBeDefined();
    expect(meta(res.body, 'twitter:card')).toBe('summary_large_image');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(String(res.headers['content-security-policy'])).toContain("default-src 'self'");
    expect(res.body).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(res.body).toContain('<meta name="referrer" content="no-referrer" />');
  });

  it("the owner's editor variant carries the same tags", async () => {
    const { viewId, imageUrl } = await upload('Owner view');
    const res = await page(viewId, { headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('id="editor-root"');
    expect(meta(res.body, 'og:image')).toBe(imageUrl);
    expect(meta(res.body, 'og:title')).toBe('Owner view');
  });
});

describe('not-found states stay the tagless uniform 404 (rule 2)', () => {
  it('never-existed, deleted and expired ids: NOT_FOUND_HTML bytes, no preview tags', async () => {
    const deleted = await upload('Deleted');
    const del = await app.inject({
      method: 'PATCH',
      url: `/api/v1/captures/${deleted.viewId}`,
      payload: { delete: true },
      headers: { cookie, [CSRF_HEADER]: csrf },
    });
    expect(del.statusCode).toBe(204);
    const expired = await upload('Expired');
    await handle.db
      .update(captures)
      .set({ retentionUntil: new Date(Date.now() - 60_000) })
      .where(eq(captures.viewId, expired.viewId));

    const ids = [randomBytes(20).toString('base64url'), deleted.viewId, expired.viewId];
    // Distinct IPs so the misses never add up to a ban inside this test.
    const responses = await Promise.all(
      ids.map((id, i) => page(id, { remoteAddress: `198.51.100.${i + 1}` })),
    );
    for (const res of responses) {
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(NOT_FOUND_HTML);
      expect(res.body).not.toMatch(/og:|twitter:|<meta property/);
      expect(res.rawPayload.equals(responses[0]!.rawPayload)).toBe(true);
    }
  });
});

describe('preview bots get no guard special-casing (rule 9)', () => {
  it('a Discordbot user agent is banned after budget+1 misses like anyone else, valid links included', async () => {
    const { viewId } = await upload('Bot target');
    const ip = '203.0.113.77';
    const bot = { 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' };
    const ok = await page(viewId, { remoteAddress: ip, headers: bot });
    expect(ok.statusCode).toBe(200);
    expect(meta(ok.body, 'og:image')).toBeDefined();

    for (let i = 0; i <= BUDGET; i++) {
      const miss = await page(randomBytes(20).toString('base64url'), {
        remoteAddress: ip,
        headers: bot,
      });
      expect(miss.statusCode).toBe(404);
    }
    const banned = await page(viewId, { remoteAddress: ip, headers: bot });
    expect(banned.statusCode).toBe(429);
    expect(banned.body).not.toMatch(/og:|twitter:/);
    // Another IP with the same bot UA is unaffected — the key is the address, not the agent.
    const other = await page(viewId, { remoteAddress: '203.0.113.78', headers: bot });
    expect(other.statusCode).toBe(200);
  });
});
