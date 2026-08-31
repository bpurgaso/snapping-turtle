import { ACCOUNT_LINK_TTL_HOURS, CSRF_HEADER, VIEW_ID_LENGTH } from '@snapping-turtle/shared';
import { desc, eq } from 'drizzle-orm';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { auditLog, captures, ipBans, settings, users } from '../../src/db/schema.js';
import { seedAdmin } from '../../src/db/seed-admin.js';
import { NOT_FOUND_HTML } from '../../src/html.js';
import { ImageStore } from '../../src/images/storage.js';
import type { App } from '../../src/types.js';
import { makePng } from '../helpers/images.js';

/**
 * The admin panel API (§11): full authz matrix, every mutation audit-logged
 * in its own transaction, the one-time-link account lifecycle end-to-end
 * over HTTP, capture management, the audit browser, and guard status/unban.
 */
const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests');

const ORIGIN = 'https://shots.test';
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

let clock = new Date('2026-08-31T10:00:00.000Z');
const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: databaseUrl,
  SESSION_SECRET: 'integration-session-secret-not-real-0123456789',
  PUBLIC_ORIGIN: ORIGIN,
  IMAGES_DIR: imagesDir,
  WEB_DIST_DIR: webDist,
  RATE_NOT_FOUND_JITTER_MIN_MS: '0',
  RATE_NOT_FOUND_JITTER_MAX_MS: '0',
  // Frozen clock: raise guard budgets so M5 admin behavior is observable
  // without windows ever sliding (config, not bypasses).
  RATE_GENERAL_PER_MIN: '100000',
  RATE_INVALID_LOOKUP_BUDGET: '100000',
  RATE_BREAKER_INVALID_PER_MIN: '1000000',
});

const ADMIN = { username: 'bootstrap-admin', password: 'integration-test-password-1' };
const ALICE = { username: 'alice', password: 'alice-password-integration-1' };

let handle: DbHandle;
let app: App;
const store = new ImageStore(imagesDir);

interface Session {
  cookie: string;
  csrf: string;
}
let admin: Session;
let alice: Session;
let aliceId: number;

/** Raw secrets seen during this suite; the closing sweep proves none reach audit rows. */
const secretsSeen: string[] = [];

const cookieOf = (setCookie: string | string[] | undefined): string => {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return list.map((c) => c.split(';')[0]!).join('; ');
};

async function login(creds: { username: string; password: string }): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: creds });
  expect(res.statusCode).toBe(200);
  return { cookie: cookieOf(res.headers['set-cookie']), csrf: res.json().csrfToken };
}

async function uploadAs(session: Session): Promise<{ viewId: string; id: number }> {
  const tokenRes = await app.inject({
    method: 'POST',
    url: '/api/v1/tokens',
    payload: { name: `up-${randomBytes(4).toString('hex')}` },
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrf },
  });
  expect(tokenRes.statusCode).toBe(201);
  secretsSeen.push(tokenRes.json().token);
  const png = await makePng(40, 30);
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
  const viewId = res.json().pageUrl.slice(`${ORIGIN}/s/`.length) as string;
  secretsSeen.push(viewId);
  const [row] = await handle.db
    .select({ id: captures.id })
    .from(captures)
    .where(eq(captures.viewId, viewId));
  return { viewId, id: row!.id };
}

const latestAudit = async (action: string) => {
  const [row] = await handle.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.action, action))
    .orderBy(desc(auditLog.id))
    .limit(1);
  return row;
};
const auditCount = async () => {
  const rows = await handle.db.select({ id: auditLog.id }).from(auditLog);
  return rows.length;
};

