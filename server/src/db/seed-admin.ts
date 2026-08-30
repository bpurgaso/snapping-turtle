import { eq } from 'drizzle-orm';
import { hashPassword } from '../password.js';
import type { Db } from './client.js';
import { settings, users } from './schema.js';

export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{1,31}$/;

export interface SeedInput {
  username: string;
  password: string;
}

export interface SeedResult {
  adminCreated: boolean;
  settingsInitialised: string[];
}

/** Settings rows every deployment starts with. Registration is closed by default (§11). */
export const DEFAULT_SETTINGS: ReadonlyArray<{ key: string; value: unknown }> = [
  { key: 'registration_enabled', value: false },
];

/**
 * Bootstrap the first admin and default settings (PLAN.md §5, §11). Safe to
 * re-run: an existing username is left untouched (never silently rotated),
 * and existing settings keep their values.
 */
export async function seedAdmin(db: Db, input: SeedInput): Promise<SeedResult> {
  if (!USERNAME_PATTERN.test(input.username)) {
    throw new Error(
      'ADMIN_BOOTSTRAP_USER must be 2–32 chars of lowercase letters, digits, "_", "." or "-"',
    );
  }
  const passwordHash = await hashPassword(input.password);

  return db.transaction(async (tx) => {
    const settingsInitialised: string[] = [];
    for (const row of DEFAULT_SETTINGS) {
      const inserted = await tx
        .insert(settings)
        .values({ key: row.key, value: row.value })
        .onConflictDoNothing()
        .returning({ key: settings.key });
      if (inserted.length > 0) settingsInitialised.push(row.key);
    }

    const existing = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, input.username))
      .limit(1);
    if (existing.length > 0) return { adminCreated: false, settingsInitialised };

    await tx.insert(users).values({ username: input.username, passwordHash, role: 'admin' });
    return { adminCreated: true, settingsInitialised };
  });
}
