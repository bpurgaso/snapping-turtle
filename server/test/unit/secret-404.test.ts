import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb } from '../../src/db/client.js';
import { NOT_FOUND_HTML } from '../../src/html.js';

/**
 * Uniform 404 without a database: malformed ids and unknown sub-paths never
 * query, so this runs in the unit suite. The integration suite adds
 * never-existed / expired / deleted well-formed ids.
 */
const { db } = createDb('postgres://unused:unused@127.0.0.1:1/unused', { max: 1 });

async function appWithJitter(min: number, max: number) {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://app:pw@localhost:5432/app',
    SESSION_SECRET: 'unit-test-session-secret-not-real-0123456789',
    WEB_DIST_DIR: '/nonexistent',
    RATE_NOT_FOUND_JITTER_MIN_MS: String(min),
    RATE_NOT_FOUND_JITTER_MAX_MS: String(max),
  });
  return buildApp({ config, db });
}

function comparable(headers: Record<string, unknown>) {
  const { date: _date, ...rest } = headers;
  return rest;
}

describe('uniform not-found on /s/* (CLAUDE.md rule 2)', () => {
  it('returns byte-identical bodies and identical headers for different misses', async () => {
    const app = await appWithJitter(0, 2);
    try {
      const urls = [
        '/s/not-a-valid-id',
        '/s/AbCdEfGhIjKlMnOpQrStUvWxYz1234', // right alphabet, wrong length
        '/s/short/image.png',
        '/s/x/y/z',
        '/s/',
        '/s',
      ];
      const responses = await Promise.all(urls.map((url) => app.inject({ method: 'GET', url })));
      const [first, ...rest] = responses;
      expect(first!.statusCode).toBe(404);
      expect(first!.body).toBe(NOT_FOUND_HTML);
      expect(first!.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(first!.headers['cache-control']).toBe('private, no-store');
      expect(first!.headers['referrer-policy']).toBe('no-referrer');
      expect(first!.headers['x-robots-tag']).toBe('noindex, nofollow');
      for (const res of rest) {
        expect(res.statusCode).toBe(404);
        expect(res.rawPayload.equals(first!.rawPayload)).toBe(true);
        expect(comparable(res.headers)).toEqual(comparable(first!.headers));
      }
    } finally {
      await app.close();
    }
  });

  it('applies latency jitter within the configured range', async () => {
    const app = await appWithJitter(40, 60);
    try {
      const started = process.hrtime.bigint();
      const res = await app.inject({ method: 'GET', url: '/s/nope' });
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      expect(res.statusCode).toBe(404);
      expect(elapsedMs).toBeGreaterThanOrEqual(38);
    } finally {
      await app.close();
    }
  });

  it('also answers HEAD and POST under /s/ with the same 404 status', async () => {
    const app = await appWithJitter(0, 0);
    try {
      const head = await app.inject({ method: 'HEAD', url: '/s/nope' });
      expect(head.statusCode).toBe(404);
      const post = await app.inject({ method: 'POST', url: '/s/nope', payload: {} });
      expect(post.statusCode).toBe(404);
      expect(post.body).toBe(NOT_FOUND_HTML);
    } finally {
      await app.close();
    }
  });
});
