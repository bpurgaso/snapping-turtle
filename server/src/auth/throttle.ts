/**
 * Per-account login throttling with exponential backoff (§11). In-process
 * state — PLAN.md §2 settles on in-process guard counters for a single node.
 * Keyed by the *attempted* username whether or not it exists, so the
 * throttle's behaviour never reveals which usernames are real.
 */

export interface ThrottleOptions {
  /** Consecutive failures tolerated before the first lock. */
  freeAttempts: number;
  baseSeconds: number;
  maxSeconds: number;
  /** Bound on tracked usernames so junk logins cannot exhaust memory. */
  maxEntries?: number;
}

interface Entry {
  failures: number;
  lockedUntil: number;
  lastFailureAt: number;
}

export type ThrottleDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export class LoginThrottle {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;

  constructor(
    private readonly opts: ThrottleOptions,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.maxEntries = opts.maxEntries ?? 10_000;
  }

  check(key: string): ThrottleDecision {
    const entry = this.live(key);
    if (!entry || entry.lockedUntil <= this.now()) return { allowed: true };
    return { allowed: false, retryAfterSeconds: this.secondsUntil(entry.lockedUntil) };
  }

  /** Record a failed attempt; returns the lock now in force, 0 if none yet. */
  recordFailure(key: string): number {
    const now = this.now();
    const entry = this.live(key) ?? { failures: 0, lockedUntil: 0, lastFailureAt: now };
    entry.failures += 1;
    entry.lastFailureAt = now;
    const over = entry.failures - this.opts.freeAttempts;
    if (over > 0) {
      const seconds = Math.min(
        this.opts.baseSeconds * 2 ** Math.min(over - 1, 30),
        this.opts.maxSeconds,
      );
      entry.lockedUntil = now + seconds * 1000;
    }
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) this.prune();
    this.entries.set(key, entry);
    return entry.lockedUntil > now ? this.secondsUntil(entry.lockedUntil) : 0;
  }

  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  /** Entry if it still counts; stale entries (no lock, no recent failure) are forgotten. */
  private live(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const now = this.now();
    if (entry.lockedUntil <= now && now - entry.lastFailureAt > this.opts.maxSeconds * 1000) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private prune(): void {
    for (const key of [...this.entries.keys()]) this.live(key);
    if (this.entries.size < this.maxEntries) return;
    // Still full: drop the least recently failed entries.
    const byAge = [...this.entries.entries()].sort(
      (a, b) => a[1].lastFailureAt - b[1].lastFailureAt,
    );
    for (const [key] of byAge.slice(0, Math.ceil(this.maxEntries / 10))) this.entries.delete(key);
  }

  private secondsUntil(ts: number): number {
    return Math.max(1, Math.ceil((ts - this.now()) / 1000));
  }
}
