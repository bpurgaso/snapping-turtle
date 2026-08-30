/**
 * Manifest generation (PLAN.md §15). One template, two targets; the only
 * per-browser differences are the background entry (Chrome service worker
 * vs Firefox event page) and Firefox's gecko id. Build output is generated —
 * never hand-edit the generated manifest.json under dist/.
 */

export const TARGETS = ['chrome', 'firefox'] as const;
export type Target = (typeof TARGETS)[number];

export function isTarget(value: string): value is Target {
  return (TARGETS as readonly string[]).includes(value);
}

export interface ManifestTemplate {
  manifest_version: 3;
  name: string;
  description: string;
  action: { default_title: string; default_popup: string };
  permissions: string[];
  optional_host_permissions: string[];
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

export function buildManifest(target: Target, opts: BuildManifestOptions): Manifest {
  if (!VERSION_PATTERN.test(opts.version)) {
    throw new Error(`extension version must be 1–4 dot-separated integers, got "${opts.version}"`);
  }
  const origin = parseOrigin(opts.publicOrigin);

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
        minimum_chrome_version: '116',
      };
    case 'firefox':
      return {
        ...base,
        background: { scripts: ['background.js'] },
        browser_specific_settings: {
          gecko: {
            id: opts.geckoId ?? `snapping-turtle@${origin.hostname}`,
            strict_min_version: '121.0',
          },
        },
      };
  }
}

function parseOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`PUBLIC_ORIGIN is not a valid URL: "${value}"`);
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(`PUBLIC_ORIGIN must be a bare http(s) origin, got "${value}"`);
  }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('PUBLIC_ORIGIN must use https except for localhost');
  }
  return url;
}
