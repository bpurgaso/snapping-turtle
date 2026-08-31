import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { users } from '../../src/db/schema.js';
import { loggerOptions } from '../../src/log.js';
import { hashPassword } from '../../src/password.js';

/**
 * Boot the real server for Playwright browser tests (web/playwright.config.ts).
 * With E2E_SEED=1 and a real DATABASE_URL it migrates and upserts one known
 * owner account for the editor smoke test; otherwise it starts exactly like
 * the M0 CSP tests did, with a placeholder DB the static pages never touch.
 * Test-only credentials — obviously fake, never a real deployment's.
 */
export const E2E_OWNER = { username: 'e2e-owner', password: 'e2e-owner-password-not-real-1' };

// Playwright loads pages and assets anonymously in parallel workers; give the
// M5 general cap headroom (config, not a bypass) unless the run overrides it.
process.env['RATE_GENERAL_PER_MIN'] ??= '1000';

const config = loadConfig();
const handle = createDb(config.databaseUrl, { max: 4 });

if (process.env['E2E_SEED'] === '1') {
  await runMigrations(handle);
  const passwordHash = await hashPassword(E2E_OWNER.password);
  await handle.db
    .insert(users)
    .values({ username: E2E_OWNER.username, passwordHash, role: 'user' })
    .onConflictDoUpdate({
      target: users.username,
      set: { passwordHash, disabledAt: null },
    });
}

const app = await buildApp({ config, db: handle.db, logger: loggerOptions(config) });
await app.listen({ host: config.host, port: config.port });
