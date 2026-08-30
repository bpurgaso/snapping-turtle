import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as schema from './schema.js';

export type Db = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  sql: Sql;
  /** Cheap liveness probe for /healthz; throws when the database is unreachable. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Create a lazily-connecting Postgres client. All queries go through
 * Drizzle's query builder (CLAUDE.md rule 11); `sql` is exposed only for
 * lifecycle concerns (migrations, ping, close).
 */
export function createDb(databaseUrl: string, opts: { max?: number } = {}): DbHandle {
  const sql = postgres(databaseUrl, {
    max: opts.max ?? 10,
    onnotice: () => {},
    connect_timeout: 10,
  });
  const db = drizzle(sql, { schema });
  return {
    db,
    sql,
    async ping() {
      await sql`select 1`;
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}
