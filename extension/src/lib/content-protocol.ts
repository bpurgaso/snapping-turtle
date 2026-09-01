import type { PageMetrics } from './capture-geometry.js';
import type { RegionSelection } from '../content/region-overlay.js';

/**
 * Background ↔ content-script protocol for M6 capture. Both ends ship in the
 * same bundle, so it is versionless. Every message is validated on receipt:
 * the content script only honours messages from its own extension, and the
 * background only trusts region results that arrive from one of its own
 * content scripts in a real tab (see background.ts).
 */

export const CONTENT_SCRIPT_FILE = 'content.js';

/** Background → content. */
export type ContentCommand =
  | { type: 'st:region:select' }
  | { type: 'st:page:measure' }
  | { type: 'st:page:begin' }
  | { type: 'st:page:scroll'; y: number }
  | { type: 'st:page:hide-fixed' }
  | { type: 'st:page:restore' };

export interface MeasuredPageMessage extends PageMetrics {
  scrollX: number;
  scrollY: number;
}

/** Content → background, in reply to a command. */
export type ContentReply =
  | { type: 'st:region:started' }
  | { type: 'st:page:metrics'; metrics: MeasuredPageMessage }
  | { type: 'st:page:scrolled'; scrollX: number; scrollY: number; cancelled: boolean }
  | { type: 'st:page:hidden'; count: number }
  | { type: 'st:page:restored' }
  | { type: 'st:error'; message: string };

/** Content → background, unsolicited: the user finished (or abandoned) a region drag. */
export type RegionResultMessage =
  { type: 'st:region:selected'; selection: RegionSelection } | { type: 'st:region:cancelled' };

const COMMAND_TYPES = new Set<ContentCommand['type']>([
  'st:region:select',
  'st:page:measure',
  'st:page:begin',
  'st:page:scroll',
  'st:page:hide-fixed',
  'st:page:restore',
]);

export function isContentCommand(value: unknown): value is ContentCommand {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v['type'] !== 'string' || !COMMAND_TYPES.has(v['type'] as ContentCommand['type'])) {
    return false;
  }
  if (v['type'] === 'st:page:scroll') {
    return typeof v['y'] === 'number' && Number.isFinite(v['y']) && v['y'] >= 0;
  }
  return true;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function isRegionSelection(value: unknown): value is RegionSelection {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    finite(v['x']) &&
    finite(v['y']) &&
    finite(v['width']) &&
    finite(v['height']) &&
    v['width'] > 0 &&
    v['height'] > 0 &&
    finite(v['devicePixelRatio']) &&
    v['devicePixelRatio'] > 0 &&
    finite(v['viewportWidth']) &&
    finite(v['viewportHeight']) &&
    finite(v['innerWidth']) &&
    v['innerWidth'] > 0 &&
    finite(v['innerHeight']) &&
    v['innerHeight'] > 0
  );
}

export function isRegionResult(value: unknown): value is RegionResultMessage {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v['type'] === 'st:region:cancelled') return true;
  return v['type'] === 'st:region:selected' && isRegionSelection(v['selection']);
}

export function isPageMetrics(value: unknown): value is MeasuredPageMessage {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    [
      'documentWidth',
      'documentHeight',
      'viewportWidth',
      'viewportHeight',
      'innerWidth',
      'innerHeight',
      'devicePixelRatio',
    ].every((k) => finite(v[k]) && (v[k] as number) > 0) &&
    finite(v['scrollX']) &&
    finite(v['scrollY'])
  );
}

export function isContentReply(value: unknown): value is ContentReply {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  switch (v['type']) {
    case 'st:region:started':
    case 'st:page:restored':
      return true;
    case 'st:page:metrics':
      return isPageMetrics(v['metrics']);
    case 'st:page:scrolled':
      return finite(v['scrollX']) && finite(v['scrollY']) && typeof v['cancelled'] === 'boolean';
    case 'st:page:hidden':
      return finite(v['count']);
    case 'st:error':
      return typeof v['message'] === 'string';
    default:
      return false;
  }
}
