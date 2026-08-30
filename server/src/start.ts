/**
 * Container entrypoint: apply migrations, then serve. Kept separate from
 * main.ts so local dev (which migrates explicitly) never runs DDL on boot.
 */
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { loadEnvFile } from './env.js';
import { startServer } from './main.js';

loadEnvFile();
const config = loadConfig();
const handle = createDb(config.databaseUrl);
await runMigrations(handle);
await startServer(handle);
