import { eq, gt } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import { isIP } from 'node:net';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import { ipBans } from './db/schema.js';
import { html } from './html.js';
import type { SecurityEvent } from './security-events.js';
import type { Clock } from './types.js';

/**
 * The application guard (PLAN.md §12): per-IP sliding windows, escalating
 * bans persisted in `ip_bans`, and the global circuit breaker. Config-driven
 * and never disabled or special-cased in production paths (CLAUDE.md rule 9)
 * — tests get their determinism from the injected clock and RATE_* config.
 *
 * Counters are in-process (single node, §2); only bans touch the database,
 * so a restart rebuilds ban state but forgets in-flight windows — an
 * attacker gains at most one fresh budget, never an amnesty.
 */

// ---- IP keying --------------------------------------------------------------

/**
 * Guard key for a client address (§12): IPv4 addresses count individually,
 * IPv6 addresses by their /64 (the smallest allocation a host usually owns,
 * so one flat cannot dodge bans by rotating within its own prefix).
 */
export function ipPrefixOf(ip: string): string {
  let addr = ip.split('%', 2)[0]!; // strip any zone id
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  if (mapped) addr = mapped[1]!;
  if (isIP(addr) === 4) return addr;
  if (isIP(addr) === 6) return `${expandIpv6(addr).slice(0, 4).join(':')}::/64`;
  // Unknown shape (unix socket, test stubs): key on the raw string.
  return addr;
}

/** Full 8-hextet expansion, lowercase, no leading zeros. */
function expandIpv6(addr: string): string[] {
  const toHextets = (parts: string[]): string[] =>
    parts.flatMap((p) => {
      if (!p.includes('.')) return [p];
      // Embedded IPv4 tail (e.g. ::ffff:1.2.3.4 with a non-mapped prefix).
      const [a, b, c, d] = p.split('.').map((n) => Number(n));
      return [((a! << 8) | b!).toString(16), ((c! << 8) | d!).toString(16)];
    });
  let head: string[];
  let tail: string[];
  if (addr.includes('::')) {
    const [h = '', t = ''] = addr.split('::', 2);
    head = toHextets(h ? h.split(':') : []);
    tail = toHextets(t ? t.split(':') : []);
  } else {
    head = toHextets(addr.split(':'));
    tail = [];
  }
  const fill = Array.from({ length: 8 - head.length - tail.length }, () => '0');
  return [...head, ...fill, ...tail].map((h) => parseInt(h === '' ? '0' : h, 16).toString(16));
}

// ---- sliding windows --------------------------------------------------------

/**
 * Per-key timestamp windows. Memory is bounded two ways: denied hits are not
 * recorded (`allow`), so no key grows past its limit, and the key count is
 * capped with oldest-activity eviction, so junk traffic cannot exhaust RAM.
 */
class SlidingWindows {
  private readonly byKey = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly maxKeys: number,
  ) {}

  /** Admit-or-refuse: only admitted hits consume window slots. */
  allow(key: string, nowMs: number, limit: number): { allowed: boolean; retryAfterMs: number } {
    const hits = this.pruned(key, nowMs);
    if (hits.length >= limit) {
      return { allowed: false, retryAfterMs: hits[0]! + this.windowMs - nowMs };
    }
    hits.push(nowMs);
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Unconditional count-up (invalid-lookup budget); returns the new count. */
  record(key: string, nowMs: number): number {
    const hits = this.pruned(key, nowMs);
    hits.push(nowMs);
    return hits.length;
  }

  clear(key: string): void {
    this.byKey.delete(key);
  }

  private pruned(key: string, nowMs: number): number[] {
    let hits = this.byKey.get(key);
    if (!hits) {
      if (this.byKey.size >= this.maxKeys) this.evict(nowMs);
      hits = [];
      this.byKey.set(key, hits);
    }
    const cutoff = nowMs - this.windowMs;
    while (hits.length > 0 && hits[0]! <= cutoff) hits.shift();
    return hits;
  }

  private evict(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    for (const [key, hits] of this.byKey) {
      if (hits.length === 0 || hits[hits.length - 1]! <= cutoff) this.byKey.delete(key);
    }
    if (this.byKey.size < this.maxKeys) return;
    const byActivity = [...this.byKey.entries()].sort(
      (a, b) => (a[1][a[1].length - 1] ?? 0) - (b[1][b[1].length - 1] ?? 0),
    );
    for (const [key] of byActivity.slice(0, Math.ceil(this.maxKeys / 10))) this.byKey.delete(key);
  }
}

// ---- guard ------------------------------------------------------------------

