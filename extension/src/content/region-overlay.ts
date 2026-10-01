import { normalizeDrag, type CssRect } from '../lib/capture-geometry.js';
import {
  chooseSuggestion,
  describeElement,
  suggestionBadge,
  withinClickSlop,
  type ChainEntry,
  type Edges,
  type ElementTraits,
  type Suggestion,
  type SuggestionKind,
} from '../lib/region-suggest.js';

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
 *
 * Suggestions (E7): while no drag is in progress, the element under the cursor
 * is looked up *through* the overlay with `elementsFromPoint` (the host keeps
 * its pointer events — it has to receive the click) and lib/region-suggest.ts
 * decides whether it or an ancestor is a confident target. A suggestion is
 * highlighted and a click captures it; the highlight lives in the same shadow
 * root, so it leaves with the host before the capture like everything else.
 * A drag is untouched: it starts a manual selection and the highlight is gone
 * the moment it does.
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
  .sug {
    position: absolute; display: none;
    outline: 2px solid #3ddc84;
    box-shadow: 0 0 0 3px rgba(0, 0, 0, 0.7), 0 0 0 200000px rgba(0, 0, 0, 0.35);
    background: transparent;
    pointer-events: none;
  }
  .badge {
    position: absolute; display: none;
    font: 600 12px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif;
    color: #06240f; background: #3ddc84;
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

export const HINT_DRAG_ONLY = 'Drag to select the area to capture · Esc to cancel';
export const HINT_WITH_SUGGESTIONS =
  'Click a highlighted element or drag to select · Esc to cancel';

/** What the suggestion highlight currently shows. */
export interface PaintedSuggestion {
  rect: CssRect;
  kind: SuggestionKind;
  /** The dimensions badge text. */
  badge: string;
  /** True when the edge rule chose an ancestor over a nearer qualifying element. */
  promoted: boolean;
}

export interface SelectRegionHooks {
  /** Called on every repaint with the live rect and the readout text (tests observe the closed shadow tree through this). */
  onPaint?: (rect: CssRect | null, readout: string) => void;
  /** Called whenever the suggestion highlight changes; null when it is dismissed. */
  onSuggest?: (suggestion: PaintedSuggestion | null) => void;
}

export interface SelectRegionOptions {
  /** Element-aware suggestions (E7); the "Smart region suggestions" setting. Default on. */
  suggestions?: boolean;
}

/**
 * Mount the overlay and resolve with the selection, or null on Esc. Resolves
 * only after the overlay is gone and the page has had two frames to repaint.
 */
export function selectRegion(
  doc: Document = document,
  hooks: SelectRegionHooks = {},
  options: SelectRegionOptions = {},
): Promise<RegionSelection | null> {
  const win = doc.defaultView;
  if (!win) return Promise.reject(new Error('document has no window'));
  const view = win;
  const suggesting = options.suggestions !== false;

  return new Promise((resolve, reject) => {
    const host = doc.createElement(OVERLAY_TAG);
    for (const [prop, value] of Object.entries(HOST_STYLE)) {
      host.style.setProperty(prop, value, 'important');
    }
    host.tabIndex = -1;
    host.setAttribute(
      'aria-label',
      suggesting
        ? 'Click a highlighted element or drag to select a region to capture. Press Escape to cancel.'
        : 'Select a region to capture. Press Escape to cancel.',
    );
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
    const sug = doc.createElement('div');
    sug.className = 'sug';
    const badge = doc.createElement('div');
    badge.className = 'badge';
    const hint = doc.createElement('div');
    hint.className = 'hint';
    hint.textContent = suggesting ? HINT_WITH_SUGGESTIONS : HINT_DRAG_ONLY;
    shadow.append(style, dim, sel, size, sug, badge, hint);

    const previouslyFocused = doc.activeElement;
    let start: { x: number; y: number } | null = null;
    let pointerId: number | null = null;
    let done = false;

    /** The highlighted suggestion, if any. */
    let suggestion: Suggestion | null = null;
    /** The suggestion a press landed on: a release within the click slop captures it. */
    let armed: Suggestion | null = null;
    /** Where the pointer last was while hovering; null once it has left the viewport. */
    let hover: { x: number; y: number } | null = null;
    let hoverFrame: number | null = null;
    /** Tag + computed style → traits, once per element for the life of the overlay. */
    const traitsCache = new WeakMap<Element, ElementTraits>();

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
        // A highlighted suggestion casts its own dim.
        dim.style.display = suggestion ? 'none' : 'block';
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

    const paintSuggestion = (next: Suggestion | null): void => {
      const prev = suggestion;
      if (
        prev === next ||
        (prev &&
          next &&
          prev.kind === next.kind &&
          prev.promoted === next.promoted &&
          prev.rect.x === next.rect.x &&
          prev.rect.y === next.rect.y &&
          prev.rect.width === next.rect.width &&
          prev.rect.height === next.rect.height)
      ) {
        return;
      }
      suggestion = next;
      if (!next) {
        sug.style.display = 'none';
        badge.style.display = 'none';
        // The drag rect casts the dim while it is up; otherwise the plain dim returns.
        if (sel.style.display !== 'block') dim.style.display = 'block';
        hooks.onSuggest?.(null);
        return;
      }
      const { rect } = next;
      dim.style.display = 'none';
      sug.style.display = 'block';
      sug.style.left = `${rect.x}px`;
      sug.style.top = `${rect.y}px`;
      sug.style.width = `${rect.width}px`;
      sug.style.height = `${rect.height}px`;
      badge.style.display = 'block';
      badge.textContent = suggestionBadge(rect);
      // Above the rect's top-left corner when there is room — and the hint is
      // not already there — else just inside it.
      const banner = hint.getBoundingClientRect();
      const underHint =
        rect.y - 26 < banner.bottom && rect.x < banner.right && rect.x + 90 > banner.left;
      const above = rect.y >= 28 && !underHint;
      badge.style.top = `${above ? rect.y - 26 : rect.y + 4}px`;
      badge.style.left = `${Math.min(above ? rect.x : rect.x + 4, Math.max(0, viewport().width - 90))}px`;
      hooks.onSuggest?.({
        rect,
        kind: next.kind,
        badge: badge.textContent,
        promoted: next.promoted,
      });
    };

    const traitsOf = (element: Element): ElementTraits => {
      let traits = traitsCache.get(element);
      if (!traits) {
        traits = describeElement(element.localName, view.getComputedStyle(element));
        traitsCache.set(element, traits);
      }
      return traits;
    };

    const edgesOf = (rect: DOMRect): Edges => ({
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
    });

    /** Padding box: what `overflow` clips to. clientWidth/Height exclude the element's own scrollbars. */
    const paddingBox = (element: Element): Edges => {
      const rect = element.getBoundingClientRect();
      const left = rect.left + element.clientLeft;
      const top = rect.top + element.clientTop;
      return { left, top, right: left + element.clientWidth, bottom: top + element.clientHeight };
    };

    /**
     * The suggestion at a viewport point, read through the overlay: the host
     * is the top of the hit-test stack and is skipped; the next element is
     * what the user is pointing at. Pointer events are never toggled.
     */
    const suggestAt = (x: number, y: number): Suggestion | null => {
      const under = doc.elementsFromPoint(x, y).find((element) => element !== host);
      if (!under) return null;
      const chain: ChainEntry[] = [];
      for (let element: Element | null = under; element; element = element.parentElement) {
        const traits = traitsOf(element);
        const entry: ChainEntry = { traits };
        if (traits.kind) entry.rect = edgesOf(element.getBoundingClientRect());
        if (traits.clipsX || traits.clipsY) entry.clip = paddingBox(element);
        chain.push(entry);
      }
      return chooseSuggestion(chain, { x, y }, viewport());
    };

    /** Re-evaluate the hover on the next frame; at most one evaluation per frame. */
    const scheduleHover = (): void => {
      if (!suggesting || hoverFrame !== null || done) return;
      hoverFrame = view.requestAnimationFrame(() => {
        hoverFrame = null;
        if (done || start) return;
        paintSuggestion(hover ? suggestAt(hover.x, hover.y) : null);
      });
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
      if (suggesting) {
        // Decided at the press point, not from the last painted frame: a press
        // can arrive before the hover's frame has run (and touch never hovers).
        hover = { x: event.clientX, y: event.clientY };
        armed = suggestAt(event.clientX, event.clientY);
        paintSuggestion(armed);
        // The highlight stays up until the press turns out to be a drag.
        if (armed) return;
      }
      paint(liveRect(event.clientX, event.clientY));
    };

    const onPointerMove = (event: PointerEvent): void => {
      stop(event);
      if (!start) {
        hover = { x: event.clientX, y: event.clientY };
        scheduleHover();
        return;
      }
      if (armed) {
        if (withinClickSlop(start, { x: event.clientX, y: event.clientY })) return;
        // A drag has started: the highlight goes, now, and the selection is manual.
        armed = null;
        paintSuggestion(null);
      }
      paint(liveRect(event.clientX, event.clientY));
    };

    const selectionFor = (rect: CssRect): RegionSelection => {
      const vp = viewport();
      return {
        ...rect,
        devicePixelRatio: view.devicePixelRatio || 1,
        viewportWidth: vp.width,
        viewportHeight: vp.height,
        innerWidth: view.innerWidth,
        innerHeight: view.innerHeight,
      };
    };

    const onPointerUp = (event: PointerEvent): void => {
      stop(event);
      if (!start || (pointerId !== null && event.pointerId !== pointerId)) return;
      const end = { x: event.clientX, y: event.clientY };
      const clicked = armed && withinClickSlop(start, end) ? armed : null;
      const rect = clicked ? null : normalizeDrag(start, end, viewport());
      start = null;
      pointerId = null;
      armed = null;
      if (clicked) {
        // A click on the highlight captures exactly what it showed.
        finish(selectionFor(clicked.rect));
        return;
      }
      if (!rect) {
        // A click, not a drag: stay mounted and let the user try again.
        paint(null);
        hover = end;
        scheduleHover();
        return;
      }
      finish(selectionFor(rect));
    };

    const onPointerCancel = (event: PointerEvent): void => {
      stop(event);
      start = null;
      pointerId = null;
      armed = null;
      paint(null);
      scheduleHover();
    };

    const onPointerLeave = (event: PointerEvent): void => {
      stop(event);
      if (start) return;
      hover = null;
      scheduleHover();
    };

    /** The page moved under a resting pointer (keyboard scroll, resize, an inner scroller). */
    const onViewChange = (): void => scheduleHover();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' || event.key === 'Esc') {
        stop(event);
        finish(null);
      }
    };

    const cleanup = (): void => {
      view.removeEventListener('keydown', onKeyDown, true);
      view.removeEventListener('scroll', onViewChange, true);
      view.removeEventListener('resize', onViewChange);
      if (hoverFrame !== null) view.cancelAnimationFrame(hoverFrame);
      hoverFrame = null;
      // The highlight and its badge live in the host's shadow root: removing
      // the host removes them, and the two frames below repaint the page.
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
    host.addEventListener('pointerleave', onPointerLeave);
    for (const type of STOPPED_EVENTS) host.addEventListener(type, stop);
    view.addEventListener('keydown', onKeyDown, true);
    if (suggesting) {
      view.addEventListener('scroll', onViewChange, { capture: true, passive: true });
      view.addEventListener('resize', onViewChange, { passive: true });
    }

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
