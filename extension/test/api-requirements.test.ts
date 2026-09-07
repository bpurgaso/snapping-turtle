import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_API_REQUIREMENTS,
  declaresAllUrls,
  NATIVE_FULL_PAGE_PERMISSION,
  unavailableGatedApis,
  unmetRequirements,
} from '../src/lib/api-requirements.js';
import { buildManifest, type ManifestTemplate } from '../src/manifest.js';

const template = JSON.parse(
  readFileSync(new URL('../manifest.template.json', import.meta.url), 'utf8'),
) as ManifestTemplate;
const opts = { template, version: '0.1.1', publicOrigin: 'https://shots.example.com' };

describe('the background ↔ manifest permission contract', () => {
  it('every ungated API the background calls is backed by both generated manifests', () => {
    for (const target of ['chrome', 'firefox'] as const) {
      expect(unmetRequirements(buildManifest(target, opts))).toEqual([]);
    }
  });

  it('native full-page capture is the one gated API, and the shipped manifest leaves it unavailable', () => {
    const gated = BACKGROUND_API_REQUIREMENTS.filter((r) => r.gated);
    expect(gated.map((r) => r.api)).toEqual(['tabs.captureTab']);
    expect(gated[0]!.anyOf).toEqual([NATIVE_FULL_PAGE_PERMISSION]);
    // Firefox hides captureTab without <all_urls>; the code stitches instead
    // (chooseFullPageStrategy). This is the drift guard: should the manifest
    // ever grant it, this test and the audit's <all_urls> rule both speak up.
    const firefox = buildManifest('firefox', opts);
    expect(unavailableGatedApis(firefox)).toEqual([
      'tabs.captureTab (needs <all_urls>; chooseFullPageStrategy in lib/full-page-strategy.ts (stitches when absent))',
    ]);
    expect(declaresAllUrls(firefox)).toBe(false);
    expect(declaresAllUrls(buildManifest('chrome', opts))).toBe(false);
  });

  it('names each missing permission when a manifest cannot back a call', () => {
    expect(unmetRequirements({ permissions: ['activeTab', 'storage', 'notifications'] })).toEqual([
      'scripting.executeScript needs one of scripting in the manifest',
    ]);
    expect(unmetRequirements({ permissions: ['scripting', 'storage', 'notifications'] })).toEqual([
      'tabs.captureVisibleTab needs one of activeTab, <all_urls> in the manifest',
    ]);
    expect(unmetRequirements({})).toHaveLength(4);
  });

  it('counts a host permission as satisfying an origin-gated API, in either manifest key', () => {
    const base = ['scripting', 'storage', 'notifications'];
    expect(unmetRequirements({ permissions: base, host_permissions: ['<all_urls>'] })).toEqual([]);
    expect(unmetRequirements({ permissions: [...base, '<all_urls>'] })).toEqual([]);
    expect(unavailableGatedApis({ permissions: base, host_permissions: ['<all_urls>'] })).toEqual(
      [],
    );
    expect(declaresAllUrls({ host_permissions: ['<all_urls>'] })).toBe(true);
    expect(declaresAllUrls({ permissions: ['<all_urls>'] })).toBe(true);
    // A broad https grant is not <all_urls>: Firefox still hides captureTab (measured on 154).
    expect(declaresAllUrls({ host_permissions: ['https://*/*'] })).toBe(false);
    expect(
      unavailableGatedApis({ permissions: base, host_permissions: ['https://*/*'] }),
    ).toHaveLength(1);
  });
});
