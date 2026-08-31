import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
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
const PAGES = ['index.html', 'login.html', 'signup.html', 'account.html'];
let outDir: string;
const html: Record<string, string> = {};

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'st-csp-'));
  await build({
    root: webRoot,
    configFile: join(webRoot, 'vite.config.ts'),
    logLevel: 'silent',
    build: { outDir, emptyOutDir: true },
  });
  for (const page of PAGES) html[page] = readFileSync(join(outDir, page), 'utf8');
});

describe.each(PAGES)('built %s is CSP-clean', (page) => {
  it('has no inline scripts', () => {
    const scripts = [...html[page]!.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attrs, body] of scripts) {
      expect(attrs).toMatch(/\bsrc=/);
      expect(body?.trim()).toBe('');
    }
  });

  it('has no inline styles or inline event handlers', () => {
    expect(html[page]).not.toMatch(/<style\b/i);
    expect(html[page]).not.toMatch(/\sstyle=/i);
    expect(html[page]).not.toMatch(/\son[a-z]+=/i);
    expect(html[page]).not.toMatch(/javascript:/i);
  });

  it('references only same-origin assets and links a stylesheet', () => {
    const urls = [...html[page]!.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1] as string);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url.startsWith('/')).toBe(true);
    expect(html[page]).toMatch(/<link rel="stylesheet"[^>]+href="\/assets\/[\w-]+\.css"/);
  });
});

describe('build layout the server relies on', () => {
  it('emits hashed assets', () => {
    const assets = readdirSync(join(outDir, 'assets'));
    expect(assets.some((f) => /^index-[\w-]+\.js$/.test(f))).toBe(true);
    expect(assets.some((f) => /\.css$/.test(f))).toBe(true);
  });

  it('writes a manifest with the capture-page entry (script + stylesheet)', () => {
    const manifestPath = join(outDir, '.vite', 'manifest.json');
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<
      string,
      { file: string; css?: string[] }
    >;
    const capture = manifest['src/capture.ts'];
    expect(capture?.file).toMatch(/^assets\/capture-[\w-]+\.js$/);
    expect(capture?.css?.[0]).toMatch(/^assets\/capture-[\w-]+\.css$/);
    expect(existsSync(join(outDir, capture!.file))).toBe(true);
  });
});
