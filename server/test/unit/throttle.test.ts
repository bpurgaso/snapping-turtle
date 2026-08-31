import { describe, expect, it } from 'vitest';
import { LoginThrottle } from '../../src/auth/throttle.js';

function make(overrides: Partial<ConstructorParameters<typeof LoginThrottle>[0]> = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const throttle = new LoginThrottle(
    { freeAttempts: 3, baseSeconds: 10, maxSeconds: 3600, ...overrides },
    clock.now,
  );
  return { throttle, clock };
}

describe('LoginThrottle (§11 exponential backoff)', () => {
  it('allows freeAttempts failures, then locks with doubling durations', () => {
    const { throttle, clock } = make();
    expect(throttle.recordFailure('alice')).toBe(0);
    expect(throttle.recordFailure('alice')).toBe(0);
    expect(throttle.recordFailure('alice')).toBe(0);
    expect(throttle.check('alice')).toEqual({ allowed: true });

    expect(throttle.recordFailure('alice')).toBe(10);
    expect(throttle.check('alice')).toEqual({ allowed: false, retryAfterSeconds: 10 });
    clock.advance(10_000);
    expect(throttle.check('alice')).toEqual({ allowed: true });

    expect(throttle.recordFailure('alice')).toBe(20);
    clock.advance(20_000);
    expect(throttle.recordFailure('alice')).toBe(40);
  });

  it('caps the lock at maxSeconds', () => {
    const { throttle, clock } = make({ freeAttempts: 0, baseSeconds: 1000, maxSeconds: 3000 });
    expect(throttle.recordFailure('bob')).toBe(1000);
    clock.advance(1000_000);
    expect(throttle.recordFailure('bob')).toBe(2000);
    clock.advance(2000_000);
    expect(throttle.recordFailure('bob')).toBe(3000);
    clock.advance(3000_000);
    expect(throttle.recordFailure('bob')).toBe(3000);
  });

  it('a success clears the record; accounts are independent', () => {
    const { throttle } = make({ freeAttempts: 0 });
    throttle.recordFailure('carol');
    expect(throttle.check('carol').allowed).toBe(false);
    expect(throttle.check('dave').allowed).toBe(true);
    throttle.recordSuccess('carol');
    expect(throttle.check('carol').allowed).toBe(true);
  });

  it('forgets stale failures after maxSeconds of quiet', () => {
    const { throttle, clock } = make({ freeAttempts: 1, baseSeconds: 5, maxSeconds: 60 });
    throttle.recordFailure('erin');
    clock.advance(61_000);
    // Would have locked on the second failure if the first were still counted.
    expect(throttle.recordFailure('erin')).toBe(0);
  });

  it('bounds tracked usernames so junk logins cannot exhaust memory', () => {
    const { throttle } = make({ freeAttempts: 0, maxEntries: 100 });
    for (let i = 0; i < 1000; i++) throttle.recordFailure(`user-${i}`);
    expect(throttle.check('user-999').allowed).toBe(false);
    const size = (throttle as unknown as { entries: Map<string, unknown> }).entries.size;
    expect(size).toBeLessThanOrEqual(100);
  });
});
