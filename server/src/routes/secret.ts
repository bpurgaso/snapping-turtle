import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import { randomInt } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { SessionService } from '../auth/session.js';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { captures } from '../db/schema.js';
import { NOT_FOUND_HTML, renderCapturePage, type PageAssets } from '../html.js';
import { VIEW_ID_PATTERN } from '../ids.js';
import type { ImageStore } from '../images/storage.js';
import type { App, Clock } from '../types.js';
import { captureUrls } from '../urls.js';

export interface SecretRouteDeps {
  db: Db;
  config: Config;
  store: ImageStore;
  sessions: SessionService;
  now: Clock;
  /** Resolved per request so dev watch builds show up; cached in production by the caller. */
  captureAssets: () => PageAssets;
  /** Bundle for the owner's editor variant of the page (§9). */
  editorAssets: () => PageAssets;
}

const NOT_FOUND_BYTES = Buffer.from(NOT_FOUND_HTML, 'utf8');

/**
 * Uniform not-found (§6, CLAUDE.md rule 2): one status, one header set, one
 * body, for every kind of miss under /s/*, after a random delay so timing
 * carries no signal either. M5's guard counts these; nothing else changes.
 */
export function uniformNotFound(config: Config): (reply: FastifyReply) => Promise<FastifyReply> {
  const { notFoundJitterMinMs: min, notFoundJitterMaxMs: max } = config.rate;
  return async (reply) => {
    const delay = max > min ? randomInt(min, max + 1) : min;
    if (delay > 0) await sleep(delay);
    return reply
      .code(404)
      .type('text/html; charset=utf-8')
      .header('Content-Length', NOT_FOUND_BYTES.length)
      .send(NOT_FOUND_BYTES);
  };
}

/** GET /s/:viewId and GET /s/:viewId/image.png (§6–§8). View-only for everyone in M1. */
export async function secretRoutes(app: App, deps: SecretRouteDeps): Promise<void> {
  const { db, config, store, sessions, now, captureAssets, editorAssets } = deps;
  const notFound = uniformNotFound(config);

  /** Live capture by view_id: not deleted, not expired. Malformed ids skip the query. */
  async function findLive(viewId: string) {
    if (!VIEW_ID_PATTERN.test(viewId)) return undefined;
    const [row] = await db
      .select({
        id: captures.id,
        viewId: captures.viewId,
        ownerId: captures.ownerId,
        sourceUrl: captures.sourceUrl,
        pageTitle: captures.pageTitle,
        width: captures.width,
        height: captures.height,
        createdAt: captures.createdAt,
        retentionUntil: captures.retentionUntil,
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
    return row;
  }

  await app.register(
    async (s) => {
      // Anything under /s/ that is not one of the two routes below is the same 404.
      s.setNotFoundHandler((_req, reply) => notFound(reply));

      s.get<{ Params: { viewId: string } }>('/:viewId', async (req, reply) => {
        const row = await findLive(req.params.viewId);
        if (!row) return notFound(reply);
        // Owner gating (§7): the signed-in owner gets the editor bundle;
        // everyone else — admins included — keeps the M1 view-only page.
        // PUT enforces ownership server-side regardless of what is rendered.
        const token = sessions.tokenFromRequest(req);
        const session = token ? await sessions.resolve(token) : null;
        const isOwner = session !== null && session.userId === row.ownerId;
        const urls = captureUrls(config.publicOrigin, row.viewId);
        const page = renderCapturePage({
          title: row.pageTitle,
          sourceUrl: row.sourceUrl,
          pageUrl: urls.pageUrl,
          imageUrl: urls.imageUrl,
          width: row.width,
          height: row.height,
          createdAt: row.createdAt,
          assets: isOwner ? editorAssets() : captureAssets(),
          ...(isOwner
            ? {
                editor: {
                  viewId: row.viewId,
                  createdAt: row.createdAt.toISOString(),
                  retentionUntil: row.retentionUntil?.toISOString() ?? '',
                  retentionMaxDays: config.retentionMaxDaysUser,
                },
              }
            : {}),
        });
        return reply.type('text/html; charset=utf-8').send(page);
      });

      // M1: the re-encoded original. M4 serves the flat render from this same URL.
      s.get<{ Params: { viewId: string } }>('/:viewId/image.png', async (req, reply) => {
        const row = await findLive(req.params.viewId);
        if (!row) return notFound(reply);
        const file = await store.open(row.id);
        if (!file) {
          req.log.error({ captureId: row.id }, 'image file missing for live capture');
          return notFound(reply);
        }
        return reply
          .type('image/png')
          .header('Content-Length', file.size)
          .header('Content-Disposition', 'inline; filename="capture.png"')
          .header('X-Content-Type-Options', 'nosniff')
          .send(file.stream);
      });
    },
    { prefix: '/s' },
  );
}
