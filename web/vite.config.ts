import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Output is served by server/ under a strict CSP (default-src 'self', no
 * unsafe-inline). Vite's production build emits only external module scripts
 * and stylesheet links, which is what keeps that policy satisfiable; the test
 * in test/csp.test.ts fails the build if an inline script or style sneaks in.
 *
 * Pages: login/signup/account/reset/admin are static HTML entries the server
 * serves as-is. `src/home.ts`, `src/capture.ts` and `src/editor.ts` are
 * script-only entries: those pages are rendered by the server (the home page
 * reflects what is published and configured, the capture page carries
 * per-capture data), which locates the hashed files through the manifest.
 * `src/privacy.ts` is the same shape for the privacy policy page (E8).
 *
 * `content/` is Vite's publicDir: its files are copied into dist verbatim.
 * It holds exactly the canonical privacy policy text (content/privacy.md),
 * which the server reads from dist and renders at /privacy — one file, the
 * page and the store kit all point at it.
 */
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  appType: 'mpa',
  publicDir: 'content',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    manifest: true,
    rollupOptions: {
      input: {
        login: here('login.html'),
        signup: here('signup.html'),
        account: here('account.html'),
        reset: here('reset.html'),
        admin: here('admin.html'),
        home: here('src/home.ts'),
        capture: here('src/capture.ts'),
        editor: here('src/editor.ts'),
        privacy: here('src/privacy.ts'),
      },
    },
  },
});
