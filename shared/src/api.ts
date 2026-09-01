import { Type, type Static } from 'typebox';
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
  'conflict',
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

/**
 * Body of POST /api/v1/auth/set-password (§11): consumes an admin-issued
 * one-time link token and sets the account password. The token itself is the
 * authentication — no cookie, so no CSRF. Invalid tokens get the generic 404
 * and count against the guard's invalid-lookup budget (§12).
 */
export const SetPasswordRequest = Type.Object(
  {
    token: Type.String({ minLength: 1, maxLength: 128 }),
    password: Password,
  },
  { additionalProperties: false, $id: 'SetPasswordRequest' },
);
export type SetPasswordRequest = Static<typeof SetPasswordRequest>;

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

// ---- Annotations (§8, §9) ---------------------------------------------------

/** Successful PUT/beacon save: the new server revision. */
export const PutAnnotationsResponse = Type.Object(
  { rev: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false, $id: 'PutAnnotationsResponse' },
);
export type PutAnnotationsResponse = Static<typeof PutAnnotationsResponse>;

/**
 * Body of the `sendBeacon` save path (POST …/annotations). A beacon cannot
 * set headers, so the CSRF token travels in the body instead of `x-csrf-token`
 * and the payload goes over `text/plain` (the only content type a beacon can
 * always send). `document` is validated exactly like the PUT body.
 */
export const BeaconAnnotationsRequest = Type.Object(
  {
    csrfToken: Type.String({ minLength: 1 }),
    document: Type.Unknown(),
  },
  { additionalProperties: false, $id: 'BeaconAnnotationsRequest' },
);
export type BeaconAnnotationsRequest = Static<typeof BeaconAnnotationsRequest>;

// ---- Admin panel (§11) ------------------------------------------------------

/** GET /api/v1/admin/settings and PUT …/settings/registration. */
export const RegistrationSetting = Type.Object(
  { enabled: Type.Boolean() },
  { additionalProperties: false, $id: 'RegistrationSetting' },
);
export type RegistrationSetting = Static<typeof RegistrationSetting>;

export const AdminUserSummary = Type.Object(
  {
    id: Type.Integer(),
    username: Type.String(),
    role: UserRole,
    disabledAt: Type.Union([IsoTimestamp, Type.Null()]),
    createdAt: IsoTimestamp,
    /** Live (non-deleted) captures owned by this user. */
    captureCount: Type.Integer(),
  },
  { additionalProperties: false, $id: 'AdminUserSummary' },
);
export type AdminUserSummary = Static<typeof AdminUserSummary>;

export const AdminUserListResponse = Type.Object(
  { users: Type.Array(AdminUserSummary) },
  { additionalProperties: false, $id: 'AdminUserListResponse' },
);
export type AdminUserListResponse = Static<typeof AdminUserListResponse>;

export const CreateUserRequest = Type.Object(
  { username: Username },
  { additionalProperties: false, $id: 'CreateUserRequest' },
);
export type CreateUserRequest = Static<typeof CreateUserRequest>;

/**
 * An admin-issued one-time link (§11). `resetUrl` carries the raw token and
 * appears here exactly once — it is never retrievable again.
 */
export const IssuedLinkResponse = Type.Object(
  {
    userId: Type.Integer(),
    username: Type.String(),
    resetUrl: Type.String(),
    expiresAt: IsoTimestamp,
  },
  { additionalProperties: false, $id: 'IssuedLinkResponse' },
);
export type IssuedLinkResponse = Static<typeof IssuedLinkResponse>;

export const AdminCaptureSummary = Type.Object(
  {
    id: Type.Integer(),
    /** The capability URL — admins are trusted with it; audit rows are not. */
    pageUrl: Type.String(),
    sourceUrl: Type.String(),
    pageTitle: Type.String(),
    width: Type.Integer(),
    height: Type.Integer(),
    bytes: Type.Integer(),
    createdAt: IsoTimestamp,
    /** null = indefinite retention. */
    retentionUntil: Type.Union([IsoTimestamp, Type.Null()]),
    deletedAt: Type.Union([IsoTimestamp, Type.Null()]),
  },
  { additionalProperties: false, $id: 'AdminCaptureSummary' },
);
export type AdminCaptureSummary = Static<typeof AdminCaptureSummary>;

