import { relative } from 'node:path';
import { isTarget } from '../src/manifest.js';
import { buildTarget } from './lib/build-target.js';
import { loadDeployEnv, resolveBuildInputs } from './lib/env.js';

/**
 * `tsx scripts/build.ts <chrome|firefox>` — a development build of one target
 * (see lib/build-target.ts). PUBLIC_ORIGIN (or https://$PUBLIC_HOST) sets the
 * build-time default server; both are read from deploy/.env when present so
 * it matches the deployment. Release builds go through scripts/release.ts,
 * which adds the dev-remnant audit.
 */
const target = process.argv[2] ?? '';
if (!isTarget(target)) {
  console.error('usage: build.ts <chrome|firefox>');
  process.exit(2);
}

loadDeployEnv();
const inputs = resolveBuildInputs();
const result = await buildTarget(target, inputs);
console.log(
  `${target}: ${result.fileCount} files → ${relative(process.cwd(), result.zipPath)} (default server ${inputs.publicOrigin})`,
);
