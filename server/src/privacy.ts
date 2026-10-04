import { PRIVACY_PATH } from '@snapping-turtle/shared';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import { renderMarkdown } from './markdown.js';

/**
 * The privacy policy page (E8, PLAN.md §8): one canonical text,
 * web/content/privacy.md, that the web build copies verbatim into web/dist
 * (Vite `publicDir`) and the server renders at GET /privacy. The store
 * listings point at that URL and extension/STORE_SUBMISSION.md references
 * the file rather than repeating it; server/test/unit/privacy-page.test.ts
 * holds the three in step.
 *
 * It is an ordinary public page, not a secret one: the route opts out of
 * the noindex directive and the no-store default (route config `indexable`,
 * server/src/app.ts), and nothing under /s/* or /reset/* ever does.
 */
export { PRIVACY_PATH };
/** The copy of web/content/privacy.md inside web/dist, as the web build emits it. */
export const PRIVACY_CONTENT_FILE = 'privacy.md';
/** The Vite entry whose stylesheet the page links (web/src/privacy.ts). */
export const PRIVACY_ASSET_ENTRY = 'src/privacy.ts';
/** Public caching, like /ext/: the text changes with a deploy, never per request. */
export const PRIVACY_CACHE_CONTROL = 'public, max-age=300';

/**
 * Rendered policy body, or undefined when the web bundle is not built. Cached
 * once in production (an unsupported construct then fails the boot, loudly);
 * re-read per request in development so edits show up.
 */
export function privacyBodyLoader(config: Config): () => string | undefined {
  const path = join(config.webDistDir, PRIVACY_CONTENT_FILE);
  const read = () => (existsSync(path) ? renderMarkdown(readFileSync(path, 'utf8')) : undefined);
  if (config.nodeEnv !== 'production') return read;
  const cached = read();
  return () => cached;
}
