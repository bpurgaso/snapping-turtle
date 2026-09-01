// Shared helpers for the k6 guard scenarios (docs/loadtest.md). Runs inside
// the grafana/k6 container against the loadtest compose profile, which is
// the only place TRUST_PROXY=true — so the X-Forwarded-For header each
// helper sends is honoured as the client IP and the guard keys on it.
import { check, fail } from 'k6';
import encoding from 'k6/encoding';
import crypto from 'k6/crypto';
import http from 'k6/http';

export const BASE = __ENV.BASE_URL || 'http://app:3000';

/** Request params that make the guard see `ip` as the client. */
export function asIp(ip, extraHeaders = {}, tags = {}) {
  return { headers: { 'x-forwarded-for': ip, ...extraHeaders }, tags };
}

/** A well-formed view_id that cannot exist: 20 CSPRNG bytes, base64url (27 chars). */
export function missPath() {
  const id = encoding.b64encode(crypto.randomBytes(20), 'rawurl');
  return `/s/${id}`;
}

function cookieHeader(res) {
  const parts = [];
  for (const name of ['st_session', 'st_csrf']) {
    const c = res.cookies[name];
    if (c && c.length > 0) parts.push(`${name}=${c[0].value}`);
  }
  return parts.join('; ');
}

/**
 * setup() helper: sign in as the seeded loadtest admin, mint an API token,
 * upload the fixture PNG and return { path, cookie, csrf }. The setup IP is
 * distinct from every scenario IP so its handful of requests never skew a
 * budget. Optionally saves one annotation so image.png exercises the flat
 * renderer instead of only streaming the original.
 */
export function setupCapture(pngBytes, { annotate = false } = {}) {
  const ip = '203.0.113.250';
  const login = http.post(
    `${BASE}/api/v1/auth/login`,
    JSON.stringify({ username: __ENV.LOADTEST_USER, password: __ENV.LOADTEST_PASSWORD }),
    asIp(ip, { 'content-type': 'application/json' }, { name: 'setup' }),
  );
  if (login.status !== 200) fail(`setup: login failed with ${login.status}`);
  const cookie = cookieHeader(login);
  const csrf = login.json('csrfToken');

  const tok = http.post(
    `${BASE}/api/v1/tokens`,
    JSON.stringify({ name: 'k6' }),
    asIp(
      ip,
      { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
      { name: 'setup' },
    ),
  );
  if (tok.status !== 201) fail(`setup: token mint failed with ${tok.status}`);
  const token = tok.json('token');

  const up = http.post(
    `${BASE}/api/v1/captures`,
    {
      image: http.file(pngBytes, 'fixture.png', 'image/png'),
      sourceUrl: 'https://example.com/k6',
      title: 'k6 fixture',
    },
    asIp(ip, { authorization: `Bearer ${token}` }, { name: 'setup' }),
  );
  if (up.status !== 201) fail(`setup: upload failed with ${up.status}: ${up.body}`);
  const m = /\/s\/[A-Za-z0-9_-]{27}$/.exec(up.json('pageUrl'));
  if (!m) fail('setup: unexpected pageUrl shape');
  const path = m[0];

  if (annotate) {
    const doc = {
      version: 1,
      rev: 0,
      shapes: [
        { id: 'k6-rect', type: 'rect', x: 10, y: 10, w: 120, h: 60 },
        { id: 'k6-text', type: 'text', x: 20, y: 90, text: 'k6 baseline', fontSize: 28 },
      ],
    };
    const put = http.put(
      `${BASE}/api/v1/captures${path.slice(2)}/annotations`,
      JSON.stringify(doc),
      asIp(
        ip,
        { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
        { name: 'setup' },
      ),
    );
    if (put.status !== 200) fail(`setup: annotation save failed with ${put.status}: ${put.body}`);
  }

  const sanity = http.get(`${BASE}${path}`, asIp(ip, {}, { name: 'setup' }));
  check(sanity, { 'setup: valid link serves 200': (r) => r.status === 200 });
  return { path, cookie, csrf };
}

/** Admin guard view — breaker state as the server sees it. */
export function guardStatus(cookie) {
  const res = http.get(
    `${BASE}/api/v1/admin/guard`,
    asIp('203.0.113.251', { cookie }, { name: 'guard-status' }),
  );
  if (res.status !== 200) fail(`guard status failed with ${res.status}`);
  return res.json();
}

/** The guard's pre-lookup 429 page: same body for valid and invalid links. */
export function isGuardBlocked(res) {
  return (
    res.status === 429 &&
    typeof res.headers['Retry-After'] === 'string' &&
    Number(res.headers['Retry-After']) > 0 &&
    res.body.includes('Too many requests')
  );
}
