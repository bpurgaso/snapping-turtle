//! Where the API token lives (PLAN.md §15a): the Secret Service keyring when
//! one answers on the bus (Plasma's ksecretd / KWallet, GNOME Keyring), else
//! a 0600 file inside the 0700 config directory. The token is never written
//! to the config file, never logged, never echoed (CLAUDE.md rule 3).

use crate::app_id::APP_ID;
use crate::config::{config_dir, TokenStore};
use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

const TOKEN_FILE: &str = "token";

fn attributes() -> HashMap<&'static str, &'static str> {
    HashMap::from([("application", APP_ID), ("purpose", "api-token")])
}

/// Is a Secret Service reachable? Decides the default store at `--configure`.
pub async fn keyring_available() -> bool {
    oo7::Keyring::new().await.is_ok()
}

pub async fn store(kind: TokenStore, token: &str) -> Result<(), String> {
    match kind {
        TokenStore::Keyring => {
            let keyring = oo7::Keyring::new()
                .await
                .map_err(|e| format!("keyring unavailable: {e}"))?;
            keyring
                .unlock()
                .await
                .map_err(|e| format!("keyring locked: {e}"))?;
            keyring
                .create_item(&format!("{APP_ID} API token"), &attributes(), token, true)
                .await
                .map_err(|e| format!("could not store the token in the keyring: {e}"))?;
            // A stale file copy from an earlier choice must not outlive the switch.
            let _ = std::fs::remove_file(token_path(&config_dir()));
            Ok(())
        }
        TokenStore::File => write_token_file(&token_path(&config_dir()), token),
    }
}

pub async fn load(kind: TokenStore) -> Result<Option<String>, String> {
    match kind {
        TokenStore::Keyring => {
            let keyring = oo7::Keyring::new()
                .await
                .map_err(|e| format!("keyring unavailable: {e}"))?;
            keyring
                .unlock()
                .await
                .map_err(|e| format!("keyring locked: {e}"))?;
            let items = keyring
                .search_items(&attributes())
                .await
                .map_err(|e| format!("keyring lookup failed: {e}"))?;
            let Some(item) = items.first() else {
                return Ok(None);
            };
            let secret = item
                .secret()
                .await
                .map_err(|e| format!("keyring read failed: {e}"))?;
            let text = std::str::from_utf8(secret.as_bytes())
                .map_err(|_| "the stored token is not valid text".to_string())?
                .trim()
                .to_string();
            Ok(if text.is_empty() { None } else { Some(text) })
        }
        TokenStore::File => read_token_file(&token_path(&config_dir())),
    }
}

pub async fn delete(kind: TokenStore) -> Result<(), String> {
    match kind {
        TokenStore::Keyring => {
            let keyring = oo7::Keyring::new()
                .await
                .map_err(|e| format!("keyring unavailable: {e}"))?;
            keyring
                .delete(&attributes())
                .await
                .map_err(|e| format!("keyring delete failed: {e}"))
        }
        TokenStore::File => match std::fs::remove_file(token_path(&config_dir())) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        },
    }
}

pub fn token_path(dir: &Path) -> PathBuf {
    dir.join(TOKEN_FILE)
}

/// Creates the directory 0700 (and tightens an existing one).
pub fn ensure_private_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("cannot chmod {}: {e}", dir.display()))
}

pub fn write_token_file(path: &Path, token: &str) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(dir) = path.parent() {
        ensure_private_dir(dir)?;
    }
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    f.set_permissions(std::fs::Permissions::from_mode(0o600))
        .map_err(|e| e.to_string())?;
    f.write_all(token.as_bytes()).map_err(|e| e.to_string())?;
    f.write_all(b"\n").map_err(|e| e.to_string())
}

pub fn read_token_file(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(t) => {
            let t = t.trim().to_string();
            Ok(if t.is_empty() { None } else { Some(t) })
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_file_is_private_and_round_trips() {
        let dir = std::env::temp_dir().join(format!("st-secrets-test-{}", std::process::id()));
        let path = token_path(&dir);
        write_token_file(&path, "st_not-a-real-token-0123456789").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let dmode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(dmode, 0o700);
        assert_eq!(
            read_token_file(&path).unwrap().as_deref(),
            Some("st_not-a-real-token-0123456789")
        );
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(read_token_file(&path).unwrap(), None);
    }
}
