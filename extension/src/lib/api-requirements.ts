/**
 * The permission contract between the background script and the manifest.
 *
 * Every browser API the background calls that Firefox or Chrome gates on a
 * manifest permission is listed here with the permissions that satisfy it
 * (Firefox: the `permissions` key on the entry in its API schema; Chrome: its
 * documentation). The release audit and the manifest unit tests check the
 * generated manifest against this table, so a call the manifest cannot back
 * fails the build instead of the user — the 0.1.0 Firefox build shipped a
 * `tabs.captureTab` call that no shipped permission could enable.
 *
 * `gated` names the runtime feature check for an API the code uses only when
 * the browser exposes it; such an entry may go unmet by the manifest. Every
 * other entry must be satisfied.
 */
export interface ApiRequirement {
  /** Dotted API name, for messages. */
  api: string;
  /** Manifest permissions (API or host) of which at least one must be declared. */
  anyOf: readonly string[];
  /** Where the code feature-detects the API, when it may legitimately be absent. */
  gated?: string;
}

/** The one permission that would enable native full-page capture on Firefox. */
export const NATIVE_FULL_PAGE_PERMISSION = '<all_urls>';

export const BACKGROUND_API_REQUIREMENTS: readonly ApiRequirement[] = [
  { api: 'tabs.captureVisibleTab', anyOf: ['activeTab', '<all_urls>'] },
  { api: 'scripting.executeScript', anyOf: ['scripting'] },
  { api: 'storage.local', anyOf: ['storage'] },
  { api: 'notifications.create', anyOf: ['notifications'] },
  {
    api: 'tabs.captureTab',
    anyOf: [NATIVE_FULL_PAGE_PERMISSION],
    gated: 'chooseFullPageStrategy in lib/full-page-strategy.ts (stitches when absent)',
  },
];

export interface ManifestPermissions {
  permissions?: readonly string[];
  host_permissions?: readonly string[];
}

function declared(manifest: ManifestPermissions): ReadonlySet<string> {
  return new Set([...(manifest.permissions ?? []), ...(manifest.host_permissions ?? [])]);
}

/** Ungated requirements the manifest does not satisfy; empty means the code's calls are all backed. */
export function unmetRequirements(
  manifest: ManifestPermissions,
  requirements: readonly ApiRequirement[] = BACKGROUND_API_REQUIREMENTS,
): string[] {
  const have = declared(manifest);
  return requirements
    .filter((r) => !r.gated && !r.anyOf.some((p) => have.has(p)))
    .map((r) => `${r.api} needs one of ${r.anyOf.join(', ')} in the manifest`);
}

/** Gated requirements the manifest does not satisfy — what runs on its fallback. */
export function unavailableGatedApis(
  manifest: ManifestPermissions,
  requirements: readonly ApiRequirement[] = BACKGROUND_API_REQUIREMENTS,
): string[] {
  const have = declared(manifest);
  return requirements
    .filter((r) => r.gated && !r.anyOf.some((p) => have.has(p)))
    .map((r) => `${r.api} (needs ${r.anyOf.join(' or ')}; ${r.gated})`);
}

/**
 * True when the manifest declares `<all_urls>` anywhere. The extension's
 * minimal-permission posture (PLAN.md §15, STORE_SUBMISSION.md) forbids it;
 * granting it is a product decision recorded in PLAN.md §17, not a build fix.
 */
export function declaresAllUrls(manifest: ManifestPermissions): boolean {
  return declared(manifest).has(NATIVE_FULL_PAGE_PERMISSION);
}
