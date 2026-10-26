import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb } from '../../src/db/client.js';
import { Guard } from '../../src/guard.js';
import { ROBOTS_CACHE_CONTROL, ROBOTS_TXT } from '../../src/robots.js';

/**
 * robots.txt (PLAN.md §6, E12 route audit): the design said it disallows /s/
 * from M0; nothing served one until E12. A fixed public file, no user data.
 */
const { db } = createDb('postgres://unused:unused@127.0.0.1:1/unused', { max: 1 });

async function withApp<T>(fn: (app: Awaited<ReturnType<typeof buildApp>>) => Promise<T>) {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://app:pw@localhost:5432/app',
    SESSION_SECRET: 'unit-test-session-secret-not-real-0123456789',
    WEB_DIST_DIR: '/nonexistent',
    RATE_GENERAL_PER_MIN: '100000',
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

describe('GET /robots.txt', () => {
  it('disallows the secret prefixes and the API, as plain text, publicly cacheable', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/robots.txt' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(res.headers['cache-control']).toBe(ROBOTS_CACHE_CONTROL);
      expect(res.body).toBe(ROBOTS_TXT);
      expect(res.body).toMatch(/^User-agent: \*$/m);
      expect(res.body).toMatch(/^Disallow: \/s\/$/m);
      expect(res.body).toMatch(/^Disallow: \/reset\/$/m);
      expect(res.body).toMatch(/^Disallow: \/api\/$/m);
      // Nothing that could point at a capture: no Sitemap line, no Allow list of pages.
      expect(res.body).not.toMatch(/sitemap|^allow:/im);
      // The app-wide header posture stays on; it is not the one indexable route.
      expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(String(res.headers['content-security-policy'])).toContain("default-src 'self'");
    });
  });

  it('is not a secret route: no jitter path, no guard budget — a plain fast 200', async () => {
    await withApp(async (app) => {
      const head = await app.inject({ method: 'HEAD', url: '/robots.txt' });
      expect(head.statusCode).toBe(200);
      const trailing = await app.inject({ method: 'GET', url: '/robots.txt/' });
      expect(trailing.statusCode).toBe(404); // Fastify's default, not the uniform 404 page
    });
  });
});
