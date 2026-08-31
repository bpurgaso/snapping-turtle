import { eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { settings } from './schema.js';

/** Read one runtime setting; `undefined` when the row is missing. */
export async function getSetting(db: Db, key: string): Promise<unknown> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);
  return row?.value;
}

/**
 * Registration gate (§11). Read per request so an admin flipping the row
 * (via SQL until M5's panel exists) takes effect immediately. Anything but
 * a literal `true` is closed — fail closed on a missing or malformed row.
 */
export async function isRegistrationEnabled(db: Db): Promise<boolean> {
  return (await getSetting(db, 'registration_enabled')) === true;
}
