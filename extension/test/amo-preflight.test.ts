import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AMO_JWT_TTL_SECONDS,
  amoJwt,
  amoVersionsUrl,
  confirmationAccepted,
  decidePreflight,
  FLAG_FIRST_SIGNING,
  FLAG_SKIP,
  interpretAmoResponse,
  isFollowableAmoUrl,
  latestVersion,
  parsePreflightFlags,
  provenanceWarnings,
  scrubSecrets,
  updatesManifestWarning,
  type AmoResult,
  type PreflightFlags,
} from '../scripts/lib/amo-preflight.js';

/**
 * The AMO signing preflight (E10, PLAN.md §15) is a pure decision over a
 * mocked AMO result, so every branch is pinned here without a network: CI
 * never signs and holds no credentials. Fake values throughout (rule 3).
 */
const geckoId = 'snapping-turtle@shots.example-deploy.net';
const noFlags: PreflightFlags = { firstSigning: false, skipVersionPreflight: false };
const versions = (...v: string[]): AmoResult => ({ kind: 'versions', versions: v });

function decide(
  localVersion: string,
  amoResult: AmoResult | undefined,
  extra: Partial<{ flags: Partial<PreflightFlags>; tty: boolean }> = {},
) {
  return decidePreflight({
    localVersion,
    geckoId,
    amoResult,
    flags: { ...noFlags, ...(extra.flags ?? {}) },
    tty: extra.tty ?? false,
  });
}

describe('decidePreflight — the version gate', () => {
  it('proceeds only when local is strictly greater than the latest AMO holds', () => {
    const d = decide('0.2.1', versions('0.1.0', '0.2.0', '0.1.1'));
    expect(d.action).toBe('proceed');
    expect(d.message).toContain('0.2.1');
    expect(d.message).toContain('0.2.0');
  });

  it('refuses an equal version, naming both versions and the fix', () => {
    const d = decide('0.2.0', versions('0.1.1', '0.2.0'));
    expect(d.action).toBe('refuse');
    expect(d.message).toContain('local version 0.2.0');
    expect(d.message).toContain('0.2.0');
    expect(d.message).toContain('extension/package.json');
    expect(d.message).toMatch(/bump/i);
    expect(d.message).toMatch(/commit/);
  });

  it('refuses a lesser version (this checkout is behind what was published)', () => {
    const d = decide('0.1.1', versions('0.2.0'));
    expect(d.action).toBe('refuse');
    expect(d.message).toContain('local version 0.1.1 is not newer than the latest on AMO, 0.2.0');
  });

  it('orders numerically, not lexically (0.10.0 > 0.9.0), and ignores AMO list order', () => {
    expect(decide('0.10.0', versions('0.9.0')).action).toBe('proceed');
    expect(decide('0.9.1', versions('0.10.0', '0.1.0')).action).toBe('refuse');
    expect(decide('1.0.0', versions('0.10.0', '0.9.9')).action).toBe('proceed');
  });

  it('refuses when the add-on exists but AMO lists no versions (not a state the pipeline produces)', () => {
    const d = decide('0.2.0', versions());
    expect(d.action).toBe('refuse');
    expect(d.message).toMatch(/lists no versions/);
  });

  it(`notes a pointless ${FLAG_FIRST_SIGNING} when the add-on already exists, without changing the verdict`, () => {
    const ok = decide('0.3.0', versions('0.2.0'), { flags: { firstSigning: true } });
    expect(ok.action).toBe('proceed');
    expect(ok.message).toContain('the flag changed nothing');
    const no = decide('0.2.0', versions('0.2.0'), { flags: { firstSigning: true } });
    expect(no.action).toBe('refuse');
    expect(no.message).toContain('the flag changed nothing');
  });
});

