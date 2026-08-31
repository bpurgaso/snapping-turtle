import { MAX_IMAGE_PIXELS } from '@snapping-turtle/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import sharp from 'sharp';
import type { Db } from '../db/client.js';
import { captures } from '../db/schema.js';
import { pinRendererFonts } from './fonts.js';
import type { ImageStore } from './storage.js';
import { buildOverlaySvg } from './svg-overlay.js';

/**
 * Flat-render pipeline (PLAN.md §10): rasterize the SVG overlay onto the
 * re-encoded original with sharp and cache the result as one file per capture,
 * overwritten in place. `flat_rev` records which revision the file holds; the
 * route serves the cache while `flat_rev === annotations_rev` and calls
 * `ensure()` otherwise. No `view_id` ever enters this module — renders are
 * keyed and logged by internal capture id only (CLAUDE.md rule 3).
 */

/**
 * Concurrency limiter + per-key single-flight: at most `limit` renders run at
 * once (a burst of viewers must not become a CPU-exhaustion vector), and
 * concurrent calls for the same capture coalesce onto one in-flight render.
 */
export class RenderGate<T> {
  private readonly waiters: Array<() => void> = [];
  private active = 0;
  private readonly inflight = new Map<number, Promise<T>>();

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('invalid render concurrency');
  }

  /** Number of jobs started — observable for tests; not part of serving logic. */
  started = 0;

  run(key: number, job: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = this.acquire()
      .then(() => {
        this.started += 1;
        return job();
      })
      .finally(() => {
        this.inflight.delete(key);
        this.release();
      });
    this.inflight.set(key, p);
    return p;
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }
}

export interface FlatRendererDeps {
  db: Db;
  store: ImageStore;
  log?: FastifyBaseLogger;
  /** Parallel sharp composites; §10 sizes this at ~2. */
  concurrency?: number;
}

export type EnsureResult =
  /** The capture disappeared (deleted) between lookup and render. */
  | null
  /** `rev` is now represented on disk: the flat file, or the original when `empty`. */
  | { rev: number; empty: boolean };

export class FlatRenderer {
  private readonly db: Db;
  private readonly store: ImageStore;
  private readonly log: FastifyBaseLogger | undefined;
  readonly gate: RenderGate<EnsureResult>;

  constructor(deps: FlatRendererDeps) {
    this.db = deps.db;
    this.store = deps.store;
    this.log = deps.log;
    this.gate = new RenderGate(deps.concurrency ?? 2);
    pinRendererFonts();
  }

  /**
   * Bring the on-disk flat render up to date for one capture. Re-reads the
   * row inside the job so coalesced callers always get the freshest revision
   * that was current when the render started; a save racing the render leaves
   * `flat_rev` stale (the guarded UPDATE misses) and the next request simply
   * renders again.
   */
  ensure(captureId: number): Promise<EnsureResult> {
    return this.gate.run(captureId, () => this.render(captureId));
  }

  private async render(captureId: number): Promise<EnsureResult> {
    const [row] = await this.db
      .select({
        annotations: captures.annotations,
        annotationsRev: captures.annotationsRev,
        width: captures.width,
        height: captures.height,
      })
      .from(captures)
      .where(and(eq(captures.id, captureId), isNull(captures.deletedAt)))
      .limit(1);
    if (!row) return null;

    const rev = row.annotationsRev;
    if (row.annotations.shapes.length === 0) return { rev, empty: true };

    const startedAt = Date.now();
    const overlay = buildOverlaySvg(row.annotations, { width: row.width, height: row.height });
    const png = await sharp(this.store.pathFor(captureId), {
      limitInputPixels: MAX_IMAGE_PIXELS,
      sequentialRead: true,
    })
      .composite([{ input: Buffer.from(overlay, 'utf8') }])
      .png()
      .toBuffer();
    // File first, then the revision marker: flat_rev never claims a render
    // that is not on disk, and a crash in between just re-renders next time.
    await this.store.write(captureId, png, 'flat');
    await this.db
      .update(captures)
      .set({ flatRev: rev })
      .where(and(eq(captures.id, captureId), eq(captures.annotationsRev, rev)));
    this.log?.info(
      { captureId, rev, ms: Date.now() - startedAt, bytes: png.length },
      'flat render complete',
    );
    return { rev, empty: false };
  }
}
