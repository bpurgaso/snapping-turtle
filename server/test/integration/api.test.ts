import {
  API_TOKEN_PREFIX,
  CSRF_HEADER,
  MAX_IMAGE_WIDTH_PX,
  RETENTION_DEFAULT_DAYS,
  VIEW_ID_LENGTH,
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
import { apiTokens, captures, sessions, settings, users } from '../../src/db/schema.js';
import { seedAdmin } from '../../src/db/seed-admin.js';
import { NOT_FOUND_HTML } from '../../src/html.js';
import { sha256Hex } from '../../src/ids.js';
import { ImageStore } from '../../src/images/storage.js';
import type { App } from '../../src/types.js';
import { craftPngBomb, makeJpegWithExif, makePng, SVG_BYTES } from '../helpers/images.js';

/**
 * M1 API against a real Postgres. Requires DATABASE_URL pointing at a
 * throwaway database — the suite drops and recreates the public schema.
 */
const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests');

const ORIGIN = 'https://shots.test';
const imagesDir = mkdtempSync(join(tmpdir(), 'st-images-'));
const webDist = mkdtempSync(join(tmpdir(), 'st-web-'));
mkdirSync(join(webDist, '.vite'));
writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>t</title>');
writeFileSync(
  join(webDist, '.vite', 'manifest.json'),
  JSON.stringify({
    'src/capture.ts': { file: 'assets/capture-h4sh.js', css: ['assets/capture-h4sh.css'] },
  }),
);

let clock = new Date('2026-08-30T12:00:00.000Z');
const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: databaseUrl,
  SESSION_SECRET: 'integration-session-secret-not-real-0123456789',
  PUBLIC_ORIGIN: ORIGIN,
  IMAGES_DIR: imagesDir,
  WEB_DIST_DIR: webDist,
  MAX_UPLOAD_MB: '1',
  LOGIN_THROTTLE_FREE_ATTEMPTS: '2',
  LOGIN_THROTTLE_BASE_SECONDS: '30',
  RATE_NOT_FOUND_JITTER_MIN_MS: '0',
  RATE_NOT_FOUND_JITTER_MAX_MS: '1',
});

let handle: DbHandle;
let app: App;
const store = new ImageStore(imagesDir);

const ADMIN = { username: 'admin', password: 'admin-password-integration-1' };
const ALICE = { username: 'alice', password: 'alice-password-integration-1' };
const BOB = { username: 'bob', password: 'bob-password-integration-01' };

beforeAll(async () => {
  handle = createDb(databaseUrl, { max: 4 });
  await handle.sql`drop schema if exists public cascade`;
  await handle.sql`drop schema if exists drizzle cascade`;
  await handle.sql`create schema public`;
  await runMigrations(handle);
  await seedAdmin(handle.db, ADMIN);
  app = await buildApp({ config, db: handle.db, now: () => clock });
});
afterAll(async () => {
  await app.close();
  await handle.close();
});

// ---- helpers ----------------------------------------------------------------

interface Session {
  cookie: string;
  csrf: string;
}

function cookieHeader(setCookie: string | string[] | undefined): string {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return list.map((c) => c.split(';')[0]!).join('; ');
}

async function login(creds: { username: string; password: string }): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: creds });
  expect(res.statusCode).toBe(200);
  return { cookie: cookieHeader(res.headers['set-cookie']), csrf: res.json().csrfToken };
}

async function setRegistration(enabled: boolean) {
  await handle.db
    .update(settings)
    .set({ value: enabled })
    .where(eq(settings.key, 'registration_enabled'));
}

type Part =
  | { name: string; value: string }
  | { name: string; filename: string; content: Buffer; type?: string };

