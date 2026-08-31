import { cpSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, type Zippable } from 'fflate';
import { build } from 'vite';
import { buildManifest, isTarget, type ManifestTemplate } from '../src/manifest.js';
import { createConfig } from '../vite.config.js';

/**
 * `tsx scripts/build.ts <chrome|firefox>`:
 *   1. vite build (popup + options pages, then self-contained background) → dist/<target>/
 *   2. copy icons/ and write dist/<target>/manifest.json from the template
 *   3. zip dist/<target>/ → dist/snapping-turtle-<target>-<version>.zip
 *
 * PUBLIC_ORIGIN (or https://$PUBLIC_HOST) sets the build-time default server;
 * both are read from deploy/.env when present so it matches the deployment.
 */
const target = process.argv[2] ?? '';
if (!isTarget(target)) {
  console.error('usage: build.ts <chrome|firefox>');
  process.exit(2);
}

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = resolve(pkgRoot, '..');
for (const envFile of [process.env['ENV_FILE'], join(repoRoot, 'deploy', '.env')]) {
  if (envFile && statSafe(envFile)) {
    process.loadEnvFile(envFile);
    break;
  }
}

const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as { version: string };
const template = JSON.parse(
  readFileSync(join(pkgRoot, 'manifest.template.json'), 'utf8'),
) as ManifestTemplate;
const publicOrigin =
  process.env['PUBLIC_ORIGIN'] ??
  (process.env['PUBLIC_HOST']
    ? `https://${process.env['PUBLIC_HOST']}`
    : 'https://shots.example.com');

const outDir = join(pkgRoot, 'dist', target);
await build(createConfig(target, 'pages', { publicOrigin }));
await build(createConfig(target, 'background', { publicOrigin }));
cpSync(join(pkgRoot, 'icons'), join(outDir, 'icons'), { recursive: true });

const manifest = buildManifest(target, {
  template,
  version: pkg.version,
  publicOrigin,
  ...(process.env['EXTENSION_GECKO_ID'] ? { geckoId: process.env['EXTENSION_GECKO_ID'] } : {}),
});
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

const files: Zippable = {};
for (const file of walk(outDir)) {
  files[relative(outDir, file).split('\\').join('/')] = readFileSync(file);
}
const zipPath = join(pkgRoot, 'dist', `snapping-turtle-${target}-${pkg.version}.zip`);
writeFileSync(zipPath, zipSync(files, { level: 9 }));
console.log(
  `${target}: ${Object.keys(files).length} files → ${relative(process.cwd(), zipPath)} (default server ${publicOrigin})`,
);

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function statSafe(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
