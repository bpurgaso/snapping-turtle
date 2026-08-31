import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PageAssets } from './html.js';

/**
 * Locate hashed bundle files via Vite's manifest (web/dist/.vite/manifest.json)
 * for pages the server renders itself. Missing bundle → no assets; the page
 * still renders, its buttons just degrade to select-and-copy inputs.
 */

interface ManifestChunk {
  file: string;
  css?: string[];
  isEntry?: boolean;
}

export function readEntryAssets(webDistDir: string, entry: string): PageAssets {
  const manifestPath = join(webDistDir, '.vite', 'manifest.json');
  if (!existsSync(manifestPath)) return { css: [] };
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, ManifestChunk>;
  const chunk = manifest[entry];
  if (!chunk) return { css: [] };
  return { js: `/${chunk.file}`, css: (chunk.css ?? []).map((f) => `/${f}`) };
}
