import { type CssRect } from './capture-geometry.js';
import {
  colorAlpha,
  contains,
  describeElement,
  ownEdgeDistance,
  passesSizeGuards,
  roundOutward,
  shadowLayers,
  SUGGEST_EDGE_PROMOTE_CSS_PX,
  SUGGEST_MIN_BOX_SIDE_CSS_PX,
  SUGGEST_MIN_MEDIA_SIDE_CSS_PX,
  type Edges,
  type ElementTraits,
  type StyleDescriptor,
  type SuggestionKind,
} from './region-suggest.js';

/**
 * Structure pre-scan behind region suggestions (E11, PLAN.md §15). E7 probed
 * the element under the cursor on every hover; this module scans the visible
 * DOM once when region mode starts and builds a ranked candidate map in a
 * spatial index, so a hover is a lookup. Pure — no browser APIs: the overlay
 * hands in a `ScanSource` that reads the page into descriptors on demand and
 * drives `step()` from animation frames; time comes from an injected clock.
 *
 * **Candidate sources** (unioned; the first rule that fires names the kind):
 *   media / border / shadow   E7's qualifiers, unchanged (lib/region-suggest.ts)
 *   semantic                  a self-contained unit by markup: article, figure,
 *                             table, pre, blockquote, aside, dialog, a section
 *                             with a heading of its own or an accessible name,
 *                             or an ARIA role that says the same (a named
 *                             region). Page chrome — main, nav, header, footer,
 *                             banner, contentinfo, navigation, search, form —
 *                             never qualifies: it is the page, not a unit in
 *                             it. role="presentation"/"none" switches the tag's
 *                             meaning off (a layout table).
 *   background                the element paints a background that differs from
 *                             the background behind it by at least
 *                             SUGGEST_BG_MIN_CHANNEL_DELTA on some channel, or a
 *                             background image — judged once, here, against
 *                             the composited ancestor background
 *   rounded                   a border radius plus a box-shadow with a visible
 *                             colour of any geometry (a rule is never rounded,
 *                             so E7's offset-only exclusion does not apply)
 *   item / set                children of a grid or flex container whose
 *                             geometry repeats — at least
 *                             SUGGEST_REPEAT_MIN_SIBLINGS siblings with the
 *                             same width and height within
 *                             SUGGEST_REPEAT_SIZE_TOLERANCE — are items; their
 *                             container is the set
 *
 * Structure signals only widen what counts as confident. A bare div of text
 * with no border, no semantics and no repetition context still yields
 * nothing; the size guards from E7 (floor per kind, the near-viewport ceiling)
 * apply to every kind at lookup time, against what would be captured.
 *
 * **Hover resolution** (`resolveHover`) — the precedence, each rule proven by
 * a fixture in extension/test/browser/:
 *   1. only candidates whose visible rect contains the point and passes the
 *      size guards are considered; the overlay first restricts them to the
 *      live hit path (the element under the pointer and its ancestors), so a
 *      candidate covered by something else is never suggested
 *   2. edge promotion (E7): the smallest *larger* candidate whose own edge is
 *      within SUGGEST_EDGE_PROMOTE_CSS_PX of the point wins
 *   3. otherwise the smallest candidate by area, the deepest element on ties
 *      (an image exactly filling its figure is the image)
 *   Repetition falls out of 3: hovering an item finds the item, the smaller;
 *   hovering the gutter between items finds nothing smaller than the set.
 *
 * **Budgets** — named here, asserted by the perf fixture:
 *   SCAN_NODE_CAP            elements fully described per scan; past it the
 *                            scan ends `capped` with what it has
 *   SCAN_SLICE_MS            work per animation frame
 *   SCAN_TIME_BUDGET_MS      wall-clock from the first slice; past it the scan
 *                            ends `timed-out` with what it has
 *   viewport scope           a subtree whose root has a box entirely outside
 *                            the viewport is recorded by its bounds only (for
 *                            repetition) and not descended into; display:none
 *                            subtrees are skipped outright
 *   SCAN_PRESS_BUDGET_MS     synchronous scanning a press may do when it
 *                            arrives before the first scan has finished
 *   HOVER_RESOLVE_BUDGET_MS  what one hover lookup may cost
 *
 * Coordinates: rects are stored in *document* pixels (viewport + scroll at
 * read time), so a window scroll does not stale them; an element that is
 * fixed, or inside a fixed one, is anchored to the viewport instead. Sticky
 * elements and inner scroll containers do move under a scroll — the overlay
 * rescans on scroll and on mutation, throttled by SCAN_RESCAN_THROTTLE_MS.
 */

