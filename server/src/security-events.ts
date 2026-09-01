import type { FastifyBaseLogger } from 'fastify';

/**
 * Security event taxonomy (PLAN.md §12 "structured security events"). Every
 * security-relevant occurrence is logged through `logSecurityEvent` as one
 * pino line carrying `tag: "sec.<area>.<event>"` plus the fields listed
 * here, so alerting can key on the tag alone. The full list, levels and
 * field semantics are documented in docs/security-events.md — keep the two
 * in sync when adding a tag.
 *
 * CLAUDE.md rule 3 applies to every field: secrets never appear (tokens,
 * view_ids, cookies, passwords), only internal row ids, IP keys and counts.
 */
export type SecurityEvent =
  // ---- guard: per-IP bans (§12) --------------------------------------------
  | {
      tag: 'sec.ban.created';
      ipPrefix: string;
      strikes: number;
      banMinutes: number;
      bannedUntil: string;
    }
  | { tag: 'sec.ban.expired'; ipPrefix: string; strikes: number }
  | { tag: 'sec.ban.lifted'; ipPrefix: string }
  // ---- guard: global breaker (§12) ------------------------------------------
  | {
      tag: 'sec.breaker.opened';
      reason: 'invalid_rate' | 'half_open_failed';
      cooldownSeconds: number;
    }
  | { tag: 'sec.breaker.half_open' }
  | { tag: 'sec.breaker.closed' }
  // ---- throttles ------------------------------------------------------------
  | { tag: 'sec.throttle.general'; ipPrefix: string; retryAfterSeconds: number; path: string }
  | { tag: 'sec.throttle.login'; username: string; retryAfterSeconds: number; ip: string }
  // ---- authentication / authorization failures (§8, §11) --------------------
  | { tag: 'sec.auth.login_failed'; username: string; lockSeconds: number; ip: string }
  | { tag: 'sec.auth.token_rejected'; ip: string; path: string }
  | { tag: 'sec.auth.session_rejected'; ip: string; path: string }
  | { tag: 'sec.auth.csrf_rejected'; userId: number; ip: string; path: string }
  | {
      tag: 'sec.auth.forbidden';
      reason: 'admin_required' | 'not_owner';
      userId: number;
      ip: string;
      path: string;
    }
  | { tag: 'sec.auth.link_rejected'; ip: string }
  | { tag: 'sec.auth.link_consumed'; userId: number; linkId: number; purpose: string; ip: string }
  // ---- admin panel (§11) ----------------------------------------------------
  | {
      tag: 'sec.admin.mutation';
      action: string;
      actorUserId: number;
      targetType: string;
      targetId: number | null;
      ip: string;
    }
  // ---- retention purge (§13) ------------------------------------------------
  | {
      tag: 'sec.purge.completed';
      expired: number;
      filesRemoved: number;
      sweptFiles: number;
      hardDeleted: number;
      errors: number;
      ms: number;
    }
  | { tag: 'sec.purge.file_error'; captureId: number; err: unknown }
  | { tag: 'sec.purge.failed'; err: unknown }
  // ---- server-side faults and configuration ---------------------------------
  | { tag: 'sec.image.missing_file'; captureId: number }
  | { tag: 'sec.proxy.permissive_trust'; trustProxy: string };

export type SecurityTag = SecurityEvent['tag'];

type Level = 'info' | 'warn' | 'error';

/** Log level per tag — the alerting contract (docs/security-events.md). */
export const SECURITY_EVENT_LEVEL: Record<SecurityTag, Level> = {
  'sec.ban.created': 'warn',
  'sec.ban.expired': 'info',
  'sec.ban.lifted': 'warn',
  'sec.breaker.opened': 'error',
  'sec.breaker.half_open': 'warn',
  'sec.breaker.closed': 'info',
  'sec.throttle.general': 'warn',
  'sec.throttle.login': 'warn',
  'sec.auth.login_failed': 'info',
  'sec.auth.token_rejected': 'warn',
  'sec.auth.session_rejected': 'info',
  'sec.auth.csrf_rejected': 'warn',
  'sec.auth.forbidden': 'warn',
  'sec.auth.link_rejected': 'warn',
  'sec.auth.link_consumed': 'info',
  'sec.admin.mutation': 'info',
  'sec.purge.completed': 'info',
  'sec.purge.file_error': 'error',
  'sec.purge.failed': 'error',
  'sec.image.missing_file': 'error',
  'sec.proxy.permissive_trust': 'error',
};

/** Every tag, for tests and the docs check. */
export const SECURITY_TAGS = Object.keys(SECURITY_EVENT_LEVEL) as SecurityTag[];

/**
 * Emit one security event as a structured log line: `{ tag, ...fields }`
 * with `msg` equal to the tag. Callers pass the request logger where one
 * exists so the line also carries `reqId`.
 */
export function logSecurityEvent(log: FastifyBaseLogger, event: SecurityEvent): void {
  const { tag, ...fields } = event;
  log[SECURITY_EVENT_LEVEL[tag]]({ tag, ...fields }, tag);
}
