import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { HealthzResponse } from '@snapping-turtle/shared';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAuthHooks } from './auth/hooks.js';
import { SessionService } from './auth/session.js';
import { LoginThrottle } from './auth/throttle.js';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import { registerErrorHandler } from './errors.js';
import type { PageAssets } from './html.js';
import { ImageStore } from './images/storage.js';
import { authRoutes } from './routes/auth.js';
import { captureRoutes } from './routes/captures.js';
import { secretRoutes } from './routes/secret.js';
import { tokenRoutes } from './routes/tokens.js';
import type { App, Clock } from './types.js';
import { readEntryAssets } from './web-assets.js';

export interface AppOptions {
  config: Config;
  db: Db;
  logger?: FastifyServerOptions['logger'];
  /** Dependency probes for /healthz; each must resolve or throw. */
  checks?: Record<string, () => Promise<void>>;
  /** Injectable clock for sessions, retention and the login throttle. */
  now?: Clock;
}

/** JSON bodies are small; uploads are multipart with their own cap (routes/captures). */
const JSON_BODY_LIMIT = 64 * 1024;

/**
 * Build the Fastify app. Every response — pages, API, static, errors — leaves
 * with the headers from CLAUDE.md rules 6 and 10. They are set here, once,
 * and nothing downstream may loosen them.
 */
export async function buildApp(opts: AppOptions): Promise<App> {
  const { config, db } = opts;
  const now: Clock = opts.now ?? (() => new Date());
  const app: App = Fastify({
    logger: opts.logger ?? false,
    trustProxy: config.trustProxy,
    bodyLimit: JSON_BODY_LIMIT,
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
    // Default to no-store; only routes that opt in (hashed assets) set their
    // own policy before this hook runs.
    if (!reply.hasHeader('cache-control')) {
      reply.header('Cache-Control', 'private, no-store');
    }
  });

  await app.register(fastifyCookie, { secret: config.sessionSecret });
  app.decorateRequest('session', null);
  app.decorateRequest('apiAuth', null);
  registerErrorHandler(app);

  const sessions = new SessionService(db, config, now);
  const throttle = new LoginThrottle(config.loginThrottle, () => now().getTime());
  const auth = createAuthHooks(db, sessions, now);
  const store = new ImageStore(config.imagesDir);

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

  await app.register(authRoutes, { db, sessions, throttle, auth });
  await app.register(tokenRoutes, { db, auth, now });
  await app.register(captureRoutes, { db, config, store, auth, now });

  const captureAssets = assetLoader(config, 'src/capture.ts');
  await app.register(secretRoutes, { db, config, store, now, captureAssets });

  await registerWeb(app, config);
  return app;
}

/** Cached once in production; re-read per request in dev so watch builds show up. */
function assetLoader(config: Config, entry: string): () => PageAssets {
  if (config.nodeEnv !== 'production') return () => readEntryAssets(config.webDistDir, entry);
  const cached = readEntryAssets(config.webDistDir, entry);
  return () => cached;
}

/** Static HTML pages from web/dist plus hashed assets under /assets/. */
const PAGES: ReadonlyArray<[route: string, file: string]> = [
  ['/', 'index.html'],
  ['/login', 'login.html'],
  ['/signup', 'signup.html'],
  ['/account', 'account.html'],
];

/** Serve the Vite bundle from web/dist: pages → their HTML, `/assets/*` → hashed files. */
async function registerWeb(app: App, config: Config): Promise<void> {
  const indexPath = join(config.webDistDir, 'index.html');
  const assetsDir = join(config.webDistDir, 'assets');

  if (!existsSync(indexPath)) {
    app.log.warn({ webDistDir: config.webDistDir }, 'web bundle not built; pages will return 503');
    for (const [route] of PAGES) {
      app.get(route, async (_req, reply) =>
        reply
          .code(503)
          .type('text/plain')
          .send('web bundle not built — run `pnpm --filter web build`\n'),
      );
    }
    return;
  }

  for (const [route, file] of PAGES) {
    const path = join(config.webDistDir, file);
    if (!existsSync(path)) continue;
    const cached = config.nodeEnv === 'production' ? readFileSync(path, 'utf8') : undefined;
    app.get(route, async (_req, reply) =>
      reply.type('text/html; charset=utf-8').send(cached ?? readFileSync(path, 'utf8')),
    );
  }

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
