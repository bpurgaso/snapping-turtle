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
import { ipBans, settings } from '../../src/db/schema.js';
import { seedAdmin } from '../../src/db/seed-admin.js';
import { Guard, GUARD_BLOCKED_HTML, type GuardEvent } from '../../src/guard.js';
import { NOT_FOUND_HTML } from '../../src/html.js';
import type { App } from '../../src/types.js';
import { makePng } from '../helpers/images.js';

/**
 * The M5 guard against a real Postgres (PLAN.md §12): invalid-lookup budget,
 * escalating persisted bans, the closed-oracle banned 429, restart rebuild,
 * XFF trust scoping, IPv6 /64 keying, general cap and the breaker. All
 * timing comes from the injected clock — no sleeps.
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
    'src/capture.ts': { file: 'assets/capture-h4sh.js', css: [] },
    'src/editor.ts': { file: 'assets/editor-h4sh.js', css: [] },
  }),
);

let clock = new Date('2026-08-31T12:00:00.000Z');
const now = () => clock;
const advanceMinutes = (min: number) => (clock = new Date(clock.getTime() + min * 60_000));

const BUDGET = 3; // >3 misses per 10 min trips a ban
const BREAKER = 10; // >10 aggregate misses per minute opens the breaker
const COOLDOWN_S = 60;

const baseEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: databaseUrl,
  SESSION_SECRET: 'integration-session-secret-not-real-0123456789',
  PUBLIC_ORIGIN: ORIGIN,
  IMAGES_DIR: imagesDir,
  WEB_DIST_DIR: webDist,
  RATE_NOT_FOUND_JITTER_MIN_MS: '0',
  RATE_NOT_FOUND_JITTER_MAX_MS: '0',
  RATE_INVALID_LOOKUP_BUDGET: String(BUDGET),
  RATE_INVALID_LOOKUP_WINDOW_MIN: '10',
  RATE_BREAKER_INVALID_PER_MIN: String(BREAKER),
  RATE_BREAKER_COOLDOWN_SECONDS: String(COOLDOWN_S),
  RATE_BAN_LADDER_MINUTES: '15,60,1440',
  RATE_GENERAL_PER_MIN: '100000', // the dedicated general-cap app lowers this
};
let handle: DbHandle;
let app: App;
let events: GuardEvent[] = [];
let ownerCookie: string;
let ownerCsrf: string;
let validPath: string; // /s/<viewId>
const OWNER = { username: 'guard-owner', password: 'guard-owner-password-not-real' };
const ADMIN = { username: 'bootstrap-admin', password: 'integration-test-password-1' };

const cookieOf = (setCookie: string | string[] | undefined): string => {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return list.map((c) => c.split(';')[0]!).join('; ');
};

/** Anonymous GET from a given client address (optionally via spoofed XFF). */
const get = (a: App, url: string, remoteAddress: string, headers: Record<string, string> = {}) =>
  a.inject({ method: 'GET', url, remoteAddress, headers });

const missUrl = () => `/s/${randomBytes(20).toString('base64url')}`;

const stripDate = (h: Record<string, unknown>) => {
  const { date: _d, ...rest } = h;
  return rest;
};

async function newApp(env: Record<string, string> = {}): Promise<{ app: App; guard: Guard }> {
  const cfg = loadConfig({ ...baseEnv, ...env });
  const guard = new Guard({
    db: handle.db,
    rate: cfg.rate,
    now,
    onEvent: (e) => events.push(e),
  });
  await guard.init();
  const built = await buildApp({ config: cfg, db: handle.db, now, guard });
  return { app: built, guard };
}

