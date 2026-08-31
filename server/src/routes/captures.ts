import fastifyMultipart from '@fastify/multipart';
import {
  CAPTURE_UPLOAD_FIELDS,
  CreateCaptureResponse,
  MAX_PAGE_TITLE_LENGTH,
  MAX_SOURCE_URL_LENGTH,
} from '@snapping-turtle/shared';
import { Type } from '@sinclair/typebox';
import type { AuthHooks } from '../auth/hooks.js';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { captures } from '../db/schema.js';
import { HttpError } from '../errors.js';
import { newViewId } from '../ids.js';
import { ingestImage } from '../images/ingest.js';
import type { ImageStore } from '../images/storage.js';
import type { App, Clock } from '../types.js';
import { captureUrls } from '../urls.js';

export interface CaptureRouteDeps {
  db: Db;
  config: Config;
  store: ImageStore;
  auth: AuthHooks;
  now: Clock;
}

const FIELD_MAX = 8192;

/** multipart/form-data body after @fastify/multipart's keyValues mode. */
const UploadBody = Type.Object(
  {
    // A file part arrives as a Buffer; a text part named "image" would be a string
    // and is rejected in the handler. Files are never trusted by declared type.
    [CAPTURE_UPLOAD_FIELDS.image]: Type.Any(),
    [CAPTURE_UPLOAD_FIELDS.sourceUrl]: Type.String({ minLength: 1, maxLength: FIELD_MAX }),
    [CAPTURE_UPLOAD_FIELDS.title]: Type.Optional(Type.String({ maxLength: FIELD_MAX })),
  },
  { additionalProperties: false },
);

/** http(s) only, length-capped, normalised (§12). */
export function validateSourceUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length > MAX_SOURCE_URL_LENGTH) {
    throw new HttpError(400, 'invalid_source_url', 'sourceUrl is too long');
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new HttpError(400, 'invalid_source_url', 'sourceUrl must be an absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, 'invalid_source_url', 'sourceUrl must be http or https');
  }
  if (url.href.length > MAX_SOURCE_URL_LENGTH) {
    throw new HttpError(400, 'invalid_source_url', 'sourceUrl is too long');
  }
  return url.href;
}

const isControl = (ch: string): boolean => {
  const c = ch.codePointAt(0) ?? 0;
  return c < 0x20 || (c >= 0x7f && c < 0xa0);
};

/** Control characters stripped, whitespace collapsed, capped by code point. */
export function cleanTitle(raw: string | undefined): string {
  if (!raw) return '';
  const cleaned = Array.from(raw)
    .map((ch) => (isControl(ch) ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, MAX_PAGE_TITLE_LENGTH).join('');
}

/** POST /api/v1/captures — bearer token only (§8, §12). */
export async function captureRoutes(app: App, deps: CaptureRouteDeps): Promise<void> {
  const { db, config, store, auth, now } = deps;

  // Registered inside this plugin so multipart parsing exists for no other route.
  await app.register(fastifyMultipart, {
    attachFieldsToBody: 'keyValues',
    limits: {
      fileSize: config.maxUploadMb * 1024 * 1024,
      files: 1,
      fields: 4,
      fieldSize: FIELD_MAX,
      fieldNameSize: 64,
      parts: 5,
      headerPairs: 64,
    },
  });

  app.post(
    '/api/v1/captures',
    {
      preHandler: [auth.requireBearer],
      schema: { body: UploadBody, response: { 201: CreateCaptureResponse } },
    },
    async (req, reply) => {
      const { userId, tokenId } = req.apiAuth!;
      const image: unknown = req.body[CAPTURE_UPLOAD_FIELDS.image];
      if (!Buffer.isBuffer(image) || image.length === 0) {
        throw new HttpError(400, 'validation', 'image must be a non-empty file part');
      }
      const sourceUrl = validateSourceUrl(req.body[CAPTURE_UPLOAD_FIELDS.sourceUrl]);
      const pageTitle = cleanTitle(req.body[CAPTURE_UPLOAD_FIELDS.title]);

      const result = await ingestImage(image);
      const viewId = newViewId();
      const createdAt = now();
      const retentionUntil = new Date(
        createdAt.getTime() + config.retentionDefaultDays * 86_400_000,
      );

      // Row and file commit together: a failed write rolls the row back.
      const id = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(captures)
          .values({
            viewId,
            ownerId: userId,
            sourceUrl,
            pageTitle,
            width: result.width,
            height: result.height,
            bytes: result.png.length,
            sha256: result.sha256,
            uploadIp: req.ip,
            uploadTokenId: tokenId,
            createdAt,
            retentionUntil,
          })
          .returning({ id: captures.id });
        await store.write(row!.id, result.png);
        return row!.id;
      });

      req.log.info(
        { captureId: id, userId, tokenId, width: result.width, height: result.height },
        'capture stored',
      );
      return reply.code(201).send(captureUrls(config.publicOrigin, viewId));
    },
  );
}
