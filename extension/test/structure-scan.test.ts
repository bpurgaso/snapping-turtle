import { describe, expect, it } from 'vitest';
import {
  CANVAS_BACKGROUND,
  channelDelta,
  clippedBox,
  compositeOver,
  describeStructure,
  hasRadius,
  HOVER_RESOLVE_BUDGET_MS,
  isSemanticUnit,
  parseRgba,
  repeatingChildren,
  resolveHover,
  sameSize,
  SCAN_NODE_CAP,
  SCAN_PRESS_BUDGET_MS,
  SCAN_RESCAN_THROTTLE_MS,
  SCAN_SLICE_MS,
  SCAN_TIME_BUDGET_MS,
  SEMANTIC_ROLES,
  SEMANTIC_TAGS,
  shadowHasVisibleLayer,
  SNAP_DISTANCE_CSS_PX,
  snapToEdges,
  SPATIAL_CELL_CSS_PX,
  SpatialIndex,
  StructureScan,
  SUGGEST_BG_MIN_CHANNEL_DELTA,
  SUGGEST_REPEAT_MIN_SIBLINGS,
  SUGGEST_REPEAT_SIZE_TOLERANCE,
  viewportRect,
  type Candidate,
  type HoverCandidate,
  type NodeDescriptor,
  type ScanEnvironment,
  type ScanSource,
  type StructureStyle,
} from '../src/lib/structure-scan.js';
import type { Edges } from '../src/lib/region-suggest.js';
import type { Rgba } from '../src/lib/structure-scan.js';

/** An unstyled block, as getComputedStyle reports it. */
const PLAIN: StructureStyle = {
  visibility: 'visible',
  opacity: '1',
  position: 'static',
  overflowX: 'visible',
  overflowY: 'visible',
  borderTopWidth: '0px',
  borderTopStyle: 'none',
  borderTopColor: 'rgb(0, 0, 0)',
  borderRightWidth: '0px',
  borderRightStyle: 'none',
  borderRightColor: 'rgb(0, 0, 0)',
  borderBottomWidth: '0px',
  borderBottomStyle: 'none',
  borderBottomColor: 'rgb(0, 0, 0)',
  borderLeftWidth: '0px',
  borderLeftStyle: 'none',
  borderLeftColor: 'rgb(0, 0, 0)',
  boxShadow: 'none',
  display: 'block',
  backgroundColor: 'rgba(0, 0, 0, 0)',
  backgroundImage: 'none',
  borderTopLeftRadius: '0px',
  borderTopRightRadius: '0px',
  borderBottomRightRadius: '0px',
  borderBottomLeftRadius: '0px',
};

const box = (left: number, top: number, width: number, height: number): Edges => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

const VIEWPORT = { width: 1280, height: 720 };
const WHITE = { r: 255, g: 255, b: 255, a: 1 };

function node(
  localName: string,
  rect: Edges,
  style: Partial<StructureStyle> = {},
  extra: Partial<Pick<NodeDescriptor, 'role' | 'named' | 'hasOwnHeading' | 'clip'>> = {},
): NodeDescriptor {
  const descriptor: NodeDescriptor = {
    localName,
    role: extra.role ?? null,
    named: extra.named ?? false,
    hasOwnHeading: extra.hasOwnHeading ?? false,
    style: { ...PLAIN, ...style },
    rect,
  };
  if (extra.clip) descriptor.clip = extra.clip;
  return descriptor;
}

describe('the tuned constants (PLAN.md §15 E11 — change them there too)', () => {
  it('are the recorded values', () => {
    expect(SCAN_NODE_CAP).toBe(6000);
    expect(SCAN_SLICE_MS).toBe(8);
    expect(SCAN_TIME_BUDGET_MS).toBe(2000);
    expect(SCAN_RESCAN_THROTTLE_MS).toBe(250);
    expect(SCAN_PRESS_BUDGET_MS).toBe(50);
    expect(HOVER_RESOLVE_BUDGET_MS).toBe(4);
    expect(SPATIAL_CELL_CSS_PX).toBe(128);
    expect(SUGGEST_REPEAT_MIN_SIBLINGS).toBe(3);
    expect(SUGGEST_REPEAT_SIZE_TOLERANCE).toBe(0.1);
    expect(SUGGEST_BG_MIN_CHANNEL_DELTA).toBe(6);
    expect(SNAP_DISTANCE_CSS_PX).toBe(6);
    expect([...SEMANTIC_TAGS].sort()).toEqual([
      'article',
      'aside',
      'blockquote',
      'dialog',
      'figure',
      'pre',
      'table',
    ]);
    expect([...SEMANTIC_ROLES].sort()).toEqual([
      'alertdialog',
      'article',
      'complementary',
      'dialog',
      'figure',
      'grid',
      'img',
      'table',
      'treegrid',
    ]);
  });
});