beforeAll(async () => {
  handle = createDb(databaseUrl, { max: 4 });
  await handle.sql`drop schema if exists public cascade`;
  await handle.sql`drop schema if exists drizzle cascade`;
  await handle.sql`create schema public`;
  await runMigrations(handle);
  await seedAdmin(handle.db, ADMIN);
  ({ app } = await newApp());

  // One owner with one live capture: the "valid link" side of every check.
  await handle.db
    .update(settings)
    .set({ value: true })
    .where(eq(settings.key, 'registration_enabled'));
  const signup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: OWNER,
    remoteAddress: '192.0.2.10',
  });
  expect(signup.statusCode).toBe(201);
  ownerCookie = cookieOf(signup.headers['set-cookie']);
  ownerCsrf = signup.json().csrfToken;

  const tokenRes = await app.inject({
    method: 'POST',
    url: '/api/v1/tokens',
    payload: { name: 'guard-tests' },
    headers: { cookie: ownerCookie, [CSRF_HEADER]: ownerCsrf },
    remoteAddress: '192.0.2.10',
  });
  expect(tokenRes.statusCode).toBe(201);

  const png = await makePng(32, 24);
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
  const upload = await app.inject({
    method: 'POST',
    url: '/api/v1/captures',
    payload,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      authorization: `Bearer ${tokenRes.json().token}`,
    },
    remoteAddress: '192.0.2.10',
  });
  expect(upload.statusCode).toBe(201);
  validPath = new URL(upload.json().pageUrl).pathname;
});
afterAll(async () => {
  await app.close();
  await handle.close();
});

describe('invalid-lookup budget → escalating persisted ban (§12)', () => {
  const IP = '10.1.1.1';

  it('misses within the budget stay uniform 404s and valid links work', async () => {
    for (let i = 0; i < BUDGET; i++) {
      const res = await get(app, missUrl(), IP);
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(NOT_FOUND_HTML);
    }
    expect((await get(app, validPath, IP)).statusCode).toBe(200);
  });

  it('one more miss trips a 15-minute ban persisted in ip_bans', async () => {
    expect((await get(app, missUrl(), IP)).statusCode).toBe(404); // 4th: trips
    const [row] = await handle.db.select().from(ipBans).where(eq(ipBans.ipPrefix, IP));
    expect(row).toMatchObject({ strikes: 1, reason: 'invalid-lookup budget exceeded' });
    expect(row!.bannedUntil.toISOString()).toBe(
      new Date(clock.getTime() + 15 * 60_000).toISOString(),
    );
    expect(events.filter((e) => e.tag === 'sec.ban.created')).toHaveLength(1);
  });

  it('while banned, valid and invalid links get byte-identical 429s before any lookup', async () => {
    const valid = await get(app, validPath, IP);
    const invalid = await get(app, missUrl(), IP);
    const image = await get(app, `${validPath}/image.png`, IP);
    const reset = await get(app, '/reset/whatever', IP);
    for (const res of [valid, invalid, image, reset]) {
      expect(res.statusCode).toBe(429);
      expect(res.body).toBe(GUARD_BLOCKED_HTML);
      expect(res.headers['retry-after']).toBe(String(15 * 60));
      // Rules 6 & 10 hold on guard responses too — helmet runs first.
      expect(String(res.headers['content-security-policy'])).toContain("default-src 'self'");
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
      expect(res.headers['cache-control']).toBe('private, no-store');
    }
    expect(invalid.rawPayload.equals(valid.rawPayload)).toBe(true);
    expect(stripDate(invalid.headers)).toEqual(stripDate(valid.headers));
    expect(stripDate(image.headers)).toEqual(stripDate(valid.headers));
    // Another IP is untouched.
    expect((await get(app, validPath, '10.1.1.2')).statusCode).toBe(200);
  });

  it('blocked requests do not extend the ban and it lapses on schedule', async () => {
    advanceMinutes(15);
    clock = new Date(clock.getTime() + 1000);
    expect((await get(app, validPath, IP)).statusCode).toBe(200);
  });

  it('strikes escalate 15 min → 1 h → 24 h and the last rung repeats', async () => {
    const trip = async () => {
      for (let i = 0; i <= BUDGET; i++)
        expect((await get(app, missUrl(), IP)).statusCode).toBe(404);
    };
    await trip(); // strike 2
    let [row] = await handle.db.select().from(ipBans).where(eq(ipBans.ipPrefix, IP));
    expect(row!.strikes).toBe(2);
    expect(row!.bannedUntil.getTime() - clock.getTime()).toBe(60 * 60_000);

    advanceMinutes(61);
    await trip(); // strike 3
    [row] = await handle.db.select().from(ipBans).where(eq(ipBans.ipPrefix, IP));
    expect(row!.strikes).toBe(3);
    expect(row!.bannedUntil.getTime() - clock.getTime()).toBe(1440 * 60_000);

    advanceMinutes(1441);
    await trip(); // strike 4: ladder clamps at the last rung
    [row] = await handle.db.select().from(ipBans).where(eq(ipBans.ipPrefix, IP));
    expect(row!.strikes).toBe(4);
    expect(row!.bannedUntil.getTime() - clock.getTime()).toBe(1440 * 60_000);
    advanceMinutes(1441); // leave this IP unbanned for later suites
  });

  it('a restart rebuilds guard state from the database (no amnesty)', async () => {
    // Ban 10.2.2.2 on the running app, then boot a second app over the same DB.
    for (let i = 0; i <= BUDGET; i++) await get(app, missUrl(), '10.2.2.2');
    const rebooted = await newApp();
    try {
      const res = await get(rebooted.app, validPath, '10.2.2.2');
      expect(res.statusCode).toBe(429);
      expect(res.body).toBe(GUARD_BLOCKED_HTML);
      expect((await get(rebooted.app, validPath, '10.2.2.3')).statusCode).toBe(200);
    } finally {
      await rebooted.app.close();
    }
  });

  it('keys IPv6 clients by /64: rotating interface ids buys nothing', async () => {
    for (let i = 0; i <= BUDGET; i++) {
      await get(app, missUrl(), `2001:db8:0:7::${(i + 1).toString(16)}`);
    }
    // A fresh address in the same /64 is banned…
    const sameSlice = await get(app, validPath, '2001:db8:0:7:dead:beef:0:1');
    expect(sameSlice.statusCode).toBe(429);
    // …the neighbouring /64 is not.
    expect((await get(app, validPath, '2001:db8:0:8::1')).statusCode).toBe(200);
    const [row] = await handle.db
      .select()
      .from(ipBans)
      .where(eq(ipBans.ipPrefix, '2001:db8:0:7::/64'));
    expect(row?.strikes).toBe(1);
  });
});

