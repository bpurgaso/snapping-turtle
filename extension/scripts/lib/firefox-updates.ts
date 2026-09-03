import {
  compareVersions,
  EXT_ROUTE_PREFIX,
  firefoxXpiFilename,
  type UpdateEntry,
  type UpdatesManifest,
} from '@snapping-turtle/shared';

/**
 * Writing side of the Firefox self-distribution manifest (M8, PLAN.md §15).
 * The shape, parser and version order live in shared/ (the server reads the
 * same file to resolve `/ext/firefox-latest`); this module adds what only
 * the signing script needs — building an entry and upserting it.
 */

export {
  compareVersions,
  parseUpdatesManifest,
  type UpdateEntry,
  type UpdatesManifest,
} from '@snapping-turtle/shared';

export interface NewRelease {
  id: string;
  version: string;
  publicOrigin: string;
  sha256Hex: string;
  strictMinVersion: string;
}

export function updateLinkFor(publicOrigin: string, version: string): string {
  return `${publicOrigin}${EXT_ROUTE_PREFIX}${firefoxXpiFilename(version)}`;
}

/** Insert or replace `release` in `existing` (which may be absent), keeping other versions. */
export function upsertUpdate(
  existing: UpdatesManifest | undefined,
  release: NewRelease,
): UpdatesManifest {
  if (!/^[0-9a-f]{64}$/.test(release.sha256Hex)) {
    throw new Error('sha256Hex must be 64 lowercase hex characters');
  }
  if (!release.publicOrigin.startsWith('https://')) {
    throw new Error('Firefox only follows https update links');
  }
  const entry: UpdateEntry = {
    version: release.version,
    update_link: updateLinkFor(release.publicOrigin, release.version),
    update_hash: `sha256:${release.sha256Hex}`,
    applications: { gecko: { strict_min_version: release.strictMinVersion } },
  };
  const others = (existing?.addons[release.id]?.updates ?? []).filter(
    (u) => u.version !== release.version,
  );
  const updates = [...others, entry].sort((a, b) => compareVersions(a.version, b.version));
  const manifest: UpdatesManifest = { addons: { ...(existing?.addons ?? {}) } };
  manifest.addons[release.id] = { updates };
  return manifest;
}
