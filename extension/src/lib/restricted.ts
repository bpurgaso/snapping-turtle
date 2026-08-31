/**
 * Up-front detection of tabs the extension cannot capture or the server will
 * not accept (PLAN.md §15): browser-internal pages, extension pages, the
 * extension stores, and anything without an http(s) address (the server
 * requires an http(s) `sourceUrl`, §12). Returns a human message or null.
 */

const BROWSER_INTERNAL = new Set([
  'chrome:',
  'chrome-untrusted:',
  'chrome-search:',
  'devtools:',
  'edge:',
  'brave:',
  'opera:',
  'vivaldi:',
  'about:',
  'view-source:',
]);
const EXTENSION_SCHEMES = new Set(['chrome-extension:', 'moz-extension:', 'extension:']);

/** Hosts (and, for chrome.google.com, the path prefix) of the extension stores. */
const STORE_HOSTS: ReadonlyArray<[host: string, pathPrefix: string]> = [
  ['chromewebstore.google.com', '/'],
  ['chrome.google.com', '/webstore'],
  ['addons.mozilla.org', '/'],
  ['microsoftedge.microsoft.com', '/addons'],
];

export function restrictedReason(url: string | undefined): string | null {
  if (!url) return "Can't capture this page: the tab has no readable address.";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Can't capture this page: its address is not a valid URL.";
  }
  if (BROWSER_INTERNAL.has(parsed.protocol)) {
    return "Can't capture this page: browser-internal pages are off limits to extensions.";
  }
  if (EXTENSION_SCHEMES.has(parsed.protocol)) {
    return "Can't capture this page: extension pages are off limits to extensions.";
  }
  if (parsed.protocol === 'file:') {
    return "Can't capture this page: local files have no web address to link back to.";
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return "Can't capture this page: only http(s) pages can be captured.";
  }
  for (const [host, prefix] of STORE_HOSTS) {
    if (parsed.hostname === host && parsed.pathname.startsWith(prefix)) {
      return "Can't capture this page: browsers block extensions on their extension stores.";
    }
  }
  return null;
}
