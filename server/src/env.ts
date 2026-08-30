import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './paths.js';

/**
 * Load a single `.env` for local development. Production (compose) injects
 * env directly, so this is a no-op there. Search order:
 *   1. $ENV_FILE if set (explicit wins)
 *   2. deploy/.env (the one file both compose and local dev share)
 *   3. .env at the repo root
 * Already-set process env always takes precedence over file values.
 */
export function loadEnvFile(): string | undefined {
  const explicit = process.env['ENV_FILE'];
  const candidates = explicit
    ? [explicit]
    : [join(repoRoot, 'deploy', '.env'), join(repoRoot, '.env')];
  for (const path of candidates) {
    if (existsSync(path)) {
      process.loadEnvFile(path);
      return path;
    }
  }
  return undefined;
}
