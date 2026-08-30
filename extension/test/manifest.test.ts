import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildManifest, type ManifestTemplate } from '../src/manifest.js';

const template = JSON.parse(
  readFileSync(new URL('../manifest.template.json', import.meta.url), 'utf8'),
) as ManifestTemplate;
const opts = { template, version: '0.1.0', publicOrigin: 'https://shots.example.com' };

describe('buildManifest', () => {
  it('chrome: MV3 with a module service worker', () => {
    const m = buildManifest('chrome', opts);
    expect(m.manifest_version).toBe(3);
    expect(m.background).toEqual({ service_worker: 'background.js' });
    expect(m.browser_specific_settings).toBeUndefined();
    expect(m.minimum_chrome_version).toBeDefined();
  });

  it('firefox: MV3 with an event page and a gecko id derived from the server host', () => {
    const m = buildManifest('firefox', opts);
    expect(m.background).toEqual({ scripts: ['background.js'] });
    expect(m.browser_specific_settings?.gecko.id).toBe('snapping-turtle@shots.example.com');
    expect(
      buildManifest('firefox', { ...opts, geckoId: 'custom@example.org' }).browser_specific_settings
        ?.gecko.id,
    ).toBe('custom@example.org');
  });

  it('both targets share everything except the background entry and gecko block', () => {
    const { background: _c, minimum_chrome_version: _v, ...chrome } = buildManifest('chrome', opts);
    const {
      background: _f,
      browser_specific_settings: _g,
      ...firefox
    } = buildManifest('firefox', opts);
    expect(chrome).toEqual(firefox);
  });

  it('requests only the minimal permission set from PLAN.md §15', () => {
    const m = buildManifest('chrome', opts);
    expect(m.permissions.sort()).toEqual(['activeTab', 'scripting', 'storage']);
    expect(m.host_permissions).toEqual(['https://shots.example.com/*']);
    expect(m.optional_host_permissions).toEqual(['https://*/*']);
    expect(m.permissions).not.toContain('debugger');
    expect(m.permissions).not.toContain('tabs');
    expect(m.host_permissions).not.toContain('<all_urls>');
  });

  it('does not mutate the template between builds', () => {
    const before = JSON.stringify(template);
    buildManifest('chrome', opts);
    buildManifest('firefox', opts);
    expect(JSON.stringify(template)).toBe(before);
  });

  it('rejects bad versions and non-origin server values', () => {
    expect(() => buildManifest('chrome', { ...opts, version: '1.0.0-beta' })).toThrow(/version/);
    expect(() => buildManifest('chrome', { ...opts, publicOrigin: 'shots.example.com' })).toThrow(
      /valid URL/,
    );
    expect(() =>
      buildManifest('chrome', { ...opts, publicOrigin: 'https://shots.example.com/app' }),
    ).toThrow(/bare/);
    expect(() =>
      buildManifest('chrome', { ...opts, publicOrigin: 'http://shots.example.com' }),
    ).toThrow(/https/);
    expect(
      buildManifest('chrome', { ...opts, publicOrigin: 'http://localhost:3000' }).host_permissions,
    ).toEqual(['http://localhost:3000/*']);
  });
});
