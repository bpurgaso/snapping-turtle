/** Popup ↔ background protocol. Kept tiny and versionless: both ends ship together. */

export const CAPTURE_MODES = ['visible', 'region', 'full'] as const;
export type CaptureMode = (typeof CAPTURE_MODES)[number];

export interface CaptureRequest {
  type: 'capture';
  mode: CaptureMode;
  tabId: number;
  windowId: number;
}

export type CaptureFailureCode =
  'restricted' | 'no_token' | 'unauthorized' | 'busy' | 'cancelled' | 'oversize' | 'failed';

/**
 * `uploaded`: the capture page is open. `started`: region selection or a
 * full-page run is under way in the background and will report through
 * notifications and the badge (the popup closes so the page has focus).
 */
export type CaptureResponse =
  | { ok: true; status: 'uploaded'; pageUrl: string }
  | { ok: true; status: 'started' }
  | { ok: false; code: CaptureFailureCode; message: string };

export function isCaptureMode(value: unknown): value is CaptureMode {
  return typeof value === 'string' && (CAPTURE_MODES as readonly string[]).includes(value);
}

export function isCaptureRequest(value: unknown): value is CaptureRequest {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v['type'] === 'capture' &&
    isCaptureMode(v['mode']) &&
    typeof v['tabId'] === 'number' &&
    typeof v['windowId'] === 'number'
  );
}