// ---- the numbers (the model is fixed, these are not — PLAN.md §15 E11) -----------

/** Elements fully described (style + rects) before a scan gives up. */
export const SCAN_NODE_CAP = 6000;
/** Scan work per animation frame; the rest of the frame is the page's. */
export const SCAN_SLICE_MS = 8;
/** Wall-clock budget from the first slice to abandoning the scan. */
export const SCAN_TIME_BUDGET_MS = 2000;
/** Least time between a mutation or scroll and the rescan it schedules. */
export const SCAN_RESCAN_THROTTLE_MS = 250;
/**
 * A press that beats the first scan (a fast click, a tap) runs it on the spot
 * for up to this long before deciding what is under the pointer: a one-off
 * pause the user caused, so that what they pressed is known.
 */
export const SCAN_PRESS_BUDGET_MS = 50;
/** What resolving one hover against the index may cost. */
export const HOVER_RESOLVE_BUDGET_MS = 4;
/** Cell size of the spatial index, in CSS px. */
export const SPATIAL_CELL_CSS_PX = 128;
/** A candidate spanning more cells than this is kept in a flat list instead. */
export const SPATIAL_MAX_CELLS = 4096;
/** Siblings (the hovered one included) with the same geometry that make a repeating set. */
export const SUGGEST_REPEAT_MIN_SIBLINGS = 3;
/** Fraction of the larger of two sizes within which they count as the same. */
export const SUGGEST_REPEAT_SIZE_TOLERANCE = 0.1;
/** Least difference, 0–255 on any channel, between a background and what is behind it. */
export const SUGGEST_BG_MIN_CHANNEL_DELTA = 6;
/** Distance within which a drag edge snaps to a candidate boundary. */
export const SNAP_DISTANCE_CSS_PX = 6;

/** Tags that are self-contained units by markup. */
export const SEMANTIC_TAGS: ReadonlySet<string> = new Set([
  'article',
  'figure',
  'table',
  'pre',
  'blockquote',
  'aside',
  'dialog',
]);
/** ARIA roles that denote a self-contained unit; `region` only with an accessible name. */
export const SEMANTIC_ROLES: ReadonlySet<string> = new Set([
  'article',
  'figure',
  'table',
  'grid',
  'treegrid',
  'complementary',
  'dialog',
  'alertdialog',
  'img',
]);
/** Roles that switch a tag's meaning off. */
const PRESENTATIONAL_ROLES: ReadonlySet<string> = new Set(['presentation', 'none']);

// ---- descriptors in --------------------------------------------------------------

/** The computed-style strings the scan reads: E7's plus the structure signals. */
export interface StructureStyle extends StyleDescriptor {
  display: string;
  backgroundColor: string;
  backgroundImage: string;
  borderTopLeftRadius: string;
  borderTopRightRadius: string;
  borderBottomRightRadius: string;
  borderBottomLeftRadius: string;
}

export interface NodeDescriptor {
  /** Lower-case tag name. */
  localName: string;
  /** First token of the `role` attribute, lower-case, or null. */
  role: string | null;
  /** Has a non-empty `aria-label` or an `aria-labelledby`. */
  named: boolean;
  /** For a `section`: a heading descendant whose nearest section is this one. */
  hasOwnHeading: boolean;
  style: StructureStyle;
  /** Border box in viewport CSS px at read time. */
  rect: Edges;
  /** Padding box (what `overflow` clips to), when the element clips. */
  clip?: Edges;
}

/** What the overlay gives the scan: a tree it can walk and read lazily. */
export interface ScanSource<N> {
  root: N;
  /** Element children worth walking: not the overlay host, not script/style/template. */
  children(node: N): readonly N[];
  /** The border box alone — cheap; decides whether the node is read in full. */
  bounds(node: N): Edges;
  /** The full read: style strings and rects. */
  describe(node: N): NodeDescriptor;
}

