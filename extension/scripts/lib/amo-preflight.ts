import { createHmac, randomBytes } from 'node:crypto';
import {
  compareVersions,
  parseUpdatesManifest,
  type UpdatesManifest,
} from '@snapping-turtle/shared';

/**
 * AMO signing preflight (E10, PLAN.md §15): everything about "may this
 * version be uploaded?" that can be decided without I/O.
 *
 * The signing script asks AMO for the versions already published under
 * EXTENSION_GECKO_ID and refuses to upload unless the local version
 * (extension/package.json, the single version source) is strictly greater.
 * Two cross-machine failure modes become deliberate gates here:
 *
 *   - a version that AMO already holds, which AMO itself would refuse — but
 *     only after a full upload and validation round, with a message that
 *     does not say what to do;
 *   - a 404, which is EITHER a genuine first signing OR an EXTENSION_GECKO_ID
 *     that differs from the one that published. A mismatched id silently
 *     creates a brand-new add-on that no installed Firefox will ever update
 *     to, so a 404 never proceeds by default (`--first-signing`, or a typed
 *     confirmation on a TTY).
 *
 * Fail-closed is cheap: signing needs AMO reachable anyway, so an auth or
 * network failure refuses with its own message instead of guessing.
 * `--skip-version-preflight` exists for genuine AMO API weirdness and
 * announces itself loudly.
 *
 * CLAUDE.md rule 3 applies to this module's output: the API key, the secret
 * and the JWT minted from them never appear in a message — `scrubSecrets`
 * is the last line of defence on every string the runner prints.
 *
 * Pure: `decidePreflight` is {localVersion, amoResult, flags, tty} in,
 * {action, message} out, so every branch is unit-tested against mocked
 * responses and CI never touches the network (signing never runs there and
 * the credentials do not exist there).
 */

export const AMO_API_ORIGIN = 'https://addons.mozilla.org';
export const AMO_DEVELOPER_HUB = 'https://addons.mozilla.org/developers/addons';
/** AMO rejects tokens that live longer than 5 minutes; one minute is plenty for one request. */
export const AMO_JWT_TTL_SECONDS = 60;
/** Pages of the versions list the runner will follow before calling the response unusable. */
export const AMO_MAX_PAGES = 20;

export type AmoResult =
  /** The add-on exists; `versions` is every version AMO lists for it (listed + unlisted). */
  | { kind: 'versions'; versions: string[] }
  /** AMO has no add-on under this id (HTTP 404). */
  | { kind: 'not-found' }
  /** The credentials were rejected (401) or are not a developer of this add-on (403). */
  | { kind: 'auth'; status: 401 | 403 }
  /** AMO could not be reached: DNS, TLS, connection, timeout. `reason` is already scrubbed. */
  | { kind: 'network'; reason: string }
  /** AMO answered with something this script does not understand (5xx, non-JSON, …). */
  | { kind: 'unexpected'; status: number | undefined; detail: string };

export interface PreflightFlags {
  firstSigning: boolean;
  skipVersionPreflight: boolean;
}

export interface PreflightInput {
  localVersion: string;
  geckoId: string;
  /** Absent only when the preflight was skipped before querying AMO. */
  amoResult?: AmoResult | undefined;
  flags: PreflightFlags;
  /** Whether a human can answer a question (stdin and stdout are both TTYs). */
  tty: boolean;
}

export interface PreflightDecision {
  /**
   * proceed  — upload may go ahead; `message` is informational.
   * refuse   — do not upload; `message` says why and exactly what to do.
   * confirm  — a human must confirm interactively (404 on a TTY without
   *            --first-signing); `message` is what to show before asking.
   */
  action: 'proceed' | 'refuse' | 'confirm';
  message: string;
}

export const FLAG_FIRST_SIGNING = '--first-signing';
export const FLAG_SKIP = '--skip-version-preflight';

