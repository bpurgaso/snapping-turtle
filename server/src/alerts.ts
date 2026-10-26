import type { FastifyBaseLogger } from 'fastify';
import { isIP } from 'node:net';
import type { GuardEvent } from './guard.js';
import { logSecurityEvent } from './security-events.js';
import type { Clock } from './types.js';

/**
 * Guard alerting (PLAN.md §12, E12): the loud guard events — a ban created,
 * the breaker opened, the breaker closed again — posted to one configurable
 * outbound webhook (`ALERT_WEBHOOK_URL`; a Discord webhook is the expected
 * shape) so an enumeration attempt is heard rather than discovered in a log
 * file weeks later. At friends-scale there is deliberately no monitoring
 * stack (§2); this is the whole alert channel.
 *
 * Three rules hold it together:
 *
 * - **An observer, never a dependency.** `onEvent` is synchronous and
 *   delivery is fire-and-forget with a short timeout; a slow, dead or hostile
 *   webhook endpoint cannot delay or block the guard, and a failure is one
 *   `sec.alert.delivery_failed` log line — without the URL, which is itself a
 *   credential (CLAUDE.md rules 3 and 12).
 * - **Its own rate limit.** At most one message per event class per
 *   `ALERT_MIN_INTERVAL_MS`: the first event in a quiet window goes out at
 *   once, later ones in the same window are coalesced into one trailing
 *   summary with a count, so an attack cannot turn the alerter into an
 *   outbound flood against a third party.
 * - **Secret-free by construction.** The payload names the event class, a
 *   count, timestamps, the site's host and the guard's own fields — and the
 *   banned IP only as a truncated prefix (`truncateIpPrefix`). Never a token,
 *   never a view_id, never a full address: the endpoint is a third party, so
 *   rule 3 applies with extra force. `alerts.test.ts` runs the payload
 *   against a deny-list.
 */

export type AlertClass = 'ban' | 'breaker_opened' | 'breaker_closed';

/** One message per class per window; later events in the window coalesce. */
export const ALERT_MIN_INTERVAL_MS = 10 * 60_000;
/** Webhook delivery timeout: the endpoint is outside the trust boundary. */
export const ALERT_TIMEOUT_MS = 5_000;

/**
 * Which guard events alert. Routine throttles never do, nor the lazy
 * `sec.ban.expired`, `sec.ban.lifted` (the admin did that) or half-open
 * probing — only the facts the owner would want interrupted for.
 */
export function alertClassOf(event: GuardEvent): AlertClass | null {
  switch (event.tag) {
    case 'sec.ban.created':
      return 'ban';
    case 'sec.breaker.opened':
      return 'breaker_opened';
    case 'sec.breaker.closed':
      return 'breaker_closed';
    default:
      return null;
  }
}

/**
 * The most an alert may say about an address: an IPv4 address loses its last
 * octet, the guard's IPv6 /64 key is cut to its /32, anything else (test
 * stubs, unix sockets) is replaced wholesale. Enough to tell "my own LAN"
 * from "somewhere else"; never enough to be a full address.
 */
