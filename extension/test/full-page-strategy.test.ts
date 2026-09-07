import { describe, expect, it } from 'vitest';
import { chooseFullPageStrategy } from '../src/lib/full-page-strategy.js';

/**
 * The full-page branch is a runtime feature check on the browser's `tabs`
 * namespace, not a build-target switch: Firefox without `<all_urls>` has no
 * `captureTab` (docs/firefox-capturetab-probe.md) and must stitch, never throw.
 */
describe('chooseFullPageStrategy', () => {
  it('takes the native path only when captureTab is a function', () => {
    expect(chooseFullPageStrategy({ captureTab: () => Promise.resolve('data:') })).toBe('native');
  });

  it('stitches when captureTab is missing — Firefox with activeTab, and every Chrome', () => {
    expect(chooseFullPageStrategy({ captureVisibleTab: () => Promise.resolve('data:') })).toBe(
      'stitch',
    );
    expect(chooseFullPageStrategy({ captureTab: undefined })).toBe('stitch');
  });

  it('stitches when captureTab is present but not callable, or tabs is not an object', () => {
    expect(chooseFullPageStrategy({ captureTab: true })).toBe('stitch');
    expect(chooseFullPageStrategy({ captureTab: 'yes' })).toBe('stitch');
    expect(chooseFullPageStrategy(undefined)).toBe('stitch');
    expect(chooseFullPageStrategy(null)).toBe('stitch');
  });

  it('is decided by the namespace it is given, not by the build target', () => {
    // vitest.config.ts defines __BROWSER_TARGET__ = 'chrome'; a Firefox-shaped
    // namespace still goes native and a Chrome-shaped one still stitches.
    expect(__BROWSER_TARGET__).toBe('chrome');
    expect(chooseFullPageStrategy({ captureTab() {} })).toBe('native');
  });
});
