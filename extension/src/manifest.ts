import { parseServerOrigin } from './lib/origin.js';

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
  browser_specific_settings?: { gecko: { id: string; strict_min_version: string } };
};

const VERSION_PATTERN = /^\d+(\.\d+){0,3}$/;

/** Chrome 116+: MV3 service workers with reliable `runtime.onMessage` promises. */
export const MIN_CHROME = '116';
/** Firefox 128+: first release with `optional_host_permissions` (MDN compat data). */
export const MIN_FIREFOX = '128.0';

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
    host_permissions: [`${origin.origin}/*`],
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
          },
        },
      };
  }
}