describe('X-Forwarded-For is trusted only from the proxy network (§12)', () => {
  let xffApp: App;
  beforeAll(async () => {
    ({ app: xffApp } = await newApp({ TRUST_PROXY: '10.99.0.0/16' }));
  });
  afterAll(() => xffApp.close());

  it('a connection from the proxy CIDR asserts the client IP; bans key on it', async () => {
    for (let i = 0; i <= BUDGET; i++) {
      await get(xffApp, missUrl(), '10.99.0.2', { 'x-forwarded-for': '198.51.100.9' });
    }
    const banned = await get(xffApp, validPath, '10.99.0.2', {
      'x-forwarded-for': '198.51.100.9',
    });
    expect(banned.statusCode).toBe(429);
    // Same proxy, different client: unaffected.
    const other = await get(xffApp, validPath, '10.99.0.2', {
      'x-forwarded-for': '198.51.100.10',
    });
    expect(other.statusCode).toBe(200);
  });

  it('a spoofed header from outside the CIDR is ignored', async () => {
    // 198.51.100.9 is banned above; a direct connection claiming to be the
    // proxy's client is keyed on its own socket address instead.
    const spoof = await get(xffApp, validPath, '203.0.113.50', {
      'x-forwarded-for': '198.51.100.9',
    });
    expect(spoof.statusCode).toBe(200);
    // And misses from it ban the connecting address, not the claimed one.
    for (let i = 0; i <= BUDGET; i++) {
      await get(xffApp, missUrl(), '203.0.113.50', { 'x-forwarded-for': '198.51.100.11' });
    }
    expect(
      await handle.db.select().from(ipBans).where(eq(ipBans.ipPrefix, '198.51.100.11')),
    ).toHaveLength(0);
    const [row] = await handle.db.select().from(ipBans).where(eq(ipBans.ipPrefix, '203.0.113.50'));
    expect(row?.strikes).toBe(1);
  });
});

