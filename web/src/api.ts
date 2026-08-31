import { CSRF_HEADER } from '@snapping-turtle/shared/api';
import type {
  ApiErrorResponse,
  CreateTokenRequest,
  CreateTokenResponse,
  CredentialsRequest,
  PatchCaptureRequest,
  PatchCaptureResponse,
  PutAnnotationsResponse,
  SessionInfo,
  TokenListResponse,
} from '@snapping-turtle/shared/api';
import type { AnnotationDocument } from '@snapping-turtle/shared/annotations';

/**
 * Thin JSON client for the browser pages. Cookies ride along same-origin;
 * every state change sends the session's CSRF token in the header the
 * server checks (double-submit, PLAN.md §8).
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, csrf?: string): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const init: RequestInit = { method, credentials: 'same-origin', headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (csrf) headers[CSRF_HEADER] = csrf;
  const res = await fetch(path, init);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const err = (data ?? {}) as Partial<ApiErrorResponse>;
    throw new ApiError(
      res.status,
      err.code,
      err.error ?? `request failed (${res.status})`,
      err.retryAfterSeconds,
    );
  }
  return data as T;
}

/** The signed-in session, or null when there is none. */
export async function currentSession(): Promise<SessionInfo | null> {
  try {
    return await request<SessionInfo>('GET', '/api/v1/auth/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export const auth = {
  login: (creds: CredentialsRequest) => request<SessionInfo>('POST', '/api/v1/auth/login', creds),
  signup: (creds: CredentialsRequest) => request<SessionInfo>('POST', '/api/v1/auth/signup', creds),
  logout: (csrf: string) => request<void>('POST', '/api/v1/auth/logout', undefined, csrf),
};

export const tokens = {
  list: () => request<TokenListResponse>('GET', '/api/v1/tokens'),
  create: (body: CreateTokenRequest, csrf: string) =>
    request<CreateTokenResponse>('POST', '/api/v1/tokens', body, csrf),
  revoke: (id: number, csrf: string) =>
    request<void>('DELETE', `/api/v1/tokens/${id}`, undefined, csrf),
};

export const annotations = {
  get: (viewId: string) =>
    request<AnnotationDocument>('GET', `/api/v1/captures/${viewId}/annotations`),
  put: (viewId: string, doc: AnnotationDocument, csrf: string) =>
    request<PutAnnotationsResponse>('PUT', `/api/v1/captures/${viewId}/annotations`, doc, csrf),
};

/** Owner capture management (§7): retention changes and delete. */
export const patchCapture = (viewId: string, body: PatchCaptureRequest, csrf: string) =>
  request<PatchCaptureResponse | undefined>('PATCH', `/api/v1/captures/${viewId}`, body, csrf);

/** Human-readable message for an API failure. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) {
      const secs = err.retryAfterSeconds ?? 60;
      return `Too many attempts. Try again in ${secs} second${secs === 1 ? '' : 's'}.`;
    }
    if (err.code === 'registration_closed') {
      return 'Registration is closed on this server. Ask the admin for an account.';
    }
    if (err.code === 'invalid_credentials') return 'Invalid username or password.';
    if (err.code === 'username_taken') return 'That username is taken.';
    return err.message;
  }
  return 'Network error — please try again.';
}
