import type { AuthHooks } from '../auth/hooks.js';
import type { App } from '../types.js';

/**
 * GET /api/v1/ping — the cheapest bearer-authenticated target (§8). The
 * extension's options page uses it for "Test connection": a valid, unrevoked
 * token of an enabled user gets 204 (and its last_used_at bumped by
 * requireBearer); anything else is the usual 401. No body, nothing to leak.
 */
export async function pingRoutes(app: App, deps: { auth: AuthHooks }): Promise<void> {
  app.get('/api/v1/ping', { preHandler: [deps.auth.requireBearer] }, async (_req, reply) =>
    reply.code(204).send(),
  );
}
