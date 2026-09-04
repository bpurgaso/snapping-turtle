# snapping-turtle for Linux

A tray-resident capture client for a self-hosted snapping-turtle server:
full-screen, region and window capture, upload with your API token, and the
annotation page opens in your default browser. Primary target: **Fedora 44,
KDE Plasma 6, Wayland**. Design authority: PLAN.md §15a (M9).

It is the repository's one non-TypeScript component — Rust, because
[ashpd](https://crates.io/crates/ashpd) is the maintained first-class portal
binding, the result is a single dependency-light binary, and nothing here
touches the renderer code where the shared-types rule matters (CLAUDE.md).

## Install, configure, capture

1. **Install the RPM** from the GitHub release (built by the release
   workflow in a `fedora:44` container) — or build it yourself on a Fedora
   box with `rpm-build`, `gcc` and the pinned toolchain (`rust-toolchain.toml`;
   rustup obeys it, and `scripts/toolchain.sh` installs both if you have
   neither — do not `dnf install rust`, see "Building and checking"):

   ```sh
   client-linux/scripts/toolchain.sh        # once: rustup + the pinned rustc/clippy/rustfmt
   client-linux/scripts/package-rpm.sh      # reads CLIENT_APP_ID / PUBLIC_HOST+PORT from deploy/.env
   sudo dnf install client-linux/dist/snapping-turtle-*.rpm
   ```

   The package installs `/usr/bin/snapping-turtle`, the desktop file
   `<app id>.desktop` (with three desktop actions and the KWin annotation —
   see "How capture works"), the hicolor icons and these docs.

2. **Configure** — needs a fresh API token from your **Account** page:

   ```sh
   snapping-turtle --configure
   ```

   It asks for the server origin (prefilled with the origin the build was
   made for), the token (not echoed), tests it against `GET /api/v1/ping`,
   stores it in the **Secret Service keyring** (KWallet through ksecretd on
   Plasma, GNOME Keyring elsewhere) or — when no keyring answers — in a 0600
   file under `~/.config/snapping-turtle/`, and offers **start at login**
   (default yes; see "Autostart"). The config file holds the origin and which
   store the token is in, never the token.

   Non-interactive form (scripts, CI):
   `printf '%s\n' "$TOKEN" | snapping-turtle --configure --origin https://host:28443 --token-stdin --token-store file --autostart no`

3. **Capture.** Start `snapping-turtle` (the launcher entry, or log out and
   in if you chose autostart). Then, from any of:
   - the **tray icon** menu — *Capture full screen*, *Capture region…*,
     *Capture window…*, *Open last capture*;
   - the launcher entry's **desktop actions** (right-click the icon in
     Kickoff / the task manager);
   - the **global shortcuts** — the client binds `capture-full`,
     `capture-region`, `capture-window` through the GlobalShortcuts portal,
     proposing Meta+Alt+S / R / W; Plasma asks you to approve them the first
     time and lists them under *System Settings → Keyboard → Shortcuts →
     snapping-turtle*. Measured on Plasma 6.7: the proposals are recorded as
     the *defaults* (`kglobalshortcutsrc` shows `none,Meta+Alt+S,…`) and may
     stay unassigned until you accept them there — press **Defaults** or set
     your own keys; the client logs each binding as "(unassigned)" until then;
   - the command line — `snapping-turtle --capture full|region|window`
     (forwarded to the resident instance when one runs, run inline otherwise).

   The PNG uploads to `POST /api/v1/captures` with the bearer token and a
   generated title (`Full screen 2026-09-03 21:43:04`), and the returned page
   opens through the OpenURI portal in your default browser. Success and
   failure arrive as desktop notifications; a **401** tells you to run
   `--configure` again with a fresh token.

`snapping-turtle --help` lists everything, including `--upload-file PATH`
for uploading an existing PNG.

## How capture works — per-mode findings on Plasma 6.7.4 (Fedora 44)

