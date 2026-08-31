import { describe, expect, it } from 'vitest';
import {
  CAPTURE_TILE_INTERVAL_MS,
  GUARD_DEFAULTS,
  LOGIN_THROTTLE_DEFAULTS,
  MAX_IMAGE_HEIGHT_PX,
  MAX_SOURCE_URL_LENGTH,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_MB,
  PASSWORD_MIN_LENGTH,
  USERNAME_PATTERN,
  VIEW_ID_BYTES,
  VIEW_ID_LENGTH,
} from '../src/index.js';

describe('cross-cutting constants', () => {
  it('pins the values PLAN.md commits to', () => {
    expect(MAX_IMAGE_HEIGHT_PX).toBe(32_000);
    expect(MAX_UPLOAD_MB).toBe(30);
    expect(MAX_UPLOAD_BYTES).toBe(30 * 1024 * 1024);
    // Chrome throttles captureVisibleTab to ~2/s; anything faster drops tiles.
    expect(CAPTURE_TILE_INTERVAL_MS).toBeGreaterThanOrEqual(500);
  });

  it('view_id entropy matches its base64url length', () => {
    expect(VIEW_ID_BYTES).toBeGreaterThanOrEqual(20);
    expect(Buffer.alloc(VIEW_ID_BYTES).toString('base64url')).toHaveLength(VIEW_ID_LENGTH);
  });

  it('guard defaults match §12 (5 misses / 10 min, 60 req/min, 100/min breaker, 15m→1h→24h)', () => {
    expect(GUARD_DEFAULTS.invalidLookupBudget).toBe(5);
    expect(GUARD_DEFAULTS.invalidLookupWindowMinutes).toBe(10);
    expect(GUARD_DEFAULTS.generalPerMinute).toBe(60);
    expect(GUARD_DEFAULTS.breakerInvalidPerMinute).toBe(100);
    expect(GUARD_DEFAULTS.banLadderMinutes).toEqual([15, 60, 1440]);
  });
});

describe('account and ingest limits', () => {
  it('pin the §11/§12 values', () => {
    expect(new RegExp(USERNAME_PATTERN).test('alice_1')).toBe(true);
    expect(new RegExp(USERNAME_PATTERN).test('Alice')).toBe(false);
    expect(new RegExp(USERNAME_PATTERN).test('_x')).toBe(false);
    expect(PASSWORD_MIN_LENGTH).toBeGreaterThanOrEqual(12);
    expect(MAX_SOURCE_URL_LENGTH).toBe(2048);
    expect(LOGIN_THROTTLE_DEFAULTS.maxSeconds).toBeGreaterThan(LOGIN_THROTTLE_DEFAULTS.baseSeconds);
    expect(GUARD_DEFAULTS.notFoundJitterMs.max).toBeGreaterThan(
      GUARD_DEFAULTS.notFoundJitterMs.min,
    );
  });
});