beforeAll(async () => {
  handle = createDb(databaseUrl, { max: 4 });
  await handle.sql`drop schema if exists public cascade`;
  await handle.sql`drop schema if exists drizzle cascade`;
  await handle.sql`create schema public`;
  await runMigrations(handle);
  await seedAdmin(handle.db, ADMIN);
  app = await buildApp({ config, db: handle.db, now: () => clock });

  admin = await login(ADMIN);
  await handle.db
    .update(settings)
    .set({ value: true })
    .where(eq(settings.key, 'registration_enabled'));
  const signup = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: ALICE });
  expect(signup.statusCode).toBe(201);
  await handle.db
    .update(settings)
    .set({ value: false })
    .where(eq(settings.key, 'registration_enabled'));
  alice = await login(ALICE);
  const [a] = await handle.db.select({ id: users.id }).from(users).where(eq(users.username, 'alice'));
  aliceId = a!.id;
});
afterAll(async () => {
  await app.close();
  await handle.close();
});

// ---- authz matrix -----------------------------------------------------------

describe('admin authz matrix (CLAUDE.md rule 8)', () => {
  const routes: Array<{ method: string; url: string; body?: unknown }> = [
    { method: 'GET', url: '/api/v1/admin/settings' },
    { method: 'PUT', url: '/api/v1/admin/settings/registration', body: { enabled: false } },
    { method: 'GET', url: '/api/v1/admin/users' },
    { method: 'POST', url: '/api/v1/admin/users', body: { username: 'matrix-user' } },
    { method: 'POST', url: '/api/v1/admin/users/1/disable' },
    { method: 'POST', url: '/api/v1/admin/users/1/enable' },
    { method: 'POST', url: '/api/v1/admin/users/1/reset-link' },
    { method: 'GET', url: '/api/v1/admin/captures?userId=1' },
    { method: 'PATCH', url: '/api/v1/admin/captures/1', body: { indefinite: true } },
    { method: 'DELETE', url: '/api/v1/admin/captures/1' },
    { method: 'GET', url: '/api/v1/admin/audit' },
    { method: 'GET', url: '/api/v1/admin/guard' },
    { method: 'POST', url: '/api/v1/admin/guard/unban', body: { ipPrefix: '10.0.0.1' } },
  ];

  it('every admin route rejects anonymous (401) and non-admin (403) callers', async () => {
    const before = await auditCount();
    for (const r of routes) {
      const anon = await app.inject({
        method: r.method as 'GET',
        url: r.url,
        ...(r.body ? { payload: r.body as object } : {}),
      });
      expect(anon.statusCode, `${r.method} ${r.url} anonymous`).toBe(401);
      const nonAdmin = await app.inject({
        method: r.method as 'GET',
        url: r.url,
        headers: { cookie: alice.cookie, [CSRF_HEADER]: alice.csrf },
        ...(r.body ? { payload: r.body as object } : {}),
      });
      expect(nonAdmin.statusCode, `${r.method} ${r.url} as user`).toBe(403);
      expect(nonAdmin.json().code).toBe('forbidden');
    }
    expect(await auditCount()).toBe(before); // refused calls audit nothing
  });

  it('every mutation additionally requires CSRF for the admin (403)', async () => {
    const before = await auditCount();
    for (const r of routes.filter((x) => x.method !== 'GET')) {
      const res = await app.inject({
        method: r.method as 'POST',
        url: r.url,
        headers: { cookie: admin.cookie }, // no CSRF header
        ...(r.body ? { payload: r.body as object } : {}),
      });
      expect(res.statusCode, `${r.method} ${r.url} without CSRF`).toBe(403);
      expect(res.json().code).toBe('csrf');
    }
    expect(await auditCount()).toBe(before);
  });
});

// ---- settings ---------------------------------------------------------------

