import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb } from '../../src/db/client.js';
import type { FastifyInstance } from 'fastify';

// A stand-in web bundle so the app exercises its real serving path.
const webDist = mkdtempSync(join(tmpdir(), 'st-web-'));
mkdirSync(join(webDist, 'assets'));
writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>t</title><div id="app"></div>');
writeFileSync(join(webDist, 'assets', 'index-abc123.js'), 'console.log(1)\n');

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://app:pw@localhost:5432/app',
  SESSION_SECRET: 'unit-test-session-secret-not-real-0123456789',
  WEB_DIST_DIR: webDist,
});
// postgres.js connects lazily; none of the routes exercised here touch the database.
const { db } = createDb('postgres://unused:unused@127.0.0.1:1/unused', { max: 1 });

let app: FastifyInstance;
let dbUp = true;
beforeAll(async () => {
  app = await buildApp({
    config,
    db,
    checks: {
      database: async () => {
        if (!dbUp) throw new Error('connection refused');
      },
    },
  });
});
afterAll(() => app.close());

function expectSecurityHeaders(headers: Record<string, unknown>) {
  const csp = String(headers['content-security-policy']);
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).not.toContain('unsafe-inline');
  expect(csp).not.toContain('unsafe-eval');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['x-robots-tag']).toBe('noindex, nofollow');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['strict-transport-security']).toMatch(/max-age=31536000/);
}

describe('security headers (CLAUDE.md rules 6 & 10)', () => {
  it('are present on /healthz with no-store caching', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expectSecurityHeaders(res.headers);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('are present on the page at /', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expectSecurityHeaders(res.headers);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('are present on 404 responses too', async () => {
    const res = await app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expectSecurityHeaders(res.headers);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('keep hashed assets immutable-cacheable without dropping the other headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(res.statusCode).toBe(200);
    expectSecurityHeaders(res.headers);
    expect(res.headers['cache-control']).toMatch(/immutable/);
  });

  it('does not list or traverse the assets directory', async () => {
    const dir = await app.inject({ method: 'GET', url: '/assets/' });
    expect([403, 404]).toContain(dir.statusCode);
    expect(dir.body).not.toContain('index-abc123.js');
    expect((await app.inject({ method: 'GET', url: '/assets/../index.html' })).statusCode).toBe(
      404,
    );
    expect((await app.inject({ method: 'GET', url: '/assets/%2e%2e/index.html' })).statusCode).toBe(
      404,
    );
  });
});

describe('GET /healthz', () => {
  it('reports ok with per-check detail', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.json()).toEqual({ status: 'ok', checks: { database: true } });
  });

  it('returns 503 degraded when a dependency probe fails', async () => {
    dbUp = false;
    try {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ status: 'degraded', checks: { database: false } });
    } finally {
      dbUp = true;
    }
  });
});
