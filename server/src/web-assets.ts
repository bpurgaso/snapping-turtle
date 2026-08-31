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
  imports?: string[];
  isEntry?: boolean;
}

export function readEntryAssets(webDistDir: string, entry: string): PageAssets {
  const manifestPath = join(webDistDir, '.vite', 'manifest.json');
  if (!existsSync(manifestPath)) return { css: [] };
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, ManifestChunk>;
  const chunk = manifest[entry];
  if (!chunk) return { css: [] };
  // CSS imported through shared chunks (e.g. capture.css used by both the
  // view and editor entries) is attributed to the shared chunk, not the
  // entry — collect transitively so no stylesheet is dropped.
  const css: string[] = [];
  const seen = new Set<string>();
  const visit = (key: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    const c = manifest[key];
    if (!c) return;
    for (const imported of c.imports ?? []) visit(imported);
    for (const f of c.css ?? []) if (!css.includes(f)) css.push(f);
  };
  visit(entry);
  return { js: `/${chunk.file}`, css: css.map((f) => `/${f}`) };
}
