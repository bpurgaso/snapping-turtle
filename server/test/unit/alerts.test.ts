import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALERT_MIN_INTERVAL_MS,
  alertClassOf,
  buildAlert,
  detailOf,
  GuardAlerter,
  truncateIpPrefix,
  type AlertSummary,
} from '../../src/alerts.js';
import type { GuardEvent } from '../../src/guard.js';

/**
 * Guard alerting (E12, PLAN.md §12): the payload is secret-free against a
 * deny-list, the rate limit coalesces, and delivery failures are observed —
 * logged without the URL — never propagated to the guard.
 */

const BAN: GuardEvent = {
  tag: 'sec.ban.created',
  ipPrefix: '198.51.100.7',
  strikes: 2,
  banMinutes: 60,
  bannedUntil: '2026-10-25T20:00:00.000Z',
};
const BAN_V6: GuardEvent = { ...BAN, ipPrefix: '2001:db8:0:7::/64' };
const OPENED: GuardEvent = {
  tag: 'sec.breaker.opened',
  reason: 'invalid_rate',
  cooldownSeconds: 300,
};
const CLOSED: GuardEvent = { tag: 'sec.breaker.closed' };

/** A logger that captures JSON lines, like the security-events test does. */
function loggedApp() {
  const lines: string[] = [];
  const app = Fastify({
    logger: { level: 'info', stream: { write: (line: string) => void lines.push(line) } } as never,
  });
  return { log: app.log, lines, close: () => app.close() };
}

function fakeFetch(respond: () => Promise<{ ok: boolean; status: number }>) {
  const calls: Array<{ url: string; body: string }> = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body) });
    return respond();
  };
  return { fetch, calls };
}

const WEBHOOK = 'https://discord.example/api/webhooks/1234567890/not-a-real-webhook-token-AbCdEf';

describe('what alerts, and how an address is truncated', () => {
  it('fires on bans and breaker open/close only — never on routine or lazy events', () => {
    expect(alertClassOf(BAN)).toBe('ban');
    expect(alertClassOf(OPENED)).toBe('breaker_opened');
    expect(alertClassOf(CLOSED)).toBe('breaker_closed');
    expect(
      alertClassOf({ tag: 'sec.ban.expired', ipPrefix: '198.51.100.7', strikes: 1 }),
    ).toBeNull();
    expect(alertClassOf({ tag: 'sec.ban.lifted', ipPrefix: '198.51.100.7' })).toBeNull();
    expect(alertClassOf({ tag: 'sec.breaker.half_open' })).toBeNull();
  });

  it('keeps at most a prefix of an address', () => {
    expect(truncateIpPrefix('198.51.100.7')).toBe('198.51.100.x');
    expect(truncateIpPrefix('10.0.0.1')).toBe('10.0.0.x');
    expect(truncateIpPrefix('2001:db8:0:7::/64')).toBe('2001:db8::/32');
    expect(truncateIpPrefix('fe80:0:0:0::/64')).toBe('fe80:0::/32');
    expect(truncateIpPrefix('')).toBe('(redacted)');
    expect(truncateIpPrefix('not-an-ip')).toBe('(redacted)');
  });
});

describe('payload deny-list (CLAUDE.md rule 3 — the endpoint is a third party)', () => {
  const summaries: AlertSummary[] = [
    {
      eventClass: 'ban',
      count: 1,
      firstAt: '2026-10-25T19:00:00.000Z',
      lastAt: '2026-10-25T19:00:00.000Z',
      site: 'shots.example.com:28443',
      detail: detailOf(BAN)!,
    },
    {
      eventClass: 'ban',
      count: 4,
      firstAt: '2026-10-25T19:00:00.000Z',
      lastAt: '2026-10-25T19:09:59.000Z',
      site: 'shots.example.com:28443',
      detail: detailOf(BAN_V6)!,
    },
    {
      eventClass: 'breaker_opened',
      count: 1,
      firstAt: '2026-10-25T19:00:00.000Z',
      lastAt: '2026-10-25T19:00:00.000Z',
      site: 'shots.example.com:28443',
      detail: detailOf(OPENED)!,
    },
    {
      eventClass: 'breaker_closed',
      count: 1,
      firstAt: '2026-10-25T19:06:00.000Z',
      lastAt: '2026-10-25T19:06:00.000Z',
      site: 'shots.example.com:28443',
      detail: detailOf(CLOSED)!,
    },
  ];

  it.each(summaries.map((s) => [s.eventClass, s] as const))(
    'carries no full IP, token, view_id or URL path: %s',
    (_cls, summary) => {
      const body = JSON.stringify(buildAlert(summary));
      // Full IPv4 address (four octets) — the truncated form has three and an "x".
      expect(body).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
      expect(body).not.toContain('198.51.100.7');
      // Full IPv6 /64 key — only the /32 may appear.
      expect(body).not.toContain('2001:db8:0:7');
      expect(body).not.toContain('/64');
      // Secret shapes: a view_id / link token (27 base64url chars), an API token.
      expect(body).not.toMatch(/[A-Za-z0-9_-]{27}/);
      expect(body).not.toMatch(/\bst_[A-Za-z0-9_-]+/);
      // No capability path, no reset path, no cookie or header names.
      expect(body).not.toMatch(/\/s\/|\/reset\/|st_session|authorization/i);
      // Only the one field a webhook needs.
      expect(Object.keys(JSON.parse(body) as object)).toEqual(['content']);
    },
  );

  it('does say what happened, where and how often', () => {
    const text = buildAlert(summaries[1]!).content;
    expect(text).toContain('shots.example.com:28443');
    expect(text).toContain('IP banned');
    expect(text).toContain('4 events coalesced');
    expect(text).toContain('2001:db8::/32');
    expect(text).toContain('strike 2');
    expect(text).toContain('60 min');
    expect(buildAlert(summaries[2]!).content).toContain('invalid_rate');
    expect(buildAlert(summaries[2]!).content).toContain('300 s');
    expect(buildAlert(summaries[3]!).content).toContain('breaker closed');
  });
});

