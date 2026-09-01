import type { PageMetrics } from '../lib/capture-geometry.js';

/**
 * The in-page half of full-page capture (PLAN.md §15): measure the document,
 * scroll in viewport steps for Chrome's stitcher, hide fixed/sticky elements
 * after the first tile so they do not repeat in every tile, and — whatever
 * happens — put everything back. No extension APIs: the Playwright browser
 * tests mount this in plain fixture pages.
 *
 * Known limitation (documented in extension/TESTING.md): only the window's
 * scrolling element is driven. Pages whose scrollable content lives in an
 * inner `overflow: auto` container capture as one viewport.
 */

export interface MeasuredPage extends PageMetrics {
  scrollX: number;
  scrollY: number;
}

/**
 * documentElement and body disagree about the document height across
 * quirks mode, `height: 100%` overflow hacks and absolutely positioned
 * content; taking the max of all of them is the only reliable answer.
 */
export function measurePage(win: Window): MeasuredPage {
  const doc = win.document;
  const html = doc.documentElement;
  const body = doc.body;
  const documentHeight = Math.max(
    html.scrollHeight,
    html.offsetHeight,
    html.clientHeight,
    body?.scrollHeight ?? 0,
    body?.offsetHeight ?? 0,
  );
  const documentWidth = Math.max(
    html.scrollWidth,
    html.offsetWidth,
    html.clientWidth,
    body?.scrollWidth ?? 0,
    body?.offsetWidth ?? 0,
  );
  return {
    documentWidth,
    documentHeight,
    viewportWidth: html.clientWidth || win.innerWidth,
    viewportHeight: html.clientHeight || win.innerHeight,
    innerWidth: win.innerWidth,
    innerHeight: win.innerHeight,
    devicePixelRatio: win.devicePixelRatio || 1,
    scrollX: win.scrollX,
    scrollY: win.scrollY,
  };
}

/** `behavior: "instant"` defeats `scroll-behavior: smooth` on the page. */
export function scrollToInstant(win: Window, x: number, y: number): void {
  win.scrollTo({ left: x, top: y, behavior: 'instant' });
}

/**
 * Elements whose *computed* position is fixed or sticky (a class name or
 * inline style is not enough — frameworks set these from stylesheets). One
 * pass over the light DOM; open shadow roots are walked too, closed ones
 * cannot be.
 */
export function findFixedElements(doc: Document): HTMLElement[] {
  const view = doc.defaultView;
  if (!view) return [];
  const found: HTMLElement[] = [];
  const walk = (root: ParentNode): void => {
    for (const el of root.querySelectorAll<HTMLElement>('*')) {
      if (el.tagName === 'SNAPPING-TURTLE-REGION') continue;
      const position = view.getComputedStyle(el).position;
      if (position === 'fixed' || position === 'sticky') found.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(doc);
  return found;
}

interface HiddenElement {
  el: HTMLElement;
  value: string;
  priority: string;
}

/** Set `visibility: hidden !important` inline; returns a restore function that puts the exact prior inline value back. */
export function hideElements(elements: HTMLElement[]): () => void {
  const hidden: HiddenElement[] = elements.map((el) => ({
    el,
    value: el.style.getPropertyValue('visibility'),
    priority: el.style.getPropertyPriority('visibility'),
  }));
  for (const { el } of hidden) el.style.setProperty('visibility', 'hidden', 'important');
  return () => {
    for (const { el, value, priority } of hidden) {
      if (value) el.style.setProperty('visibility', value, priority);
      else el.style.removeProperty('visibility');
    }
  };
}

export interface ScrollResult {
  scrollX: number;
  scrollY: number;
}

/**
 * Stateful driver for one capture. `restore()` is idempotent and safe to call
 * at any point, including before `begin()`; `withPageDriver` guarantees it
 * runs on success, throw, or rejection.
 */
export class PageDriver {
  private original: { x: number; y: number } | null = null;
  private restoreFixed: (() => void) | null = null;
  private restored = false;

  constructor(private readonly win: Window) {}

  /** Remember the scroll position and go to the top. */
  begin(): MeasuredPage {
    const measured = measurePage(this.win);
    this.original ??= { x: measured.scrollX, y: measured.scrollY };
    this.restored = false;
    scrollToInstant(this.win, 0, 0);
    return measured;
  }

  measure(): MeasuredPage {
    return measurePage(this.win);
  }

  /** Scroll and report where the page actually ended up. */
  scrollTo(y: number): ScrollResult {
    if (!Number.isFinite(y) || y < 0) throw new Error(`scrollTo: bad offset ${y}`);
    scrollToInstant(this.win, 0, y);
    return { scrollX: this.win.scrollX, scrollY: this.win.scrollY };
  }

  /** Hide fixed/sticky elements; returns how many. Calling twice is a no-op. */
  hideFixed(): number {
    if (this.restoreFixed) return 0;
    const elements = findFixedElements(this.win.document);
    this.restoreFixed = hideElements(elements);
    return elements.length;
  }

  /** Put hidden elements and the scroll position back. Idempotent. */
  restore(): void {
    if (this.restored) return;
    this.restored = true;
    try {
      this.restoreFixed?.();
    } finally {
      this.restoreFixed = null;
      if (this.original) scrollToInstant(this.win, this.original.x, this.original.y);
    }
  }
}

/** Run `fn` with a driver and restore the page no matter how `fn` ends. */
export async function withPageDriver<T>(
  win: Window,
  fn: (driver: PageDriver) => Promise<T> | T,
): Promise<T> {
  const driver = new PageDriver(win);
  try {
    return await fn(driver);
  } finally {
    driver.restore();
  }
}