describe('decidePreflight — the 404 is the gecko-id gate', () => {
  const notFound: AmoResult = { kind: 'not-found' };

  it('never proceeds by default: without a TTY it refuses and names the flag', () => {
    const d = decide('0.1.0', notFound, { tty: false });
    expect(d.action).toBe('refuse');
    expect(d.message).toContain(FLAG_FIRST_SIGNING);
  });

  it('asks for confirmation on a TTY', () => {
    const d = decide('0.1.0', notFound, { tty: true });
    expect(d.action).toBe('confirm');
  });

  it(`proceeds with ${FLAG_FIRST_SIGNING}, TTY or not`, () => {
    expect(decide('0.1.0', notFound, { flags: { firstSigning: true }, tty: false }).action).toBe(
      'proceed',
    );
    expect(decide('0.1.0', notFound, { flags: { firstSigning: true }, tty: true }).action).toBe(
      'proceed',
    );
  });

  it('spells out both possibilities and the Developer Hub comparison in every 404 message', () => {
    for (const d of [
      decide('0.1.0', notFound, { tty: false }),
      decide('0.1.0', notFound, { tty: true }),
      decide('0.1.0', notFound, { flags: { firstSigning: true } }),
    ]) {
      expect(d.message).toContain(geckoId);
      expect(d.message).toMatch(/first signing/);
      expect(d.message).toMatch(/EXTENSION_GECKO_ID/);
      expect(d.message).toMatch(/brand-new add-on/);
      expect(d.message).toMatch(/orphan/);
      expect(d.message).toMatch(/Developer Hub|addons\.mozilla\.org\/developers/);
      expect(d.message).toMatch(/deploy\/\.env/);
    }
  });

  it('the typed confirmation is the add-on id, exactly', () => {
    expect(confirmationAccepted(geckoId, geckoId)).toBe(true);
    expect(confirmationAccepted(`  ${geckoId}\n`, geckoId)).toBe(true);
    expect(confirmationAccepted('y', geckoId)).toBe(false);
    expect(confirmationAccepted('yes', geckoId)).toBe(false);
    expect(confirmationAccepted(geckoId.toUpperCase(), geckoId)).toBe(false);
    expect(confirmationAccepted('', geckoId)).toBe(false);
  });
});

describe('decidePreflight — fail-closed on anything but an answer', () => {
  it('refuses on a rejected credential (401) with its own message, never printing one', () => {
    const d = decide('0.2.0', { kind: 'auth', status: 401 });
    expect(d.action).toBe('refuse');
    expect(d.message).toMatch(/401/);
    expect(d.message).toMatch(/WEB_EXT_API_KEY/);
    expect(d.message).not.toMatch(/user:\d/);
  });

  it('refuses on 403 as an id/account mismatch, pointing at the Developer Hub', () => {
    const d = decide('0.2.0', { kind: 'auth', status: 403 });
    expect(d.action).toBe('refuse');
    expect(d.message).toMatch(/403/);
    expect(d.message).toMatch(/not a developer/);
    expect(d.message).toMatch(/orphan/);
  });

  it('refuses when AMO is unreachable, distinct from an auth failure, and names the escape hatch', () => {
    const d = decide('0.2.0', { kind: 'network', reason: 'ENOTFOUND' });
    expect(d.action).toBe('refuse');
    expect(d.message).toMatch(/unreachable/);
    expect(d.message).toContain('ENOTFOUND');
    expect(d.message).not.toMatch(/401|credential/);
    expect(d.message).toContain(FLAG_SKIP);
  });

  it('refuses on an unexpected answer (5xx, non-JSON)', () => {
    const d = decide('0.2.0', { kind: 'unexpected', status: 503, detail: 'Service Unavailable' });
    expect(d.action).toBe('refuse');
    expect(d.message).toContain('HTTP 503');
    const noStatus = decide('0.2.0', {
      kind: 'unexpected',
      status: undefined,
      detail: 'too many pages',
    });
    expect(noStatus.message).toContain('no HTTP status');
  });

  it('refuses when no AMO result exists and nothing asked to skip (a script bug, not a user error)', () => {
    expect(decide('0.2.0', undefined).action).toBe('refuse');
  });

  it(`${FLAG_SKIP} proceeds with no AMO result and announces itself loudly`, () => {
    const d = decide('0.2.0', undefined, { flags: { skipVersionPreflight: true } });
    expect(d.action).toBe('proceed');
    expect(d.message).toContain(FLAG_SKIP);
    expect(d.message).toMatch(/SKIPPED/);
    expect(d.message.split('\n').every((l) => l.startsWith('!!!'))).toBe(true);
    // Even a result that would have refused is overridden — that is what the hatch is for.
    expect(
      decide('0.1.0', versions('0.2.0'), { flags: { skipVersionPreflight: true } }).action,
    ).toBe('proceed');
  });
});

describe('flags and helpers', () => {
  it('parses the two flags from argv and ignores everything else', () => {
    expect(parsePreflightFlags([])).toEqual(noFlags);
    expect(parsePreflightFlags(['--xpi', 'x.xpi', FLAG_FIRST_SIGNING])).toEqual({
      ...noFlags,
      firstSigning: true,
    });
    expect(parsePreflightFlags([FLAG_SKIP])).toEqual({ ...noFlags, skipVersionPreflight: true });
  });

  it('latestVersion picks the numerically highest, undefined for none', () => {
    expect(latestVersion(['0.9', '0.10', '0.2'])).toBe('0.10');
    expect(latestVersion([])).toBeUndefined();
  });
});

