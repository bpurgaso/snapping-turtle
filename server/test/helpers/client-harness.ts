import { desc, eq } from 'drizzle-orm';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { apiTokens, captures, users } from '../../src/db/schema.js';
import { newApiToken, sha256Hex } from '../../src/ids.js';
import { loggerOptions } from '../../src/log.js';
import { hashPassword } from '../../src/password.js';

/**
 * Cross-component harness for the native Linux client (M9, PLAN.md §15a),
 * driven by client-linux/scripts/integration.sh:
 *
 *   serve   migrate a throwaway DATABASE_URL, upsert one owner, mint one API
 *           token, boot the real server, print ONE JSON line
 *           `{ origin, token }` to stdout and run until SIGTERM/SIGINT.
 *   check   print the owner's newest capture as JSON
 *           `{ viewId, sourceUrl, pageTitle, width, height, bytes }` (or null).
 *
 * The token is minted per run for a throwaway database and printed exactly
 * once, to the script that consumes it; the credentials below are obviously
 * fake. The server itself is the production build path (buildApp), so the
 * client is exercised against the implemented contract, not a stub.
 */
const OWNER = { username: 'client-owner', password: 'client-owner-password-not-real-1' };

const mode = process.argv[2];
const config = loadConfig();
const handle = createDb(config.databaseUrl, { max: 4 });

if (mode === 'serve') {
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
    .values({ userId: owner!.id, name: 'client-linux integration', tokenHash: sha256Hex(token) });

  const app = await buildApp({ config, db: handle.db, logger: loggerOptions(config) });
  await app.listen({ host: config.host, port: config.port });
  process.stdout.write(`${JSON.stringify({ origin: config.publicOrigin, token })}\n`);

  const stop = async () => {
    await app.close();
    await handle.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
} else if (mode === 'check') {
  const [owner] = await handle.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, OWNER.username));
  const [row] = owner
    ? await handle.db
        .select({
          viewId: captures.viewId,
          sourceUrl: captures.sourceUrl,
          pageTitle: captures.pageTitle,
          width: captures.width,
          height: captures.height,
          bytes: captures.bytes,
          uploadTokenId: captures.uploadTokenId,
        })
        .from(captures)
        .where(eq(captures.ownerId, owner.id))
        .orderBy(desc(captures.id))
        .limit(1)
    : [];
  process.stdout.write(`${JSON.stringify(row ?? null)}\n`);
  await handle.close();
} else {
  process.stderr.write('usage: client-harness.ts serve | check\n');
  process.exit(2);
}
