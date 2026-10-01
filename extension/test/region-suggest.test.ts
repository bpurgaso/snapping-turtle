import { describe, expect, it } from 'vitest';
import { MIN_REGION_CSS_PX } from '../src/lib/capture-geometry.js';
import {
  chooseSuggestion,
  colorAlpha,
  describeElement,
  MEDIA_TAGS,
  passesSizeGuards,
  roundOutward,
  shadowDrawsBox,
  suggestionBadge,
  SUGGEST_EDGE_PROMOTE_CSS_PX,
  SUGGEST_MAX_VIEWPORT_FRACTION,
  SUGGEST_MIN_BORDER_SIDES,
  SUGGEST_MIN_BOX_SIDE_CSS_PX,
  SUGGEST_MIN_MEDIA_SIDE_CSS_PX,
  visibleBorderSides,
  visibleRect,
  withinClickSlop,
  type ChainEntry,
  type Edges,
  type StyleDescriptor,
} from '../src/lib/region-suggest.js';

/** What getComputedStyle reports for an unstyled block: no border, no shadow, nothing clipped. */
const PLAIN: StyleDescriptor = {
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
};

type Side = 'Top' | 'Right' | 'Bottom' | 'Left';
const ALL_SIDES: readonly Side[] = ['Top', 'Right', 'Bottom', 'Left'];

/** A style with a border on the given sides. */
function bordered(
  sides: readonly Side[] = ALL_SIDES,
  { width = '1px', style = 'solid', color = 'rgb(200, 200, 200)' } = {},
): StyleDescriptor {
  const out: StyleDescriptor = { ...PLAIN };
  for (const side of sides) {
    out[`border${side}Width`] = width;
    out[`border${side}Style`] = style;
    out[`border${side}Color`] = color;
  }
  return out;
}

const SHADOW = 'rgba(0, 0, 0, 0.2) 0px 4px 12px 0px';
const VIEWPORT = { width: 1280, height: 720 };

const box = (left: number, top: number, width: number, height: number): Edges => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

/** A chain entry the way the overlay builds one: traits from tag + style, the same box for rect and clip. */
function el(localName: string, style: StyleDescriptor, rect: Edges): ChainEntry {
  return { traits: describeElement(localName, style), rect, clip: rect };
}

const BODY = el('body', PLAIN, box(0, 0, 1280, 3000));
const HTML = el('html', PLAIN, box(0, 0, 1280, 3000));

describe('the tuned constants (PLAN.md §15 E7 — change them there too)', () => {
  it('are the recorded values', () => {
    expect(SUGGEST_MIN_MEDIA_SIDE_CSS_PX).toBe(32);
    expect(SUGGEST_MIN_BOX_SIDE_CSS_PX).toBe(48);
    expect(SUGGEST_MAX_VIEWPORT_FRACTION).toBe(0.9);
    expect(SUGGEST_EDGE_PROMOTE_CSS_PX).toBe(8);
    expect(SUGGEST_MIN_BORDER_SIDES).toBe(3);
    expect([...MEDIA_TAGS].sort()).toEqual(['canvas', 'img', 'picture', 'svg', 'video']);
  });
});

describe('colorAlpha', () => {
  it('reads the alpha of every serialisation a computed colour takes', () => {
    expect(colorAlpha('rgb(0, 0, 0)')).toBe(1);
    expect(colorAlpha('rgba(0, 0, 0, 0)')).toBe(0);
    expect(colorAlpha('rgba(0, 0, 0, 0.125)')).toBe(0.125);
    expect(colorAlpha('rgba(10, 20, 30, 1)')).toBe(1);
    expect(colorAlpha('transparent')).toBe(0);
    expect(colorAlpha('RGBA(0, 0, 0, 0)')).toBe(0);
    expect(colorAlpha('  rgba(0, 0, 0, 0)  ')).toBe(0);
    // Space-separated syntax and the wide-gamut functions carry alpha after a slash.
    expect(colorAlpha('rgb(0 0 0 / 0)')).toBe(0);
    expect(colorAlpha('rgb(0 0 0 / 50%)')).toBe(0.5);
    expect(colorAlpha('color(srgb 1 0 0 / 0.25)')).toBe(0.25);
    expect(colorAlpha('color(srgb 1 0 0)')).toBe(1);
    expect(colorAlpha('oklch(0.7 0.1 200 / 0)')).toBe(0);
    expect(colorAlpha('oklch(0.7 0.1 200 / none)')).toBe(0);
    expect(colorAlpha('lab(50 20 30)')).toBe(1);
  });

  it('treats an empty value as transparent and an unknown one as opaque', () => {
    expect(colorAlpha('')).toBe(0);
    expect(colorAlpha('red')).toBe(1);
    expect(colorAlpha('rgba(0, 0, 0, nonsense)')).toBe(1);
    expect(colorAlpha('rgba(0, 0, 0, 7)')).toBe(1);
    expect(colorAlpha('rgba(0, 0, 0, -1)')).toBe(0);
  });
});

