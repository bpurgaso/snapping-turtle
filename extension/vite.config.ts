import { resolve } from 'node:path';
import { defineConfig, type InlineConfig } from 'vite';
import { isTarget, type Target } from './src/manifest.js';

export type Entry = 'popup' | 'background';

/**
 * One self-contained bundle per entry (no shared chunks), so the background
 * script loads as a plain classic script in both Chrome's service worker and
 * Firefox's event page, and the popup as a normal module page. Output names
 * are fixed because the manifest references them. Driven by scripts/build.ts.
 */
export function createConfig(target: Target, entry: Entry): InlineConfig {
  const pkgRoot = import.meta.dirname;
  const outDir = resolve(pkgRoot, 'dist', target);
  const common: InlineConfig = {
    configFile: false,
    root: resolve(pkgRoot, 'src'),
    base: './',
    publicDir: false,
    logLevel: 'warn',
  };
  if (entry === 'popup') {
    return {
      ...common,
      build: {
        outDir,
        emptyOutDir: true,
        target: 'es2022',
        modulePreload: false,
        rollupOptions: {
          input: resolve(pkgRoot, 'src/popup/index.html'),
          output: {
            entryFileNames: 'popup.js',
            chunkFileNames: 'chunks/[name].js',
            assetFileNames: 'assets/[name][extname]',
            inlineDynamicImports: true,
          },
        },
      },
    };
  }
  return {
    ...common,
    build: {
      outDir,
      emptyOutDir: false,
      target: 'es2022',
      lib: {
        entry: resolve(pkgRoot, 'src/background.ts'),
        formats: ['iife'],
        name: 'snappingTurtleBackground',
        fileName: () => 'background.js',
      },
    },
  };
}

const target = process.env['EXTENSION_TARGET'] ?? 'chrome';
const entry = (process.env['EXTENSION_ENTRY'] ?? 'popup') as Entry;
if (!isTarget(target)) throw new Error(`unknown EXTENSION_TARGET "${target}"`);
export default defineConfig(createConfig(target, entry));
