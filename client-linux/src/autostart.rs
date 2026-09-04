//! "Start at login" as a choice (PLAN.md §15a): the Background portal's
//! autostart request. For a host app xdg-desktop-portal writes
//! `~/.config/autostart/<APP_ID>.desktop` itself (background.c,
//! `enable_autostart_sync`) and removes it on `autostart=false`; that only
//! works once the portal knows our app id (the Registry call at startup).
//! If the portal cannot do it, the same file is written or removed directly.

use crate::app_id::{APP_ID, PRODUCT_NAME};
use ashpd::desktop::background::Background;
use std::path::PathBuf;

pub fn autostart_path() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".config")
        });
    base.join("autostart").join(format!("{APP_ID}.desktop"))
}

pub fn autostart_entry() -> String {
    format!(
        "[Desktop Entry]\nType=Application\nName={PRODUCT_NAME}\nExec=snapping-turtle\nIcon={}\nX-XDP-Autostart={APP_ID}\nX-KDE-autostart-after=panel\n",
        crate::app_id::ICON_NAME
    )
}

#[derive(Debug, PartialEq, Eq)]
pub enum How {
    Portal,
    File,
}

pub async fn set(enabled: bool) -> Result<How, String> {
    let via_portal = async {
        let request = Background::request()
            .reason("Keeps the capture tray icon and global shortcuts available")
            .auto_start(enabled)
            .command(["snapping-turtle"])
            .dbus_activatable(false)
            .send()
            .await?;
        let response = request.response()?;
        Ok::<bool, ashpd::Error>(response.auto_start())
    }
    .await;
    match via_portal {
        Ok(state) if state == enabled => return Ok(How::Portal),
        Ok(_) => crate::logx::debug("background portal answered but did not apply the autostart choice; writing the entry directly"),
        Err(e) => crate::logx::debug(format!("background portal unavailable ({e}); writing the entry directly")),
    }
    let path = autostart_path();
    if enabled {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        }
        std::fs::write(&path, autostart_entry())
            .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    } else {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("cannot remove {}: {e}", path.display())),
        }
    }
    Ok(How::File)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_names_the_app_id_and_binary() {
        let e = autostart_entry();
        assert!(e.contains(&format!("X-XDP-Autostart={APP_ID}")));
        assert!(e.contains("Exec=snapping-turtle\n"));
        assert!(autostart_path().ends_with(format!("autostart/{APP_ID}.desktop")));
    }
}
