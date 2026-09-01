import { resolve } from 'node:path';
import { build } from 'vite';

export const harnessDir = resolve(import.meta.dirname, '../../dist/test-harness');
export const harnessPath = resolve(harnessDir, 'harness.js');

/** Playwright globalSetup: bundle harness.ts (IIFE, global `__stHarness`). */
export default async function buildHarness(): Promise<void> {
  await build({
    configFile: false,
    root: resolve(import.meta.dirname),
    logLevel: 'warn',
    build: {
      outDir: harnessDir,
      emptyOutDir: true,
      target: 'es2022',
      minify: false,
      lib: {
        entry: resolve(import.meta.dirname, 'harness.ts'),
        formats: ['iife'],
        name: '__stHarness',
        fileName: () => 'harness.js',
      },
    },
  });
}
