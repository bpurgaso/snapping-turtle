import { MIN_REGION_CSS_PX, type CssRect } from './capture-geometry.js';

/**
 * Element-aware region suggestions (E7, PLAN.md §15): which element under the
 * cursor is a confident capture target, and what rect it suggests. Pure — no
 * browser APIs. The overlay hands in what it read from the page (tag names,
 * computed-style strings, bounding rects) and this module decides, so every
 * rule that can be wrong is unit-tested without a browser.
 *
 * The model is fixed (PLAN.md §15 E7 notes); the numbers below are not:
 *
 *   confident targets   replaced/media elements (their own bounds), and
 *                       elements that draw a box — a visible border on at
 *                       least SUGGEST_MIN_BORDER_SIDES sides, or a box-shadow
 *                       with a blur or a spread
 *   size guards         each side of what would be captured at least
 *                       SUGGEST_MIN_MEDIA_SIDE_CSS_PX (media) or
 *                       SUGGEST_MIN_BOX_SIDE_CSS_PX (boxes), and its area at
 *                       most SUGGEST_MAX_VIEWPORT_FRACTION of the viewport
 *   selection           the nearest qualifying ancestor-or-self of the element
 *                       under the cursor; a qualifying ancestor whose edge is
 *                       within SUGGEST_EDGE_PROMOTE_CSS_PX of the cursor wins
 *                       over a qualifying descendant
 *
 * Nothing else qualifies. A paragraph on a plain background suggests nothing,
 * by contract.
 */

/** Smallest side, in CSS px, of a suggested image or other media — below this it is an icon. */
export const SUGGEST_MIN_MEDIA_SIDE_CSS_PX = 32;
/**
 * Smallest side, in CSS px, of a suggested box. Higher than the media floor:
 * measured on real pages, bordered boxes between 32 and 48 px are buttons,
 * inputs, chips and table cells — controls, not content — and at 32 they were
 * most of what a toolbar suggested.
 */
export const SUGGEST_MIN_BOX_SIDE_CSS_PX = 48;
/** Largest share of the viewport's area a suggestion may cover; beyond it Visible mode is the tool. */
export const SUGGEST_MAX_VIEWPORT_FRACTION = 0.9;
/** Cursor distance from a qualifying ancestor's edge, in CSS px, that promotes it over a qualifying descendant. */
export const SUGGEST_EDGE_PROMOTE_CSS_PX = 8;
/** Visible border sides that make a box rather than a rule (a heading's underline, a row divider). */
export const SUGGEST_MIN_BORDER_SIDES = 3;

/** Replaced/media elements: confident targets by tag alone, suggesting their own bounds. */
export const MEDIA_TAGS: ReadonlySet<string> = new Set([
  'img',
  'video',
  'canvas',
  'svg',
  'picture',
]);

/** Float noise below this is not a partial pixel worth a whole extra row or column. */
const ROUND_EPSILON = 1e-3;

export type SuggestionKind = 'media' | 'border' | 'shadow';

/** Box edges in viewport CSS px, as `getBoundingClientRect()` reports them. */
export interface Edges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The computed-style strings the qualifier reads. A `CSSStyleDeclaration`
 * from `getComputedStyle()` satisfies this as it is.
 */
export interface StyleDescriptor {
  visibility: string;
  opacity: string;
  position: string;
  overflowX: string;
  overflowY: string;
  borderTopWidth: string;
  borderTopStyle: string;
  borderTopColor: string;
  borderRightWidth: string;
  borderRightStyle: string;
  borderRightColor: string;
  borderBottomWidth: string;
  borderBottomStyle: string;
  borderBottomColor: string;
  borderLeftWidth: string;
  borderLeftStyle: string;
  borderLeftColor: string;
  boxShadow: string;
}

