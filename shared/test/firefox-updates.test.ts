import { describe, expect, it } from 'vitest';
import { latestUpdate, parseUpdatesManifest, type UpdateEntry } from '../src/firefox-updates.js';

const entry = (version: string): UpdateEntry => ({
  version,
  update_link: `https://shots.test/ext/snapping-turtle-firefox-${version}.xpi`,
  update_hash: `sha256:${'a'.repeat(64)}`,
  applications: { gecko: { strict_min_version: '140.0' } },
});

describe('latestUpdate', () => {
  it('picks the numerically highest version regardless of file order', () => {
    const manifest = {
      addons: { 'snapping-turtle@shots.test': { updates: [entry('0.10.0'), entry('0.2.0'), entry('0.9.1')] } },
    };
    expect(latestUpdate(manifest)?.version).toBe('0.10.0');
    expect(latestUpdate(parseUpdatesManifest(JSON.stringify(manifest)))?.version).toBe('0.10.0');
  });

  it('is undefined for a manifest that lists nothing', () => {
    expect(latestUpdate({ addons: {} })).toBeUndefined();
    expect(latestUpdate({ addons: { 'a@b': { updates: [] } } })).toBeUndefined();
  });
});
