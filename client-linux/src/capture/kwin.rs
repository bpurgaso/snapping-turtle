//! KDE-native capture through KWin's `org.kde.KWin.ScreenShot2` (PLAN.md
//! §15a). Authorisation is KWin's: it resolves the caller's `/proc/<pid>/exe`
//! to a desktop file whose `Exec` names that binary and requires
//! `X-KDE-DBUS-Restricted-Interfaces=org.kde.KWin.ScreenShot2` there
//! (kwin/src/utils/serviceutils.h) — no dialog, no permission store. A
//! binary run from a build directory is therefore refused with
//! `…Error.NoAuthorized` and the caller falls back to the portal.
//!
//! Every method takes a vardict of options and the write end of a pipe; the
//! reply carries `format`/`width`/`height`/`stride` and KWin streams the raw
//! pixels into the pipe afterwards, so nothing touches the disk.

use super::raw_image::{encode_png, RawImage};
use std::collections::HashMap;
use std::io::Read;
use std::os::fd::{AsFd, FromRawFd, OwnedFd};
use zbus::zvariant::{Fd, OwnedValue, Value};

pub const SERVICE: &str = "org.kde.KWin.ScreenShot2";
pub const PATH: &str = "/org/kde/KWin/ScreenShot2";
pub const INTERFACE: &str = "org.kde.KWin.ScreenShot2";

const ERR_NOT_AUTHORIZED: &str = "org.kde.KWin.ScreenShot2.Error.NoAuthorized";
const ERR_CANCELLED: &str = "org.kde.KWin.ScreenShot2.Error.Cancelled";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Request {
    /// The screen that has the active window / pointer — `CaptureActiveScreen`.
    ActiveScreen,
    /// Crosshair: click a window — `CaptureInteractive(kind=0)`.
    PickWindow,
}

impl Request {
    pub fn api_name(self) -> &'static str {
        match self {
            Request::ActiveScreen => "kwin:CaptureActiveScreen",
            Request::PickWindow => "kwin:CaptureInteractive(window)",
        }
    }
}

#[derive(Debug)]
pub enum KwinError {
    /// KWin's ScreenShot2 is not on the bus (not a Plasma session).
    Unavailable,
    /// Our executable is not named by an installed desktop file with the annotation.
    NotAuthorized,
    /// The user pressed Escape / right-clicked in the interactive picker.
    Cancelled,
    Other(String),
}

impl std::fmt::Display for KwinError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KwinError::Unavailable => write!(f, "KWin ScreenShot2 is not available on this session"),
            KwinError::NotAuthorized => write!(f, "KWin refused: this binary is not authorised for ScreenShot2 (install the desktop file)"),
            KwinError::Cancelled => write!(f, "capture cancelled"),
            KwinError::Other(m) => write!(f, "KWin ScreenShot2: {m}"),
        }
    }
}

pub async fn available(conn: &zbus::Connection) -> bool {
    match zbus::fdo::DBusProxy::new(conn).await {
        Ok(dbus) => matches!(
            dbus.name_has_owner(zbus::names::BusName::try_from(SERVICE).expect("static name"))
                .await,
            Ok(true)
        ),
        Err(_) => false,
    }
}

fn pipe() -> Result<(OwnedFd, OwnedFd), KwinError> {
    let mut fds = [-1i32; 2];
    // SAFETY: pipe2 fills the two-element array; both ends are owned below.
    let rc = unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) };
    if rc != 0 {
        return Err(KwinError::Other(format!(
            "pipe2: {}",
            std::io::Error::last_os_error()
        )));
    }
    // SAFETY: fresh descriptors from pipe2, each owned exactly once.
    Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
}

fn get_u32(map: &HashMap<String, OwnedValue>, key: &str) -> Option<u32> {
    let v = map.get(key)?;
    match &**v {
        Value::U32(n) => Some(*n),
        Value::I32(n) => u32::try_from(*n).ok(),
        Value::U64(n) => u32::try_from(*n).ok(),
        Value::I64(n) => u32::try_from(*n).ok(),
        _ => None,
    }
}

