# client-linux — manual checklist

What automation covers: `cargo test` (argument parsing, config and token
files with their modes, origin normalisation, upload/ping classification,
QImage → RGBA → PNG conversion, portal-file cleanup rules, redaction, the
shared-constants mirror) and `scripts/integration.sh` (the real server, a
real upload through the binary, the row, the page, secret hygiene). What
needs a desktop session is below. Run it on the Fedora 44 / Plasma Wayland
machine after `sudo dnf install` of the RPM and `snapping-turtle --configure`
with a fresh token. Everything here is the human's to confirm; nothing in
it is claimed by the automated run.

Status column: **verified 2026-09-03** = exercised in this milestone's
Plasma 6.7.4 session with a development build authorised through a
`~/.local/share/applications` desktop file; **unverified** = for you.

| # | Check | Expect | Status |
| --- | --- | --- | --- |
| 1 | `snapping-turtle --configure` with the token from your Account page | "Testing connection … ok"; token stored in the keyring (KWallet prompt may appear once); config saved; autostart question answered | unverified (the file-store, non-interactive form is verified by integration.sh) |
| 2 | Launch **snapping-turtle** from Kickoff | Tray icon appears in the system tray; tooltip "Ready"; Plasma's global-shortcut grants dialog appears once for `capture-full/region/window` | unverified |
| 3 | Tray → **Capture full screen** | No dialog; the screen with the active window uploads; notification "Capture uploaded"; the capture page opens in the browser with a `Full screen <date time>` title and **no "Open original page" link** | verified 2026-09-03 via `--capture full` (KWin `CaptureActiveScreen`, 5120×1440, format 6); tray/browser-open path unverified |
| 4 | Tray → **Capture window…** | KWin's crosshair and on-screen hint; click a window → that window (decorated, no shadow) uploads; Escape cancels with no upload and no error notification | unverified (API confirmed from KWin 6.7 source) |
| 5 | Tray → **Capture region…** | The Plasma portal chooser (Full Screen / Current Screen / Active Window, cursor and border toggles, preview, Share); Share uploads; Cancel → nothing. Note the absence of a rectangle option — that is the measured Plasma 6.7 limitation (README) | unverified (dialog contents confirmed from xdg-desktop-portal-kde 6.7.4 source) |
| 6 | Second full-screen capture | Still no prompt of any kind (KWin authorises by desktop file, not a grant) | verified 2026-09-03 (two consecutive `--capture full` runs) |
| 7 | Portal permission persistence: run the binary from a path KWin does not authorise (`cp /usr/bin/snapping-turtle /tmp/st && /tmp/st --capture full`) | First run: "Allow snapping-turtle to Take Screenshots?" — Allow; the whole workspace uploads. Second run: no prompt. The remembered grant is per app id (`flatpak permission-show screenshot` lists it, or the permission store table `screenshot`) | unverified — the dialog appeared unattended in this session (the request waited 45 s and was cancelled) |
| 8 | Desktop actions: right-click the launcher/task-manager entry → each of the three | Same three flows, routed to the resident instance when it runs (one tray icon, one shortcut session) | unverified |
| 9 | Global shortcuts: Meta+Alt+S / R / W (or what you granted) | Same three flows from any application | unverified |
| 10 | **401 path:** revoke the token on the Account page, capture | Notification "Capture not uploaded — reconfigure" naming `snapping-turtle --configure`; nothing opens; the tooltip says not uploaded | unverified (classification unit-tested; `--configure` with a bad token verified to refuse and save nothing) |
| 11 | **Oversize path:** a region/window capture that would exceed 30 MB is hard to make with PNG; instead `--upload-file` a 10,001 px-wide PNG | Refused locally with the dimension message, no request sent | unverified (unit-tested) |
| 12 | **File hygiene, ten captures:** `ls ~/Pictures | wc -l`, then ten *Capture region…* (Share each), then count again | Count unchanged (the portal's `Screenshot_*.png` is removed after each upload); Spectacle's own `~/Pictures/Screenshots/` untouched. Ten full-screen captures also leave the count unchanged (no file is ever written) | full-screen part verified 2026-09-03 (Pictures count unchanged after two captures); portal part unverified |
| 13 | Autostart: log out and in | Tray icon present without launching anything; `snapping-turtle --autostart off` removes `~/.config/autostart/<app id>.desktop`; next login has no icon | unverified (`--autostart no` through the Background portal verified to answer for a host app) |
| 14 | Quit from the tray; `snapping-turtle --capture window` from a terminal | Works inline without the resident instance | unverified |
| 15 | GNOME session (only if one is available): tray via the AppIndicator extension, all three actions through the portal (full = silent after the grant, window and region = GNOME's chooser) | Works; out of scope to polish (PLAN.md §17) | unverified |

Findings to record back into README.md if they differ: which API served each
mode (`-v` prints it), where the portal file landed, whether the first-use
prompts matched the wording above.
