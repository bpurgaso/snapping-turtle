/**
 * Cross-cutting constants. Every package imports these; never re-declare them
 * elsewhere (CLAUDE.md "Engineering conventions"). Section references point
 * into PLAN.md.
 */

// ---- Annotation document (§9) ----------------------------------------------

/** Version stamped into every persisted annotation document. Bump with a migration. */
export const ANNOTATION_SCHEMA_VERSION = 1 as const;

// ---- Image and upload caps (§12, §15) ---------------------------------------

/** Full-page captures are capped at this many physical pixels tall. Shared by
 *  extension capture, server ingest validation, and the editor (§9, §15). */
export const MAX_IMAGE_HEIGHT_PX = 32_000;

/** Widest image the ingest pipeline will decode (§12). */
export const MAX_IMAGE_WIDTH_PX = 10_000;

/** Decompression-bomb guard for sharp's `limitInputPixels` (§12). */
export const MAX_IMAGE_PIXELS = 150_000_000;

/** Upload body cap, mirrored by Caddy's request_body limit (§12, §14). */
export const MAX_UPLOAD_MB = 30;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

/** `source_url` must parse as http(s) and fit this many characters (§12). */
export const MAX_SOURCE_URL_LENGTH = 2048;
/** `page_title` is truncated to this many characters on ingest (§12). */
export const MAX_PAGE_TITLE_LENGTH = 512;

/** Byte cap for a serialized annotation document PUT (500 text shapes of
 *  2,000 chars can legitimately reach several MB once JSON-escaped). */
export const MAX_ANNOTATION_DOC_BYTES = 8 * 1024 * 1024;

// ---- Capture mechanics (§15) ------------------------------------------------

/** Chrome throttles captureVisibleTab to ~2 calls/sec; scroll-and-stitch tiles
 *  are paced this far apart. Do not "optimize" this away. */
export const CAPTURE_TILE_INTERVAL_MS = 600;

// ---- Upload wire contract (§8) ----------------------------------------------

/** multipart/form-data field names for POST /api/v1/captures. Lives here rather
 *  than in api.ts so the extension can import it without pulling the TypeBox
 *  schemas (and TypeBox itself) into its bundles. */
export const CAPTURE_UPLOAD_FIELDS = {
  /** PNG or JPEG bytes; the server sniffs magic bytes and ignores the declared type. */
  image: 'image',
  /** Absolute http(s) URL of the captured page. Optional since M9 (desktop
   *  captures have none); browser captures always send it. Blank = absent. */
  sourceUrl: 'sourceUrl',
  /** Page title; optional, truncated to MAX_PAGE_TITLE_LENGTH. */
  title: 'title',
} as const;

// ---- Extension distribution (§15, M8) ---------------------------------------

/** Public, secret-free static route serving the self-distributed Firefox
 *  build: `/ext/updates.json` plus the signed .xpi files it points at. */
export const EXT_ROUTE_PREFIX = '/ext/';
/** Firefox update manifest name under EXT_ROUTE_PREFIX (the manifest's `update_url`). */
export const EXT_UPDATES_MANIFEST = 'updates.json';
/** Stable install link under EXT_ROUTE_PREFIX: redirects to the newest .xpi in updates.json (E2). */
export const EXT_FIREFOX_LATEST = 'firefox-latest';
/** Signed Firefox artifact name for a version; also what updates.json links to. */
export function firefoxXpiFilename(version: string): string {
  return `snapping-turtle-firefox-${version}.xpi`;
}

// ---- Identifiers and secrets (§6, CLAUDE.md rule 1 & 3) ---------------------

/** Bytes of CSPRNG entropy in a view_id (20 bytes → 27 base64url chars ≈ 160 bits). */
export const VIEW_ID_BYTES = 20;
/** Base64url length of a VIEW_ID_BYTES-byte token. */
export const VIEW_ID_LENGTH = 27;
/** API tokens and set-password link tokens use the same entropy budget. */
export const SECRET_TOKEN_BYTES = 20;
/** Secrets appear in logs and error messages only as this many leading chars. */
export const SECRET_LOG_PREFIX_CHARS = 8;
/** Personal API tokens are prefixed so leaked ones are recognisable to secret scanners. */
export const API_TOKEN_PREFIX = 'st_';
/** Human label an owner gives an API token on the account page. */
export const MAX_TOKEN_NAME_LENGTH = 64;

// ---- Accounts (§11) ---------------------------------------------------------

/** Lowercase letters, digits, "_", "." or "-"; 2–32 chars; must start alphanumeric. */
export const USERNAME_PATTERN = '^[a-z0-9][a-z0-9_.-]{1,31}$';
export const USERNAME_MIN_LENGTH = 2;
export const USERNAME_MAX_LENGTH = 32;
export const PASSWORD_MIN_LENGTH = 12;
/** Bounded so argon2 cost stays predictable. */
export const PASSWORD_MAX_LENGTH = 512;

/** Per-account login throttling with exponential backoff (§11). After
 *  `freeAttempts` consecutive failures the account is locked for
 *  `baseSeconds × 2^(n − freeAttempts − 1)`, capped at `maxSeconds`. */
export const LOGIN_THROTTLE_DEFAULTS = {
  freeAttempts: 5,
  baseSeconds: 5,
  maxSeconds: 3600,
} as const;

/** Admin-issued one-time set-password links expire after this long (§11). */
export const ACCOUNT_LINK_TTL_HOURS = 24;

// ---- Retention (§13) --------------------------------------------------------

export const RETENTION_DEFAULT_DAYS = 30;
export const RETENTION_MAX_DAYS_USER = 365;
/** Deleted/expired captures keep a tombstone row this long before hard delete (§5).
 *  Overridable via TOMBSTONE_DAYS (§14). */
export const TOMBSTONE_RETENTION_DAYS = 90;
/** The retention purge job runs this often (§13: hourly). */
export const PURGE_INTERVAL_MS = 60 * 60 * 1000;

// ---- Guard defaults (§12) ---------------------------------------------------

/** Default knobs for the per-IP limiter, invalid-lookup budget and global
 *  breaker. The server reads these into config (overridable via RATE_* env
 *  vars); the guard itself lands in M5 and must never be disabled in prod. */
export const GUARD_DEFAULTS = {
  /** Unauthenticated requests per IP per minute. */
  generalPerMinute: 60,
  /** Not-found hits on /s/* per IP within the window before a ban. */
  invalidLookupBudget: 5,
  invalidLookupWindowMinutes: 10,
  /** Aggregate invalid lookups per minute (all IPs) that open the breaker. */
  breakerInvalidPerMinute: 100,
  /** Escalating ban durations per strike, in minutes: 15 min → 1 h → 24 h.
   *  Further strikes stay at the last rung. */
  banLadderMinutes: [15, 60, 24 * 60],
  /** How long the breaker stays open before half-open probes are admitted. */
  breakerCooldownSeconds: 300,
  /** Uniform not-found responses on /s/* sleep a random duration in this
   *  range so response timing never distinguishes a miss from an expired row (§6). */
  notFoundJitterMs: { min: 30, max: 150 },
} as const;
