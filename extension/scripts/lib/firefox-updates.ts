import { EXT_ROUTE_PREFIX, firefoxXpiFilename } from '@snapping-turtle/shared';

/**
 * Firefox self-distribution update manifest (M8, PLAN.md §15). The signed
 * .xpi and this file are served by the app under EXT_ROUTE_PREFIX; the
 * Firefox manifest's `update_url` points at it. Format per MDN
 * "Updating extensions": one add-on id, ascending version entries, each with
 * an https `update_link` and a `sha256:` hash of the exact file served.
 */

export interface UpdateEntry {
  version: string;
  update_link: string;
  update_hash: string;
  applications: { gecko: { strict_min_version: string } };
}

export interface UpdatesManifest {
  addons: Record<string, { updates: UpdateEntry[] }>;
}

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

/** Parse and shape-check an updates.json; throws with a reason on anything off. */
export function parseUpdatesManifest(json: string): UpdatesManifest {
  const value: unknown = JSON.parse(json);
  if (!isRecord(value) || !isRecord(value['addons'])) throw new Error('updates.json: no addons');
  for (const [id, addon] of Object.entries(value['addons'])) {
    if (!isRecord(addon) || !Array.isArray(addon['updates'])) {
      throw new Error(`updates.json: addon ${id} has no updates array`);
    }
    for (const u of addon['updates']) {
      if (
        !isRecord(u) ||
        typeof u['version'] !== 'string' ||
        typeof u['update_link'] !== 'string' ||
        !u['update_link'].startsWith('https://') ||
        typeof u['update_hash'] !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/.test(u['update_hash'])
      ) {
        throw new Error(`updates.json: malformed entry for ${id}`);
      }
    }
  }
  return value as unknown as UpdatesManifest;
}

/** Dotted-integer version order (the only shape buildManifest accepts). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
