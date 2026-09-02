import { EXT_ROUTE_PREFIX, EXT_UPDATES_MANIFEST } from '@snapping-turtle/shared/constants';
import { hostPattern, parseServerOrigin } from './lib/origin.js';

/**
 * Manifest generation (PLAN.md §15). One template, two targets; the only
 * per-browser differences are the background entry (Chrome service worker
 * vs Firefox event page) and Firefox's gecko block. Build output is generated —
 * never hand-edit the generated manifest.json under dist/.
 */

export const TARGETS = ['chrome', 'firefox'] as const;
export type Target = (typeof TARGETS)[number];

export function isTarget(value: string): value is Target {
  return (TARGETS as readonly string[]).includes(value);
}

type IconSet = Record<string, string>;

export interface ManifestTemplate {
  manifest_version: 3;
  name: string;
  description: string;
  icons: IconSet;
  action: { default_title: string; default_popup: string; default_icon: IconSet };
  options_ui: { page: string; open_in_tab: boolean };
  permissions: string[];
  optional_host_permissions: string[];
  commands: Record<string, { suggested_key: { default: string }; description: string }>;
}

export interface BuildManifestOptions {
  template: ManifestTemplate;
  version: string;
  /** Build-time default server; becomes the sole host_permissions entry. */
  publicOrigin: string;
  /** Firefox add-on id; defaults to `snapping-turtle@<publicOrigin host>`. */
  geckoId?: string;
}

export type Manifest = ManifestTemplate & {
  version: string;
  host_permissions: string[];
  background: { service_worker: string } | { scripts: string[] };
  minimum_chrome_version?: string;
  browser_specific_settings?: {
    gecko: GeckoSettings;
    gecko_android: { strict_min_version: string };
  };
};

export interface GeckoSettings {
  id: string;
  strict_min_version: string;
  /**
   * Self-distributed builds update themselves from the server's public
   * `/ext/updates.json` (M8, PLAN.md §15). Firefox requires https here, so a
   * plain-http localhost dev build carries no update_url at all.
   */
  update_url?: string;
  /**
   * AMO's addons-linter requires a data-collection declaration for new
   * submissions (Firefox 140+ shows it at install; older versions ignore the
   * key). Declared truthfully: captures are website content and the source
   * URL + title are browsing activity — both go only to the user's own server.
   */
  data_collection_permissions: { required: readonly DataCollectionCategory[] };
}

export type DataCollectionCategory = 'websiteContent' | 'browsingActivity';
export const DATA_COLLECTION_REQUIRED: readonly DataCollectionCategory[] = [
  'websiteContent',
  'browsingActivity',
];

const VERSION_PATTERN = /^\d+(\.\d+){0,3}$/;

/** Chrome 116+: MV3 service workers with reliable `runtime.onMessage` promises. */
export const MIN_CHROME = '116';
/**
 * Firefox 140+ (the 2025 ESR). 128 was the `optional_host_permissions` floor
 * (M2); 140 is the first release that understands
 * `data_collection_permissions`, which AMO requires for new submissions —
 * older Firefox would install the add-on but addons-linter flags the key as
 * unsupported below 140. 128 ESR reached end of life before M8 shipped.
 */
export const MIN_FIREFOX = '140.0';
/**
 * Firefox for Android learned `data_collection_permissions` in 142. Android
 * has no ESR channel (users ride the release train), so this floor excludes
 * nobody real; the build is not tested on Android (extension/TESTING.md).
 */
export const MIN_FIREFOX_ANDROID = '142.0';

export function buildManifest(target: Target, opts: BuildManifestOptions): Manifest {
  if (!VERSION_PATTERN.test(opts.version)) {
    throw new Error(`extension version must be 1–4 dot-separated integers, got "${opts.version}"`);
  }
  const parsed = parseServerOrigin(opts.publicOrigin);
  if (!parsed.ok)
    throw new Error(`PUBLIC_ORIGIN "${opts.publicOrigin}" rejected: ${parsed.reason}`);
  const origin = new URL(parsed.origin);

  const base = {
    ...structuredClone(opts.template),
    version: opts.version,
    // The port of PUBLIC_ORIGIN needs no manifest change of its own:
    // hostPattern keeps it for Chrome (which honours explicit ports) and drops
    // it for Firefox (whose matcher ignores ports), and the template's
    // port-less optional_host_permissions pattern matches every port in both.
    host_permissions: [hostPattern(origin.origin, target)],
  };

  switch (target) {
    case 'chrome':
      return {
        ...base,
        background: { service_worker: 'background.js' },
        minimum_chrome_version: MIN_CHROME,
      };
    case 'firefox':
      return {
        ...base,
        background: { scripts: ['background.js'] },
        browser_specific_settings: {
          gecko: {
            id: opts.geckoId ?? `snapping-turtle@${origin.hostname}`,
            strict_min_version: MIN_FIREFOX,
            ...(origin.protocol === 'https:'
              ? { update_url: `${origin.origin}${EXT_ROUTE_PREFIX}${EXT_UPDATES_MANIFEST}` }
              : {}),
            data_collection_permissions: { required: [...DATA_COLLECTION_REQUIRED] },
          },
          gecko_android: { strict_min_version: MIN_FIREFOX_ANDROID },
        },
      };
  }
}
