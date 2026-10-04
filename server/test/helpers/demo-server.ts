import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { apiTokens, users } from '../../src/db/schema.js';
import { newApiToken, sha256Hex } from '../../src/ids.js';
import { loggerOptions } from '../../src/log.js';
import { hashPassword } from '../../src/password.js';

/**
 * Throwaway server for generated store-listing screenshots (E8), driven by
 * extension/scripts/listing-shots.ts the way client-harness.ts is driven by
 * client-linux/scripts/integration.sh: migrate the throwaway DATABASE_URL,
 * upsert one demo owner, mint one API token, boot the real server (buildApp,
 * the production path — the screenshots show the real pages), print ONE JSON
 * line `{ origin, token, username, password }` to stdout and run until
 * SIGTERM/SIGINT.
 *
 * Everything here is obviously fake and lives in a database that is thrown
 * away; the credentials exist so the script can sign in as the owner and
 * photograph the editor. The one consumer is the script that reads stdout.
 */
const OWNER = { username: 'demo-owner', password: 'demo-owner-password-not-real-1' };

const config = loadConfig();
const handle = createDb(config.databaseUrl, { max: 4 });

await runMigrations(handle);
const passwordHash = await hashPassword(OWNER.password);
const [owner] = await handle.db
  .insert(users)
  .values({ username: OWNER.username, passwordHash, role: 'user' })
  .onConflictDoUpdate({ target: users.username, set: { passwordHash, disabledAt: null } })
  .returning({ id: users.id });
const token = newApiToken();
await handle.db
  .insert(apiTokens)
  .values({ userId: owner!.id, name: 'listing screenshots', tokenHash: sha256Hex(token) });

const app = await buildApp({ config, db: handle.db, logger: loggerOptions(config) });
await app.listen({ host: config.host, port: config.port });
process.stdout.write(`${JSON.stringify({ origin: config.publicOrigin, token, ...OWNER })}\n`);

const stop = async () => {
  await app.close();
  await handle.close();
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