export function truncateIpPrefix(ipPrefix: string): string {
  if (isIP(ipPrefix) === 4) return `${ipPrefix.split('.').slice(0, 3).join('.')}.x`;
  const v6 = /^([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i.exec(ipPrefix);
  if (v6) return `${v6[1]}:${v6[2]}::/32`;
  return '(redacted)';
}

/** The per-class facts an alert carries, built only from guard event fields. */
export type AlertDetail =
  | { kind: 'ban'; ipPrefix: string; strikes: number; banMinutes: number }
  | { kind: 'breaker_opened'; reason: string; cooldownSeconds: number }
  | { kind: 'breaker_closed' };

export interface AlertSummary {
  eventClass: AlertClass;
  /** Events coalesced into this one message (1 when sent immediately). */
  count: number;
  firstAt: string;
  lastAt: string;
  /** The deployment's public host (with port) — not a secret, and it tells two instances apart. */
  site: string;
  /** The latest event's facts, already truncated. */
  detail: AlertDetail;
}

/** Event fields → what the alert may carry about it (truncation happens here, once). */
export function detailOf(event: GuardEvent): AlertDetail | null {
  switch (event.tag) {
    case 'sec.ban.created':
      return {
        kind: 'ban',
        ipPrefix: truncateIpPrefix(event.ipPrefix),
        strikes: event.strikes,
        banMinutes: event.banMinutes,
      };
    case 'sec.breaker.opened':
      return {
        kind: 'breaker_opened',
        reason: event.reason,
        cooldownSeconds: event.cooldownSeconds,
      };
    case 'sec.breaker.closed':
      return { kind: 'breaker_closed' };
    default:
      return null;
  }
}

/** Discord-compatible body; any JSON webhook receiver sees the same one field. */
export interface AlertPayload {
  content: string;
}

const HEADLINE: Record<AlertClass, string> = {
  ban: 'IP banned for enumerating secret links',
  breaker_opened: 'breaker OPEN — distributed enumeration; anonymous secret-link traffic refused',
  breaker_closed: 'breaker closed — normal service resumed',
};

/** Pure: the whole outbound message from a summary. */
export function buildAlert(s: AlertSummary): AlertPayload {
  const lines = [`[snapping-turtle ${s.site}] guard: ${HEADLINE[s.eventClass]}`];
  lines.push(
    s.count === 1
      ? `at ${s.lastAt}`
      : `${s.count} events coalesced between ${s.firstAt} and ${s.lastAt} (latest below)`,
  );
  switch (s.detail.kind) {
    case 'ban':
      lines.push(
        `ip ${s.detail.ipPrefix} · strike ${s.detail.strikes} · banned ${s.detail.banMinutes} min`,
      );
      break;
    case 'breaker_opened':
      lines.push(`reason ${s.detail.reason} · cool-down ${s.detail.cooldownSeconds} s`);
      break;
    case 'breaker_closed':
      break;
  }
  return { content: lines.join('\n') };
}

type Fetch = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;

export interface GuardAlerterDeps {
  url: string;
  site: string;
  now: Clock;
  log: FastifyBaseLogger;
  /** Injectable for tests; production uses the global fetch. */
  fetch?: Fetch;
  minIntervalMs?: number;
}

interface ClassState {
  lastSentMs: number;
  pending: { count: number; firstAt: string; lastAt: string; detail: AlertDetail } | null;
  timer: NodeJS.Timeout | null;
}

export class GuardAlerter {
  private readonly state = new Map<AlertClass, ClassState>();
  private readonly fetch: Fetch;
  private readonly minIntervalMs: number;
  /** Deliveries started — observable for tests; not part of the logic. */
  sent = 0;

  constructor(private readonly deps: GuardAlerterDeps) {
    this.fetch = deps.fetch ?? ((url, init) => fetch(url, init));
    this.minIntervalMs = deps.minIntervalMs ?? ALERT_MIN_INTERVAL_MS;
    // Says that alerting is on, and nothing about where it goes.
    deps.log.info('guard alerting: webhook configured');
  }

  /** Synchronous, never throws, never awaits: the guard's hot path stays untouched. */
  onEvent(event: GuardEvent): void {
    const cls = alertClassOf(event);
    const detail = detailOf(event);
    if (!cls || !detail) return;
    const nowMs = this.deps.now().getTime();
    const at = new Date(nowMs).toISOString();
    const st = this.state.get(cls) ?? { lastSentMs: -Infinity, pending: null, timer: null };
    this.state.set(cls, st);

    if (nowMs - st.lastSentMs >= this.minIntervalMs && !st.pending) {
      st.lastSentMs = nowMs;
      void this.deliver({
        eventClass: cls,
        count: 1,
        firstAt: at,
        lastAt: at,
        site: this.deps.site,
        detail,
      });
      return;
    }
    // Inside the window: coalesce, and arrange one trailing summary at its end.
    if (st.pending) {
      st.pending.count += 1;
      st.pending.lastAt = at;
      st.pending.detail = detail;
    } else {
      st.pending = { count: 1, firstAt: at, lastAt: at, detail };
    }
    if (!st.timer) {
      const delay = Math.max(0, st.lastSentMs + this.minIntervalMs - nowMs);
      st.timer = setTimeout(() => this.flush(cls), delay);
      st.timer.unref?.();
    }
  }

  private flush(cls: AlertClass): void {
    const st = this.state.get(cls);
    if (!st) return;
    st.timer = null;
    const p = st.pending;
    st.pending = null;
    if (!p) return;
    st.lastSentMs = this.deps.now().getTime();
    void this.deliver({ eventClass: cls, site: this.deps.site, ...p });
  }

  /** Drop pending timers so shutdown never waits on an alert window. */
  close(): void {
    for (const st of this.state.values()) {
      if (st.timer) clearTimeout(st.timer);
      st.timer = null;
      st.pending = null;
    }
  }

  private async deliver(summary: AlertSummary): Promise<void> {
    this.sent += 1;
    const body = JSON.stringify(buildAlert(summary));
    // null = network failure or timeout. The error itself is not logged:
    // undici's messages can name the endpoint, and the URL is a credential.
    let status: number | null;
    try {
      const res = await this.fetch(this.deps.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
      });
      if (res.ok) return;
      status = res.status;
    } catch {
      status = null;
    }
    logSecurityEvent(this.deps.log, {
      tag: 'sec.alert.delivery_failed',
      eventClass: summary.eventClass,
      status,
    });
  }
}
