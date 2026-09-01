import {
  AnnotationDocument,
  BeaconAnnotationsRequest,
  MAX_ANNOTATION_DOC_BYTES,
  PatchCaptureRequest,
  PatchCaptureResponse,
  PutAnnotationsResponse,
  validateAnnotationDocument,
} from '@snapping-turtle/shared';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { AuthHooks } from '../auth/hooks.js';
import type { SessionService } from '../auth/session.js';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { captures } from '../db/schema.js';
import { HttpError } from '../errors.js';
import { VIEW_ID_PATTERN } from '../ids.js';
import type { ImageStore } from '../images/storage.js';
import { logSecurityEvent } from '../security-events.js';
import type { App, Clock } from '../types.js';

export interface OwnerRouteDeps {
  db: Db;
  config: Config;
  store: ImageStore;
  auth: AuthHooks;
  sessions: SessionService;
  now: Clock;
}

const CaptureParams = Type.Object(
  { viewId: Type.String({ minLength: 1, maxLength: 64 }) },
  { additionalProperties: false },
);

/**
 * Owner-only capture routes (§7–§9): annotations load/save and capture
 * management (retention, delete). Ownership is checked server-side on every
 * request and fails closed (CLAUDE.md rule 8) — not even admins annotate
 * someone else's capture. `view_id`s never appear in log lines or error
 * messages (rule 3).
 */