describe('GuardAlerter: rate limit, coalescing, failure isolation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T19:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const flushMicrotasks = () => vi.advanceTimersByTimeAsync(0);

  it('sends the first event of a quiet window at once and coalesces the rest into one trailing summary', async () => {
    const { log, close } = loggedApp();
    const { fetch, calls } = fakeFetch(async () => ({ ok: true, status: 204 }));
    const alerter = new GuardAlerter({
      url: WEBHOOK,
      site: 'shots.example.com:28443',
      now: () => new Date(),
      log,
      fetch,
    });
    alerter.onEvent(BAN); // 19:00:00 → immediate
    await flushMicrotasks();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(WEBHOOK);
    expect(JSON.parse(calls[0]!.body).content).toContain('at 2026-10-25T19:00:00.000Z');

    await vi.advanceTimersByTimeAsync(60_000);
    alerter.onEvent(BAN); // 19:01 → coalesced
    await vi.advanceTimersByTimeAsync(60_000);
    alerter.onEvent({ ...BAN, ipPrefix: '203.0.113.9', strikes: 1, banMinutes: 15 }); // 19:02
    await vi.advanceTimersByTimeAsync(60_000);
    alerter.onEvent(BAN_V6); // 19:03
    expect(calls).toHaveLength(1); // nothing more inside the window

    // The trailing summary lands exactly at the end of the window (19:10).
    await vi.advanceTimersByTimeAsync(ALERT_MIN_INTERVAL_MS - 3 * 60_000 - 1);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    const summary = JSON.parse(calls[1]!.body).content as string;
    expect(summary).toContain(
      '3 events coalesced between 2026-10-25T19:01:00.000Z and 2026-10-25T19:03:00.000Z',
    );
    expect(summary).toContain('2001:db8::/32'); // the latest event's facts
    expect(summary).not.toContain('203.0.113');

    // The next event opens a new window only after another full interval.
    alerter.onEvent(BAN); // 19:10:00 — within the window that just started
    await vi.advanceTimersByTimeAsync(ALERT_MIN_INTERVAL_MS);
    expect(calls).toHaveLength(3);
    alerter.close();
    await close();
  });

  it('rate-limits per event class: a ban and a breaker transition in the same minute are two messages', async () => {
    const { log, close } = loggedApp();
    const { fetch, calls } = fakeFetch(async () => ({ ok: true, status: 204 }));
    const alerter = new GuardAlerter({
      url: WEBHOOK,
      site: 'shots.example.com:28443',
      now: () => new Date(),
      log,
      fetch,
    });
    alerter.onEvent(BAN);
    alerter.onEvent(OPENED);
    alerter.onEvent(BAN); // coalesced into the ban class
    await flushMicrotasks();
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    alerter.onEvent(CLOSED); // a third class: the all-clear goes out at once
    await flushMicrotasks();
    expect(calls).toHaveLength(3);
    expect(JSON.parse(calls[2]!.body).content).toContain('breaker closed');
    alerter.close();
    await close();
  });

  it('a refused or failed delivery is one warn line without the URL, and never throws into the guard', async () => {
    const { log, lines, close } = loggedApp();
    let mode: 'refuse' | 'throw' = 'refuse';
    const { fetch } = fakeFetch(async () => {
      if (mode === 'throw') throw new TypeError(`fetch failed: ${WEBHOOK}`);
      return { ok: false, status: 429 };
    });
    const alerter = new GuardAlerter({
      url: WEBHOOK,
      site: 'shots.example.com:28443',
      now: () => new Date(),
      log,
      fetch,
      minIntervalMs: 0, // every event delivers, so both failure modes are observed
    });
    expect(() => alerter.onEvent(BAN)).not.toThrow();
    await flushMicrotasks();
    mode = 'throw';
    expect(() => alerter.onEvent(OPENED)).not.toThrow();
    await flushMicrotasks();
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const failures = parsed.filter((l) => l['tag'] === 'sec.alert.delivery_failed');
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatchObject({ level: 40, eventClass: 'ban', status: 429 });
    expect(failures[1]).toMatchObject({ level: 40, eventClass: 'breaker_opened', status: null });
    const blob = lines.join('');
    expect(blob).not.toContain(WEBHOOK);
    expect(blob).not.toContain('not-a-real-webhook-token');
    expect(blob).not.toContain('discord.example');
    expect(blob).toContain('guard alerting: webhook configured');
    alerter.close();
    await close();
  });

  it('onEvent returns before delivery completes (an observer, not a dependency)', async () => {
    const { log, close } = loggedApp();
    let resolve!: (v: { ok: boolean; status: number }) => void;
    const { fetch, calls } = fakeFetch(() => new Promise((r) => (resolve = r)));
    const alerter = new GuardAlerter({
      url: WEBHOOK,
      site: 'shots.example.com:28443',
      now: () => new Date(),
      log,
      fetch,
    });
    const started = Date.now();
    alerter.onEvent(BAN);
    expect(Date.now() - started).toBe(0); // no await inside onEvent
    await flushMicrotasks();
    expect(calls).toHaveLength(1);
    resolve({ ok: true, status: 204 });
    alerter.close();
    await close();
  });
});
