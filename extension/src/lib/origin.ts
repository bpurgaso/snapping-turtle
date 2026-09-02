/**
 * Server-origin validation shared by the manifest generator (build time) and
 * the options page (run time). Fails closed: anything that is not a bare
 * http(s) origin is rejected, and plain http is only tolerated for loopback
 * hosts so local development does not have to fight Caddy's internal CA
 * (PLAN.md §15).
 */

export type OriginResult = { ok: true; origin: string } | { ok: false; reason: string };

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function parseServerOrigin(input: string): OriginResult {
  const trimmed = input.trim();
  if (trimmed === '')
    return {
      ok: false,
      reason: 'Enter your server address: the https origin of your snapping-turtle server',
    };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: `Not a valid URL — include the scheme, e.g. https://${trimmed}` };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'The server address must start with https://' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'The server address must not contain credentials' };
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    return { ok: false, reason: 'Use a bare origin — no path, query or fragment' };
  }
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    return {
      ok: false,
      reason:
        'The server address must use https (plain http is only allowed for localhost / 127.0.0.1)',
    };
  }
  return { ok: true, origin: url.origin };
}

export type BrowserTarget = 'chrome' | 'firefox';

/**
 * Host-permission match pattern covering every path on `origin`.
 *
 * Ports need no manifest handling of their own — a deployment on a custom
 * port (PUBLIC_PORT, default 28443) flows through here from PUBLIC_ORIGIN:
 *
 * - Firefox silently accepts a port in a match pattern but its matcher
 *   ignores ports, so `http://localhost:3000/*` matches nothing there
 *   (Firefox bugs 1362809 / 1468162, design-decision-denied) —
 *   `permissions.request` still reports success and every fetch then fails
 *   CORS. For Firefox the port is therefore dropped: `http://localhost/*`
 *   matches every port on that host, `https://shots.example.com/*` covers
 *   `https://shots.example.com:28443` too.
 * - Chrome honours an explicit port and keeps the tighter pattern
 *   (`https://shots.example.com:28443/*`). A pattern without a port matches
 *   every port in Chrome as well, which is why the template's port-less
 *   `optional_host_permissions` pattern (`https://` + any host + any path,
 *   manifest.template.json) already admits any custom-port https server a
 *   user enters in options.
 */
export function hostPattern(origin: string, target: BrowserTarget = 'chrome'): string {
  if (target === 'firefox') {
    const url = new URL(origin);
    return `${url.protocol}//${url.hostname}/*`;
  }
  return `${origin}/*`;
}
