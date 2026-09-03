/**
 * Which install card to emphasise on the home page (E2). Chromium-family
 * browsers (Chrome, Edge, Brave, Opera, Vivaldi) all install from the Chrome
 * Web Store, so they group as 'chrome'. Anything else — Safari, unknown —
 * gets no emphasis: both cards are always shown regardless.
 */
export function detectBrowser(userAgent: string): 'firefox' | 'chrome' | undefined {
  if (/Firefox\/|FxiOS\//.test(userAgent)) return 'firefox';
  // No word boundary: headless Chromium reports "HeadlessChrome/".
  if (/Chrome\/|Chromium\/|CriOS\//.test(userAgent)) return 'chrome';
  return undefined;
}
