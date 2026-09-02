import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import {
  GUARD_DEFAULTS,
  LOGIN_THROTTLE_DEFAULTS,
  MAX_UPLOAD_MB,
  RETENTION_DEFAULT_DAYS,
  RETENTION_MAX_DAYS_USER,
  TOMBSTONE_RETENTION_DAYS,
} from '@snapping-turtle/shared';
import { defaultExtDir, defaultImagesDir, defaultWebDist } from './paths.js';

/**
 * Typed runtime configuration parsed from the environment (PLAN.md §14).
 * Defaults for anything cross-cutting come from `shared/` so the extension,
 * Caddy and the app cannot drift apart. Unknown env vars are ignored.
 */

const NodeEnv = Type.Union([
  Type.Literal('development'),
  Type.Literal('test'),
  Type.Literal('production'),
]);

export const ConfigSchema = Type.Object({
  nodeEnv: NodeEnv,
  host: Type.String({ minLength: 1 }),
  port: Type.Integer({ minimum: 1, maximum: 65535 }),
  logLevel: Type.Union(
    ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].map((l) => Type.Literal(l)),
  ),
  /**
   * Behind Caddy the client IP arrives in X-Forwarded-For. `true`/`false`, or
   * a list of CIDRs so only connections that actually came from the proxy may
   * assert a client IP — a spoofed header would otherwise let an attacker aim
   * guard bans at other people (§12). Compose pins this to its own subnet.
   */
  trustProxy: Type.Union([Type.Boolean(), Type.Array(Type.String({ minLength: 1 }))]),
  publicOrigin: Type.String({ pattern: '^https?://[^/\\s]+$' }),
  /**
   * The port the deployment publishes (PLAN.md §14). Optional; when set it
   * must equal the effective port of PUBLIC_ORIGIN, so a Caddy listener and
   * the links the app mints can never silently disagree — config drift
   * fails at boot, like the image-pin check fails CI.
   */
  publicPort: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
  databaseUrl: Type.String({ pattern: '^postgres(ql)?://' }),
  /** Signs session cookies and derives CSRF tokens; rotating it logs everyone out. */
  sessionSecret: Type.String({ minLength: 32 }),
  sessionTtlDays: Type.Integer({ minimum: 1, maximum: 3650 }),
  webDistDir: Type.String({ minLength: 1 }),
  /** Signed Firefox .xpi files + updates.json, served read-only at /ext/ (§15, M8). */
  extDir: Type.String({ minLength: 1 }),
  /** Re-encoded originals live here as {shard}/{id}.png (§12). The server chooses every path. */
  imagesDir: Type.String({ minLength: 1 }),
  maxUploadMb: Type.Integer({ minimum: 1, maximum: 1024 }),
  retentionDefaultDays: Type.Integer({ minimum: 1 }),
  retentionMaxDaysUser: Type.Integer({ minimum: 1 }),
  /** Tombstones (deleted or expired captures) are hard-deleted after this many days (§5, §13). */
  tombstoneDays: Type.Integer({ minimum: 1 }),
  /** Per-account login backoff (§11). */
  loginThrottle: Type.Object({
    freeAttempts: Type.Integer({ minimum: 0 }),
    baseSeconds: Type.Integer({ minimum: 1 }),
    maxSeconds: Type.Integer({ minimum: 1 }),
  }),
  rate: Type.Object({
    generalPerMinute: Type.Integer({ minimum: 1 }),
    invalidLookupBudget: Type.Integer({ minimum: 1 }),
    invalidLookupWindowMinutes: Type.Integer({ minimum: 1 }),
    breakerInvalidPerMinute: Type.Integer({ minimum: 1 }),
    /** Seconds the breaker stays open before half-open probes (§12). */
    breakerCooldownSeconds: Type.Integer({ minimum: 1 }),
    /** Escalating ban durations per strike, in minutes; the last rung repeats. */
    banLadderMinutes: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1 }),
    /** Latency jitter on uniform /s/* not-found responses (§6). */
    notFoundJitterMinMs: Type.Integer({ minimum: 0 }),
    notFoundJitterMaxMs: Type.Integer({ minimum: 0 }),
  }),
});
export type Config = Static<typeof ConfigSchema>;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

type Env = Record<string, string | undefined>;

function int(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new ConfigError(`${key} must be an integer, got "${raw}"`);
  return n;
}

/** TRUST_PROXY: boolean-ish, or a comma-separated CIDR/address list. */
function trustProxyOf(env: Env, fallback: boolean): boolean | string[] {
  const raw = env['TRUST_PROXY'];
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes'].includes(raw.toLowerCase())) return true;
  if (['0', 'false', 'no'].includes(raw.toLowerCase())) return false;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The port an origin actually uses: explicit, else the scheme default (443 / 80). */
export function effectivePort(origin: string): number | undefined {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return undefined;
  }
  if (url.port !== '') return Number(url.port);
  return url.protocol === 'https:' ? 443 : url.protocol === 'http:' ? 80 : undefined;
}

/** Comma-separated integer list, e.g. RATE_BAN_LADDER_MINUTES=15,60,1440. */
function intList(env: Env, key: string, fallback: readonly number[]): number[] {
  const raw = env[key];
  if (raw === undefined || raw === '') return [...fallback];
  return raw.split(',').map((part) => {
    const n = Number(part.trim());
    if (!Number.isInteger(n)) {
      throw new ConfigError(`${key} must be a comma-separated list of integers, got "${raw}"`);
    }
    return n;
  });
}

