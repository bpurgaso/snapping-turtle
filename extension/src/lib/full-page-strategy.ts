/**
 * Which full-page strategy runs (PLAN.md §15, revised 2026-09-07).
 *
 * Firefox's `tabs.captureTab({ rect })` captures the whole document in one
 * call, but Firefox exposes the function only to extensions whose manifest
 * declares `<all_urls>`: its schema (`browser/components/extensions/schemas/
 * tabs.json`) gates `captureTab` on exactly that permission, while
 * `captureVisibleTab` also accepts `activeTab`. Measured on Firefox 154
 * (`docs/firefox-capturetab-probe.md`, "Permissions"): with `activeTab` the
 * property is undefined before and after a real toolbar gesture, and it stays
 * undefined after a runtime grant of `<all_urls>` or `https://*` — only a
 * manifest-declared `<all_urls>` makes it a function. The shipped manifest
 * deliberately never carries `<all_urls>` (lib/api-requirements.ts), so on
 * Firefox the function is absent and both browsers scroll-and-stitch through
 * lib/stitch.ts, whose APIs (`scripting`, `captureVisibleTab`, the tile
 * geometry) are the same on both.
 *
 * The choice is made at runtime from what the browser actually exposes, never
 * from the build target: a Firefox that has the API takes the native path, one
 * that lacks it stitches instead of failing with "captureTab is not a
 * function" — which is what the 0.1.0 Firefox build did.
 */
export type FullPageStrategy = 'native' | 'stitch';

/** `tabs` is the browser's `tabs` namespace; anything else stitches. */
export function chooseFullPageStrategy(tabs: unknown): FullPageStrategy {
  if (!tabs || typeof tabs !== 'object') return 'stitch';
  return typeof (tabs as { captureTab?: unknown }).captureTab === 'function' ? 'native' : 'stitch';
}
