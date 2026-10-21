import { normalizeDrag, type CssRect } from '../lib/capture-geometry.js';
import {
  contains,
  describeElement,
  passesSizeGuards,
  suggestionBadge,
  visibleRect,
  withinClickSlop,
  type ChainEntry,
  type Edges,
  type SuggestionKind,
} from '../lib/region-suggest.js';
import {
  resolveHover,
  SCAN_PRESS_BUDGET_MS,
  SCAN_RESCAN_THROTTLE_MS,
  SNAP_DISTANCE_CSS_PX,
  snapToEdges,
  SpatialIndex,
  StructureScan,
  viewportRect,
  type HoverCandidate,
  type NodeDescriptor,
  type ScanEnvironment,
  type ScanRecord,
  type ScanSource,
  type ScanStats,
  type SnappedPoint,
  type StructureStyle,
} from '../lib/structure-scan.js';

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
 * Suggestions (E7, restructured in E11): when the overlay mounts with the
 * assist on, it scans the visible DOM once — in animation-frame slices, under
 * the budgets in lib/structure-scan.ts — into a spatial index of confident
 * targets. A hover is then a lookup: the candidates containing the point,
 * restricted to the live hit path (`elementsFromPoint` through the overlay —
 * the host keeps its pointer events, it has to receive the click — so a
 * covered element is never suggested), resolved by the precedence documented
 * in the scan module. A MutationObserver and the scroll/resize events
 * schedule throttled rescans, so a feed that grows under the open overlay
 * becomes suggestible without leaving region mode. A suggestion is highlighted
 * and a click captures it — re-reading that one element's live rect, so what
 * is captured is where the element is, not where the index last saw it. The
 * highlight lives in the same shadow root, so it leaves with the host before
 * the capture like everything else.
 *
 * A drag is manual, as before, with one assist: each edge of the rectangle
 * snaps to a candidate boundary within SNAP_DISTANCE_CSS_PX (a green guide
 * marks a snapped edge), and holding Alt suppresses it for the pixel-perfect
 * case. The one setting governs the whole assist: with it off there is no
 * scan, no highlight and no snapping.
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
  .guide {
    position: absolute; display: none;
    background: #3ddc84;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6);
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

/** Elements with no box of their own and nothing to find inside. */
const SKIP_TAGS: ReadonlySet<string> = new Set([
  'head',
  'script',
  'style',
  'template',
  'noscript',
  'link',
  'meta',
  'title',
  'base',
]);
/** Elements whose insides are not elements to suggest (an svg's paths, a video's tracks, a frame's document). */
const OPAQUE_TAGS: ReadonlySet<string> = new Set([
  'svg',
  'canvas',
  'video',
  'audio',
  'iframe',
  'object',
  'embed',
  'img',
  'input',
  'textarea',
  'select',
]);
/** Attribute changes that can restyle or re-shape a subtree. */
const WATCHED_ATTRIBUTES = [
  'class',
  'style',
  'hidden',
  'open',
  'role',
  'aria-label',
  'aria-labelledby',
];
/** Past this many dirty subtrees a rescan re-reads every style rather than walking each one. */
const DIRTY_SUBTREE_LIMIT = 64;
/** How many hover timings the metrics keep. */
const HOVER_SAMPLE_LIMIT = 512;

export const HINT_DRAG_ONLY = 'Drag to select the area to capture · Esc to cancel';
export const HINT_WITH_SUGGESTIONS =
  'Click a highlighted element or drag to select · hold Alt to stop edges snapping · Esc to cancel';

/** What the suggestion highlight currently shows. */
export interface PaintedSuggestion {
  rect: CssRect;
  kind: SuggestionKind;
  /** The dimensions badge text. */
  badge: string;
  /** True when the edge rule chose an ancestor over a nearer qualifying element. */
  promoted: boolean;
}

/** Which edges of the drag rectangle are snapped to a candidate boundary. */
export interface SnappedEdges {
  left: boolean;
  top: boolean;
  right: boolean;
  bottom: boolean;
}

/** Scan and hover measurements, for the perf fixture and the console. */
export interface OverlayMetrics {
  /** The most recent completed scan, or null before the first finishes. */
  scan: ScanStats | null;
  /** Completed scans, rescans included. */
  scans: number;
  hover: {
    count: number;
    totalMs: number;
    maxMs: number;
    /** The most recent HOVER_SAMPLE_LIMIT timings. */
    samples: number[];
  };
}

export interface SelectRegionHooks {
  /** Called on every repaint with the live rect and the readout text (tests observe the closed shadow tree through this). */
  onPaint?: (rect: CssRect | null, readout: string) => void;
  /** Called whenever the suggestion highlight changes; null when it is dismissed. */
  onSuggest?: (suggestion: PaintedSuggestion | null) => void;
  /** Called on every drag repaint with the edges that snapped. */
  onSnap?: (edges: SnappedEdges) => void;
  /** Called when a scan completes and after every hover evaluation. */
  onMetrics?: (metrics: OverlayMetrics) => void;
}

export interface SelectRegionOptions {
  /** Element-aware suggestions and edge snapping (E7/E11); the "Smart region suggestions" setting. Default on. */
  suggestions?: boolean;
}

/** A highlighted target: the rect to capture and the element it came from. */
interface Highlight {
  rect: CssRect;
  kind: SuggestionKind;
  promoted: boolean;
  node: Element;
}

const NO_SNAP: SnappedEdges = { left: false, top: false, right: false, bottom: false };

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
    const guides = {
      left: doc.createElement('div'),
      top: doc.createElement('div'),
      right: doc.createElement('div'),
      bottom: doc.createElement('div'),
    };
    for (const guide of Object.values(guides)) guide.className = 'guide';
    const hint = doc.createElement('div');
    hint.className = 'hint';
    hint.textContent = suggesting ? HINT_WITH_SUGGESTIONS : HINT_DRAG_ONLY;
    shadow.append(style, dim, sel, size, sug, badge, ...Object.values(guides), hint);

    const previouslyFocused = doc.activeElement;
    /** The press point, unsnapped: the click-slop reference. */
    let start: { x: number; y: number } | null = null;
    /** The press point after snapping: the rectangle's anchor corner. */
    let anchor: SnappedPoint | null = null;
    let pointerId: number | null = null;
    let done = false;

    /** The highlighted suggestion, if any. */
    let suggestion: Highlight | null = null;
    /** The suggestion a press landed on: a release within the click slop captures it. */
    let armed: Highlight | null = null;
    /** Where the pointer last was; null once it has left the viewport. */
    let hover: { x: number; y: number } | null = null;
    let hoverFrame: number | null = null;
    /** Alt as last seen on a key or pointer event. */
    let altHeld = false;

    const viewport = (): { width: number; height: number } => ({
      width: doc.documentElement.clientWidth || view.innerWidth,
      height: doc.documentElement.clientHeight || view.innerHeight,
    });

    const env: ScanEnvironment = {
      viewport,
      scroll: () => ({ x: view.scrollX, y: view.scrollY }),
      now: () => view.performance.now(),
    };

    // ---- the scan: a DOM source, the driver, and the rescan scheduler ------------

    /** Style-derived part of a descriptor, read once per element until the element is dirtied. */
    type StaticPart = Omit<NodeDescriptor, 'rect' | 'clip'>;
    let styleCache = new WeakMap<Element, StaticPart>();

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

    const readStyle = (cs: CSSStyleDeclaration): StructureStyle => ({
      visibility: cs.visibility,
      opacity: cs.opacity,
      position: cs.position,
      overflowX: cs.overflowX,
      overflowY: cs.overflowY,
      borderTopWidth: cs.borderTopWidth,
      borderTopStyle: cs.borderTopStyle,
      borderTopColor: cs.borderTopColor,
      borderRightWidth: cs.borderRightWidth,
      borderRightStyle: cs.borderRightStyle,
      borderRightColor: cs.borderRightColor,
      borderBottomWidth: cs.borderBottomWidth,
      borderBottomStyle: cs.borderBottomStyle,
      borderBottomColor: cs.borderBottomColor,
      borderLeftWidth: cs.borderLeftWidth,
      borderLeftStyle: cs.borderLeftStyle,
      borderLeftColor: cs.borderLeftColor,
      boxShadow: cs.boxShadow,
      display: cs.display,
      backgroundColor: cs.backgroundColor,
      backgroundImage: cs.backgroundImage,
      borderTopLeftRadius: cs.borderTopLeftRadius,
      borderTopRightRadius: cs.borderTopRightRadius,
      borderBottomRightRadius: cs.borderBottomRightRadius,
      borderBottomLeftRadius: cs.borderBottomLeftRadius,
    });

    const staticPart = (element: Element): StaticPart => {
      let part = styleCache.get(element);
      if (part) return part;
      const localName = element.localName;
      const roleAttr = element.getAttribute('role');
      const role = roleAttr ? (roleAttr.trim().split(/\s+/)[0]?.toLowerCase() ?? null) : null;
      const label = element.getAttribute('aria-label');
      const named =
        (label !== null && label.trim() !== '') || element.hasAttribute('aria-labelledby');
      let hasOwnHeading = false;
      if (localName === 'section') {
        const heading = element.querySelector('h1,h2,h3,h4,h5,h6');
        hasOwnHeading = heading !== null && heading.closest('section') === element;
      }
      part = {
        localName,
        role,
        named,
        hasOwnHeading,
        style: readStyle(view.getComputedStyle(element)),
      };
      styleCache.set(element, part);
      return part;
    };

    const source: ScanSource<Element> = {
      root: doc.documentElement,
      children(element) {
        if (OPAQUE_TAGS.has(element.localName)) return [];
        const out: Element[] = [];
        for (const child of element.children) {
          if (child === host || SKIP_TAGS.has(child.localName)) continue;
          out.push(child);
        }
        return out;
      },
      bounds(element) {
        return edgesOf(element.getBoundingClientRect());
      },
      describe(element) {
        const part = staticPart(element);
        const descriptor: NodeDescriptor = {
          ...part,
          rect: edgesOf(element.getBoundingClientRect()),
        };
        const { overflowX, overflowY } = part.style;
        if (
          (overflowX !== 'visible' && overflowX !== '') ||
          (overflowY !== 'visible' && overflowY !== '')
        ) {
          descriptor.clip = paddingBox(element);
        }
        return descriptor;
      },
    };

    /** The scan in progress, if any. */
    let scan: StructureScan<Element> | null = null;
    /** What hover and snapping read: the last completed scan's index (the first scan's, live, until it completes). */
    let spatial = new SpatialIndex<Element>();
    let records = new Map<Element, ScanRecord<Element>>();
    let scanFrame: number | null = null;
    let rescanTimer: number | null = null;
    let rescanWanted = false;
    let lastScanEnd = Number.NEGATIVE_INFINITY;
    /** Elements whose subtree's styles may have changed since they were read. */
    const dirty = new Set<Element>();
    let invalidateAll = false;
    let observer: MutationObserver | null = null;

    const metrics: OverlayMetrics = {
      scan: null,
      scans: 0,
      hover: { count: 0, totalMs: 0, maxMs: 0, samples: [] },
    };
    const snapshotMetrics = (): OverlayMetrics => ({
      scan: metrics.scan ? { ...metrics.scan } : null,
      scans: metrics.scans,
      hover: { ...metrics.hover, samples: [...metrics.hover.samples] },
    });

    /** The running scan has stopped: serve its index, record it, and run what waited on it. */
    const completeScan = (): void => {
      if (!scan) return;
      spatial = scan.index;
      records = scan.records;
      metrics.scan = scan.stats();
      metrics.scans++;
      scan = null;
      lastScanEnd = env.now();
      hooks.onMetrics?.(snapshotMetrics());
      scheduleHover();
      if (rescanWanted) {
        rescanWanted = false;
        requestRescan();
      }
    };

    const pumpScan = (): void => {
      if (scanFrame !== null || !scan || done) return;
      scanFrame = view.requestAnimationFrame(() => {
        scanFrame = null;
        if (done || !scan) return;
        if (scan.step() === 'running') pumpScan();
        else completeScan();
      });
    };

    /**
     * A press before the first scan has finished: scan synchronously for up
     * to SCAN_PRESS_BUDGET_MS so the element under the pointer is known. A
     * press can arrive before the hover's frame has run, and touch never
     * hovers; the page was still being read in frame slices.
     */
    const settleForPress = (): void => {
      if (!scan || metrics.scans > 0) return;
      const started = env.now();
      while (scan && env.now() - started < SCAN_PRESS_BUDGET_MS) {
        if (scan.step() !== 'running') completeScan();
      }
    };

    const startScan = (): void => {
      if (done || !suggesting || scan) return;
      if (invalidateAll || dirty.size > DIRTY_SUBTREE_LIMIT) {
        styleCache = new WeakMap();
      } else {
        for (const element of dirty) {
          styleCache.delete(element);
          for (const descendant of element.querySelectorAll('*')) styleCache.delete(descendant);
        }
      }
      invalidateAll = false;
      dirty.clear();
      scan = new StructureScan(source, env);
      if (spatial.all.length === 0) {
        // Nothing to serve yet: hover reads the first scan as it fills.
        spatial = scan.index;
        records = scan.records;
      }
      pumpScan();
    };

    /** A rescan, at most one every SCAN_RESCAN_THROTTLE_MS, after any running scan. */
    const requestRescan = (): void => {
      if (done || !suggesting) return;
      if (scan) {
        rescanWanted = true;
        return;
      }
      if (rescanTimer !== null) return;
      const wait = Math.max(0, SCAN_RESCAN_THROTTLE_MS - (env.now() - lastScanEnd));
      rescanTimer = view.setTimeout(() => {
        rescanTimer = null;
        startScan();
      }, wait);
    };

    const onMutations = (list: MutationRecord[]): void => {
      let changed = false;
      for (const mutation of list) {
        const target =
          mutation.target.nodeType === 1
            ? (mutation.target as Element)
            : mutation.target.parentElement;
        if (!target || target === host || host.contains(target)) continue;
        changed = true;
        if (mutation.type === 'attributes') dirty.add(target);
      }
      if (changed) requestRescan();
    };

    // ---- painting -----------------------------------------------------------------

    const stop = (event: Event): void => {
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (event.cancelable) event.preventDefault();
    };

    const paint = (rect: CssRect | null): void => {
      if (!rect) {
        sel.style.display = 'none';
        size.style.display = 'none';
        paintGuides(null, NO_SNAP);
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

    /** Green guides along the snapped edges of the drag rectangle. */
    const paintGuides = (rect: CssRect | null, snapped: SnappedEdges): void => {
      const place = (
        guide: HTMLElement,
        on: boolean,
        left: number,
        top: number,
        width: number,
        height: number,
      ): void => {
        guide.style.display = on && rect ? 'block' : 'none';
        if (!on || !rect) return;
        guide.style.left = `${left}px`;
        guide.style.top = `${top}px`;
        guide.style.width = `${width}px`;
        guide.style.height = `${height}px`;
      };
      const r = rect ?? { x: 0, y: 0, width: 0, height: 0 };
      place(guides.left, snapped.left, r.x - 1, r.y - 6, 2, r.height + 12);
      place(guides.right, snapped.right, r.x + r.width - 1, r.y - 6, 2, r.height + 12);
      place(guides.top, snapped.top, r.x - 6, r.y - 1, r.width + 12, 2);
      place(guides.bottom, snapped.bottom, r.x - 6, r.y + r.height - 1, r.width + 12, 2);
    };

    const paintSuggestion = (next: Highlight | null): void => {
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
        if (prev && next) suggestion = next; // same highlight, possibly a fresher element reference
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

    // ---- hover: a lookup against the index, on the live hit path -----------------

    const noteHover = (ms: number): void => {
      metrics.hover.count++;
      metrics.hover.totalMs += ms;
      if (ms > metrics.hover.maxMs) metrics.hover.maxMs = ms;
      metrics.hover.samples.push(ms);
      if (metrics.hover.samples.length > HOVER_SAMPLE_LIMIT) metrics.hover.samples.shift();
      hooks.onMetrics?.(snapshotMetrics());
    };

    /**
     * The suggestion at a viewport point: candidates whose indexed rect
     * contains it, kept only when they are the element under the pointer or
     * one of its ancestors (the host is the top of the hit-test stack and is
     * skipped), resolved by the scan module's precedence.
     */
    const suggestAt = (x: number, y: number): Highlight | null => {
      const started = env.now();
      try {
        const under = doc.elementsFromPoint(x, y).find((element) => element !== host);
        if (!under) return null;
        const scroll = env.scroll();
        const containing = spatial.containing({ x: x + scroll.x, y: y + scroll.y }, { x, y });
        if (containing.length === 0) return null;
        const path = new Set<Element>();
        for (let element: Element | null = under; element; element = element.parentElement) {
          path.add(element);
        }
        const vp = viewport();
        const live: HoverCandidate[] = [];
        const nodes = new Map<number, Element>();
        for (const candidate of containing) {
          if (!path.has(candidate.node)) continue;
          const converted = viewportRect(candidate, scroll, vp);
          if (!converted) continue;
          live.push({
            id: candidate.id,
            kind: candidate.kind,
            rect: converted.rect,
            box: converted.box,
            depth: candidate.depth,
          });
          nodes.set(candidate.id, candidate.node);
        }
        const hit = resolveHover(live, { x, y }, vp);
        if (!hit) return null;
        return { rect: hit.rect, kind: hit.kind, promoted: hit.promoted, node: nodes.get(hit.id)! };
      } finally {
        noteHover(env.now() - started);
      }
    };

    /**
     * What a click on a highlight captures: the element's rect as it is now,
     * cut by its clipping ancestors exactly as E7 did — the index may be a
     * frame or a scroll behind. The indexed rect is the fallback when the
     * element no longer contains the point.
     */
    const captureRect = (target: Highlight, point: { x: number; y: number }): CssRect => {
      const chain: ChainEntry[] = [];
      for (let element: Element | null = target.node; element; element = element.parentElement) {
        const traits =
          records.get(element)?.traits ??
          describeElement(element.localName, view.getComputedStyle(element));
        const entry: ChainEntry = { traits };
        if (element === target.node) entry.rect = edgesOf(element.getBoundingClientRect());
        if (traits.clipsX || traits.clipsY) entry.clip = paddingBox(element);
        chain.push(entry);
      }
      const vp = viewport();
      const live = visibleRect(chain, 0, vp);
      return live && passesSizeGuards(live, target.kind, vp) && contains(live, point)
        ? live
        : target.rect;
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

    // ---- dragging, with magnetic edges --------------------------------------------

    /** The point, snapped to nearby candidate edges unless Alt is held or the assist is off. */
    const snapPoint = (point: { x: number; y: number }, alt: boolean): SnappedPoint => {
      if (!suggesting || alt) return { x: point.x, y: point.y, snappedX: false, snappedY: false };
      return snapToEdges(point, spatial.edgesNear(point, env.scroll(), SNAP_DISTANCE_CSS_PX));
    };

    /** Live rect while dragging: clamped but not subject to the minimum size. */
    const liveRect = (x: number, y: number): CssRect => {
      const vp = viewport();
      const cx = Math.min(Math.max(x, 0), vp.width);
      const cy = Math.min(Math.max(y, 0), vp.height);
      const sx = anchor!.x;
      const sy = anchor!.y;
      return {
        x: Math.min(sx, cx),
        y: Math.min(sy, cy),
        width: Math.abs(cx - sx),
        height: Math.abs(cy - sy),
      };
    };

    /** Paint the drag rectangle to a (snapped) corner and mark which of its edges snapped. */
    const paintDrag = (corner: SnappedPoint): void => {
      const rect = liveRect(corner.x, corner.y);
      paint(rect);
      const a = anchor!;
      const snapped: SnappedEdges = { ...NO_SNAP };
      if (corner.snappedX) snapped[corner.x < a.x ? 'left' : 'right'] = true;
      if (a.snappedX) snapped[a.x <= corner.x ? 'left' : 'right'] = true;
      if (corner.snappedY) snapped[corner.y < a.y ? 'top' : 'bottom'] = true;
      if (a.snappedY) snapped[a.y <= corner.y ? 'top' : 'bottom'] = true;
      paintGuides(rect, snapped);
      hooks.onSnap?.(snapped);
    };

    const onPointerDown = (event: PointerEvent): void => {
      stop(event);
      if (event.button !== 0 || start) return;
      altHeld = event.altKey;
      start = { x: event.clientX, y: event.clientY };
      anchor = { x: start.x, y: start.y, snappedX: false, snappedY: false };
      pointerId = event.pointerId;
      try {
        host.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic events may have no live pointer; dragging still works via host listeners.
      }
      if (suggesting) {
        // Decided at the press point, not from the last painted frame: a press
        // can arrive before the hover's frame has run (and touch never hovers).
        settleForPress();
        hover = { x: event.clientX, y: event.clientY };
        anchor = snapPoint(start, altHeld);
        armed = suggestAt(event.clientX, event.clientY);
        paintSuggestion(armed);
        // The highlight stays up until the press turns out to be a drag.
        if (armed) return;
      }
      paintDrag(snapPoint({ x: event.clientX, y: event.clientY }, altHeld));
    };

    const onPointerMove = (event: PointerEvent): void => {
      stop(event);
      altHeld = event.altKey;
      hover = { x: event.clientX, y: event.clientY };
      if (!start) {
        scheduleHover();
        return;
      }
      if (armed) {
        if (withinClickSlop(start, hover)) return;
        // A drag has started: the highlight goes, now, and the selection is manual.
        armed = null;
        paintSuggestion(null);
      }
      paintDrag(snapPoint(hover, altHeld));
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
      altHeld = event.altKey;
      const end = { x: event.clientX, y: event.clientY };
      const clicked = armed && withinClickSlop(start, end) ? armed : null;
      const pressed = start;
      const corner = snapPoint(end, altHeld);
      const rect = clicked ? null : normalizeDrag(anchor!, corner, viewport());
      start = null;
      anchor = null;
      pointerId = null;
      armed = null;
      if (clicked) {
        // A click on the highlight captures the element it showed, where it is now.
        finish(selectionFor(captureRect(clicked, pressed)));
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
      anchor = null;
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

    /** The page scrolled under the overlay: the highlight follows, and the index catches up. */
    const onScroll = (): void => {
      scheduleHover();
      requestRescan();
    };

    /** A resize can restyle anything (media queries): every style is re-read. */
    const onResize = (): void => {
      invalidateAll = true;
      scheduleHover();
      requestRescan();
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' || event.key === 'Esc') {
        stop(event);
        finish(null);
        return;
      }
      if (event.key === 'Alt') onAltChange(true);
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === 'Alt') onAltChange(false);
    };

    /** Alt pressed or released mid-drag: the live rectangle re-snaps (or stops) at once. */
    const onAltChange = (held: boolean): void => {
      if (altHeld === held) return;
      altHeld = held;
      if (start && !armed && hover) paintDrag(snapPoint(hover, altHeld));
    };

    const cleanup = (): void => {
      view.removeEventListener('keydown', onKeyDown, true);
      view.removeEventListener('keyup', onKeyUp, true);
      view.removeEventListener('scroll', onScroll, true);
      view.removeEventListener('resize', onResize);
      if (hoverFrame !== null) view.cancelAnimationFrame(hoverFrame);
      hoverFrame = null;
      if (scanFrame !== null) view.cancelAnimationFrame(scanFrame);
      scanFrame = null;
      if (rescanTimer !== null) view.clearTimeout(rescanTimer);
      rescanTimer = null;
      observer?.disconnect();
      observer = null;
      scan = null;
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
      view.addEventListener('keyup', onKeyUp, true);
      view.addEventListener('scroll', onScroll, { capture: true, passive: true });
      view.addEventListener('resize', onResize, { passive: true });
    }

    doc.documentElement.append(host);
    try {
      host.focus({ preventScroll: true });
    } catch {
      // Some documents refuse focus; Esc still arrives via the window listener.
    }

    if (suggesting) {
      // Observed after the host is in the tree, so our own mount is not a mutation.
      observer = new MutationObserver(onMutations);
      observer.observe(doc.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: WATCHED_ATTRIBUTES,
        characterData: true,
      });
      startScan();
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
