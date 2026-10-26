/**
 * `GET /robots.txt` (PLAN.md §6 "no discovery surface"; E12 route audit).
 * The design has always said robots.txt disallows `/s/`; until E12 nothing
 * served one, so a well-behaved crawler that somehow held a capture link had
 * only the per-response `X-Robots-Tag` to go on. The file is a fixed string
 * — no user data, no configuration — and `scripts/verify-live.sh` asserts the
 * live deployment serves exactly this text.
 *
 * Naming `/s/` here reveals nothing: the prefix is in every shared link and
 * in the public design; the secret is the 160-bit id after it (§6).
 */
export const ROBOTS_PATH = '/robots.txt';

export const ROBOTS_TXT = `User-agent: *
Disallow: /s/
Disallow: /reset/
Disallow: /api/
`;

/** Public like /ext/ and /privacy: crawlers re-read it; it never changes per viewer. */
export const ROBOTS_CACHE_CONTROL = 'public, max-age=300';
