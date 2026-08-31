import { describe, expect, it } from 'vitest';
import { restrictedReason } from '../src/lib/restricted.js';

describe('restrictedReason', () => {
  it('allows ordinary http(s) pages', () => {
    expect(restrictedReason('https://example.com/some/page?q=1')).toBeNull();
    expect(restrictedReason('http://localhost:3000/')).toBeNull();
    expect(restrictedReason('https://chrome.google.com/')).toBeNull(); // not the store path
    expect(restrictedReason('https://addons.mozilla.org.evil.example/')).toBeNull();
  });

  it('flags browser-internal and extension pages', () => {
    for (const url of [
      'chrome://extensions/',
      'chrome://newtab/',
      'chrome-untrusted://new-tab-page/',
      'devtools://devtools/bundled/inspector.html',
      'edge://settings/',
      'about:blank',
      'about:debugging#/runtime/this-firefox',
      'about:newtab',
      'view-source:https://example.com/',
    ]) {
      expect(restrictedReason(url), url).toMatch(/browser-internal/);
    }
    expect(restrictedReason('chrome-extension://abcdefgh/popup/index.html')).toMatch(
      /extension pages/,
    );
    expect(restrictedReason('moz-extension://1234-5678/options/index.html')).toMatch(
      /extension pages/,
    );
  });

  it('flags the extension stores', () => {
    for (const url of [
      'https://chromewebstore.google.com/detail/foo/abcdefgh',
      'https://chrome.google.com/webstore/detail/foo/abcdefgh',
      'https://addons.mozilla.org/en-US/firefox/addon/foo/',
      'https://microsoftedge.microsoft.com/addons/detail/foo/abcdefgh',
    ]) {
      expect(restrictedReason(url), url).toMatch(/extension stores/);
    }
  });

  it('flags everything the server would refuse as a source URL', () => {
    expect(restrictedReason('file:///Users/me/doc.html')).toMatch(/local files/);
    expect(restrictedReason('data:text/html,hi')).toMatch(/only http\(s\)/);
    expect(restrictedReason('blob:https://example.com/uuid')).toMatch(/only http\(s\)/);
    expect(restrictedReason('ftp://example.com/')).toMatch(/only http\(s\)/);
    expect(restrictedReason(undefined)).toMatch(/no readable address/);
    expect(restrictedReason('')).toMatch(/no readable address/);
    expect(restrictedReason('not a url')).toMatch(/not a valid URL/);
  });
});
