import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { settings, users } from '../../src/db/schema.js';
import { seedAdmin } from '../../src/db/seed-admin.js';
import { verifyPassword } from '../../src/password.js';

/**
 * Requires DATABASE_URL pointing at a throwaway Postgres. The suite drops and
 * recreates the public schema, so never point it at real data.
 */
const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests');

let handle: DbHandle;
beforeAll(async () => {
  handle = createDb(databaseUrl, { max: 2 });
  await handle.sql`drop schema if exists public cascade`;
  await handle.sql`drop schema if exists drizzle cascade`;
  await handle.sql`create schema public`;
});
afterAll(() => handle.close());

describe('migrations', () => {
  it('apply cleanly to an empty database and are idempotent', async () => {
    await runMigrations(handle);
    await runMigrations(handle);
    const tables = await handle.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' order by table_name`;
    expect(tables.map((t) => t.table_name)).toEqual(['settings', 'users']);
  });

  it('enforce the users constraints from PLAN.md §5', async () => {
    const cols = await handle.sql<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns
      where table_name = 'users' order by ordinal_position`;
    expect(cols.map((c) => c.column_name)).toEqual([
      'id',
      'username',
      'password_hash',
      'role',
      'disabled_at',
      'created_at',
    ]);
    expect(cols.find((c) => c.column_name === 'disabled_at')?.is_nullable).toBe('YES');
    expect(cols.find((c) => c.column_name === 'password_hash')?.is_nullable).toBe('NO');
  });
});

describe('seedAdmin', () => {
  const input = { username: 'bootstrap-admin', password: 'integration-test-password-1' };

  it('creates the admin with an argon2id hash and closes registration', async () => {
    const result = await seedAdmin(handle.db, input);
    expect(result).toEqual({ adminCreated: true, settingsInitialised: ['registration_enabled'] });

    const [user] = await handle.db.select().from(users).where(eq(users.username, input.username));
    expect(user?.role).toBe('admin');
    expect(user?.disabledAt).toBeNull();
    expect(user?.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(user!.passwordHash, input.password)).toBe(true);

    const [reg] = await handle.db
      .select()
      .from(settings)
      .where(eq(settings.key, 'registration_enabled'));
    expect(reg?.value).toBe(false);
  });

  it("is idempotent and never rotates an existing user's password", async () => {
    const before = await handle.db.select().from(users).where(eq(users.username, input.username));
    const result = await seedAdmin(handle.db, { ...input, password: 'a-different-password-xyz' });
    expect(result.adminCreated).toBe(false);
    expect(result.settingsInitialised).toEqual([]);
    const after = await handle.db.select().from(users).where(eq(users.username, input.username));
    expect(after).toEqual(before);
    const [row] = await handle.db.select({ count: sql<number>`count(*)::int` }).from(users);
    expect(row?.count).toBe(1);
  });

  it('rejects usernames outside the allowed pattern and short passwords', async () => {
    await expect(
      seedAdmin(handle.db, { username: 'Bad Name', password: input.password }),
    ).rejects.toThrow(/ADMIN_BOOTSTRAP_USER/);
    await expect(seedAdmin(handle.db, { username: 'fine', password: 'short' })).rejects.toThrow(
      /characters/,
    );
  });

  it('enforces unique usernames at the database level', async () => {
    const err: unknown = await handle.db
      .insert(users)
      .values({ username: input.username, passwordHash: 'x', role: 'user' })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(Error);
    // Drizzle wraps driver errors; the Postgres error (23505 unique_violation) is the cause.
    const cause = (err as Error & { cause?: { code?: string } }).cause;
    expect(cause?.code).toBe('23505');
  });
});

describe('GET /healthz against the real database', () => {
  it('returns ok', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      SESSION_SECRET: 'integration-session-secret-not-real-0123456789',
    });
    const app = await buildApp({ config, checks: { database: () => handle.ping() } });
    try {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok', checks: { database: true } });
    } finally {
      await app.close();
    }
  });
});
