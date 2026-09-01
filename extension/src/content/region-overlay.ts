import { normalizeDrag, type CssRect } from '../lib/capture-geometry.js';

/**
 * Region-select overlay (PLAN.md §15): dims the page, lets the user drag a
 * rectangle with a live size readout, Esc cancels. Mounted as a closed shadow
 * root on a custom element attached to <html> (not <body>, whose transforms
 * would break fixed positioning) with every host style set inline and
 * !important, so hostile page CSS — even `* { display: none !important }` —
 * cannot restyle it: inline !important outranks stylesheet !important, and
 * nothing outside can reach into a closed shadow tree.
 *
 * Page listeners: pointer/mouse/click events are stopped at the host, so
 * bubble-phase page listeners never see them and no page element is ever the
 * target (the overlay covers the viewport). Capture-phase listeners on
 * window/document fire before the host and cannot be suppressed by design —
 * that is a platform limit, not a bug.
 *
 * On confirm the overlay is removed and two animation frames are awaited
 * before the promise resolves, so the background's captureVisibleTab never
 * sees the overlay in its own screenshot. No extension APIs here: this module
 * mounts in any page, which is how the Playwright browser tests drive it.
 */

export interface RegionSelection extends CssRect {
  /** Viewport-relative CSS px (clientX/clientY space), what captureVisibleTab shows. */
  devicePixelRatio: number;
  /** documentElement.clientWidth/Height: the content box, excluding classic scrollbars. */
  viewportWidth: number;
  viewportHeight: number;
  /** window.innerWidth/innerHeight: what captureVisibleTab renders, for deriving the real scale. */
  innerWidth: number;
  innerHeight: number;
}

/** Highest 32-bit z-index; nothing in the page can sit above it. */
export const OVERLAY_Z_INDEX = 2147483647;
export const OVERLAY_TAG = 'snapping-turtle-region';

const HOST_STYLE: Record<string, string> = {
  position: 'fixed',
  inset: '0',
  width: '100vw',
  height: '100vh',
  margin: '0',
  padding: '0',
  border: '0',
  display: 'block',
  visibility: 'visible',
  opacity: '1',
  transform: 'none',
  filter: 'none',
  'pointer-events': 'auto',
  'user-select': 'none',
  cursor: 'crosshair',
  'z-index': String(OVERLAY_Z_INDEX),
  overflow: 'visible',
  'clip-path': 'none',
  contain: 'none',
  'touch-action': 'none',
};

const SHADOW_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .dim {
    position: absolute; inset: 0;
    background: rgba(0, 0, 0, 0.35);
  }
  .sel {
    position: absolute; display: none;
    outline: 1px solid #fff;
    box-shadow: 0 0 0 200000px rgba(0, 0, 0, 0.35);
    background: transparent;
  }
  .size {
    position: absolute; display: none;
    font: 12px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif;
    color: #fff; background: rgba(20, 20, 20, 0.85);
    padding: 2px 6px; border-radius: 4px; white-space: nowrap;
    pointer-events: none;
  }
  .hint {
    position: absolute; top: 12px; left: 50%; transform: translateX(-50%);
    font: 13px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif;
    color: #fff; background: rgba(20, 20, 20, 0.85);
    padding: 6px 12px; border-radius: 6px; white-space: nowrap;
    pointer-events: none;
  }
