//! Global shortcuts through `org.freedesktop.portal.GlobalShortcuts`. Plasma 6
//! implements it with a grants dialog on first bind and a "Shortcuts" page
//! afterwards; the bindings persist per app id. The session lives as long as
//! the resident process; activations turn into capture commands.

use crate::capture::Mode;
use crate::ipc::Command;
use ashpd::desktop::global_shortcuts::{GlobalShortcuts, NewShortcut};
use futures_util::StreamExt;
use tokio::sync::mpsc::UnboundedSender;

pub async fn run(tx: UnboundedSender<Command>) -> Result<(), String> {
    let portal = GlobalShortcuts::new().await.map_err(|e| e.to_string())?;
    let session = portal
        .create_session(Default::default())
        .await
        .map_err(|e| e.to_string())?;
    let wanted: Vec<NewShortcut> = Mode::ALL
        .iter()
        .map(|m| {
            NewShortcut::new(m.shortcut_id(), m.shortcut_description())
                .preferred_trigger(m.preferred_trigger())
        })
        .collect();
    let bound = portal
        .bind_shortcuts(&session, &wanted, None, Default::default())
        .await
        .map_err(|e| e.to_string())?
        .response()
        .map_err(|e| e.to_string())?;
    for s in bound.shortcuts() {
        crate::logx::info(format!(
            "shortcut {} → {}",
            s.id(),
            if s.trigger_description().is_empty() {
                "(unassigned)"
            } else {
                s.trigger_description()
            }
        ));
    }
    let mut activated = portal
        .receive_activated()
        .await
        .map_err(|e| e.to_string())?;
    while let Some(event) = activated.next().await {
        let Some(mode) = Mode::ALL
            .iter()
            .copied()
            .find(|m| m.shortcut_id() == event.shortcut_id())
        else {
            continue;
        };
        if tx.send(Command::Capture(mode)).is_err() {
            break;
        }
    }
    Ok(())
}