/** What an element's tag and style say about it; independent of where it is, so it can be cached per element. */
export interface ElementTraits {
  /** Why the element is a confident target, or null when it is not one. */
  kind: SuggestionKind | null;
  /** The element clips its descendants on this axis (overflow other than `visible`). */
  clipsX: boolean;
  clipsY: boolean;
  /** How ancestors clip it: `absolute` and `fixed` boxes escape ancestors that are not their containing block. */
  flow: 'normal' | 'absolute' | 'fixed';
  /** A containing block for absolutely positioned descendants. */
  positioned: boolean;
}

/** One element of the ancestor chain, nearest first. */
export interface ChainEntry {
  traits: ElementTraits;
  /** Border box. Read only when `traits.kind` is set. */
  rect?: Edges;
  /** Padding box. Read only when the element clips. */
  clip?: Edges;
}

export interface Suggestion {
  /** What to capture: whole CSS px, inside the viewport, containing the cursor. */
  rect: CssRect;
  kind: SuggestionKind;
  /** Index into the chain of the element that produced it. */
  index: number;
  /** True when the edge rule chose an ancestor over a nearer qualifying element. */
  promoted: boolean;
}

// ---- style → traits -----------------------------------------------------------

/**
 * Alpha of a computed colour, 0–1. Computed colours serialise as
 * `rgb(r, g, b)`, `rgba(r, g, b, a)` or, for the newer spaces, a function with
 * `/ a`; `transparent` computes to `rgba(0, 0, 0, 0)`. An unrecognised but
 * non-empty value is treated as opaque — every browser spells transparency
 * one of the ways above.
 */
export function colorAlpha(color: string): number {
  const value = color.trim().toLowerCase();
  if (value === '' || value === 'transparent') return 0;
  const open = value.indexOf('(');
  if (open === -1 || !value.endsWith(')')) return 1;
  const inner = value.slice(open + 1, -1);
  const slash = inner.lastIndexOf('/');
  if (slash !== -1) return parseAlpha(inner.slice(slash + 1));
  const parts = inner.split(',');
  if (parts.length === 4) return parseAlpha(parts[3]!);
  return 1;
}

function parseAlpha(text: string): number {
  const value = text.trim();
  if (value === 'none') return 0;
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return 1;
  return Math.min(1, Math.max(0, value.endsWith('%') ? number / 100 : number));
}

const px = (value: string): number => {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : 0;
};

function borderSideVisible(width: string, style: string, color: string): boolean {
  return px(width) > 0 && style !== 'none' && style !== 'hidden' && colorAlpha(color) > 0;
}

/** How many of the four sides draw a border: non-zero width, a drawn style, a colour that is not transparent. */
export function visibleBorderSides(style: StyleDescriptor): number {
  return [
    borderSideVisible(style.borderTopWidth, style.borderTopStyle, style.borderTopColor),
    borderSideVisible(style.borderRightWidth, style.borderRightStyle, style.borderRightColor),
    borderSideVisible(style.borderBottomWidth, style.borderBottomStyle, style.borderBottomColor),
    borderSideVisible(style.borderLeftWidth, style.borderLeftStyle, style.borderLeftColor),
  ].filter(Boolean).length;
}

