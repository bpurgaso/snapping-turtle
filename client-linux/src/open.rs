//! Open the capture page in the system browser via `org.freedesktop.portal.OpenURI`.

use ashpd::desktop::open_uri::OpenFileRequest;
use ashpd::Uri;

pub async fn open_url(url: &str) -> Result<(), String> {
    let uri = Uri::parse(url).map_err(|e| format!("invalid URL: {e}"))?;
    let request = OpenFileRequest::default()
        .ask(false)
        .send_uri(&uri)
        .await
        .map_err(|e| format!("OpenURI portal: {e}"))?;
    request
        .response()
        .map_err(|e| format!("OpenURI portal: {e}"))
}
