import { resolve } from 'node:path';
import { defineConfig, type InlineConfig } from 'vite';
import { isTarget, type Target } from './src/manifest.js';

export type Entry = 'pages' | 'background' | 'content';

export interface BuildOptions {
  /** Build-time default server, exposed to the bundle as __DEFAULT_SERVER_ORIGIN__. */
  publicOrigin: string;
}

/**
 * Three vite builds per target: the extension pages (popup + options, module
 * scripts that may share chunks), a self-contained classic background script,
 * which loads as-is in both Chrome's service worker and Firefox's event page,
 * and the self-contained content script that scripting.executeScript injects
 * for region and full-page capture (M6). Output names are fixed because the
 * manifest and background reference them. Driven by scripts/build.ts.
 */
export function createConfig(target: Target, entry: Entry, opts: BuildOptions): InlineConfig {
  const pkgRoot = import.meta.dirname;
  const outDir = resolve(pkgRoot, 'dist', target);
  const common: InlineConfig = {
    configFile: false,
    root: resolve(pkgRoot, 'src'),
    base: './',
    publicDir: false,
    logLevel: 'warn',
    define: {
      __DEFAULT_SERVER_ORIGIN__: JSON.stringify(opts.publicOrigin),
      __BROWSER_TARGET__: JSON.stringify(target),
    },
  };
  if (entry === 'pages') {
    return {
      ...common,
      build: {
        outDir,
        emptyOutDir: true,
        target: 'es2022',
        modulePreload: false,
        rollupOptions: {
          input: {
            popup: resolve(pkgRoot, 'src/popup/index.html'),
            options: resolve(pkgRoot, 'src/options/index.html'),
          },
          output: {
            entryFileNames: '[name].js',
            chunkFileNames: 'chunks/[name].js',
            assetFileNames: 'assets/[name][extname]',
          },
        },
      },
    };
  }
  const script =
    entry === 'background'
      ? { file: 'src/background.ts', name: 'snappingTurtleBackground', out: 'background.js' }
      : { file: 'src/content/index.ts', name: 'snappingTurtleContent', out: 'content.js' };
  return {
    ...common,
    build: {
      outDir,
      emptyOutDir: false,
      target: 'es2022',
      lib: {
        entry: resolve(pkgRoot, script.file),
        formats: ['iife'],
        name: script.name,
        fileName: () => script.out,
      },
    },
  };
}

const target = process.env['EXTENSION_TARGET'] ?? 'chrome';
const entry = (process.env['EXTENSION_ENTRY'] ?? 'pages') as Entry;
if (!isTarget(target)) throw new Error(`unknown EXTENSION_TARGET "${target}"`);
export default defineConfig(
  createConfig(target, entry, {
    publicOrigin: process.env['PUBLIC_ORIGIN'] ?? 'https://shots.example.com',
  }),
);
