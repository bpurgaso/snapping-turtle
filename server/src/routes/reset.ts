import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { findLiveLink } from '../auth/links.js';
import type { Guard } from '../guard.js';
import { LINK_TOKEN_PATTERN } from '../ids.js';
import type { App, Clock } from '../types.js';
import { uniformNotFound } from './secret.js';

export interface ResetRouteDeps {
  db: Db;
  config: Config;
  guard: Guard;
  now: Clock;
  /** The built set-password page (web/dist/reset.html), or undefined when unbuilt. */
  resetPage: () => string | undefined;
}

/**
 * GET /reset/:token (§8, §11): the set-password page for a live link. The
 * token space must add no enumeration surface (§11), so every miss —
 * malformed, unknown, consumed, expired, disabled user, stray sub-path — is
 * the same uniform 404 as /s/* (byte-identical, jittered) and counts against
 * the guard's invalid-lookup budget. The page itself is identical for every
 * valid token: the token reaches the API only from the URL the user holds.
 */
export async function resetRoutes(app: App, deps: ResetRouteDeps): Promise<void> {
  const { db, config, guard, now, resetPage } = deps;
  const notFound = uniformNotFound(config, (req) =>
    guard.recordInvalidLookup(guard.keyFor(req.ip)),
  );

  await app.register(
    async (s) => {
      s.setNotFoundHandler((req, reply) => notFound(req, reply));

      s.get<{ Params: { token: string } }>('/:token', async (req, reply) => {
        const { token } = req.params;
        if (!LINK_TOKEN_PATTERN.test(token)) return notFound(req, reply);
        const live = await findLiveLink(db, now, token);
        if (!live) return notFound(req, reply);
        const page = resetPage();
        if (!page) {
          return reply
            .code(503)
            .type('text/plain')
            .send('web bundle not built — run `pnpm --filter web build`\n');
        }
        return reply.type('text/html; charset=utf-8').send(page);
      });
    },
    { prefix: '/reset' },
  );
}
