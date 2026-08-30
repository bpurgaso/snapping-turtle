import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The server sends `default-src 'self'` with no 'unsafe-inline'. Any inline
 * script, inline style, or event-handler attribute in the built HTML would be
 * silently blocked by browsers, so this test fails the build first.
 */
const webRoot = fileURLToPath(new URL('..', import.meta.url));
let outDir: string;
let html: string;

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'st-csp-'));
  await build({
    root: webRoot,
    configFile: join(webRoot, 'vite.config.ts'),
    logLevel: 'silent',
    build: { outDir, emptyOutDir: true },
  });
  html = readFileSync(join(outDir, 'index.html'), 'utf8');
});

describe('built index.html is CSP-clean', () => {
  it('has no inline scripts', () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attrs, body] of scripts) {
      expect(attrs).toMatch(/\bsrc=/);
      expect(body?.trim()).toBe('');
    }
  });

  it('has no inline styles or inline event handlers', () => {
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/javascript:/i);
  });

  it('references only same-origin assets', () => {
    const urls = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1] as string);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url.startsWith('/')).toBe(true);
  });

  it('emits hashed assets and a stylesheet link (not injected styles)', () => {
    const assets = readdirSync(join(outDir, 'assets'));
    expect(assets.some((f) => /^index-[\w-]+\.js$/.test(f))).toBe(true);
    expect(assets.some((f) => /^index-[\w-]+\.css$/.test(f))).toBe(true);
    expect(html).toMatch(/<link rel="stylesheet"[^>]+href="\/assets\/index-[\w-]+\.css"/);
  });
});
