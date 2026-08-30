import { defineConfig } from 'vite';

/**
 * Output is served by server/ under a strict CSP (default-src 'self', no
 * unsafe-inline). Vite's production build emits only external module scripts
 * and stylesheet links, which is what keeps that policy satisfiable; the test
 * in test/csp.test.ts fails the build if an inline script or style sneaks in.
 */
export default defineConfig({
  appType: 'mpa',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
});
