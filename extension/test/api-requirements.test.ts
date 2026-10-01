import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_API_REQUIREMENTS,
  declaresAllUrls,
  NATIVE_FULL_PAGE_PERMISSION,
  permissionSetDrift,
  PINNED_OPTIONAL_HOST_PERMISSIONS,
  PINNED_PERMISSIONS,
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

describe('the pinned permission set (PLAN.md §15; unchanged by E7)', () => {
  it('is exactly what 0.1.1 shipped with, in order', () => {
    expect(PINNED_PERMISSIONS).toEqual(['activeTab', 'scripting', 'storage', 'notifications']);
    expect(PINNED_OPTIONAL_HOST_PERMISSIONS).toEqual(['https://*/*']);
  });

  it('both generated manifests match it byte for byte', () => {
    expect(
      permissionSetDrift(buildManifest('chrome', opts), 'https://shots.example.com/*'),
    ).toEqual([]);
    expect(
      permissionSetDrift(buildManifest('firefox', opts), 'https://shots.example.com/*'),
    ).toEqual([]);
    // With a port: Chrome keeps it in the pattern, Firefox drops it.
    const ported = { ...opts, publicOrigin: 'https://shots.example.com:28443' };
    expect(
      permissionSetDrift(buildManifest('chrome', ported), 'https://shots.example.com:28443/*'),
    ).toEqual([]);
    expect(
      permissionSetDrift(buildManifest('firefox', ported), 'https://shots.example.com/*'),
    ).toEqual([]);
  });

  it('names an added, dropped or reordered permission', () => {
    const base = buildManifest('chrome', opts);
    const host = 'https://shots.example.com/*';
    expect(
      permissionSetDrift({ ...base, permissions: [...base.permissions, 'tabs'] }, host),
    ).toEqual([
      'permissions is ["activeTab","scripting","storage","notifications","tabs"], the pinned set is ["activeTab","scripting","storage","notifications"]',
    ]);
    expect(
      permissionSetDrift({ ...base, permissions: ['activeTab', 'scripting', 'storage'] }, host),
    ).toHaveLength(1);
    expect(
      permissionSetDrift(
        { ...base, permissions: ['scripting', 'activeTab', 'storage', 'notifications'] },
        host,
      ),
    ).toHaveLength(1);
    const { permissions: _dropped, ...withoutPermissions } = base;
    expect(permissionSetDrift(withoutPermissions, host)).toEqual([
      'permissions is null, the pinned set is ["activeTab","scripting","storage","notifications"]',
    ]);
  });

  it('names a widened or extra host grant', () => {
    const base = buildManifest('chrome', opts);
    const host = 'https://shots.example.com/*';
    expect(permissionSetDrift({ ...base, host_permissions: [host, 'https://*/*'] }, host)).toEqual([
      expect.stringMatching(/^host_permissions is /),
    ]);
    expect(permissionSetDrift({ ...base, host_permissions: ['<all_urls>'] }, host)).toEqual([
      expect.stringMatching(/^host_permissions is \["<all_urls>"\]/),
    ]);
    expect(permissionSetDrift({ ...base, optional_host_permissions: ['*://*/*'] }, host)).toEqual([
      expect.stringMatching(/^optional_host_permissions is /),
    ]);
    const { optional_host_permissions: _gone, ...withoutOptional } = base;
    expect(permissionSetDrift(withoutOptional, host)).toEqual([
      expect.stringMatching(/^optional_host_permissions is null/),
    ]);
  });

  it('refuses access by another name: optional_permissions and declared content scripts', () => {
    const base = buildManifest('firefox', opts);
    const host = 'https://shots.example.com/*';
    expect(permissionSetDrift({ ...base, optional_permissions: ['tabs'] }, host)).toEqual([
      'optional_permissions must not be declared',
    ]);
    expect(
      permissionSetDrift(
        { ...base, content_scripts: [{ matches: ['<all_urls>'], js: ['content.js'] }] },
        host,
      ),
    ).toEqual(['content_scripts must not be declared']);
  });
});
