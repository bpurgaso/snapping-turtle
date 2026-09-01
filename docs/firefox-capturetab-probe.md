# Firefox `tabs.captureTab({ rect, scale })` probe (M6, PLAN.md §15)

**Question:** PLAN.md §15 has Firefox capture the whole document natively with
one `tabs.captureTab(tabId, { rect })` call. How does the `scale` option
interact with `devicePixelRatio`, and does Firefox clamp or refuse very tall
rects — or is the 32,000-physical-px cap (`MAX_IMAGE_HEIGHT_PX`) ours alone
to enforce?

**Answer (Firefox 154.0.1, 2026-08-31):**

- Output size is exactly `rect.width × scale` by `rect.height × scale`.
- `scale` is an **absolute** physical-px-per-CSS-px factor. Omitting it uses
  `devicePixelRatio`; passing `scale: devicePixelRatio` produces a
  byte-identical image; `scale: 1` on a 2× display gives a 1× image. It is
  **not** multiplied on top of dpr, so there is no double scaling to correct.
- A rect taller than the document is **padded**, not clamped and not an error
  (a 5,000 px document captured as a 9,000-row rect).
- 32,000- and 40,000-row rects render without error (1,000 px wide, ~200 ms).
  Firefox does not enforce our cap; `reconcileFullPageCapture` in
  `extension/src/lib/capture-geometry.ts` crops the real image to the cap.
- `resetScrollPosition: true` is accepted.

Consequence for the extension: pass `scale: devicePixelRatio` explicitly (so
the output is deterministic and documented), cap the requested rect height at
`floor(MAX_IMAGE_HEIGHT_PX / scale)` CSS px, and still measure the decoded
result before upload.

## Data

`layout.css.devPixelsPerPx` set to 1, 2 and 1.5 (headless Firefox otherwise
reports dpr 1); window 1000 × 800, document 1000 × 5000 CSS px, viewport
content box 1000 × 715/716.

| call                                            | dpr 1        | dpr 2        | dpr 1.5     |
| ----------------------------------------------- | ------------ | ------------ | ----------- |
| `captureTab()` (visible, default)               | 1000 × 715   | 2000 × 1432  | 1500 × 1074 |
| `rect 1000×5000`, no `scale`                    | 1000 × 5000  | 2000 × 10000 | 1500 × 7500 |
| `rect 1000×5000, scale: dpr`                    | 1000 × 5000  | 2000 × 10000 | 1500 × 7500 |
| `rect 1000×5000, scale: 1`                      | 1000 × 5000  | 1000 × 5000  | 1000 × 5000 |
| `rect 1000×5000, scale: 2`                      | 2000 × 10000 | 2000 × 10000 | —           |
| `rect 1000×5000, scale: 1, resetScrollPosition` | 1000 × 5000  | 1000 × 5000  | —           |
| `rect 1000×9000` (beyond the 5000 px document)  | 1000 × 9000  | 1000 × 9000  | —           |
| `rect 1000×32000, scale: 1`                     | 1000 × 32000 | 1000 × 32000 | —           |
| `rect 1000×16000, scale: 2`                     | 2000 × 32000 | 2000 × 32000 | —           |
| `rect 1000×40000, scale: 1`                     | 1000 × 40000 | 1000 × 40000 | —           |

## Method

`docs/firefox-capturetab-probe/` holds a throwaway **MV2** probe extension
(`<all_urls>` is granted at install for MV2, so no toolbar gesture is needed —
which is the whole reason it is MV2; the shipped extension stays MV3) and a
dependency-free WebDriver runner. The probe fires on a tab whose URL contains
`st-probe`, runs every case above, decodes each data URL with
`createImageBitmap`, and writes the JSON into `document.title`, which the
runner polls.

```sh
cd docs/firefox-capturetab-probe
npm i --no-save geckodriver          # downloads the driver binary
node run.mjs 1                        # dpr 1, headless
node run.mjs 2                        # dpr 2 via layout.css.devPixelsPerPx
node run.mjs 1.5 headed               # any dpr; "headed" shows the window
```

The runner expects Firefox at `/Applications/Firefox.app/Contents/MacOS/firefox`;
edit `binary` in `run.mjs` elsewhere. Re-run this when bumping
`strict_min_version` or when Firefox release notes mention `captureTab`.

## Not covered

- Fixed/sticky elements inside a rect capture: rendered once at their
  position for scroll offset 0 (`resetScrollPosition: true`); not measured here.
- Memory/time at 10,000 px wide × 32,000 px tall (the server's width cap);
  the probe stops at 2,000 × 32,000 (~0.4 s).
- Whether this holds on Windows/Linux builds; the measurements are macOS
  (Darwin 25.6, Apple silicon).
