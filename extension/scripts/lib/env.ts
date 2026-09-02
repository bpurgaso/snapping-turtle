import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Build inputs shared by build.ts, release.ts and sign-firefox.ts so every
 * artifact of one release is stamped from the same three values:
 *
 *   version      extension/package.json — the single version source for both
 *                manifests, the zip names, the signed .xpi and updates.json
 *   publicOrigin PUBLIC_ORIGIN, else https://$PUBLIC_HOST:$PUBLIC_PORT (the
 *                port omitted only when it is 443 or unset), else the
 *                placeholder (dev builds only; release refuses it). The
 *                derivation mirrors compose's, so the baked-in default server
 *                carries the deployment's published port (PLAN.md §14).
 *   geckoId      EXTENSION_GECKO_ID — the Firefox add-on id. AMO ties signing
 *                to it forever, so a release build requires it explicitly
 *                rather than deriving it from the hostname (which a domain
 *                migration would change).
 *
 * Env is read from the process first, then deploy/.env (ENV_FILE overrides),
 * exactly like the server, so the extension default matches the deployment.
 */

export const pkgRoot = fileURLToPath(new URL('../..', import.meta.url));
export const repoRoot = resolve(pkgRoot, '..');

export const PLACEHOLDER_ORIGIN = 'https://shots.example.com';

export interface BuildInputs {
  version: string;
  publicOrigin: string;
  geckoId?: string;
}

export function loadDeployEnv(): string | undefined {
  for (const envFile of [process.env['ENV_FILE'], join(repoRoot, 'deploy', '.env')]) {
    if (envFile && isFile(envFile)) {
      process.loadEnvFile(envFile);
      return envFile;
    }
  }
  return undefined;
}

export function readVersion(): string {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

export function resolveBuildInputs(env: NodeJS.ProcessEnv = process.env): BuildInputs {
  const geckoId = env['EXTENSION_GECKO_ID'];
  return {
    version: readVersion(),
    publicOrigin: env['PUBLIC_ORIGIN'] ?? deriveOrigin(env['PUBLIC_HOST'], env['PUBLIC_PORT']),
    ...(geckoId ? { geckoId } : {}),
  };
}

/** `https://$PUBLIC_HOST:$PUBLIC_PORT`, exactly as compose derives PUBLIC_ORIGIN. Pure, for tests. */
export function deriveOrigin(host: string | undefined, port: string | undefined): string {
  if (!host) return PLACEHOLDER_ORIGIN;
  const p = port?.trim();
  if (p && !/^[1-9]\d{0,4}$/.test(p)) {
    throw new Error(`PUBLIC_PORT must be a port number, got "${p}"`);
  }
  return p && p !== '443' ? `https://${host}:${p}` : `https://${host}`;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
