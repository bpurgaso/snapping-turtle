/**
 * One capture at a time per background instance (PLAN.md §15): a second
 * request during a ~20 s Chrome stitch is refused with a message instead of
 * scrolling the page out from under the running composite. Pure, so the
 * refusal path is unit-tested; the lock lives in memory, which is exactly the
 * lifetime of the stitch it protects.
 */

export interface CaptureLock {
  /** The release function, or null when another capture holds the lock. */
  acquire(label: string): (() => void) | null;
  /** Label of the running capture, or null. */
  current(): string | null;
}

export function createCaptureLock(): CaptureLock {
  let holder: { label: string; token: symbol } | null = null;
  return {
    acquire(label) {
      if (holder) return null;
      const token = Symbol(label);
      holder = { label, token };
      return () => {
        // A stale release (from a run that already gave up the lock) must not
        // free somebody else's.
        if (holder?.token === token) holder = null;
      };
    },
    current: () => holder?.label ?? null,
  };
}

export function busyMessage(label: string): string {
  return `A ${label} capture is already running. Wait for it to finish (press Esc on the page to cancel a full-page capture) before starting another.`;
}
