import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';
import { unzipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { TARGETS } from '../src/manifest.js';
import { buildTarget, readDistFiles, readTemplate } from './lib/build-target.js';
import { loadDeployEnv, pkgRoot, resolveBuildInputs } from './lib/env.js';
import { auditReleaseFiles, checkReleaseInputs } from './lib/release-audit.js';

/**
 * `pnpm --filter extension build:release` (M8, PLAN.md §15): production
 * builds of both targets from one version source (extension/package.json)
 * with the deployment's PUBLIC_ORIGIN baked in, then the release audit —
 * template-only manifests, no dev origins, no debug logging, no stray files,
 * zip == dist — and addons-linter over the Firefox build in self-hosted
 * mode (what AMO runs at signing time). Any problem fails the build.
 *
 * Inputs come from deploy/.env (or the environment): PUBLIC_HOST /
 * PUBLIC_ORIGIN and EXTENSION_GECKO_ID. No credentials are involved here;
 * signing is a separate, human-gated step (scripts/sign-firefox.ts).
 */
const envFile = loadDeployEnv();
const inputs = resolveBuildInputs();
const preflight = checkReleaseInputs(inputs);
if (preflight.length > 0) {
  console.error('release build refused:');
  for (const p of preflight) console.error(`  - ${p}`);
  console.error(envFile ? `(inputs read from ${envFile})` : '(no deploy/.env found)');
  process.exit(1);
}

const template = readTemplate();
const problems: string[] = [];
for (const target of TARGETS) {
  const result = await buildTarget(target, inputs);
  const files = readDistFiles(result.outDir);
  const zip = new Map(Object.entries(unzipSync(readFileSync(result.zipPath))));
  problems.push(...auditReleaseFiles({ target, files, zip, template, inputs }));
  console.log(
    `${target}: ${result.fileCount} files → ${relative(process.cwd(), result.zipPath)} (v${inputs.version}, default server ${inputs.publicOrigin})`,
  );
}

if (problems.length === 0) {
  console.log('addons-linter (self-hosted mode) over dist/firefox:');
  try {
    execFileSync(
      process.execPath,
      [
        `${pkgRoot}/node_modules/web-ext/bin/web-ext.js`,
        'lint',
        '--source-dir',
        `${pkgRoot}/dist/firefox`,
        '--self-hosted',
        '--warnings-as-errors',
        '--no-config-discovery',
      ],
      { stdio: 'inherit' },
    );
  } catch {
    problems.push('firefox: addons-linter reported errors or warnings (see above)');
  }
}

if (problems.length > 0) {
  console.error('\nrelease audit FAILED:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  '\nrelease audit OK: both artifacts are template-built, origin-baked and free of dev remnants',
);
