import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Build inputs shared by build.ts, release.ts and sign-firefox.ts so every
 * artifact of one release is stamped from the same three values:
 *
 *   version      extension/package.json — the single version source for both
 *                manifests, the zip names, the signed .xpi and updates.json
 *   publicOrigin PUBLIC_ORIGIN, else https://$PUBLIC_HOST, else the
 *                placeholder (dev builds only; release refuses it)
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
  const publicOrigin =
    env['PUBLIC_ORIGIN'] ??
    (env['PUBLIC_HOST'] ? `https://${env['PUBLIC_HOST']}` : PLACEHOLDER_ORIGIN);
  const geckoId = env['EXTENSION_GECKO_ID'];
  return { version: readVersion(), publicOrigin, ...(geckoId ? { geckoId } : {}) };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