describe('visibleBorderSides', () => {
  it('counts sides with a width, a drawn style and a colour that is not transparent', () => {
    expect(visibleBorderSides(PLAIN)).toBe(0);
    expect(visibleBorderSides(bordered())).toBe(4);
    expect(visibleBorderSides(bordered(['Bottom']))).toBe(1);
    expect(visibleBorderSides(bordered(['Left', 'Right', 'Bottom']))).toBe(3);
  });

  it('a zero width, a none/hidden style or a transparent colour is not a border', () => {
    expect(visibleBorderSides(bordered(ALL_SIDES, { width: '0px' }))).toBe(0);
    expect(visibleBorderSides(bordered(ALL_SIDES, { style: 'none' }))).toBe(0);
    expect(visibleBorderSides(bordered(ALL_SIDES, { style: 'hidden' }))).toBe(0);
    expect(visibleBorderSides(bordered(ALL_SIDES, { color: 'rgba(0, 0, 0, 0)' }))).toBe(0);
    expect(visibleBorderSides(bordered(ALL_SIDES, { color: 'transparent' }))).toBe(0);
    expect(visibleBorderSides(bordered(ALL_SIDES, { width: '' }))).toBe(0);
  });

  it('a faint or hairline border still counts', () => {
    expect(visibleBorderSides(bordered(ALL_SIDES, { color: 'rgba(0, 0, 0, 0.125)' }))).toBe(4);
    expect(visibleBorderSides(bordered(ALL_SIDES, { width: '0.5px' }))).toBe(4);
    expect(visibleBorderSides(bordered(ALL_SIDES, { style: 'dashed' }))).toBe(4);
  });
});

describe('shadowDrawsBox', () => {
  it('none and empty are not shadows', () => {
    expect(shadowDrawsBox('none')).toBe(false);
    expect(shadowDrawsBox('')).toBe(false);
    expect(shadowDrawsBox('  NONE ')).toBe(false);
  });

  it('a layer with a visible colour and a blur or a spread draws a box', () => {
    expect(shadowDrawsBox(SHADOW)).toBe(true);
    expect(shadowDrawsBox('rgba(0, 0, 0, 0.05) 0px 1px 2px 0px')).toBe(true);
    // A 1 px ring: no offset, no blur, only spread.
    expect(shadowDrawsBox('rgb(221, 221, 221) 0px 0px 0px 1px')).toBe(true);
    // Inset rings are a common way to draw a border.
    expect(shadowDrawsBox('rgb(221, 221, 221) 0px 0px 0px 1px inset')).toBe(true);
    // A negative spread under a blur, and the colour last, as authored order allows.
    expect(shadowDrawsBox('rgba(0, 0, 0, 0.1) 0px 4px 6px -1px')).toBe(true);
    expect(shadowDrawsBox('0px 4px 12px 0px rgba(0, 0, 0, 0.3)')).toBe(true);
    expect(shadowDrawsBox('color(srgb 0 0 0 / 0.3) 0px 1px 2px 0px')).toBe(true);
  });

  it('an offset-only layer is a rule along a side, not a box (measured on real pages)', () => {
    // github.com repository tab bar: an underline.
    expect(shadowDrawsBox('rgba(209, 217, 224, 0.7) 0px -1px 0px 0px inset')).toBe(false);
    // developer.mozilla.org "In this article" entries: a rule down the left.
    expect(shadowDrawsBox('rgb(195, 199, 203) -2px 0px 0px 0px')).toBe(false);
    expect(shadowDrawsBox('rgb(0, 0, 0) 2px 2px 0px 0px')).toBe(false);
    expect(shadowDrawsBox('rgb(0, 0, 0) 0px 1px')).toBe(false);
  });

  it('transparent or zero-extent layers are not, however many there are', () => {
    expect(shadowDrawsBox('rgba(0, 0, 0, 0) 0px 4px 12px 0px')).toBe(false);
    expect(shadowDrawsBox('rgb(0, 0, 0) 0px 0px 0px 0px')).toBe(false);
    // What utility frameworks leave on elements with no shadow utility applied.
    expect(
      shadowDrawsBox('rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px'),
    ).toBe(false);
    expect(shadowDrawsBox('color(srgb 0 0 0 / 0) 0px 4px 12px 0px')).toBe(false);
  });

  it('one box-drawing layer among others is enough; commas inside colours do not split layers', () => {
    expect(
      shadowDrawsBox(
        'rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.1) 0px 1px 3px 0px',
      ),
    ).toBe(true);
    expect(
      shadowDrawsBox(
        'rgb(200, 200, 200) 0px -1px 0px 0px inset, rgba(0, 0, 0, 0.2) 0px 2px 8px 0px',
      ),
    ).toBe(true);
    expect(shadowDrawsBox('rgba(0, 0, 0, 0) 0px 4px 12px 0px, rgb(0, 0, 0) 0px 1px 0px')).toBe(
      false,
    );
  });
});

