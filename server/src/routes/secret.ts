import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomInt } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { SessionService } from '../auth/session.js';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { captures } from '../db/schema.js';
import type { Guard } from '../guard.js';
import { NOT_FOUND_HTML, renderCapturePage, type PageAssets } from '../html.js';
import { VIEW_ID_PATTERN } from '../ids.js';
import type { FlatRenderer } from '../images/flat.js';
import type { ImageStore } from '../images/storage.js';
import { logSecurityEvent } from '../security-events.js';
import type { App, Clock } from '../types.js';
import { captureUrls } from '../urls.js';

export interface SecretRouteDeps {
  db: Db;
  config: Config;
  store: ImageStore;
  /** Flat composite pipeline for image.png (§10). */
  flat: FlatRenderer;
  sessions: SessionService;
  /** Misses under /s/* count against the invalid-lookup budget (§12). */
  guard: Guard;
  now: Clock;
  /** Resolved per request so dev watch builds show up; cached in production by the caller. */
  captureAssets: () => PageAssets;
  /** Bundle for the owner's editor variant of the page (§9). */
  editorAssets: () => PageAssets;
}

const NOT_FOUND_BYTES = Buffer.from(NOT_FOUND_HTML, 'utf8');

/**
 * Uniform not-found (§6, CLAUDE.md rule 2): one status, one header set, one
 * body, for every kind of miss under /s/* and /reset/*, after a random delay
 * so timing carries no signal either. `onMiss` lets the guard count the miss
 * (M5) — it runs before the jitter and must not vary the response.
 */
export function uniformNotFound(
  config: Config,
  onMiss?: (req: FastifyRequest) => Promise<void>,
): (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply> {
  const { notFoundJitterMinMs: min, notFoundJitterMaxMs: max } = config.rate;
  return async (req, reply) => {
    if (onMiss) await onMiss(req);
    const delay = max > min ? randomInt(min, max + 1) : min;
    if (delay > 0) await sleep(delay);
    return reply
      .code(404)
      .type('text/html; charset=utf-8')
      .header('Content-Length', NOT_FOUND_BYTES.length)
      .send(NOT_FOUND_BYTES);
  };
}

/**
 * Case-insensitive-scheme ETag check per RFC 9110 §13.1.2: a match on any
 * listed value (weak comparison — a `W/` prefix is ignored) or `*`.
 */
export function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header
    .split(',')
    .map((v) => v.trim())
    .some((v) => v === '*' || v === etag || (v.startsWith('W/') && v.slice(2) === etag));
}

/** GET /s/:viewId and GET /s/:viewId/image.png (§6–§8). View-only for everyone in M1. */
export async function secretRoutes(app: App, deps: SecretRouteDeps): Promise<void> {
  const { db, config, store, flat, sessions, guard, now, captureAssets, editorAssets } = deps;
  const notFound = uniformNotFound(config, (req) =>
    guard.recordInvalidLookup(guard.keyFor(req.ip)),
  );
  // Server-side faults (a live row whose file vanished) are not enumeration
  // attempts: same uniform response, but they never count against a budget.
  const notFoundFault = uniformNotFound(config);

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
        annotationsRev: captures.annotationsRev,
        flatRev: captures.flatRev,
        /** Cheap emptiness check without pulling the (up to 8 MB) document. */
        shapeCount: sql<number>`jsonb_array_length(${captures.annotations} -> 'shapes')`,
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
      s.setNotFoundHandler((req, reply) => notFound(req, reply));

      s.get<{ Params: { viewId: string } }>('/:viewId', async (req, reply) => {
        const row = await findLive(req.params.viewId);
        if (!row) return notFound(req, reply);
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

      // The flat render (§10): the URL is stable while its content follows the
      // annotations, so the ETag derives from annotations_rev and clients
      // revalidate cheaply (`private, no-cache`). Zero-annotation captures
      // serve the re-encoded original untouched — exactly what M1 served.
      s.get<{ Params: { viewId: string } }>('/:viewId/image.png', async (req, reply) => {
        const row = await findLive(req.params.viewId);
        if (!row) return notFound(req, reply);

        const cacheHeaders = (rev: number) =>
          reply
            .header('ETag', `"r${rev}"`)
            .header('Cache-Control', 'private, no-cache')
            .header('X-Content-Type-Options', 'nosniff');

        // Headers go on only when a real response is sent, so a fall-through
        // to notFound() stays byte- and header-identical (CLAUDE.md rule 2).
        // Returns whether it sent, never the reply: Fastify's Reply is a
        // thenable, so `await reply.send(...)` would resolve to undefined and
        // read as "not sent" while the stream is already on the wire.
        const sendFile = async (rev: number, variant: 'original' | 'flat'): Promise<boolean> => {
          const file = await store.open(row.id, variant);
          if (!file) return false;
          cacheHeaders(rev)
            .type('image/png')
            .header('Content-Length', file.size)
            .header('Content-Disposition', 'inline; filename="capture.png"')
            .send(file.stream);
          return true;
        };

        // A revalidation of the current revision needs no file (or render).
        if (ifNoneMatchHits(req.headers['if-none-match'], `"r${row.annotationsRev}"`)) {
          return cacheHeaders(row.annotationsRev).code(304).send();
        }

        let sent =
          row.shapeCount === 0
            ? await sendFile(row.annotationsRev, 'original')
            : row.flatRev === row.annotationsRev
              ? await sendFile(row.annotationsRev, 'flat')
              : false;

        if (!sent) {
          // Cache stale (or its file missing): render through the gate. The
          // renderer re-reads the row, so the result may be a newer revision.
          const rendered = await flat.ensure(row.id);
          if (rendered) {
            sent = await sendFile(rendered.rev, rendered.empty ? 'original' : 'flat');
          }
        }
        if (!sent) {
          // Defense in depth (§13): a live row whose file is gone — e.g. a
          // crash between the purge's unlink and its row update — answers
          // exactly like never-existed and is never charged to the guard.
          logSecurityEvent(req.log, { tag: 'sec.image.missing_file', captureId: row.id });
          return notFoundFault(req, reply);
        }
        return reply;
      });
    },
    { prefix: '/s' },
  );
}
