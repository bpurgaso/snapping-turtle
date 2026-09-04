//! Desktop notifications through `org.freedesktop.portal.Notification`
//! (Plasma implements it via plasmashell's notification backend). Bodies
//! must already be free of secrets (CLAUDE.md rule 3) — callers pass
//! redacted text. Failures to notify are logged, never fatal.

use crate::app_id::ICON_NAME;
use ashpd::desktop::notification::{Notification, NotificationProxy, Priority};
use ashpd::desktop::Icon;

pub const ID_RESULT: &str = "capture-result";
pub const ID_STATE: &str = "state";

pub async fn notify(id: &str, title: &str, body: &str, urgent: bool) {
    let result = async {
        let proxy = NotificationProxy::new().await?;
        let n = Notification::new(title)
            .body(body)
            .icon(Icon::with_names([ICON_NAME]))
            .priority(if urgent {
                Priority::High
            } else {
                Priority::Normal
            });
        proxy.add_notification(id, n).await
    }
    .await;
    if let Err(e) = result {
        crate::logx::warn(format!("notification not shown ({e}): {title} — {body}"));
    }
}

pub async fn success(body: &str) {
    notify(ID_RESULT, "Capture uploaded", body, false).await;
}

pub async fn failure(body: &str) {
    notify(ID_RESULT, "Capture failed", body, true).await;
}
