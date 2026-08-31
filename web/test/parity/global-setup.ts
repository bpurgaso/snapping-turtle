import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Bundle the browser half of the parity harness (harness/main.ts → one IIFE)
 * so the spec can inject it into about:blank with addScriptTag. Built into
 * test-results/, which is git-ignored; the shipped web bundle is untouched.
 */
export default async function globalSetup(): Promise<void> {
  await build({
    configFile: false,
    root: here('../..'),
    logLevel: 'warn',
    build: {
      outDir: here('../../test-results/parity-harness'),
      emptyOutDir: true,
      sourcemap: false,
      lib: {
        entry: here('harness/main.ts'),
        formats: ['iife'],
        name: 'parityHarness',
        fileName: () => 'harness.js',
      },
    },
  });
}