export interface ScanEnvironment {
  viewport(): { width: number; height: number };
  scroll(): { x: number; y: number };
  now(): number;
}

export interface ScanBudgets {
  nodeCap: number;
  sliceMs: number;
  timeBudgetMs: number;
}

export const DEFAULT_SCAN_BUDGETS: ScanBudgets = {
  nodeCap: SCAN_NODE_CAP,
  sliceMs: SCAN_SLICE_MS,
  timeBudgetMs: SCAN_TIME_BUDGET_MS,
};

// ---- records and candidates out --------------------------------------------------

export type Anchor = 'document' | 'viewport';

export interface StructureTraits extends ElementTraits {
  /** A container whose uniform children are items. */
  layout: 'grid' | 'flex' | null;
}

/** One element the scan looked at. Light records (off-viewport) carry bounds only. */
export interface ScanRecord<N> {
  id: number;
  node: N;
  parent: ScanRecord<N> | null;
  depth: number;
  anchor: Anchor;
  /** Border box, unrounded, in the anchor's coordinates. */
  box: Edges;
  traits?: StructureTraits;
  clip?: Edges;
}

export interface Candidate<N> {
  id: number;
  node: N;
  kind: SuggestionKind;
  anchor: Anchor;
  depth: number;
  /** What could be seen of it at scan time: cut by clipping ancestors (not by the viewport), whole px. */
  rect: Edges;
  /** Own border box, rounded outward. */
  box: Edges;
}

export type ScanStatus = 'running' | 'done' | 'capped' | 'timed-out';

export interface ScanStats {
  status: ScanStatus;
  /** Elements described in full. */
  examined: number;
  /** Elements recorded by bounds only (off-viewport subtree roots). */
  peeked: number;
  /** display:none subtrees skipped. */
  hidden: number;
  candidates: number;
  slices: number;
  /** Sum of slice durations. */
  workMs: number;
  /** First slice start to last slice end. */
  wallMs: number;
}

// ---- style → structure ------------------------------------------------------------

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** The canvas behind a page whose root paints nothing. */
export const CANVAS_BACKGROUND: Rgba = { r: 255, g: 255, b: 255, a: 1 };

/**
 * A computed colour as channels, or null when it is in a form this does not
 * read (the wide-gamut functions) — then nothing can be judged against it.
 */
export function parseRgba(color: string): Rgba | null {
  const value = color.trim().toLowerCase();
  if (value === 'transparent' || value === '') return { r: 0, g: 0, b: 0, a: 0 };
  const match = /^rgba?\((.*)\)$/.exec(value);
  if (!match) return null;
  const inner = match[1]!;
  const parts = inner.includes(',')
    ? inner.split(',').map((p) => p.trim())
    : inner
        .replace('/', ' ')
        .split(/\s+/)
        .filter((p) => p !== '');
  if (parts.length < 3) return null;
  const channel = (text: string): number | null => {
    const number = Number.parseFloat(text);
    if (!Number.isFinite(number)) return null;
    return Math.min(255, Math.max(0, text.endsWith('%') ? (number / 100) * 255 : number));
  };
  const r = channel(parts[0]!);
  const g = channel(parts[1]!);
  const b = channel(parts[2]!);
  if (r === null || g === null || b === null) return null;
  return { r, g, b, a: parts.length > 3 ? colorAlpha(color) : 1 };
}

/** `fg` composited over `bg`; an unknown colour on either side stays unknown. */
export function compositeOver(fg: Rgba | null, bg: Rgba | null): Rgba | null {
  if (!fg || !bg) return null;
  if (fg.a <= 0) return bg;
  if (fg.a >= 1) return fg;
  const mix = (f: number, b: number): number => f * fg.a + b * (1 - fg.a);
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a: 1 };
}

/** Largest per-channel difference, 0–255. */
export function channelDelta(a: Rgba, b: Rgba): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}

const px = (value: string): number => {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : 0;
};

