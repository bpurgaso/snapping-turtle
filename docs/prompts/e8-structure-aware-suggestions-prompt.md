# snapping-turtle — Enhancement prompt E8: structure-aware region suggestions + magnetic drag edges

Paste everything below this line into Claude Code, started from the repo root. File under `docs/prompts/`. Assumes E6 is merged and main is green.

---

Read CLAUDE.md and PLAN.md before writing anything; PLAN.md wins on design, CLAUDE.md on process. First confirm the contract holds — full suite including the `cargo --locked` checks — and fix anything broken. Then re-read the E6 overlay and qualifier module; E8 upgrades them in place.

This session's scope is **E8: a structure pre-scan behind region suggestions**, inverting E6's model. Today the overlay reactively probes under the cursor; E8 runs **one bounded scan of the visible DOM when region mode starts**, building a ranked candidate map, so hover becomes a cheap lookup against a spatial index. The same content-script injection E6 already uses covers all of this — **no new permissions, no manifest change** — and the E6 interaction decisions stand unchanged: click a highlight to capture immediately, drag manually otherwise, conservative targeting.

**The contract that must survive:** structure signals *widen what counts as confident; they never lower the bar.* The plain-paragraph-yields-nothing fixture stays asserted. A bare `div` of text with no border, no semantics, and no repetition context still highlights nothing.

## Definition of done — verify each item by running it, not by assertion

1. **The scan engine is a pure module** (descriptors in → ranked candidates out), per the M6/E6 pattern, with named budget constants: viewport-scoped traversal, a node cap, rAF-sliced work so the page never janks, and a hard time budget. The overlay consumes its output; it never touches browser APIs itself.
2. **Candidate sources, unioned with E6's:** (a) E6's border/shadow and media qualifiers, unchanged; (b) **semantics** — `article`, `section` with a heading, `figure`, `table`, `pre`, `blockquote`, landmark/ARIA roles that denote self-contained units; (c) **repetition** — children of a grid/flex container with uniform sibling geometry (within a tolerance constant) qualify as items and their container qualifies as the set; (d) **precomputed visual distinctness** — background contrast vs ancestor, radius + shadow, judged once during the scan, never per-mousemove. Size guards from E6 (tiny floor, near-viewport ceiling) apply to every source.
3. **Ranking and hover resolution:** hover resolves via the spatial index to the smallest qualifying candidate containing the point; E6's edge-promotion rule carries over; for repetition, hovering an item suggests the item and hovering the gutter between items suggests the container. Document the precedence order in the module and prove each rule with a fixture.
4. **Dynamic pages:** a MutationObserver invalidates affected candidates and schedules a throttled partial rescan — an infinite-feed fixture proves new cards become suggestible without re-entering region mode, within the same budgets.
5. **Performance is asserted, not assumed:** on a deliberately heavy fixture (thousands of nodes), the scan completes within its budget, hover lookup stays under a per-move budget, and the test prints the measured numbers so regressions are visible in CI output.
6. **Magnetic drag edges:** during manual drag, each edge snaps to nearby candidate boundaries within a snap distance (~6 px, a named constant), with subtle visual feedback on snap; **holding Alt suppresses snapping** for the pixel-perfect case — magnetism must always be escapable. Snapped edges use the same outward rounding as E6 geometry. The existing options toggle governs the whole assist (suggestions + snap) as one setting.
7. **Fixture suite extends E6's:** a card grid/feed (repetition — item and gutter cases); a semantic page (`article`/`figure`/`table` suggestible with zero visual styling — the new-capability proof); the **borderless card** page that E6 could not see, now confidently suggested; plain text still yielding zero; a canvas-app page yielding zero (pixels without DOM — documented limit, asserted); the dynamic feed; the heavy-DOM perf fixture; hostile CSS unchanged.
8. **No permission creep, proven:** the release audit's manifest assertion (byte-identical permission set) passes; STORE_SUBMISSION.md and the AMO data-collection declarations need no changes, stated in the summary.
9. **TESTING.md rows:** suggestions on a real feed-style site and a docs/article-style site, snap-drag with and without Alt, the toggle, on both browsers — listed as the owner's, alongside any still-unrun rows.
10. **The contract holds:** full suite green; version bumped; the ship handoff — `build:release`, preflight + `sign:firefox`, publish to `/ext/` (auto-update delivers), upload the new zip to the Chrome listing.

## Explicitly out of scope — do not start these

Piercing closed shadow roots or cross-origin iframes (physics, not effort — still documented limits); OCR, ML, or pixel-analysis targeting; always-on best-guess suggestions (the conservative contract is load-bearing); keyboard hierarchy-walking (still §17, still declined); any server or client-linux change.

## Working agreements for this session

- CLAUDE.md rules bind throughout; the permission floor and the conservative contract are this session's invariants, each with its asserting test named above.
- Small, coherent commits; no new runtime dependencies are expected.
- The heuristic and budget constants are tunable against fixtures — the model is fixed, the numbers are not; record the final values in the module and the closing summary.
- Verification means running the command and showing output; desktop-browser behavior that needs a real session lands in TESTING.md as the owner's, never claimed.
- Finish with a closing summary: what was built, measured scan/hover numbers, final constants, verification outputs, and the ship handoff.