/** Split at top-level occurrences of `separator`, leaving anything inside parentheses whole. */
function splitTopLevel(text: string, separator: ',' | ' '): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(') depth++;
    else if (char === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && char === separator) {
      parts.push(current);
      current = '';
    } else current += char;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

const LENGTH = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?(px)?$/;

/**
 * True when a computed `box-shadow` draws a box around the element: at least
 * one layer whose colour is not transparent and that has a blur or a spread,
 * so it shows on every side. Inset layers count — an inset 1 px ring is a
 * common way to draw a border. A layer with only an offset does not: it is a
 * rule along one or two sides (`inset 0 -1px 0` under a tab bar, `-2px 0 0`
 * beside a list item), the shadow spelling of a one-sided border. Nor do the
 * transparent zero-size layers frameworks that compose shadows from variables
 * leave on unshadowed elements (`0 0 #0000`).
 */
export function shadowDrawsBox(boxShadow: string): boolean {
  const value = boxShadow.trim().toLowerCase();
  if (value === '' || value === 'none') return false;
  return splitTopLevel(value, ',').some((layer) => {
    let alpha = 1;
    const lengths: number[] = [];
    for (const token of splitTopLevel(layer, ' ')) {
      if (token === 'inset') continue;
      if (LENGTH.test(token)) lengths.push(Number.parseFloat(token));
      else alpha = colorAlpha(token);
    }
    // Computed order is offset-x, offset-y, blur, spread.
    const [, , blur = 0, spread = 0] = lengths;
    return alpha > 0 && (blur > 0 || spread > 0);
  });
}

/**
 * Tag + computed style → traits. `localName` is the element's lower-case tag
 * name (`svg` for the SVG root; its `<path>` children are not media, their
 * `<svg>` ancestor is).
 */
export function describeElement(localName: string, style: StyleDescriptor): ElementTraits {
  // `overflow` on <html>/<body> propagates to the viewport: it scrolls the
  // page, it does not clip to the element's own box.
  const isRoot = localName === 'html' || localName === 'body';
  const flow =
    style.position === 'fixed' ? 'fixed' : style.position === 'absolute' ? 'absolute' : 'normal';
  return {
    kind: qualify(localName, style),
    clipsX: !isRoot && style.overflowX !== 'visible' && style.overflowX !== '',
    clipsY: !isRoot && style.overflowY !== 'visible' && style.overflowY !== '',
    flow,
    positioned: style.position !== 'static' && style.position !== '',
  };
}

function qualify(localName: string, style: StyleDescriptor): SuggestionKind | null {
  // Nothing the user cannot see is a target: a hidden ancestor of a visible
  // child draws no box, and a fully transparent image is a tracking pixel or
  // a lazy-load placeholder.
  if (style.visibility !== 'visible' || px(style.opacity) === 0) return null;
  if (MEDIA_TAGS.has(localName)) return 'media';
  if (visibleBorderSides(style) >= SUGGEST_MIN_BORDER_SIDES) return 'border';
  if (shadowDrawsBox(style.boxShadow)) return 'shadow';
  return null;
}

// ---- geometry -----------------------------------------------------------------

/**
 * Whole-pixel edges that contain the box: left/top round down, right/bottom
 * round up, so a border on a fractional edge is never shaved off the capture.
 */
export function roundOutward(edges: Edges): Edges {
  return {
    left: Math.floor(edges.left + ROUND_EPSILON),
    top: Math.floor(edges.top + ROUND_EPSILON),
    right: Math.ceil(edges.right - ROUND_EPSILON),
    bottom: Math.ceil(edges.bottom - ROUND_EPSILON),
  };
}

function intersect(a: Edges, b: Edges, axes: { x: boolean; y: boolean }): Edges {
  return {
    left: axes.x ? Math.max(a.left, b.left) : a.left,
    right: axes.x ? Math.min(a.right, b.right) : a.right,
    top: axes.y ? Math.max(a.top, b.top) : a.top,
    bottom: axes.y ? Math.min(a.bottom, b.bottom) : a.bottom,
  };
}

/**
 * The part of chain[index]'s border box the user can actually see: cut by
 * every ancestor that clips it, rounded outward, then clamped to the viewport.
 * An absolutely positioned box is clipped only from its containing block (the
 * nearest positioned ancestor) upward, and a fixed one by no ancestor at all.
 * Null when nothing is left.
 */
export function visibleRect(
  chain: readonly ChainEntry[],
  index: number,
  viewport: { width: number; height: number },
): CssRect | null {
  const entry = chain[index];
  if (!entry?.rect) return null;
  let edges = entry.rect;
  let flow = entry.traits.flow;
  for (let i = index + 1; i < chain.length && flow !== 'fixed'; i++) {
    const { traits, clip } = chain[i]!;
    if (flow === 'absolute' && !traits.positioned) continue;
    if (clip && (traits.clipsX || traits.clipsY)) {
      edges = intersect(edges, clip, { x: traits.clipsX, y: traits.clipsY });
    }
    flow = traits.flow;
  }
  const rounded = roundOutward(edges);
  const left = Math.max(rounded.left, 0);
  const top = Math.max(rounded.top, 0);
  const right = Math.min(rounded.right, Math.floor(viewport.width));
  const bottom = Math.min(rounded.bottom, Math.floor(viewport.height));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Both size guards, applied to what would be captured. */
export function passesSizeGuards(
  rect: CssRect,
  kind: SuggestionKind,
  viewport: { width: number; height: number },
): boolean {
  const floor = kind === 'media' ? SUGGEST_MIN_MEDIA_SIDE_CSS_PX : SUGGEST_MIN_BOX_SIDE_CSS_PX;
  if (rect.width < floor || rect.height < floor) return false;
  return (
    rect.width * rect.height <= SUGGEST_MAX_VIEWPORT_FRACTION * viewport.width * viewport.height
  );
}

const contains = (rect: CssRect, point: { x: number; y: number }): boolean =>
  point.x >= rect.x &&
  point.x <= rect.x + rect.width &&
  point.y >= rect.y &&
  point.y <= rect.y + rect.height;

/**
 * Distance from a point inside `rect` to the nearest of the element's own
 * edges. A side where the visible rect stops short of the element's box — cut
 * by the viewport or a scroll container — is not an edge of the element, and
 * being near it says nothing about the element.
 */
function ownEdgeDistance(rect: CssRect, box: Edges, point: { x: number; y: number }): number {
  const distances: number[] = [];
  if (rect.x === box.left) distances.push(point.x - rect.x);
  if (rect.x + rect.width === box.right) distances.push(rect.x + rect.width - point.x);
  if (rect.y === box.top) distances.push(point.y - rect.y);
  if (rect.y + rect.height === box.bottom) distances.push(rect.y + rect.height - point.y);
  return Math.min(...distances);
}

/**
 * The suggestion for a cursor position, or null. `chain` is the element under
 * the cursor followed by its ancestors, nearest first.
 *
 * A candidate qualifies by its traits, passes both size guards on its visible
 * rect, and contains the cursor (an overflowing or positioned child can sit
 * outside an ancestor's box — highlighting a box somewhere else would be a
 * guess). The nearest candidate wins, unless the cursor is within
 * SUGGEST_EDGE_PROMOTE_CSS_PX of a farther candidate's edge: an image filling
 * its card leaves the card nothing to hover but its hairline border, so the
 * band just inside the card's edge belongs to the card.
 */
export function chooseSuggestion(
  chain: readonly ChainEntry[],
  cursor: { x: number; y: number },
  viewport: { width: number; height: number },
): Suggestion | null {
  const candidates: Array<Suggestion & { box: Edges }> = [];
  chain.forEach(({ traits, rect: box }, index) => {
    if (!traits.kind || !box) return;
    const rect = visibleRect(chain, index, viewport);
    if (!rect || !passesSizeGuards(rect, traits.kind, viewport) || !contains(rect, cursor)) return;
    candidates.push({ rect, kind: traits.kind, index, promoted: false, box: roundOutward(box) });
  });
  const nearest = candidates[0];
  if (!nearest) return null;
  const ancestor = candidates
    .slice(1)
    .find((c) => ownEdgeDistance(c.rect, c.box, cursor) <= SUGGEST_EDGE_PROMOTE_CSS_PX);
  const { rect, kind, index } = ancestor ?? nearest;
  return { rect, kind, index, promoted: ancestor !== undefined };
}

/**
 * A press and release this close together is a click, not a drag: on a
 * suggestion it captures, and past it a manual selection has started.
 */
export function withinClickSlop(
  start: { x: number; y: number },
  end: { x: number; y: number },
  slop: number = MIN_REGION_CSS_PX,
): boolean {
  return Math.abs(end.x - start.x) < slop && Math.abs(end.y - start.y) < slop;
}

/** Dimensions badge text; the same `W × H` shape as the drag readout. */
export function suggestionBadge(rect: CssRect): string {
  return `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
}
