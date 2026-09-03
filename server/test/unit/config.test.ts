import {
  GUARD_DEFAULTS,
  MAX_UPLOAD_MB,
  RETENTION_DEFAULT_DAYS,
  TOMBSTONE_RETENTION_DAYS,
} from '@snapping-turtle/shared';
import { describe, expect, it } from 'vitest';
import { ConfigError, effectivePort, loadConfig } from '../../src/config.js';

const minimal = {
  DATABASE_URL: 'postgres://app:pw@localhost:5432/app',
  SESSION_SECRET: 'unit-test-session-secret-not-real-0123456789',
};

describe('loadConfig', () => {
  it('round-trips shared constants into defaults', () => {
    const cfg = loadConfig(minimal);
    expect(cfg.maxUploadMb).toBe(MAX_UPLOAD_MB);
    expect(cfg.retentionDefaultDays).toBe(RETENTION_DEFAULT_DAYS);
    expect(cfg.tombstoneDays).toBe(TOMBSTONE_RETENTION_DAYS);
    expect(cfg.rate.generalPerMinute).toBe(GUARD_DEFAULTS.generalPerMinute);
    expect(cfg.rate.invalidLookupBudget).toBe(GUARD_DEFAULTS.invalidLookupBudget);
    expect(cfg.rate.invalidLookupWindowMinutes).toBe(GUARD_DEFAULTS.invalidLookupWindowMinutes);
    expect(cfg.rate.breakerInvalidPerMinute).toBe(GUARD_DEFAULTS.breakerInvalidPerMinute);
    expect(cfg.port).toBe(3000);
    expect(cfg.nodeEnv).toBe('development');
  });

  it('reads TOMBSTONE_DAYS and rejects a non-positive value', () => {
    expect(loadConfig({ ...minimal, TOMBSTONE_DAYS: '7' }).tombstoneDays).toBe(7);
    expect(() => loadConfig({ ...minimal, TOMBSTONE_DAYS: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...minimal, TOMBSTONE_DAYS: 'ninety' })).toThrow(ConfigError);
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

  it('keeps an explicit port in PUBLIC_ORIGIN — every generated URL derives from it', () => {
    const cfg = loadConfig({ ...minimal, PUBLIC_ORIGIN: 'https://shots.example.com:28443/' });
    expect(cfg.publicOrigin).toBe('https://shots.example.com:28443');
    expect(cfg.publicPort).toBeUndefined();
  });

  describe('PUBLIC_PORT must agree with PUBLIC_ORIGIN (config drift fails loudly, §14)', () => {
    it('accepts a matching explicit port and the scheme default', () => {
      expect(
        loadConfig({ ...minimal, PUBLIC_ORIGIN: 'https://shots.example.com:28443', PUBLIC_PORT: '28443' })
          .publicPort,
      ).toBe(28443);
      expect(
        loadConfig({ ...minimal, PUBLIC_ORIGIN: 'https://shots.example.com', PUBLIC_PORT: '443' })
          .publicPort,
      ).toBe(443);
      expect(
        loadConfig({ ...minimal, PUBLIC_ORIGIN: 'http://localhost:3000', PUBLIC_PORT: '3000' })
          .publicPort,
      ).toBe(3000);
      expect(effectivePort('http://app:3000')).toBe(3000);
      expect(effectivePort('http://app')).toBe(80);
      expect(effectivePort('not a url')).toBeUndefined();
    });

    it('refuses to boot when the origin carries a different port, or none', () => {
      expect(() =>
        loadConfig({ ...minimal, PUBLIC_ORIGIN: 'https://shots.example.com:8443', PUBLIC_PORT: '28443' }),
      ).toThrow(/PUBLIC_PORT \(28443\) does not match the port of PUBLIC_ORIGIN \(8443\)/);
      // Compose publishes 28443 but the origin is port-less: links would say :443.
      expect(() =>
        loadConfig({ ...minimal, PUBLIC_ORIGIN: 'https://shots.example.com', PUBLIC_PORT: '28443' }),
      ).toThrow(/PUBLIC_PORT \(28443\) does not match the port of PUBLIC_ORIGIN \(443\)/);
      expect(() => loadConfig({ ...minimal, PUBLIC_PORT: 'high' })).toThrow(/PUBLIC_PORT must be an integer/);
      expect(() => loadConfig({ ...minimal, PUBLIC_PORT: '70000' })).toThrow(/publicPort/);
    });
  });

  it('reads CHROME_EXTENSION_URL only as an https URL; blank means unset (E2)', () => {
    expect(loadConfig(minimal).chromeExtensionUrl).toBeUndefined();
    expect(loadConfig({ ...minimal, CHROME_EXTENSION_URL: '' }).chromeExtensionUrl).toBeUndefined();
    expect(loadConfig({ ...minimal, CHROME_EXTENSION_URL: '   ' }).chromeExtensionUrl).toBeUndefined();
    expect(
      loadConfig({ ...minimal, CHROME_EXTENSION_URL: ' https://chromewebstore.google.com/detail/abc ' })
        .chromeExtensionUrl,
    ).toBe('https://chromewebstore.google.com/detail/abc');
    for (const bad of ['http://chromewebstore.google.com/detail/abc', 'javascript:alert(1)', 'abc']) {
      expect(() => loadConfig({ ...minimal, CHROME_EXTENSION_URL: bad }), bad).toThrow(ConfigError);
    }
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
