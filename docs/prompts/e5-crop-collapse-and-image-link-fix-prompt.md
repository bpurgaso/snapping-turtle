# snapping-turtle — Prompt E5: crop view collapse/expand (feature) + uncropped image link (bug)

Paste everything below this line into Claude Code, started from the repo root. File under `docs/prompts/`. Assumes E4 is merged and main is green.

---

Read CLAUDE.md and PLAN.md before writing anything; PLAN.md wins on design, CLAUDE.md on process. First confirm the contract holds — full suite including the `cargo --locked` checks — and fix anything broken.

Two work items this session, both server + web only (no client or extension changes — if one seems needed, stop and say why). The E4 invariant governs everything here: **shape and crop coordinates live in original-image pixel space, always.** The feature below changes what the editor *shows*, never what the document *stores*; if an implementation route requires rebasing coordinates or touching the wire format, stop and report.

## Item 1 — feature: the editor collapses to the crop once accepted

Current behavior: the editor always shows the full image with cropped-out regions dimmed. Desired behavior, as a mode model:

- **Crop mode** (entering the crop tool, or adjusting an existing crop): today's view — full image, dimmed outside, adjustable rect with handles. This is explicitly the "add back what I accidentally cropped out" view; previously out-of-crop content and shapes are visible here.
- **Normal mode with an accepted crop:** the editor shows **only the cropped region** — the canvas viewport pans and clips to the crop rect (canvas element sized to crop dimensions), matching what viewers see, so the owner edits what the audience gets.
- Transitions: accepting a crop collapses; re-entering the crop tool expands; clearing the crop returns to the full image. Undo/redo spans these transitions coherently.

### Definition of done — feature

1. The mode model above, implemented as viewport state only — a Playwright test draws a shape **while collapsed** and asserts the stored document holds original-space coordinates (this is the test that guards against silent document corruption), and a second test widens the crop in crop mode and asserts a previously hidden shape reappears without any data change.
2. Out-of-crop shapes: exist, invisible in collapsed mode, visible and editable in crop mode — behavior documented in PLAN.md §7/§9.
3. E1's effective-width sizing already keys on crop width; assert it renders identically in both modes so nothing visually jumps at the transition except the viewport.
4. A quick note on the tall-canvas fixture: collapsed mode should *improve* editor performance on cropped full-page captures (smaller canvas); confirm no regression either way.

## Item 2 — bug: sharing a direct image link serves the original, uncropped image

Diagnose before fixing, with the cheap bisect first: copy the image link from a cropped capture and fetch it — is the **copied URL** not the flat route, or is the flat route serving the wrong **bytes**? Different answers, different fixes.

If it's the bytes, the prime suspect is named in E4's own prompt: the M4 fast path — "no annotations → serve the original untouched" — was required to become "no annotations **and no crop**." Check every branch of that shortcut, and check the cache: whether a crop-only save bumps `annotations_rev`, whether cache validity (`flat_rev`, `RENDER_VERSION`, the ETag inputs) covers a crop-only document, and whether a pre-fix cached uncropped flat can still be served for a cropped capture. Confirm the blast radius while there — if the flat route is wrong, viewers and E3 unfurls are showing uncropped output too, not just shared links.

### Definition of done — bug

5. Root cause identified with the bisect evidence, and fixed at the cause.
6. A regression **matrix**, not a spot test: all four states — no annotations/no crop, shapes only, **crop only**, shapes + crop — each asserting the served image's actual pixel dimensions, plus: the ETag changes on a crop-only edit, the copy-image button's URL is the flat route, and E3's `og:image` dimensions are correct for the crop-only case.
7. Stale caches handled: any already-cached uncropped flat for a cropped capture must regenerate on next view — if the cache key was the flaw, bumping `RENDER_VERSION` is the designed lever; say which was used.
8. **A short retrospective, required:** E4's DoD claimed tests for exactly this behavior — identify the gap that let the bug ship (most likely: fixtures always paired crop with shapes) and close the gap *class*, adding crop-only fixtures wherever shape fixtures exist (validation corpus rows, parity, integration).

## Explicitly out of scope — do not start these

Wire-format or schema changes (stop-and-report per the header); aspect-ratio presets, rotation, multi-crop (§17); any client/extension code; download-original affordances.

## Working agreements for this session

- CLAUDE.md rules bind throughout; the coordinate-space invariant and the fast-path condition are the two things this session most stresses, and both have their guard tests named above.
- Small, coherent commits; no new runtime dependencies are expected.
- Verification means running the command and showing output; anything unverifiable in this environment is marked unverified, not claimed.
- Finish with a closing summary: feature behavior notes, the bug's root cause and retrospective, verification outputs, and the deployment note — server + web, compose rebuild, nothing republished.
