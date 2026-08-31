import { ACCOUNT_LINK_TTL_HOURS } from '@snapping-turtle/shared';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { issueAccountLink, type IssuedLink } from '../../src/auth/links.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { accountLinks, auditLog, ipBans, sessions, users } from '../../src/db/schema.js';
import { seedAdmin } from '../../src/db/seed-admin.js';
import { NOT_FOUND_HTML } from '../../src/html.js';
import { sha256Hex } from '../../src/ids.js';
import { hashPassword } from '../../src/password.js';
import type { App } from '../../src/types.js';

/**
 * One-time set-password links (§11): the /reset/:token page, atomic
 * consumption via POST /api/v1/auth/set-password, session revocation, and
 * the uniform-404 + guard coupling for the token space (§12). Links are
 * issued directly through the service here; the admin routes that issue
 * them over HTTP are covered by the admin suite.
 */
const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests');

const imagesDir = mkdtempSync(join(tmpdir(), 'st-images-'));
const webDist = mkdtempSync(join(tmpdir(), 'st-web-'));
mkdirSync(join(webDist, '.vite'));
writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>t</title>');
const RESET_PAGE = '<!doctype html><title>set password</title><main id="app"></main>';
writeFileSync(join(webDist, 'reset.html'), RESET_PAGE);
writeFileSync(
  join(webDist, '.vite', 'manifest.json'),
  JSON.stringify({
    'src/capture.ts': { file: 'assets/capture-h4sh.js', css: [] },
    'src/editor.ts': { file: 'assets/editor-h4sh.js', css: [] },
  }),
);

let clock = new Date('2026-08-31T09:00:00.000Z');
const now = () => clock;
const advanceHours = (h: number) => (clock = new Date(clock.getTime() + h * 3_600_000));

const BUDGET = 3;
const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: databaseUrl,
  SESSION_SECRET: 'integration-session-secret-not-real-0123456789',
  PUBLIC_ORIGIN: 'https://shots.test',
  IMAGES_DIR: imagesDir,
  WEB_DIST_DIR: webDist,
  RATE_NOT_FOUND_JITTER_MIN_MS: '0',
  RATE_NOT_FOUND_JITTER_MAX_MS: '0',
  RATE_INVALID_LOOKUP_BUDGET: String(BUDGET),
  RATE_GENERAL_PER_MIN: '100000',
  RATE_BREAKER_INVALID_PER_MIN: '1000000',
});

const ADMIN = { username: 'bootstrap-admin', password: 'integration-test-password-1' };
let handle: DbHandle;
let app: App;
let adminId: number;

const cookieOf = (setCookie: string | string[] | undefined): string => {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return list.map((c) => c.split(';')[0]!).join('; ');
};

/** Create a passwordless user + link the way the admin panel does. */
async function userWithLink(username: string): Promise<{ userId: number; link: IssuedLink }> {
  const placeholder = await hashPassword(randomBytes(32).toString('base64url'));
  return handle.db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({ username, passwordHash: placeholder, role: 'user' })
      .returning({ id: users.id });
    const link = await issueAccountLink(tx, now, {
      userId: user!.id,
      purpose: 'setup',
      createdBy: adminId,
    });
    return { userId: user!.id, link };
  });
}

const setPassword = (token: string, password: string, remoteAddress = '198.18.0.1') =>
  app.inject({ method: 'POST', url: '/api/v1/auth/set-password', payload: { token, password }, remoteAddress });

beforeAll(async () => {
  handle = createDb(databaseUrl, { max: 4 });
  await handle.sql`drop schema if exists public cascade`;
  await handle.sql`drop schema if exists drizzle cascade`;
  await handle.sql`create schema public`;
  await runMigrations(handle);
  await seedAdmin(handle.db, ADMIN);
  const [admin] = await handle.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, ADMIN.username));
  adminId = admin!.id;
  app = await buildApp({ config, db: handle.db, now });
});
afterAll(async () => {
  await app.close();
  await handle.close();
});

