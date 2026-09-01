import { buildManifest, type ManifestTemplate, type Target } from '../../src/manifest.js';
import { PLACEHOLDER_ORIGIN, type BuildInputs } from './env.js';

/**
 * Release-build audit (M8, PLAN.md §15): what a store submission or a signed
 * .xpi must never contain. Pure — operates on the file map of a built target
 * so the unit tests can feed it synthetic bundles. Every rule returns a
 * human-readable problem; an empty list means the build is clean.
 *
 * The one deliberate allowance: the options page tells users that plain http
 * is accepted for localhost / 127.0.0.1 (PLAN.md §15), so those loopback
 * names may appear in options.js — and nowhere else. `http://` is forbidden
 * everywhere: a release bakes an https origin and nothing may fall back.
 */

const TEXT_FILE = /\.(js|html|css|json)$/;
const FORBIDDEN_FILE =
  /(^|\/)(\.[^/]*|.*\.(map|ts|md|log|zip|xpi|env))$|(^|\/)(test|tests|node_modules|fixtures)\//;
const DEBUG_LOGGING = /\bconsole\.(log|debug|info|trace)\s*\(|\bdebugger\b/;
const SOURCE_MAP = /sourceMappingURL/;
const PLAIN_HTTP = /\bhttp:\/\//;
const LOOPBACK = /\blocalhost\b|127\.0\.0\.1|\[::1\]|0\.0\.0\.0/;
const PLACEHOLDER_HOST = /example\.(com|org|net)\b|\.invalid\b/;
const NODE_ENV_LEAK = /\bprocess\.env\b/;
const LOOPBACK_ALLOWED_FILE = 'options.js';

export interface AuditOptions {
  target: Target;
  /** dist/<target> contents, keyed by zip-style relative path. */
  files: ReadonlyMap<string, Uint8Array>;
  /** The zip's entries, when checking that it is exactly the dist directory. */
  zip?: ReadonlyMap<string, Uint8Array>;
  template: ManifestTemplate;
  inputs: BuildInputs;
}

/** Release preconditions on the inputs themselves, before anything is built. */
export function checkReleaseInputs(inputs: BuildInputs): string[] {
  const problems: string[] = [];
  let url: URL | undefined;
  try {
    url = new URL(inputs.publicOrigin);
  } catch {
    problems.push(`PUBLIC_ORIGIN "${inputs.publicOrigin}" is not a URL`);
  }
  if (url) {
    if (url.protocol !== 'https:') {
      problems.push(`PUBLIC_ORIGIN must be https for a release build, got ${inputs.publicOrigin}`);
    }
    if (LOOPBACK.test(url.hostname)) {
      problems.push(`PUBLIC_ORIGIN must not be a loopback host in a release build`);
    }
    if (inputs.publicOrigin === PLACEHOLDER_ORIGIN || PLACEHOLDER_HOST.test(url.hostname)) {
      problems.push(
        `PUBLIC_ORIGIN resolved to the placeholder ${inputs.publicOrigin} — set PUBLIC_HOST (or PUBLIC_ORIGIN) to the real deployment in deploy/.env`,
      );
    }
  }
  if (!inputs.geckoId) {
    problems.push(
      'EXTENSION_GECKO_ID is not set. AMO ties every signature to this id forever, so a release must pin it explicitly (e.g. snapping-turtle@<your-domain>) in deploy/.env and never change it — a hostname-derived default would change with a domain migration',
    );
  } else if (!/^([A-Za-z0-9._-]+@[A-Za-z0-9._-]+|\{[0-9a-fA-F-]{36}\})$/.test(inputs.geckoId)) {
    problems.push(`EXTENSION_GECKO_ID "${inputs.geckoId}" is neither name@host nor a {GUID}`);
  }
  return problems;
}

export function auditReleaseFiles(opts: AuditOptions): string[] {
  const { target, files, template, inputs } = opts;
  const problems: string[] = [];
  const decoder = new TextDecoder();

  // 1. Manifest: generated from the template with this release's inputs, byte-for-byte.
  const manifestBytes = files.get('manifest.json');
  if (!manifestBytes) {
    problems.push(`${target}: manifest.json missing`);
  } else {
    const expected = buildManifest(target, {
      template,
      version: inputs.version,
      publicOrigin: inputs.publicOrigin,
      ...(inputs.geckoId ? { geckoId: inputs.geckoId } : {}),
    });
    let actual: unknown;
    try {
      actual = JSON.parse(decoder.decode(manifestBytes));
    } catch {
      problems.push(`${target}: manifest.json is not valid JSON`);
    }
    if (actual !== undefined && JSON.stringify(actual) !== JSON.stringify(expected)) {
      problems.push(
        `${target}: manifest.json differs from the template-generated manifest for version ${inputs.version} / ${inputs.publicOrigin} (hand-edited output, stale build, or different inputs)`,
      );
    }
  }

  // 2. Files that never belong in a shipped extension.
  for (const name of files.keys()) {
    if (FORBIDDEN_FILE.test(name)) problems.push(`${target}: ${name} must not ship in a release`);
  }

  // 3. Text content rules.
  let originBaked = false;
  for (const [name, bytes] of files) {
    if (!TEXT_FILE.test(name)) continue;
    const text = decoder.decode(bytes);
    const base = name.split('/').pop() ?? name;
    if (name.endsWith('.js') && text.includes(inputs.publicOrigin)) originBaked = true;
    if (DEBUG_LOGGING.test(text)) problems.push(`${target}: ${name} contains debug logging`);
    if (SOURCE_MAP.test(text)) problems.push(`${target}: ${name} references a source map`);
    if (PLAIN_HTTP.test(text)) problems.push(`${target}: ${name} contains a plain http:// URL`);
    if (LOOPBACK.test(text) && base !== LOOPBACK_ALLOWED_FILE) {
      problems.push(
        `${target}: ${name} names a loopback host (only ${LOOPBACK_ALLOWED_FILE}'s validation copy may)`,
      );
    }
    if (PLACEHOLDER_HOST.test(text)) problems.push(`${target}: ${name} contains a placeholder host`);
    if (NODE_ENV_LEAK.test(text)) problems.push(`${target}: ${name} references process.env`);
  }
  if (!originBaked) {
    problems.push(`${target}: no bundle contains the default server ${inputs.publicOrigin}`);
  }

  // 4. The zip is the dist directory, exactly.
  if (opts.zip) {
    const distNames = [...files.keys()].sort();
    const zipNames = [...opts.zip.keys()].sort();
    if (JSON.stringify(distNames) !== JSON.stringify(zipNames)) {
      problems.push(`${target}: zip entries differ from dist/${target}`);
    } else {
      for (const [name, bytes] of files) {
        if (!bytesEqual(bytes, opts.zip.get(name)!)) {
          problems.push(`${target}: zip entry ${name} differs from dist/${target}/${name}`);
        }
      }
    }
  }
  return problems;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}