describe('describeElement', () => {
  it('media tags qualify by tag alone', () => {
    for (const tag of ['img', 'video', 'canvas', 'svg', 'picture']) {
      expect(describeElement(tag, PLAIN).kind).toBe('media');
    }
  });

  it('everything else needs a box: plain elements, iframes and svg children do not qualify', () => {
    for (const tag of ['p', 'div', 'span', 'a', 'h1', 'li', 'iframe', 'path', 'g', 'button']) {
      expect(describeElement(tag, PLAIN).kind).toBeNull();
    }
  });

  it('a border on at least three sides is a box; one or two sides are a rule', () => {
    expect(describeElement('div', bordered()).kind).toBe('border');
    expect(describeElement('div', bordered(['Left', 'Right', 'Bottom'])).kind).toBe('border');
    expect(describeElement('h2', bordered(['Bottom'])).kind).toBeNull();
    expect(describeElement('section', bordered(['Top', 'Bottom'])).kind).toBeNull();
    expect(describeElement('div', bordered(ALL_SIDES, { color: 'rgba(0, 0, 0, 0)' })).kind).toBe(
      null,
    );
  });

  it('a visible box-shadow is a box; border wins when both are present', () => {
    expect(describeElement('div', { ...PLAIN, boxShadow: SHADOW }).kind).toBe('shadow');
    expect(describeElement('div', { ...bordered(), boxShadow: SHADOW }).kind).toBe('border');
    expect(
      describeElement('div', { ...PLAIN, boxShadow: 'rgba(0, 0, 0, 0) 0px 0px 0px 0px' }).kind,
    ).toBeNull();
  });

  it('an iframe or a custom element qualifies only by its own box', () => {
    expect(
      describeElement('iframe', bordered(ALL_SIDES, { width: '2px', style: 'inset' })).kind,
    ).toBe('border');
    expect(describeElement('my-widget', { ...PLAIN, boxShadow: SHADOW }).kind).toBe('shadow');
    expect(describeElement('my-widget', PLAIN).kind).toBeNull();
  });

  it('nothing invisible qualifies', () => {
    expect(describeElement('img', { ...PLAIN, opacity: '0' }).kind).toBeNull();
    expect(describeElement('img', { ...PLAIN, visibility: 'hidden' }).kind).toBeNull();
    expect(describeElement('div', { ...bordered(), visibility: 'hidden' }).kind).toBeNull();
    expect(describeElement('div', { ...bordered(), visibility: 'collapse' }).kind).toBeNull();
    expect(describeElement('img', { ...PLAIN, opacity: '0.4' }).kind).toBe('media');
  });

  it('reports clipping per axis, and never for html/body', () => {
    expect(describeElement('div', PLAIN)).toMatchObject({ clipsX: false, clipsY: false });
    const scrolling = { ...PLAIN, overflowX: 'auto', overflowY: 'auto' };
    expect(describeElement('div', scrolling)).toMatchObject({ clipsX: true, clipsY: true });
    expect(describeElement('div', { ...PLAIN, overflowX: 'clip' })).toMatchObject({
      clipsX: true,
      clipsY: false,
    });
    expect(
      describeElement('div', { ...PLAIN, overflowX: 'hidden', overflowY: 'scroll' }),
    ).toMatchObject({ clipsX: true, clipsY: true });
    // overflow on the root elements scrolls the viewport; it does not clip to their box.
    expect(describeElement('body', scrolling)).toMatchObject({ clipsX: false, clipsY: false });
    expect(describeElement('html', scrolling)).toMatchObject({ clipsX: false, clipsY: false });
  });

  it('reports how the box is positioned', () => {
    expect(describeElement('div', PLAIN)).toMatchObject({ flow: 'normal', positioned: false });
    expect(describeElement('div', { ...PLAIN, position: 'relative' })).toMatchObject({
      flow: 'normal',
      positioned: true,
    });
    expect(describeElement('div', { ...PLAIN, position: 'sticky' })).toMatchObject({
      flow: 'normal',
      positioned: true,
    });
    expect(describeElement('div', { ...PLAIN, position: 'absolute' })).toMatchObject({
      flow: 'absolute',
      positioned: true,
    });
    expect(describeElement('div', { ...PLAIN, position: 'fixed' })).toMatchObject({
      flow: 'fixed',
      positioned: true,
    });
  });
});

