/** Popup ↔ background protocol. Kept tiny and versionless: both ends ship together. */

export const CAPTURE_MODES = ['visible', 'region', 'full'] as const;
export type CaptureMode = (typeof CAPTURE_MODES)[number];

/** Modes wired end-to-end today; the others render disabled with an M6 hint (PLAN.md §16). */
export const ENABLED_MODES: ReadonlySet<CaptureMode> = new Set<CaptureMode>(['visible']);

export interface CaptureRequest {
  type: 'capture';
  mode: CaptureMode;
  tabId: number;
  windowId: number;
}

export type CaptureFailureCode =
  'restricted' | 'no_token' | 'unauthorized' | 'unsupported' | 'failed';

export type CaptureResponse =
  { ok: true; pageUrl: string } | { ok: false; code: CaptureFailureCode; message: string };

export function isCaptureRequest(value: unknown): value is CaptureRequest {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v['type'] === 'capture' &&
    typeof v['mode'] === 'string' &&
    (CAPTURE_MODES as readonly string[]).includes(v['mode']) &&
    typeof v['tabId'] === 'number' &&
    typeof v['windowId'] === 'number'
  );
}
