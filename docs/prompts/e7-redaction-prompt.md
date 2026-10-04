# snapping-turtle — Enhancement prompt E7: redaction

Paste everything below this line into Claude Code, started from the repo root. File under `docs/prompts/`. Assumes E5 (and E6 if shipped) are merged and main is green.

---

Read CLAUDE.md and PLAN.md before writing anything; PLAN.md wins on design, CLAUDE.md on process. First confirm the contract holds — full suite including the `cargo --locked` checks — and fix anything broken.

This session's scope is **E7: redaction** — the owner selects regions of a capture to obfuscate, and no link of any kind ever yields the hidden pixels, while the owner can delete a redaction like any other annotation. Those two requirements jointly fix the architecture, and the first deliverable is writing that down:

## Item 0 — the threat model, written before the code (PLAN.md §9 + §12)

Deletable redaction requires the original pixels to survive, so the guarantee is **access control, not data destruction**, scoped precisely: (a) no capability URL — page, flat image, preview — ever emits unredacted pixels; (b) the original remains reachable only through an authenticated **owner** session, and by the admin — the server operator is explicitly **inside the trust boundary**; defending against the admin is a stated non-goal, consistent with existing admin capture access and the trust-and-safety attribution requirements; (c) the guarantee is **prospective** — viewers before the redaction existed saw what they saw, and the docs say so honestly. Irreversible "burn-in" (flatten redactions into the original, destroying deletability) is recorded in §17 as a distinct future feature, not built here.

## Definition of done — verify each item by running it, not by assertion

1. **Schema:** a new `redact` shape — `{x, y, w, h}`, integers, bounds-validated, minimum size — added to the version-1 document per the established discipline: corpus **extended**, existing rows and outcomes byte-unchanged; stop-and-report if that proves impossible.
2. **Obfuscation is solid opaque fill, full stop.** No blur, no pixelate, no mosaic — and a code comment at the renderer explains why: obfuscation derived from source pixels is reconstructable (depixelation of blurred text is a practical attack), so the output must contain zero information from the covered region. The fill color is a shared constant.
3. **Rendering rule, deterministic in both renderers:** image → all redactions → all other shapes, so arrows and text can point *at* a redacted block but nothing ever peeks from under one. Redact geometry passes through **one shared function with outward integer rounding** — any renderer disagreement must err toward covering more, never less — and E1's adaptive sizing is explicitly inapplicable (no stroke, pure fill).
4. **Editor:** a redact tool with the rectangle tool's draw interaction; redactions render **opaque in the editor** (WYSIWYG — the owner sees exactly what viewers get), going semi-transparent only while actively being dragged or resized for precise placement, snapping opaque on release. Delete, undo/redo, autosave, `rev`/409 all work because it's an ordinary shape — requirement two satisfied by construction. Behaves correctly in both crop view modes (E5).
5. **The pixel leak test — the heart of the milestone:** a fixture with known, high-contrast content; redact a region; fetch the served flat and **sample actual pixels** inside each redact rect, asserting pure fill color with zero source-pixel bleed, including at the rect's exact edges. Matrix: redaction alone, redaction + shapes, redaction + crop, and a redaction **straddling the crop boundary** (the visible portion must be covered in the cropped output).
6. **Route audit, enumerated and attempted:** list every endpoint and artifact that emits capture pixels (flat route, the editor's owner-gated original route, OG/unfurl targets, anything else found); integration tests attempt each for a redacted capture as **anonymous** and as a **different authenticated non-owner** — every reachable response contains only redacted pixels, everything else is the uniform 404/403 posture. Additionally: the non-owner page HTML is inspected to confirm no original-image URL appears anywhere in markup a link-holder receives.
7. **Cache correctness:** adding or editing a redaction bumps `annotations_rev` through the normal save path, the stale pre-redaction flat is never served (the rev-match condition, tested with a deliberately staged stale file), and the ETag changes — so any viewer's browser revalidation fetches redacted bytes.
8. **Parity:** redact fixtures in both renderers with near-zero tolerance inside redact regions — a parity failure here is a privacy bug, and the tolerance recorded for these fixtures must say so.
9. **Docs + manual rows:** PLAN.md §7 (editor behavior), §9 (shape + rendering rule + threat model pointer), §17 (burn-in). TESTING.md gains: redact → open the link in a private window and confirm; redact → confirm a Discord unfurl shows the redacted image.
10. **The contract holds:** full suite green; deployment note — server + web, compose rebuild, no clients or extensions republished.

## Explicitly out of scope — do not start these

Blur/pixelate/mosaic styles (banned above, with rationale — not deferred, *rejected* unless someday rendered from noise rather than source); burn-in/irreversible flattening (§17); per-viewer selective disclosure; any extension or client-linux change; changing admin visibility of originals (policy stated, not altered).

## Working agreements for this session

- CLAUDE.md rules bind throughout; this feature's invariants are the rendering-order rule, the outward-rounding function, and the route audit — each with its test named above.
- Small, coherent commits; no new runtime dependencies are expected.
- Verification means running the command and showing output; anything unverifiable in this environment is marked unverified, not claimed.
- Finish with a closing summary: the written threat model, verification outputs with the leak-test results called out, the route-audit table, and anything intentionally deferred.