describe('roundOutward', () => {
  it('never shaves a fractional edge', () => {
    expect(roundOutward({ left: 10.4, top: 20.6, right: 110.2, bottom: 80.5 })).toEqual({
      left: 10,
      top: 20,
      right: 111,
      bottom: 81,
    });
    expect(roundOutward({ left: -0.5, top: -3.2, right: 0.5, bottom: 3.2 })).toEqual({
      left: -1,
      top: -4,
      right: 1,
      bottom: 4,
    });
  });

  it('leaves whole pixels alone and ignores float noise', () => {
    expect(roundOutward({ left: 10, top: 20, right: 110, bottom: 80 })).toEqual({
      left: 10,
      top: 20,
      right: 110,
      bottom: 80,
    });
    expect(
      roundOutward({ left: 9.9999999, top: 19.99999, right: 110.0000001, bottom: 80.00001 }),
    ).toEqual({ left: 10, top: 20, right: 110, bottom: 80 });
    // A 64th of a pixel is a real layout unit, not noise.
    expect(roundOutward({ left: 10, top: 20, right: 110.015625, bottom: 80 }).right).toBe(111);
  });
});

describe('visibleRect', () => {
  it('is the rounded border box when nothing clips it', () => {
    const chain = [el('img', PLAIN, box(100.4, 200.6, 300.3, 150)), BODY, HTML];
    expect(visibleRect(chain, 0, VIEWPORT)).toEqual({ x: 100, y: 200, width: 301, height: 151 });
  });

  it('is clamped to the viewport on every side', () => {
    const at = (rect: Edges) => visibleRect([el('img', PLAIN, rect)], 0, VIEWPORT);
    expect(at(box(-50, -30, 200, 100))).toEqual({ x: 0, y: 0, width: 150, height: 70 });
    expect(at(box(1200, 650, 200, 100))).toEqual({ x: 1200, y: 650, width: 80, height: 70 });
    expect(at(box(-100, -100, 2000, 2000))).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
    // A fractional viewport (zoom) never yields a rect past its last whole pixel.
    expect(
      visibleRect([el('img', PLAIN, box(0, 0, 2000, 2000))], 0, { width: 853.33, height: 480 }),
    ).toEqual({ x: 0, y: 0, width: 853, height: 480 });
  });

  it('is null when the element is entirely off screen, empty, or has no rect', () => {
    expect(visibleRect([el('img', PLAIN, box(1300, 100, 200, 100))], 0, VIEWPORT)).toBeNull();
    expect(visibleRect([el('img', PLAIN, box(100, -300, 200, 100))], 0, VIEWPORT)).toBeNull();
    expect(visibleRect([el('img', PLAIN, box(100, 100, 0, 0))], 0, VIEWPORT)).toBeNull();
    expect(visibleRect([{ traits: describeElement('img', PLAIN) }], 0, VIEWPORT)).toBeNull();
    expect(visibleRect([], 0, VIEWPORT)).toBeNull();
  });

  it('is cut by a scroll container it has scrolled partly out of', () => {
    const pane = el(
      'div',
      { ...PLAIN, overflowX: 'auto', overflowY: 'auto' },
      box(100, 100, 400, 300),
    );
    const image = el('img', PLAIN, box(150, 50, 200, 200)); // top 50 px above the pane
    expect(visibleRect([image, pane, BODY, HTML], 0, VIEWPORT)).toEqual({
      x: 150,
      y: 100,
      width: 200,
      height: 150,
    });
  });

  it('clips only on the axis the ancestor clips', () => {
    const strip = el('div', { ...PLAIN, overflowX: 'clip' }, box(100, 100, 300, 100));
    const image = el('img', PLAIN, box(50, 50, 500, 300));
    expect(visibleRect([image, strip, BODY], 0, VIEWPORT)).toEqual({
      x: 100,
      y: 50,
      width: 300,
      height: 300,
    });
  });

  it('accumulates through nested clipping ancestors', () => {
    const hidden = { ...PLAIN, overflowX: 'hidden', overflowY: 'hidden' };
    const outer = el('div', hidden, box(0, 0, 300, 300));
    const inner = el('div', hidden, box(100, 100, 400, 400));
    const image = el('img', PLAIN, box(50, 50, 600, 600));
    expect(visibleRect([image, inner, outer, BODY], 0, VIEWPORT)).toEqual({
      x: 100,
      y: 100,
      width: 200,
      height: 200,
    });
  });

  it('an absolutely positioned box escapes clipping ancestors below its containing block', () => {
    const hidden = { ...PLAIN, overflowX: 'hidden', overflowY: 'hidden' };
    const menu = el('div', { ...bordered(), position: 'absolute' }, box(100, 140, 200, 300));
    const clipper = el('div', hidden, box(100, 100, 200, 40)); // static: not the containing block
    const positioned = el('div', { ...PLAIN, position: 'relative' }, box(0, 0, 1280, 600));
    expect(visibleRect([menu, clipper, positioned, BODY], 0, VIEWPORT)).toEqual({
      x: 100,
      y: 140,
      width: 200,
      height: 300,
    });
    // The containing block itself does clip it, and so does everything above that.
    const clippingBlock = el('div', { ...hidden, position: 'relative' }, box(0, 0, 1280, 300));
    expect(visibleRect([menu, clipper, clippingBlock, BODY], 0, VIEWPORT)).toEqual({
      x: 100,
      y: 140,
      width: 200,
      height: 160,
    });
    const outerClip = el('div', hidden, box(0, 0, 250, 600));
    expect(visibleRect([menu, clipper, positioned, outerClip, BODY], 0, VIEWPORT)).toEqual({
      x: 100,
      y: 140,
      width: 150,
      height: 300,
    });
  });

  it('a static box inside an absolute one inherits the escape', () => {
    const hidden = { ...PLAIN, overflowX: 'hidden', overflowY: 'hidden' };
    const image = el('img', PLAIN, box(110, 150, 100, 100));
    const menu = el('div', { ...PLAIN, position: 'absolute' }, box(100, 140, 200, 300));
    const clipper = el('div', hidden, box(100, 100, 200, 40));
    expect(visibleRect([image, menu, clipper, BODY], 0, VIEWPORT)).toEqual({
      x: 110,
      y: 150,
      width: 100,
      height: 100,
    });
  });

  it('a fixed box is clipped by no ancestor, only by the viewport', () => {
    const hidden = { ...PLAIN, overflowX: 'hidden', overflowY: 'hidden' };
    const banner = el('div', { ...bordered(), position: 'fixed' }, box(1000, 600, 400, 200));
    const clipper = el('div', { ...hidden, position: 'relative' }, box(0, 0, 100, 100));
    expect(visibleRect([banner, clipper, BODY], 0, VIEWPORT)).toEqual({
      x: 1000,
      y: 600,
      width: 280,
      height: 120,
    });
  });
});

