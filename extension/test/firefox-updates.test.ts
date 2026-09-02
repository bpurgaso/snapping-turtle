import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  parseUpdatesManifest,
  updateLinkFor,
  upsertUpdate,
} from '../scripts/lib/firefox-updates.js';

const sha = 'a'.repeat(64);
const release = {
  id: 'snapping-turtle@shots.real.net',
  version: '0.1.0',
  publicOrigin: 'https://shots.real.net',
  sha256Hex: sha,
  strictMinVersion: '140.0',
};

describe('firefox updates.json', () => {
  it('links the xpi under the public /ext/ route with its sha256', () => {
    const m = upsertUpdate(undefined, release);
    expect(m).toEqual({
      addons: {
        [release.id]: {
          updates: [
            {
              version: '0.1.0',
              update_link: 'https://shots.real.net/ext/snapping-turtle-firefox-0.1.0.xpi',
              update_hash: `sha256:${sha}`,
              applications: { gecko: { strict_min_version: '140.0' } },
            },
          ],
        },
      },
    });
    expect(updateLinkFor('https://h', '2.0')).toBe('https://h/ext/snapping-turtle-firefox-2.0.xpi');
  });

  it('a ported PUBLIC_ORIGIN flows into update_link unchanged (PUBLIC_PORT, §14)', () => {
    const ported = upsertUpdate(undefined, { ...release, publicOrigin: 'https://shots.real.net:28443' });
    expect(ported.addons[release.id]!.updates[0]!.update_link).toBe(
      'https://shots.real.net:28443/ext/snapping-turtle-firefox-0.1.0.xpi',
    );
    expect(updateLinkFor('https://shots.real.net:28443', '0.2.0')).toBe(
      'https://shots.real.net:28443/ext/snapping-turtle-firefox-0.2.0.xpi',
    );
    expect(() => parseUpdatesManifest(JSON.stringify(ported))).not.toThrow();
  });

  it('keeps earlier versions, replaces a re-signed same version, sorts ascending', () => {
    let m = upsertUpdate(undefined, { ...release, version: '0.2.0' });
    m = upsertUpdate(m, { ...release, version: '0.1.0' });
    m = upsertUpdate(m, { ...release, version: '0.10.0' });
    m = upsertUpdate(m, { ...release, version: '0.2.0', sha256Hex: 'b'.repeat(64) });
    const updates = m.addons[release.id]!.updates;
    expect(updates.map((u) => u.version)).toEqual(['0.1.0', '0.2.0', '0.10.0']);
    expect(updates[1]!.update_hash).toBe(`sha256:${'b'.repeat(64)}`);
    // Other add-on ids in the same file are untouched.
    const other = upsertUpdate(m, { ...release, id: 'other@x' });
    expect(Object.keys(other.addons).sort()).toEqual(['other@x', release.id].sort());
  });

  it('refuses a non-https origin or a malformed hash', () => {
    expect(() => upsertUpdate(undefined, { ...release, publicOrigin: 'http://x' })).toThrow(
      /https/,
    );
    expect(() => upsertUpdate(undefined, { ...release, sha256Hex: 'abc' })).toThrow(/sha256/);
  });

  it('round-trips through parseUpdatesManifest and rejects broken files', () => {
    const m = upsertUpdate(undefined, release);
    expect(parseUpdatesManifest(JSON.stringify(m))).toEqual(m);
    expect(() => parseUpdatesManifest('{}')).toThrow(/no addons/);
    expect(() => parseUpdatesManifest('{"addons":{"a@b":{}}}')).toThrow(/no updates/);
    const bad = JSON.parse(JSON.stringify(m)) as typeof m;
    bad.addons[release.id]!.updates[0]!.update_link = 'http://shots.real.net/x.xpi';
    expect(() => parseUpdatesManifest(JSON.stringify(bad))).toThrow(/malformed/);
  });

  it('orders dotted-integer versions numerically', () => {
    expect(compareVersions('0.9', '0.10')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1')).toBe(0);
    expect(compareVersions('2', '1.9.9.9')).toBeGreaterThan(0);
  });
});
