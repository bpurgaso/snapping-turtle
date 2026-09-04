//! The client's view of the upload contract (PLAN.md §8), read from
//! server/src/routes/captures.ts and its tests — the same M2 discipline the
//! extension applies in extension/src/lib/api.ts:
//!
//!   POST /api/v1/captures  multipart {image, title} + bearer → 201 {pageUrl, imageUrl}
//!   GET  /api/v1/ping      bearer → 204
//!
//! No `sourceUrl` part: a desktop capture has no source page (M9, §7).
//! Response classification is pure and unit-tested; the request wrappers
//! never log or echo the token.

use crate::redact;
use std::time::Duration;

pub const CAPTURES_PATH: &str = "/api/v1/captures";
pub const PING_PATH: &str = "/api/v1/ping";
/// Multipart field names: `CAPTURE_UPLOAD_FIELDS` in shared/src/constants.ts.
pub const FIELD_IMAGE: &str = "image";
pub const FIELD_TITLE: &str = "title";

/// Mirrors `MAX_UPLOAD_MB` in shared/src/constants.ts (checked by contract.rs).
pub const MAX_UPLOAD_MB: u64 = 30;
pub const MAX_UPLOAD_BYTES: u64 = MAX_UPLOAD_MB * 1024 * 1024;

const MAX_SERVER_MESSAGE: usize = 200;

#[derive(Debug, PartialEq, Eq)]
pub enum UploadOutcome {
    Created {
        page_url: String,
        image_url: String,
    },
    /// 401: the token is missing, revoked or the account is disabled → reconfigure.
    Unauthorized,
    Failed(String),
}

#[derive(Debug, PartialEq, Eq)]
pub enum PingOutcome {
    Ok,
    Unauthorized,
    Failed(String),
}

/// The extension's `oversizeMessage`: refuse before spending the upload.
pub fn oversize_message(bytes: u64) -> Option<String> {
    if bytes <= MAX_UPLOAD_BYTES {
        return None;
    }
    Some(format!(
        "The capture is {:.1} MB, over the {} MB upload limit. Capture a smaller area.",
        bytes as f64 / (1024.0 * 1024.0),
        MAX_UPLOAD_MB
    ))
}

fn server_error_text(body: &[u8]) -> String {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
        .unwrap_or_default()
        .trim()
        .chars()
        .take(MAX_SERVER_MESSAGE)
        .collect()
}

/// Short, human error text from an ApiErrorResponse body, or a status-based fallback.
pub fn describe_failure(status: u16, body: &[u8]) -> String {
    let text = server_error_text(body);
    match status {
        413 => "Upload rejected: the image is too large (HTTP 413).".to_string(),
        429 => "The server asked us to slow down (HTTP 429). Try again shortly.".to_string(),
        s if s >= 500 => format!("The server had a problem (HTTP {s}). Try again shortly."),
        s if text.is_empty() => format!("Upload rejected (HTTP {s})."),
        s => format!("Upload rejected (HTTP {s}): {text}"),
    }
}

fn is_http_url(v: &str) -> bool {
    (v.starts_with("https://") || v.starts_with("http://"))
        && v.len() > 8
        && !v.contains(char::is_whitespace)
}

pub fn classify_upload(status: u16, body: &[u8]) -> UploadOutcome {
    if status == 401 {
        return UploadOutcome::Unauthorized;
    }
    if status == 201 {
        let parsed = serde_json::from_slice::<serde_json::Value>(body).ok();
        let field = |k: &str| {
            parsed
                .as_ref()
                .and_then(|v| v.get(k))
                .and_then(|v| v.as_str())
                .map(str::to_string)
        };
        return match (field("pageUrl"), field("imageUrl")) {
            // A misbehaving server must not be able to make us open an arbitrary scheme.
            (Some(p), Some(i)) if is_http_url(&p) && is_http_url(&i) => UploadOutcome::Created {
                page_url: p,
                image_url: i,
            },
            _ => UploadOutcome::Failed(
                "The server returned an unexpected response to the upload.".into(),
            ),
        };
    }
    UploadOutcome::Failed(describe_failure(status, body))
}

pub fn classify_ping(status: u16) -> PingOutcome {
    match status {
        204 => PingOutcome::Ok,
        401 => PingOutcome::Unauthorized,
        404 => PingOutcome::Failed(format!(
            "Reached the server but it has no {PING_PATH} — is the address right and the server up to date?"
        )),
        s => PingOutcome::Failed(format!("Unexpected response from the server (HTTP {s}).")),
    }
}

pub fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        // Never follow a redirect with the bearer token attached (the extension uses redirect: 'error').
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(format!(
            "snapping-turtle-linux/{}",
            env!("CARGO_PKG_VERSION")
        ))
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("HTTP client: {e}"))
}

fn unreachable(origin: &str, e: &reqwest::Error) -> String {
    let why = if e.is_timeout() {
        "timed out"
    } else if e.is_connect() {
        "connection failed"
    } else {
        "request failed"
    };
    format!("Could not reach {origin} ({why}). Check the server address, your connection, and the certificate.")
}

