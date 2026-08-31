import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { loadEnvFile } from '../env.js';
import { migrationsDir } from '../paths.js';
import { createDb, type DbHandle } from './client.js';

/** Apply pending migrations from server/drizzle. Idempotent. */
export async function runMigrations(handle: DbHandle): Promise<void> {
  await migrate(handle.db, { migrationsFolder: migrationsDir });
}

/**
 * Point the `st_app` runtime role's password at whatever the app's
 * DATABASE_URL carries (migration 0002 creates the role without one — a
 * static SQL file cannot hold a secret). Runs on the privileged connection.
 * Role management is lifecycle DDL like the migrations themselves, not data
 * access, so raw SQL is fine here (CLAUDE.md rule 11 governs queries).
 */
export async function syncAppRolePassword(
  privileged: DbHandle,
  appDatabaseUrl: string,
): Promise<void> {
  const url = new URL(appDatabaseUrl);
  const role = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (!role || !password) {
    throw new Error('the app DATABASE_URL must carry a username and password');
  }
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) {
    throw new Error(`app database role "${role}" must be a plain lowercase identifier`);
  }
  const literal = `'${password.replace(/'/g, "''")}'`;
  await privileged.sql.unsafe(`ALTER ROLE "${role}" WITH LOGIN PASSWORD ${literal}`);
}

const isCli =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isCli) {
  loadEnvFile();
  // Migrations prefer the privileged role when the runtime role is split off.
  const url = process.env['MIGRATE_DATABASE_URL'] ?? process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  const handle = createDb(url, { max: 1 });
  try {
    await runMigrations(handle);
    console.log('migrations applied');
  } finally {
    await handle.close();
  }
}
