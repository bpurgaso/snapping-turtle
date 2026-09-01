import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { EXT_UPDATES_MANIFEST, firefoxXpiFilename } from '@snapping-turtle/shared';
import { MIN_FIREFOX, type Manifest } from '../src/manifest.js';
import { loadDeployEnv, pkgRoot, repoRoot, resolveBuildInputs } from './lib/env.js';
import { parseUpdatesManifest, updateLinkFor, upsertUpdate } from './lib/firefox-updates.js';
import { checkReleaseInputs } from './lib/release-audit.js';

/**
 * `pnpm --filter extension sign:firefox` (M8, PLAN.md §15 — self-distributed
 * Firefox build):
 *
 *   1. submit dist/firefox (from build:release) to AMO for signing on the
 *      unlisted channel with web-ext, using the API credentials from the
 *      environment — WEB_EXT_API_KEY / WEB_EXT_API_SECRET, issued at
 *      https://addons.mozilla.org/developers/addon/api/key/ — which are
 *      never written to disk, printed or committed (CLAUDE.md rule 12);
 *   2. copy the signed .xpi into the publish directory the app serves under
 *      /ext/ (EXT_PUBLISH_DIR, default deploy/ext — the compose bind mount)
 *      and upsert this version into its updates.json with the file's sha256.
 *
 *   --xpi <path>   skip step 1 and publish an .xpi already signed by AMO
 *                  (downloaded from the developer hub, for instance).
 */
const args = process.argv.slice(2);
const xpiFlag = args.indexOf('--xpi');
const presigned = xpiFlag >= 0 ? args[xpiFlag + 1] : undefined;
if (xpiFlag >= 0 && !presigned) fail('--xpi needs a path');

loadDeployEnv();
const inputs = resolveBuildInputs();
const preflight = checkReleaseInputs(inputs);
if (preflight.length > 0) fail(`release inputs invalid:\n  - ${preflight.join('\n  - ')}`);
const geckoId = inputs.geckoId!;

const sourceDir = join(pkgRoot, 'dist', 'firefox');
const manifestPath = join(sourceDir, 'manifest.json');
if (!existsSync(manifestPath))
  fail('dist/firefox is not built — run `pnpm --filter extension build:release` first');
const built = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
const gecko = built.browser_specific_settings?.gecko;
if (built.version !== inputs.version || gecko?.id !== geckoId) {
  fail(
    `dist/firefox was built for v${built.version} / ${gecko?.id ?? 'no id'}, but the release inputs are v${inputs.version} / ${geckoId} — re-run build:release`,
  );
}

const artifactsDir = join(pkgRoot, 'dist', 'signed');
let xpiPath: string;
if (presigned) {
  // pnpm runs scripts with cwd = the package dir; resolve a relative path
  // against where the user actually typed the command (pnpm sets INIT_CWD).
  xpiPath = resolve(process.env['INIT_CWD'] ?? process.cwd(), presigned);
  if (!existsSync(xpiPath)) fail(`${xpiPath} does not exist`);
} else {
  if (!process.env['WEB_EXT_API_KEY'] || !process.env['WEB_EXT_API_SECRET']) {
    fail(
      'WEB_EXT_API_KEY and WEB_EXT_API_SECRET are not set.\n' +
        '  Issue a key pair at https://addons.mozilla.org/developers/addon/api/key/ (an AMO developer\n' +
        '  account is required), export both variables in this shell only — never put them in\n' +
        '  deploy/.env or any file — and run again. See extension/STORE_SUBMISSION.md.',
    );
  }
  mkdirSync(artifactsDir, { recursive: true });
  const before = new Set(listXpis(artifactsDir));
  console.log(
    `signing dist/firefox (v${inputs.version}, ${geckoId}) on the unlisted channel via AMO…`,
  );
  // web-ext reads the credentials from the WEB_EXT_* environment itself, so
  // they never appear in argv (visible to `ps`) or in this script's output.
  execFileSync(
    process.execPath,
    [
      join(pkgRoot, 'node_modules', 'web-ext', 'bin', 'web-ext.js'),
      'sign',
      '--source-dir',
      sourceDir,
      '--artifacts-dir',
      artifactsDir,
      '--channel',
      'unlisted',
      '--no-config-discovery',
    ],
    { stdio: 'inherit' },
  );
  const produced = listXpis(artifactsDir).filter((f) => !before.has(f));
  if (produced.length !== 1) {
    fail(`expected exactly one new .xpi in ${artifactsDir}, found ${produced.length}`);
  }
  xpiPath = join(artifactsDir, produced[0]!);
}

const bytes = readFileSync(xpiPath);
const sha256Hex = createHash('sha256').update(bytes).digest('hex');
const publishDir = resolve(process.env['EXT_PUBLISH_DIR'] ?? join(repoRoot, 'deploy', 'ext'));
mkdirSync(publishDir, { recursive: true });
const publishedXpi = join(publishDir, firefoxXpiFilename(inputs.version));
copyFileSync(xpiPath, publishedXpi);

const updatesPath = join(publishDir, EXT_UPDATES_MANIFEST);
const existing = existsSync(updatesPath)
  ? parseUpdatesManifest(readFileSync(updatesPath, 'utf8'))
  : undefined;
const updates = upsertUpdate(existing, {
  id: geckoId,
  version: inputs.version,
  publicOrigin: inputs.publicOrigin,
  sha256Hex,
  strictMinVersion: gecko?.strict_min_version ?? MIN_FIREFOX,
});
writeFileSync(updatesPath, JSON.stringify(updates, null, 2) + '\n');

console.log(
  `published ${relative(process.cwd(), publishedXpi)} (sha256 ${sha256Hex.slice(0, 16)}…)`,
);
console.log(
  `updated   ${relative(process.cwd(), updatesPath)} → ${updateLinkFor(inputs.publicOrigin, inputs.version)}`,
);
console.log(
  `next: make sure the app serves ${publishDir} at ${inputs.publicOrigin}/ext/ (compose mounts deploy/ext there), then\n` +
    `      curl -sS ${inputs.publicOrigin}/ext/${EXT_UPDATES_MANIFEST} | grep ${inputs.version}`,
);

function listXpis(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.xpi') && statSync(join(dir, f)).isFile())
    .sort();
}

function fail(message: string): never {
  console.error(`sign:firefox: ${message}`);
  process.exit(1);
}