fn map_error(e: zbus::Error) -> KwinError {
    match &e {
        zbus::Error::MethodError(name, _, _) => match name.as_str() {
            ERR_NOT_AUTHORIZED => KwinError::NotAuthorized,
            ERR_CANCELLED => KwinError::Cancelled,
            "org.freedesktop.DBus.Error.ServiceUnknown"
            | "org.freedesktop.DBus.Error.NameHasNoOwner" => KwinError::Unavailable,
            _ => KwinError::Other(e.to_string()),
        },
        _ => KwinError::Other(e.to_string()),
    }
}

/// Take the screenshot and return PNG bytes. `include_decoration` matters
/// only for window captures.
pub async fn capture(conn: &zbus::Connection, req: Request) -> Result<Vec<u8>, KwinError> {
    let proxy = zbus::Proxy::new(conn, SERVICE, PATH, INTERFACE)
        .await
        .map_err(map_error)?;
    let mut options: HashMap<&str, Value<'_>> = HashMap::new();
    // Native pixels, no cursor; decorations on, shadows off for a clean window crop.
    options.insert("native-resolution", Value::Bool(true));
    options.insert("include-cursor", Value::Bool(false));
    options.insert("include-decoration", Value::Bool(true));
    options.insert("include-shadow", Value::Bool(false));

    let (read_end, write_end) = pipe()?;
    let reply = match req {
        Request::ActiveScreen => {
            proxy
                .call_method(
                    "CaptureActiveScreen",
                    &(options, Fd::from(write_end.as_fd())),
                )
                .await
        }
        Request::PickWindow => {
            proxy
                .call_method(
                    "CaptureInteractive",
                    &(0u32, options, Fd::from(write_end.as_fd())),
                )
                .await
        }
    }
    .map_err(map_error)?;
    // KWin dup'd the fd for its writer thread; our copy must close so the reader sees EOF.
    drop(write_end);

    let meta: HashMap<String, OwnedValue> = reply
        .body()
        .deserialize()
        .map_err(|e| KwinError::Other(e.to_string()))?;
    let width =
        get_u32(&meta, "width").ok_or_else(|| KwinError::Other("reply lacks width".into()))?;
    let height =
        get_u32(&meta, "height").ok_or_else(|| KwinError::Other("reply lacks height".into()))?;
    let stride =
        get_u32(&meta, "stride").ok_or_else(|| KwinError::Other("reply lacks stride".into()))?;
    let format =
        get_u32(&meta, "format").ok_or_else(|| KwinError::Other("reply lacks format".into()))?;
    crate::logx::debug(format!(
        "kwin reply: {width}x{height} stride {stride} format {format}"
    ));
    let expected = stride as usize * height as usize;
    if expected == 0 || expected > 4 * 1024 * 1024 * 1024 {
        return Err(KwinError::Other(format!(
            "implausible image size {width}x{height} stride {stride}"
        )));
    }

    let mut file = std::fs::File::from(read_end);
    let data = tokio::task::spawn_blocking(move || {
        let mut buf = Vec::with_capacity(expected);
        file.read_to_end(&mut buf).map(|_| buf)
    })
    .await
    .map_err(|e| KwinError::Other(e.to_string()))?
    .map_err(|e| KwinError::Other(format!("reading KWin's pixel pipe: {e}")))?;
    if data.len() < expected {
        return Err(KwinError::Other(format!(
            "KWin sent {} of {expected} pixel bytes",
            data.len()
        )));
    }

    let raw = RawImage {
        width,
        height,
        stride,
        format,
        data,
    };
    let rgba = tokio::task::spawn_blocking(move || {
        raw.to_rgba8()
            .and_then(|rgba| encode_png(width, height, &rgba))
    })
    .await
    .map_err(|e| KwinError::Other(e.to_string()))?
    .map_err(KwinError::Other)?;
    Ok(rgba)
}
