import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildApp, isPermissiveProxyTrust } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb } from '../../src/db/client.js';
import { Guard } from '../../src/guard.js';
import { loggerOptions } from '../../src/log.js';
import { repoRoot } from '../../src/paths.js';
import {
  logSecurityEvent,
  SECURITY_EVENT_LEVEL,
  SECURITY_TAGS,
} from '../../src/security-events.js';

const baseEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://app:pw@localhost:5432/app',
  SESSION_SECRET: 'unit-test-session-secret-not-real-0123456789',
  WEB_DIST_DIR: '/nonexistent',
  LOG_LEVEL: 'info',
};

/** A Fastify instance whose logger writes JSON lines into `lines`. */
function loggedApp(env: Record<string, string> = {}) {
  const lines: string[] = [];
  const config = loadConfig({ ...baseEnv, ...env });
  const app = Fastify({
    logger: {
      ...(loggerOptions(config) as object),
      stream: { write: (line: string) => void lines.push(line) },
    } as never,
  });
  return { app, lines, parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe('security event taxonomy (docs/security-events.md)', () => {
  it('logs { tag, ...fields } at the level the table assigns, with msg = tag', () => {
    const { app, parsed } = loggedApp();
    logSecurityEvent(app.log, {
      tag: 'sec.ban.created',
      ipPrefix: '198.51.100.7',
      strikes: 2,
      banMinutes: 60,
      bannedUntil: '2026-09-01T00:00:00.000Z',
    });
    logSecurityEvent(app.log, { tag: 'sec.breaker.closed' });
    const [ban, closed] = parsed();
    expect(ban).toMatchObject({
      level: 40,
      tag: 'sec.ban.created',
      ipPrefix: '198.51.100.7',
      strikes: 2,
      msg: 'sec.ban.created',
    });
    expect(closed).toMatchObject({
      level: 30,
      tag: 'sec.breaker.closed',
      msg: 'sec.breaker.closed',
    });
  });

  it('every tag is namespaced, has a level, and is documented', () => {
    const doc = readFileSync(`${repoRoot}/docs/security-events.md`, 'utf8');
    expect(SECURITY_TAGS.length).toBeGreaterThan(15);
    for (const tag of SECURITY_TAGS) {
      expect(tag).toMatch(/^sec\.[a-z_]+\.[a-z_]+$/);
      expect(['info', 'warn', 'error']).toContain(SECURITY_EVENT_LEVEL[tag]);
      expect(doc, `${tag} missing from docs/security-events.md`).toContain(`\`${tag}\``);
    }
  });
});

describe('pino redaction (CLAUDE.md rule 3)', () => {
  it('censors credential headers and secret-shaped keys, one level down too', async () => {
    const { app, lines } = loggedApp();
    const token = 'st_AbCdEfGhIjKlMnOpQrStUvWxYz01';
    const password = 'hunter2-not-a-real-password';
    app.log.info(
      {
        password,
        token,
        nested: { token, csrfToken: 'csrf-value-1234', resetUrl: `https://x/reset/${token}` },
        headers: { authorization: `Bearer ${token}`, cookie: `st_session=${token}` },
        databaseUrl: 'postgres://app:dbpassword@db/x',
      },
      'redaction probe',
    );
    const blob = lines.join('');
    expect(blob).toContain('redaction probe');
    expect(blob).not.toContain(token);
    expect(blob).not.toContain(password);
    expect(blob).not.toContain('csrf-value-1234');
    expect(blob).not.toContain('dbpassword');
    expect(blob).toContain('[redacted]');
  });

  it('request logs truncate secret paths and drop credential headers', async () => {
    const { app, lines } = loggedApp();
    app.get('/s/:id', async () => 'ok');
    const viewId = 'AbCdEfGhIjKlMnOpQrStUvWxYz1';
    await app.inject({
      method: 'GET',
      url: `/s/${viewId}`,
      headers: { cookie: 'st_session=cookie-secret-value', authorization: 'Bearer st_secret' },
    });
    const blob = lines.join('');
    expect(blob).toContain('/s/AbCdEfGh…');
    expect(blob).not.toContain(viewId);
    expect(blob).not.toContain('cookie-secret-value');
    expect(blob).not.toContain('st_secret');
    await app.close();
  });
});

describe('permissive proxy trust warning (§12)', () => {
  it('classifies trust settings', () => {
    expect(isPermissiveProxyTrust(true)).toBe(true);
    expect(isPermissiveProxyTrust(false)).toBe(false);
    expect(isPermissiveProxyTrust(['172.28.101.0/24'])).toBe(false);
    expect(isPermissiveProxyTrust(['10.0.0.0/8', '0.0.0.0/0'])).toBe(true);
    expect(isPermissiveProxyTrust(['::/0'])).toBe(true);
  });

  it('logs sec.proxy.permissive_trust at error level on boot only when trust is permissive', async () => {
    const { db } = createDb('postgres://unused:unused@127.0.0.1:1/unused', { max: 1 });
    const boot = async (trustProxy: string) => {
      const lines: string[] = [];
      const config = loadConfig({ ...baseEnv, TRUST_PROXY: trustProxy });
      const guard = new Guard({ db, rate: config.rate, now: () => new Date() });
      const app = await buildApp({
        config,
        db,
        guard,
        logger: {
          ...(loggerOptions(config) as object),
          stream: { write: (line: string) => void lines.push(line) },
        } as never,
      });
      await app.close();
      return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    };
    const permissive = await boot('true');
    const warning = permissive.find((l) => l['tag'] === 'sec.proxy.permissive_trust');
    expect(warning).toMatchObject({ level: 50, trustProxy: 'true' });
    const pinned = await boot('172.28.101.0/24');
    expect(pinned.some((l) => l['tag'] === 'sec.proxy.permissive_trust')).toBe(false);
  });
});