export async function ownerRoutes(app: App, deps: OwnerRouteDeps): Promise<void> {
  const { db, config, store, auth, sessions, now } = deps;

  /** Live capture the current session owns; 404 unknown/expired/deleted, 403 non-owner. */
  async function findOwned(req: FastifyRequest, viewId: string) {
    const notFound = () => new HttpError(404, 'not_found', 'no such capture');
    if (!VIEW_ID_PATTERN.test(viewId)) throw notFound();
    const [row] = await db
      .select({
        id: captures.id,
        ownerId: captures.ownerId,
        width: captures.width,
        height: captures.height,
        createdAt: captures.createdAt,
        annotations: captures.annotations,
        annotationsRev: captures.annotationsRev,
      })
      .from(captures)
      .where(
        and(
          eq(captures.viewId, viewId),
          isNull(captures.deletedAt),
          or(isNull(captures.retentionUntil), gt(captures.retentionUntil, now())),
        ),
      )
      .limit(1);
    if (!row) throw notFound();
    if (row.ownerId !== req.session!.userId) {
      logSecurityEvent(req.log, {
        tag: 'sec.auth.forbidden',
        reason: 'not_owner',
        userId: req.session!.userId,
        ip: req.ip,
        path: `${req.method} /api/v1/captures/…`,
      });
      throw new HttpError(403, 'forbidden', 'only the owner may do this');
    }
    return row;
  }

  /**
   * Validate + persist one annotation document with optimistic concurrency:
   * the client sends the revision it loaded; the UPDATE only lands if that
   * is still the current revision, otherwise 409 and the editor reloads (§9).
   */
  async function saveAnnotations(
    row: Awaited<ReturnType<typeof findOwned>>,
    input: unknown,
  ): Promise<{ rev: number }> {
    const validated = validateAnnotationDocument(input, {
      width: row.width,
      height: row.height,
    });
    if (!validated.ok) throw new HttpError(400, 'bad_request', validated.reason);
    const base = validated.doc.rev;
    const stale = () =>
      new HttpError(409, 'conflict', 'annotations were changed elsewhere; reload and retry');
    if (base !== row.annotationsRev) throw stale();
    const nextRev = base + 1;
    const updated = await db
      .update(captures)
      .set({ annotations: { ...validated.doc, rev: nextRev }, annotationsRev: nextRev })
      .where(
        and(eq(captures.id, row.id), eq(captures.annotationsRev, base), isNull(captures.deletedAt)),
      )
      .returning({ id: captures.id });
    if (updated.length === 0) throw stale();
    return { rev: nextRev };
  }

  app.get(
    '/api/v1/captures/:viewId/annotations',
    {
      preHandler: [auth.requireSession],
      schema: { params: CaptureParams, response: { 200: AnnotationDocument } },
    },
    async (req) => {
      const row = await findOwned(req, req.params.viewId);
      return row.annotations;
    },
  );

  app.put(
    '/api/v1/captures/:viewId/annotations',
    {
      preHandler: [auth.requireSession, auth.requireCsrf],
      // The document is validated in the handler with TypeBox Value.Check
      // (same schema): Ajv's removeAdditional mutates union branches while
      // trying them, which corrupts shape unions — so the body is declared
      // opaque here on purpose, and no unvalidated field survives the check.
      bodyLimit: MAX_ANNOTATION_DOC_BYTES,
      schema: {
        params: CaptureParams,
        body: Type.Unknown(),
        response: { 200: PutAnnotationsResponse },
      },
    },
    async (req) => {
      const row = await findOwned(req, req.params.viewId);
      return saveAnnotations(row, req.body);
    },
  );

  // `navigator.sendBeacon` fallback for saves on unload (§9). A beacon cannot
  // set headers, so the CSRF token travels in the body, and the payload
  // arrives as text/plain — the parser below exists only in this plugin scope.
  app.addContentTypeParser(
    'text/plain',
    { parseAs: 'string', bodyLimit: MAX_ANNOTATION_DOC_BYTES },
    (_req, body, done) => done(null, body),
  );

  app.post(
    '/api/v1/captures/:viewId/annotations',
    {
      preHandler: [auth.requireSession],
      bodyLimit: MAX_ANNOTATION_DOC_BYTES,
      schema: { params: CaptureParams, response: { 200: PutAnnotationsResponse } },
    },
    async (req) => {
      let parsed: unknown = req.body;
      if (typeof parsed === 'string') {
        try {
          parsed = JSON.parse(parsed);
        } catch {
          throw new HttpError(400, 'bad_request', 'body must be JSON');
        }
      }
      if (!Value.Check(BeaconAnnotationsRequest, parsed)) {
        throw new HttpError(400, 'bad_request', 'body must carry csrfToken and document');
      }
      if (!sessions.verifyCsrf(req.session!, parsed.csrfToken)) {
        throw new HttpError(403, 'csrf', 'missing or invalid CSRF token');
      }
      const row = await findOwned(req, req.params.viewId);
      return saveAnnotations(row, parsed.document);
    },
  );

  app.patch(
    '/api/v1/captures/:viewId',
    {
      preHandler: [auth.requireSession, auth.requireCsrf],
      schema: {
        params: CaptureParams,
        body: PatchCaptureRequest,
        response: { 200: PatchCaptureResponse, 204: Type.Null() },
      },
    },
    async (req, reply) => {
      const row = await findOwned(req, req.params.viewId);
      const wantsRetention = req.body.retentionDays !== undefined;
      const wantsDelete = req.body.delete === true;
      if (wantsRetention === wantsDelete) {
        throw new HttpError(400, 'bad_request', 'specify exactly one of retentionDays or delete');
      }

      if (wantsDelete) {
        // Tombstone first (§5): the row survives for trust-and-safety, the
        // image files go now. A failed unlink is logged and swept by M7's purge.
        await db
          .update(captures)
          .set({ deletedAt: now() })
          .where(and(eq(captures.id, row.id), isNull(captures.deletedAt)));
        try {
          await store.remove(row.id);
        } catch (err) {
          req.log.error({ captureId: row.id, err }, 'image removal failed for deleted capture');
        }
        req.log.info({ captureId: row.id, userId: req.session!.userId }, 'capture deleted');
        return reply.code(204).send(null);
      }

      const days = req.body.retentionDays!;
      if (days > config.retentionMaxDaysUser) {
        throw new HttpError(
          400,
          'bad_request',
          `retention may be at most ${config.retentionMaxDaysUser} days`,
        );
      }
      const retentionUntil = new Date(row.createdAt.getTime() + days * 86_400_000);
      await db.update(captures).set({ retentionUntil }).where(eq(captures.id, row.id));
      req.log.info({ captureId: row.id, userId: req.session!.userId, days }, 'retention changed');
      return reply.send({ retentionUntil: retentionUntil.toISOString() });
    },
  );
}
