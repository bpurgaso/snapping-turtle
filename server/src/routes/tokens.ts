import {
  CreateTokenRequest,
  CreateTokenResponse,
  TokenListResponse,
  type TokenSummary,
} from '@snapping-turtle/shared';
import { Type } from 'typebox';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { AuthHooks } from '../auth/hooks.js';
import type { Db } from '../db/client.js';
import { apiTokens } from '../db/schema.js';
import { HttpError } from '../errors.js';
import { newApiToken, sha256Hex } from '../ids.js';
import type { App, Clock } from '../types.js';

export interface TokenRouteDeps {
  db: Db;
  auth: AuthHooks;
  now: Clock;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Personal API token management (§8, §11). Session + CSRF on every mutation. */
export async function tokenRoutes(app: App, deps: TokenRouteDeps): Promise<void> {
  const { db, auth, now } = deps;

  app.get(
    '/api/v1/tokens',
    { preHandler: [auth.requireSession], schema: { response: { 200: TokenListResponse } } },
    async (req) => {
      const rows = await db
        .select({
          id: apiTokens.id,
          name: apiTokens.name,
          createdAt: apiTokens.createdAt,
          lastUsedAt: apiTokens.lastUsedAt,
          revokedAt: apiTokens.revokedAt,
        })
        .from(apiTokens)
        .where(eq(apiTokens.userId, req.session!.userId))
        .orderBy(desc(apiTokens.createdAt), desc(apiTokens.id));
      const tokens: TokenSummary[] = rows.map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: r.createdAt.toISOString(),
        lastUsedAt: iso(r.lastUsedAt),
        revokedAt: iso(r.revokedAt),
      }));
      return { tokens };
    },
  );

  app.post(
    '/api/v1/tokens',
    {
      preHandler: [auth.requireSession, auth.requireCsrf],
      schema: { body: CreateTokenRequest, response: { 201: CreateTokenResponse } },
    },
    async (req, reply) => {
      const token = newApiToken();
      const [row] = await db
        .insert(apiTokens)
        .values({
          userId: req.session!.userId,
          name: req.body.name.trim() || 'token',
          tokenHash: sha256Hex(token),
          createdAt: now(),
        })
        .returning({ id: apiTokens.id, name: apiTokens.name, createdAt: apiTokens.createdAt });
      // The plaintext leaves the server exactly here and is never stored or logged.
      return reply
        .code(201)
        .send({ id: row!.id, name: row!.name, token, createdAt: row!.createdAt.toISOString() });
    },
  );

  app.delete(
    '/api/v1/tokens/:id',
    {
      preHandler: [auth.requireSession, auth.requireCsrf],
      schema: { params: Type.Object({ id: Type.Integer({ minimum: 1 }) }) },
    },
    async (req, reply) => {
      // Owner-scoped update: someone else's token id is indistinguishable from a missing one.
      const revoked = await db
        .update(apiTokens)
        .set({ revokedAt: now() })
        .where(
          and(
            eq(apiTokens.id, req.params.id),
            eq(apiTokens.userId, req.session!.userId),
            isNull(apiTokens.revokedAt),
          ),
        )
        .returning({ id: apiTokens.id });
      if (revoked.length === 0) throw new HttpError(404, 'not_found', 'no such active token');
      return reply.code(204).send();
    },
  );
}
