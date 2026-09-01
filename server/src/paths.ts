import { fileURLToPath } from 'node:url';

/**
 * Filesystem anchors. Resolved relative to this module so they hold both from
 * `src/` (tsx) and from `dist/` (compiled) — the two directories are siblings.
 */
export const serverRoot = fileURLToPath(new URL('..', import.meta.url));
export const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
export const migrationsDir = fileURLToPath(new URL('../drizzle', import.meta.url));
export const defaultWebDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
/** Local-dev image store; compose mounts a volume and sets IMAGES_DIR=/data/images. */
export const defaultImagesDir = fileURLToPath(new URL('../../data/images', import.meta.url));
/** Self-distributed Firefox artifacts served under /ext/ (§15, M8); compose mounts deploy/ext read-only. */
export const defaultExtDir = fileURLToPath(new URL('../../deploy/ext', import.meta.url));
