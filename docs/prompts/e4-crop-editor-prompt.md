# snapping-turtle — Enhancement prompt E4: crop in the annotation editor

Paste everything below this line into Claude Code, started from the repo root. File under `docs/prompts/` per the E-series convention. Assumes M9 and the CI repair are merged and main is green.

---

Read CLAUDE.md and PLAN.md before writing anything; PLAN.md wins on design, CLAUDE.md on process. First confirm the contract holds — run the full suite (`pnpm` checks plus the `cargo` checks with `--locked`) and fix anything broken.

This session's scope is **E4: non-destructive crop on the capture page**, closing the Plasma region gap recorded in §17 (any client can now capture generously and trim on the page). Design decisions, made:

- **Non-destructive, always.** The stored original PNG is immutable — it carries the sha256 attribution record — and the crop is a rect stored in the **annotation document**, so autosave, `rev`/409 handling, undo/redo, owner-only writes, and cache invalidation all come for free. No re-encode, no new endpoints.
- **Shapes stay in original-image pixel space; crop is a viewport.** The owner's editor shows the full image with an adjustable, dimmable crop rect and annotations placeable anywhere; the flat render and viewers get the cropped output with out-of-bounds shapes clipped. The crop is always re-expandable.

## Definition of done — verify each item by running it, not by assertion

1. **Schema, evolved compatibly:** an optional `crop: {x, y, w, h}` field on the annotation document; schema version stays 1 and absence means no crop. Validation in `shared/`: integers, within image bounds, minimum dimensions (a named shared constant, ~16 px). The TypeBox corpus is **extended** with crop accept/reject rows — every existing row and its outcome byte-unchanged. If a clean implementation genuinely requires a version bump or changing existing rows, **stop and report**; that is the wire-format conversation, not a footnote.
2. **Editor:** a crop tool in the toolbar — enter crop mode, drag out or adjust the rect with handles, dimmed outside, apply and clear. Crop changes participate in autosave, the revision counter, 409 reload, and the undo/redo stack exactly like shapes. Re-check the tall-canvas fixture briefly; a crop rect shouldn't change performance, confirm it doesn't.
3. **E1 interaction, named so it can't be missed:** the adaptive sizing functions take **effective width** — crop width when present, image width otherwise — in *both* renderers. A parity fixture renders the same document with and without a narrow crop and proves the stroke weights differ appropriately and identically across renderers. New-text default font size uses effective width; stored absolute `fontSize` values are untouched.
4. **Flat renderer:** composite the overlay in original space, then extract the crop rect. Cache invalidation is free — crop lives in the document, so `annotations_rev` bumps — with a test proving a crop-only change re-renders. **The M4 fast path is a trap:** "no annotations → serve the original untouched" must become "no annotations *and no crop*," or a cropped-but-unannotated capture serves full-size. Test that exact case.
5. **Previews follow the crop:** `og:image:width`/`height` (E3) report effective dimensions, with a test. The flat image URL is unchanged — viewers, copy-links, and the E3 unfurl all inherit the crop with no markup changes, which is the M1 URL-contract payoff again.
6. **Parity suite extended:** fixtures include a shape fully inside, fully outside, and **straddling** the crop boundary — the straddler must clip identically in both renderers. Goldens extended, tolerances recorded as usual.
7. **Documentation:** PLAN.md §9 gains the crop semantics (original-space coordinates, viewport model, E1 effective-width rule), §10 the extract step and the amended fast path, §7 the editor behavior; the §17 Plasma region-gap entry and the client README are updated to say the gap is mitigated by server-side crop (capture the screen, trim on the page). No client code changes.
8. **Manual scenario:** `extension/TESTING.md` (or the client's) gains one flow — full-screen capture from the Linux client, crop to a region on the page, verify the flat image and a Discord unfurl show the cropped result at cropped dimensions.
9. **The contract holds:** full suite green, including the extended corpus and regenerated parity goldens in CI.

## Explicitly out of scope — do not start these

Destructive cropping or downloading a re-encoded cropped original; rotation, multiple crops, or aspect-ratio presets; any `client-linux/` code change (docs only — if a client change seems needed, stop and say why); per-shape stroke or size overrides (still §17).

## Working agreements for this session

- CLAUDE.md rules bind throughout; renderer parity and the wire-format discipline are the invariants this change stresses, and both have explicit stop-and-report lines above.
- Small, coherent commits; no new runtime dependencies are expected.
- Verification means running the command and showing output; anything unverifiable in this environment is marked unverified, not claimed.
- Finish with a closing summary: what changed, verification outputs, the corpus and parity deltas, and a deployment note — server + web only, compose rebuild, no client or extension republish.
