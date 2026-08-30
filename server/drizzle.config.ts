import { defineConfig } from 'drizzle-kit';
import { loadEnvFile } from './src/env.js';

loadEnvFile();

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/snapping_turtle',
  },
  strict: true,
  verbose: true,
});
