import { describe, expect, it } from 'vitest';
import { describeLastError, parseLastError, relativeTime } from '../src/lib/last-error.js';

const NOW = Date.parse('2026-08-30T12:00:00Z');

describe('parseLastError', () => {
  it('accepts a well-formed entry and trims/caps the message', () => {
    expect(parseLastError({ message: '  boom  ', at: NOW })).toEqual({ message: 'boom', at: NOW });
    expect(parseLastError({ message: 'x'.repeat(1000), at: NOW })?.message).toHaveLength(300);
  });
  it('rejects anything malformed', () => {
    for (const raw of [
      undefined,
      null,
      'boom',
      42,
      {},
      { message: '', at: NOW },
      { message: 'x' },
      { message: 'x', at: 'now' },
      { message: 'x', at: NaN },
    ]) {
      expect(parseLastError(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});

describe('relativeTime / describeLastError', () => {
  it('formats coarse relative times and never negative', () => {
    expect(relativeTime(NOW, NOW)).toBe('just now');
    expect(relativeTime(NOW + 5_000, NOW)).toBe('just now');
    expect(relativeTime(NOW - 59_000, NOW)).toBe('just now');
    expect(relativeTime(NOW - 3 * 60_000, NOW)).toBe('3 min ago');
    expect(relativeTime(NOW - 2 * 3_600_000, NOW)).toBe('2 h ago');
    expect(relativeTime(NOW - 3 * 86_400_000, NOW)).toBe('on 2026-08-27');
  });
  it('prefixes the stored message', () => {
    expect(
      describeLastError(
        { message: 'Could not reach http://localhost:3000.', at: NOW - 120_000 },
        NOW,
      ),
    ).toBe('Last capture failed 2 min ago: Could not reach http://localhost:3000.');
  });
});