function multipart(parts: Part[]): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----st${randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if ('filename' in p) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n` +
            `Content-Type: ${p.type ?? 'application/octet-stream'}\r\n\r\n`,
        ),
        p.content,
        Buffer.from('\r\n'),
      );
    } else {
      chunks.push(
        Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value}\r\n`),
      );
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function upload(
  token: string | undefined,
  image: Buffer,
  fields: Record<string, string> = { sourceUrl: 'https://example.com/page', title: 'A page' },
  extraHeaders: Record<string, string> = {},
) {
  const parts: Part[] = Object.entries(fields).map(([name, value]) => ({ name, value }));
  parts.push({ name: 'image', filename: 'shot.png', content: image, type: 'image/png' });
  const form = multipart(parts);
  return app.inject({
    method: 'POST',
    url: '/api/v1/captures',
    payload: form.payload,
    headers: {
      ...form.headers,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
  });
}

async function createToken(
  session: Session,
  name = 'laptop',
): Promise<{ id: number; token: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/tokens',
    payload: { name },
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrf },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

const viewIdOf = (pageUrl: string) => pageUrl.slice(`${ORIGIN}/s/`.length);

// ---- signup / login / sessions ---------------------------------------------

describe('signup (§11 registration toggle)', () => {
  it('is rejected while registration_enabled is false', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: ALICE });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'registration is closed', code: 'registration_closed' });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('creates the account and a session once enabled; cookie flags per §8', async () => {
    await setRegistration(true);
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: ALICE });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ username: 'alice', role: 'user' });
    expect(res.json().csrfToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    const cookies = res.cookies;
    const session = cookies.find((c) => c.name === 'st_session');
    expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
    const csrf = cookies.find((c) => c.name === 'st_csrf');
    expect(csrf).toMatchObject({ secure: true, sameSite: 'Lax', path: '/' });
    expect(csrf?.httpOnly).toBeFalsy();
    expect(csrf?.value).toBe(res.json().csrfToken);

    const [row] = await handle.db.select().from(users).where(eq(users.username, 'alice'));
    expect(row?.passwordHash.startsWith('$argon2id$')).toBe(true);
    // A second account for cross-user tests.
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: BOB })).statusCode,
    ).toBe(201);
  });

  it('rejects duplicate usernames, bad usernames and short passwords', async () => {
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: ALICE })).statusCode,
    ).toBe(409);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { username: 'Bad Name', password: ALICE.password },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('validation');
    const short = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { username: 'fine', password: 'short' },
    });
    expect(short.statusCode).toBe(400);
    await setRegistration(false);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/signup',
          payload: { username: 'carol', password: 'carol-password-integration' },
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe('login / me / logout', () => {
  it('rejects wrong passwords and unknown users identically', async () => {
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: ALICE.username, password: 'not-the-password-1' },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'nobody', password: 'not-the-password-1' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.body).toBe(unknown.body);
  });

  it('issues a session that /me accepts; tampered or absent cookies are 401', async () => {
    const s = await login(ALICE);
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: s.cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ username: 'alice', role: 'user', csrfToken: s.csrf });

    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me' })).statusCode).toBe(401);
    const tampered = s.cookie.replace(/st_session=([A-Za-z0-9_-]{4})/, 'st_session=AAAA');
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: tampered } }))
        .statusCode,
    ).toBe(401);
    // Session rows never hold the raw token.
    const rows = await handle.db.select().from(sessions);
    const rawToken = decodeURIComponent(/st_session=([^;]+)/.exec(s.cookie)![1]!).split('.')[0]!;
    expect(rows.some((r) => r.tokenHash === rawToken)).toBe(false);
    expect(rows.some((r) => r.tokenHash === sha256Hex(rawToken))).toBe(true);
  });

  it('logout needs CSRF, destroys the session server-side and clears cookies', async () => {
    const s = await login(ALICE);
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: s.cookie },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().code).toBe('csrf');

    const out = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: s.cookie, [CSRF_HEADER]: s.csrf },
    });
    expect(out.statusCode).toBe(204);
    expect(out.cookies.find((c) => c.name === 'st_session')?.value).toBe('');
    // Replaying the old cookie no longer works.
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: s.cookie } }))
        .statusCode,
    ).toBe(401);
  });

  it('sessions expire with the clock and stop working when the user is disabled', async () => {
    const s = await login(BOB);
    advance(config.sessionTtlDays * 86_400_000 + 1000);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: s.cookie } }))
        .statusCode,
    ).toBe(401);
    advance(-(config.sessionTtlDays * 86_400_000 + 1000));

    const s2 = await login(BOB);
    await handle.db.update(users).set({ disabledAt: clock }).where(eq(users.username, 'bob'));
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: s2.cookie } }))
        .statusCode,
    ).toBe(401);
    const relogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: BOB });
    expect(relogin.statusCode).toBe(401);
    await handle.db.update(users).set({ disabledAt: null }).where(eq(users.username, 'bob'));
  });
});

