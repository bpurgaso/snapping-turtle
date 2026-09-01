import {
  AdminCaptureListResponse,
  AdminCapturePatchRequest,
  AdminCapturePatchResponse,
  AdminUserListResponse,
  AuditListResponse,
  CreateUserRequest,
  GuardStatusResponse,
  IssuedLinkResponse,
  RegistrationSetting,
  UnbanRequest,
} from '@snapping-turtle/shared';
import { Type } from 'typebox';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { AuthHooks } from '../auth/hooks.js';
import { issueAccountLink, type LinkPurpose } from '../auth/links.js';
import type { Config } from '../config.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/client.js';
import {
  auditLog,
  captures,
  ipBans,
  sessions as sessionsTable,
  settings,
  users,
} from '../db/schema.js';
import { HttpError } from '../errors.js';
import type { Guard } from '../guard.js';
import { secretPrefix } from '../ids.js';
import type { ImageStore } from '../images/storage.js';
import { hashPassword } from '../password.js';
import { logSecurityEvent } from '../security-events.js';
import type { App, Clock } from '../types.js';
import { captureUrls } from '../urls.js';

export interface AdminRouteDeps {
  db: Db;
  config: Config;
  store: ImageStore;
  auth: AuthHooks;
  guard: Guard;
  now: Clock;
}

const PAGE_SIZE = 50;