/**
 * Build config from an env map. Pure: no process access, so tests pass their
 * own maps. Throws ConfigError listing every violation — without echoing
 * secret values (CLAUDE.md rule 3).
 */
export function loadConfig(env: Env = process.env): Config {
  const nodeEnv = env['NODE_ENV'] ?? 'development';
  const candidate = {
    nodeEnv,
    host: env['HOST'] ?? '0.0.0.0',
    port: int(env, 'PORT', 3000),
    logLevel: env['LOG_LEVEL'] ?? (nodeEnv === 'production' ? 'info' : 'debug'),
    trustProxy: trustProxyOf(env, nodeEnv === 'production'),
    publicOrigin: (env['PUBLIC_ORIGIN'] ?? 'http://localhost:3000').replace(/\/+$/, ''),
    ...(env['PUBLIC_PORT'] ? { publicPort: int(env, 'PUBLIC_PORT', 0) } : {}),
    databaseUrl: env['DATABASE_URL'] ?? '',
    sessionSecret: env['SESSION_SECRET'] ?? '',
    sessionTtlDays: int(env, 'SESSION_TTL_DAYS', 30),
    webDistDir: env['WEB_DIST_DIR'] ?? defaultWebDist,
    extDir: env['EXT_DIR'] ?? defaultExtDir,
    imagesDir: env['IMAGES_DIR'] ?? defaultImagesDir,
    maxUploadMb: int(env, 'MAX_UPLOAD_MB', MAX_UPLOAD_MB),
    retentionDefaultDays: int(env, 'RETENTION_DEFAULT_DAYS', RETENTION_DEFAULT_DAYS),
    retentionMaxDaysUser: int(env, 'RETENTION_MAX_DAYS_USER', RETENTION_MAX_DAYS_USER),
    tombstoneDays: int(env, 'TOMBSTONE_DAYS', TOMBSTONE_RETENTION_DAYS),
    loginThrottle: {
      freeAttempts: int(env, 'LOGIN_THROTTLE_FREE_ATTEMPTS', LOGIN_THROTTLE_DEFAULTS.freeAttempts),
      baseSeconds: int(env, 'LOGIN_THROTTLE_BASE_SECONDS', LOGIN_THROTTLE_DEFAULTS.baseSeconds),
      maxSeconds: int(env, 'LOGIN_THROTTLE_MAX_SECONDS', LOGIN_THROTTLE_DEFAULTS.maxSeconds),
    },
    rate: {
      generalPerMinute: int(env, 'RATE_GENERAL_PER_MIN', GUARD_DEFAULTS.generalPerMinute),
      invalidLookupBudget: int(
        env,
        'RATE_INVALID_LOOKUP_BUDGET',
        GUARD_DEFAULTS.invalidLookupBudget,
      ),
      invalidLookupWindowMinutes: int(
        env,
        'RATE_INVALID_LOOKUP_WINDOW_MIN',
        GUARD_DEFAULTS.invalidLookupWindowMinutes,
      ),
      breakerInvalidPerMinute: int(
        env,
        'RATE_BREAKER_INVALID_PER_MIN',
        GUARD_DEFAULTS.breakerInvalidPerMinute,
      ),
      breakerCooldownSeconds: int(
        env,
        'RATE_BREAKER_COOLDOWN_SECONDS',
        GUARD_DEFAULTS.breakerCooldownSeconds,
      ),
      banLadderMinutes: intList(env, 'RATE_BAN_LADDER_MINUTES', GUARD_DEFAULTS.banLadderMinutes),
      notFoundJitterMinMs: int(
        env,
        'RATE_NOT_FOUND_JITTER_MIN_MS',
        GUARD_DEFAULTS.notFoundJitterMs.min,
      ),
      notFoundJitterMaxMs: int(
        env,
        'RATE_NOT_FOUND_JITTER_MAX_MS',
        GUARD_DEFAULTS.notFoundJitterMs.max,
      ),
    },
  };

  const errors = Value.Errors(ConfigSchema, candidate).map(
    (e) => `${e.instancePath.replace(/^\//, '').replace(/\//g, '.') || '(root)'}: ${e.message}`,
  );
  if (candidate.publicPort !== undefined) {
    const originPort = effectivePort(candidate.publicOrigin);
    if (originPort !== candidate.publicPort) {
      errors.push(
        `PUBLIC_PORT (${candidate.publicPort}) does not match the port of PUBLIC_ORIGIN` +
          ` (${originPort ?? 'unparseable'}); every generated link derives from PUBLIC_ORIGIN, so it must carry the published port explicitly`,
      );
    }
  }
  if (candidate.retentionDefaultDays > candidate.retentionMaxDaysUser) {
    errors.push('RETENTION_DEFAULT_DAYS must not exceed RETENTION_MAX_DAYS_USER');
  }
  if (candidate.rate.notFoundJitterMinMs > candidate.rate.notFoundJitterMaxMs) {
    errors.push('RATE_NOT_FOUND_JITTER_MIN_MS must not exceed RATE_NOT_FOUND_JITTER_MAX_MS');
  }
  if (candidate.loginThrottle.baseSeconds > candidate.loginThrottle.maxSeconds) {
    errors.push('LOGIN_THROTTLE_BASE_SECONDS must not exceed LOGIN_THROTTLE_MAX_SECONDS');
  }
  if (errors.length > 0) {
    throw new ConfigError(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
  }
  return candidate as Config;
}
