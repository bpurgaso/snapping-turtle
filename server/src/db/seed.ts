import { loadEnvFile } from '../env.js';
import { createDb } from './client.js';
import { runMigrations } from './migrate.js';
import { seedAdmin } from './seed-admin.js';

/**
 * One-time bootstrap CLI: `pnpm --filter server db:seed`.
 * Reads ADMIN_BOOTSTRAP_USER / ADMIN_BOOTSTRAP_PASSWORD, ensures migrations are
 * applied, then creates the admin. The password is never logged.
 */
loadEnvFile();

// Seeding runs migrations first, so it needs the privileged role when the
// runtime role is split off (see start.ts).
const databaseUrl = process.env['MIGRATE_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const username = process.env['ADMIN_BOOTSTRAP_USER'];
const password = process.env['ADMIN_BOOTSTRAP_PASSWORD'];

if (!databaseUrl || !username || !password) {
  console.error('DATABASE_URL, ADMIN_BOOTSTRAP_USER and ADMIN_BOOTSTRAP_PASSWORD are required');
  process.exit(2);
}

const handle = createDb(databaseUrl, { max: 1 });
try {
  await runMigrations(handle);
  const result = await seedAdmin(handle.db, { username, password });
  if (result.settingsInitialised.length > 0) {
    console.log(`settings initialised: ${result.settingsInitialised.join(', ')}`);
  }
  console.log(
    result.adminCreated
      ? `admin "${username}" created`
      : `user "${username}" already exists — left unchanged`,
  );
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await handle.close();
}
