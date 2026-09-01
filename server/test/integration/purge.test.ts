import { CSRF_HEADER, type AnnotationDocument } from '@snapping-turtle/shared';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { captures, users } from '../../src/db/schema.js';
import { seedAdmin } from '../../src/db/seed-admin.js';
import { NOT_FOUND_HTML } from '../../src/html.js';
import { newViewId } from '../../src/ids.js';
import { ImageStore } from '../../src/images/storage.js';
import { PurgeJob } from '../../src/jobs/purge.js';
import { loggerOptions } from '../../src/log.js';
import type { App } from '../../src/types.js';
import { makePng } from '../helpers/images.js';

/**
 * The M7 retention purge (PLAN.md §5, §13) against a real Postgres: expiry
 * → tombstone, indefinite captures untouched, idempotent re-runs over
 * partial state, hard delete after TOMBSTONE_DAYS (owner deletes included),
 * the missing-file fault path on the image route, and the rule-3 log sweep
 * over the job's own output. All timing comes from the injected clock.
 */
const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests');

const imagesDir = mkdtempSync(join(tmpdir(), 'st-images-'));
const webDist = mkdtempSync(join(tmpdir(), 'st-web-'));
mkdirSync(join(webDist, '.vite'));
writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>t</title>');
writeFileSync(
  join(webDist, '.vite', 'manifest.json'),
  JSON.stringify({
    'src/capture.ts': { file: 'assets/capture-h4sh.js', css: [] },
    'src/editor.ts': { file: 'assets/editor-h4sh.js', css: [] },
  }),
);

const DAY = 86_400_000;
let clock = new Date('2026-09-01T03:00:00.000Z');
const now = () => clock;

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: databaseUrl,
  SESSION_SECRET: 'integration-session-secret-not-real-0123456789',
  PUBLIC_ORIGIN: 'https://shots.test',
  IMAGES_DIR: imagesDir,
  WEB_DIST_DIR: webDist,
  RATE_NOT_FOUND_JITTER_MIN_MS: '0',
  RATE_NOT_FOUND_JITTER_MAX_MS: '0',
  // Tight budget so the "faults are never charged" check below is real.
  RATE_INVALID_LOOKUP_BUDGET: '2',
  RATE_GENERAL_PER_MIN: '100000',
  RATE_BREAKER_INVALID_PER_MIN: '1000000',
});
const ADMIN = { username: 'bootstrap-admin', password: 'integration-test-password-1' };

let handle: DbHandle;
let app: App;
let ownerId: number;
const logLines: string[] = [];
const store = new ImageStore(imagesDir);

const strip = (h: Record<string, unknown>) => {
  const { date: _d, ...rest } = h;
  return rest;
};

const RECT_DOC: AnnotationDocument = {
  version: 1,
  rev: 1,
  shapes: [{ id: 'a1', type: 'rect', x: 2, y: 2, w: 10, h: 8 }],
};

interface Made {
  id: number;
  viewId: string;
}

/** Insert a capture row directly (the upload path is covered by api.test.ts) and write its file. */
async function mk(opts: {
  retentionUntil: Date | null;
  deletedAt?: Date | null;
  annotated?: boolean;
  flat?: boolean;
  file?: boolean;
}): Promise<Made> {
  const viewId = newViewId();
  const [row] = await handle.db
    .insert(captures)
    .values({
      viewId,
      ownerId,
      sourceUrl: 'https://example.com/page',
      pageTitle: 'purge fixture',
      width: 16,
      height: 12,
      bytes: 1,
      sha256: 'f'.repeat(64),
      uploadIp: '192.0.2.1',
      createdAt: new Date(clock.getTime() - 40 * DAY),
      retentionUntil: opts.retentionUntil,
      deletedAt: opts.deletedAt ?? null,
      ...(opts.annotated ? { annotations: RECT_DOC, annotationsRev: 1 } : {}),
    })
    .returning({ id: captures.id });
  const png = await makePng(16, 12);
  if (opts.file !== false) await store.write(row!.id, png);
  if (opts.flat) await store.write(row!.id, png, 'flat');
  return { id: row!.id, viewId };
}

const rowOf = async (id: number) =>
  (await handle.db.select().from(captures).where(eq(captures.id, id)))[0];