export function parsePreflightFlags(argv: readonly string[]): PreflightFlags {
  return {
    firstSigning: argv.includes(FLAG_FIRST_SIGNING),
    skipVersionPreflight: argv.includes(FLAG_SKIP),
  };
}

/** The highest version in `versions` by the dotted-integer order updates.json uses. */
export function latestVersion(versions: readonly string[]): string | undefined {
  let latest: string | undefined;
  for (const v of versions) {
    if (latest === undefined || compareVersions(v, latest) > 0) latest = v;
  }
  return latest;
}

export function decidePreflight(input: PreflightInput): PreflightDecision {
  const { localVersion, geckoId, amoResult, flags, tty } = input;

  if (flags.skipVersionPreflight) {
    return {
      action: 'proceed',
      message: [
        `!!! ${FLAG_SKIP} given: the AMO version check was SKIPPED.`,
        `!!! Nothing has verified that v${localVersion} is newer than what AMO holds for`,
        `!!! ${geckoId}, or that this id is the one that published before. If this is`,
        `!!! not a known AMO API problem, stop and run version:check without the flag.`,
      ].join('\n'),
    };
  }

  if (!amoResult) {
    return {
      action: 'refuse',
      message: 'the AMO query did not run; this is a bug in the signing script, not in your setup',
    };
  }

  switch (amoResult.kind) {
    case 'network':
      return {
        action: 'refuse',
        message: [
          `AMO is unreachable (${amoResult.reason}).`,
          `Signing needs ${AMO_API_ORIGIN} anyway, so nothing was uploaded. Check the connection and`,
          `retry; ${FLAG_SKIP} skips this check if the AMO API itself is misbehaving.`,
        ].join('\n'),
      };

    case 'auth':
      return amoResult.status === 401
        ? {
            action: 'refuse',
            message: [
              'AMO rejected the API credentials (HTTP 401).',
              'Re-export WEB_EXT_API_KEY and WEB_EXT_API_SECRET in this shell from your password manager',
              '(https://addons.mozilla.org/developers/addon/api/key/ issues a new pair; the old secret is',
              'not recoverable). Neither value is printed here, by design.',
            ].join('\n'),
          }
        : {
            action: 'refuse',
            message: [
              `AMO accepted the credentials but they are not a developer of ${geckoId} (HTTP 403).`,
              'The add-on exists under another AMO account, or EXTENSION_GECKO_ID names somebody',
              `else's add-on. Compare the id in ${AMO_DEVELOPER_HUB} with deploy/.env before`,
              'doing anything else; signing under a different id would orphan every installed copy.',
            ].join('\n'),
          };

    case 'unexpected':
      return {
        action: 'refuse',
        message: [
          `AMO answered unexpectedly (${
            amoResult.status === undefined ? 'no HTTP status' : `HTTP ${amoResult.status}`
          }: ${amoResult.detail}).`,
          `Nothing was uploaded. Retry later; ${FLAG_SKIP} skips this check if the AMO API itself is`,
          'misbehaving and you have confirmed the version and id by hand in the Developer Hub.',
        ].join('\n'),
      };

    case 'not-found': {
      const explanation = [
        `AMO has no add-on with id ${geckoId} (HTTP 404). That means ONE of two things:`,
        `  (a) this is genuinely the first signing of this extension, and AMO will create`,
        `      the add-on under this id now; or`,
        `  (b) EXTENSION_GECKO_ID on this machine differs from the id that published before.`,
        `      Signing would then create a brand-new add-on that NO installed Firefox will`,
        `      ever update to — every existing user is silently orphaned.`,
        `Before confirming, open ${AMO_DEVELOPER_HUB} with the publishing account and compare`,
        `the add-on's id with deploy/.env byte for byte (the Developer Hub shows it under`,
        `"Manage Status & Versions"). If an add-on is already there, fix deploy/.env — do not confirm.`,
      ].join('\n');
      if (flags.firstSigning) {
        return {
          action: 'proceed',
          message: `${explanation}\n${FLAG_FIRST_SIGNING} given: proceeding as the first signing of ${geckoId} (v${localVersion}).`,
        };
      }
      if (tty) {
        return { action: 'confirm', message: explanation };
      }
      return {
        action: 'refuse',
        message: `${explanation}\nNo terminal to ask on. If (a) is certain, re-run with ${FLAG_FIRST_SIGNING}.`,
      };
    }

    case 'versions': {
      const latest = latestVersion(amoResult.versions);
      if (latest === undefined) {
        return {
          action: 'refuse',
          message: [
            `AMO knows the add-on ${geckoId} but lists no versions for it.`,
            'That is not a state this script expects (every signing creates a version). Look at',
            `${AMO_DEVELOPER_HUB} first; ${FLAG_SKIP} skips this check once you understand why.`,
          ].join('\n'),
        };
      }
      const note = flags.firstSigning
        ? `\n(${FLAG_FIRST_SIGNING} was given but the add-on already exists on AMO; the flag changed nothing.)`
        : '';
      if (compareVersions(localVersion, latest) <= 0) {
        return {
          action: 'refuse',
          message:
            [
              `local version ${localVersion} is not newer than the latest on AMO, ${latest} (${geckoId}).`,
              `Bump "version" in extension/package.json and commit, then build:release and sign again.`,
            ].join('\n') + note,
        };
      }
      return {
        action: 'proceed',
        message: `local version ${localVersion} > ${latest} (latest on AMO for ${geckoId}); ok to upload.${note}`,
      };
    }
  }
}