/** The guard's slice of the security taxonomy (docs/security-events.md). */
export type GuardEvent = Extract<
  SecurityEvent,
  {
    tag:
      | 'sec.ban.created'
      | 'sec.ban.expired'
      | 'sec.ban.lifted'
      | 'sec.breaker.opened'
      | 'sec.breaker.half_open'
      | 'sec.breaker.closed';
  }
>;

type BreakerState =
  | { state: 'closed' }
  | { state: 'open'; untilMs: number }
  | { state: 'half_open'; sinceMs: number; invalid: number };

export interface GuardDeps {
  db: Db;
  rate: Config['rate'];
  now: Clock;
  /** Structured security events (§12): ban trips and breaker transitions. */
  onEvent?: (event: GuardEvent) => void;
  /** Bound on distinct IP keys tracked per window (memory cap, not a knob). */
  maxTrackedKeys?: number;
}

export type GuardDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

const MINUTE_MS = 60_000;

export class Guard {
  private readonly bans = new Map<string, { strikes: number; bannedUntilMs: number }>();
  private readonly general: SlidingWindows;
  private readonly invalid: SlidingWindows;
  private breakerHits: number[] = [];
  private breaker: BreakerState = { state: 'closed' };

  constructor(private readonly deps: GuardDeps) {
    const maxKeys = deps.maxTrackedKeys ?? 10_000;
    this.general = new SlidingWindows(MINUTE_MS, maxKeys);
    this.invalid = new SlidingWindows(deps.rate.invalidLookupWindowMinutes * MINUTE_MS, maxKeys);
  }

  /** Rebuild ban state from the database so restarts never amnesty anyone. */
  async init(): Promise<void> {
    const now = this.deps.now();
    const rows = await this.deps.db
      .select({
        ipPrefix: ipBans.ipPrefix,
        strikes: ipBans.strikes,
        bannedUntil: ipBans.bannedUntil,
      })
      .from(ipBans)
      .where(gt(ipBans.bannedUntil, now));
    for (const row of rows) {
      this.bans.set(row.ipPrefix, {
        strikes: row.strikes,
        bannedUntilMs: row.bannedUntil.getTime(),
      });
    }
  }

  keyFor(ip: string): string {
    return ipPrefixOf(ip);
  }

  /**
   * Remaining ban seconds for a key, or null. Constant-time in-memory check:
   * safe to run before any ID lookup so a banned 429 carries no oracle (§12).
   */
  banRemainingSeconds(ipKey: string): number | null {
    const ban = this.bans.get(ipKey);
    if (!ban) return null;
    const nowMs = this.deps.now().getTime();
    if (ban.bannedUntilMs <= nowMs) {
      // Expired: memory only — the DB row keeps the strike count.
      this.bans.delete(ipKey);
      this.emit({ tag: 'sec.ban.expired', ipPrefix: ipKey, strikes: ban.strikes });
      return null;
    }
    return Math.max(1, Math.ceil((ban.bannedUntilMs - nowMs) / 1000));
  }