function job(tombstoneDays = config.tombstoneDays, batchSize?: number) {
  return new PurgeJob({
    db: handle.db,
    store,
    now,
    log: app.log,
    tombstoneDays,
    ...(batchSize ? { batchSize } : {}),
  });
}

beforeAll(async () => {
  handle = createDb(databaseUrl, { max: 4 });
  await handle.sql`drop schema if exists public cascade`;
  await handle.sql`drop schema if exists drizzle cascade`;
  await handle.sql`create schema public`;
  await runMigrations(handle);
  await seedAdmin(handle.db, ADMIN);
  const stream = { write: (line: string) => void logLines.push(line) };
  app = await buildApp({
    config,
    db: handle.db,
    now,
    logger: { ...(loggerOptions(config) as object), stream } as never,
  });
  const [admin] = await handle.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, ADMIN.username));
  ownerId = admin!.id;
});
afterAll(async () => {
  await app.close();
  await handle.close();
});

describe('expiry → tombstone (§13)', () => {
  it('removes files, tombstones the row, clears annotations, keeps attribution', async () => {
    const expired = await mk({
      retentionUntil: new Date(clock.getTime() - 1000),
      annotated: true,
      flat: true,
    });
    const before = (await rowOf(expired.id))!;
    expect(existsSync(store.pathFor(expired.id))).toBe(true);
    expect(existsSync(store.pathFor(expired.id, 'flat'))).toBe(true);

    const report = await job().runOnce();
    expect(report).toMatchObject({ expired: 1, filesRemoved: 2, hardDeleted: 0, errors: 0 });

    expect(existsSync(store.pathFor(expired.id))).toBe(false);
    expect(existsSync(store.pathFor(expired.id, 'flat'))).toBe(false);
    const after = (await rowOf(expired.id))!;
    expect(after.deletedAt?.toISOString()).toBe(clock.toISOString());
    expect(after.annotations.shapes).toEqual([]);
    // §5: attribution survives on the tombstone.
    expect(after).toMatchObject({
      ownerId: before.ownerId,
      sourceUrl: before.sourceUrl,
      sha256: before.sha256,
      uploadIp: before.uploadIp,
      createdAt: before.createdAt,
      retentionUntil: before.retentionUntil,
    });
    expect((await app.inject({ method: 'GET', url: `/s/${expired.viewId}` })).statusCode).toBe(404);
  });

  it('never touches indefinite (retention NULL) or still-live captures', async () => {
    const indefinite = await mk({ retentionUntil: null });
    const live = await mk({ retentionUntil: new Date(clock.getTime() + DAY) });
    const report = await job().runOnce();
    expect(report.expired).toBe(0);
    for (const c of [indefinite, live]) {
      expect(existsSync(store.pathFor(c.id))).toBe(true);
      expect((await rowOf(c.id))!.deletedAt).toBeNull();
      expect((await app.inject({ method: 'GET', url: `/s/${c.viewId}` })).statusCode).toBe(200);
    }
    // Ageing far past any retention window changes nothing for the indefinite one.
    clock = new Date(clock.getTime() + 400 * DAY);
    try {
      expect((await job().runOnce()).expired).toBe(1); // `live` expired on its own schedule
      expect((await rowOf(indefinite.id))!.deletedAt).toBeNull();
      expect(existsSync(store.pathFor(indefinite.id))).toBe(true);
    } finally {
      clock = new Date(clock.getTime() - 400 * DAY);
    }
  });

  it('is idempotent: re-running over an already-purged state is a no-op', async () => {
    const expired = await mk({ retentionUntil: new Date(clock.getTime() - 1000) });
    const first = await job().runOnce();
    expect(first.expired).toBe(1);
    const deletedAt = (await rowOf(expired.id))!.deletedAt;
    clock = new Date(clock.getTime() + 60_000);
    const second = await job().runOnce();
    expect(second).toMatchObject({ expired: 0, filesRemoved: 0, sweptFiles: 0, errors: 0 });
    // The tombstone keeps its original deleted_at — nothing was re-tombstoned.
    expect((await rowOf(expired.id))!.deletedAt?.toISOString()).toBe(deletedAt?.toISOString());
  });

  it('converges partially processed state (crash between unlink and row update, failed unlinks)', async () => {
    // (a) files already gone, row still live-but-expired
    const halfDone = await mk({ retentionUntil: new Date(clock.getTime() - 1000), file: false });
    // (b) row tombstoned by an owner delete whose unlink failed — file still there
    const leftover = await mk({ retentionUntil: null, deletedAt: clock, flat: true });
    const report = await job().runOnce();
    expect(report.errors).toBe(0);
    expect(report.expired).toBe(1);
    expect((await rowOf(halfDone.id))!.deletedAt).not.toBeNull();
    expect(report.sweptFiles).toBe(2);
    expect(existsSync(store.pathFor(leftover.id))).toBe(false);
    expect(existsSync(store.pathFor(leftover.id, 'flat'))).toBe(false);
    expect((await rowOf(leftover.id))!.deletedAt).not.toBeNull(); // still a tombstone, not hard-deleted
  });

  it('pages through backlogs larger than one batch', async () => {
    const made = await Promise.all(
      Array.from({ length: 5 }, () => mk({ retentionUntil: new Date(clock.getTime() - 1) })),
    );
    const report = await job(config.tombstoneDays, 2).runOnce();
    expect(report.expired).toBe(5);
    for (const c of made) expect((await rowOf(c.id))!.deletedAt).not.toBeNull();
  });
});

