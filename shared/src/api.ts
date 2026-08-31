import { Type, type Static } from '@sinclair/typebox';
import {
  MAX_TOKEN_NAME_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_PATTERN,
} from './constants.js';

/**
 * Wire types for the JSON API (PLAN.md §8). Every Fastify route declares
 * these as its schemas; the web pages and the extension import the same
 * definitions, so the three cannot drift.
 */

export const HealthzResponse = Type.Object(
  {
    status: Type.Union([Type.Literal('ok'), Type.Literal('degraded')]),
    /** Which dependencies were checked and whether each passed. */
    checks: Type.Record(Type.String(), Type.Boolean()),
  },
  { additionalProperties: false, $id: 'HealthzResponse' },
);
export type HealthzResponse = Static<typeof HealthzResponse>;

/** Machine-readable error codes. Messages are for humans; branch on these. */
export const ApiErrorCodes = [
  'validation',
  'bad_request',
  'unauthorized',
  'forbidden',
  'csrf',
  'invalid_credentials',
  'throttled',
  'registration_closed',
  'username_taken',
  'not_found',
  'payload_too_large',
  'unsupported_media_type',
  'invalid_image',
  'image_too_large',
  'invalid_source_url',
  'internal',
] as const;
export type ApiErrorCode = (typeof ApiErrorCodes)[number];

export const ApiErrorResponse = Type.Object(
  {
    error: Type.String(),
    /** Short machine-readable code; never contains secrets or row internals. */
    code: Type.Optional(Type.String()),
    /** Present on 429s: seconds until the client may retry. */
    retryAfterSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false, $id: 'ApiErrorResponse' },
);
export type ApiErrorResponse = Static<typeof ApiErrorResponse>;

// ---- Auth (§11) -------------------------------------------------------------

export const Username = Type.String({
  pattern: USERNAME_PATTERN,
  minLength: USERNAME_MIN_LENGTH,
  maxLength: USERNAME_MAX_LENGTH,
});
export const Password = Type.String({
  minLength: PASSWORD_MIN_LENGTH,
  maxLength: PASSWORD_MAX_LENGTH,
});

/** Body of POST /api/v1/auth/login and /signup. */
export const CredentialsRequest = Type.Object(
  { username: Username, password: Password },
  { additionalProperties: false, $id: 'CredentialsRequest' },
);
export type CredentialsRequest = Static<typeof CredentialsRequest>;

export const UserRole = Type.Union([Type.Literal('user'), Type.Literal('admin')]);
export type UserRole = Static<typeof UserRole>;

/** Returned by login/signup and GET /api/v1/auth/me. */
export const SessionInfo = Type.Object(
  {
    username: Type.String(),
    role: UserRole,
    /** Echo this in the `x-csrf-token` header on every cookie-authenticated state change. */
    csrfToken: Type.String(),
  },
  { additionalProperties: false, $id: 'SessionInfo' },
);
export type SessionInfo = Static<typeof SessionInfo>;

/** Header carrying the double-submit CSRF token. */
export const CSRF_HEADER = 'x-csrf-token';

// ---- API tokens (§11) -------------------------------------------------------

const IsoTimestamp = Type.String({ format: 'date-time' });

export const TokenSummary = Type.Object(
  {
    id: Type.Integer(),
    name: Type.String(),
    createdAt: IsoTimestamp,
    lastUsedAt: Type.Union([IsoTimestamp, Type.Null()]),
    revokedAt: Type.Union([IsoTimestamp, Type.Null()]),
  },
  { additionalProperties: false, $id: 'TokenSummary' },
);
export type TokenSummary = Static<typeof TokenSummary>;

export const TokenListResponse = Type.Object(
  { tokens: Type.Array(TokenSummary) },
  { additionalProperties: false, $id: 'TokenListResponse' },
);
export type TokenListResponse = Static<typeof TokenListResponse>;

export const CreateTokenRequest = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: MAX_TOKEN_NAME_LENGTH }) },
  { additionalProperties: false, $id: 'CreateTokenRequest' },
);
export type CreateTokenRequest = Static<typeof CreateTokenRequest>;

/** The plaintext `token` appears here exactly once; only its sha256 is stored. */
export const CreateTokenResponse = Type.Object(
  {
    id: Type.Integer(),
    name: Type.String(),
    token: Type.String(),
    createdAt: IsoTimestamp,
  },
  { additionalProperties: false, $id: 'CreateTokenResponse' },
);
export type CreateTokenResponse = Static<typeof CreateTokenResponse>;

// ---- Captures (§8, §12) -----------------------------------------------------

/** multipart/form-data field names for POST /api/v1/captures. */
export const CAPTURE_UPLOAD_FIELDS = {
  /** PNG or JPEG bytes; the server sniffs magic bytes and ignores the declared type. */
  image: 'image',
  /** Absolute http(s) URL of the captured page. Required. */
  sourceUrl: 'sourceUrl',
  /** Page title; optional, truncated to MAX_PAGE_TITLE_LENGTH. */
  title: 'title',
} as const;

export const CreateCaptureResponse = Type.Object(
  {
    /** Absolute URL of the capture page (`/s/{viewId}`). Treat as a secret. */
    pageUrl: Type.String(),
    /** Absolute URL of the image (`/s/{viewId}/image.png`). */
    imageUrl: Type.String(),
  },
  { additionalProperties: false, $id: 'CreateCaptureResponse' },
);
export type CreateCaptureResponse = Static<typeof CreateCaptureResponse>;
