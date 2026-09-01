import { CredentialsRequest, SessionInfo, SetPasswordRequest } from '@snapping-turtle/shared';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { AuthHooks } from '../auth/hooks.js';
import type { SessionService } from '../auth/session.js';
import type { LoginThrottle } from '../auth/throttle.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/client.js';
import { accountLinks, sessions as sessionsTable, users } from '../db/schema.js';
import { isRegistrationEnabled } from '../db/settings.js';
import { HttpError } from '../errors.js';
import type { Guard } from '../guard.js';
import { LINK_TOKEN_PATTERN, secretPrefix, sha256Hex } from '../ids.js';
import { hashPassword, verifyPassword } from '../password.js';
import { logSecurityEvent } from '../security-events.js';
import type { App, Clock } from '../types.js';

export interface AuthRouteDeps {
  db: Db;
  sessions: SessionService;
  throttle: LoginThrottle;
  auth: AuthHooks;
  /** Guessed set-password tokens count against the invalid-lookup budget (§12). */
  guard: Guard;
  now: Clock;
}

/** POST /api/v1/auth/{signup,login,logout,set-password}, GET /api/v1/auth/me (§8, §11). */
export async function authRoutes(app: App, deps: AuthRouteDeps): Promise<void> {
  const { db, sessions, throttle, auth, guard, now } = deps;
  // Verified against when the username is unknown so response time does not
  // depend on whether the account exists.
  const decoyHash = await hashPassword(randomBytes(24).toString('base64url'));

  app.post(
    '/api/v1/auth/signup',
    { schema: { body: CredentialsRequest, response: { 201: SessionInfo } } },
    async (req, reply) => {
      if (!(await isRegistrationEnabled(db))) {
        throw new HttpError(403, 'registration_closed', 'registration is closed');
      }
      const passwordHash = await hashPassword(req.body.password);
      const [created] = await db
        .insert(users)
        .values({ username: req.body.username, passwordHash, role: 'user' })
        .onConflictDoNothing({ target: users.username })
        .returning({ id: users.id, username: users.username, role: users.role });
      if (!created) throw new HttpError(409, 'username_taken', 'that username is taken');

      const { token, csrfToken } = await sessions.create(created.id);
      sessions.setCookies(reply, token, csrfToken);
      return reply.code(201).send({ username: created.username, role: created.role, csrfToken });
    },
  );

  app.post(
    '/api/v1/auth/login',
    { schema: { body: CredentialsRequest, response: { 200: SessionInfo } } },
    async (req, reply) => {
      const { username, password } = req.body;
      const decision = throttle.check(username);
      if (!decision.allowed) {
        logSecurityEvent(req.log, {
          tag: 'sec.throttle.login',
          username,
          retryAfterSeconds: decision.retryAfterSeconds,
          ip: req.ip,
        });
        throw new HttpError(
          429,
          'throttled',
          'too many failed sign-in attempts; try again later',
          decision.retryAfterSeconds,
        );
      }

      const [user] = await db
        .select({
          id: users.id,
          username: users.username,
          role: users.role,
          passwordHash: users.passwordHash,
          disabledAt: users.disabledAt,
        })
        .from(users)
        .where(eq(users.username, username))
        .limit(1);

      const verified = await verifyPassword(user?.passwordHash ?? decoyHash, password);
      if (!user || !verified || user.disabledAt !== null) {
        const lockSeconds = throttle.recordFailure(username);
        logSecurityEvent(req.log, {
          tag: 'sec.auth.login_failed',
          username,
          lockSeconds,
          ip: req.ip,
        });
        throw new HttpError(401, 'invalid_credentials', 'invalid username or password');
      }
      throttle.recordSuccess(username);

      const { token, csrfToken } = await sessions.create(user.id);
      sessions.setCookies(reply, token, csrfToken);
      return reply.send({ username: user.username, role: user.role, csrfToken });
    },
  );

  app.post(
    '/api/v1/auth/logout',
    { preHandler: [auth.requireSession, auth.requireCsrf] },
    async (req, reply) => {
      await sessions.destroy(req.session!.tokenHash);
      sessions.clearCookies(reply);
      return reply.code(204).send();
    },
  );

  app.get(
    '/api/v1/auth/me',
    { preHandler: [auth.requireSession], schema: { response: { 200: SessionInfo } } },
    async (req) => {
      const { username, role, csrfToken } = req.session!;
      return { username, role, csrfToken };
    },
  );

  /**
   * Consume a one-time set-password link (§11): the token is the
   * authentication (no cookie → no CSRF; CLAUDE.md rule 8 governs
   * cookie-authenticated changes). Consumption, the password write, session
   * revocation and the audit row share one transaction; the conditional
   * UPDATE makes first-use-wins atomic under concurrency. Every failure mode
   * — malformed, unknown, consumed, expired, disabled user — is the same
   * generic 404 and counts against the guard's invalid-lookup budget.
   */
  app.post(
    '/api/v1/auth/set-password',
    { schema: { body: SetPasswordRequest, response: { 200: SessionInfo } } },
    async (req, reply) => {
      const { token, password } = req.body;
      const invalid = async (): Promise<HttpError> => {
        await guard.recordInvalidLookup(guard.keyFor(req.ip));
        logSecurityEvent(req.log, { tag: 'sec.auth.link_rejected', ip: req.ip });
        return new HttpError(404, 'not_found', 'this link is invalid or has expired');
      };
      if (!LINK_TOKEN_PATTERN.test(token)) throw await invalid();

      const passwordHash = await hashPassword(password);
      const consumedAt = now();
      const outcome = await db
        .transaction(async (tx) => {
          const [link] = await tx
            .update(accountLinks)
            .set({ consumedAt })
            .where(
              and(
                eq(accountLinks.tokenHash, sha256Hex(token)),
                isNull(accountLinks.consumedAt),
                gt(accountLinks.expiresAt, consumedAt),
              ),
            )
            .returning({
              id: accountLinks.id,
              userId: accountLinks.userId,
              purpose: accountLinks.purpose,
            });
          if (!link) return undefined;
          const [user] = await tx
            .select({ id: users.id, username: users.username, role: users.role })
            .from(users)
            .where(and(eq(users.id, link.userId), isNull(users.disabledAt)))
            .limit(1);
          // A disabled user's link stays unconsumed: rolling back keeps the
          // row available should the admin re-enable the account.
          if (!user) throw new RollbackDisabled();
          await tx.update(users).set({ passwordHash }).where(eq(users.id, user.id));
          // §11: completing a reset revokes the user's other sessions.
          await tx.delete(sessionsTable).where(eq(sessionsTable.userId, user.id));
          await writeAudit(tx, consumedAt, {
            actorUserId: user.id,
            action: 'auth.set_password',
            targetType: 'user',
            targetId: user.id,
            detail: { purpose: link.purpose, linkId: link.id, token: secretPrefix(token) },
            ip: req.ip,
          });
          return { ...user, linkId: link.id, purpose: link.purpose };
        })
        .catch((err: unknown) => {
          if (err instanceof RollbackDisabled) return undefined;
          throw err;
        });
      if (!outcome) throw await invalid();

      const created = await sessions.create(outcome.id);
      sessions.setCookies(reply, created.token, created.csrfToken);
      logSecurityEvent(req.log, {
        tag: 'sec.auth.link_consumed',
        userId: outcome.id,
        linkId: outcome.linkId,
        purpose: outcome.purpose,
        ip: req.ip,
      });
      return reply.send({
        username: outcome.username,
        role: outcome.role,
        csrfToken: created.csrfToken,
      });
    },
  );
}

/** Control-flow marker: abort the set-password transaction without an error response. */
class RollbackDisabled extends Error {
  override name = 'RollbackDisabled';
}
