import { GUARD_DEFAULTS, MAX_UPLOAD_MB, RETENTION_DEFAULT_DAYS } from '@snapping-turtle/shared';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config.js';

const minimal = {
  DATABASE_URL: 'postgres://app:pw@localhost:5432/app',
  SESSION_SECRET: 'unit-test-session-secret-not-real-0123456789',
};

describe('loadConfig', () => {
  it('round-trips shared constants into defaults', () => {
    const cfg = loadConfig(minimal);
    expect(cfg.maxUploadMb).toBe(MAX_UPLOAD_MB);
    expect(cfg.retentionDefaultDays).toBe(RETENTION_DEFAULT_DAYS);
    expect(cfg.rate.generalPerMinute).toBe(GUARD_DEFAULTS.generalPerMinute);
    expect(cfg.rate.invalidLookupBudget).toBe(GUARD_DEFAULTS.invalidLookupBudget);
    expect(cfg.rate.invalidLookupWindowMinutes).toBe(GUARD_DEFAULTS.invalidLookupWindowMinutes);
    expect(cfg.rate.breakerInvalidPerMinute).toBe(GUARD_DEFAULTS.breakerInvalidPerMinute);
    expect(cfg.port).toBe(3000);
    expect(cfg.nodeEnv).toBe('development');
  });

  it('honours overrides and strips trailing slashes from PUBLIC_ORIGIN', () => {
    const cfg = loadConfig({
      ...minimal,
      PORT: '4100',
      MAX_UPLOAD_MB: '10',
      PUBLIC_ORIGIN: 'https://shots.example.com/',
      RATE_INVALID_LOOKUP_BUDGET: '3',
      TRUST_PROXY: 'true',
    });
    expect(cfg.port).toBe(4100);
    expect(cfg.maxUploadMb).toBe(10);
    expect(cfg.publicOrigin).toBe('https://shots.example.com');
    expect(cfg.rate.invalidLookupBudget).toBe(3);
    expect(cfg.trustProxy).toBe(true);
  });

  it('refuses to start without a database URL or a strong session secret', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ ...minimal, SESSION_SECRET: 'short' })).toThrow(/sessionSecret/);
    expect(() => loadConfig({ ...minimal, DATABASE_URL: 'mysql://x' })).toThrow(/databaseUrl/);
  });

  it('rejects malformed numbers, out-of-range ports and inverted retention', () => {
    expect(() => loadConfig({ ...minimal, PORT: 'abc' })).toThrow(/PORT must be an integer/);
    expect(() => loadConfig({ ...minimal, PORT: '70000' })).toThrow(/port/);
    expect(() =>
      loadConfig({ ...minimal, RETENTION_DEFAULT_DAYS: '400', RETENTION_MAX_DAYS_USER: '365' }),
    ).toThrow(/RETENTION_DEFAULT_DAYS/);
  });

  it('never echoes the secret value in its error message', () => {
    const secret = 'tooshort';
    expect(() => loadConfig({ ...minimal, SESSION_SECRET: secret })).toThrow(
      expect.not.stringContaining(secret),
    );
  });
});
