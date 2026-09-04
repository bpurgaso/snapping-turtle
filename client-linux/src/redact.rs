//! Secret redaction (CLAUDE.md rule 3): API tokens and capture-page URLs
//! appear in logs, error output and notifications only as an 8-character
//! prefix. The constant mirrors `SECRET_LOG_PREFIX_CHARS` in
//! shared/src/constants.ts (a test in `contract.rs` checks the two agree).

pub const SECRET_LOG_PREFIX_CHARS: usize = 8;

/// `st_AbCdEf…` — the first eight characters and an ellipsis.
pub fn prefix(secret: &str) -> String {
    let mut out: String = secret.chars().take(SECRET_LOG_PREFIX_CHARS).collect();
    if secret.chars().count() > SECRET_LOG_PREFIX_CHARS {
        out.push('…');
    }
    out
}

/// A capture-page or image URL with the capability id cut to its prefix:
/// `https://host:28443/s/AbCdEfGh…`. Anything unexpected collapses to the
/// origin alone, never the full path.
pub fn url(full: &str) -> String {
    let Some(scheme_end) = full.find("://") else {
        return prefix(full);
    };
    let after = &full[scheme_end + 3..];
    let host_end = after.find('/').unwrap_or(after.len());
    let origin = &full[..scheme_end + 3 + host_end];
    match after[host_end..].strip_prefix("/s/") {
        Some(rest) => {
            let id: String = rest.chars().take_while(|c| *c != '/').collect();
            format!("{origin}/s/{}", prefix(&id))
        }
        None => origin.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefixes_tokens() {
        assert_eq!(prefix("st_AbCdEfGhIjKlMnOp"), "st_AbCdE…");
        assert_eq!(prefix("short"), "short");
        assert_eq!(prefix(""), "");
    }

    #[test]
    fn redacts_capture_urls_to_the_id_prefix() {
        assert_eq!(
            url("https://shots.example.com:28443/s/AbCdEfGhIjKlMnOpQrStUvWxYz1"),
            "https://shots.example.com:28443/s/AbCdEfGh…"
        );
        assert_eq!(
            url("https://shots.example.com:28443/s/AbCdEfGhIjKlMnOpQrStUvWxYz1/image.png"),
            "https://shots.example.com:28443/s/AbCdEfGh…"
        );
        assert_eq!(
            url("https://shots.example.com:28443/login"),
            "https://shots.example.com:28443"
        );
        assert_eq!(url("not a url at all"), "not a ur…");
    }
}
