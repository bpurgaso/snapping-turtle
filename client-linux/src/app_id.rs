//! The one application identity (PLAN.md §15a).
//!
//! `APP_ID` is the reverse-DNS id this client presents everywhere: the
//! installed desktop file is `<APP_ID>.desktop`, the resident process owns
//! the DBus name `APP_ID`, `register_host_app(APP_ID)` tells the portal who
//! we are before the first portal call, notifications and the tray carry it,
//! and the autostart entry the Background portal writes is named by it.
//!
//! It has to be the *same* value in all of those places because the portal
//! persists permissions per app id: the remembered screenshot grant, the
//! global-shortcut bindings Plasma shows in its grants UI, the "run in
//! background" decision. A binary that registers one id while its desktop
//! file carries another gets prompted every time and its grants never stick.
//! It also has to be *permanent*: changing it after the first install
//! orphans every grant (the same rule as `EXTENSION_GECKO_ID`). It is derived
//! from the owner's domain once (`CLIENT_APP_ID` in deploy/.env, baked in by
//! build.rs), and never from the migratable `PUBLIC_HOST`.

/// Set by build.rs from `CLIENT_APP_ID`, or the development default.
pub const APP_ID: &str = env!("CLIENT_APP_ID");

/// Default server origin `--configure` proposes (build-time `PUBLIC_ORIGIN`), if any.
pub const DEFAULT_ORIGIN: Option<&str> = option_env!("PUBLIC_ORIGIN");

/// Human-facing product name (desktop file `Name`, notifications, tray tooltip).
pub const PRODUCT_NAME: &str = "snapping-turtle";

/// Icon name installed in the hicolor theme by the package.
pub const ICON_NAME: &str = "snapping-turtle";

/// DBus interface of the resident instance's control object (fixed; the bus
/// name and object path derive from `APP_ID`).
pub const CONTROL_INTERFACE: &str = "org.snappingturtle.Control1";

/// Object path derived from the app id (`/io/github/x/App` style), as GApplication does.
pub fn object_path() -> String {
    let mut path = String::from("/");
    path.push_str(&APP_ID.replace('.', "/").replace('-', "_"));
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_id_is_reverse_dns() {
        assert!(APP_ID.split('.').count() >= 2, "{APP_ID}");
        assert!(APP_ID
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-'));
    }

    #[test]
    fn object_path_is_a_valid_dbus_path() {
        let p = object_path();
        assert!(p.starts_with('/'));
        assert!(!p.contains('.'));
        assert!(!p.contains("//"));
        assert!(zbus::zvariant::ObjectPath::try_from(p.as_str()).is_ok());
    }
}