describe('general unauthenticated cap (§12)', () => {
  let capApp: App;
  beforeAll(async () => {
    ({ app: capApp } = await newApp({
      RATE_GENERAL_PER_MIN: '3',
      RATE_INVALID_LOOKUP_BUDGET: '1000',
    }));
  });
  afterAll(() => capApp.close());

  it('caps anonymous requests per IP per minute; sessions are exempt; the window slides', async () => {
    const IP = '10.50.0.1';
    // 1st anonymous request: sign in (login itself is unauthenticated).
    const login = await capApp.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: OWNER,
      remoteAddress: IP,
    });
    expect(login.statusCode).toBe(200);
    const cookie = cookieOf(login.headers['set-cookie']);

    expect((await get(capApp, '/', IP)).statusCode).toBe(200); // 2nd
    expect((await get(capApp, '/', IP)).statusCode).toBe(200); // 3rd
    const over = await get(capApp, '/', IP); // 4th within the minute
    expect(over.statusCode).toBe(429);
    expect(over.json()).toMatchObject({ code: 'throttled' });
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);

    // On secret routes the refusal is the pre-lookup blocked page.
    const secret = await get(capApp, validPath, IP);
    expect(secret.statusCode).toBe(429);
    expect(secret.body).toBe(GUARD_BLOCKED_HTML);

    // The authenticated session keeps working from the same IP.
    for (let i = 0; i < 5; i++) {
      const me = await capApp.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { cookie },
        remoteAddress: IP,
      });
      expect(me.statusCode).toBe(200);
    }
    // Another IP is not affected; the window frees after a minute.
    expect((await get(capApp, '/', '10.50.0.2')).statusCode).toBe(200);
    advanceMinutes(2);
    expect((await get(capApp, '/', IP)).statusCode).toBe(200);
  });
});

describe('global breaker (§12)', () => {
  const breakerEvents = () =>
    events.filter((e) => e.tag.startsWith('sec.breaker.')).map((e) => e.tag);

  it('opens when aggregate invalid lookups exceed the threshold', async () => {
    advanceMinutes(2); // fresh minute for the aggregate window
    events = [];
    // 12 misses spread over 6 IPs — no single IP exceeds its budget of 3.
    for (let ip = 1; ip <= 6; ip++) {
      for (let i = 0; i < 2; i++) {
        await get(app, missUrl(), `10.60.0.${ip}`);
      }
    }
    expect(events.some((e) => e.tag === 'sec.breaker.opened')).toBe(true);
    expect(events.filter((e) => e.tag === 'sec.ban.created')).toHaveLength(0);
  });

  it('while open: anonymous /s/* gets 429 + Retry-After, sessions pass, other routes work', async () => {
    const anonValid = await get(app, validPath, '10.61.0.1');
    const anonInvalid = await get(app, missUrl(), '10.61.0.1');
    expect(anonValid.statusCode).toBe(429);
    expect(anonValid.body).toBe(GUARD_BLOCKED_HTML);
    expect(Number(anonValid.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(anonValid.headers['retry-after'])).toBeLessThanOrEqual(COOLDOWN_S);
    expect(anonInvalid.rawPayload.equals(anonValid.rawPayload)).toBe(true);
    expect(stripDate(anonInvalid.headers)).toEqual(stripDate(anonValid.headers));

    const authed = await app.inject({
      method: 'GET',
      url: validPath,
      headers: { cookie: ownerCookie },
      remoteAddress: '10.61.0.1',
    });
    expect(authed.statusCode).toBe(200);

    expect((await get(app, '/', '10.61.0.1')).statusCode).toBe(200);
  });

  it('half-opens after the cool-down and closes after a clean minute', async () => {
    advanceMinutes(1.1); // past the 60 s cooldown
    const probe = await get(app, validPath, '10.61.0.2');
    expect(probe.statusCode).toBe(200);
    expect(breakerEvents()).toContain('sec.breaker.half_open');

    advanceMinutes(1.1); // a clean minute in half-open closes it
    expect((await get(app, validPath, '10.61.0.3')).statusCode).toBe(200);
    expect(breakerEvents()).toContain('sec.breaker.closed');
  });

  it('re-opens from half-open when probes keep missing', async () => {
    events = [];
    advanceMinutes(2);
    for (let ip = 1; ip <= 6; ip++) {
      for (let i = 0; i < 2; i++) await get(app, missUrl(), `10.62.0.${ip}`);
    }
    expect(events.some((e) => e.tag === 'sec.breaker.opened')).toBe(true);
    advanceMinutes(1.1);
    // First anonymous request transitions to half-open and is admitted…
    const probeMiss = await get(app, missUrl(), '10.63.0.1');
    expect(probeMiss.statusCode).toBe(404);
    // …but its miss exceeds the half-open tolerance (ceil(10/10) = 1): re-open.
    expect(events.filter((e) => e.tag === 'sec.breaker.opened')).toHaveLength(2);
    expect((await get(app, validPath, '10.63.0.2')).statusCode).toBe(429);
  });
});