export const AdminCaptureListResponse = Type.Object(
  {
    captures: Type.Array(AdminCaptureSummary),
    total: Type.Integer(),
    page: Type.Integer(),
    pageSize: Type.Integer(),
  },
  { additionalProperties: false, $id: 'AdminCaptureListResponse' },
);
export type AdminCaptureListResponse = Static<typeof AdminCaptureListResponse>;

/** PATCH /api/v1/admin/captures/:id — the "Keep indefinitely" checkbox (§7). */
export const AdminCapturePatchRequest = Type.Object(
  { indefinite: Type.Boolean() },
  { additionalProperties: false, $id: 'AdminCapturePatchRequest' },
);
export type AdminCapturePatchRequest = Static<typeof AdminCapturePatchRequest>;

export const AdminCapturePatchResponse = Type.Object(
  { retentionUntil: Type.Union([IsoTimestamp, Type.Null()]) },
  { additionalProperties: false, $id: 'AdminCapturePatchResponse' },
);
export type AdminCapturePatchResponse = Static<typeof AdminCapturePatchResponse>;

export const AuditEntry = Type.Object(
  {
    id: Type.Integer(),
    at: IsoTimestamp,
    actorUserId: Type.Integer(),
    /** Username at read time; null if ever unresolvable. */
    actor: Type.Union([Type.String(), Type.Null()]),
    action: Type.String(),
    targetType: Type.String(),
    targetId: Type.Union([Type.Integer(), Type.Null()]),
    /** Never contains full secrets — 8-char prefixes only (CLAUDE.md rule 3). */
    detail: Type.Record(Type.String(), Type.Any()),
    ip: Type.String(),
  },
  { additionalProperties: false, $id: 'AuditEntry' },
);
export type AuditEntry = Static<typeof AuditEntry>;

export const AuditListResponse = Type.Object(
  {
    entries: Type.Array(AuditEntry),
    total: Type.Integer(),
    page: Type.Integer(),
    pageSize: Type.Integer(),
  },
  { additionalProperties: false, $id: 'AuditListResponse' },
);
export type AuditListResponse = Static<typeof AuditListResponse>;

export const GuardBanEntry = Type.Object(
  {
    ipPrefix: Type.String(),
    strikes: Type.Integer(),
    bannedUntil: IsoTimestamp,
    reason: Type.String(),
    updatedAt: IsoTimestamp,
    /** false = the ban has lapsed; the row remains for its strike history. */
    active: Type.Boolean(),
  },
  { additionalProperties: false, $id: 'GuardBanEntry' },
);
export type GuardBanEntry = Static<typeof GuardBanEntry>;

export const GuardStatusResponse = Type.Object(
  {
    breaker: Type.Object({
      state: Type.Union([
        Type.Literal('closed'),
        Type.Literal('open'),
        Type.Literal('half_open'),
      ]),
      retryAfterSeconds: Type.Optional(Type.Integer()),
    }),
    bans: Type.Array(GuardBanEntry),
  },
  { additionalProperties: false, $id: 'GuardStatusResponse' },
);
export type GuardStatusResponse = Static<typeof GuardStatusResponse>;

export const UnbanRequest = Type.Object(
  { ipPrefix: Type.String({ minLength: 1, maxLength: 64 }) },
  { additionalProperties: false, $id: 'UnbanRequest' },
);
export type UnbanRequest = Static<typeof UnbanRequest>;

// ---- Capture management (§7, §8, §13) ---------------------------------------

/** Retention choices offered by the capture page; filtered to the server max. */
export const RETENTION_CHOICES_DAYS = [30, 90, 180, 365] as const;

/**
 * Body of PATCH /api/v1/captures/:viewId — exactly one of the two actions.
 * `retentionDays` re-anchors expiry at `created_at + days`; the server
 * rejects values beyond RETENTION_MAX_DAYS_USER with 400.
 */
export const PatchCaptureRequest = Type.Object(
  {
    retentionDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })),
    delete: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: false, $id: 'PatchCaptureRequest' },
);
export type PatchCaptureRequest = Static<typeof PatchCaptureRequest>;

export const PatchCaptureResponse = Type.Object(
  { retentionUntil: Type.String({ format: 'date-time' }) },
  { additionalProperties: false, $id: 'PatchCaptureResponse' },
);
export type PatchCaptureResponse = Static<typeof PatchCaptureResponse>;
