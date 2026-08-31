import { resolve } from 'node:path';
import { defineConfig, type InlineConfig } from 'vite';
import { isTarget, type Target } from './src/manifest.js';

export type Entry = 'pages' | 'background';

export interface BuildOptions {
  /** Build-time default server, exposed to the bundle as __DEFAULT_SERVER_ORIGIN__. */
  publicOrigin: string;
}

/**
 * Two vite builds per target: the extension pages (popup + options, module
 * scripts that may share chunks) and a self-contained classic background
 * script, which loads as-is in both Chrome's service worker and Firefox's
 * event page. Output names are fixed because the manifest references them.
 * Driven by scripts/build.ts.
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
    define: { __DEFAULT_SERVER_ORIGIN__: JSON.stringify(opts.publicOrigin) },
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
const entry = (process.env['EXTENSION_ENTRY'] ?? 'pages') as Entry;
if (!isTarget(target)) throw new Error(`unknown EXTENSION_TARGET "${target}"`);
export default defineConfig(
  createConfig(target, entry, {
    publicOrigin: process.env['PUBLIC_ORIGIN'] ?? 'https://shots.example.com',
  }),
);