describe('the AMO request', () => {
  it('mints an HS256 JWT with iss, a jti, and a 60 s expiry that verifies against the secret', () => {
    const key = 'user:123456:789';
    const secret = 'fake-secret-for-tests-only';
    const token = amoJwt(key, secret, 1_700_000_000, 'fixed-jti');
    const [h, p, sig] = token.split('.');
    expect(h && p && sig).toBeTruthy();
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({
      alg: 'HS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(p!, 'base64url').toString())).toEqual({
      iss: key,
      jti: 'fixed-jti',
      iat: 1_700_000_000,
      exp: 1_700_000_000 + AMO_JWT_TTL_SECONDS,
    });
    expect(AMO_JWT_TTL_SECONDS).toBeLessThanOrEqual(300);
    const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
    expect(sig).toBe(expected);
    // A fresh jti per call by default (AMO refuses a reused one).
    const [, p1] = amoJwt(key, secret).split('.');
    const [, p2] = amoJwt(key, secret).split('.');
    expect(JSON.parse(Buffer.from(p1!, 'base64url').toString()).jti).not.toBe(
      JSON.parse(Buffer.from(p2!, 'base64url').toString()).jti,
    );
  });

  it('asks the authenticated versions endpoint for every channel', () => {
    const url = amoVersionsUrl('snapping-turtle@shots.real.net');
    expect(url).toBe(
      'https://addons.mozilla.org/api/v5/addons/addon/snapping-turtle%40shots.real.net/versions/?filter=all_with_unlisted&page_size=50',
    );
    expect(isFollowableAmoUrl(url)).toBe(true);
    expect(isFollowableAmoUrl('https://addons.mozilla.org/api/v5/x/?page=2')).toBe(true);
    expect(isFollowableAmoUrl('https://evil.example.net/api/v5/x/?page=2')).toBe(false);
    expect(isFollowableAmoUrl('http://addons.mozilla.org/api/v5/x/')).toBe(false);
    expect(isFollowableAmoUrl('not a url')).toBe(false);
  });

  it('interprets each status the decision needs', () => {
    expect(interpretAmoResponse(404, '{"detail":"Not found."}')).toEqual({ kind: 'not-found' });
    expect(interpretAmoResponse(401, '{"detail":"..."}')).toEqual({ kind: 'auth', status: 401 });
    expect(interpretAmoResponse(403, '{"detail":"..."}')).toEqual({ kind: 'auth', status: 403 });
    expect(interpretAmoResponse(503, '<html>maintenance</html>')).toEqual({
      kind: 'unexpected',
      status: 503,
      detail: '<html>maintenance</html>',
    });
    expect(interpretAmoResponse(200, 'not json')).toMatchObject({
      kind: 'unexpected',
      status: 200,
    });
    expect(interpretAmoResponse(200, '{"count":0}')).toMatchObject({
      kind: 'unexpected',
      detail: expect.stringMatching(/results/),
    });
    expect(interpretAmoResponse(200, '{"results":[{"id":1}]}')).toMatchObject({
      kind: 'unexpected',
    });
  });

  it('reads versions and the next page out of a 200', () => {
    const body = JSON.stringify({
      count: 2,
      next: 'https://addons.mozilla.org/api/v5/addons/addon/x/versions/?page=2',
      previous: null,
      results: [
        { id: 1, version: '0.1.1', channel: 'unlisted' },
        { id: 2, version: '0.2.0', channel: 'unlisted' },
      ],
    });
    expect(interpretAmoResponse(200, body)).toEqual({
      kind: 'page',
      page: {
        versions: ['0.1.1', '0.2.0'],
        next: 'https://addons.mozilla.org/api/v5/addons/addon/x/versions/?page=2',
      },
    });
    expect(interpretAmoResponse(200, '{"results":[],"next":null}')).toEqual({
      kind: 'page',
      page: { versions: [], next: undefined },
    });
  });

  it('truncates and flattens an unexpected body in the detail', () => {
    const r = interpretAmoResponse(500, 'a\n'.repeat(400));
    expect(r.kind).toBe('unexpected');
    if (r.kind === 'unexpected') expect(r.detail.length).toBeLessThanOrEqual(120);
    expect(interpretAmoResponse(502, '')).toMatchObject({ detail: 'empty body' });
  });
});

