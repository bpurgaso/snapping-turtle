//! Single instance + control interface. The resident process owns the bus
//! name `APP_ID`; desktop actions and a second launch forward their capture
//! request to it over `org.snappingturtle.Control1` so the tray, the
//! global-shortcut session and the "busy" gate live in one process.

use crate::app_id::{object_path, APP_ID, CONTROL_INTERFACE};
use crate::capture::Mode;
use tokio::sync::mpsc::UnboundedSender;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Capture(Mode),
    OpenLast,
    Quit,
}

pub struct Control {
    tx: UnboundedSender<Command>,
}

#[zbus::interface(name = "org.snappingturtle.Control1")]
impl Control {
    /// Start a capture: `full`, `region` or `window`.
    async fn capture(&self, mode: &str) -> zbus::fdo::Result<()> {
        let mode = Mode::parse(mode)
            .ok_or_else(|| zbus::fdo::Error::InvalidArgs(format!("unknown mode {mode:?}")))?;
        self.tx
            .send(Command::Capture(mode))
            .map_err(|_| zbus::fdo::Error::Failed("shutting down".into()))
    }

    async fn quit(&self) -> zbus::fdo::Result<()> {
        self.tx
            .send(Command::Quit)
            .map_err(|_| zbus::fdo::Error::Failed("shutting down".into()))
    }
}

pub enum Serve {
    Owned(zbus::Connection),
    AlreadyRunning,
}

/// Own the name and serve the control object, or report a running instance.
///
/// The name is requested explicitly with `DoNotQueue` and the reply is
/// matched: zbus's builder-level `.name()` queues behind an existing owner
/// (measured on zbus 5.19: a second instance came up believing it owned the
/// name and took it when the first released it), which is exactly the
/// two-tray-icons situation this guards against.
pub async fn serve(tx: UnboundedSender<Command>) -> Result<Serve, String> {
    use zbus::fdo::{RequestNameFlags, RequestNameReply};
    let conn = zbus::connection::Builder::session()
        .map_err(|e| e.to_string())?
        .serve_at(object_path(), Control { tx })
        .map_err(|e| e.to_string())?
        .build()
        .await
        .map_err(|e| format!("session bus: {e}"))?;
    let name = zbus::names::WellKnownName::try_from(APP_ID).map_err(|e| e.to_string())?;
    match conn
        .request_name_with_flags(name, RequestNameFlags::DoNotQueue.into())
        .await
    {
        Ok(RequestNameReply::PrimaryOwner) => Ok(Serve::Owned(conn)),
        Ok(RequestNameReply::Exists) | Ok(RequestNameReply::InQueue) => Ok(Serve::AlreadyRunning),
        Ok(RequestNameReply::AlreadyOwner) => Ok(Serve::Owned(conn)),
        Err(zbus::Error::NameTaken) => Ok(Serve::AlreadyRunning),
        Err(e) => Err(format!("requesting the bus name {APP_ID}: {e}")),
    }
}

/// Ask a running instance to capture. `Ok(false)` = no instance owns the name.
pub async fn forward(conn: &zbus::Connection, mode: Mode) -> Result<bool, String> {
    let proxy = zbus::Proxy::new(conn, APP_ID, object_path(), CONTROL_INTERFACE)
        .await
        .map_err(|e| e.to_string())?;
    match proxy.call_method("Capture", &(mode.id(),)).await {
        Ok(_) => Ok(true),
        Err(zbus::Error::MethodError(name, _, _))
            if matches!(
                name.as_str(),
                "org.freedesktop.DBus.Error.ServiceUnknown"
                    | "org.freedesktop.DBus.Error.NameHasNoOwner"
            ) =>
        {
            Ok(false)
        }
        Err(e) => Err(format!("forwarding to the running instance: {e}")),
    }
}