/** Any corner rounded. */
export function hasRadius(style: StructureStyle): boolean {
  return (
    px(style.borderTopLeftRadius) > 0 ||
    px(style.borderTopRightRadius) > 0 ||
    px(style.borderBottomRightRadius) > 0 ||
    px(style.borderBottomLeftRadius) > 0
  );
}

/** A `box-shadow` layer with a visible colour, whatever its geometry. */
export function shadowHasVisibleLayer(boxShadow: string): boolean {
  return shadowLayers(boxShadow).some((layer) => layer.alpha > 0);
}

/** Whether the markup makes the element a self-contained unit. */
export function isSemanticUnit(descriptor: {
  localName: string;
  role: string | null;
  named: boolean;
  hasOwnHeading: boolean;
}): boolean {
  const { localName, role, named, hasOwnHeading } = descriptor;
  if (role !== null) {
    if (PRESENTATIONAL_ROLES.has(role)) return false;
    if (SEMANTIC_ROLES.has(role)) return true;
    if (role === 'region') return named;
    // Any other explicit role overrides the tag's meaning (a <table role="grid"> is caught above).
    return false;
  }
  if (SEMANTIC_TAGS.has(localName)) return true;
  if (localName === 'section') return hasOwnHeading || named;
  return false;
}

export interface StructureJudgement {
  traits: StructureTraits;
  /** The background descendants see behind them. */
  background: Rgba | null;
}

/**
 * Tag + style + the background behind the element → traits. E7's qualifiers
 * run first and unchanged; the structure rules only add kinds where E7 found
 * none.
 */
export function describeStructure(
  descriptor: NodeDescriptor,
  behind: Rgba | null,
): StructureJudgement {
  const { localName, style } = descriptor;
  const base = describeElement(localName, style);
  const own = parseRgba(style.backgroundColor);
  // An unreadable colour still paints: whatever is behind it is unknown from here down.
  const background = own === null ? null : own.a > 0 ? compositeOver(own, behind) : behind;
  const display = style.display;
  const layout = display.includes('grid') ? 'grid' : display.includes('flex') ? 'flex' : null;
  let kind: SuggestionKind | null = base.kind;
  const visible = style.visibility === 'visible' && px(style.opacity) !== 0;
  if (kind === null && visible) {
    if (isSemanticUnit(descriptor)) kind = 'semantic';
    else if (paintsDistinctBackground(style, own, behind)) kind = 'background';
    else if (hasRadius(style) && shadowHasVisibleLayer(style.boxShadow)) kind = 'rounded';
  }
  return { traits: { ...base, kind, layout }, background };
}

function paintsDistinctBackground(
  style: StructureStyle,
  own: Rgba | null,
  behind: Rgba | null,
): boolean {
  const image = style.backgroundImage.trim().toLowerCase();
  if (image !== '' && image !== 'none') return true;
  if (!own || own.a <= 0 || !behind) return false;
  const painted = compositeOver(own, behind);
  return painted !== null && channelDelta(painted, behind) >= SUGGEST_BG_MIN_CHANNEL_DELTA;
}

// ---- geometry helpers -------------------------------------------------------------

const area = (e: Edges): number => Math.max(0, e.right - e.left) * Math.max(0, e.bottom - e.top);

const shift = (e: Edges, dx: number, dy: number): Edges => ({
  left: e.left + dx,
  top: e.top + dy,
  right: e.right + dx,
  bottom: e.bottom + dy,
});

const disjoint = (a: Edges, b: Edges): boolean =>
  a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom;

function intersect(a: Edges, b: Edges, axes: { x: boolean; y: boolean }): Edges {
  return {
    left: axes.x ? Math.max(a.left, b.left) : a.left,
    right: axes.x ? Math.min(a.right, b.right) : a.right,
    top: axes.y ? Math.max(a.top, b.top) : a.top,
    bottom: axes.y ? Math.min(a.bottom, b.bottom) : a.bottom,
  };
}