/**
 * A typed confirmation for the 404 branch: the user types the add-on id
 * back, which forces reading it next to the Developer Hub rather than
 * hitting "y". Whitespace around the answer is forgiven; nothing else is.
 */
export function confirmationAccepted(answer: string, geckoId: string): boolean {
  return answer.trim() === geckoId;
}

// ---- AMO API: JWT and response interpretation ---------------------------------

/**
 * The JWT AMO's API wants: HS256, `iss` = the JWT issuer ("user:…"), a random
 * `jti`, `iat`/`exp` at most five minutes apart. Hand-rolled on node:crypto
 * (CLAUDE.md: dependencies are attack surface; this is fifteen lines).
 * The result is a credential: it must only ever go into an Authorization
 * header, never into a message (`scrubSecrets` also removes it).
 */
export function amoJwt(
  apiKey: string,
  apiSecret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  jti: string = randomBytes(16).toString('hex'),
): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({ iss: apiKey, jti, iat: nowSeconds, exp: nowSeconds + AMO_JWT_TTL_SECONDS }),
  );
  const signature = createHmac('sha256', apiSecret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

/** The authenticated versions list, every channel: `filter=all_with_unlisted` needs a developer of the add-on. */
export function amoVersionsUrl(geckoId: string): string {
  return `${AMO_API_ORIGIN}/api/v5/addons/addon/${encodeURIComponent(geckoId)}/versions/?filter=all_with_unlisted&page_size=50`;
}

/** One page of AMO's versions list, as far as this script reads it. */
export interface AmoVersionsPage {
  versions: string[];
  next: string | undefined;
}

/**
 * Interpret one response of the versions endpoint. Pure over (status, body)
 * so the branches are testable without a server. A 200 whose body is not
 * the documented shape is `unexpected`, never silently "no versions".
 */
export function interpretAmoResponse(
  status: number,
  body: string,
): { kind: 'page'; page: AmoVersionsPage } | Exclude<AmoResult, { kind: 'versions' }> {
  if (status === 404) return { kind: 'not-found' };
  if (status === 401 || status === 403) return { kind: 'auth', status };
  if (status !== 200) {
    return { kind: 'unexpected', status, detail: summarizeBody(body) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: 'unexpected', status, detail: 'response is not JSON' };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['results'])) {
    return { kind: 'unexpected', status, detail: 'response has no results array' };
  }
  const versions: string[] = [];
  for (const r of parsed['results']) {
    if (!isRecord(r) || typeof r['version'] !== 'string') {
      return { kind: 'unexpected', status, detail: 'a result has no version string' };
    }
    versions.push(r['version']);
  }
  const next = parsed['next'];
  if (next !== null && next !== undefined && typeof next !== 'string') {
    return { kind: 'unexpected', status, detail: 'next is neither a URL nor null' };
  }
  return {
    kind: 'page',
    page: { versions, next: typeof next === 'string' ? next : undefined },
  };
}