describe('soft warning (a): the server already lists a version ≥ local', () => {
  const origin = 'https://shots.real.net:28443';
  const manifest = (v: string) =>
    JSON.stringify({
      addons: {
        [geckoId]: {
          updates: [
            {
              version: v,
              update_link: `${origin}/ext/snapping-turtle-firefox-${v}.xpi`,
              update_hash: `sha256:${'a'.repeat(64)}`,
              applications: { gecko: { strict_min_version: '140.0' } },
            },
          ],
        },
      },
    });

  it('warns when the live manifest is level with or ahead of this checkout', () => {
    expect(
      updatesManifestWarning('0.2.0', geckoId, origin, { ok: true, body: manifest('0.2.0') }),
    ).toMatch(/already lists v0\.2\.0/);
    expect(
      updatesManifestWarning('0.1.1', geckoId, origin, { ok: true, body: manifest('0.2.0') }),
    ).toMatch(/git pull/);
  });

  it('is silent when the checkout is ahead, or the manifest knows another id only', () => {
    expect(
      updatesManifestWarning('0.2.1', geckoId, origin, { ok: true, body: manifest('0.2.0') }),
    ).toBeUndefined();
    const other = manifest('9.9.9').replace(geckoId, 'other@x');
    expect(
      updatesManifestWarning('0.1.0', geckoId, origin, { ok: true, body: other }),
    ).toBeUndefined();
  });

  it('turns a fetch failure or a malformed file into a warning, not a refusal', () => {
    expect(
      updatesManifestWarning('0.2.0', geckoId, origin, { ok: false, reason: 'HTTP 404' }),
    ).toMatch(/could not read .*HTTP 404/);
    expect(updatesManifestWarning('0.2.0', geckoId, origin, { ok: true, body: '{}' })).toMatch(
      /not a valid updates manifest/,
    );
    expect(updatesManifestWarning('0.2.0', geckoId, origin, { ok: true, body: '<html>' })).toMatch(
      /not a valid updates manifest/,
    );
  });
});

describe('soft warning (b): provenance', () => {
  it('warns on a dirty tree, on an unpushed HEAD, on both, and never on a clean pushed one', () => {
    expect(provenanceWarnings({ dirty: false, onRemote: true, head: 'abc1234' })).toEqual([]);
    expect(provenanceWarnings({ dirty: true, onRemote: true, head: 'abc1234' })).toEqual([
      expect.stringMatching(/uncommitted changes on top of HEAD \(abc1234\)/),
    ]);
    expect(provenanceWarnings({ dirty: false, onRemote: false })).toEqual([
      expect.stringMatching(/not on any remote branch/),
    ]);
    expect(provenanceWarnings({ dirty: true, onRemote: false })).toHaveLength(2);
  });
});

describe('rule 3: credentials and JWTs never reach output', () => {
  const key = 'user:424242:17';
  const secret = 'fake-secret-value-that-must-not-print';

  it('scrubs every occurrence of the key and secret, and anything shaped like a JWT', () => {
    const jwt = amoJwt(key, secret, 1_700_000_000, 'j');
    const leak = `request failed for ${key} with Authorization: JWT ${jwt} using ${secret} twice ${secret}`;
    const scrubbed = scrubSecrets(leak, [key, secret]);
    expect(scrubbed).not.toContain(key);
    expect(scrubbed).not.toContain(secret);
    expect(scrubbed).not.toContain(jwt);
    expect(scrubbed).toContain('[redacted]');
    expect(scrubbed).toContain('[redacted-jwt]');
  });

  it('leaves ordinary text alone and tolerates unset secrets', () => {
    const text = 'local version 0.2.0 is not newer than the latest on AMO, 0.2.0';
    expect(scrubSecrets(text, [undefined, ''])).toBe(text);
  });

  it('no decision message carries anything but what the user typed into deploy/.env', () => {
    const results: AmoResult[] = [
      versions('0.2.0'),
      versions(),
      { kind: 'not-found' },
      { kind: 'auth', status: 401 },
      { kind: 'auth', status: 403 },
      { kind: 'network', reason: 'ECONNREFUSED' },
      { kind: 'unexpected', status: 500, detail: 'x' },
    ];
    for (const r of results) {
      for (const tty of [true, false]) {
        for (const flags of [noFlags, { ...noFlags, firstSigning: true }]) {
          const { message } = decidePreflight({
            localVersion: '0.2.0',
            geckoId,
            amoResult: r,
            flags,
            tty,
          });
          expect(message).not.toMatch(/user:\d+:\d+/);
          expect(message).not.toMatch(/eyJ/);
        }
      }
    }
  });
});