const IdParams = Type.Object({ id: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
const PageQuery = Type.Object(
  { page: Type.Optional(Type.Integer({ minimum: 1 })) },
  { additionalProperties: false },
);
const CaptureSearchQuery = Type.Object(
  { userId: Type.Integer({ minimum: 1 }), page: Type.Optional(Type.Integer({ minimum: 1 })) },
  { additionalProperties: false },
);

/**
 * The admin panel API (§11). Server-side authz on every route — session +
 * admin role, CSRF on every mutation (CLAUDE.md rule 8) — and every mutation
 * writes its audit row in the same transaction as the change itself (rule
 * 7): if either half fails, both roll back. Audit detail carries internal
 * ids and 8-char secret prefixes only (rule 3).
 */
export async function adminRoutes(app: App, deps: AdminRouteDeps): Promise<void> {
  const { db, config, store, auth, guard, now } = deps;
  const read = { preHandler: [auth.requireSession, auth.requireAdmin] };
  const write = { preHandler: [auth.requireSession, auth.requireAdmin, auth.requireCsrf] };

  /** After the audited transaction committed: the same fact as a `sec.admin.mutation` log line. */
  const mutated = (
    req: { log: FastifyBaseLogger; ip: string; session: { userId: number } | null },
    action: string,
    targetType: string,
    targetId: number | null,
  ) =>
    logSecurityEvent(req.log, {
      tag: 'sec.admin.mutation',
      action,
      actorUserId: req.session!.userId,
      targetType,
      targetId,
      ip: req.ip,
    });

  // ---- settings -------------------------------------------------------------

  app.get(
    '/api/v1/admin/settings',
    { ...read, schema: { response: { 200: RegistrationSetting } } },
    async () => {
      const [row] = await db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, 'registration_enabled'))
        .limit(1);
      return { enabled: row?.value === true };
    },
  );

  app.put(
    '/api/v1/admin/settings/registration',
    { ...write, schema: { body: RegistrationSetting, response: { 200: RegistrationSetting } } },
    async (req) => {
      const enabled = req.body.enabled;
      const at = now();
      await db.transaction(async (tx) => {
        await tx
          .insert(settings)
          .values({ key: 'registration_enabled', value: enabled, updatedAt: at })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value: enabled, updatedAt: at },
          });
        await writeAudit(tx, at, {
          actorUserId: req.session!.userId,
          action: 'settings.registration',
          targetType: 'settings',
          detail: { enabled },
          ip: req.ip,
        });
      });
      mutated(req, 'settings.registration', 'settings', null);
      return { enabled };
    },
  );

  // ---- users ----------------------------------------------------------------

  app.get(
    '/api/v1/admin/users',
    { ...read, schema: { response: { 200: AdminUserListResponse } } },
    async () => {
      const rows = await db
        .select({
          id: users.id,
          username: users.username,
          role: users.role,
          disabledAt: users.disabledAt,
          createdAt: users.createdAt,
          captureCount: sql<number>`count(${captures.id}) filter (where ${captures.deletedAt} is null)::int`,
        })
        .from(users)
        .leftJoin(captures, eq(captures.ownerId, users.id))
        .groupBy(users.id)
        .orderBy(users.id);
      return {
        users: rows.map((u) => ({
          ...u,
          disabledAt: u.disabledAt?.toISOString() ?? null,
          createdAt: u.createdAt.toISOString(),
        })),
      };
    },
  );

  /** Create user + setup link (§11): the whole lifecycle in one mechanism. */
  app.post(
    '/api/v1/admin/users',
    { ...write, schema: { body: CreateUserRequest, response: { 201: IssuedLinkResponse } } },
    async (req, reply) => {
      const { username } = req.body;
      // Unusable placeholder: sign-in is impossible until the link sets a
      // real password. The admin never sees or chooses it (§11).
      const placeholderHash = await hashPassword(randomBytes(32).toString('base64url'));
      const at = now();
      const issued = await db.transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({ username, passwordHash: placeholderHash, role: 'user' })
          .onConflictDoNothing({ target: users.username })
          .returning({ id: users.id });
        if (!user) return undefined;
        const link = await issueAccountLink(tx, now, {
          userId: user.id,
          purpose: 'setup',
          createdBy: req.session!.userId,
        });
        await writeAudit(tx, at, {
          actorUserId: req.session!.userId,
          action: 'user.create',
          targetType: 'user',
          targetId: user.id,
          detail: { username, linkId: link.id, token: secretPrefix(link.token) },
          ip: req.ip,
        });
        return { userId: user.id, link };
      });
      if (!issued) throw new HttpError(409, 'username_taken', 'that username is taken');
      mutated(req, 'user.create', 'user', issued.userId);
      return reply.code(201).send({
        userId: issued.userId,
        username,
        resetUrl: `${config.publicOrigin}/reset/${issued.link.token}`,
        expiresAt: issued.link.expiresAt.toISOString(),
      });
    },
  );

  /** Look a user up or 404 — admin routes may say "no such user" (not secret). */
  async function findUser(id: number) {
    const [user] = await db
      .select({
        id: users.id,
        username: users.username,
        role: users.role,
        disabledAt: users.disabledAt,
      })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    if (!user) throw new HttpError(404, 'not_found', 'no such user');
    return user;
  }

  app.post(
    '/api/v1/admin/users/:id/disable',
    { ...write, schema: { params: IdParams, response: { 204: Type.Null() } } },
    async (req, reply) => {
      const user = await findUser(req.params.id);
      if (user.id === req.session!.userId) {
        throw new HttpError(400, 'bad_request', 'you cannot disable your own account');
      }
      if (user.disabledAt !== null) {
        throw new HttpError(409, 'conflict', 'user is already disabled');
      }
      const at = now();
      await db.transaction(async (tx) => {
        const updated = await tx
          .update(users)
          .set({ disabledAt: at })
          .where(and(eq(users.id, user.id), isNull(users.disabledAt)))
          .returning({ id: users.id });
        if (updated.length === 0) throw new HttpError(409, 'conflict', 'user is already disabled');
        // Disabling revokes sessions immediately (§11); API tokens die via
        // the disabled_at join in every token lookup.
        await tx.delete(sessionsTable).where(eq(sessionsTable.userId, user.id));
        await writeAudit(tx, at, {
          actorUserId: req.session!.userId,
          action: 'user.disable',
          targetType: 'user',
          targetId: user.id,
          detail: { username: user.username },
          ip: req.ip,
        });
      });
      mutated(req, 'user.disable', 'user', user.id);
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/api/v1/admin/users/:id/enable',
    { ...write, schema: { params: IdParams, response: { 204: Type.Null() } } },
    async (req, reply) => {
      const user = await findUser(req.params.id);
      if (user.disabledAt === null) {
        throw new HttpError(409, 'conflict', 'user is not disabled');
      }
      const at = now();
      await db.transaction(async (tx) => {
        await tx.update(users).set({ disabledAt: null }).where(eq(users.id, user.id));
        await writeAudit(tx, at, {
          actorUserId: req.session!.userId,
          action: 'user.enable',
          targetType: 'user',
          targetId: user.id,
          detail: { username: user.username },
          ip: req.ip,
        });
      });
      mutated(req, 'user.enable', 'user', user.id);
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/api/v1/admin/users/:id/reset-link',
    { ...write, schema: { params: IdParams, response: { 201: IssuedLinkResponse } } },
    async (req, reply) => {
      const user = await findUser(req.params.id);
      const at = now();
      const purpose: LinkPurpose = 'reset';
      const link = await db.transaction(async (tx) => {
        const issued = await issueAccountLink(tx, now, {
          userId: user.id,
          purpose,
          createdBy: req.session!.userId,
        });
        await writeAudit(tx, at, {
          actorUserId: req.session!.userId,
          action: 'link.issue',
          targetType: 'account_link',
          targetId: issued.id,
          detail: { userId: user.id, purpose, token: secretPrefix(issued.token) },
          ip: req.ip,
        });
        return issued;
      });
      mutated(req, 'link.issue', 'account_link', link.id);
      return reply.code(201).send({
        userId: user.id,
        username: user.username,
        resetUrl: `${config.publicOrigin}/reset/${link.token}`,
        expiresAt: link.expiresAt.toISOString(),
      });
    },
  );

  // ---- captures -------------------------------------------------------------

  app.get(
    '/api/v1/admin/captures',
    {
      ...read,
      schema: { querystring: CaptureSearchQuery, response: { 200: AdminCaptureListResponse } },
    },
    async (req) => {
      const page = req.query.page ?? 1;
      const where = eq(captures.ownerId, req.query.userId);
      const [count] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(captures)
        .where(where);
      const rows = await db
        .select({
          id: captures.id,
          viewId: captures.viewId,
          sourceUrl: captures.sourceUrl,
          pageTitle: captures.pageTitle,
          width: captures.width,
          height: captures.height,
          bytes: captures.bytes,
          createdAt: captures.createdAt,
          retentionUntil: captures.retentionUntil,
          deletedAt: captures.deletedAt,
        })
        .from(captures)
        .where(where)
        .orderBy(desc(captures.id))
        .limit(PAGE_SIZE)
        .offset((page - 1) * PAGE_SIZE);
      return {
        captures: rows.map((c) => ({
          id: c.id,
          pageUrl: captureUrls(config.publicOrigin, c.viewId).pageUrl,
          sourceUrl: c.sourceUrl,
          pageTitle: c.pageTitle,
          width: c.width,
          height: c.height,
          bytes: c.bytes,
          createdAt: c.createdAt.toISOString(),
          retentionUntil: c.retentionUntil?.toISOString() ?? null,
          deletedAt: c.deletedAt?.toISOString() ?? null,
        })),
        total: count?.total ?? 0,
        page,
        pageSize: PAGE_SIZE,
      };
    },
  );

  /** The "Keep indefinitely" checkbox (§7): NULL retention, admin-only. */
  app.patch(
    '/api/v1/admin/captures/:id',
    {
      ...write,
      schema: {
        params: IdParams,
        body: AdminCapturePatchRequest,
        response: { 200: AdminCapturePatchResponse },
      },
    },
    async (req) => {
      const [row] = await db
        .select({ id: captures.id, createdAt: captures.createdAt })
        .from(captures)
        .where(and(eq(captures.id, req.params.id), isNull(captures.deletedAt)))
        .limit(1);
      if (!row) throw new HttpError(404, 'not_found', 'no such capture');
      const indefinite = req.body.indefinite;
      // Unchecking restores the default window anchored at creation (§13).
      const retentionUntil = indefinite
        ? null
        : new Date(row.createdAt.getTime() + config.retentionDefaultDays * 86_400_000);
      const at = now();
      await db.transaction(async (tx) => {
        await tx.update(captures).set({ retentionUntil }).where(eq(captures.id, row.id));
        await writeAudit(tx, at, {
          actorUserId: req.session!.userId,
          action: 'capture.retention',
          targetType: 'capture',
          targetId: row.id,
          detail: { indefinite },
          ip: req.ip,
        });
      });
      mutated(req, 'capture.retention', 'capture', row.id);
      return { retentionUntil: retentionUntil?.toISOString() ?? null };
    },
  );

  app.delete(
    '/api/v1/admin/captures/:id',
    { ...write, schema: { params: IdParams, response: { 204: Type.Null() } } },
    async (req, reply) => {
      const at = now();
      const deleted = await db.transaction(async (tx) => {
        const rows = await tx
          .update(captures)
          .set({ deletedAt: at })
          .where(and(eq(captures.id, req.params.id), isNull(captures.deletedAt)))
          .returning({ id: captures.id, ownerId: captures.ownerId });
        if (rows.length === 0) return undefined;
        await writeAudit(tx, at, {
          actorUserId: req.session!.userId,
          action: 'capture.delete',
          targetType: 'capture',
          targetId: rows[0]!.id,
          detail: { ownerId: rows[0]!.ownerId },
          ip: req.ip,
        });
        return rows[0];
      });
      if (!deleted) throw new HttpError(404, 'not_found', 'no such capture');
      mutated(req, 'capture.delete', 'capture', deleted.id);
      // Files go after the commit (§5 tombstone rule, same as owner delete);
      // a failed unlink is logged and swept by M7's purge job.
      try {
        await store.remove(deleted.id);
      } catch (err) {
        req.log.error({ captureId: deleted.id, err }, 'image removal failed for deleted capture');
      }
      return reply.code(204).send(null);
    },
  );

  // ---- audit log ------------------------------------------------------------

  app.get(
    '/api/v1/admin/audit',
    { ...read, schema: { querystring: PageQuery, response: { 200: AuditListResponse } } },
    async (req) => {
      const page = req.query.page ?? 1;
      const [count] = await db.select({ total: sql<number>`count(*)::int` }).from(auditLog);
      const rows = await db
        .select({
          id: auditLog.id,
          at: auditLog.at,
          actorUserId: auditLog.actorUserId,
          actor: users.username,
          action: auditLog.action,
          targetType: auditLog.targetType,
          targetId: auditLog.targetId,
          detail: auditLog.detail,
          ip: auditLog.ip,
        })
        .from(auditLog)
        .leftJoin(users, eq(users.id, auditLog.actorUserId))
        .orderBy(desc(auditLog.id))
        .limit(PAGE_SIZE)
        .offset((page - 1) * PAGE_SIZE);
      return {
        entries: rows.map((r) => ({ ...r, at: r.at.toISOString() })),
        total: count?.total ?? 0,
        page,
        pageSize: PAGE_SIZE,
      };
    },
  );

  // ---- guard status ---------------------------------------------------------

  app.get(
    '/api/v1/admin/guard',
    { ...read, schema: { response: { 200: GuardStatusResponse } } },
    async () => {
      const at = now();
      const rows = await db.select().from(ipBans).orderBy(desc(ipBans.updatedAt)).limit(200);
      return {
        breaker: guard.breakerStatus(),
        bans: rows.map((b) => ({
          ipPrefix: b.ipPrefix,
          strikes: b.strikes,
          bannedUntil: b.bannedUntil.toISOString(),
          reason: b.reason,
          updatedAt: b.updatedAt.toISOString(),
          active: b.bannedUntil.getTime() > at.getTime(),
        })),
      };
    },
  );

  /**
   * Unban (§11): an operational necessity — admins will ban themselves while
   * testing. Deletes the row (deliberately forgiving the strike history) and
   * drops the in-memory ban in the same breath.
   */
  app.post(
    '/api/v1/admin/guard/unban',
    { ...write, schema: { body: UnbanRequest, response: { 204: Type.Null() } } },
    async (req, reply) => {
      const at = now();
      const removed = await db.transaction(async (tx) => {
        const rows = await tx
          .delete(ipBans)
          .where(eq(ipBans.ipPrefix, req.body.ipPrefix))
          .returning({ ipPrefix: ipBans.ipPrefix });
        if (rows.length === 0) return false;
        await writeAudit(tx, at, {
          actorUserId: req.session!.userId,
          action: 'guard.unban',
          targetType: 'ip_ban',
          detail: { ipPrefix: req.body.ipPrefix },
          ip: req.ip,
        });
        return true;
      });
      if (!removed) throw new HttpError(404, 'not_found', 'no such ban');
      mutated(req, 'guard.unban', 'ip_ban', null);
      guard.forgetBan(req.body.ipPrefix);
      return reply.code(204).send(null);
    },
  );
}
