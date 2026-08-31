/**
 * `captureVisibleTab` returns a data: URL; the upload wants a Blob. Decoded by
 * hand (no fetch of the data URL) so it is trivially unit-testable and works
 * identically in Chrome's service worker and Firefox's event page.
 */
const DATA_URL = /^data:([^;,]+)?(;base64)?,(.*)$/s;

export function dataUrlToBlob(dataUrl: string): Blob {
  const match = DATA_URL.exec(dataUrl);
  if (!match) throw new Error('capture did not return a data URL');
  const [, mime = 'application/octet-stream', base64, payload = ''] = match;
  if (!base64) return new Blob([decodeURIComponent(payload)], { type: mime });
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