describe('passesSizeGuards', () => {
  const rect = (width: number, height: number) => ({ x: 0, y: 0, width, height });

  it('media: each side must reach 32 px', () => {
    expect(passesSizeGuards(rect(32, 32), 'media', VIEWPORT)).toBe(true);
    expect(passesSizeGuards(rect(31, 200), 'media', VIEWPORT)).toBe(false);
    expect(passesSizeGuards(rect(200, 31), 'media', VIEWPORT)).toBe(false);
    expect(passesSizeGuards(rect(16, 16), 'media', VIEWPORT)).toBe(false);
    expect(passesSizeGuards(rect(24, 24), 'media', VIEWPORT)).toBe(false);
  });

  it('boxes: each side must reach 48 px — a 32 px button or input is a control, not a card', () => {
    for (const kind of ['border', 'shadow'] as const) {
      expect(passesSizeGuards(rect(48, 48), kind, VIEWPORT)).toBe(true);
      expect(passesSizeGuards(rect(300, 47), kind, VIEWPORT)).toBe(false);
      expect(passesSizeGuards(rect(47, 300), kind, VIEWPORT)).toBe(false);
      expect(passesSizeGuards(rect(73, 32), kind, VIEWPORT)).toBe(false);
      expect(passesSizeGuards(rect(205, 32), kind, VIEWPORT)).toBe(false);
    }
  });

  it('the area must not exceed 90% of the viewport, whatever the kind', () => {
    // 1280 × 720 = 921,600; 90% = 829,440 = 1280 × 648.
    for (const kind of ['media', 'border', 'shadow'] as const) {
      expect(passesSizeGuards(rect(1280, 648), kind, VIEWPORT)).toBe(true);
      expect(passesSizeGuards(rect(1280, 649), kind, VIEWPORT)).toBe(false);
      expect(passesSizeGuards(rect(1280, 720), kind, VIEWPORT)).toBe(false);
      // A full-width band or a full-height column is far below the limit.
      expect(passesSizeGuards(rect(1280, 300), kind, VIEWPORT)).toBe(true);
      expect(passesSizeGuards(rect(400, 720), kind, VIEWPORT)).toBe(true);
    }
  });
});

