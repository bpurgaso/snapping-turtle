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
    return { ok: false, reason: 'Enter your server address, e.g. https://shots.example.com' };
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

/** Host-permission match pattern covering every path on `origin`. */
export function hostPattern(origin: string): string {
  return `${origin}/*`;
}
