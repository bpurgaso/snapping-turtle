import type { ApiErrorCode, ApiErrorResponse } from '@snapping-turtle/shared';
import type { FastifyError, FastifyInstance } from 'fastify';

/** An error the client is meant to see. Messages must never contain secrets. */
export class HttpError extends Error {
  override name = 'HttpError';
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

const CODE_BY_STATUS: Record<number, ApiErrorCode> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  406: 'bad_request',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'throttled',
};

/**
 * Normalise every error to ApiErrorResponse. 4xx from our code or from
 * plugins (validation, multipart limits) keep their message; anything 5xx is
 * logged in full but answered with a fixed body so internals never leak.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
    if (err instanceof HttpError) {
      const body: ApiErrorResponse = { error: err.message, code: err.code };
      if (err.retryAfterSeconds !== undefined) {
        body.retryAfterSeconds = err.retryAfterSeconds;
        reply.header('Retry-After', String(err.retryAfterSeconds));
      }
      return reply.code(err.statusCode).send(body);
    }
    if ('validation' in err && err.validation) {
      return reply.code(400).send({ error: err.message, code: 'validation' });
    }
    const status = err.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      return reply
        .code(status)
        .send({ error: err.message, code: CODE_BY_STATUS[status] ?? 'bad_request' });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal error', code: 'internal' });
  });
}
