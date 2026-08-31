import { describe, expect, it } from 'vitest';
import { GUARD_DEFAULTS } from '@snapping-turtle/shared';
import type { Config } from '../../src/config.js';
import { ipPrefixOf } from '../../src/guard.js';

/**
 * Pure guard pieces that need no database: IP keying and the config shape.
 * Window/ban/breaker behavior — which persists bans — lives in the
 * integration suite (guard.test.ts there) against real Postgres with the
 * injected clock; no sleeps anywhere.
 */

describe('ipPrefixOf (§12: IPv4 address, IPv6 /64)', () => {
  it('keys IPv4 addresses individually', () => {
    expect(ipPrefixOf('203.0.113.7')).toBe('203.0.113.7');
    expect(ipPrefixOf('203.0.113.8')).not.toBe(ipPrefixOf('203.0.113.7'));
  });

  it('unwraps IPv4-mapped IPv6 to the IPv4 address', () => {
    expect(ipPrefixOf('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(ipPrefixOf('::FFFF:203.0.113.7')).toBe('203.0.113.7');
  });

  it('groups IPv6 addresses by /64', () => {
    const a = ipPrefixOf('2001:db8:0:0:1:2:3:4');
    const b = ipPrefixOf('2001:db8::dead:beef');
    const c = ipPrefixOf('2001:db8:0:1::1');
    expect(a).toBe('2001:db8:0:0::/64');
    expect(b).toBe(a); // same /64, different interface ids
    expect(c).not.toBe(a); // next /64 over
  });

  it('normalizes case, leading zeros and zone ids', () => {
    expect(ipPrefixOf('2001:0DB8:0000:0000:ffff::1')).toBe('2001:db8:0:0::/64');
    expect(ipPrefixOf('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('keys unknown shapes on the raw string (still bounded, never throws)', () => {
    expect(ipPrefixOf('')).toBe('');
    expect(ipPrefixOf('not-an-ip')).toBe('not-an-ip');
  });
});

describe('guard config defaults', () => {
  it('shared GUARD_DEFAULTS carry the §12 ladder and breaker knobs', () => {
    expect(GUARD_DEFAULTS.banLadderMinutes).toEqual([15, 60, 1440]);
    expect(GUARD_DEFAULTS.breakerCooldownSeconds).toBeGreaterThan(0);
    const rate: Config['rate'] = {
      generalPerMinute: GUARD_DEFAULTS.generalPerMinute,
      invalidLookupBudget: GUARD_DEFAULTS.invalidLookupBudget,
      invalidLookupWindowMinutes: GUARD_DEFAULTS.invalidLookupWindowMinutes,
      breakerInvalidPerMinute: GUARD_DEFAULTS.breakerInvalidPerMinute,
      breakerCooldownSeconds: GUARD_DEFAULTS.breakerCooldownSeconds,
      banLadderMinutes: [...GUARD_DEFAULTS.banLadderMinutes],
      notFoundJitterMinMs: GUARD_DEFAULTS.notFoundJitterMs.min,
      notFoundJitterMaxMs: GUARD_DEFAULTS.notFoundJitterMs.max,
    };
    expect(rate.generalPerMinute).toBe(60);
  });
});
