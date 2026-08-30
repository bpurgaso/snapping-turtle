import fastifyHelmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { HealthzResponse } from '@snapping-turtle/shared';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';

export interface AppOptions {
  config: Config;
  logger?: FastifyServerOptions['logger'];
  /** Dependency probes for /healthz; each must resolve or throw. */
  checks?: Record<string, () => Promise<void>>;
}

/**
 * Build the Fastify app. Every response — pages, API, static, errors — leaves
 * with the headers from CLAUDE.md rules 6 and 10. They are set here, once,
 * and nothing downstream may loosen them.
 */
export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { config } = opts;
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: config.trustProxy,
    bodyLimit: config.maxUploadMb * 1024 * 1024,
  }).withTypeProvider<TypeBoxTypeProvider>();

  await app.register(fastifyHelmet, {
    // Explicit allow-list; no 'unsafe-inline', no 'unsafe-eval' (rule 6).
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'font-src': ["'self'"],
        'connect-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    xFrameOptions: { action: 'deny' }, // legacy twin of frame-ancestors 'none'
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    // Default to no-store; only routes that opt in (hashed assets, flat images)
    // set their own policy before this hook runs.
    if (!reply.hasHeader('cache-control')) {
      reply.header('Cache-Control', 'private, no-store');
    }
  });

  app.get(
    '/healthz',
    { schema: { response: { 200: HealthzResponse, 503: HealthzResponse } } },
    async (_req, reply) => {
      const checks: Record<string, boolean> = {};
      for (const [name, probe] of Object.entries(opts.checks ?? {})) {
        try {
          await probe();
          checks[name] = true;
        } catch (err) {
          checks[name] = false;
          app.log.warn({ check: name, err }, 'health check failed');
        }
      }
      const healthy = Object.values(checks).every(Boolean);
      return reply.code(healthy ? 200 : 503).send({ status: healthy ? 'ok' : 'degraded', checks });
    },
  );

  await registerWeb(app, config);
  return app;
}

/** Serve the Vite bundle from web/dist: `/` → index.html, `/assets/*` → hashed files. */
async function registerWeb(app: FastifyInstance, config: Config): Promise<void> {
  const indexPath = join(config.webDistDir, 'index.html');
  const assetsDir = join(config.webDistDir, 'assets');

  if (!existsSync(indexPath)) {
    app.log.warn({ webDistDir: config.webDistDir }, 'web bundle not built; / will return 503');
    app.get('/', async (_req, reply) =>
      reply
        .code(503)
        .type('text/plain')
        .send('web bundle not built — run `pnpm --filter web build`\n'),
    );
    return;
  }

  // Read once in production; re-read per request in dev so `vite build --watch` output shows up.
  const cachedIndex = config.nodeEnv === 'production' ? readFileSync(indexPath, 'utf8') : undefined;
  app.get('/', async (_req, reply) =>
    reply.type('text/html; charset=utf-8').send(cachedIndex ?? readFileSync(indexPath, 'utf8')),
  );

  if (existsSync(assetsDir)) {
    await app.register(fastifyStatic, {
      root: assetsDir,
      prefix: '/assets/',
      decorateReply: false,
      index: false,
      list: false,
      // Vite content-hashes everything under assets/, so immutable caching is safe.
      cacheControl: true,
      maxAge: '1y',
      immutable: true,
    });
  }
}
