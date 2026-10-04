import { PRIVACY_PATH } from '@snapping-turtle/shared';
import type { FastifyInstance } from 'fastify';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb } from '../../src/db/client.js';
import { Guard } from '../../src/guard.js';
import { renderMarkdown } from '../../src/markdown.js';
import { PRIVACY_CACHE_CONTROL, PRIVACY_CONTENT_FILE } from '../../src/privacy.js';

/**
 * GET /privacy (E8), DB-free. Three things are held in step: the canonical
 * file web/content/privacy.md is what the route renders; the page is public
 * (indexable, cacheable) while the secret routes keep their posture; and
 * extension/STORE_SUBMISSION.md points at this URL and this file instead of
 * carrying a second copy of the text.
 */
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const canonicalPath = 'web/content/privacy.md';
const canonical = readFileSync(join(repoRoot, canonicalPath), 'utf8');
const kit = readFileSync(join(repoRoot, 'extension/STORE_SUBMISSION.md'), 'utf8');

// A stand-in web/dist holding exactly what the web build copies from content/.
const webDist = mkdtempSync(join(tmpdir(), 'st-web-privacy-'));
mkdirSync(join(webDist, '.vite'));
copyFileSync(join(repoRoot, canonicalPath), join(webDist, PRIVACY_CONTENT_FILE));
writeFileSync(
  join(webDist, '.vite', 'manifest.json'),
  JSON.stringify({
    'src/privacy.ts': { file: 'assets/privacy-h4sh.js', css: ['assets/privacy-h4sh.css'] },
  }),
);

const { db } = createDb('postgres://unused:unused@127.0.0.1:1/unused', { max: 1 });

async function appWith(env: Record<string, string>): Promise<FastifyInstance> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://app:pw@localhost:5432/app',
    SESSION_SECRET: 'unit-test-session-secret-not-real-0123456789',
    PUBLIC_ORIGIN: 'https://shots.test:28443',
    PUBLIC_PORT: '28443',
    RATE_GENERAL_PER_MIN: '100000',
    RATE_INVALID_LOOKUP_BUDGET: '1000',
    RATE_NOT_FOUND_JITTER_MIN_MS: '0',
    RATE_NOT_FOUND_JITTER_MAX_MS: '0',
    ...env,
  });
  return buildApp({
    config,
    db,
    guard: new Guard({ db, rate: config.rate, now: () => new Date() }),
  });
}

let app: FastifyInstance;
beforeAll(async () => {
  app = await appWith({ WEB_DIST_DIR: webDist });
});
afterAll(() => app.close());

describe(`GET ${PRIVACY_PATH} (E8)`, () => {
  it('serves the canonical policy, rendered, in the shared page chrome', async () => {
    const res = await app.inject({ method: 'GET', url: PRIVACY_PATH });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain(renderMarkdown(canonical));
    expect(res.body).toContain('<title>Privacy policy · snapping-turtle</title>');
    expect(res.body).toContain('<link rel="stylesheet" href="/assets/privacy-h4sh.css" />');
    // No behaviour, so no script; and nothing inline (CSP rule 6).
    expect(res.body).not.toContain('<script');
    expect(res.body).not.toMatch(/\sstyle=|<style\b|\son[a-z]+=/i);
  });

  it('is an ordinary public page: indexable and publicly cacheable, CSP and the rest intact', async () => {
    const res = await app.inject({ method: 'GET', url: PRIVACY_PATH });
    expect(res.headers['x-robots-tag']).toBeUndefined();
    expect(res.body).not.toContain('noindex');
    expect(res.headers['cache-control']).toBe(PRIVACY_CACHE_CONTROL);
    expect(res.headers['cache-control']).not.toContain('no-store');
    // App-wide headers (rules 6 & 10) are not loosened for it.
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['strict-transport-security']).toMatch(/max-age=31536000/);
  });

  it('the opt-out does not bleed: secret routes, the home page and 404s keep noindex + no-store', async () => {
    for (const url of [
      '/s/AAAAAAAAAAAAAAAAAAAAAAAAAAA',
      '/s/nope',
      '/reset/nope',
      '/',
      '/no-such-page',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.headers['x-robots-tag'], url).toBe('noindex, nofollow');
      expect(res.headers['cache-control'], url).toBe('private, no-store');
    }
  });

  it('the home page footer links it (E2 page, E8 link)', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.body).toContain(
      `<footer class="foot"><a href="${PRIVACY_PATH}">Privacy policy</a></footer>`,
    );
  });

  it('answers 503 like the other pages when the web bundle is not built', async () => {
    const unbuilt = await appWith({ WEB_DIST_DIR: '/nonexistent' });
    try {
      const res = await unbuilt.inject({ method: 'GET', url: PRIVACY_PATH });
      expect(res.statusCode).toBe(503);
      expect(res.headers['cache-control']).toBe('private, no-store');
    } finally {
      await unbuilt.close();
    }
  });
});

describe('extension/STORE_SUBMISSION.md stays in step with the live page (doc rot)', () => {
  it('names the URL the server serves, with the deployment origin in front', () => {
    const urls = [...kit.matchAll(/https:\/\/\$PUBLIC_HOST:\$PUBLIC_PORT(\/[a-z-]*)/g)].map(
      (m) => m[1],
    );
    expect(urls).toContain(PRIVACY_PATH);
  });

  it('references the canonical file, which exists', () => {
    expect(kit).toContain(canonicalPath);
    expect(existsSync(join(repoRoot, canonicalPath))).toBe(true);
  });

  it('does not carry a second copy of the policy text', () => {
    const paragraphs = canonical
      .split(/\n\s*\n/)
      .map((p) =>
        p
          .replace(/^[#>-]+\s*/, '')
          .replace(/\s+/g, ' ')
          .trim(),
      )
      .filter((p) => p.length >= 40);
    expect(paragraphs.length).toBeGreaterThanOrEqual(4);
    const flatKit = kit.replace(/\s+/g, ' ');
    for (const p of paragraphs) expect(flatKit, p.slice(0, 60)).not.toContain(p.slice(0, 60));
  });
});
