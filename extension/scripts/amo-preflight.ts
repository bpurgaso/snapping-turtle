import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import type { BuildInputs } from './lib/env.js';
import { loadDeployEnv, repoRoot, resolveBuildInputs } from './lib/env.js';
import {
  AMO_MAX_PAGES,
  amoJwt,
  amoVersionsUrl,
  confirmationAccepted,
  decidePreflight,
  FLAG_FIRST_SIGNING,
  FLAG_SKIP,
  interpretAmoResponse,
  isFollowableAmoUrl,
  parsePreflightFlags,
  provenanceWarnings,
  scrubSecrets,
  updatesManifestWarning,
  type AmoResult,
  type PreflightDecision,
  type Provenance,
} from './lib/amo-preflight.js';
import { checkReleaseInputs } from './lib/release-audit.js';

/**
 * `pnpm --filter extension version:check` (E10, PLAN.md §15), and the first
 * step of `sign:firefox`: before anything is uploaded, compare the local
 * version (extension/package.json, never a built manifest) with what AMO
 * has actually published under EXTENSION_GECKO_ID, and refuse unless the
 * local version is strictly greater. The decision itself is the pure
 * `decidePreflight` in lib/amo-preflight.ts; this file is the I/O around it:
 * the AMO query, the two soft warnings, the interactive confirmation.
 *
 *   --first-signing            a 404 from AMO is the genuine first signing
 *                              under this id (otherwise a 404 asks on a TTY
 *                              and refuses without one)
 *   --skip-version-preflight   do not query AMO at all; loud, for genuine
 *                              AMO API weirdness only
 *
 * Exit status 0 = ok to upload, 1 = refused. Credentials come from
 * WEB_EXT_API_KEY / WEB_EXT_API_SECRET in the environment, like web-ext;
 * they and the JWT minted from them are scrubbed from every printed line
 * (CLAUDE.md rule 3), including on failures.
 */

export interface PreflightRunOptions {
  inputs: BuildInputs & { geckoId: string };
  argv: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** Ask on the terminal when a 404 needs a human; false for version:check. */
  interactive: boolean;
  /** Prefix for every printed line (the calling command's name). */
  label: string;
}

/** Resolves when uploading is allowed; exits the process with status 1 when it is not. */
export async function runAmoPreflight(opts: PreflightRunOptions): Promise<void> {
  const env = opts.env ?? process.env;
  const apiKey = env['WEB_EXT_API_KEY'];
  const apiSecret = env['WEB_EXT_API_SECRET'];
  const secrets: (string | undefined)[] = [apiKey, apiSecret];
  const say = (line: string, stream: 'out' | 'err' = 'out'): void => {
    const text = scrubSecrets(
      `${opts.label}: ${line.replace(/\n/g, `\n${opts.label}: `)}`,
      secrets,
    );
    if (stream === 'out') console.log(text);
    else console.error(text);
  };
  const { version, geckoId, publicOrigin } = opts.inputs;
  const flags = parsePreflightFlags(opts.argv);

  say(`local version v${version} (extension/package.json), add-on id ${geckoId}`);

  // Soft warnings first, so they are on screen before any verdict or prompt.
  const updatesWarning = updatesManifestWarning(
    version,
    geckoId,
    publicOrigin,
    await fetchText(`${publicOrigin}/ext/updates.json`),
  );
  if (updatesWarning) say(`warning: ${updatesWarning}`, 'err');
  for (const w of provenanceWarnings(gitProvenance())) say(`warning: ${w}`, 'err');

  let amoResult: AmoResult | undefined;
  if (!flags.skipVersionPreflight) {
    if (!apiKey || !apiSecret) {
      say(
        'WEB_EXT_API_KEY and WEB_EXT_API_SECRET are not set.\n' +
          'Issue a key pair at https://addons.mozilla.org/developers/addon/api/key/ (an AMO developer\n' +
          'account is required), export both variables in this shell only — never put them in\n' +
          'deploy/.env or any file — and run again. See extension/STORE_SUBMISSION.md.',
        'err',
      );
      process.exit(1);
    }
    say(`asking AMO for the versions published under ${geckoId}…`);
    amoResult = await queryAmoVersions(geckoId, () => amoJwt(apiKey, apiSecret), secrets);
  }

  const tty = opts.interactive && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let decision = decidePreflight({ localVersion: version, geckoId, amoResult, flags, tty });

  if (decision.action === 'confirm') {
    say(decision.message, 'err');
    decision = await askForConfirmation(geckoId, say);
  }

  if (decision.action === 'refuse') {
    say(`refused — ${decision.message}`, 'err');
    process.exit(1);
  }
  say(decision.message, flags.skipVersionPreflight ? 'err' : 'out');
}

