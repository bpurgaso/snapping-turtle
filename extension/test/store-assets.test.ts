import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

/**
 * The committed store-listing screenshots (E8) are what `listing-shots`
 * generates and what STORE_SUBMISSION.md tells the owner to upload: at least
 * two, each exactly 1280×800, 24-bit RGB without alpha (the Chrome Web
 * Store's PNG rule), named in the kit. A hand-made replacement of the wrong
 * shape fails here before it fails in the console.
 */
const extensionRoot = fileURLToPath(new URL('..', import.meta.url));
const assetsDir = join(extensionRoot, 'store-assets');
const kit = readFileSync(join(extensionRoot, 'STORE_SUBMISSION.md'), 'utf8');
const readme = readFileSync(join(assetsDir, 'README.md'), 'utf8');
const shots = readdirSync(assetsDir)
  .filter((f) => f.endsWith('.png'))
  .sort();

describe('extension/store-assets (E8)', () => {
  it('holds at least two screenshots', () => {
    expect(shots.length).toBeGreaterThanOrEqual(2);
  });

  it.each(shots)('%s is exactly 1280×800, 24-bit RGB, no alpha', (name) => {
    const png = PNG.sync.read(readFileSync(join(assetsDir, name)));
    expect({ width: png.width, height: png.height }).toEqual({ width: 1280, height: 800 });
    // IHDR byte 25 is the colour type: 2 = truecolour without alpha.
    expect(readFileSync(join(assetsDir, name))[25]).toBe(2);
  });

  it.each(shots)('%s is named by the kit and the assets README', (name) => {
    expect(kit).toContain(name);
    expect(readme).toContain(name);
  });

  it('the kit points at the directory and the command that regenerates it', () => {
    expect(kit).toContain('store-assets/');
    expect(kit).toContain('pnpm --filter extension listing-shots');
    expect(readFileSync(join(extensionRoot, 'package.json'), 'utf8')).toContain('"listing-shots":');
  });

  it('the fixture page carries only placeholder addresses', () => {
    const fixture = readFileSync(join(assetsDir, 'fixture/demo-page.html'), 'utf8');
    for (const url of fixture.match(/https?:\/\/[^\s"'<)]+/g) ?? []) {
      expect(new URL(url).hostname).toMatch(/(^|\.)example\.(com|org|net)$/);
    }
  });
});