Two sanctioned APIs and nothing else: the **XDG Desktop Portal**
(`org.freedesktop.portal.Screenshot`, portable, consent handled by the
desktop) and, on KDE, **KWin's `org.kde.KWin.ScreenShot2`** (v5 here),
which offers genuinely distinct full-screen / window / interactive captures
and streams raw pixels over a pipe — nothing touches the disk. No custom
overlays, no grim/slurp (PLAN.md §17).

What the Plasma portal backend (xdg-desktop-portal-kde 6.7.4) actually
delivers, read from its source and exercised here:

- `Screenshot(interactive=false)` → KWin `CaptureWorkspace`: **every output
  stitched** into one image, saved to **`~/Pictures/Screenshot_<yyyyMMdd_hhmmss>.png`**
  (`QStandardPaths::PicturesLocation`), the `file://` URI returned. The
  portal frontend (xdg-desktop-portal 1.22) gates this behind the
  `screenshot` permission: the first non-interactive request for an app id
  shows *"Allow snapping-turtle to Take Screenshots?"* and remembers the
  answer in the permission store; later requests are silent.
- `Screenshot(interactive=true)` → the KDE **chooser dialog**: a list of
  *Full Screen / Current Screen / Active Window*, *include cursor* and
  *include window borders* toggles, a live preview and a Share button. **No
  rectangular region.** Interactive requests never show the permission
  prompt — the dialog is the consent.

KWin's ScreenShot2 authorises by executable, not by dialog: it resolves the
caller's `/proc/<pid>/exe` and looks for an installed desktop file whose
`Exec` names that path and carries
`X-KDE-DBUS-Restricted-Interfaces=org.kde.KWin.ScreenShot2`
(`packaging/snapping-turtle.desktop`, comment inside). A binary at any other
path is refused (`…Error.NoAuthorized`) and the client falls back to the
portal — a development build behaves like the portal-only case until you
drop a desktop file pointing at it into `~/.local/share/applications/`.

