# snapping-turtle — Enhancement prompt E1: adaptive annotation sizing

Paste everything below this line into Claude Code, started from the repo root. First of the post-1.0 enhancement prompts; keep the numbering convention and file these under `docs/prompts/` alongside the triage playbook.

---

Read CLAUDE.md and PLAN.md before writing anything; PLAN.md wins on design, CLAUDE.md on process. First confirm the contract holds — run the full suite (`pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm test:parity`) and fix anything broken.

This session's scope is **E1: annotations scale relative to image size** so they stay legible on everything from a 300 px region crop to a 10,000 px-wide retina full-page capture. The design, decided: sizing derives from **image width** (viewing is fit-to-width, so width-proportional means constant apparent size; height is deliberately ignored so tall pages don't get giant strokes), passed through **clamps** (a floor for tiny crops that display at natural size, a ceiling against cartoonish extremes). The annotation **wire format does not change** — this is a rendering change, not a schema change.

## Definition of done — verify each item by running it, not by assertion

1. **Sizing model in `shared/`:** the fixed style constants (stroke width, white-outline delta, arrowhead dimensions, default text size) become pure functions of image width — `clamp(k · width, min, max)` with the curve constants named and exported. Unit tests pin the curve at the boundary dimensions: a ~300 px crop (floor engaged), ~1,280 and ~3,200 px typical captures (proportional region), the 10,000 px width cap (ceiling engaged). Document the curve — a small table of width → resulting sizes — in PLAN.md §9.
2. **Both renderers consume the functions, nothing inlines a size:** the Fabric editor and the SVG flat renderer both call the shared functions with the capture's width. Add a cheap guard in the spirit of the pin check — a test or lint that fails if a literal stroke/font constant reappears outside `shared/` in either renderer.
3. **Wire format untouched, and provably:** schema stays version 1; stored `fontSize` remains absolute pixels; only the *default* for newly placed text derives from width, and user resize stores absolute exactly as today. The TypeBox corpus and its accept/reject table pass unmodified. If implementation pressure ever suggests storing relative units or bumping the schema version, **stop and report** — that is a different, larger change.
4. **Editor behavior:** new shapes pick up derived sizes on creation; existing documents load and edit normally; selection handles and the arrow's endpoint controls are unaffected. Re-check the tall-canvas fixture from M3 briefly — derived sizes shouldn't change performance, confirm they don't.
5. **Flat-render cache learns about renderer versions:** cached flats are currently valid when `flat_rev === annotations_rev`, but this change alters output with no rev change anywhere. Introduce a `RENDER_VERSION` constant folded into cache validity so every pre-E1 flat regenerates lazily on next view — no mass re-render job; the single-flight queue absorbs it. Test: a cache file stamped with the old version is re-rendered despite matching revs.
6. **Parity suite regenerated across a dimension matrix:** fixtures now span small / typical / huge widths for each shape type; goldens regenerate (reviewable diff), tolerances re-recorded, and the extreme fixtures explicitly prove the floor and ceiling clamp behavior in both renderers.
7. **The existing-content decision, recorded:** pre-E1 annotations re-render with adaptive sizing — an accepted visual change to already-shared links, reasonable at this deployment's age and content volume. Write that decision and its rationale into PLAN.md §9 so a future compatibility question finds an answer, not a mystery.
8. **Manual check added:** `extension/TESTING.md` gains one scenario — annotate a full-page capture and a small region crop, view both logged-out, confirm legibility at fit-to-width and natural size respectively.
9. **The contract holds:** full suite green, including the regenerated parity goldens in CI.

## Explicitly out of scope — do not start these

Schema version 2 / stored relative units (the stop-and-report above); per-shape user-adjustable stroke width (a future enhancement, note it in §17); viewer-side dynamic scaling of the flat image (the PNG is the product); any extension change (none is needed — if you believe one is, stop and say why).

## Working agreements for this session

- CLAUDE.md rules bind throughout; renderer parity (the §10 convention) is the invariant this change most stresses — the shared functions are the mechanism, the regenerated goldens the proof.
- Small, coherent commits; no new runtime dependencies are expected.
- Where the chosen curve constants prove visually wrong on real fixtures, tune the constants and update the PLAN.md §9 table in the same change — the model is fixed, the numbers are not.
- Verification means running the command and showing output; anything unverifiable in this environment is marked unverified, not claimed.
- Finish with a closing summary: what changed, verification outputs, the final curve table, and a note on deployment — server + web only, compose rebuild, no extension republish.
