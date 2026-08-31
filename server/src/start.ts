/**
 * Container entrypoint: apply migrations, then serve. Kept separate from
 * main.ts so local dev (which migrates explicitly) never runs DDL on boot.
 *
 * When MIGRATE_DATABASE_URL is set (compose does), migrations run over that
 * privileged connection — the runtime DATABASE_URL role (`st_app`) owns no
 * tables and, per CLAUDE.md rule 7, has no UPDATE/DELETE grant on audit_log,
 * so it could not run DDL even if asked. The privileged connection also
 * re-points st_app's password at the one in DATABASE_URL each boot, which is
 * idempotent and keeps the secret out of the migration files.
 */
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { runMigrations, syncAppRolePassword } from './db/migrate.js';
import { loadEnvFile } from './env.js';
import { startServer } from './main.js';

loadEnvFile();
const config = loadConfig();
const migrateUrl = process.env['MIGRATE_DATABASE_URL'];

if (migrateUrl && migrateUrl !== config.databaseUrl) {
  const privileged = createDb(migrateUrl, { max: 1 });
  try {
    await runMigrations(privileged);
    await syncAppRolePassword(privileged, config.databaseUrl);
  } finally {
    await privileged.close();
  }
  await startServer();
} else {
  const handle = createDb(config.databaseUrl);
  await runMigrations(handle);
  await startServer(handle);
}