/** The same cut E7's `visibleRect` makes, over the record chain instead of the hover chain. */
export function clippedBox<N>(record: ScanRecord<N>): Edges {
  let edges = record.box;
  let flow = record.traits?.flow ?? 'normal';
  for (let p = record.parent; p && flow !== 'fixed'; p = p.parent) {
    const traits = p.traits;
    if (!traits) continue;
    if (flow === 'absolute' && !traits.positioned) continue;
    if (p.clip && (traits.clipsX || traits.clipsY)) {
      edges = intersect(edges, p.clip, { x: traits.clipsX, y: traits.clipsY });
    }
    flow = traits.flow;
  }
  return edges;
}

/** Two sizes within SUGGEST_REPEAT_SIZE_TOLERANCE of the larger. */
export function sameSize(a: number, b: number): boolean {
  return Math.abs(a - b) <= SUGGEST_REPEAT_SIZE_TOLERANCE * Math.max(a, b);
}

/**
 * Which of a container's children repeat: a child with at least
 * SUGGEST_REPEAT_MIN_SIBLINGS − 1 siblings of the same width and height.
 * Empty-box children (zero area) are never items and never counted.
 */
export function repeatingChildren(boxes: readonly Edges[]): boolean[] {
  const sizes = boxes.map((b) => ({ w: b.right - b.left, h: b.bottom - b.top }));
  return sizes.map((size, i) => {
    if (size.w <= 0 || size.h <= 0) return false;
    let alike = 1;
    for (let j = 0; j < sizes.length && alike < SUGGEST_REPEAT_MIN_SIBLINGS; j++) {
      if (j === i) continue;
      const other = sizes[j]!;
      if (other.w > 0 && other.h > 0 && sameSize(size.w, other.w) && sameSize(size.h, other.h)) {
        alike++;
      }
    }
    return alike >= SUGGEST_REPEAT_MIN_SIBLINGS;
  });
}

// ---- the spatial index -----------------------------------------------------------

/**
 * A uniform grid per anchor space. `containing` is the hover lookup;
 * `edgesNear` feeds drag snapping.
 */
export class SpatialIndex<N> {
  readonly all: Candidate<N>[] = [];
  private readonly cells: Record<Anchor, Map<number, Candidate<N>[]>> = {
    document: new Map(),
    viewport: new Map(),
  };
  private readonly large: Record<Anchor, Candidate<N>[]> = { document: [], viewport: [] };

  private static key(cx: number, cy: number): number {
    return (cx + 0x8000) * 0x10000 + (cy + 0x8000);
  }

  private static cellRange(rect: Edges): { x0: number; x1: number; y0: number; y1: number } {
    const c = SPATIAL_CELL_CSS_PX;
    return {
      x0: Math.floor(rect.left / c),
      x1: Math.floor((rect.right - 1) / c),
      y0: Math.floor(rect.top / c),
      y1: Math.floor((rect.bottom - 1) / c),
    };
  }

