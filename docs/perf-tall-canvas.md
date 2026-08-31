# Tall-canvas performance spike (M3, PLAN.md §9)

**Question:** is a single Fabric.js canvas usable at the tallest capture the
system can ingest, or do we need the windowed-rendering fallback §9 designed?

**Answer: usable — ship M3 on the single canvas.** At standard resolution the
maximal capture is fully smooth. At retina (dpr 2) the *worst legal image* gets
sluggish while dragging shapes (p95 ≈ 100 ms/frame) but stays workable; the
fallback stays unbuilt, with a revisit trigger noted below.

## Fixture

`server/test/helpers/make-tall-fixture.ts` → **4,680 × 32,000 px** (banded
page-like SVG rasterized by sharp; 0.7 MB PNG).

Note the task's nominal "~10,000 × 32,000" fixture cannot exist here: that is
320 MP, and our own ingest cap (`MAX_IMAGE_PIXELS`, §12 decompression-bomb
guard) admits 150 MP. 4,680 px is the widest image possible at the full
32,000 px height — this spike runs at the actual ceiling.

## Method

`web/test/parity/perf-tall.spec.ts` (manual; skipped unless `ST_PERF_FIXTURE`
is set). Playwright headless Chromium 1.62, viewport 1280×720, macOS
(Darwin 25.6, Apple silicon), 2026-08-31. Editor scales fit-to-width:
canvas element ≈ 1246 × 8,520 CSS px at zoom ≈ 0.266, page scrolls vertically.
Frame times sampled with a rAF loop during scripted mouse drags.

```
DATABASE_URL=… ST_PERF_FIXTURE=/tmp/tall.png [ST_PERF_DPR=2] \
  pnpm --filter @snapping-turtle/web exec playwright test test/parity/perf-tall.spec.ts
```

## Results

| Metric                          | dpr 1        | dpr 2 (retina) |
|---------------------------------|--------------|----------------|
| Upload (0.7 MB fixture)         | 238 ms       | 237 ms         |
| Page load → interactive editor¹ | ~1.0 s       | ~1.1 s         |
| Draw rectangle, avg / p95 frame | 8.2 / 9.3 ms | 9.5 / 9.8 ms   |
| Drag rectangle, avg / p95 frame | 14.1 / 25.1 ms | **51.1 / 100.3 ms** |
| JS heap after load / drag       | 2.9 / 5.0 MB | 2.9 / 4.3 MB   |

¹ measured 2.0–2.1 s including a deliberate 1 s settle wait; navigation +
canvas + image response is ≈ 1 s.

## Reading the numbers

- **Draw is cheap everywhere** — creating a shape only repaints the upper
  (interaction) canvas.
- **Dragging an existing shape repaints the lower canvas**, i.e. re-blits the
  scaled 150 MP background every frame. At dpr 1 (≈ 10.6 M backing px/layer)
  that is 60 fps; at dpr 2 (≈ 42 M backing px/layer) it drops to ~10–20 fps —
  sluggish but controllable, and only on captures near the height ceiling.
- **JS heap is not the memory story**: the decoded 150 MP bitmap (~600 MB RGBA)
  lives in the renderer's image cache, outside `usedJSHeapSize`. Process-level
  RSS was not measured; no instability was observed across runs.

## Caveats

- Synthetic fixture compresses to 0.7 MB; real full-page captures will be
  10–25 MB and decode slower on load (one-time cost, not per-frame).
- Headless Chromium; real-GPU compositing may shift both directions.
- Typical captures (viewport-sized, even 4–8 k tall) are far below this
  ceiling and smooth at any dpr.

## If/when it needs fixing (deferred, per §9)

Revisit when M6 lands full-page capture (the only producer of such images), or
sooner if real-world drags exceed ~50 ms p95 on target hardware:

1. **Windowed rendering** (§9's designed fallback): only the visible slice of
   the image on canvas; annotations already live in image coordinates.
2. Cheap partial mitigation: `enableRetinaScaling: false` above a canvas-area
   threshold — restores dpr-1 pacing at the cost of slightly soft rendering on
   retina, no architectural change.
