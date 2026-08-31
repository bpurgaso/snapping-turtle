import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Output is served by server/ under a strict CSP (default-src 'self', no
 * unsafe-inline). Vite's production build emits only external module scripts
 * and stylesheet links, which is what keeps that policy satisfiable; the test
 * in test/csp.test.ts fails the build if an inline script or style sneaks in.
 *
 * Pages: index/login/signup/account are static HTML entries the server serves
 * as-is. `src/capture.ts` is a script-only entry: the capture page itself is
 * rendered by the server (it carries per-capture data), which locates the
 * hashed files through the manifest.
 */
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  appType: 'mpa',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    manifest: true,
    rollupOptions: {
      input: {
        index: here('index.html'),
        login: here('login.html'),
        signup: here('signup.html'),
        account: here('account.html'),
        capture: here('src/capture.ts'),
        editor: here('src/editor.ts'),
      },
    },
  },
});