  insert(candidate: Candidate<N>): void {
    this.all.push(candidate);
    const { x0, x1, y0, y1 } = SpatialIndex.cellRange(candidate.rect);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > SPATIAL_MAX_CELLS) {
      this.large[candidate.anchor].push(candidate);
      return;
    }
    const cells = this.cells[candidate.anchor];
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = SpatialIndex.key(cx, cy);
        const bucket = cells.get(key);
        if (bucket) bucket.push(candidate);
        else cells.set(key, [candidate]);
      }
    }
  }

  /** Candidates in the cells a rect touches, plus the large ones; may repeat and over-include. */
  private near(anchor: Anchor, rect: Edges): Candidate<N>[] {
    const out: Candidate<N>[] = [...this.large[anchor]];
    const { x0, x1, y0, y1 } = SpatialIndex.cellRange(rect);
    const cells = this.cells[anchor];
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const bucket = cells.get(SpatialIndex.key(cx, cy));
        if (bucket) out.push(...bucket);
      }
    }
    return out;
  }

  /**
   * Every candidate whose rect contains the point, given in both spaces: the
   * document point for document-anchored candidates, the viewport point for
   * the rest.
   */
  containing(doc: { x: number; y: number }, viewport: { x: number; y: number }): Candidate<N>[] {
    const hits: Candidate<N>[] = [];
    const seen = new Set<number>();
    const probe = (anchor: Anchor, p: { x: number; y: number }): void => {
      const point = { left: p.x, top: p.y, right: p.x + 1, bottom: p.y + 1 };
      for (const c of this.near(anchor, point)) {
        if (seen.has(c.id)) continue;
        const r = c.rect;
        if (p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom) {
          seen.add(c.id);
          hits.push(c);
        }
      }
    };
    probe('document', doc);
    probe('viewport', viewport);
    return hits;
  }

  /**
   * Candidate boundaries within `distance` of the point, in viewport px:
   * vertical edges (x positions) whose span covers the point's y to within
   * `distance`, and horizontal edges likewise. `scroll` converts the
   * document-anchored rects.
   */
  edgesNear(
    viewportPoint: { x: number; y: number },
    scroll: { x: number; y: number },
    distance: number,
  ): { vertical: number[]; horizontal: number[] } {
    const vertical = new Set<number>();
    const horizontal = new Set<number>();
    const probe = (anchor: Anchor, p: { x: number; y: number }, dx: number, dy: number): void => {
      const around = {
        left: p.x - distance,
        top: p.y - distance,
        right: p.x + distance + 1,
        bottom: p.y + distance + 1,
      };
      for (const c of this.near(anchor, around)) {
        const r = shift(c.rect, dx, dy);
        const spansY =
          viewportPoint.y >= r.top - distance && viewportPoint.y <= r.bottom + distance;
        const spansX =
          viewportPoint.x >= r.left - distance && viewportPoint.x <= r.right + distance;
        if (spansY) {
          if (Math.abs(r.left - viewportPoint.x) <= distance) vertical.add(r.left);
          if (Math.abs(r.right - viewportPoint.x) <= distance) vertical.add(r.right);
        }
        if (spansX) {
          if (Math.abs(r.top - viewportPoint.y) <= distance) horizontal.add(r.top);
          if (Math.abs(r.bottom - viewportPoint.y) <= distance) horizontal.add(r.bottom);
        }
      }
    };
    probe(
      'document',
      { x: viewportPoint.x + scroll.x, y: viewportPoint.y + scroll.y },
      -scroll.x,
      -scroll.y,
    );
    probe('viewport', viewportPoint, 0, 0);
    return { vertical: [...vertical], horizontal: [...horizontal] };
  }
}

// ---- the scan ---------------------------------------------------------------------

interface Frame<N> {
  node: N;
  parent: ScanRecord<N> | null;
  depth: number;
  behind: Rgba | null;
  anchored: boolean;
}

interface Pending<N> {
  remaining: number;
  kids: ScanRecord<N>[];
}

/**
 * One bounded, sliceable walk of the visible DOM. Construct, then call
 * `step()` once per animation frame until it stops returning `running`;
 * `index` fills as the walk goes and is usable at any time.
 */
export class StructureScan<N> {
  readonly index = new SpatialIndex<N>();
  /** Every record by its node, for the overlay's hit-path filter. */
  readonly records = new Map<N, ScanRecord<N>>();
  private readonly stack: Frame<N>[];
  private readonly pending = new Map<ScanRecord<N>, Pending<N>>();
  private status: ScanStatus = 'running';
  private nextId = 0;
  private examined = 0;
  private peeked = 0;
  private hidden = 0;
  private slices = 0;
  private workMs = 0;
  private firstStart: number | null = null;
  private lastEnd: number | null = null;
  private viewport = { width: 0, height: 0 };
  private scroll = { x: 0, y: 0 };

  constructor(
    private readonly source: ScanSource<N>,
    private readonly env: ScanEnvironment,
    private readonly budgets: ScanBudgets = DEFAULT_SCAN_BUDGETS,
  ) {
    this.stack = [
      { node: source.root, parent: null, depth: 0, behind: CANVAS_BACKGROUND, anchored: false },
    ];
  }

  stats(): ScanStats {
    return {
      status: this.status,
      examined: this.examined,
      peeked: this.peeked,
      hidden: this.hidden,
      candidates: this.index.all.length,
      slices: this.slices,
      workMs: this.workMs,
      wallMs:
        this.firstStart === null || this.lastEnd === null ? 0 : this.lastEnd - this.firstStart,
    };
  }

