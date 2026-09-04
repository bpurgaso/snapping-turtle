//! Mode → API plan (PLAN.md §15a; findings in client-linux/README.md).
//!
//! | Mode   | Plasma (KWin ScreenShot2 present)                 | Elsewhere (portal only)         |
//! |--------|---------------------------------------------------|---------------------------------|
//! | Full   | `CaptureActiveScreen`, native px, no dialog       | `Screenshot(interactive=false)` |
//! | Window | `CaptureInteractive(window)`: click a window      | `Screenshot(interactive=true)`  |
//! | Region | `Screenshot(interactive=true)` — the compositor's | `Screenshot(interactive=true)`  |
//! |        | own chooser (on Plasma 6.7: full / current screen |                                 |
//! |        | / active window; no rectangle — see README)       |                                 |
//!
//! KWin refusing us (`NoAuthorized`: binary not named by an installed desktop
//! file) falls back to the portal so a development build still captures.

pub mod kwin;
pub mod portal;
pub mod raw_image;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Full,
    Region,
    Window,
}

impl Mode {
    pub const ALL: [Mode; 3] = [Mode::Full, Mode::Region, Mode::Window];

    pub fn parse(s: &str) -> Option<Mode> {
        match s.trim().to_ascii_lowercase().as_str() {
            "full" | "screen" | "full-screen" | "fullscreen" => Some(Mode::Full),
            "region" | "area" => Some(Mode::Region),
            "window" => Some(Mode::Window),
            _ => None,
        }
    }

    /// CLI / DBus / shortcut-id spelling.
    pub fn id(self) -> &'static str {
        match self {
            Mode::Full => "full",
            Mode::Region => "region",
            Mode::Window => "window",
        }
    }

    /// Title prefix and menu wording.
    pub fn label(self) -> &'static str {
        match self {
            Mode::Full => "Full screen",
            Mode::Region => "Region",
            Mode::Window => "Window",
        }
    }

    pub fn menu_label(self) -> &'static str {
        match self {
            Mode::Full => "Capture full screen",
            Mode::Region => "Capture region…",
            Mode::Window => "Capture window…",
        }
    }

    pub fn shortcut_id(self) -> String {
        format!("capture-{}", self.id())
    }

    pub fn shortcut_description(self) -> &'static str {
        match self {
            Mode::Full => "Capture the active screen and upload it",
            Mode::Region => "Choose what to capture and upload it",
            Mode::Window => "Pick a window to capture and upload",
        }
    }

    /// XDG shortcut trigger the GlobalShortcuts portal is asked for; the
    /// desktop's grants UI lets the user change it.
    pub fn preferred_trigger(self) -> &'static str {
        match self {
            Mode::Full => "LOGO+ALT+s",
            Mode::Region => "LOGO+ALT+r",
            Mode::Window => "LOGO+ALT+w",
        }
    }
}

pub struct Captured {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// Which API produced it (for the log line and the tray tooltip).
    pub api: &'static str,
}

#[derive(Debug)]
pub enum CaptureError {
    Cancelled,
    Failed(String),
}

impl std::fmt::Display for CaptureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CaptureError::Cancelled => write!(f, "capture cancelled"),
            CaptureError::Failed(m) => write!(f, "{m}"),
        }
    }
}

fn finish(png: Vec<u8>, api: &'static str) -> Result<Captured, CaptureError> {
    let (width, height) = raw_image::png_dimensions(&png)
        .map_err(|e| CaptureError::Failed(format!("{api} returned no readable PNG: {e}")))?;
    raw_image::check_dimensions(width, height).map_err(CaptureError::Failed)?;
    Ok(Captured {
        png,
        width,
        height,
        api,
    })
}

async fn via_portal(interactive: bool) -> Result<Captured, CaptureError> {
    match portal::screenshot(interactive).await {
        Ok(shot) => finish(shot.png, portal::api_name(interactive)),
        Err(portal::PortalError::Cancelled) => Err(CaptureError::Cancelled),
        Err(e) => Err(CaptureError::Failed(e.to_string())),
    }
}

async fn via_kwin_or_portal(
    conn: &zbus::Connection,
    req: kwin::Request,
    portal_interactive: bool,
) -> Result<Captured, CaptureError> {
    if kwin::available(conn).await {
        match kwin::capture(conn, req).await {
            Ok(png) => return finish(png, req.api_name()),
            Err(kwin::KwinError::Cancelled) => return Err(CaptureError::Cancelled),
            Err(kwin::KwinError::NotAuthorized) => {
                crate::logx::warn(format!("{}: KWin refused this binary (no installed desktop file names it); using the portal", req.api_name()));
            }
            Err(e) => {
                crate::logx::warn(format!("{}: {e}; using the portal", req.api_name()));
            }
        }
    }
    via_portal(portal_interactive).await
}

pub async fn capture(conn: &zbus::Connection, mode: Mode) -> Result<Captured, CaptureError> {
    match mode {
        Mode::Full => via_kwin_or_portal(conn, kwin::Request::ActiveScreen, false).await,
        Mode::Window => via_kwin_or_portal(conn, kwin::Request::PickWindow, true).await,
        Mode::Region => via_portal(true).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mode_spellings() {
        assert_eq!(Mode::parse("full"), Some(Mode::Full));
        assert_eq!(Mode::parse(" Window "), Some(Mode::Window));
        assert_eq!(Mode::parse("area"), Some(Mode::Region));
        assert_eq!(Mode::parse("nope"), None);
        for m in Mode::ALL {
            assert_eq!(Mode::parse(m.id()), Some(m));
            assert!(m.shortcut_id().starts_with("capture-"));
        }
    }
}
