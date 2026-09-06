import type { CreateCaptureResponse } from '@snapping-turtle/shared';

/**
 * Same-origin path of the owner-only original image (§7, §9 E4): what the
 * editor draws on. Session-gated under the API, never under /s/* — the public
 * image URL stays the flat (cropped) render for everyone.
 */
export function ownerOriginalPath(viewId: string): string {
  return `/api/v1/captures/${viewId}/original`;
}

/** The two URLs derived from a view_id (§6). Stable from M1 on; M4 changes only what image.png serves. */
export function captureUrls(publicOrigin: string, viewId: string): CreateCaptureResponse {
  const pageUrl = `${publicOrigin}/s/${viewId}`;
  return { pageUrl, imageUrl: `${pageUrl}/image.png` };
}
