import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { loadEnvFile } from '../env.js';
import { migrationsDir } from '../paths.js';
import { createDb, type DbHandle } from './client.js';

/** Apply pending migrations from server/drizzle. Idempotent. */
export async function runMigrations(handle: DbHandle): Promise<void> {
  await migrate(handle.db, { migrationsFolder: migrationsDir });
}

const isCli =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isCli) {
  loadEnvFile();
  const url = process.env['DATABASE_URL'];
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