async function askForConfirmation(
  geckoId: string,
  say: (line: string, stream?: 'out' | 'err') => void,
): Promise<PreflightDecision> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    say(
      `To proceed as the FIRST signing under this id, type the add-on id exactly (${geckoId}); anything else aborts.`,
      'err',
    );
    const answer = await rl.question('add-on id> ');
    return confirmationAccepted(answer, geckoId)
      ? {
          action: 'proceed',
          message: `confirmed on the terminal: proceeding as the first signing of ${geckoId}. (${FLAG_FIRST_SIGNING} does the same non-interactively.)`,
        }
      : {
          action: 'refuse',
          message: `the answer did not match ${geckoId}; nothing uploaded. Compare the id in the Developer Hub with deploy/.env, then re-run.`,
        };
  } finally {
    rl.close();
  }
}

/** Walk the versions list (every channel) page by page into one AmoResult. */
async function queryAmoVersions(
  geckoId: string,
  mintJwt: () => string,
  secrets: readonly (string | undefined)[],
): Promise<AmoResult> {
  const versions: string[] = [];
  let url: string | undefined = amoVersionsUrl(geckoId);
  for (let page = 0; url !== undefined; page++) {
    if (page >= AMO_MAX_PAGES) {
      return {
        kind: 'unexpected',
        status: undefined,
        detail: `more than ${AMO_MAX_PAGES} pages of versions`,
      };
    }
    if (!isFollowableAmoUrl(url)) {
      return {
        kind: 'unexpected',
        status: undefined,
        detail: 'next page is not on addons.mozilla.org',
      };
    }
    let res: Response;
    try {
      // A fresh token per request: 60 s TTL, and AMO rejects a reused jti.
      res = await fetch(url, {
        headers: { Authorization: `JWT ${mintJwt()}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      return { kind: 'network', reason: scrubSecrets(networkReason(err), secrets) };
    }
    const body = await res.text().catch(() => '');
    const interpreted = interpretAmoResponse(res.status, body);
    if (interpreted.kind !== 'page') return interpreted;
    versions.push(...interpreted.page.versions);
    url = interpreted.page.next;
  }
  return { kind: 'versions', versions };
}

/** A short, header-free description of why a fetch threw (DNS, TLS, refused, timeout). */
function networkReason(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    if (cause instanceof Error) {
      const code = (cause as Error & { code?: unknown }).code;
      return typeof code === 'string' ? code : cause.message;
    }
    if (err.name === 'TimeoutError') return 'timed out after 20 s';
    return err.message;
  }
  return 'unknown error';
}

async function fetchText(
  url: string,
): Promise<{ ok: true; body: string } | { ok: false; reason: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    return { ok: true, body: await res.text() };
  } catch (err) {
    return { ok: false, reason: networkReason(err) };
  }
}

function gitProvenance(): Provenance {
  const git = (...args: string[]): string =>
    execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  try {
    const head = git('rev-parse', '--short', 'HEAD');
    const dirty = git('status', '--porcelain').length > 0;
    const onRemote = git('branch', '-r', '--contains', 'HEAD').length > 0;
    return { dirty, onRemote, head };
  } catch {
    // Not a git checkout (an exported tree): nothing to vouch for the source either way.
    return { dirty: true, onRemote: false };
  }
}

// ---- standalone: pnpm --filter extension version:check ----------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadDeployEnv();
  const inputs = resolveBuildInputs();
  const problems = checkReleaseInputs(inputs);
  if (problems.length > 0 || !inputs.geckoId) {
    console.error(`version:check: release inputs invalid:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  await runAmoPreflight({
    inputs: { ...inputs, geckoId: inputs.geckoId },
    argv: process.argv.slice(2),
    interactive: false,
    label: 'version:check',
  });
  console.log(
    `version:check: ok — sign:firefox would upload v${inputs.version}${
      parsePreflightFlags(process.argv.slice(2)).firstSigning ? ` (with ${FLAG_FIRST_SIGNING})` : ''
    }${parsePreflightFlags(process.argv.slice(2)).skipVersionPreflight ? ` (with ${FLAG_SKIP})` : ''}`,
  );
}