describe('registration toggle (§11)', () => {
  const asAdmin = () => ({ cookie: admin.cookie, [CSRF_HEADER]: admin.csrf });

  it('reads and flips the setting, audit-logging both states', async () => {
    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings',
      headers: { cookie: admin.cookie },
    });
    expect(before.json()).toEqual({ enabled: false });

    const on = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/registration',
      payload: { enabled: true },
      headers: asAdmin(),
    });
    expect(on.statusCode).toBe(200);
    const signup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { username: 'toggle-probe', password: 'toggle-probe-password-1' },
    });
    expect(signup.statusCode).toBe(201);

    const off = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/registration',
      payload: { enabled: false },
      headers: asAdmin(),
    });
    expect(off.statusCode).toBe(200);

    const rows = await handle.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'settings.registration'));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const details = rows.map((r) => r.detail['enabled']);
    expect(details).toContain(true);
    expect(details).toContain(false);
    expect(rows[0]!.ip).toBe('127.0.0.1');
  });
});

// ---- account lifecycle ------------------------------------------------------

describe('account lifecycle via one-time links (§11)', () => {
  const asAdmin = () => ({ cookie: admin.cookie, [CSRF_HEADER]: admin.csrf });

  it('create user issues a single-use setup link, shown exactly once', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      payload: { username: 'newcomer' },
      headers: asAdmin(),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.username).toBe('newcomer');
    expect(body.resetUrl).toMatch(
      new RegExp(`^${ORIGIN}/reset/[A-Za-z0-9_-]{${VIEW_ID_LENGTH}}$`),
    );
    expect(body.expiresAt).toBe(
      new Date(clock.getTime() + ACCOUNT_LINK_TTL_HOURS * 3_600_000).toISOString(),
    );
    const token = body.resetUrl.slice(`${ORIGIN}/reset/`.length) as string;
    secretsSeen.push(token);

    // The new account cannot sign in yet (placeholder password is unusable).
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { username: 'newcomer', password: 'anything-guessable-123' },
        })
      ).statusCode,
    ).toBe(401);

    // The link page is live; consuming it sets the password and signs in.
    expect(
      (await app.inject({ method: 'GET', url: `/reset/${token}` })).statusCode,
    ).toBe(200);
    const done = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/set-password',
      payload: { token, password: 'newcomer-chosen-password-1' },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ username: 'newcomer', role: 'user' });
    // Once only.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/set-password',
          payload: { token, password: 'try-again-password-9999' },
        })
      ).statusCode,
    ).toBe(404);

    const created = await latestAudit('user.create');
    expect(created).toMatchObject({ targetType: 'user' });
    expect(created!.detail['username']).toBe('newcomer');
    expect(created!.detail['token']).toBe(`${token.slice(0, 8)}…`);
  });

  it('duplicate usernames are 409 and, mid-transaction, leave no audit row', async () => {
    const before = await auditCount();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      payload: { username: 'alice' },
      headers: asAdmin(),
    });
    expect(res.statusCode).toBe(409);
    expect(await auditCount()).toBe(before);
  });

  it('disable revokes sessions immediately; enable restores; both audited', async () => {
    const aliceSession = await login(ALICE);
    const disable = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${aliceId}/disable`,
      headers: asAdmin(),
    });
    expect(disable.statusCode).toBe(204);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/auth/me',
          headers: { cookie: aliceSession.cookie },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: ALICE })).statusCode,
    ).toBe(401);
    expect(await latestAudit('user.disable')).toMatchObject({ targetId: aliceId });

    // Double-disable is a conflict, not a silent no-op.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/admin/users/${aliceId}/disable`,
          headers: asAdmin(),
        })
      ).statusCode,
    ).toBe(409);

    const enable = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${aliceId}/enable`,
      headers: asAdmin(),
    });
    expect(enable.statusCode).toBe(204);
    alice = await login(ALICE);
    expect(await latestAudit('user.enable')).toMatchObject({ targetId: aliceId });
  });

  it('admins cannot disable themselves', async () => {
    const [adminRow] = await handle.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, ADMIN.username));
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${adminRow!.id}/disable`,
      headers: asAdmin(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('reset-link issues a fresh link for an existing user and audits the issuance', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${aliceId}/reset-link`,
      headers: asAdmin(),
    });
    expect(res.statusCode).toBe(201);
    const token = res.json().resetUrl.slice(`${ORIGIN}/reset/`.length) as string;
    secretsSeen.push(token);
    const issued = await latestAudit('link.issue');
    expect(issued!.detail).toMatchObject({ userId: aliceId, purpose: 'reset' });
    expect(issued!.detail['token']).toBe(`${token.slice(0, 8)}…`);

    // The unknown-user variant is a plain admin 404.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/users/999999/reset-link',
          headers: asAdmin(),
        })
      ).statusCode,
    ).toBe(404);
  });
});

// ---- captures ---------------------------------------------------------------

describe('admin capture management (§7, §11)', () => {
  const asAdmin = () => ({ cookie: admin.cookie, [CSRF_HEADER]: admin.csrf });
  let mine: { viewId: string; id: number };

  beforeAll(async () => {
    mine = await uploadAs(alice);
  });

  it('search by user pages through captures with the capability URL', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/captures?userId=${aliceId}`,
      headers: { cookie: admin.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.page).toBe(1);
    const entry = body.captures.find((c: { id: number }) => c.id === mine.id);
    expect(entry).toMatchObject({
      pageUrl: `${ORIGIN}/s/${mine.viewId}`,
      deletedAt: null,
    });
    expect(entry.retentionUntil).not.toBeNull();
  });

  it('"Keep indefinitely" nulls retention, unchecking restores the default — both audited', async () => {
    const on = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/captures/${mine.id}`,
      payload: { indefinite: true },
      headers: asAdmin(),
    });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({ retentionUntil: null });
    let [row] = await handle.db.select().from(captures).where(eq(captures.id, mine.id));
    expect(row!.retentionUntil).toBeNull();
    expect(await latestAudit('capture.retention')).toMatchObject({ targetId: mine.id });

    const off = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/captures/${mine.id}`,
      payload: { indefinite: false },
      headers: asAdmin(),
    });
    expect(off.statusCode).toBe(200);
    [row] = await handle.db.select().from(captures).where(eq(captures.id, mine.id));
    expect(row!.retentionUntil?.toISOString()).toBe(
      new Date(row!.createdAt.getTime() + config.retentionDefaultDays * 86_400_000).toISOString(),
    );
  });

  it('admin delete tombstones the row, removes files, joins the uniform 404, audits', async () => {
    const doomed = await uploadAs(alice);
    const imagePath = store.pathFor(doomed.id);
    expect(existsSync(imagePath)).toBe(true);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/captures/${doomed.id}`,
      headers: asAdmin(),
    });
    expect(res.statusCode).toBe(204);
    expect(existsSync(imagePath)).toBe(false);
    const [row] = await handle.db.select().from(captures).where(eq(captures.id, doomed.id));
    expect(row!.deletedAt?.toISOString()).toBe(clock.toISOString());

    const gone = await app.inject({ method: 'GET', url: `/s/${doomed.viewId}` });
    expect(gone.statusCode).toBe(404);
    expect(gone.body).toBe(NOT_FOUND_HTML);

    const audit = await latestAudit('capture.delete');
    expect(audit).toMatchObject({ targetId: doomed.id });
    expect(JSON.stringify(audit!.detail)).not.toContain(doomed.viewId);

    // Deleting again: 404, and no extra audit row.
    const before = await auditCount();
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/captures/${doomed.id}`,
          headers: asAdmin(),
        })
      ).statusCode,
    ).toBe(404);
    expect(await auditCount()).toBe(before);
  });
});

