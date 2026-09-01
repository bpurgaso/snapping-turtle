import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb } from '../../src/db/client.js';
import { Guard } from '../../src/guard.js';

/**
 * /ext/ — the self-distributed Firefox build (PLAN.md §15, M8): public,
 * secret-free, exactly two file shapes, everything else in the directory
 * unreachable.
 */
const webDist = mkdtempSync(join(tmpdir(), 'st-web-'));
mkdirSync(join(webDist, 'assets'));
writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>t</title>');

const xpiName = 'snapping-turtle-firefox-0.1.0.xpi';
const xpiBytes = Buffer.from('PK not really a zip, but the bytes are what matters');
const sha256 = createHash('sha256').update(xpiBytes).digest('hex');
const updates = {
  addons: {
    'snapping-turtle@shots.test': {
      updates: [
        {
          version: '0.1.0',
          update_link: `https://shots.test/ext/${xpiName}`,
          update_hash: `sha256:${sha256}`,
          applications: { gecko: { strict_min_version: '140.0' } },
        },
      ],
    },
  },
};

const extDir = mkdtempSync(join(tmpdir(), 'st-ext-'));
writeFileSync(join(extDir, 'updates.json'), JSON.stringify(updates));
writeFileSync(join(extDir, xpiName), xpiBytes);
// Decoys: an operator could drop anything in here by mistake; none of it may be served.
writeFileSync(join(extDir, '.env'), 'SESSION_SECRET=never-served');
writeFileSync(join(extDir, 'notes.txt'), 'private-notes');
writeFileSync(join(extDir, 'other-addon-1.0.xpi'), 'x');
writeFileSync(join(extDir, 'snapping-turtle-firefox-evil.xpi'), 'x');
mkdirSync(join(extDir, 'sub'));
writeFileSync(join(extDir, 'sub', 'updates.json'), '{}');

const { db } = createDb('postgres://unused:unused@127.0.0.1:1/unused', { max: 1 });

function appFor(extDirValue: string): Promise<FastifyInstance> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://app:pw@localhost:5432/app',
    SESSION_SECRET: 'unit-test-session-secret-not-real-0123456789',
    PUBLIC_ORIGIN: 'https://shots.test',
    WEB_DIST_DIR: webDist,
    EXT_DIR: extDirValue,
    RATE_GENERAL_PER_MIN: '100000',
  });
  return buildApp({
    config,
    db,
    guard: new Guard({ db, rate: config.rate, now: () => new Date() }),
  });
}

let app: FastifyInstance;
let bare: FastifyInstance;
beforeAll(async () => {
  app = await appFor(extDir);
  bare = await appFor(join(extDir, 'does-not-exist'));
});
afterAll(async () => {
  await app.close();
  await bare.close();
});

describe('/ext/ self-distribution route', () => {
  it('serves updates.json that parses and points at an .xpi this route also serves', async () => {
    const res = await app.inject({ method: 'GET', url: '/ext/updates.json' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    const body = JSON.parse(res.body) as typeof updates;
    const entry = body.addons['snapping-turtle@shots.test']!.updates[0]!;
    const link = new URL(entry.update_link);
    expect(link.origin).toBe('https://shots.test');

    const xpi = await app.inject({ method: 'GET', url: link.pathname });
    expect(xpi.statusCode).toBe(200);
    expect(xpi.headers['content-type']).toBe('application/x-xpinstall');
    expect(xpi.headers['cache-control']).toBe('public, max-age=300');
    expect(xpi.rawPayload.equals(xpiBytes)).toBe(true);
    expect(entry.update_hash).toBe(
      `sha256:${createHash('sha256').update(xpi.rawPayload).digest('hex')}`,
    );
  });

  it('keeps the security headers on and never sets cookies', async () => {
    const res = await app.inject({ method: 'GET', url: `/ext/${xpiName}` });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(String(res.headers['content-security-policy'])).toContain("default-src 'self'");
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('serves nothing else in the directory: decoys, subdirectories, listing, traversal', async () => {
    for (const url of [
      '/ext/.env',
      '/ext/notes.txt',
      '/ext/other-addon-1.0.xpi',
      '/ext/snapping-turtle-firefox-evil.xpi',
      '/ext/sub/updates.json',
      '/ext/',
      '/ext',
      '/ext/../package.json',
      '/ext/%2e%2e/package.json',
      '/ext/updates.json/',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.body, url).not.toContain('never-served');
      expect(res.body, url).not.toContain('private-notes');
    }
    const missing = await app.inject({
      method: 'GET',
      url: '/ext/snapping-turtle-firefox-9.9.9.xpi',
    });
    expect(missing.statusCode).toBe(404);
  });

  it('is read-only', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'] as const) {
      const res = await app.inject({ method, url: '/ext/updates.json' });
      expect([404, 405]).toContain(res.statusCode);
    }
  });

  it('with no EXT_DIR present, /ext/* is a plain 404 and the app still boots', async () => {
    const res = await bare.inject({ method: 'GET', url: '/ext/updates.json' });
    expect(res.statusCode).toBe(404);
    expect((await bare.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });
});
