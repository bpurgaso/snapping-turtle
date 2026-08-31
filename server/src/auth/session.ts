import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHmac } from 'node:crypto';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import { newSessionToken, safeEqual, sha256Hex } from '../ids.js';
import type { Clock } from '../types.js';

/**
 * Browser sessions (§8, §11). The cookie holds a random token, signed with
 * SESSION_SECRET; the database holds only its sha256. CSRF tokens are
 * derived from the session (HMAC over the stored hash), so a request must
 * present both the cookie and a header value that only same-origin script
 * could have learned — the double-submit shape, bound to the session.
 */

export const SESSION_COOKIE = 'st_session';
/** Readable by same-origin script so pages can echo it in the CSRF header. */
export const CSRF_COOKIE = 'st_csrf';

export interface SessionContext {
  userId: number;
  username: string;
  role: 'user' | 'admin';
  tokenHash: string;
  csrfToken: string;
}

const TOUCH_INTERVAL_MS = 5 * 60_000;

export class SessionService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly now: Clock,
  ) {}

  async create(userId: number): Promise<{ token: string; csrfToken: string }> {
    const token = newSessionToken();
    const tokenHash = sha256Hex(token);
    const now = this.now();
    await this.db.insert(sessions).values({
      tokenHash,
      userId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + this.config.sessionTtlDays * 86_400_000),
    });
    return { token, csrfToken: this.csrfTokenFor(tokenHash) };
  }

  /** Resolve a raw cookie token; null for unknown, expired, or disabled-user sessions. */
  async resolve(token: string): Promise<SessionContext | null> {
    const tokenHash = sha256Hex(token);
    const now = this.now();
    const [row] = await this.db
      .select({
        userId: users.id,
        username: users.username,
        role: users.role,
        lastSeenAt: sessions.lastSeenAt,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.tokenHash, tokenHash),
          gt(sessions.expiresAt, now),
          isNull(users.disabledAt),
        ),
      )
      .limit(1);
    if (!row) return null;
    if (now.getTime() - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.db
        .update(sessions)
        .set({ lastSeenAt: now })
        .where(and(eq(sessions.tokenHash, tokenHash), lt(sessions.lastSeenAt, now)));
    }
    return {
      userId: row.userId,
      username: row.username,
      role: row.role,
      tokenHash,
      csrfToken: this.csrfTokenFor(tokenHash),
    };
  }

  async destroy(tokenHash: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
  }

  /** Used when a password is reset or a user disabled (§11). */
  async destroyAllForUser(userId: number): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.userId, userId));
  }

  csrfTokenFor(tokenHash: string): string {
    return createHmac('sha256', this.config.sessionSecret)
      .update(`csrf:${tokenHash}`)
      .digest('base64url');
  }

  verifyCsrf(session: SessionContext, presented: string | undefined): boolean {
    return typeof presented === 'string' && safeEqual(session.csrfToken, presented);
  }

  /** Raw token from a valid signed cookie, or undefined. Never throws. */
  tokenFromRequest(req: FastifyRequest): string | undefined {
    const raw = req.cookies[SESSION_COOKIE];
    if (!raw) return undefined;
    const unsigned = req.unsignCookie(raw);
    return unsigned.valid && unsigned.value ? unsigned.value : undefined;
  }

  setCookies(reply: FastifyReply, token: string, csrfToken: string): void {
    const base = {
      path: '/',
      // §8: Secure whenever the deployment is https; local http dev keeps working.
      secure: this.config.publicOrigin.startsWith('https://'),
      sameSite: 'lax' as const,
      maxAge: this.config.sessionTtlDays * 86_400,
    };
    reply.setCookie(SESSION_COOKIE, token, { ...base, httpOnly: true, signed: true });
    reply.setCookie(CSRF_COOKIE, csrfToken, { ...base, httpOnly: false });
  }

  clearCookies(reply: FastifyReply): void {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    reply.clearCookie(CSRF_COOKIE, { path: '/' });
  }
}
