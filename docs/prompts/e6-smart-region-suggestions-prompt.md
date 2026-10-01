# snapping-turtle — Enhancement prompt E6: smart region suggestions

Paste everything below this line into Claude Code, started from the repo root. File under `docs/prompts/`. Assumes the Firefox captureTab fix and E5 are merged and main is green.

---

Read CLAUDE.md and PLAN.md before writing anything; PLAN.md wins on design, CLAUDE.md on process. First confirm the contract holds — full suite including the `cargo --locked` checks — and fix anything broken. Then re-read the M6 region overlay code; this feature extends it in place.

This session's scope is **E6: element-aware region suggestions** in both browser extensions' region mode. Owner decisions, made: **click on a highlighted suggestion captures immediately** (no adjust-then-confirm — the crop tool is the fixup path); **manual drag is the only refinement** (no keyboard hierarchy-walking — record that idea in §17 as the known future refinement); **conservative targeting** — only confident targets get highlighted, and hovering anything else shows nothing. The feature is an assist layered onto the existing overlay: drag behaves exactly as today and starting a drag dismisses any highlight instantly.

## Design, decided

- **Confident targets:** (a) replaced/media elements — `img`, `video`, `canvas`, `svg`, `picture` — suggesting their own bounds; (b) containers with a visible border (non-zero width, non-transparent color) or a box-shadow. Size guards both ways: skip targets below a minimum (~32 CSS px per side, a named constant) and skip near-viewport containers (>~90% of viewport area — full-screen mode already exists). Nothing else qualifies; a plain paragraph on a plain background highlights nothing, by contract.
- **Selection rule:** the suggestion is the **nearest qualifying ancestor-or-self** of the element under the cursor. This yields both of the owner's examples for free: hovering an image suggests the image; hovering a bordered card's padding or edge suggests the card. One refinement if fixtures show a qualifying child (an image filling its card) making the card unreachable: cursor within ~8 px of a qualifying *ancestor's* edge promotes the ancestor over the qualifying descendant.
- **Hit-testing through our own overlay:** the overlay keeps `pointer-events` (it must receive the click), and page elements are found with `document.elementsFromPoint(x, y)`, skipping our shadow host in the returned stack — do not toggle pointer-events per mousemove.
- **Known limitations, documented not fought:** cross-origin iframes and closed shadow roots can't be inspected — an iframe or shadow host is itself suggestible only if it qualifies (bordered, media); open shadow roots are not pierced in v1. Same-origin iframe traversal is out of scope.

## Definition of done — verify each item by running it, not by assertion

1. **The qualifier is a pure module** — element-ish descriptors in, qualify/not + rect out, no browser APIs — unit-tested exhaustively (border/shadow detection, size guards, ancestor-or-self selection, edge promotion). The M6 lesson applies: the logic that will have bugs must be testable without a browser.
2. **Overlay integration:** rAF-throttled hover highlighting with a per-element decision cache (WeakMap); a visually distinct suggestion highlight (clearly different from the drag rect, with a small dimensions badge); click captures the suggested rect; drag anywhere starts a manual selection and dismisses the highlight; Esc cancels as today; click with no highlight is a no-op.
3. **Geometry correctness:** rects from `getBoundingClientRect` are rounded *outward* so borders aren't shaved, clamped to the viewport, and fed into the existing dpr-scaling and crop path unchanged — no new capture code.
4. **The M6 remove-before-capture trap applies to the highlight:** the suggestion highlight and overlay are fully removed and a frame awaited before `captureVisibleTab` fires, so the assist never photographs itself. Test it the way M6 did.
5. **Playwright fixture pages** (plain pages, no extension APIs — the M6 pattern): an image grid; bordered and shadowed cards; a plain-text page that must yield **zero** suggestions (the conservative contract, asserted, not assumed); tiny icons skipped; a near-viewport container skipped; an image inside a bordered card exercising the ancestor rule and the edge promotion; the hostile-CSS page confirming the highlight renders inside the shadow root regardless.
6. **No new permissions:** `activeTab` + `scripting` already cover everything here — the release audit's manifest check asserts the permission set is byte-identical to before, and STORE_SUBMISSION.md needs no disclosure changes.
7. **Options toggle:** "Smart region suggestions," default on, in the existing options page — stored with the other settings, respected by the overlay.
8. **Both browsers** from the shared content script, builds green from templates, version bumped.
9. **TESTING.md gains the manual rows:** suggestion-click capture on a real image-heavy page and a card-based page, the no-suggestion state on plain text, the toggle, on both browsers — and the closing summary lists them plainly as the owner's to run, alongside any still-unrun rows from before (the captureTab bug's lesson: unrun rows are where shipped bugs live).
10. **The contract holds:** full suite green.

## Explicitly out of scope — do not start these

Keyboard hierarchy-walking (declined by the owner; §17); always-on/best-guess suggestions for non-qualifying elements; piercing open shadow roots or traversing same-origin iframes; any OCR/visual-ML detection; any server, client-linux, or capture-path changes beyond the overlay.

## Working agreements for this session

- CLAUDE.md rules bind throughout; the permission floor (item 6) and the remove-before-capture trap (item 4) are the two invariants this feature brushes against.
- Small, coherent commits; no new runtime dependencies are expected.
- Where real-page behavior defies the heuristic constants (size floors, edge distance), tune the named constants against the fixtures and record the final values — the model is fixed, the numbers are not.
- Verification means running the command and showing output; desktop-browser behavior that needs a real session lands in TESTING.md as the owner's, never claimed.
- Finish with a closing summary: what was built, verification outputs, the final heuristic constants, and the ship handoff — `build:release`, `sign:firefox` + publish to `/ext/` (auto-update delivers to installed Firefoxes), and upload the new zip to the Chrome listing if it's live (its first update), else note it rides the next submission.
