//! Bakes the two build-time identities into the binary, mirroring how the
//! extension bakes its default origin (extension/scripts/lib/env.ts):
//!
//! - `CLIENT_APP_ID` — the reverse-DNS application id (see src/app_id.rs for
//!   why it must be one value everywhere and never change). Release builds
//!   set it from deploy/.env; a plain `cargo build` falls back to the
//!   development id below so the crate always builds and tests.
//! - `PUBLIC_ORIGIN` — the default server origin `--configure` proposes.
//!   Optional; without it `--configure` simply asks.

const DEV_APP_ID: &str = "io.github.bpurgaso.SnappingTurtle";

fn valid_app_id(id: &str) -> bool {
    // Reverse-DNS per the freedesktop rules ashpd enforces at runtime too:
    // ≥ 2 elements, each starting with a letter or underscore, [A-Za-z0-9_-].
    let parts: Vec<&str> = id.split('.').collect();
    parts.len() >= 2
        && id.len() <= 255
        && parts.iter().all(|p| {
            let mut chars = p.chars();
            matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
                && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        })
}

fn main() {
    println!("cargo:rerun-if-env-changed=CLIENT_APP_ID");
    println!("cargo:rerun-if-env-changed=PUBLIC_ORIGIN");
    let app_id = match std::env::var("CLIENT_APP_ID") {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => DEV_APP_ID.to_string(),
    };
    assert!(
        valid_app_id(&app_id),
        "CLIENT_APP_ID {app_id:?} is not a reverse-DNS application id (e.g. com.example.shots.SnappingTurtle)"
    );
    println!("cargo:rustc-env=CLIENT_APP_ID={app_id}");
    if let Ok(origin) = std::env::var("PUBLIC_ORIGIN") {
        let origin = origin.trim().trim_end_matches('/').to_string();
        if !origin.is_empty() {
            println!("cargo:rustc-env=PUBLIC_ORIGIN={origin}");
        }
    }
}
