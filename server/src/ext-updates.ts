import {
  EXT_ROUTE_PREFIX,
  EXT_UPDATES_MANIFEST,
  firefoxXpiFilename,
  latestUpdate,
  parseUpdatesManifest,
} from '@snapping-turtle/shared';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Exactly the .xpi file shape sign:firefox publishes; nothing else in EXT_DIR is reachable. */
export const EXT_XPI_PATH = /^\/snapping-turtle-firefox-\d+(\.\d+){0,3}\.xpi$/;

/**
 * The path under /ext/ of the newest signed Firefox build, resolved from
 * updates.json at call time (E2): the home page links `/ext/firefox-latest`
 * and never has to change as versions ship. Undefined when nothing is
 * published yet — no directory, no manifest, an empty or malformed one, or a
 * manifest naming a version whose file is not actually there — so the caller
 * can degrade ("not yet published") instead of linking a dead download.
 *
 * The filename derives from the version, not from `update_link`, so the
 * redirect stays same-origin even for entries signed before a domain
 * migration; the shape check mirrors the static route's allow-list.
 */
export function resolveLatestFirefoxXpi(
  extDir: string,
  onMalformed?: (reason: string) => void,
): string | undefined {
  const manifestPath = join(extDir, EXT_UPDATES_MANIFEST);
  if (!existsSync(manifestPath)) return undefined;
  let version: string | undefined;
  try {
    version = latestUpdate(parseUpdatesManifest(readFileSync(manifestPath, 'utf8')))?.version;
  } catch (err) {
    onMalformed?.(err instanceof Error ? err.message : String(err));
    return undefined;
  }
  if (version === undefined) return undefined;
  const filename = firefoxXpiFilename(version);
  if (!EXT_XPI_PATH.test(`/${filename}`) || !existsSync(join(extDir, filename))) {
    onMalformed?.(`updates.json names version ${version} but ${filename} is not published`);
    return undefined;
  }
  return `${EXT_ROUTE_PREFIX}${filename}`;
}