describe('hard delete after TOMBSTONE_DAYS (§5)', () => {
  it('drops tombstones older than the window — owner deletes included — and keeps younger ones', async () => {
    const days = config.tombstoneDays;
    const old = await mk({
      retentionUntil: null,
      deletedAt: new Date(clock.getTime() - (days + 1) * DAY),
    });
    const edge = await mk({
      retentionUntil: null,
      deletedAt: new Date(clock.getTime() - days * DAY),
    });
    const young = await mk({
      retentionUntil: null,
      deletedAt: new Date(clock.getTime() - (days - 1) * DAY),
    });

    // A real owner delete (M3 PATCH) is a tombstone like any other.
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: ADMIN,
    });
    const cookie = (
      Array.isArray(login.headers['set-cookie'])
        ? login.headers['set-cookie']
        : [String(login.headers['set-cookie'])]
    )
      .map((c) => c.split(';')[0]!)
      .join('; ');
    const ownerDeleted = await mk({ retentionUntil: new Date(clock.getTime() + 10 * DAY) });
    const del = await app.inject({
      method: 'PATCH',
      url: `/api/v1/captures/${ownerDeleted.viewId}`,
      payload: { delete: true },
      headers: { cookie, [CSRF_HEADER]: login.json().csrfToken },
    });
    expect(del.statusCode).toBe(204);

    let report = await job().runOnce();
    expect(report.hardDeleted).toBe(2); // old + edge (deleted_at <= cutoff)
    expect(await rowOf(old.id)).toBeUndefined();
    expect(await rowOf(edge.id)).toBeUndefined();
    expect(await rowOf(young.id)).toBeDefined();
    expect(await rowOf(ownerDeleted.id)).toBeDefined();
    expect(existsSync(store.pathFor(old.id))).toBe(false);

    // Time passes: the owner delete ages out too.
    clock = new Date(clock.getTime() + (days + 1) * DAY);
    try {
      report = await job().runOnce();
      expect(report.hardDeleted).toBeGreaterThanOrEqual(2); // young + ownerDeleted (+ earlier tombstones)
      expect(await rowOf(young.id)).toBeUndefined();
      expect(await rowOf(ownerDeleted.id)).toBeUndefined();
    } finally {
      clock = new Date(clock.getTime() - (days + 1) * DAY);
    }
  });

  it('honours a shorter TOMBSTONE_DAYS', async () => {
    const weekOld = await mk({
      retentionUntil: null,
      deletedAt: new Date(clock.getTime() - 8 * DAY),
    });
    expect((await job(90).runOnce()).hardDeleted).toBe(0);
    expect(await rowOf(weekOld.id)).toBeDefined();
    expect((await job(7).runOnce()).hardDeleted).toBe(1);
    expect(await rowOf(weekOld.id)).toBeUndefined();
  });
});

