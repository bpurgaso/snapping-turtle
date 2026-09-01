/**
 * Test harness bundled by build-harness.ts into dist/test-harness/harness.js
 * and injected into plain fixture pages (no extension APIs, no polyfill), so
 * Playwright can drive the overlay and page driver exactly as the content
 * script does. Exposed as the `__stHarness` global.
 */
export {
  afterRepaint,
  OVERLAY_TAG,
  OVERLAY_Z_INDEX,
  selectRegion,
} from '../../src/content/region-overlay.js';
export {
  findFixedElements,
  hideElements,
  measurePage,
  PageDriver,
  scrollToInstant,
  withPageDriver,
} from '../../src/content/page-driver.js';