describe('chooseSuggestion', () => {
  const card = el('div', bordered(), box(100, 100, 400, 300));
  const cardText = el('p', PLAIN, box(116, 116, 368, 40));

  it('nothing qualifies → null: a paragraph on a plain page', () => {
    const p = el('p', PLAIN, box(40, 100, 600, 80));
    const main = el('main', PLAIN, box(40, 0, 600, 3000));
    expect(chooseSuggestion([p, main, BODY, HTML], { x: 200, y: 140 }, VIEWPORT)).toBeNull();
    expect(chooseSuggestion([], { x: 200, y: 140 }, VIEWPORT)).toBeNull();
  });

  it('self: hovering an image suggests the image', () => {
    const image = el('img', PLAIN, box(200, 150, 320, 240));
    expect(chooseSuggestion([image, BODY, HTML], { x: 300, y: 200 }, VIEWPORT)).toEqual({
      rect: { x: 200, y: 150, width: 320, height: 240 },
      kind: 'media',
      index: 0,
      promoted: false,
    });
  });

  it('self: hovering a bordered card’s own padding suggests the card', () => {
    expect(chooseSuggestion([card, BODY, HTML], { x: 104, y: 250 }, VIEWPORT)).toMatchObject({
      rect: { x: 100, y: 100, width: 400, height: 300 },
      kind: 'border',
      index: 0,
    });
  });

  it('ancestor: hovering plain text inside the card suggests the card', () => {
    expect(chooseSuggestion([cardText, card, BODY, HTML], { x: 300, y: 130 }, VIEWPORT)).toEqual({
      rect: { x: 100, y: 100, width: 400, height: 300 },
      kind: 'border',
      index: 1,
      promoted: false,
    });
  });

  it('nearest wins: an image inside a card suggests the image, not the card', () => {
    const image = el('img', PLAIN, box(140, 140, 200, 150));
    expect(chooseSuggestion([image, card, BODY, HTML], { x: 240, y: 200 }, VIEWPORT)).toMatchObject(
      {
        rect: { x: 140, y: 140, width: 200, height: 150 },
        kind: 'media',
        index: 0,
        promoted: false,
      },
    );
  });

  it('nearest wins through several qualifying ancestors', () => {
    const inner = el('div', { ...PLAIN, boxShadow: SHADOW }, box(120, 120, 200, 100));
    const text = el('span', PLAIN, box(130, 130, 100, 20));
    expect(
      chooseSuggestion([text, inner, card, BODY, HTML], { x: 180, y: 140 }, VIEWPORT),
    ).toMatchObject({ kind: 'shadow', index: 1 });
  });

  it('too-small targets are skipped and the walk continues to the ancestor', () => {
    const icon = el('img', PLAIN, box(120, 120, 16, 16));
    expect(chooseSuggestion([icon, card, BODY, HTML], { x: 128, y: 128 }, VIEWPORT)).toMatchObject({
      kind: 'border',
      index: 1,
    });
    // …and to nothing when no ancestor qualifies.
    expect(chooseSuggestion([icon, BODY, HTML], { x: 128, y: 128 }, VIEWPORT)).toBeNull();
    const svgIcon = el('svg', PLAIN, box(120, 120, 24, 24));
    const path = el('path', PLAIN, box(122, 122, 20, 20));
    expect(chooseSuggestion([path, svgIcon, BODY, HTML], { x: 130, y: 130 }, VIEWPORT)).toBeNull();
  });

  it('a bordered control under the box floor is skipped for the card around it', () => {
    const button = el('button', bordered(), box(120, 120, 90, 32));
    const input = el('input', bordered(), box(120, 170, 205, 36));
    for (const control of [button, input]) {
      expect(
        chooseSuggestion(
          [control, card, BODY, HTML],
          { x: 130, y: control.rect!.top + 10 },
          VIEWPORT,
        ),
      ).toMatchObject({ kind: 'border', index: 1 });
      expect(
        chooseSuggestion([control, BODY, HTML], { x: 130, y: control.rect!.top + 10 }, VIEWPORT),
      ).toBeNull();
    }
    // The same 32 px is enough for an image.
    const thumb = el('img', PLAIN, box(120, 120, 32, 32));
    expect(chooseSuggestion([thumb, card, BODY, HTML], { x: 130, y: 130 }, VIEWPORT)).toMatchObject(
      {
        kind: 'media',
        index: 0,
      },
    );
  });

  it('the minimum applies to what is visible, not to the element’s full box', () => {
    // A 300 px image with only its bottom 20 px on screen would capture a sliver.
    const sliver = el('img', PLAIN, box(100, -280, 300, 300));
    expect(chooseSuggestion([sliver, BODY, HTML], { x: 200, y: 10 }, VIEWPORT)).toBeNull();
    const enough = el('img', PLAIN, box(100, -260, 300, 300));
    expect(chooseSuggestion([enough, BODY, HTML], { x: 200, y: 10 }, VIEWPORT)).toMatchObject({
      rect: { x: 100, y: 0, width: 300, height: 40 },
    });
  });

  it('near-viewport targets are skipped, media included', () => {
    const frame = el('div', bordered(), box(10, 10, 1260, 700)); // 95.7% of the viewport
    const text = el('p', PLAIN, box(40, 40, 600, 30));
    expect(chooseSuggestion([text, frame, BODY, HTML], { x: 100, y: 50 }, VIEWPORT)).toBeNull();
    const hero = el('canvas', PLAIN, box(0, 0, 1280, 720));
    expect(chooseSuggestion([hero, BODY, HTML], { x: 600, y: 300 }, VIEWPORT)).toBeNull();
    // A page wrapper far taller than the viewport is its visible part: the whole viewport.
    const wrapper = el('div', { ...PLAIN, boxShadow: SHADOW }, box(0, -500, 1280, 5000));
    expect(chooseSuggestion([text, wrapper, BODY, HTML], { x: 100, y: 50 }, VIEWPORT)).toBeNull();
  });

  it('a qualifying card inside a skipped near-viewport frame is still suggested', () => {
    const frame = el('div', bordered(), box(10, 10, 1260, 700));
    expect(
      chooseSuggestion([cardText, card, frame, BODY, HTML], { x: 300, y: 130 }, VIEWPORT),
    ).toMatchObject({ kind: 'border', index: 1 });
  });

  it('a bordered <body> or <html> is a candidate like any other and falls to the size guard', () => {
    const body = el('body', bordered(), box(0, 0, 1280, 3000));
    const p = el('p', PLAIN, box(40, 100, 600, 80));
    expect(chooseSuggestion([p, body, HTML], { x: 200, y: 140 }, VIEWPORT)).toBeNull();
  });

  it('a candidate that does not contain the cursor is not suggested', () => {
    // A menu item positioned outside its bordered ancestor's box.
    const item = el('a', { ...PLAIN, position: 'absolute' }, box(600, 400, 120, 30));
    const bar = el('nav', { ...bordered(), position: 'relative' }, box(100, 100, 400, 60));
    expect(chooseSuggestion([item, bar, BODY, HTML], { x: 650, y: 410 }, VIEWPORT)).toBeNull();
  });

  describe('edge promotion', () => {
    // An image filling its card: the card's own hover area is a 1 px border.
    const flushCard = el('div', bordered(), box(100, 100, 402, 302));
    const fill = el('img', PLAIN, box(101, 101, 400, 300));
    const chain = [fill, flushCard, BODY, HTML];
    const at = (x: number, y: number) => chooseSuggestion(chain, { x, y }, VIEWPORT);

    it('the interior of the image suggests the image', () => {
      expect(at(300, 250)).toMatchObject({ kind: 'media', index: 0, promoted: false });
    });

    it('within 8 px of the card’s edge the card is promoted, on every side', () => {
      const cardRect = { x: 100, y: 100, width: 402, height: 302 };
      for (const [x, y] of [
        [104, 250], // left
        [498, 250], // right
        [300, 104], // top
        [300, 398], // bottom
        [108, 250], // exactly 8 px in
      ] as const) {
        expect(at(x, y), `${x},${y}`).toEqual({
          rect: cardRect,
          kind: 'border',
          index: 1,
          promoted: true,
        });
      }
    });

    it('one pixel past the band it is the image again', () => {
      expect(at(109, 250)).toMatchObject({ kind: 'media', promoted: false });
      expect(at(300, 109)).toMatchObject({ kind: 'media', promoted: false });
      expect(at(493, 250)).toMatchObject({ kind: 'media', promoted: false });
      expect(at(300, 393)).toMatchObject({ kind: 'media', promoted: false });
    });

    it('promotes the nearest ancestor whose edge is close, not the outermost', () => {
      const section = el('section', { ...PLAIN, boxShadow: SHADOW }, box(99, 99, 404, 304));
      const nested = [fill, flushCard, section, BODY, HTML];
      expect(chooseSuggestion(nested, { x: 104, y: 250 }, VIEWPORT)).toMatchObject({
        kind: 'border',
        index: 1,
        promoted: true,
      });
    });

    it('an ancestor that fails a size guard is never promoted', () => {
      const frame = el('div', bordered(), box(0, 0, 1280, 720));
      const image = el('img', PLAIN, box(2, 2, 400, 300));
      expect(chooseSuggestion([image, frame, BODY], { x: 5, y: 100 }, VIEWPORT)).toMatchObject({
        kind: 'media',
        promoted: false,
      });
    });

    it('a side cut off by the viewport is not an edge of the ancestor', () => {
      // The card runs off the bottom of the viewport; its bottom edge is not on screen.
      const tall = el('div', bordered(), box(100, 400, 402, 600));
      const image = el('img', PLAIN, box(101, 401, 400, 598));
      const cut = [image, tall, BODY, HTML];
      expect(chooseSuggestion(cut, { x: 300, y: 716 }, VIEWPORT)).toMatchObject({
        kind: 'media',
        promoted: false,
      });
      // Its left edge is on screen and still promotes.
      expect(chooseSuggestion(cut, { x: 104, y: 600 }, VIEWPORT)).toMatchObject({
        kind: 'border',
        promoted: true,
      });
    });

    it('a side cut off by a scroll container is not an edge either', () => {
      const pane = el(
        'div',
        { ...PLAIN, overflowX: 'auto', overflowY: 'auto' },
        box(0, 200, 800, 300),
      );
      const scrolled = el('div', bordered(), box(100, 100, 402, 302)); // top 100 px hidden
      const image = el('img', PLAIN, box(101, 101, 400, 300));
      const chain2 = [image, scrolled, pane, BODY, HTML];
      expect(chooseSuggestion(chain2, { x: 300, y: 203 }, VIEWPORT)).toMatchObject({
        kind: 'media',
        rect: { x: 101, y: 200, width: 400, height: 201 },
        promoted: false,
      });
    });

    it('does not apply to the hovered element itself', () => {
      expect(chooseSuggestion([flushCard, BODY, HTML], { x: 100, y: 250 }, VIEWPORT)).toMatchObject(
        {
          kind: 'border',
          index: 0,
          promoted: false,
        },
      );
    });
  });
});

describe('withinClickSlop', () => {
  it('a press and release under the drag minimum on both axes is a click', () => {
    expect(MIN_REGION_CSS_PX).toBe(4);
    expect(withinClickSlop({ x: 100, y: 100 }, { x: 100, y: 100 })).toBe(true);
    expect(withinClickSlop({ x: 100, y: 100 }, { x: 103, y: 97 })).toBe(true);
    expect(withinClickSlop({ x: 100, y: 100 }, { x: 104, y: 100 })).toBe(false);
    expect(withinClickSlop({ x: 100, y: 100 }, { x: 100, y: 96 })).toBe(false);
    // A long drag along one axis is a drag, though normalizeDrag would call it too thin.
    expect(withinClickSlop({ x: 100, y: 100 }, { x: 400, y: 101 })).toBe(false);
  });
});

describe('suggestionBadge', () => {
  it('is W × H in whole CSS px', () => {
    expect(suggestionBadge({ x: 0, y: 0, width: 320, height: 240 })).toBe('320 × 240');
  });
});
