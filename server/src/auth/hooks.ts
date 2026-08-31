import { CSRF_HEADER } from '@snapping-turtle/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { Db } from '../db/client.js';
import { apiTokens, users } from '../db/schema.js';
import { HttpError } from '../errors.js';
import { sha256Hex } from '../ids.js';
import type { Clock } from '../types.js';
import type { SessionContext, SessionService } from './session.js';

/** Identity established by a bearer API token (upload routes only). */
export interface ApiAuth {
  userId: number;
  tokenId: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by requireSession. */
    session: SessionContext | null;
    /** Set by requireBearer. */
    apiAuth: ApiAuth | null;
  }
}

export interface AuthHooks {
  /** Cookie session required → 401. */
  requireSession: preHandlerAsyncHookHandler;
  /** Run after requireSession: x-csrf-token must match the session → 403. */
  requireCsrf: preHandlerAsyncHookHandler;
  /** Run after requireSession: admin role required → 403 (CLAUDE.md rule 8). */
  requireAdmin: preHandlerAsyncHookHandler;
  /** Bearer API token required → 401. Never consults cookies (CLAUDE.md rule 8). */
  requireBearer: preHandlerAsyncHookHandler;
}

export function createAuthHooks(db: Db, sessions: SessionService, now: Clock): AuthHooks {
  const requireSession = async (req: FastifyRequest): Promise<void> => {
    const token = sessions.tokenFromRequest(req);
    const session = token ? await sessions.resolve(token) : null;
    if (!session) throw new HttpError(401, 'unauthorized', 'sign in required');
    req.session = session;
  };

  const requireCsrf = async (req: FastifyRequest): Promise<void> => {
    if (!req.session) throw new HttpError(401, 'unauthorized', 'sign in required');
    const presented = req.headers[CSRF_HEADER];
    if (!sessions.verifyCsrf(req.session, Array.isArray(presented) ? undefined : presented)) {
      throw new HttpError(403, 'csrf', 'missing or invalid CSRF token');
    }
  };

  const requireAdmin = async (req: FastifyRequest): Promise<void> => {
    if (!req.session) throw new HttpError(401, 'unauthorized', 'sign in required');
    if (req.session.role !== 'admin') {
      throw new HttpError(403, 'forbidden', 'admin access required');
    }
  };

  const requireBearer = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    const token = match?.[1];
    const auth = token ? await lookupToken(db, token, now) : null;
    if (!auth) {
      reply.header('WWW-Authenticate', 'Bearer realm="snapping-turtle"');
      throw new HttpError(401, 'unauthorized', 'a valid API token is required');
    }
    req.apiAuth = auth;
  };

  return { requireSession, requireCsrf, requireAdmin, requireBearer };
}

/** Active token of a non-disabled user, by hash; records last use. */
async function lookupToken(db: Db, token: string, now: Clock): Promise<ApiAuth | null> {
  const tokenHash = sha256Hex(token);
  const [row] = await db
    .select({ tokenId: apiTokens.id, userId: apiTokens.userId })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(
      and(
        eq(apiTokens.tokenHash, tokenHash),
        isNull(apiTokens.revokedAt),
        isNull(users.disabledAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  await db.update(apiTokens).set({ lastUsedAt: now() }).where(eq(apiTokens.id, row.tokenId));
  return row;
}
