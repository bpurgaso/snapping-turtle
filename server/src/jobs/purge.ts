import { emptyAnnotationDocument, PURGE_INTERVAL_MS } from '@snapping-turtle/shared';
import { and, eq, gt, isNotNull, isNull, lte } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/client.js';
import { captures } from '../db/schema.js';
import type { ImageStore } from '../images/storage.js';
import { logSecurityEvent } from '../security-events.js';
import type { Clock } from '../types.js';

/**
 * Retention purge (PLAN.md §5, §13). Hourly, in-process, on the injected
 * clock like the guard. One run does three things, each idempotent:
 *
 *  1. **Expire.** Captures whose `retention_until` has passed lose their
 *     files (original + flat render) and become tombstones: `deleted_at`
 *     set, annotations cleared, attribution retained (owner, source_url,
 *     sha256, upload ip/token, timestamps). Indefinite captures
 *     (`retention_until IS NULL`) are never touched.
 *  2. **Sweep.** Every tombstone — including owner/admin deletes, which
 *     unlink at delete time but may have failed — gets its files removed
 *     again; missing files are not errors, so re-running is harmless.
 *  3. **Hard-delete.** Tombstones older than `tombstoneDays` are deleted
 *     outright, files first.
 *
 * Files go before rows so a crash never leaves a tombstone with a live
 * file; the reverse gap (row still live, file gone) is closed by the image
 * route's uniform 404 and by the next run. Logs carry internal ids only —
 * never `view_id`s (CLAUDE.md rule 3).
 */

export interface PurgeDeps {
  db: Db;
  store: ImageStore;
  now: Clock;
  log: FastifyBaseLogger;
  /** Days a tombstone survives before hard delete (TOMBSTONE_DAYS, §14). */
  tombstoneDays: number;
  /** Rows per query; keeps memory flat for a backlog after downtime. */
  batchSize?: number;
}

export interface PurgeReport {
  /** Expired captures tombstoned this run. */
  expired: number;
  /** Files actually unlinked while expiring. */
  filesRemoved: number;
  /** Files unlinked from pre-existing tombstones (failed earlier unlinks). */
  sweptFiles: number;
  /** Tombstone rows hard-deleted. */
  hardDeleted: number;
  /** Captures skipped this run because a file could not be removed. */
  errors: number;
  ms: number;
}

const DAY_MS = 86_400_000;

export class PurgeJob {
  private readonly batchSize: number;
  private timer: NodeJS.Timeout | undefined;
  private inflight: Promise<PurgeReport> | null = null;
  private stopped = false;

  constructor(private readonly deps: PurgeDeps) {
    this.batchSize = deps.batchSize ?? 200;
    if (!Number.isInteger(deps.tombstoneDays) || deps.tombstoneDays < 1) {
      throw new Error('tombstoneDays must be a positive integer');
    }
  }

  /** Run immediately, then every `intervalMs` (hourly per §13). Timer never keeps the process alive. */
  start(intervalMs: number = PURGE_INTERVAL_MS): void {
    if (this.timer) return;
    this.stopped = false;
    const tick = () => {
      if (this.stopped) return;
      this.runOnce().catch((err: unknown) =>
        logSecurityEvent(this.deps.log, { tag: 'sec.purge.failed', err }),
      );
    };
    tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
  }

  /** Stop scheduling and wait for any run in progress. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.inflight) await this.inflight.catch(() => undefined);
  }

  /** One full pass. Single-flight: a call during a run joins that run. */
  runOnce(): Promise<PurgeReport> {
    if (this.inflight) return this.inflight;
    this.inflight = this.pass().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async pass(): Promise<PurgeReport> {
    const startedAt = Date.now();
    const report: PurgeReport = {
      expired: 0,
      filesRemoved: 0,
      sweptFiles: 0,
      hardDeleted: 0,
      errors: 0,
      ms: 0,
    };
    await this.expire(report);
    await this.sweepAndHardDelete(report);
    report.ms = Date.now() - startedAt;
    logSecurityEvent(this.deps.log, { tag: 'sec.purge.completed', ...report });
    return report;
  }

  /** Step 1: expired live captures → files unlinked, row tombstoned. */
  private async expire(report: PurgeReport): Promise<void> {
    const { db } = this.deps;
    const now = this.deps.now();
    let lastId = 0;
    for (;;) {
      const rows = await db
        .select({ id: captures.id })
        .from(captures)
        .where(
          and(
            isNull(captures.deletedAt),
            isNotNull(captures.retentionUntil),
            lte(captures.retentionUntil, now),
            gt(captures.id, lastId),
          ),
        )
        .orderBy(captures.id)
        .limit(this.batchSize);
      if (rows.length === 0) return;
      for (const { id } of rows) {
        lastId = id;
        const removed = await this.removeFiles(id);
        if (removed === null) {
          report.errors += 1;
          continue; // row stays live-but-expired (already a uniform 404); retried next run
        }
        report.filesRemoved += removed;
        const updated = await db
          .update(captures)
          .set({ deletedAt: now, annotations: emptyAnnotationDocument() })
          .where(and(eq(captures.id, id), isNull(captures.deletedAt)))
          .returning({ id: captures.id });
        if (updated.length > 0) report.expired += 1;
      }
      if (rows.length < this.batchSize) return;
    }
  }

  /** Steps 2 + 3: every tombstone loses any leftover file; old ones lose the row too. */
  private async sweepAndHardDelete(report: PurgeReport): Promise<void> {
    const { db } = this.deps;
    const now = this.deps.now();
    const cutoff = new Date(now.getTime() - this.deps.tombstoneDays * DAY_MS);
    let lastId = 0;
    for (;;) {
      const rows = await db
        .select({ id: captures.id, deletedAt: captures.deletedAt })
        .from(captures)
        .where(and(isNotNull(captures.deletedAt), gt(captures.id, lastId)))
        .orderBy(captures.id)
        .limit(this.batchSize);
      if (rows.length === 0) return;
      for (const { id, deletedAt } of rows) {
        lastId = id;
        const removed = await this.removeFiles(id);
        if (removed === null) {
          report.errors += 1;
          continue; // never hard-delete a row while its file might still exist
        }
        report.sweptFiles += removed;
        if (deletedAt !== null && deletedAt.getTime() <= cutoff.getTime()) {
          const gone = await db
            .delete(captures)
            .where(and(eq(captures.id, id), lte(captures.deletedAt, cutoff)))
            .returning({ id: captures.id });
          report.hardDeleted += gone.length;
        }
      }
      if (rows.length < this.batchSize) return;
    }
  }

  /** Files removed for one capture, or null when the unlink itself failed. */
  private async removeFiles(id: number): Promise<number | null> {
    try {
      return await this.deps.store.remove(id);
    } catch (err) {
      logSecurityEvent(this.deps.log, { tag: 'sec.purge.file_error', captureId: id, err });
      return null;
    }
  }
}