  /** Run one slice. Returns the status afterwards. */
  step(): ScanStatus {
    if (this.status !== 'running') return this.status;
    const start = this.env.now();
    this.firstStart ??= start;
    this.slices++;
    this.viewport = this.env.viewport();
    this.scroll = this.env.scroll();
    const deadline = start + this.budgets.sliceMs;
    while (this.stack.length > 0) {
      if (this.env.now() - this.firstStart > this.budgets.timeBudgetMs) {
        this.status = 'timed-out';
        break;
      }
      if (this.examined >= this.budgets.nodeCap) {
        this.status = 'capped';
        break;
      }
      this.visit(this.stack.pop()!);
      if (this.env.now() >= deadline) break;
    }
    if (this.stack.length === 0 && this.status === 'running') this.status = 'done';
    const end = this.env.now();
    this.lastEnd = end;
    this.workMs += end - start;
    return this.status;
  }

  private visit(frame: Frame<N>): void {
    const { node, parent, depth } = frame;
    const viewportBox = {
      left: 0,
      top: 0,
      right: this.viewport.width,
      bottom: this.viewport.height,
    };
    const bounds = this.source.bounds(node);
    if (area(bounds) > 0 && disjoint(bounds, viewportBox)) {
      // Off-viewport: its bounds matter to a repeating parent, its insides do not.
      this.peeked++;
      this.childDone(parent, this.record(node, parent, depth, frame.anchored, bounds));
      return;
    }
    this.examined++;
    const descriptor = this.source.describe(node);
    if (descriptor.style.display === 'none') {
      this.hidden++;
      this.childDone(parent, null);
      return;
    }
    const { traits, background } = describeStructure(descriptor, frame.behind);
    const anchored = frame.anchored || traits.flow === 'fixed';
    const record = this.record(
      node,
      parent,
      depth,
      anchored,
      descriptor.rect,
      traits,
      descriptor.clip,
    );
    if (traits.kind) this.admit(record, traits.kind);
    const children = this.source.children(node);
    if (traits.layout && children.length >= SUGGEST_REPEAT_MIN_SIBLINGS) {
      this.pending.set(record, { remaining: children.length, kids: [] });
    }
    for (let i = children.length - 1; i >= 0; i--) {
      this.stack.push({
        node: children[i]!,
        parent: record,
        depth: depth + 1,
        behind: background,
        anchored,
      });
    }
    this.childDone(parent, record);
  }

  private record(
    node: N,
    parent: ScanRecord<N> | null,
    depth: number,
    anchored: boolean,
    viewportRect: Edges,
    traits?: StructureTraits,
    clip?: Edges,
  ): ScanRecord<N> {
    const dx = anchored ? 0 : this.scroll.x;
    const dy = anchored ? 0 : this.scroll.y;
    const record: ScanRecord<N> = {
      id: this.nextId++,
      node,
      parent,
      depth,
      anchor: anchored ? 'viewport' : 'document',
      box: shift(viewportRect, dx, dy),
    };
    if (traits) record.traits = traits;
    if (clip) record.clip = shift(clip, dx, dy);
    this.records.set(node, record);
    return record;
  }

  /** A child of `parent` has been visited; when they all have, judge repetition. */
  private childDone(parent: ScanRecord<N> | null, child: ScanRecord<N> | null): void {
    if (!parent) return;
    const pending = this.pending.get(parent);
    if (!pending) return;
    if (child) pending.kids.push(child);
    if (--pending.remaining > 0) return;
    this.pending.delete(parent);
    const repeating = repeatingChildren(pending.kids.map((k) => k.box));
    let items = 0;
    pending.kids.forEach((kid, i) => {
      if (!repeating[i]) return;
      items++;
      // Only an element that was read in full (so, visible) can be a target now.
      if (kid.traits && kid.traits.kind === null) {
        kid.traits.kind = 'item';
        this.admit(kid, 'item');
      }
    });
    if (items >= SUGGEST_REPEAT_MIN_SIBLINGS && parent.traits && parent.traits.kind === null) {
      parent.traits.kind = 'set';
      this.admit(parent, 'set');
    }
  }