describe('login throttle (§11)', () => {
  const attempt = (username: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password: 'definitely-wrong-password' },
    });

  it('locks an account after the free attempts with a Retry-After, then releases', async () => {
    expect((await attempt('alice')).statusCode).toBe(401);
    expect((await attempt('alice')).statusCode).toBe(401);
    expect((await attempt('alice')).statusCode).toBe(401); // 3rd failure trips the lock
    const locked = await attempt('alice');
    expect(locked.statusCode).toBe(429);
    expect(locked.headers['retry-after']).toBe('30');
    expect(locked.json()).toMatchObject({ code: 'throttled', retryAfterSeconds: 30 });
    // Even the right password is refused while locked — otherwise the lock is no brake.
    const right = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: ALICE });
    expect(right.statusCode).toBe(429);

    advance(31_000);
    const s = await login(ALICE);
    expect(s.csrf).toBeTruthy();
  });

  it('throttles unknown usernames the same way (no existence oracle)', async () => {
    for (let i = 0; i < 3; i++) expect((await attempt('ghost')).statusCode).toBe(401);
    expect((await attempt('ghost')).statusCode).toBe(429);
    advance(31_000);
  });
});

// ---- API tokens --------------------------------------------------------------

describe('API tokens (§11)', () => {
  let alice: Session;
  beforeAll(async () => {
    alice = await login(ALICE);
  });

  it('require a session and CSRF for creation', async () => {
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/tokens', payload: { name: 'x' } }))
        .statusCode,
    ).toBe(401);
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/tokens',
      payload: { name: 'x' },
      headers: { cookie: alice.cookie },
    });
    expect(noCsrf.statusCode).toBe(403);
    const wrongCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/tokens',
      payload: { name: 'x' },
      headers: { cookie: alice.cookie, [CSRF_HEADER]: alice.csrf.replace(/.$/, '!') },
    });
    expect(wrongCsrf.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/tokens' })).statusCode).toBe(401);
  });

  it('show the plaintext once and store only its sha256', async () => {
    const created = await createToken(alice, 'laptop');
    expect(created.token.startsWith(API_TOKEN_PREFIX)).toBe(true);
    expect(Buffer.from(created.token.slice(API_TOKEN_PREFIX.length), 'base64url')).toHaveLength(20);

    const [row] = await handle.db.select().from(apiTokens).where(eq(apiTokens.id, created.id));
    expect(row?.tokenHash).toBe(sha256Hex(created.token));
    expect(JSON.stringify(row)).not.toContain(created.token);

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/tokens',
      headers: { cookie: alice.cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(created.token);
    expect(list.json().tokens[0]).toMatchObject({
      id: created.id,
      name: 'laptop',
      lastUsedAt: null,
      revokedAt: null,
    });
  });

  it('can be revoked by their owner only; revoking twice is 404', async () => {
    const created = await createToken(alice, 'phone');
    const bob = await login(BOB);
    const asBob = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tokens/${created.id}`,
      headers: { cookie: bob.cookie, [CSRF_HEADER]: bob.csrf },
    });
    expect(asBob.statusCode).toBe(404);

    const noCsrf = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tokens/${created.id}`,
      headers: { cookie: alice.cookie },
    });
    expect(noCsrf.statusCode).toBe(403);

    const ok = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tokens/${created.id}`,
      headers: { cookie: alice.cookie, [CSRF_HEADER]: alice.csrf },
    });
    expect(ok.statusCode).toBe(204);
    const again = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tokens/${created.id}`,
      headers: { cookie: alice.cookie, [CSRF_HEADER]: alice.csrf },
    });
    expect(again.statusCode).toBe(404);
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/tokens',
      headers: { cookie: alice.cookie },
    });
    const entry = list.json().tokens.find((t: { id: number }) => t.id === created.id);
    expect(entry.revokedAt).toBe(clock.toISOString());
  });
});

// ---- upload -----------------------------------------------------------------