describe('colours', () => {
  it('parses every serialisation a computed background takes', () => {
    expect(parseRgba('rgb(246, 248, 250)')).toEqual({ r: 246, g: 248, b: 250, a: 1 });
    expect(parseRgba('rgba(0, 0, 0, 0.03)')).toEqual({ r: 0, g: 0, b: 0, a: 0.03 });
    expect(parseRgba('rgb(0 0 0 / 50%)')).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
    expect(parseRgba('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseRgba('rgba(0, 0, 0, 0)')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseRgba('RGB(10%, 50%, 100%)')).toEqual({ r: 25.5, g: 127.5, b: 255, a: 1 });
  });

  it('declines what it does not read, so nothing is judged against it', () => {
    expect(parseRgba('color(srgb 1 0 0)')).toBeNull();
    expect(parseRgba('oklch(0.7 0.1 200)')).toBeNull();
    expect(parseRgba('rgb(nonsense)')).toBeNull();
    expect(parseRgba('red')).toBeNull();
  });

  it('composites a translucent colour over what is behind it', () => {
    expect(compositeOver({ r: 0, g: 0, b: 0, a: 0.03 }, WHITE)).toEqual({
      r: 247.35,
      g: 247.35,
      b: 247.35,
      a: 1,
    });
    expect(compositeOver({ r: 0, g: 0, b: 0, a: 0 }, WHITE)).toEqual(WHITE);
    expect(compositeOver({ r: 1, g: 2, b: 3, a: 1 }, WHITE)).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(compositeOver(null, WHITE)).toBeNull();
    expect(compositeOver(WHITE, null)).toBeNull();
  });

  it('measures the largest channel difference', () => {
    expect(channelDelta(WHITE, { r: 246, g: 248, b: 250, a: 1 })).toBe(9);
    expect(channelDelta({ r: 13, g: 17, b: 23, a: 1 }, { r: 22, g: 27, b: 34, a: 1 })).toBe(11);
    expect(channelDelta(WHITE, WHITE)).toBe(0);
  });
});

describe('radius and shadow', () => {
  it('any rounded corner counts', () => {
    expect(hasRadius(PLAIN)).toBe(false);
    expect(hasRadius({ ...PLAIN, borderBottomLeftRadius: '8px' })).toBe(true);
    expect(hasRadius({ ...PLAIN, borderTopLeftRadius: '8px 12px' })).toBe(true);
    expect(hasRadius({ ...PLAIN, borderTopRightRadius: '50%' })).toBe(true);
  });

  it('a shadow layer with a visible colour counts whatever its geometry; transparent layers do not', () => {
    expect(shadowHasVisibleLayer('none')).toBe(false);
    expect(shadowHasVisibleLayer('')).toBe(false);
    expect(shadowHasVisibleLayer('rgba(0, 0, 0, 0.2) 0px 1px 0px 0px')).toBe(true);
    expect(shadowHasVisibleLayer('rgba(0, 0, 0, 0) 0px 0px 0px 0px')).toBe(false);
    expect(shadowHasVisibleLayer('rgba(0, 0, 0, 0) 0px 0px, rgb(0, 0, 0) 0px 1px 0px 0px')).toBe(
      true,
    );
    expect(shadowHasVisibleLayer('rgba(0, 0, 0, 0.4) 0px -1px 0px 0px inset')).toBe(true);
  });
});

describe('isSemanticUnit', () => {
  const unit = (localName: string, extra: Partial<NodeDescriptor> = {}) =>
    isSemanticUnit({ localName, role: null, named: false, hasOwnHeading: false, ...extra });

  it('the listed tags are units by themselves', () => {
    for (const tag of SEMANTIC_TAGS) expect(unit(tag), tag).toBe(true);
  });

  it('a section needs a heading of its own or an accessible name', () => {
    expect(unit('section')).toBe(false);
    expect(unit('section', { hasOwnHeading: true })).toBe(true);
    expect(unit('section', { named: true })).toBe(true);
  });

  it('the listed roles are units; region only when named; presentation switches a tag off', () => {
    for (const role of SEMANTIC_ROLES) expect(unit('div', { role }), role).toBe(true);
    expect(unit('div', { role: 'region' })).toBe(false);
    expect(unit('div', { role: 'region', named: true })).toBe(true);
    expect(unit('table', { role: 'presentation' })).toBe(false);
    expect(unit('table', { role: 'none' })).toBe(false);
    // Another explicit role overrides the tag's meaning.
    expect(unit('table', { role: 'navigation' })).toBe(false);
    expect(unit('div', { role: 'button' })).toBe(false);
  });

  it('page chrome and prose are not units', () => {
    for (const tag of ['main', 'nav', 'header', 'footer', 'form', 'div', 'p', 'ul', 'li', 'span']) {
      expect(unit(tag), tag).toBe(false);
    }
    for (const role of ['main', 'navigation', 'banner', 'contentinfo', 'search', 'form', 'list']) {
      expect(unit('div', { role }), role).toBe(false);
    }
  });
});

describe('describeStructure', () => {
  const judge = (descriptor: NodeDescriptor, behind: Rgba | null = WHITE) =>
    describeStructure(descriptor, behind);

  it('E7 kinds come first and are unchanged', () => {
    expect(judge(node('img', box(0, 0, 100, 100))).traits.kind).toBe('media');
    expect(
      judge(
        node('article', box(0, 0, 100, 100), {
          borderTopWidth: '1px',
          borderTopStyle: 'solid',
          borderRightWidth: '1px',
          borderRightStyle: 'solid',
          borderBottomWidth: '1px',
          borderBottomStyle: 'solid',
          borderLeftWidth: '1px',
          borderLeftStyle: 'solid',
        }),
      ).traits.kind,
    ).toBe('border');
    expect(
      judge(
        node('article', box(0, 0, 100, 100), { boxShadow: 'rgba(0, 0, 0, 0.2) 0px 4px 12px 0px' }),
      ).traits.kind,
    ).toBe('shadow');
  });

  it('then semantic, then background, then rounded; nothing for a plain div', () => {
    expect(judge(node('article', box(0, 0, 100, 100))).traits.kind).toBe('semantic');
    expect(
      judge(node('article', box(0, 0, 100, 100), { backgroundColor: 'rgb(0, 0, 0)' })).traits.kind,
    ).toBe('semantic');
    expect(
      judge(node('div', box(0, 0, 100, 100), { backgroundColor: 'rgb(246, 248, 250)' })).traits
        .kind,
    ).toBe('background');
    expect(
      judge(
        node('div', box(0, 0, 100, 100), {
          backgroundColor: 'rgb(246, 248, 250)',
          borderTopLeftRadius: '8px',
          boxShadow: 'rgba(0, 0, 0, 0.2) 0px 1px 0px 0px',
        }),
      ).traits.kind,
    ).toBe('background');
    expect(
      judge(
        node('div', box(0, 0, 100, 100), {
          borderTopLeftRadius: '8px',
          boxShadow: 'rgba(0, 0, 0, 0.2) 0px 1px 0px 0px',
        }),
      ).traits.kind,
    ).toBe('rounded');
    expect(judge(node('div', box(0, 0, 100, 100))).traits.kind).toBeNull();
  });

  it('background distinctness is judged against what is behind, after compositing', () => {
    const grey = { r: 240, g: 240, b: 240, a: 1 };
    const white = node('div', box(0, 0, 100, 100), { backgroundColor: 'rgb(255, 255, 255)' });
    expect(judge(white, WHITE).traits.kind).toBeNull();
    expect(judge(white, grey).traits.kind).toBe('background');
    const faint = node('div', box(0, 0, 100, 100), { backgroundColor: 'rgb(253, 253, 253)' });
    expect(judge(faint).traits.kind).toBeNull();
    const wash = node('div', box(0, 0, 100, 100), { backgroundColor: 'rgba(0, 0, 0, 0.03)' });
    expect(judge(wash).traits.kind).toBe('background');
    const fainter = node('div', box(0, 0, 100, 100), { backgroundColor: 'rgba(0, 0, 0, 0.01)' });
    expect(judge(fainter).traits.kind).toBeNull();
    // An unknown colour on either side cannot be judged.
    expect(
      judge(node('div', box(0, 0, 1, 1), { backgroundColor: 'oklch(0.5 0.1 200)' })).traits.kind,
    ).toBeNull();
    expect(judge(white, null).traits.kind).toBeNull();
    // A background image is distinct by itself.
    expect(
      judge(
        node('div', box(0, 0, 1, 1), {
          backgroundImage: 'linear-gradient(rgb(255, 255, 255), rgb(232, 232, 232))',
        }),
      ).traits.kind,
    ).toBe('background');
  });

  it('passes the painted background down to descendants', () => {
    expect(judge(node('div', box(0, 0, 1, 1))).background).toEqual(WHITE);
    expect(
      judge(node('div', box(0, 0, 1, 1), { backgroundColor: 'rgb(13, 17, 23)' })).background,
    ).toEqual({
      r: 13,
      g: 17,
      b: 23,
      a: 1,
    });
    expect(
      judge(node('div', box(0, 0, 1, 1), { backgroundColor: 'rgba(0, 0, 0, 0.5)' })).background,
    ).toEqual({
      r: 127.5,
      g: 127.5,
      b: 127.5,
      a: 1,
    });
    expect(
      judge(node('div', box(0, 0, 1, 1), { backgroundColor: 'oklch(0.5 0.1 200)' })).background,
    ).toBeNull();
  });

  it('nothing invisible qualifies by structure either', () => {
    expect(
      judge(node('article', box(0, 0, 100, 100), { visibility: 'hidden' })).traits.kind,
    ).toBeNull();
    expect(judge(node('article', box(0, 0, 100, 100), { opacity: '0' })).traits.kind).toBeNull();
  });

  it('reports a grid or flex layout', () => {
    expect(judge(node('div', box(0, 0, 1, 1), { display: 'grid' })).traits.layout).toBe('grid');
    expect(judge(node('div', box(0, 0, 1, 1), { display: 'inline-flex' })).traits.layout).toBe(
      'flex',
    );
    expect(judge(node('div', box(0, 0, 1, 1), { display: 'block' })).traits.layout).toBeNull();
  });
});

describe('repetition', () => {
  it('sizes within the tolerance of the larger are the same', () => {
    expect(sameSize(200, 200)).toBe(true);
    expect(sameSize(200, 180)).toBe(true);
    expect(sameSize(200, 179)).toBe(false);
    expect(sameSize(0, 0)).toBe(true);
  });

  it('a child with two alike siblings is an item; ragged or empty children are not', () => {
    const uniform = [box(0, 0, 200, 140), box(224, 0, 200, 140), box(448, 0, 200, 140)];
    expect(repeatingChildren(uniform)).toEqual([true, true, true]);
    expect(repeatingChildren(uniform.slice(0, 2))).toEqual([false, false]);
    expect(
      repeatingChildren([box(0, 0, 200, 120), box(0, 0, 150, 120), box(0, 0, 200, 60)]),
    ).toEqual([false, false, false]);
    expect(
      repeatingChildren([
        box(0, 0, 110, 100),
        box(0, 0, 110, 100),
        box(0, 0, 110, 100),
        box(0, 0, 110, 40),
      ]),
    ).toEqual([true, true, true, false]);
    expect(repeatingChildren([box(0, 0, 0, 0), box(0, 0, 0, 0), box(0, 0, 0, 0)])).toEqual([
      false,
      false,
      false,
    ]);
  });
});

describe('SpatialIndex', () => {
  const candidate = (
    id: number,
    rect: Edges,
    anchor: 'document' | 'viewport' = 'document',
    kind: Candidate<string>['kind'] = 'border',
  ): Candidate<string> => ({ id, node: `n${id}`, kind, anchor, depth: id, rect, box: rect });

  it('finds the candidates containing a point in either space', () => {
    const index = new SpatialIndex<string>();
    index.insert(candidate(1, box(40, 40, 300, 200)));
    index.insert(candidate(2, box(100, 100, 50, 50)));
    index.insert(candidate(3, box(0, 0, 1280, 60), 'viewport'));
    const ids = (doc: { x: number; y: number }, vp: { x: number; y: number }) =>
      index
        .containing(doc, vp)
        .map((c) => c.id)
        .sort();
    expect(ids({ x: 120, y: 120 }, { x: 120, y: 120 })).toEqual([1, 2]);
    expect(ids({ x: 50, y: 50 }, { x: 50, y: 50 })).toEqual([1, 3]);
    expect(ids({ x: 50, y: 1050 }, { x: 50, y: 50 })).toEqual([3]);
    expect(ids({ x: 400, y: 400 }, { x: 400, y: 400 })).toEqual([]);
    // Edges are inclusive, like E7's contains().
    expect(ids({ x: 340, y: 240 }, { x: 340, y: 240 })).toEqual([1]);
  });

  it('keeps a candidate spanning too many cells in a flat list and still finds it', () => {
    const index = new SpatialIndex<string>();
    index.insert(candidate(1, box(0, 0, 100000, 100000)));
    expect(index.containing({ x: 99999, y: 99999 }, { x: 0, y: 0 }).map((c) => c.id)).toEqual([1]);
    expect(index.all).toHaveLength(1);
  });

  it('lists the edges near a point, in viewport px, only where the candidate spans the point', () => {
    const index = new SpatialIndex<string>();
    index.insert(candidate(1, box(40, 40, 300, 200)));
    index.insert(candidate(2, box(0, 1000, 1280, 400)));
    index.insert(candidate(3, box(0, 0, 1280, 60), 'viewport'));
    const near = (x: number, y: number, scroll = { x: 0, y: 0 }) =>
      index.edgesNear({ x, y }, scroll, 6);
    expect(near(345, 245)).toEqual({ vertical: [340], horizontal: [240] });
    expect(near(44, 44)).toEqual({ vertical: [40], horizontal: [40] });
    // The band's left edge is at x=0 but it does not span y=245.
    expect(near(3, 245)).toEqual({ vertical: [], horizontal: [] });
    // The card spans y=100 but its left edge is 37 px from x=3.
    expect(near(3, 100)).toEqual({ vertical: [], horizontal: [] });
  });
});

describe('edgesNear, exactly', () => {
  it('a vertical edge within the distance, a horizontal one beyond it', () => {
    const index = new SpatialIndex<string>();
    index.insert({
      id: 1,
      node: 'n',
      kind: 'border',
      anchor: 'document',
      depth: 1,
      rect: box(40, 40, 300, 200),
      box: box(40, 40, 300, 200),
    });
    expect(index.edgesNear({ x: 3, y: 100 }, { x: 0, y: 0 }, 6)).toEqual({
      vertical: [],
      horizontal: [],
    });
    expect(index.edgesNear({ x: 36, y: 100 }, { x: 0, y: 0 }, 6)).toEqual({
      vertical: [40],
      horizontal: [],
    });
    // Scrolled 100 down: the document rect appears 100 higher in the viewport.
    expect(index.edgesNear({ x: 36, y: 142 }, { x: 0, y: 100 }, 6)).toEqual({
      vertical: [40],
      horizontal: [140],
    });
  });
});

/** A tree the scan can walk: nodes keyed by name, children listed, descriptors given. */
interface FakeNode {
  name: string;
  descriptor: NodeDescriptor;
  children: FakeNode[];
}

function tree(name: string, descriptor: NodeDescriptor, children: FakeNode[] = []): FakeNode {
  return { name, descriptor, children };
}

function sourceOf(
  root: FakeNode,
  counters?: { bounds: number; describe: number },
): ScanSource<FakeNode> {
  return {
    root,
    children: (n) => n.children,
    bounds: (n) => {
      if (counters) counters.bounds++;
      return n.descriptor.rect;
    },
    describe: (n) => {
      if (counters) counters.describe++;
      return n.descriptor;
    },
  };
}

function envOf(
  options: { scroll?: { x: number; y: number }; tick?: number } = {},
): ScanEnvironment & {
  clock: { now: number };
} {
  const clock = { now: 0 };
  const tick = options.tick ?? 0;
  return {
    clock,
    viewport: () => VIEWPORT,
    scroll: () => options.scroll ?? { x: 0, y: 0 },
    now: () => {
      clock.now += tick;
      return clock.now;
    },
  };
}

const runToEnd = (scan: StructureScan<FakeNode>): string => {
  let status = scan.step();
  let guard = 0;
  while (status === 'running' && guard++ < 10000) status = scan.step();
  return status;
};

describe('StructureScan', () => {
  const html = (children: FakeNode[]) =>
    tree('html', node('html', box(0, 0, 1280, 3000)), [
      tree('body', node('body', box(0, 0, 1280, 3000)), children),
    ]);

  it('walks the tree, admits candidates with their kinds, and reports done', () => {
    const root = html([
      tree('article', node('article', box(40, 40, 360, 160)), [
        tree('p', node('p', box(40, 40, 360, 40))),
      ]),
      tree('img', node('img', box(500, 40, 200, 150))),
      tree('plain', node('div', box(800, 40, 200, 150))),
    ]);
    const scan = new StructureScan(sourceOf(root), envOf());
    expect(runToEnd(scan)).toBe('done');
    const kinds = scan.index.all.map((c) => [c.node.name, c.kind]).sort();
    expect(kinds).toEqual([
      ['article', 'semantic'],
      ['img', 'media'],
    ]);
    expect(scan.stats()).toMatchObject({
      status: 'done',
      examined: 6,
      peeked: 0,
      hidden: 0,
      candidates: 2,
    });
    expect(scan.records.size).toBe(6);
  });

  it('records off-viewport subtree roots by their bounds and does not descend into them', () => {
    const counters = { bounds: 0, describe: 0 };
    const deep = tree('card', node('div', box(40, 2000, 600, 100)), [
      tree('p1', node('p', box(40, 2000, 600, 20))),
      tree('p2', node('p', box(40, 2020, 600, 20))),
    ]);
    const root = html([deep, tree('img', node('img', box(0, 0, 100, 100)))]);
    const scan = new StructureScan(sourceOf(root, counters), envOf());
    expect(runToEnd(scan)).toBe('done');
    expect(scan.stats()).toMatchObject({ examined: 3, peeked: 1 });
    expect(counters.describe).toBe(3);
    expect(scan.records.get(deep)).toMatchObject({ box: box(40, 2000, 600, 100) });
    expect(scan.records.get(deep)!.traits).toBeUndefined();
  });

  it('skips display:none subtrees outright, a zero-area wrapper is descended', () => {
    const root = html([
      tree('menu', node('div', box(0, 0, 0, 0), { display: 'none' }), [
        tree('item', node('img', box(0, 0, 100, 100))),
      ]),
      tree('wrapper', node('div', box(0, 0, 0, 0)), [
        tree('img', node('img', box(0, 0, 100, 100))),
      ]),
    ]);
    const scan = new StructureScan(sourceOf(root), envOf());
    runToEnd(scan);
    expect(scan.stats()).toMatchObject({ hidden: 1, candidates: 1 });
    expect(scan.index.all[0]!.node.name).toBe('img');
  });

  it('stores rects in document px and anchors fixed elements (and their descendants) to the viewport', () => {
    const root = html([
      tree('card', node('div', box(40, 40, 300, 200), { backgroundColor: 'rgb(240, 240, 240)' })),
      tree(
        'bar',
        node('div', box(0, 0, 1280, 60), { position: 'fixed', backgroundColor: 'rgb(0, 0, 0)' }),
        [tree('logo', node('img', box(10, 10, 40, 40)))],
      ),
    ]);
    const scan = new StructureScan(sourceOf(root), envOf({ scroll: { x: 0, y: 500 } }));
    runToEnd(scan);
    const byName = Object.fromEntries(scan.index.all.map((c) => [c.node.name, c]));
    expect(byName['card']).toMatchObject({ anchor: 'document', rect: box(40, 540, 300, 200) });
    expect(byName['bar']).toMatchObject({ anchor: 'viewport', rect: box(0, 0, 1280, 60) });
    expect(byName['logo']).toMatchObject({ anchor: 'viewport', rect: box(10, 10, 40, 40) });
  });

  it('judges repetition once every child of a grid/flex container has been visited', () => {
    const grid = tree(
      'grid',
      node('div', box(40, 40, 680, 336), { display: 'grid' }),
      [0, 1, 2, 3, 4, 5].map((i) =>
        tree(
          `g${i}`,
          node('div', box(56 + (i % 3) * 224, 56 + Math.floor(i / 3) * 164, 200, 140)),
          [tree(`t${i}`, node('p', box(56, 56, 100, 20)))],
        ),
      ),
    );
    const two = tree('two', node('div', box(760, 40, 424, 120), { display: 'grid' }), [
      tree('a', node('div', box(760, 40, 200, 120))),
      tree('b', node('div', box(984, 40, 200, 120))),
    ]);
    const block = tree('block', node('div', box(760, 320, 424, 180)), [
      tree('r0', node('div', box(760, 320, 424, 60))),
      tree('r1', node('div', box(760, 380, 424, 60))),
      tree('r2', node('div', box(760, 440, 424, 60))),
    ]);
    const scan = new StructureScan(sourceOf(html([grid, two, block])), envOf());
    runToEnd(scan);
    const kinds = Object.fromEntries(scan.index.all.map((c) => [c.node.name, c.kind]));
    expect(kinds).toEqual({
      grid: 'set',
      g0: 'item',
      g1: 'item',
      g2: 'item',
      g3: 'item',
      g4: 'item',
      g5: 'item',
    });
  });

  it('an off-viewport sibling still counts towards repetition, but is not itself a candidate', () => {
    const flex = tree('feed', node('div', box(40, 40, 600, 1000), { display: 'flex' }), [
      tree('c0', node('div', box(40, 40, 600, 120))),
      tree('c1', node('div', box(40, 176, 600, 120))),
      tree('c2', node('div', box(40, 900, 600, 120))), // below the fold
    ]);
    const scan = new StructureScan(sourceOf(html([flex])), envOf());
    runToEnd(scan);
    expect(scan.index.all.map((c) => c.node.name).sort()).toEqual(['c0', 'c1', 'feed']);
    expect(scan.stats()).toMatchObject({ peeked: 1 });
  });

  it('stops at the node cap and at the time budget with what it has', () => {
    const many = html(
      Array.from({ length: 50 }, (_, i) => tree(`img${i}`, node('img', box(i, 0, 100, 100)))),
    );
    const capped = new StructureScan(sourceOf(many), envOf(), {
      nodeCap: 10,
      sliceMs: 8,
      timeBudgetMs: 2000,
    });
    expect(runToEnd(capped)).toBe('capped');
    expect(capped.stats().examined).toBe(10);
    expect(capped.index.all.length).toBe(8);

    // Every clock read advances 1 ms: a slice of 8 ms visits a handful of nodes, and 20 ms in total is too little.
    const slow = new StructureScan(sourceOf(many), envOf({ tick: 1 }), {
      nodeCap: 6000,
      sliceMs: 8,
      timeBudgetMs: 20,
    });
    expect(runToEnd(slow)).toBe('timed-out');
    expect(slow.stats().examined).toBeGreaterThan(0);
    expect(slow.stats().examined).toBeLessThan(52);
    expect(slow.stats().slices).toBeGreaterThan(1);
  });

  it('slices: a step stops at the slice deadline and the next one continues', () => {
    const many = html(
      Array.from({ length: 30 }, (_, i) => tree(`img${i}`, node('img', box(i, 0, 100, 100)))),
    );
    const scan = new StructureScan(sourceOf(many), envOf({ tick: 1 }), {
      nodeCap: 6000,
      sliceMs: 8,
      timeBudgetMs: 2000,
    });
    expect(scan.step()).toBe('running');
    const afterOne = scan.stats().examined;
    expect(afterOne).toBeGreaterThan(0);
    expect(afterOne).toBeLessThan(32);
    expect(runToEnd(scan)).toBe('done');
    expect(scan.stats().examined).toBe(32);
    expect(scan.stats().slices).toBeGreaterThan(1);
  });

  it('a candidate inside a scroll container is admitted with the part that shows; under the floor it is dropped', () => {
    const pane = tree(
      'pane',
      node(
        'div',
        box(1060, 40, 200, 200),
        { overflowX: 'auto', overflowY: 'auto' },
        { clip: box(1060, 40, 200, 200) },
      ),
      [
        tree('card', node('article', box(1070, -10, 160, 400))),
        tree('sliver', node('article', box(1070, 230, 160, 400))), // 10 px of it shows: under the floor
      ],
    );
    const scan = new StructureScan(sourceOf(html([pane])), envOf());
    runToEnd(scan);
    expect(scan.index.all.map((c) => [c.node.name, c.rect])).toEqual([
      ['card', box(1070, 40, 160, 200)],
    ]);
    expect(clippedBox(scan.records.get(pane.children[0]!)!)).toEqual(box(1070, 40, 160, 200));
  });
});

describe('viewportRect', () => {
  const candidate = (rect: Edges, anchor: 'document' | 'viewport'): Candidate<string> => ({
    id: 1,
    node: 'n',
    kind: 'border',
    anchor,
    depth: 1,
    rect,
    box: rect,
  });

  it('converts a document rect by the scroll and clamps to the viewport; a fixed one is not shifted', () => {
    expect(
      viewportRect(candidate(box(40, 540, 300, 200), 'document'), { x: 0, y: 500 }, VIEWPORT),
    ).toEqual({
      rect: { x: 40, y: 40, width: 300, height: 200 },
      box: box(40, 40, 300, 200),
    });
    expect(
      viewportRect(candidate(box(1200, 650, 200, 150), 'document'), { x: 0, y: 0 }, VIEWPORT),
    ).toEqual({
      rect: { x: 1200, y: 650, width: 80, height: 70 },
      box: box(1200, 650, 200, 150),
    });
    expect(
      viewportRect(candidate(box(0, 0, 1280, 60), 'viewport'), { x: 0, y: 500 }, VIEWPORT),
    ).toEqual({
      rect: { x: 0, y: 0, width: 1280, height: 60 },
      box: box(0, 0, 1280, 60),
    });
    expect(
      viewportRect(candidate(box(40, 40, 300, 200), 'document'), { x: 0, y: 500 }, VIEWPORT),
    ).toBeNull();
  });
});

describe('resolveHover — the precedence', () => {
  const c = (
    id: number,
    rect: Edges,
    kind: HoverCandidate['kind'] = 'border',
    depth = id,
  ): HoverCandidate => ({
    id,
    kind,
    rect: {
      x: rect.left,
      y: rect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
    },
    box: rect,
    depth,
  });

  it('nothing → null; a candidate not containing the point is ignored', () => {
    expect(resolveHover([], { x: 1, y: 1 }, VIEWPORT)).toBeNull();
    expect(resolveHover([c(1, box(40, 40, 300, 200))], { x: 400, y: 400 }, VIEWPORT)).toBeNull();
  });

  it('the smallest containing candidate wins (an item over its set)', () => {
    const set = c(1, box(40, 40, 680, 336), 'set', 2);
    const item = c(2, box(56, 56, 200, 140), 'item', 3);
    expect(resolveHover([set, item], { x: 100, y: 100 }, VIEWPORT)).toEqual({
      id: 2,
      kind: 'item',
      rect: item.rect,
      promoted: false,
    });
    // In the gutter only the set contains the point.
    expect(resolveHover([set], { x: 268, y: 120 }, VIEWPORT)).toMatchObject({
      id: 1,
      kind: 'set',
      promoted: false,
    });
  });

  it('on equal rects the deepest element wins (the image filling its figure)', () => {
    const figure = c(1, box(440, 40, 300, 200), 'semantic', 2);
    const img = c(2, box(440, 40, 300, 200), 'media', 3);
    expect(resolveHover([figure, img], { x: 500, y: 100 }, VIEWPORT)).toMatchObject({
      id: 2,
      kind: 'media',
    });
    expect(resolveHover([img, figure], { x: 500, y: 100 }, VIEWPORT)).toMatchObject({
      id: 2,
      kind: 'media',
    });
  });

  it('edge promotion: a larger candidate whose own edge is within 8 px wins', () => {
    const card = c(1, box(720, 40, 302, 202), 'border', 2);
    const img = c(2, box(721, 41, 300, 200), 'media', 3);
    expect(resolveHover([card, img], { x: 870, y: 140 }, VIEWPORT)).toMatchObject({
      id: 2,
      promoted: false,
    });
    expect(resolveHover([card, img], { x: 728, y: 140 }, VIEWPORT)).toMatchObject({
      id: 1,
      promoted: true,
    });
    expect(resolveHover([card, img], { x: 729, y: 140 }, VIEWPORT)).toMatchObject({
      id: 2,
      promoted: false,
    });
  });

  it('a side cut by the viewport is not an edge to promote on', () => {
    const card: HoverCandidate = {
      id: 1,
      kind: 'border',
      rect: { x: 0, y: 40, width: 300, height: 200 }, // its box starts at −50: the left side is cut
      box: box(-50, 40, 350, 200),
      depth: 2,
    };
    const img = c(2, box(1, 41, 298, 198), 'media', 3);
    expect(resolveHover([card, img], { x: 4, y: 140 }, VIEWPORT)).toMatchObject({
      id: 2,
      promoted: false,
    });
  });

  it('the size guards apply to every kind: a small item is skipped for its set, a near-viewport set for nothing', () => {
    const set = c(1, box(40, 40, 680, 336), 'set', 2);
    const tiny = c(2, box(56, 56, 40, 40), 'item', 3);
    expect(resolveHover([set, tiny], { x: 60, y: 60 }, VIEWPORT)).toMatchObject({ id: 1 });
    const huge = c(3, box(10, 10, 1260, 700), 'set', 1);
    expect(resolveHover([huge], { x: 600, y: 600 }, VIEWPORT)).toBeNull();
    const media = c(4, box(0, 0, 40, 40), 'media', 1);
    expect(resolveHover([media], { x: 20, y: 20 }, VIEWPORT)).toMatchObject({ id: 4 });
  });
});

describe('snapToEdges', () => {
  it('each axis moves to the nearest edge within the distance, independently', () => {
    const edges = { vertical: [340, 380], horizontal: [240] };
    expect(snapToEdges({ x: 345, y: 245 }, edges)).toEqual({
      x: 340,
      y: 240,
      snappedX: true,
      snappedY: true,
    });
    expect(snapToEdges({ x: 361, y: 245 }, edges)).toEqual({
      x: 361,
      y: 240,
      snappedX: false,
      snappedY: true,
    });
    expect(snapToEdges({ x: 377, y: 100 }, edges)).toEqual({
      x: 380,
      y: 100,
      snappedX: true,
      snappedY: false,
    });
    expect(snapToEdges({ x: 100, y: 100 }, edges)).toEqual({
      x: 100,
      y: 100,
      snappedX: false,
      snappedY: false,
    });
    expect(snapToEdges({ x: 346, y: 246 }, edges, 6)).toEqual({
      x: 340,
      y: 240,
      snappedX: true,
      snappedY: true,
    });
    expect(snapToEdges({ x: 347, y: 247 }, edges, 6)).toEqual({
      x: 347,
      y: 247,
      snappedX: false,
      snappedY: false,
    });
  });

  it('nothing to snap to leaves the point alone', () => {
    expect(snapToEdges({ x: 1, y: 2 }, { vertical: [], horizontal: [] })).toEqual({
      x: 1,
      y: 2,
      snappedX: false,
      snappedY: false,
    });
  });
});

describe('CANVAS_BACKGROUND', () => {
  it('is opaque white: the canvas behind a page whose root paints nothing', () => {
    expect(CANVAS_BACKGROUND).toEqual(WHITE);
  });
});