`;

const STOPPED_EVENTS = [
  'mousedown',
  'mouseup',
  'mousemove',
  'click',
  'dblclick',
  'contextmenu',
  'auxclick',
  'wheel',
  'selectstart',
  'dragstart',
  'touchstart',
  'touchmove',
  'touchend',
] as const;

export interface SelectRegionHooks {
  /** Called on every repaint with the live rect and the readout text (tests observe the closed shadow tree through this). */
  onPaint?: (rect: CssRect | null, readout: string) => void;
}

/**
 * Mount the overlay and resolve with the selection, or null on Esc. Resolves
 * only after the overlay is gone and the page has had two frames to repaint.
 */
export function selectRegion(
  doc: Document = document,
  hooks: SelectRegionHooks = {},
): Promise<RegionSelection | null> {
  const win = doc.defaultView;
  if (!win) return Promise.reject(new Error('document has no window'));
  const view = win;

  return new Promise((resolve, reject) => {
    const host = doc.createElement(OVERLAY_TAG);
    for (const [prop, value] of Object.entries(HOST_STYLE)) {
      host.style.setProperty(prop, value, 'important');
    }
    host.tabIndex = -1;
    host.setAttribute('aria-label', 'Select a region to capture. Press Escape to cancel.');
    host.setAttribute('role', 'dialog');

    const shadow = host.attachShadow({ mode: 'closed' });
    const style = doc.createElement('style');
    style.textContent = SHADOW_CSS;
    const dim = doc.createElement('div');
    dim.className = 'dim';
    const sel = doc.createElement('div');
    sel.className = 'sel';
    const size = doc.createElement('div');
    size.className = 'size';
    const hint = doc.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Drag to select the area to capture · Esc to cancel';
    shadow.append(style, dim, sel, size, hint);

    const previouslyFocused = doc.activeElement;
    let start: { x: number; y: number } | null = null;
    let pointerId: number | null = null;
    let done = false;

    const viewport = (): { width: number; height: number } => ({
      width: doc.documentElement.clientWidth || view.innerWidth,
      height: doc.documentElement.clientHeight || view.innerHeight,
    });

    const stop = (event: Event): void => {
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (event.cancelable) event.preventDefault();
    };

    const paint = (rect: CssRect | null): void => {
      if (!rect) {
        sel.style.display = 'none';
        size.style.display = 'none';
        dim.style.display = 'block';
        hooks.onPaint?.(null, '');
        return;
      }
      dim.style.display = 'none';
      sel.style.display = 'block';
      sel.style.left = `${rect.x}px`;
      sel.style.top = `${rect.y}px`;
      sel.style.width = `${rect.width}px`;
      sel.style.height = `${rect.height}px`;
      size.style.display = 'block';
      size.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
      // Below the rect when there is room, else inside its bottom edge.
      const vp = viewport();
      const belowTop = rect.y + rect.height + 6;
      size.style.top = `${belowTop + 24 <= vp.height ? belowTop : Math.max(0, rect.y + rect.height - 26)}px`;
      size.style.left = `${Math.min(rect.x, Math.max(0, vp.width - 90))}px`;
      hooks.onPaint?.(rect, size.textContent ?? '');
    };

    /** Live rect while dragging: clamped but not subject to the minimum size. */
    const liveRect = (x: number, y: number): CssRect => {
      const vp = viewport();
      const cx = Math.min(Math.max(x, 0), vp.width);
      const cy = Math.min(Math.max(y, 0), vp.height);
      const sx = start!.x;
      const sy = start!.y;
      return {
        x: Math.min(sx, cx),
        y: Math.min(sy, cy),
        width: Math.abs(cx - sx),
        height: Math.abs(cy - sy),
      };
    };

    const onPointerDown = (event: PointerEvent): void => {
      stop(event);
      if (event.button !== 0 || start) return;
      start = { x: event.clientX, y: event.clientY };
      pointerId = event.pointerId;
      try {
        host.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic events may have no live pointer; dragging still works via host listeners.
      }
      paint(liveRect(event.clientX, event.clientY));
    };

    const onPointerMove = (event: PointerEvent): void => {
      stop(event);
      if (!start) return;
      paint(liveRect(event.clientX, event.clientY));
    };

    const onPointerUp = (event: PointerEvent): void => {
      stop(event);
      if (!start || (pointerId !== null && event.pointerId !== pointerId)) return;
      const rect = normalizeDrag(start, { x: event.clientX, y: event.clientY }, viewport());
      start = null;
      pointerId = null;
      if (!rect) {
        // A click, not a drag: stay mounted and let the user try again.
        paint(null);
        return;
      }
      const vp = viewport();
      finish({
        ...rect,
        devicePixelRatio: view.devicePixelRatio || 1,
        viewportWidth: vp.width,
        viewportHeight: vp.height,
        innerWidth: view.innerWidth,
        innerHeight: view.innerHeight,
      });
    };

    const onPointerCancel = (event: PointerEvent): void => {
      stop(event);
      start = null;
      pointerId = null;
      paint(null);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' || event.key === 'Esc') {
        stop(event);
        finish(null);
      }
    };

    const cleanup = (): void => {
      view.removeEventListener('keydown', onKeyDown, true);
      host.remove();
      if (previouslyFocused instanceof HTMLElement && doc.contains(previouslyFocused)) {
        try {
          previouslyFocused.focus({ preventScroll: true });
        } catch {
          // Focus restoration is best-effort.
        }
      }
    };

    const finish = (result: RegionSelection | null): void => {
      if (done) return;
      done = true;
      cleanup();
      // Two frames: the removal is committed on the first, painted by the second.
      void afterRepaint(view).then(() => resolve(result), reject);
    };

    host.addEventListener('pointerdown', onPointerDown);
    host.addEventListener('pointermove', onPointerMove);
    host.addEventListener('pointerup', onPointerUp);
    host.addEventListener('pointercancel', onPointerCancel);
    for (const type of STOPPED_EVENTS) host.addEventListener(type, stop);
    view.addEventListener('keydown', onKeyDown, true);

    doc.documentElement.append(host);
    try {
      host.focus({ preventScroll: true });
    } catch {
      // Some documents refuse focus; Esc still arrives via the window listener.
    }
  });
}

/** Resolves after two animation frames, or 250 ms if frames are not being delivered. */
export function afterRepaint(win: Window): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    win.requestAnimationFrame(() => win.requestAnimationFrame(finish));
    win.setTimeout(finish, 250);
  });
}
