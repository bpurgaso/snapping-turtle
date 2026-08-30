import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  GUARD_DEFAULTS,
  MAX_UPLOAD_MB,
  RETENTION_DEFAULT_DAYS,
  RETENTION_MAX_DAYS_USER,
} from '@snapping-turtle/shared';
import { defaultWebDist } from './paths.js';

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
  /** Behind Caddy the client IP arrives in X-Forwarded-For; only trust it when told to. */
  trustProxy: Type.Boolean(),
  publicOrigin: Type.String({ pattern: '^https?://[^/\\s]+$' }),
  databaseUrl: Type.String({ pattern: '^postgres(ql)?://' }),
  /** Used by session cookies from M1 on; required now so deployments never start without one. */
  sessionSecret: Type.String({ minLength: 32 }),
  webDistDir: Type.String({ minLength: 1 }),
  maxUploadMb: Type.Integer({ minimum: 1, maximum: 1024 }),
  retentionDefaultDays: Type.Integer({ minimum: 1 }),
  retentionMaxDaysUser: Type.Integer({ minimum: 1 }),
  rate: Type.Object({
    generalPerMinute: Type.Integer({ minimum: 1 }),
    invalidLookupBudget: Type.Integer({ minimum: 1 }),
    invalidLookupWindowMinutes: Type.Integer({ minimum: 1 }),
    breakerInvalidPerMinute: Type.Integer({ minimum: 1 }),
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

function bool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes'].includes(raw.toLowerCase())) return true;
  if (['0', 'false', 'no'].includes(raw.toLowerCase())) return false;
  throw new ConfigError(`${key} must be a boolean, got "${raw}"`);
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
    trustProxy: bool(env, 'TRUST_PROXY', nodeEnv === 'production'),
    publicOrigin: (env['PUBLIC_ORIGIN'] ?? 'http://localhost:3000').replace(/\/+$/, ''),
    databaseUrl: env['DATABASE_URL'] ?? '',
    sessionSecret: env['SESSION_SECRET'] ?? '',
    webDistDir: env['WEB_DIST_DIR'] ?? defaultWebDist,
    maxUploadMb: int(env, 'MAX_UPLOAD_MB', MAX_UPLOAD_MB),
    retentionDefaultDays: int(env, 'RETENTION_DEFAULT_DAYS', RETENTION_DEFAULT_DAYS),
    retentionMaxDaysUser: int(env, 'RETENTION_MAX_DAYS_USER', RETENTION_MAX_DAYS_USER),
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
    },
  };

  const errors = [...Value.Errors(ConfigSchema, candidate)].map(
    (e) => `${e.path.replace(/^\//, '').replace(/\//g, '.') || '(root)'}: ${e.message}`,
  );
  if (candidate.retentionDefaultDays > candidate.retentionMaxDaysUser) {
    errors.push('RETENTION_DEFAULT_DAYS must not exceed RETENTION_MAX_DAYS_USER');
  }
  if (errors.length > 0) {
    throw new ConfigError(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
  }
  return candidate as Config;
}
