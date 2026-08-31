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
import { registerErrorHandler, HttpError } from './errors.js';
import { Guard, sendGuardBlocked } from './guard.js';
import type { PageAssets } from './html.js';
import { FlatRenderer } from './images/flat.js';
import { ImageStore } from './images/storage.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { captureRoutes } from './routes/captures.js';
import { ownerRoutes } from './routes/owner.js';
import { pingRoutes } from './routes/ping.js';
import { resetRoutes } from './routes/reset.js';
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
  /** Injectable flat renderer (§10) so tests can observe the render gate. */
  flat?: FlatRenderer;
  /**
   * Injectable guard (§12) so DB-free unit suites can supply one whose ban
   * state was never hydrated. When omitted (production, integration), the
   * app builds its own from config and hydrates it from ip_bans. The guard
   * itself always runs — determinism comes from config and the clock, never
   * from a bypass (CLAUDE.md rule 9).
   */
  guard?: Guard;
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

  // The guard (§12) sits in front of everything. Ban state is rebuilt from
  // ip_bans here so a restart never amnesties anyone; all thresholds come
  // from RATE_* config and the injected clock (CLAUDE.md rule 9 — no
  // bypasses, no special cases).
  const guard =
    opts.guard ??
    new Guard({
      db,
      rate: config.rate,
      now,
      onEvent: (event) => app.log.warn({ securityEvent: event }, 'guard event'),
    });
  if (!opts.guard) await guard.init();

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?', 2)[0]!;
    const secretPath =
      path === '/s' || path.startsWith('/s/') || path === '/reset' || path.startsWith('/reset/');
    const ipKey = guard.keyFor(req.ip);

    if (secretPath) {
      // A ban closes the oracle, not just the door: the check is in-memory,
      // before any ID lookup, so valid and invalid links get byte-identical
      // 429s with an identical timing profile (§12).
      const banSeconds = guard.banRemainingSeconds(ipKey);
      if (banSeconds !== null) return sendGuardBlocked(reply, banSeconds);

      const gate = guard.breakerGate();
      if (!gate.allowed) {
        // Breaker open: authenticated sessions keep working (§12).
        const token = sessions.tokenFromRequest(req);
        const session = token ? await sessions.resolve(token) : null;
        if (!session) return sendGuardBlocked(reply, gate.retryAfterSeconds);
      }
    }

    // General unauthenticated cap. "Anonymous" means no validly signed
    // session cookie and no bearer header — the cookie signature check is
    // cheap and unforgeable, and both credential kinds are verified for real
    // by the routes that require them.
    const anonymous =
      sessions.tokenFromRequest(req) === undefined && req.headers.authorization === undefined;
    if (anonymous) {
      const decision = guard.checkGeneral(ipKey);
      if (!decision.allowed) {
        if (secretPath) return sendGuardBlocked(reply, decision.retryAfterSeconds);
        throw new HttpError(429, 'throttled', 'too many requests', decision.retryAfterSeconds);
      }
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

  await app.register(authRoutes, { db, sessions, throttle, auth, guard, now });
  await app.register(adminRoutes, { db, config, store, auth, guard, now });
  await app.register(tokenRoutes, { db, auth, now });
  await app.register(pingRoutes, { auth });
  await app.register(captureRoutes, { db, config, store, auth, now });
  await app.register(ownerRoutes, { db, config, store, auth, sessions, now });

  const captureAssets = assetLoader(config, 'src/capture.ts');
  const editorAssets = assetLoader(config, 'src/editor.ts');
  const flat = opts.flat ?? new FlatRenderer({ db, store, log: app.log });
  await app.register(secretRoutes, {
    db,
    config,
    store,
    flat,
    sessions,
    guard,
    now,
    captureAssets,
    editorAssets,
  });

  await app.register(resetRoutes, {
    db,
    config,
    guard,
    now,
    resetPage: pageLoader(config, 'reset.html'),
  });

  await registerWeb(app, config);
  return app;
}

/** Raw HTML page loader: cached in production, re-read per request in dev. */
function pageLoader(config: Config, file: string): () => string | undefined {
  const path = join(config.webDistDir, file);
  const read = () => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);
  if (config.nodeEnv !== 'production') return read;
  const cached = read();
  return () => cached;
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
