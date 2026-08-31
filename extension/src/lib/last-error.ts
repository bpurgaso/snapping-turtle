/**
 * The most recent capture failure, kept in storage.local so the popup can show
 * it on next open. Exists because a notification is the only channel on the
 * keyboard-shortcut path, and the OS (Do Not Disturb, Focus, muted browser)
 * can swallow notifications without the extension ever knowing.
 * Pure helpers here; storage and badge plumbing in failure-flag.ts.
 */

export const LAST_ERROR_KEY = 'lastError';

export interface LastError {
  message: string;
  /** Epoch milliseconds. */
  at: number;
}

const MAX_MESSAGE = 300;

export function parseLastError(raw: unknown): LastError | null {
  if (!raw || typeof raw !== 'object') return null;
  const { message, at } = raw as Record<string, unknown>;
  if (typeof message !== 'string' || !message.trim() || typeof at !== 'number' || !isFinite(at)) {
    return null;
  }
  return { message: message.trim().slice(0, MAX_MESSAGE), at };
}

/** "just now" / "3 min ago" / "2 h ago" / "on 2026-08-30". */
export function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `on ${new Date(at).toISOString().slice(0, 10)}`;
}

export function describeLastError(err: LastError, now: number): string {
  return `Last capture failed ${relativeTime(err.at, now)}: ${err.message}`;
}
