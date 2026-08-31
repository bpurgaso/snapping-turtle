import {
  API_TOKEN_PREFIX,
  SECRET_LOG_PREFIX_CHARS,
  SECRET_TOKEN_BYTES,
  VIEW_ID_BYTES,
  VIEW_ID_LENGTH,
} from '@snapping-turtle/shared';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Secret identifiers (CLAUDE.md rule 1): every token comes from
 * crypto.randomBytes, base64url-encoded, ≥ 20 bytes. Nothing here is ever
 * derived from time, counters or other tokens.
 */

export function newViewId(): string {
  return randomBytes(VIEW_ID_BYTES).toString('base64url');
}

/** Shape check only — a syntactically valid id says nothing about existence. */
export const VIEW_ID_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${VIEW_ID_LENGTH}}$`);

export function newApiToken(): string {
  return API_TOKEN_PREFIX + randomBytes(SECRET_TOKEN_BYTES).toString('base64url');
}

/** Session tokens get a larger budget: they are long-lived and cheap to carry. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Constant-time string comparison that also hides length mismatches. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** The only form in which a secret may appear in a log line (CLAUDE.md rule 3). */
export function secretPrefix(secret: string): string {
  return `${secret.slice(0, SECRET_LOG_PREFIX_CHARS)}…`;
}
