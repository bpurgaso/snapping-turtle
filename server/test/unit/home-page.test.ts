import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb } from '../../src/db/client.js';
import { Guard } from '../../src/guard.js';

/**
 * The home page (E2), DB-free: server-rendered from what is published in
 * EXT_DIR and what CHROME_EXTENSION_URL says, at request time. Both install
 * cards render in every state; each is a working link or an honest "not
 * yet", never a dead button.
 */
const { db } = createDb('postgres://unused:unused@127.0.0.1:1/unused', { max: 1 });

const published = mkdtempSync(join(tmpdir(), 'st-ext-home-'));
const xpi = 'snapping-turtle-firefox-0.3.0.xpi';
writeFileSync(join(published, xpi), 'xpi');
writeFileSync(
  join(published, 'updates.json'),
  JSON.stringify({
    addons: {
      'snapping-turtle@shots.test': {
        updates: [
          {
            version: '0.3.0',
            update_link: `https://shots.test/ext/${xpi}`,
            update_hash: `sha256:${createHash('sha256').update('xpi').digest('hex')}`,
            applications: { gecko: { strict_min_version: '140.0' } },
          },
        ],
      },
    },
  }),
);
const unpublished = join(published, 'nothing-here');
const CHROME = 'https://chromewebstore.google.com/detail/abcdefghijklmnop';

async function withApp<T>(
  env: { EXT_DIR: string; CHROME_EXTENSION_URL?: string; WEB_DIST_DIR?: string },
  fn: (app: FastifyInstance) => Promise<T>,
): Promise<T> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://app:pw@localhost:5432/app',
    SESSION_SECRET: 'unit-test-session-secret-not-real-0123456789',
    PUBLIC_ORIGIN: 'https://shots.test:28443',
    PUBLIC_PORT: '28443',
    WEB_DIST_DIR: '/nonexistent',
    RATE_GENERAL_PER_MIN: '100000',
    ...env,
  });
  const app = await buildApp({
    config,
    db,
    guard: new Guard({ db, rate: config.rate, now: () => new Date() }),
  });
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

const home = (app: FastifyInstance) => app.inject({ method: 'GET', url: '/' });

describe('GET / (E2)', () => {
  it('renders with no web bundle at all, with the secret-page header posture', async () => {
    await withApp({ EXT_DIR: unpublished }, async (app) => {
      const res = await home(app);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
      expect(String(res.headers['content-security-policy'])).toContain("default-src 'self'");
      expect(res.body).toContain('<h1>snapping-turtle</h1>');
      expect(res.body).toContain('href="/login"');
      expect(res.body).not.toContain('<script');
      expect(res.body).not.toMatch(/\sstyle=|<style\b|\son[a-z]+=/i);
    });
  });

  it.each([
    ['nothing published, no Chrome URL', unpublished, undefined],
    ['Firefox published, no Chrome URL', published, undefined],
    ['nothing published, Chrome URL set', unpublished, CHROME],
    ['both available', published, CHROME],
  ])('always renders both cards: %s', async (_name, extDir, chromeUrl) => {
    await withApp(
      { EXT_DIR: extDir, ...(chromeUrl ? { CHROME_EXTENSION_URL: chromeUrl } : {}) },
      async (app) => {
        const body = (await home(app)).body;
        expect(body).toContain('data-browser="firefox"');
        expect(body).toContain('data-browser="chrome"');
        expect(body).toContain('Install the extension');
        if (extDir === published) {
          expect(body).toContain('href="/ext/firefox-latest"');
          expect(body).not.toContain('Not yet published');
        } else {
          expect(body).toContain('Not yet published');
          expect(body).not.toContain('firefox-latest');
        }
        if (chromeUrl) {
          expect(body).toContain(`href="${chromeUrl}"`);
          expect(body).not.toContain('Coming soon');
        } else {
          expect(body).toContain('Coming soon');
          expect(body).not.toContain('chromewebstore');
        }
      },
    );
  });

  it('the Firefox button it renders is the redirect that actually serves the .xpi', async () => {
    await withApp({ EXT_DIR: published }, async (app) => {
      const body = (await home(app)).body;
      const href = /<a class="button" href="([^"]+)">Install for Firefox<\/a>/.exec(body)?.[1];
      expect(href).toBe('/ext/firefox-latest');
      const hop = await app.inject({ method: 'GET', url: href! });
      expect(hop.statusCode).toBe(302);
      expect(hop.headers['location']).toBe(`/ext/${xpi}`);
      const file = await app.inject({ method: 'GET', url: String(hop.headers['location']) });
      expect(file.statusCode).toBe(200);
      expect(file.headers['content-type']).toBe('application/x-xpinstall');
    });
  });

  it('never renders a Firefox button whose redirect would 404', async () => {
    await withApp({ EXT_DIR: unpublished }, async (app) => {
      expect((await home(app)).body).not.toContain('Install for Firefox');
      expect((await app.inject({ method: 'GET', url: '/ext/firefox-latest' })).statusCode).toBe(
        404,
      );
    });
  });

  it('serves the static pages from the bundle when built, 503 when not', async () => {
    const webDist = mkdtempSync(join(tmpdir(), 'st-web-home-'));
    writeFileSync(join(webDist, 'login.html'), '<!doctype html><title>login</title>');
    await withApp({ EXT_DIR: unpublished, WEB_DIST_DIR: webDist }, async (app) => {
      expect((await app.inject({ method: 'GET', url: '/login' })).body).toContain('login');
      expect((await home(app)).statusCode).toBe(200);
    });
    await withApp({ EXT_DIR: unpublished }, async (app) => {
      expect((await app.inject({ method: 'GET', url: '/login' })).statusCode).toBe(503);
      expect((await home(app)).statusCode).toBe(200);
    });
  });
});
