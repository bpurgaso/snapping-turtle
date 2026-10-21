/** What the built harness exposes inside fixture pages (see harness.ts). */
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type HarnessApi = typeof import('./harness.js');

interface Window {
  __stHarness: HarnessApi;
  /** Scratch space the specs use to pass results out of page.evaluate. */
  __stTest: Record<string, unknown>;
}

interface Window {
  /** suggest-feed.html: drives the dynamic fixture from the spec. */
  __feed: {
    append(n: number): void;
    appendArticle(): string;
    remove(id: string): void;
    tint(on: boolean): void;
  };
  /** suggest-heavy.html: the generated page's shape. */
  __heavy: { elements: number; inViewport: number };
}
