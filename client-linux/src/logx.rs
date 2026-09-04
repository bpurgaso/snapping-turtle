//! Tiny stderr logger. Everything printed here must already be redacted
//! (CLAUDE.md rule 3 crosses the language boundary): callers pass tokens and
//! capture URLs through `crate::redact` first, never raw.

use std::sync::atomic::{AtomicBool, Ordering};

static VERBOSE: AtomicBool = AtomicBool::new(false);

pub fn set_verbose(on: bool) {
    VERBOSE.store(on, Ordering::Relaxed);
}

pub fn verbose() -> bool {
    VERBOSE.load(Ordering::Relaxed) || std::env::var_os("SNAPPING_TURTLE_DEBUG").is_some()
}

pub fn info(msg: impl AsRef<str>) {
    eprintln!("snapping-turtle: {}", msg.as_ref());
}

pub fn warn(msg: impl AsRef<str>) {
    eprintln!("snapping-turtle: warning: {}", msg.as_ref());
}

pub fn debug(msg: impl AsRef<str>) {
    if verbose() {
        eprintln!("snapping-turtle: debug: {}", msg.as_ref());
    }
}