pub async fn upload(
    client: &reqwest::Client,
    origin: &str,
    token: &str,
    png: Vec<u8>,
    title: &str,
) -> UploadOutcome {
    let image = reqwest::multipart::Part::bytes(png)
        .file_name("capture.png")
        .mime_str("image/png")
        .expect("static mime");
    let form = reqwest::multipart::Form::new()
        .part(FIELD_IMAGE, image)
        .text(FIELD_TITLE, title.to_string());
    let res = client
        .post(format!("{origin}{CAPTURES_PATH}"))
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await;
    match res {
        Ok(res) => {
            let status = res.status().as_u16();
            let body = res.bytes().await.map(|b| b.to_vec()).unwrap_or_default();
            classify_upload(status, &body)
        }
        Err(e) => UploadOutcome::Failed(unreachable(origin, &e)),
    }
}

pub async fn ping(client: &reqwest::Client, origin: &str, token: &str) -> PingOutcome {
    match client
        .get(format!("{origin}{PING_PATH}"))
        .bearer_auth(token)
        .send()
        .await
    {
        Ok(res) => classify_ping(res.status().as_u16()),
        Err(e) => PingOutcome::Failed(unreachable(origin, &e)),
    }
}

/// What the user sees for a 401 — points at reconfiguration, names nothing secret.
pub fn unauthorized_message() -> String {
    "The server rejected the API token (HTTP 401). Run `snapping-turtle --configure` with a fresh token from your Account page.".to_string()
}

/// Log line for a successful upload: redacted page URL only.
pub fn created_log(page_url: &str, api: &str) -> String {
    format!("uploaded via {api}: {}", redact::url(page_url))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_like_the_extension() {
        let ok = br#"{"pageUrl":"https://s.test:28443/s/AbCdEfGhIjKlMnOpQrStUvWxYz1","imageUrl":"https://s.test:28443/s/AbCdEfGhIjKlMnOpQrStUvWxYz1/image.png"}"#;
        assert_eq!(
            classify_upload(201, ok),
            UploadOutcome::Created {
                page_url: "https://s.test:28443/s/AbCdEfGhIjKlMnOpQrStUvWxYz1".into(),
                image_url: "https://s.test:28443/s/AbCdEfGhIjKlMnOpQrStUvWxYz1/image.png".into()
            }
        );
        assert_eq!(classify_upload(401, b"{}"), UploadOutcome::Unauthorized);
        assert!(matches!(
            classify_upload(
                201,
                br#"{"pageUrl":"javascript:alert(1)","imageUrl":"https://x/"}"#
            ),
            UploadOutcome::Failed(_)
        ));
        assert!(matches!(
            classify_upload(201, b"not json"),
            UploadOutcome::Failed(_)
        ));
        assert_eq!(
            classify_upload(413, b""),
            UploadOutcome::Failed("Upload rejected: the image is too large (HTTP 413).".into())
        );
        assert_eq!(
            classify_upload(429, b""),
            UploadOutcome::Failed(
                "The server asked us to slow down (HTTP 429). Try again shortly.".into()
            )
        );
        assert_eq!(
            classify_upload(503, b""),
            UploadOutcome::Failed("The server had a problem (HTTP 503). Try again shortly.".into())
        );
        assert_eq!(
            classify_upload(
                422,
                br#"{"error":"image exceeds the height cap","code":"image_too_large"}"#
            ),
            UploadOutcome::Failed(
                "Upload rejected (HTTP 422): image exceeds the height cap".into()
            )
        );
        assert_eq!(
            classify_upload(400, b"{}"),
            UploadOutcome::Failed("Upload rejected (HTTP 400).".into())
        );
    }

    #[test]
    fn ping_classification() {
        assert_eq!(classify_ping(204), PingOutcome::Ok);
        assert_eq!(classify_ping(401), PingOutcome::Unauthorized);
        assert!(matches!(classify_ping(404), PingOutcome::Failed(m) if m.contains(PING_PATH)));
        assert!(matches!(classify_ping(500), PingOutcome::Failed(_)));
    }

    #[test]
    fn oversize_check_mirrors_the_shared_cap() {
        assert_eq!(oversize_message(MAX_UPLOAD_BYTES), None);
        let m = oversize_message(MAX_UPLOAD_BYTES + 1).unwrap();
        assert!(m.contains("30 MB"), "{m}");
    }

    #[test]
    fn messages_never_carry_secrets() {
        let m = unauthorized_message();
        assert!(!m.contains("st_"));
        assert_eq!(
            created_log(
                "https://s.test/s/AbCdEfGhIjKlMnOpQrStUvWxYz1",
                "kwin:CaptureActiveScreen"
            ),
            "uploaded via kwin:CaptureActiveScreen: https://s.test/s/AbCdEfGh…"
        );
    }
}
