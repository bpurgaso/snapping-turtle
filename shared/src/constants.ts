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

// ---- Capture mechanics (§15) ------------------------------------------------

/** Chrome throttles captureVisibleTab to ~2 calls/sec; scroll-and-stitch tiles
 *  are paced this far apart. Do not "optimize" this away. */
export const CAPTURE_TILE_INTERVAL_MS = 600;

// ---- Identifiers and secrets (§6, CLAUDE.md rule 1 & 3) ---------------------

/** Bytes of CSPRNG entropy in a view_id (20 bytes → 27 base64url chars ≈ 160 bits). */
export const VIEW_ID_BYTES = 20;
/** Base64url length of a VIEW_ID_BYTES-byte token. */
export const VIEW_ID_LENGTH = 27;
/** API tokens and set-password link tokens use the same entropy budget. */
export const SECRET_TOKEN_BYTES = 20;
/** Secrets appear in logs and error messages only as this many leading chars. */
export const SECRET_LOG_PREFIX_CHARS = 8;

// ---- Retention (§13) --------------------------------------------------------

export const RETENTION_DEFAULT_DAYS = 30;
export const RETENTION_MAX_DAYS_USER = 365;
/** Deleted/expired captures keep a tombstone row this long before hard delete (§5). */
export const TOMBSTONE_RETENTION_DAYS = 90;

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
  /** Escalating ban durations per strike, in minutes: 15 min → 1 h → 24 h. */
  banLadderMinutes: [15, 60, 24 * 60],
} as const;