/** Only an https URL on AMO's own origin may be followed as a `next` page. */
export function isFollowableAmoUrl(url: string): boolean {
  try {
    return new URL(url).origin === AMO_API_ORIGIN;
  } catch {
    return false;
  }
}

function summarizeBody(body: string): string {
  const oneLine = body.replace(/\s+/g, ' ').trim();
  return oneLine.length === 0 ? 'empty body' : oneLine.slice(0, 120);
}

// ---- Soft warnings (printed, never blocking) ----------------------------------

/**
 * (a) The server's live updates.json already lists a version ≥ local: the
 * publish pipeline may be ahead of this checkout (someone else signed, or
 * this machine is behind). `fetched` is the body, or the reason it could
 * not be fetched. Returns the warning text, or undefined when all is well.
 */
export function updatesManifestWarning(
  localVersion: string,
  geckoId: string,
  publicOrigin: string,
  fetched: { ok: true; body: string } | { ok: false; reason: string },
): string | undefined {
  const where = `${publicOrigin}/ext/updates.json`;
  if (!fetched.ok) {
    return `could not read ${where} (${fetched.reason}); cannot tell whether the server is already ahead of this checkout`;
  }
  let manifest: UpdatesManifest;
  try {
    manifest = parseUpdatesManifest(fetched.body);
  } catch (err) {
    return `${where} is not a valid updates manifest (${err instanceof Error ? err.message : String(err)})`;
  }
  const published = latestVersion((manifest.addons[geckoId]?.updates ?? []).map((u) => u.version));
  if (published !== undefined && compareVersions(published, localVersion) >= 0) {
    return [
      `${where} already lists v${published} for ${geckoId}, and this checkout is at v${localVersion}.`,
      'The publish pipeline is ahead of (or level with) this checkout: another machine signed, or',
      'this one is behind — `git pull` and compare before signing.',
    ].join('\n');
  }
  return undefined;
}

export interface Provenance {
  /** `git status --porcelain` printed something. */
  dirty: boolean;
  /** HEAD is contained in at least one remote-tracking branch. */
  onRemote: boolean;
  /** Short HEAD hash for the message, when known. */
  head?: string | undefined;
}

/**
 * (b) Provenance: the original incident was a signed artifact whose source
 * was never pushed, so "what source produced this .xpi" stayed unanswerable.
 * Dirty tree or unpushed HEAD → warn, continue.
 */
export function provenanceWarnings(p: Provenance): string[] {
  const warnings: string[] = [];
  const at = p.head ? ` (${p.head})` : '';
  if (p.dirty) {
    warnings.push(
      `the working tree has uncommitted changes on top of HEAD${at}: the signed .xpi would not correspond to any commit. Commit (or stash) first so "what source produced it" stays answerable.`,
    );
  }
  if (!p.onRemote) {
    warnings.push(
      `HEAD${at} is not on any remote branch: push before signing, or the source of the published .xpi exists only on this machine.`,
    );
  }
  return warnings;
}

// ---- Rule 3: no credential ever reaches output -----------------------------------

/**
 * Remove every occurrence of the given secrets (and anything that looks like
 * a JWT) from text destined for a terminal or a log. Applied to every line
 * the runner prints, including error paths — which is where the temptation
 * to dump a response or a request lives.
 */
export function scrubSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length > 0) out = out.split(s).join('[redacted]');
  }
  // Three base64url segments joined by dots, the first decoding to a JWT header.
  return out.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
