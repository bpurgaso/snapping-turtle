import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

/**
 * Local-disk image store (§2, §12). Paths are derived from the internal row
 * id only — `{root}/{shard}/{id}.png` for the re-encoded original and
 * `{root}/{shard}/{id}.flat.png` for the cached flat render (§10, one cache
 * file per capture, overwritten in place) — so nothing user-supplied and no
 * secret ever reaches the filesystem layer.
 */
export class ImageStore {
  constructor(readonly root: string) {}

  pathFor(id: number, variant: 'original' | 'flat' = 'original'): string {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('invalid image id');
    const shard = (id % 256).toString(16).padStart(2, '0');
    return join(this.root, shard, variant === 'flat' ? `${id}.flat.png` : `${id}.png`);
  }

  /** Atomic write: temp file in the shard directory, then rename. */
  async write(
    id: number,
    png: Uint8Array,
    variant: 'original' | 'flat' = 'original',
  ): Promise<void> {
    const target = this.pathFor(id, variant);
    const dir = join(target, '..');
    await mkdir(dir, { recursive: true, mode: 0o750 });
    const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, png, { mode: 0o640, flag: 'wx' });
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  /** Stream + size for an existing image; null when the file is missing. */
  async open(
    id: number,
    variant: 'original' | 'flat' = 'original',
  ): Promise<{ stream: Readable; size: number } | null> {
    const path = this.pathFor(id, variant);
    try {
      const info = await stat(path);
      if (!info.isFile()) return null;
      return { stream: createReadStream(path), size: info.size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * Remove every file for a capture — the original and any flat render.
   * Missing files are not an error (the purge job re-runs over partial
   * state, §13); returns how many files actually existed and were removed.
   */
  async remove(id: number): Promise<number> {
    let removed = 0;
    for (const variant of ['original', 'flat'] as const) {
      try {
        await unlink(this.pathFor(id, variant));
        removed += 1;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    return removed;
  }
}