describe('POST /api/v1/captures (§8, §12)', () => {
  let alice: Session;
  let token: { id: number; token: string };
  let png: Buffer;
  beforeAll(async () => {
    alice = await login(ALICE);
    token = await createToken(alice, 'uploader');
    png = await makePng(120, 80);
  });

  it('authn matrix: no token / malformed / bad / cookie-only → 401', async () => {
    const none = await upload(undefined, png);
    expect(none.statusCode).toBe(401);
    expect(none.headers['www-authenticate']).toMatch(/^Bearer/);
    expect((await upload('not-a-token', png)).statusCode).toBe(401);
    expect(
      (await upload(`${API_TOKEN_PREFIX}${randomBytes(20).toString('base64url')}`, png)).statusCode,
    ).toBe(401);
    const malformed = await upload(undefined, png, undefined, { authorization: 'Basic abc' });
    expect(malformed.statusCode).toBe(401);
    // CLAUDE.md rule 8: a valid session cookie (+CSRF) is not authentication here.
    const cookieOnly = await upload(undefined, png, undefined, {
      cookie: alice.cookie,
      [CSRF_HEADER]: alice.csrf,
    });
    expect(cookieOnly.statusCode).toBe(401);
    expect(await handle.db.select().from(captures)).toHaveLength(0);
  });

  it('stores a capture with full attribution and returns the two URLs', async () => {
    const res = await upload(token.token, png, {
      sourceUrl: 'HTTPS://Example.com/Some/Path?q=1',
      title: '  Example   page  ',
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.pageUrl).toMatch(new RegExp(`^${ORIGIN}/s/[A-Za-z0-9_-]{${VIEW_ID_LENGTH}}$`));
    expect(body.imageUrl).toBe(`${body.pageUrl}/image.png`);
    expect(Object.keys(body).sort()).toEqual(['imageUrl', 'pageUrl']);

    const [row] = await handle.db
      .select()
      .from(captures)
      .where(eq(captures.viewId, viewIdOf(body.pageUrl)));
    expect(row).toBeDefined();
    const [owner] = await handle.db.select().from(users).where(eq(users.username, 'alice'));
    expect(row!.ownerId).toBe(owner!.id);
    expect(row!.uploadTokenId).toBe(token.id);
    expect(row!.uploadIp).toBe('127.0.0.1');
    expect(row!.sourceUrl).toBe('https://example.com/Some/Path?q=1');
    expect(row!.pageTitle).toBe('Example page');
    expect(row!.width).toBe(120);
    expect(row!.height).toBe(80);
    expect(row!.deletedAt).toBeNull();
    expect(row!.retentionUntil?.toISOString()).toBe(
      new Date(clock.getTime() + RETENTION_DEFAULT_DAYS * 86_400_000).toISOString(),
    );
    expect(row!.annotations).toEqual({ version: 1, rev: 0, shapes: [] });

    const stored = readFileSync(store.pathFor(row!.id));
    expect(row!.bytes).toBe(stored.length);
    expect(row!.sha256).toBe(sha256Hex(stored));
    expect(store.pathFor(row!.id)).toMatch(/\/[0-9a-f]{2}\/\d+\.png$/);

    const [tok] = await handle.db.select().from(apiTokens).where(eq(apiTokens.id, token.id));
    expect(tok!.lastUsedAt?.toISOString()).toBe(clock.toISOString());
  });

  it('re-encodes: an EXIF-laden JPEG is stored as a PNG with no metadata', async () => {
    const jpeg = await makeJpegWithExif(50, 40);
    expect((await sharp(jpeg).metadata()).exif).toBeInstanceOf(Buffer);
    const res = await upload(token.token, jpeg);
    expect(res.statusCode).toBe(201);
    const [row] = await handle.db
      .select()
      .from(captures)
      .where(eq(captures.viewId, viewIdOf(res.json().pageUrl)));
    const stored = readFileSync(store.pathFor(row!.id));
    expect(stored.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const meta = await sharp(stored).metadata();
    expect(meta.format).toBe('png');
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(stored.includes(Buffer.from('snapping-turtle test fixture'))).toBe(false);
    expect(stored.equals(jpeg)).toBe(false); // never the uploaded bytes verbatim
  });

  it('rejects SVG (415), oversized bodies (413) and over-dimension images (422)', async () => {
    const svg = await upload(token.token, SVG_BYTES);
    expect(svg.statusCode).toBe(415);
    expect(svg.json().code).toBe('unsupported_media_type');

    const big = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      randomBytes(config.maxUploadMb * 1024 * 1024 + 1024),
    ]);
    const tooBig = await upload(token.token, big);
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json().code).toBe('payload_too_large');

    const wide = await upload(token.token, craftPngBomb(MAX_IMAGE_WIDTH_PX + 1, 1));
    expect(wide.statusCode).toBe(422);
    expect(wide.json().code).toBe('image_too_large');
    const bomb = await upload(token.token, craftPngBomb(MAX_IMAGE_WIDTH_PX, 16_000));
    expect(bomb.statusCode).toBe(422);
    expect(bomb.json().code).toBe('image_too_large');

    const before = await handle.db.select().from(captures);
    expect(before).toHaveLength(2); // nothing in this test was persisted
  });

  it('validates sourceUrl and title fields', async () => {
    const js = await upload(token.token, png, { sourceUrl: 'javascript:alert(1)' });
    expect(js.statusCode).toBe(400);
    expect(js.json().code).toBe('invalid_source_url');
    const missing = await upload(token.token, png, {});
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe('validation');
    const long = await upload(token.token, png, {
      sourceUrl: `https://example.com/${'a'.repeat(3000)}`,
    });
    expect(long.statusCode).toBe(400);
    // Unknown fields are stripped before the handler (Ajv removeAdditional):
    // a client-supplied ownerId can never influence attribution (rule 8).
    const extra = await upload(token.token, png, {
      sourceUrl: 'https://example.com/',
      ownerId: '999999',
    });
    expect(extra.statusCode).toBe(201);
    const [owned] = await handle.db
      .select({ ownerId: captures.ownerId })
      .from(captures)
      .where(eq(captures.viewId, viewIdOf(extra.json().pageUrl)));
    const [alice] = await handle.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, 'alice'));
    expect(owned!.ownerId).toBe(alice!.id);
    // A text field named "image" is not a file.
    const form = multipart([
      { name: 'sourceUrl', value: 'https://example.com/' },
      { name: 'image', value: png.toString('base64') },
    ]);
    const textImage = await app.inject({
      method: 'POST',
      url: '/api/v1/captures',
      payload: form.payload,
      headers: { ...form.headers, authorization: `Bearer ${token.token}` },
    });
    expect(textImage.statusCode).toBe(400);
  });

  it('a revoked token stops working immediately', async () => {
    const t = await createToken(alice, 'short-lived');
    expect((await upload(t.token, png)).statusCode).toBe(201);
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tokens/${t.id}`,
      headers: { cookie: alice.cookie, [CSRF_HEADER]: alice.csrf },
    });
    expect(del.statusCode).toBe(204);
    const after = await upload(t.token, png);
    expect(after.statusCode).toBe(401);
  });

  it('a disabled user cannot upload even with a live token', async () => {
    await handle.db.update(users).set({ disabledAt: clock }).where(eq(users.username, 'alice'));
    try {
      expect((await upload(token.token, png)).statusCode).toBe(401);
    } finally {
      await handle.db.update(users).set({ disabledAt: null }).where(eq(users.username, 'alice'));
    }
  });
});

// ---- capture page + image + uniform 404 -------------------------------------

describe('GET /s/:viewId and /s/:viewId/image.png (§6, §7)', () => {
  let pageUrl: string;
  let imageUrl: string;
  let captureId: number;
  const title = 'Quarterly <b>numbers</b> & "notes"';
  const sourceUrl = 'https://intranet.example.com/reports?q=1&r=2';

  beforeAll(async () => {
    const alice = await login(ALICE);
    const t = await createToken(alice, 'page-tests');
    const res = await upload(t.token, await makePng(300, 200), { sourceUrl, title });
    expect(res.statusCode).toBe(201);
    ({ pageUrl, imageUrl } = res.json());
    const [row] = await handle.db
      .select({ id: captures.id })
      .from(captures)
      .where(eq(captures.viewId, viewIdOf(pageUrl)));
    captureId = row!.id;
  });

  const path = (abs: string) => abs.slice(ORIGIN.length);

  it('renders the view-only page with escaped data, the source link and copy targets', async () => {
    const res = await app.inject({ method: 'GET', url: path(pageUrl) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(String(res.headers['content-security-policy'])).toContain("default-src 'self'");

    expect(res.body).toContain('Quarterly &lt;b&gt;numbers&lt;/b&gt; &amp; &quot;notes&quot;');
    expect(res.body).not.toContain('<b>numbers</b>');
    expect(res.body).toMatch(
      /<a[^>]*class="source"[^>]*href="https:\/\/intranet\.example\.com\/reports\?q=1&amp;r=2"[^>]*rel="noopener noreferrer"/,
    );
    expect(res.body).toContain('Open original page');
    expect(res.body).toContain(`data-copy="${pageUrl}"`);
    expect(res.body).toContain(`data-copy="${imageUrl}"`);
    expect(res.body).toContain(`src="${imageUrl}"`);
    expect(res.body).toContain('<script type="module" src="/assets/capture-h4sh.js"></script>');
    expect(res.body).not.toMatch(/<script(?![^>]*\bsrc=)/);
  });

  it('serves the re-encoded original as image/png with nosniff and inline disposition', async () => {
    const res = await app.inject({ method: 'GET', url: path(imageUrl) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toBe('inline; filename="capture.png"');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.headers['cache-control']).toBe('private, no-store');
    const stored = readFileSync(store.pathFor(captureId));
    expect(Number(res.headers['content-length'])).toBe(stored.length);
    expect(res.rawPayload.equals(stored)).toBe(true);
    const meta = await sharp(res.rawPayload).metadata();
    expect([meta.width, meta.height]).toEqual([300, 200]);

    const head = await app.inject({ method: 'HEAD', url: path(imageUrl) });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-type']).toBe('image/png');
  });

  it('never-existed, expired, deleted and malformed ids are byte-identical 404s', async () => {
    const alice = await login(ALICE);
    const t = await createToken(alice, '404-tests');
    const mk = async () => viewIdOf((await upload(t.token, await makePng(8, 8))).json().pageUrl);
    const expiredId = await mk();
    const deletedId = await mk();
    const liveId = await mk();
    await handle.db
      .update(captures)
      .set({ retentionUntil: new Date(clock.getTime() - 1000) })
      .where(eq(captures.viewId, expiredId));
    await handle.db
      .update(captures)
      .set({ deletedAt: clock })
      .where(eq(captures.viewId, deletedId));
    const neverId = randomBytes(20).toString('base64url');

    // Sanity: the live one still works, so the misses below are real distinctions.
    expect((await app.inject({ method: 'GET', url: `/s/${liveId}` })).statusCode).toBe(200);

    const urls = [
      `/s/${neverId}`,
      `/s/${expiredId}`,
      `/s/${deletedId}`,
      '/s/malformed-id',
      `/s/${neverId}/image.png`,
      `/s/${expiredId}/image.png`,
      `/s/${deletedId}/image.png`,
      `/s/${liveId}/other.png`,
    ];
    const responses = [];
    for (const url of urls) responses.push(await app.inject({ method: 'GET', url }));
    const strip = (h: Record<string, unknown>) => {
      const { date: _d, ...rest } = h;
      return rest;
    };
    const first = responses[0]!;
    expect(first.statusCode).toBe(404);
    expect(first.body).toBe(NOT_FOUND_HTML);
    for (const res of responses.slice(1)) {
      expect(res.statusCode).toBe(404);
      expect(res.rawPayload.equals(first.rawPayload)).toBe(true);
      expect(strip(res.headers)).toEqual(strip(first.headers));
    }
  });

  it('a capture disappears into the uniform 404 when its retention passes', async () => {
    const before = await app.inject({ method: 'GET', url: path(pageUrl) });
    expect(before.statusCode).toBe(200);
    advance((RETENTION_DEFAULT_DAYS + 1) * 86_400_000);
    try {
      const after = await app.inject({ method: 'GET', url: path(pageUrl) });
      expect(after.statusCode).toBe(404);
      expect(after.body).toBe(NOT_FOUND_HTML);
      const img = await app.inject({ method: 'GET', url: path(imageUrl) });
      expect(img.statusCode).toBe(404);
    } finally {
      advance(-(RETENTION_DEFAULT_DAYS + 1) * 86_400_000);
    }
  });
});
