/**
 * Firefox self-distribution update manifest (PLAN.md §15, M8): the shape of
 * `/ext/updates.json`, its parser, and the version order it is sorted by.
 * Pure — used by the extension's signing script (which writes the file) and
 * by the server (which resolves the current .xpi from it for the home page's
 * stable install link, E2). Format per MDN "Updating extensions": one add-on
 * id, ascending version entries, each with an https `update_link` and a
 * `sha256:` hash of the exact file served.
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

/**
 * The highest version listed across every add-on in the manifest, or
 * undefined when it lists none. The file is sorted ascending when written,
 * but the order is not trusted — a hand-edited file must still resolve.
 */
export function latestUpdate(manifest: UpdatesManifest): UpdateEntry | undefined {
  let latest: UpdateEntry | undefined;
  for (const addon of Object.values(manifest.addons)) {
    for (const entry of addon.updates) {
      if (!latest || compareVersions(entry.version, latest.version) > 0) latest = entry;
    }
  }
  return latest;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
