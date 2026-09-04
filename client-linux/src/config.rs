//! The XDG config file: `$XDG_CONFIG_HOME/snapping-turtle/config.json`
//! (default `~/.config/snapping-turtle/config.json`). Holds the server origin
//! and *where* the token lives — never the token itself (see `secrets.rs`).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const DIR_NAME: &str = "snapping-turtle";
pub const FILE_NAME: &str = "config.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TokenStore {
    /// The Secret Service keyring (KWallet / GNOME Keyring via ksecretd or gnome-keyring).
    Keyring,
    /// A 0600 file next to the config, used when no Secret Service answers.
    File,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Config {
    /// `https://host:port`, no path, no trailing slash — the same shape the extension stores.
    pub origin: String,
    #[serde(rename = "tokenStore")]
    pub token_store: TokenStore,
    /// What the user chose at `--configure`; informational (the autostart
    /// entry itself lives in ~/.config/autostart, written by the portal).
    #[serde(default)]
    pub autostart: Option<bool>,
}

/// `$XDG_CONFIG_HOME/snapping-turtle`, or `~/.config/snapping-turtle`.
pub fn config_dir() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let home = std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_default();
            home.join(".config")
        });
    base.join(DIR_NAME)
}

pub fn config_path() -> PathBuf {
    config_dir().join(FILE_NAME)
}

pub fn load() -> Result<Option<Config>, String> {
    load_from(&config_path())
}

pub fn load_from(path: &Path) -> Result<Option<Config>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    let cfg: Config = serde_json::from_str(&text)
        .map_err(|e| format!("{} is not a valid config file: {e}", path.display()))?;
    normalize_origin(&cfg.origin).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(Some(cfg))
}

pub fn save(cfg: &Config) -> Result<PathBuf, String> {
    let path = config_path();
    save_to(cfg, &path)?;
    Ok(path)
}

pub fn save_to(cfg: &Config, path: &Path) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        crate::secrets::ensure_private_dir(dir)?;
    }
    let text = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(path, text + "\n").map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/// The extension's origin rule (extension/src/lib/origin.ts): http(s), a host,
/// an optional port, nothing else. Returns the canonical `scheme://host[:port]`.
pub fn normalize_origin(input: &str) -> Result<String, String> {
    let s = input.trim();
    let (scheme, rest) = if let Some(r) = s.strip_prefix("https://") {
        ("https", r)
    } else if let Some(r) = s.strip_prefix("http://") {
        ("http", r)
    } else {
        return Err(
            "the server address must start with https:// (or http:// for a local server)".into(),
        );
    };
    let rest = rest.trim_end_matches('/');
    if rest.is_empty() || rest.contains('/') || rest.contains('?') || rest.contains('#') {
        return Err(
            "the server address is just the origin, e.g. https://shots.example.com:28443 — no path"
                .into(),
        );
    }
    if rest.contains('@') {
        return Err("the server address must not contain credentials".into());
    }
    let (host, port) = match rest.rsplit_once(':') {
        Some((h, p)) if !h.contains(']') || h.ends_with(']') => (h, Some(p)),
        _ => (rest, None),
    };
    let host = host.to_ascii_lowercase();
    if host.is_empty() || host.chars().any(|c| c.is_whitespace()) {
        return Err("the server address needs a host name".into());
    }
    let mut out = format!("{scheme}://{host}");
    if let Some(p) = port {
        let n: u16 = p
            .parse()
            .map_err(|_| format!("{p:?} is not a valid port"))?;
        if n == 0 {
            return Err("port 0 is not valid".into());
        }
        let default = if scheme == "https" { 443 } else { 80 };
        if n != default {
            out.push(':');
            out.push_str(&n.to_string());
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_origins_like_the_extension() {
        assert_eq!(
            normalize_origin(" https://Shots.Example.com:28443/ ").unwrap(),
            "https://shots.example.com:28443"
        );
        assert_eq!(
            normalize_origin("https://shots.example.com:443").unwrap(),
            "https://shots.example.com"
        );
        assert_eq!(
            normalize_origin("http://localhost:3000").unwrap(),
            "http://localhost:3000"
        );
        assert!(normalize_origin("shots.example.com").is_err());
        assert!(normalize_origin("https://shots.example.com/s/abc").is_err());
        assert!(normalize_origin("https://user:pw@shots.example.com").is_err());
        assert!(normalize_origin("https://shots.example.com:99999").is_err());
        assert!(normalize_origin("https://").is_err());
    }

    #[test]
    fn config_round_trips_and_rejects_garbage() {
        let dir = std::env::temp_dir().join(format!("st-config-test-{}", std::process::id()));
        let path = dir.join("config.json");
        let cfg = Config {
            origin: "https://shots.test:28443".into(),
            token_store: TokenStore::File,
            autostart: Some(true),
        };
        save_to(&cfg, &path).unwrap();
        assert_eq!(load_from(&path).unwrap(), Some(cfg));
        std::fs::write(&path, "{\"origin\": \"nope\", \"tokenStore\": \"file\"}").unwrap();
        assert!(load_from(&path).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(load_from(&path).unwrap(), None);
    }
}
