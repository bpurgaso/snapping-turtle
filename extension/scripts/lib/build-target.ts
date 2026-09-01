import { cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { zipSync, type Zippable } from 'fflate';
import { build } from 'vite';
import { buildManifest, type ManifestTemplate, type Target } from '../../src/manifest.js';
import { createConfig } from '../../vite.config.js';
import { pkgRoot, type BuildInputs } from './env.js';

/**
 * One target build (PLAN.md §15):
 *   1. vite build (popup + options pages, then the self-contained background
 *      and content scripts) → dist/<target>/
 *   2. copy icons/ and write dist/<target>/manifest.json from the template
 *   3. zip dist/<target>/ → dist/snapping-turtle-<target>-<version>.zip
 */
export interface BuildResult {
  target: Target;
  outDir: string;
  zipPath: string;
  fileCount: number;
}

export function readTemplate(): ManifestTemplate {
  return JSON.parse(
    readFileSync(join(pkgRoot, 'manifest.template.json'), 'utf8'),
  ) as ManifestTemplate;
}

export async function buildTarget(target: Target, inputs: BuildInputs): Promise<BuildResult> {
  const { publicOrigin, version } = inputs;
  const outDir = join(pkgRoot, 'dist', target);
  await build(createConfig(target, 'pages', { publicOrigin }));
  await build(createConfig(target, 'background', { publicOrigin }));
  await build(createConfig(target, 'content', { publicOrigin }));
  cpSync(join(pkgRoot, 'icons'), join(outDir, 'icons'), { recursive: true });

  const manifest = buildManifest(target, {
    template: readTemplate(),
    version,
    publicOrigin,
    ...(inputs.geckoId ? { geckoId: inputs.geckoId } : {}),
  });
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const files = readDistFiles(outDir);
  const zippable: Zippable = {};
  for (const [name, bytes] of files) zippable[name] = bytes;
  const zipPath = join(pkgRoot, 'dist', `snapping-turtle-${target}-${version}.zip`);
  writeFileSync(zipPath, zipSync(zippable, { level: 9 }));
  return { target, outDir, zipPath, fileCount: files.size };
}

/** Every file under a built target directory, keyed by zip-style relative path. */
export function readDistFiles(outDir: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const file of walk(outDir)) {
    files.set(relative(outDir, file).split('\\').join('/'), readFileSync(file));
  }
  return files;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
