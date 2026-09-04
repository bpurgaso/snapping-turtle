//! The portable path: `org.freedesktop.portal.Screenshot` through ashpd.
//! Consent is the portal frontend's (an access dialog the first time for an
//! app with a known id, remembered in the permission store); the
//! backend decides what the user gets — on Plasma 6.7 see the README's
//! per-mode table. The portal returns a `file://` URI; on Fedora 44 / Plasma
//! the KDE backend writes `~/Pictures/Screenshot_<timestamp>.png` (measured,
//! see README "File hygiene"), so we read it and remove exactly that file.

use ashpd::desktop::screenshot::Screenshot;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

#[derive(Debug)]
pub enum PortalError {
    Cancelled,
    Unavailable(String),
    Other(String),
}

impl std::fmt::Display for PortalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PortalError::Cancelled => write!(f, "capture cancelled"),
            PortalError::Unavailable(m) => write!(f, "the screenshot portal is not available: {m}"),
            PortalError::Other(m) => write!(f, "screenshot portal: {m}"),
        }
    }
}

pub struct PortalShot {
    pub png: Vec<u8>,
}

pub fn api_name(interactive: bool) -> &'static str {
    if interactive {
        "portal:Screenshot(interactive)"
    } else {
        "portal:Screenshot"
    }
}

/// `file:///home/u/Pictures/Screenshot_2026%2D09%2D03.png` → the path.
pub fn file_uri_to_path(uri: &str) -> Option<PathBuf> {
    let rest = uri.strip_prefix("file://")?;
    // An authority component (file://host/…) is not something a local portal produces.
    let path = if rest.starts_with('/') {
        rest
    } else {
        return None;
    };
    let path = path.split(['?', '#']).next()?;
    let mut bytes = Vec::with_capacity(path.len());
    let raw = path.as_bytes();
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'%' && i + 2 < raw.len() {
            let hex = std::str::from_utf8(&raw[i + 1..i + 3]).ok()?;
            bytes.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            bytes.push(raw[i]);
            i += 1;
        }
    }
    use std::os::unix::ffi::OsStringExt;
    Some(PathBuf::from(std::ffi::OsString::from_vec(bytes)))
}

/// Remove the portal's file only when it is unmistakably the one just made
/// for us: a regular `.png`, modified no earlier than our request started.
/// Anything the user's own screenshot settings saved earlier fails the
/// timestamp test and is left alone.
pub fn cleanup_portal_file(path: &Path, started: SystemTime) -> Result<bool, String> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.to_string()),
    };
    if !meta.is_file() {
        return Ok(false);
    }
    if path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("png"))
        != Some(true)
    {
        return Ok(false);
    }
    let modified = meta.modified().map_err(|e| e.to_string())?;
    // Filesystem timestamps can be coarser than our clock; allow 2 s of slack.
    if modified + Duration::from_secs(2) < started {
        return Ok(false);
    }
    std::fs::remove_file(path).map_err(|e| e.to_string())?;
    Ok(true)
}

pub async fn screenshot(interactive: bool) -> Result<PortalShot, PortalError> {
    let started = SystemTime::now();
    let request = Screenshot::request()
        .interactive(interactive)
        .modal(true)
        .send()
        .await
        .map_err(map_error)?;
    let shot = request.response().map_err(map_error)?;
    let uri = shot.uri().as_str().to_string();
    let path = file_uri_to_path(&uri).ok_or_else(|| {
        PortalError::Other(format!(
            "unexpected screenshot URI scheme in {}",
            scheme_of(&uri)
        ))
    })?;
    let png = std::fs::read(&path)
        .map_err(|e| PortalError::Other(format!("reading {}: {e}", path.display())))?;
    let removed = match cleanup_portal_file(&path, started) {
        Ok(r) => r,
        Err(e) => {
            crate::logx::warn(format!(
                "could not remove the portal's file {}: {e}",
                path.display()
            ));
            false
        }
    };
    crate::logx::debug(format!(
        "portal file {} ({} bytes){}",
        path.display(),
        png.len(),
        if removed {
            ", removed"
        } else {
            ", left in place"
        }
    ));
    Ok(PortalShot { png })
}

fn scheme_of(uri: &str) -> String {
    uri.split(':').next().unwrap_or("").to_string()
}

fn map_error(e: ashpd::Error) -> PortalError {
    match e {
        ashpd::Error::Response(ashpd::desktop::ResponseError::Cancelled) => PortalError::Cancelled,
        // The frontend answers "other" (no detail) when the screenshot permission
        // is denied — including a remembered Deny from the first-use prompt.
        ashpd::Error::Response(ashpd::desktop::ResponseError::Other) => PortalError::Other(
            "the desktop refused the screenshot. If you denied the first-use prompt, the answer is remembered per app: reset it under System Settings → Apps & Windows → Application Permissions (or `flatpak permission-remove screenshot screenshot <app id>`) and try again"
                .into(),
        ),
        ashpd::Error::PortalNotFound(n) => PortalError::Unavailable(n.to_string()),
        other => PortalError::Other(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_file_uris() {
        assert_eq!(
            file_uri_to_path("file:///home/u/Pictures/Screenshot_20260903_211405.png").unwrap(),
            PathBuf::from("/home/u/Pictures/Screenshot_20260903_211405.png")
        );
        assert_eq!(
            file_uri_to_path("file:///tmp/a%20b%2Fc.png").unwrap(),
            PathBuf::from("/tmp/a b/c.png")
        );
        assert!(file_uri_to_path("https://example.com/x.png").is_none());
        assert!(file_uri_to_path("file://host/x.png").is_none());
    }

    #[test]
    fn cleanup_removes_only_our_fresh_png() {
        let dir = std::env::temp_dir().join(format!("st-portal-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let ours = dir.join("Screenshot_new.png");
        let started = SystemTime::now();
        std::fs::write(&ours, b"png").unwrap();
        assert!(cleanup_portal_file(&ours, started).unwrap());
        assert!(!ours.exists());
        // An older file with the same shape is left alone.
        let old = dir.join("Screenshot_old.png");
        std::fs::write(&old, b"png").unwrap();
        assert!(!cleanup_portal_file(&old, SystemTime::now() + Duration::from_secs(60)).unwrap());
        assert!(old.exists());
        // Not a PNG, not a file: left alone.
        let txt = dir.join("notes.txt");
        std::fs::write(&txt, b"x").unwrap();
        assert!(!cleanup_portal_file(&txt, started).unwrap());
        assert!(!cleanup_portal_file(&dir, started).unwrap());
        assert!(!cleanup_portal_file(&dir.join("missing.png"), started).unwrap());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