describe('GET /reset/:token (§11)', () => {
  it('serves the identical set-password page for a live link', async () => {
    const { link } = await userWithLink('page-user');
    const res = await app.inject({ method: 'GET', url: `/reset/${link.token}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(RESET_PAGE);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    // The page never embeds the token; the client script reads the URL.
    expect(res.body).not.toContain(link.token);
    expect(link.expiresAt.getTime() - clock.getTime()).toBe(ACCOUNT_LINK_TTL_HOURS * 3_600_000);
  });

  it('misses are byte-identical with the /s/* 404 (rule 2) for every failure mode', async () => {
    const consumed = await userWithLink('modes-consumed');
    expect((await setPassword(consumed.link.token, 'a-long-enough-password-1')).statusCode).toBe(
      200,
    );
    const expired = await userWithLink('modes-expired');
    advanceHours(ACCOUNT_LINK_TTL_HOURS + 1);
    const disabled = await userWithLink('modes-disabled');
    await handle.db.update(users).set({ disabledAt: clock }).where(eq(users.id, disabled.userId));
    const live = await userWithLink('modes-live');

    const sReference = await app.inject({
      method: 'GET',
      url: `/s/${randomBytes(20).toString('base64url')}`,
    });
    const strip = (h: Record<string, unknown>) => {
      const { date: _d, ...rest } = h;
      return rest;
    };
    const missUrls = [
      `/reset/${randomBytes(20).toString('base64url')}`, // never existed
      `/reset/${consumed.link.token}`, // consumed
      `/reset/${expired.link.token}`, // expired
      `/reset/${disabled.link.token}`, // disabled user
      '/reset/not-a-token', // malformed
      '/reset/a/b', // stray sub-path
      '/reset', // bare prefix
    ];
    // One IP per miss: this test is about the 404 shape, not the budget.
    for (const [i, url] of missUrls.entries()) {
      const res = await app.inject({ method: 'GET', url, remoteAddress: `198.18.1.${i + 1}` });
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(NOT_FOUND_HTML);
      expect(res.rawPayload.equals(sReference.rawPayload)).toBe(true);
      expect(strip(res.headers)).toEqual(strip(sReference.headers));
    }
    // A live link is unaffected by the noise.
    expect(
      (await app.inject({ method: 'GET', url: `/reset/${live.link.token}` })).statusCode,
    ).toBe(200);
  });

  it('invalid /reset/* lookups count against the guard budget and bans close the surface', async () => {
    const IP = '198.18.2.2';
    for (let i = 0; i <= BUDGET; i++) {
      await app.inject({
        method: 'GET',
        url: `/reset/${randomBytes(20).toString('base64url')}`,
        remoteAddress: IP,
      });
    }
    const [ban] = await handle.db.select().from(ipBans).where(eq(ipBans.ipPrefix, IP));
    expect(ban?.strikes).toBe(1);
    const live = await userWithLink('banned-viewer');
    const blocked = await app.inject({
      method: 'GET',
      url: `/reset/${live.link.token}`,
      remoteAddress: IP,
    });
    expect(blocked.statusCode).toBe(429);
    // POSTs guessing tokens count too.
    const post = await setPassword(
      randomBytes(20).toString('base64url'),
      'a-long-enough-password-1',
      '198.18.2.3',
    );
    expect(post.statusCode).toBe(404);
    expect(post.json().code).toBe('not_found');
  });
});

describe('POST /api/v1/auth/set-password (§11)', () => {
  it('works once: sets an argon2id password, signs in, and refuses a second use', async () => {
    const { userId, link } = await userWithLink('once-user');
    const first = await setPassword(link.token, 'brand-new-password-123');
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ username: 'once-user', role: 'user' });
    const cookie = cookieOf(first.headers['set-cookie']);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } })).statusCode,
    ).toBe(200);

    const [user] = await handle.db.select().from(users).where(eq(users.id, userId));
    expect(user!.passwordHash.startsWith('$argon2id$')).toBe(true);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'once-user', password: 'brand-new-password-123' },
    });
    expect(login.statusCode).toBe(200);

    // Second use: generic 404, page gone too.
    expect((await setPassword(link.token, 'another-password-456xyz')).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: `/reset/${link.token}` })).statusCode,
    ).toBe(404);

    // Consumption is audited with an 8-char token prefix only (rule 3).
    const audits = await handle.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'auth.set_password'));
    const mine = audits.find((a) => a.targetId === userId);
    expect(mine).toBeDefined();
    expect(mine!.actorUserId).toBe(userId);
    expect(mine!.detail['token']).toBe(`${link.token.slice(0, 8)}…`);
    expect(JSON.stringify(audits)).not.toContain(link.token);
  });

  it('expires after 24 h', async () => {
    const { link } = await userWithLink('expiry-user');
    advanceHours(ACCOUNT_LINK_TTL_HOURS + 1);
    expect((await setPassword(link.token, 'a-long-enough-password-1')).statusCode).toBe(404);
    const [row] = await handle.db
      .select()
      .from(accountLinks)
      .where(eq(accountLinks.tokenHash, sha256Hex(link.token)));
    expect(row!.consumedAt).toBeNull();
  });

  it('completing a reset revokes the user’s other sessions', async () => {
    const { userId, link } = await userWithLink('revoke-user');
    expect((await setPassword(link.token, 'first-password-abcdef1')).statusCode).toBe(200);
    // Two live sessions from two browsers.
    const s1 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'revoke-user', password: 'first-password-abcdef1' },
    });
    const c1 = cookieOf(s1.headers['set-cookie']);
    // Admin issues a reset; the user completes it elsewhere.
    const reset = await handle.db.transaction(async (tx) =>
      issueAccountLink(tx, now, { userId, purpose: 'reset', createdBy: adminId }),
    );
    const done = await setPassword(reset.token, 'second-password-uvwxyz2');
    expect(done.statusCode).toBe(200);
    // The old session is gone server-side.
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: c1 } }))
        .statusCode,
    ).toBe(401);
    const rows = await handle.db.select().from(sessions).where(eq(sessions.userId, userId));
    expect(rows).toHaveLength(1); // only the session minted by the reset itself
    // Old password no longer works.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { username: 'revoke-user', password: 'first-password-abcdef1' },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('a validation failure consumes nothing', async () => {
    const { link } = await userWithLink('short-pass-user');
    const res = await setPassword(link.token, 'short');
    expect(res.statusCode).toBe(400);
    expect((await setPassword(link.token, 'now-a-proper-password-1')).statusCode).toBe(200);
  });

  it('a disabled user’s link is refused and stays unconsumed', async () => {
    const { userId, link } = await userWithLink('disabled-user');
    await handle.db.update(users).set({ disabledAt: clock }).where(eq(users.id, userId));
    expect((await setPassword(link.token, 'a-long-enough-password-1')).statusCode).toBe(404);
    const [row] = await handle.db
      .select()
      .from(accountLinks)
      .where(eq(accountLinks.userId, userId));
    expect(row!.consumedAt).toBeNull();
    // Re-enabling restores the link — nothing was burned.
    await handle.db.update(users).set({ disabledAt: null }).where(eq(users.id, userId));
    expect((await setPassword(link.token, 'a-long-enough-password-1')).statusCode).toBe(200);
  });
});