// ---- audit browser ----------------------------------------------------------

describe('audit log browser (§11)', () => {
  it('pages newest-first with actor usernames and full detail', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit',
      headers: { cookie: admin.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pageSize).toBe(50);
    expect(body.total).toBeGreaterThanOrEqual(5);
    expect(body.entries.length).toBeGreaterThanOrEqual(5);
    // Newest first.
    const ids = body.entries.map((e: { id: number }) => e.id);
    expect([...ids].sort((a, b) => b - a)).toEqual(ids);
    // Admin actions name the admin; the set-password completion names the user.
    expect(body.entries.some((e: { actor: string }) => e.actor === ADMIN.username)).toBe(true);
    const setPw = body.entries.find((e: { action: string }) => e.action === 'auth.set_password');
    expect(setPw?.actor).toBe('newcomer');

    const page2 = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit?page=2',
      headers: { cookie: admin.cookie },
    });
    expect(page2.statusCode).toBe(200);
    expect(page2.json().page).toBe(2);
  });
});

// ---- guard status + unban ---------------------------------------------------

describe('guard status view and unban (§11, §12)', () => {
  const asAdmin = () => ({ cookie: admin.cookie, [CSRF_HEADER]: admin.csrf });
  const BANNED_IP = '203.0.113.99';

  beforeAll(async () => {
    // Plant a ban the way the guard would (this suite's budget is raised).
    await handle.db.insert(ipBans).values({
      ipPrefix: BANNED_IP,
      strikes: 2,
      bannedUntil: new Date(clock.getTime() + 3_600_000),
      reason: 'invalid-lookup budget exceeded',
      updatedAt: clock,
    });
    // A separate app instance hydrates it, exactly like a restart would.
  });

  it('reports breaker state and current bans', async () => {
    const rebooted = await buildApp({ config, db: handle.db, now: () => clock });
    try {
      const res = await rebooted.inject({
        method: 'GET',
        url: '/api/v1/admin/guard',
        headers: { cookie: admin.cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.breaker).toEqual({ state: 'closed' });
      const ban = body.bans.find((b: { ipPrefix: string }) => b.ipPrefix === BANNED_IP);
      expect(ban).toMatchObject({ strikes: 2, active: true });
      // And the hydrated ban actually blocks.
      const blocked = await rebooted.inject({
        method: 'GET',
        url: '/s/whatever',
        remoteAddress: BANNED_IP,
      });
      expect(blocked.statusCode).toBe(429);
    } finally {
      await rebooted.close();
    }
  });

  it('unban deletes the row, clears memory, audits — and the IP works again', async () => {
    const rebooted = await buildApp({ config, db: handle.db, now: () => clock });
    try {
      const res = await rebooted.inject({
        method: 'POST',
        url: '/api/v1/admin/guard/unban',
        payload: { ipPrefix: BANNED_IP },
        headers: asAdmin(),
      });
      expect(res.statusCode).toBe(204);
      const rows = await handle.db.select().from(ipBans).where(eq(ipBans.ipPrefix, BANNED_IP));
      expect(rows).toHaveLength(0);
      const free = await rebooted.inject({
        method: 'GET',
        url: '/s/whatever',
        remoteAddress: BANNED_IP,
      });
      expect(free.statusCode).toBe(404); // back to the uniform miss, not 429
      expect(await latestAudit('guard.unban')).toBeDefined();
      expect((await latestAudit('guard.unban'))!.detail['ipPrefix']).toBe(BANNED_IP);

      // Unknown prefix: 404 and no audit row.
      const before = await auditCount();
      expect(
        (
          await rebooted.inject({
            method: 'POST',
            url: '/api/v1/admin/guard/unban',
            payload: { ipPrefix: '198.51.100.250' },
            headers: asAdmin(),
          })
        ).statusCode,
      ).toBe(404);
      expect(await auditCount()).toBe(before);
    } finally {
      await rebooted.close();
    }
  });
});

// ---- rule 3 sweep -----------------------------------------------------------

describe('audit rows never carry full secrets (CLAUDE.md rule 3)', () => {
  it('every token and view_id from this suite is absent from the audit table', async () => {
    expect(secretsSeen.length).toBeGreaterThanOrEqual(4);
    const rows = await handle.db.select().from(auditLog);
    const blob = JSON.stringify(rows);
    for (const secret of secretsSeen) {
      expect(blob).not.toContain(secret);
    }
    advance(0); // clock untouched; assertion suite only
  });
});
