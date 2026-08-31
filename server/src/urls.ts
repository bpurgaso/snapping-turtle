import type { CreateCaptureResponse } from '@snapping-turtle/shared';

/** The two URLs derived from a view_id (§6). Stable from M1 on; M4 changes only what image.png serves. */
export function captureUrls(publicOrigin: string, viewId: string): CreateCaptureResponse {
  const pageUrl = `${publicOrigin}/s/${viewId}`;
  return { pageUrl, imageUrl: `${pageUrl}/image.png` };
}
