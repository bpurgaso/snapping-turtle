import { describe, expect, it } from 'vitest';
import { detectBrowser } from '../src/browser-detect.js';

describe('detectBrowser (home page emphasis, E2)', () => {
  it('recognises Firefox on desktop and iOS', () => {
    expect(
      detectBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:140.0) Gecko/20100101 Firefox/140.0'),
    ).toBe('firefox');
    expect(detectBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) FxiOS/140.0 Mobile/15E148')).toBe(
      'firefox',
    );
  });

  it('groups the Chromium family under chrome (they all use the Web Store)', () => {
    const chrome = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';
    expect(detectBrowser(chrome)).toBe('chrome');
    expect(detectBrowser(`${chrome} Edg/139.0.0.0`)).toBe('chrome');
    expect(detectBrowser(`${chrome} OPR/120.0.0.0`)).toBe('chrome');
    expect(detectBrowser('Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/139.0.0.0 Safari/537.36')).toBe(
      'chrome',
    );
  });

  it('emphasises nothing for Safari or an unknown agent', () => {
    expect(
      detectBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'),
    ).toBeUndefined();
    expect(detectBrowser('')).toBeUndefined();
  });
});
