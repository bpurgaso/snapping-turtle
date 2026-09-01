/** What the built harness exposes inside fixture pages (see harness.ts). */
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type HarnessApi = typeof import('./harness.js');

interface Window {
  __stHarness: HarnessApi;
  /** Scratch space the specs use to pass results out of page.evaluate. */
  __stTest: Record<string, unknown>;
}