describe('missing-file fault path (§13 defense in depth)', () => {
  it('image.png of a live capture whose file vanished is byte-identical to never-existed', async () => {
    const plain = await mk({ retentionUntil: null });
    const annotated = await mk({ retentionUntil: null, annotated: true });
    // Sanity: both serve before the files go.
    for (const c of [plain, annotated]) {
      expect(
        (await app.inject({ method: 'GET', url: `/s/${c.viewId}/image.png` })).statusCode,
      ).toBe(200);
    }
    await rm(store.pathFor(plain.id));
    await rm(store.pathFor(annotated.id));
    await rm(store.pathFor(annotated.id, 'flat'), { force: true });

    const ghost = await app.inject({
      method: 'GET',
      url: `/s/${randomBytes(20).toString('base64url')}/image.png`,
    });
    expect(ghost.statusCode).toBe(404);
    expect(ghost.body).toBe(NOT_FOUND_HTML);
    for (const c of [plain, annotated]) {
      const res = await app.inject({ method: 'GET', url: `/s/${c.viewId}/image.png` });
      expect(res.statusCode).toBe(404);
      expect(res.rawPayload.equals(ghost.rawPayload)).toBe(true);
      expect(strip(res.headers)).toEqual(strip(ghost.headers));
    }
  });

  it('faults are never charged to the guard budget', async () => {
    const gone = await mk({ retentionUntil: null, file: false });
    const good = await mk({ retentionUntil: null });
    const ip = '198.51.100.77';
    // Budget is 2; five faults from one address would ban it if they counted.
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'GET',
        url: `/s/${gone.viewId}/image.png`,
        remoteAddress: ip,
      });
      expect(res.statusCode).toBe(404);
    }
    const still = await app.inject({ method: 'GET', url: `/s/${good.viewId}`, remoteAddress: ip });
    expect(still.statusCode).toBe(200);
  });
});

describe('scheduling and logging', () => {
  it('start() runs at once and again on the interval; stop() waits for the run in flight', async () => {
    const before = logLines.length;
    const j = job();
    j.start(30);
    await sleep(110);
    await j.stop();
    const runs = logLines
      .slice(before)
      .filter((l) => l.includes('"tag":"sec.purge.completed"')).length;
    expect(runs).toBeGreaterThanOrEqual(2);
    const after = logLines.length;
    await sleep(80);
    expect(logLines.length).toBe(after); // nothing fires after stop()
  });

  it('logs sec.purge.* with counts and internal ids only — never a view_id (rule 3)', async () => {
    const expired = await mk({ retentionUntil: new Date(clock.getTime() - 1000) });
    const before = logLines.length;
    await job().runOnce();
    const lines = logLines.slice(before);
    const completed = lines.find((l) => l.includes('"tag":"sec.purge.completed"'));
    expect(completed).toBeDefined();
    const parsed = JSON.parse(completed!) as Record<string, unknown>;
    expect(parsed).toMatchObject({ tag: 'sec.purge.completed', expired: 1, errors: 0 });
    expect(typeof parsed['ms']).toBe('number');
    const blob = logLines.join('');
    expect(blob).not.toContain(expired.viewId);
    // Every capture minted by this suite stays out of the log in full.
    const all = await handle.db.select({ viewId: captures.viewId }).from(captures);
    for (const { viewId } of all) expect(blob).not.toContain(viewId);
  });

  it('reports sec.purge.file_error and skips the row when an unlink fails', async () => {
    const stuck = await mk({ retentionUntil: new Date(clock.getTime() - 1000) });
    const failing = new ImageStore(imagesDir);
    failing.remove = async () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    };
    const before = logLines.length;
    const report = new PurgeJob({
      db: handle.db,
      store: failing,
      now,
      log: app.log,
      tombstoneDays: 90,
    }).runOnce();
    expect((await report).errors).toBeGreaterThanOrEqual(1);
    expect((await rowOf(stuck.id))!.deletedAt).toBeNull(); // retried next run, not half-done
    expect(logLines.slice(before).some((l) => l.includes('"tag":"sec.purge.file_error"'))).toBe(
      true,
    );
    // A healthy run converges it.
    expect((await job().runOnce()).expired).toBe(1);
  });
});