| Mode | On Plasma (ScreenShot2 present) | Why | Elsewhere (portal only) |
| --- | --- | --- | --- |
| **Full screen** | KWin `CaptureActiveScreen`: the output that holds the active window, native resolution, cursor excluded, **no dialog**. Measured here: 5120×1440, QImage format 6 (ARGB32 premultiplied), stride 20480, converted and PNG-encoded in-process. | The portal's non-interactive capture on Plasma is the whole workspace — a three-monitor desk exceeds the server's 10,000 px width cap (§12) — and it writes a file under `~/Pictures` plus a first-use permission prompt. | `Screenshot(interactive=false)` — GNOME Shell captures all outputs silently after its one-time grant. |
| **Window** | KWin `CaptureInteractive(kind=window)`: KWin shows *"Select window to screen shot with left click or enter. Escape or right click to cancel."*, the crosshair picks any window; decorations included, shadow excluded. | The portal chooser's *Active Window* is whichever window had focus when the chooser opened — from the tray that is often the wrong one; the crosshair is unambiguous and works from a shortcut too. | `Screenshot(interactive=true)` — the compositor's chooser (GNOME's has window mode). |
| **Region** | Portal `Screenshot(interactive=true)`: the compositor's own chooser — on Plasma 6.7 the dialog above (full / current screen / active window, cursor/borders, preview), **without a rectangle**. | Neither sanctioned API has a rectangle picker on Plasma 6.7: KWin's `CaptureArea` takes coordinates, `CaptureInteractive` knows only window and screen kinds, and the KDE portal dialog has no region entry. Building an overlay is out of scope by design and delegating to Spectacle would be a third API (§17). The action stays wired to the path that *does* give a rectangle on GNOME and will on Plasma the day the KDE backend adds one — no client change needed. | `Screenshot(interactive=true)` — GNOME's shell UI offers area selection. |

Which API served a capture is in the log line (`uploaded via
kwin:CaptureActiveScreen: https://host:28443/s/AbCdEfGh…`) and in the tray
tooltip.

## File hygiene

The KWin path never creates a file. The portal path does — the KDE backend
saves every portal screenshot to `~/Pictures/Screenshot_<timestamp>.png`
whether or not the caller wants a file. The client reads that file, uploads
it, and removes **exactly the path the portal returned**, only if it is a
regular `.png` modified no earlier than the request started; anything your
own screenshot tool saved before (Spectacle's copies live in
`~/Pictures/Screenshots/` by default and are older) fails that test and is
left alone. `-v` prints where the file landed and whether it was removed.
The ten-capture check is in TESTING.md.

## Identity, permissions and where things live

- **App id.** One reverse-DNS id (`CLIENT_APP_ID` in deploy/.env, baked in at
  build; `snapping-turtle --print-app-id` shows it) names the desktop file,
  the resident DBus name, the notification source and the autostart entry,
  and is what the client registers with the portal on startup
  (`org.freedesktop.host.portal.Registry`). The portal keys every remembered
  grant on it — screenshot permission, shortcut bindings, background — so it
  must be one value everywhere and must never change after the first install
  (`src/app_id.rs`).
- **Config:** `$XDG_CONFIG_HOME/snapping-turtle/config.json` (0700 dir).
  **Token:** keyring item labelled `<app id> API token`, or
  `~/.config/snapping-turtle/token` (0600). **Logs:** stderr only; the token
  and capture URLs appear as 8-character prefixes, never in full
  (CLAUDE.md rule 3 — `--print-url` is the one explicit exception, on stdout,
  for scripting).
- **Tray:** a StatusNotifierItem, native on Plasma. On GNOME it needs the
  AppIndicator extension; without it the desktop actions and global
  shortcuts still work (not verified this milestone — PLAN.md §17).
- **Single instance:** the resident process owns the DBus name `<app id>`;
  a second launch or a desktop action forwards its request to it.

## Autostart

`--configure` offers start-at-login (default yes for a tray app). It goes
through the Background portal, which for a host application writes
`~/.config/autostart/<app id>.desktop` itself (removed again on disable);
if the portal cannot, the client writes the same entry directly. Turn it
off any time:

```sh
snapping-turtle --autostart off      # or delete ~/.config/autostart/<app id>.desktop
```

## Size and format limits

The client refuses locally what the server would refuse: PNGs over
`MAX_UPLOAD_MB` (30 MB) and images wider than 10,000 px or taller than
32,000 px. The constants mirror `shared/src/constants.ts`; `cargo test`
reads that file and fails if they drift (`src/contract.rs`).

## Troubleshooting

- **Full screen or window silently uses the portal (a dialog or a
  whole-workspace image where none was expected).** KWin refused the binary:
  `-v` shows `KWin refused this binary`. The installed desktop file's `Exec`
  must be the real path of the running binary (`/usr/bin/snapping-turtle`
  from the RPM) — see "How capture works".
- **Every portal call hangs (also for other apps).** A portal dialog that
  was left unanswered while the app that asked for it went away wedges
  xdg-desktop-portal 1.22 until the dialog is dismissed (observed here when a
  probe was killed with the first-use screenshot prompt open). Dismiss the
  dialog, or close the stale request from a terminal:
  `busctl --user tree org.freedesktop.impl.portal.desktop.kde | grep request/`
  then `busctl --user call org.freedesktop.impl.portal.desktop.kde <that path> org.freedesktop.impl.portal.Request Close`.
  Never kill the client while one of its prompts is open; cancel the prompt
  instead.
- **"already running"** — the tray icon belongs to another instance; use it,
  or `busctl --user call <app id> /<app id with slashes> org.snappingturtle.Control1 Quit`.

## Development

```sh
cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked && cargo build --release --locked
DATABASE_URL=postgres://… scripts/integration.sh   # real server + client upload + row/page assertions (CI runs it)
SNAPPING_TURTLE_DEBUG=1 snapping-turtle --capture full      # or -v: which API, dimensions, portal file location
```

To exercise the KWin path from a build directory, install a desktop file that
names the binary:
`sed "s#^Exec=/usr/bin/snapping-turtle#Exec=$PWD/target/debug/snapping-turtle#" packaging/snapping-turtle.desktop > ~/.local/share/applications/$(target/debug/snapping-turtle --print-app-id).desktop`
(desktop actions in that copy point at `/usr/bin`; only the main `Exec` matters
to KWin). Remove it when done.