  /** General unauthenticated cap (~60 req/min per IP). */
  checkGeneral(ipKey: string): GuardDecision {
    const nowMs = this.deps.now().getTime();
    const res = this.general.allow(ipKey, nowMs, this.deps.rate.generalPerMinute);
    if (res.allowed) return { allowed: true };
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(res.retryAfterMs / 1000)) };
  }

  /**
   * Count one not-found on /s/* or /reset/* against the caller's budget and
   * the breaker aggregate. Trips a persisted, escalating ban past the budget.
   */
  async recordInvalidLookup(ipKey: string): Promise<void> {
    const nowMs = this.deps.now().getTime();
    const count = this.invalid.record(ipKey, nowMs);
    if (count > this.deps.rate.invalidLookupBudget) await this.tripBan(ipKey);
    this.recordBreakerHit(nowMs);
  }

  /**
   * Breaker gate for anonymous secret-route traffic. Handles the open →
   * half-open transition on read; half-open closes after a clean minute.
   */
  breakerGate(): GuardDecision {
    const nowMs = this.deps.now().getTime();
    if (this.breaker.state === 'open') {
      if (nowMs < this.breaker.untilMs) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((this.breaker.untilMs - nowMs) / 1000)),
        };
      }
      this.breaker = { state: 'half_open', sinceMs: nowMs, invalid: 0 };
      this.emit({ tag: 'sec.breaker.half_open' });
      return { allowed: true };
    }
    if (this.breaker.state === 'half_open' && nowMs - this.breaker.sinceMs >= MINUTE_MS) {
      this.breaker = { state: 'closed' };
      this.breakerHits = [];
      this.emit({ tag: 'sec.breaker.closed' });
    }
    return { allowed: true };
  }

  /** Drop a ban from memory after the admin's transaction deleted the row. */
  forgetBan(ipKey: string): void {
    const had = this.bans.delete(ipKey);
    this.invalid.clear(ipKey);
    if (had) this.emit({ tag: 'sec.ban.lifted', ipPrefix: ipKey });
  }

  /** Breaker state for the admin guard view. */
  breakerStatus(): { state: BreakerState['state']; retryAfterSeconds?: number } {
    // Let a due transition happen so the view never shows a stale "open".
    this.breakerGate();
    if (this.breaker.state === 'open') {
      const nowMs = this.deps.now().getTime();
      return {
        state: 'open',
        retryAfterSeconds: Math.max(1, Math.ceil((this.breaker.untilMs - nowMs) / 1000)),
      };
    }
    return { state: this.breaker.state };
  }

  private async tripBan(ipKey: string): Promise<void> {
    const now = this.deps.now();
    // The DB row is authoritative for strikes: it survives restarts and
    // outlives expired bans, so escalation cannot be reset by waiting.
    const [existing] = await this.deps.db
      .select({ strikes: ipBans.strikes })
      .from(ipBans)
      .where(eq(ipBans.ipPrefix, ipKey))
      .limit(1);
    const strikes = (existing?.strikes ?? 0) + 1;
    const ladder = this.deps.rate.banLadderMinutes;
    const banMinutes = ladder[Math.min(strikes - 1, ladder.length - 1)]!;
    const bannedUntil = new Date(now.getTime() + banMinutes * MINUTE_MS);
    const reason = 'invalid-lookup budget exceeded';
    await this.deps.db
      .insert(ipBans)
      .values({ ipPrefix: ipKey, strikes, bannedUntil, reason, updatedAt: now })
      .onConflictDoUpdate({
        target: ipBans.ipPrefix,
        set: { strikes, bannedUntil, reason, updatedAt: now },
      });
    this.bans.set(ipKey, { strikes, bannedUntilMs: bannedUntil.getTime() });
    this.invalid.clear(ipKey);
    this.emit({
      tag: 'sec.ban.created',
      ipPrefix: ipKey,
      strikes,
      banMinutes,
      bannedUntil: bannedUntil.toISOString(),
    });
  }

  private recordBreakerHit(nowMs: number): void {
    if (this.breaker.state === 'open') return;
    if (this.breaker.state === 'half_open') {
      this.breaker.invalid += 1;
      if (this.breaker.invalid >= this.halfOpenTolerance()) {
        this.openBreaker(nowMs, 'half_open_failed');
      }
      return;
    }
    const cutoff = nowMs - MINUTE_MS;
    while (this.breakerHits.length > 0 && this.breakerHits[0]! <= cutoff) this.breakerHits.shift();
    this.breakerHits.push(nowMs);
    if (this.breakerHits.length > this.deps.rate.breakerInvalidPerMinute) {
      this.openBreaker(nowMs, 'invalid_rate');
    }
  }

  /** Invalid lookups tolerated while half-open before re-opening. */
  private halfOpenTolerance(): number {
    return Math.max(1, Math.ceil(this.deps.rate.breakerInvalidPerMinute / 10));
  }

  private openBreaker(nowMs: number, reason: 'invalid_rate' | 'half_open_failed'): void {
    const cooldownSeconds = this.deps.rate.breakerCooldownSeconds;
    this.breaker = { state: 'open', untilMs: nowMs + cooldownSeconds * 1000 };
    this.breakerHits = [];
    this.emit({ tag: 'sec.breaker.opened', reason, cooldownSeconds });
  }

  private emit(event: GuardEvent): void {
    this.deps.onEvent?.(event);
  }
}

// ---- blocked response -------------------------------------------------------

/**
 * The single 429 body for guard-blocked secret routes. Sent before any ID
 * lookup, so valid and invalid links produce byte-identical responses with
 * an identical timing profile (definition of a closed oracle, §12).
 */
export const GUARD_BLOCKED_HTML = html`<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex, nofollow" />
      <title>Too many requests · snapping-turtle</title>
    </head>
    <body>
      <main>
        <h1>Too many requests</h1>
        <p>Try again later.</p>
      </main>
    </body>
  </html> `;

const GUARD_BLOCKED_BYTES = Buffer.from(GUARD_BLOCKED_HTML, 'utf8');

export function sendGuardBlocked(reply: FastifyReply, retryAfterSeconds: number): FastifyReply {
  return reply
    .code(429)
    .type('text/html; charset=utf-8')
    .header('Retry-After', String(retryAfterSeconds))
    .header('Content-Length', GUARD_BLOCKED_BYTES.length)
    .send(GUARD_BLOCKED_BYTES);
}
