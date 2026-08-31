import { CredentialsRequest, SessionInfo } from '@snapping-turtle/shared';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { AuthHooks } from '../auth/hooks.js';
import type { SessionService } from '../auth/session.js';
import type { LoginThrottle } from '../auth/throttle.js';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import { isRegistrationEnabled } from '../db/settings.js';
import { HttpError } from '../errors.js';
import { hashPassword, verifyPassword } from '../password.js';
import type { App } from '../types.js';

export interface AuthRouteDeps {
  db: Db;
  sessions: SessionService;
  throttle: LoginThrottle;
  auth: AuthHooks;
}

/** POST /api/v1/auth/{signup,login,logout}, GET /api/v1/auth/me (§8, §11). */
export async function authRoutes(app: App, deps: AuthRouteDeps): Promise<void> {
  const { db, sessions, throttle, auth } = deps;
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
        req.log.info({ username, lockSeconds }, 'login failed');
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
}
