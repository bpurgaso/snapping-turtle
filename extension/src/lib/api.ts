import type { CreateCaptureResponse } from '@snapping-turtle/shared/api';
import { CAPTURE_UPLOAD_FIELDS } from '@snapping-turtle/shared/constants';

/**
 * The extension's view of the M1 server contract (PLAN.md §8):
 *   POST /api/v1/captures  multipart {image, sourceUrl, title}, bearer → 201 {pageUrl, imageUrl}
 *   GET  /api/v1/ping      bearer → 204
 * Response classification is pure so it can be unit-tested; the fetch
 * wrappers never log or echo the token (CLAUDE.md rule 3).
 */

export const CAPTURES_PATH = '/api/v1/captures';
export const PING_PATH = '/api/v1/ping';

export type UploadOutcome =
  | { kind: 'created'; pageUrl: string; imageUrl: string }
  | { kind: 'unauthorized' }
  | { kind: 'failed'; message: string };

export type PingOutcome =
  { kind: 'ok' } | { kind: 'unauthorized' } | { kind: 'failed'; message: string };

const MAX_SERVER_MESSAGE = 200;

/** Short, human error text from an ApiErrorResponse body, or a status-based fallback. */
export function describeFailure(status: number, body: unknown): string {
  const error =
    body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : '';
  const text = error.trim().slice(0, MAX_SERVER_MESSAGE);
  if (status === 413) return `Upload rejected: the image is too large (HTTP 413).`;
  if (status === 429) return `The server asked us to slow down (HTTP 429). Try again shortly.`;
  if (status >= 500) return `The server had a problem (HTTP ${status}). Try again shortly.`;
  return text ? `Upload rejected (HTTP ${status}): ${text}` : `Upload rejected (HTTP ${status}).`;
}

const isHttpUrl = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
};

export function classifyUploadResponse(status: number, body: unknown): UploadOutcome {
  if (status === 401) return { kind: 'unauthorized' };
  if (status === 201) {
    const { pageUrl, imageUrl } = (body ?? {}) as Partial<CreateCaptureResponse>;
    // A misbehaving server must not be able to make us open an arbitrary scheme.
    if (isHttpUrl(pageUrl) && isHttpUrl(imageUrl)) return { kind: 'created', pageUrl, imageUrl };
    return { kind: 'failed', message: 'The server returned an unexpected response to the upload.' };
  }
  return { kind: 'failed', message: describeFailure(status, body) };
}

export function classifyPingResponse(status: number): PingOutcome {
  if (status === 204) return { kind: 'ok' };
  if (status === 401) return { kind: 'unauthorized' };
  if (status === 404) {
    return {
      kind: 'failed',
      message: `Reached the server but it has no ${PING_PATH} — is the address right and the server up to date?`,
    };
  }
  return { kind: 'failed', message: `Unexpected response from the server (HTTP ${status}).` };
}

export interface UploadRequest {
  origin: string;
  token: string;
  image: Blob;
  sourceUrl: string;
  title: string;
}

/** Exactly the M1 multipart shape: file part `image`, text parts `sourceUrl` and `title`. */
export function buildUploadForm(
  req: Pick<UploadRequest, 'image' | 'sourceUrl' | 'title'>,
): FormData {
  const form = new FormData();
  form.append(CAPTURE_UPLOAD_FIELDS.image, req.image, 'capture.png');
  form.append(CAPTURE_UPLOAD_FIELDS.sourceUrl, req.sourceUrl);
  form.append(CAPTURE_UPLOAD_FIELDS.title, req.title);
  return form;
}

const unreachable = (origin: string): string =>
  `Could not reach ${origin}. Check the server address, your connection, and that the extension has permission for that site.`;

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function uploadCapture(
  req: UploadRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<UploadOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(`${req.origin}${CAPTURES_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${req.token}` },
      body: buildUploadForm(req),
      credentials: 'omit',
      redirect: 'error',
    });
  } catch {
    return { kind: 'failed', message: unreachable(req.origin) };
  }
  return classifyUploadResponse(res.status, res.status === 204 ? null : await readJson(res));
}

export async function pingServer(
  origin: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PingOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(`${origin}${PING_PATH}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
    });
  } catch {
    return { kind: 'failed', message: unreachable(origin) };
  }
  return classifyPingResponse(res.status);
}