  /** Into the index, unless what could be seen of it is already under the floor. */
  private admit(record: ScanRecord<N>, kind: SuggestionKind): void {
    const rect = roundOutward(clippedBox(record));
    const floor = kind === 'media' ? SUGGEST_MIN_MEDIA_SIDE_CSS_PX : SUGGEST_MIN_BOX_SIDE_CSS_PX;
    if (rect.right - rect.left < floor || rect.bottom - rect.top < floor) return;
    this.index.insert({
      id: record.id,
      node: record.node,
      kind,
      anchor: record.anchor,
      depth: record.depth,
      rect,
      box: roundOutward(record.box),
    });
  }
}

// ---- lookup -----------------------------------------------------------------------

/** A candidate converted to viewport px and clamped to it: what a capture would take. */
export function viewportRect<N>(
  candidate: Candidate<N>,
  scroll: { x: number; y: number },
  viewport: { width: number; height: number },
): { rect: CssRect; box: Edges } | null {
  const dx = candidate.anchor === 'document' ? -scroll.x : 0;
  const dy = candidate.anchor === 'document' ? -scroll.y : 0;
  const r = shift(candidate.rect, dx, dy);
  const left = Math.max(r.left, 0);
  const top = Math.max(r.top, 0);
  const right = Math.min(r.right, Math.floor(viewport.width));
  const bottom = Math.min(r.bottom, Math.floor(viewport.height));
  if (right <= left || bottom <= top) return null;
  return {
    rect: { x: left, y: top, width: right - left, height: bottom - top },
    box: shift(candidate.box, dx, dy),
  };
}

export interface HoverCandidate {
  id: number;
  kind: SuggestionKind;
  /** Visible rect in viewport px, clamped. */
  rect: CssRect;
  /** Own box in viewport px, rounded outward. */
  box: Edges;
  depth: number;
}

export interface HoverResult {
  id: number;
  kind: SuggestionKind;
  rect: CssRect;
  /** True when edge promotion chose a larger candidate over the smallest. */
  promoted: boolean;
}

/**
 * The precedence in the module comment: guards, then edge promotion, then the
 * smallest by area (deepest on ties). `candidates` are the ones containing
 * the point that survived the overlay's hit-path filter.
 */
export function resolveHover(
  candidates: readonly HoverCandidate[],
  point: { x: number; y: number },
  viewport: { width: number; height: number },
): HoverResult | null {
  const eligible = candidates
    .filter((c) => passesSizeGuards(c.rect, c.kind, viewport) && contains(c.rect, point))
    .sort((a, b) => {
      const byArea = a.rect.width * a.rect.height - b.rect.width * b.rect.height;
      return byArea !== 0 ? byArea : b.depth - a.depth;
    });
  const smallest = eligible[0];
  if (!smallest) return null;
  const promoted = eligible
    .slice(1)
    .find((c) => ownEdgeDistance(c.rect, c.box, point) <= SUGGEST_EDGE_PROMOTE_CSS_PX);
  const chosen = promoted ?? smallest;
  return { id: chosen.id, kind: chosen.kind, rect: chosen.rect, promoted: promoted !== undefined };
}

export interface SnappedPoint {
  x: number;
  y: number;
  snappedX: boolean;
  snappedY: boolean;
}

/**
 * Each axis of the point moves to the nearest candidate edge within
 * `distance`; the other axis is independent. Edges are whole px already
 * (candidate rects are rounded outward), so a snapped corner lands exactly on
 * the boundary E7 geometry would have produced.
 */
export function snapToEdges(
  point: { x: number; y: number },
  edges: { vertical: readonly number[]; horizontal: readonly number[] },
  distance: number = SNAP_DISTANCE_CSS_PX,
): SnappedPoint {
  const nearest = (value: number, options: readonly number[]): number | null => {
    let best: number | null = null;
    for (const option of options) {
      const d = Math.abs(option - value);
      if (d <= distance && (best === null || d < Math.abs(best - value))) best = option;
    }
    return best;
  };
  const x = nearest(point.x, edges.vertical);
  const y = nearest(point.y, edges.horizontal);
  return { x: x ?? point.x, y: y ?? point.y, snappedX: x !== null, snappedY: y !== null };
}
