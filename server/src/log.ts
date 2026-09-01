import { SECRET_LOG_PREFIX_CHARS } from '@snapping-turtle/shared';
import type { FastifyServerOptions } from 'fastify';
import type { Config } from './config.js';

/**
 * Logging setup that bakes in CLAUDE.md rule 3 from the first commit:
 * secrets never reach the log in full. Capability URLs (`/s/<view_id>`) and
 * set-password links (`/reset/<token>`) are truncated to an 8-char prefix,
 * and credential-bearing headers are redacted outright.
 */

const SECRET_PATH_SEGMENTS = ['s', 'reset'] as const;

/** `/s/AbCdEfGhIjKlMnOpQrStUvWxYz1/image.png` → `/s/AbCdEfGh…/image.png` */
export function redactSecretPath(url: string): string {
  const [path = '', query] = url.split('?', 2);
  const parts = path.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    const segment = parts[i] as string;
    const next = parts[i + 1] as string;
    if ((SECRET_PATH_SEGMENTS as readonly string[]).includes(segment) && next.length > 0) {
      parts[i + 1] = `${next.slice(0, SECRET_LOG_PREFIX_CHARS)}…`;
      i++;
    }
  }
  // Query strings on secret routes are dropped entirely rather than guessed at.
  const touched = parts.join('/') !== path;
  return touched || query === undefined ? parts.join('/') : `${path}?${query}`;
}

/**
 * pino redaction paths (CLAUDE.md rule 3). Credential-bearing headers, plus
 * any object logged with a secret-shaped key one level down (`*.password`,
 * `*.token`, …) — belt and braces over the rule that such objects are never
 * logged in the first place. pino's `*` matches exactly one path segment.
 */
export const REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'password',
  'token',
  'csrfToken',
  'resetUrl',
  'sessionSecret',
  'databaseUrl',
  'migrateDatabaseUrl',
  '*.password',
  '*.token',
  '*.csrfToken',
  '*.resetUrl',
  '*.sessionSecret',
  '*.databaseUrl',
  '*.migrateDatabaseUrl',
  '*.authorization',
  '*.cookie',
  '*["set-cookie"]',
];

export function loggerOptions(config: Config): FastifyServerOptions['logger'] {
  const pretty = config.nodeEnv === 'development';
  return {
    level: config.logLevel,
    redact: {
      paths: [...REDACT_PATHS],
      censor: '[redacted]',
    },
    serializers: {
      req(req: { method: string; url: string; ip?: string; id?: unknown }) {
        return { id: req.id, method: req.method, url: redactSecretPath(req.url), ip: req.ip };
      },
    },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  };
}
