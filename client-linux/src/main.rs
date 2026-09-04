//! snapping-turtle — native Linux capture client (PLAN.md §15a, M9).
//!
//!   snapping-turtle                       resident: tray icon + global shortcuts
//!   snapping-turtle --capture MODE        full | region | window (forwards to the resident instance if one runs)
//!   snapping-turtle --configure           server origin, API token, autostart
//!   snapping-turtle --autostart on|off
//!   snapping-turtle --upload-file PATH    upload an existing PNG (scripting, CI)
//!
//! Capture, upload and open are one pipeline (`run_capture`); every message
//! that leaves the process passes through `redact` first (CLAUDE.md rule 3).

mod api;
mod app_id;
mod autostart;
mod capture;
mod config;
mod contract;
mod ipc;
mod logx;
mod notify;
mod open;
mod redact;
mod secrets;
mod shortcuts;
mod title;
mod tray;

use app_id::{APP_ID, DEFAULT_ORIGIN};
use capture::Mode;
use config::{Config, TokenStore};
use ipc::Command;
use std::io::{BufRead, Write};
use std::process::ExitCode;
use tokio::sync::mpsc;

const USAGE: &str = "\
snapping-turtle — capture your screen, upload it, annotate it in the browser

USAGE
  snapping-turtle                     run resident: tray icon, global shortcuts
  snapping-turtle --capture MODE      capture now (full | region | window)
  snapping-turtle --configure         set the server, the API token, autostart
      [--origin URL] [--token-stdin] [--token-store keyring|file] [--autostart yes|no|ask]
  snapping-turtle --autostart on|off  enable or disable start-at-login
  snapping-turtle --upload-file PATH [--title TEXT]   upload an existing PNG
  snapping-turtle --print-app-id | --version | --help

OPTIONS
  --no-open      do not open the capture page after upload
  --print-url    print the full capture-page URL to stdout (never logged otherwise)
  -v             verbose diagnostics on stderr (never the token, never full URLs)
";

#[derive(Debug, Default)]
struct Args {
    configure: bool,
    capture: Option<String>,
    autostart: Option<String>,
    upload_file: Option<String>,
    title: Option<String>,
    origin: Option<String>,
    token_stdin: bool,
    token_store: Option<String>,
    configure_autostart: Option<String>,
    no_open: bool,
    print_url: bool,
    print_app_id: bool,
    version: bool,
    help: bool,
    verbose: bool,
}

fn parse_args(argv: &[String]) -> Result<Args, String> {
    let mut a = Args::default();
    let mut i = 0;
    let value = |i: &mut usize, flag: &str| -> Result<String, String> {
        *i += 1;
        argv.get(*i)
            .cloned()
            .ok_or_else(|| format!("{flag} needs a value"))
    };
    while i < argv.len() {
        match argv[i].as_str() {
            "--configure" => a.configure = true,
            "--capture" => a.capture = Some(value(&mut i, "--capture")?),
            "--autostart" => a.autostart = Some(value(&mut i, "--autostart")?),
            "--upload-file" => a.upload_file = Some(value(&mut i, "--upload-file")?),
            "--title" => a.title = Some(value(&mut i, "--title")?),
            "--origin" => a.origin = Some(value(&mut i, "--origin")?),
            "--token-stdin" => a.token_stdin = true,
            "--token-store" => a.token_store = Some(value(&mut i, "--token-store")?),
            "--no-open" => a.no_open = true,
            "--print-url" => a.print_url = true,
            "--print-app-id" => a.print_app_id = true,
            "--version" | "-V" => a.version = true,
            "--help" | "-h" => a.help = true,
            "-v" | "--verbose" => a.verbose = true,
            other => return Err(format!("unknown argument {other:?} (see --help)")),
        }
        i += 1;
    }
    // `--configure --autostart yes|no|ask` reuses the flag as the configure answer.
    if a.configure {
        a.configure_autostart = a.autostart.take();
    }
    Ok(a)
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let args = match parse_args(&argv) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("snapping-turtle: {e}");
            return ExitCode::from(2);
        }
    };
    if args.help {
        print!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    if args.version {
        println!("snapping-turtle {} ({APP_ID})", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    if args.print_app_id {
        println!("{APP_ID}");
        return ExitCode::SUCCESS;
    }
    logx::set_verbose(args.verbose);
    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("snapping-turtle: runtime: {e}");
            return ExitCode::from(1);
        }
    };
    let result = rt.block_on(async move {
        if args.configure {
            configure(&args).await
        } else if let Some(state) = &args.autostart {
            set_autostart(state).await
        } else if let Some(path) = &args.upload_file {
            upload_file(path, args.title.as_deref(), !args.no_open, args.print_url).await
        } else if let Some(mode) = &args.capture {
            capture_command(mode, !args.no_open, args.print_url).await
        } else {
            resident().await
        }
    });
    // Let in-flight DBus replies drain instead of tearing the runtime down mid-call.
    rt.shutdown_timeout(std::time::Duration::from_millis(500));
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("snapping-turtle: {e}");
            ExitCode::from(1)
        }
    }
}

/// Tell the portal who we are before any other portal call. Harmless when the
/// launcher's systemd scope already identified us; logged when the portal
/// declines (e.g. sandboxed, or a different id already associated).
async fn register_app_id() {
    match ashpd::AppID::try_from(APP_ID) {
        Ok(id) => match ashpd::register_host_app(id).await {
            Ok(()) => logx::debug(format!("registered host app id {APP_ID}")),
            Err(e) => logx::debug(format!("host app registration declined ({e}); continuing with the portal's own identification")),
        },
        Err(e) => logx::warn(format!("app id {APP_ID:?} rejected by ashpd: {e}")),
    }
}

// ---- configure ----------------------------------------------------------------

fn prompt(text: &str) -> Result<String, String> {
    print!("{text}");
    std::io::stdout().flush().map_err(|e| e.to_string())?;
    let mut line = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    Ok(line.trim().to_string())
}

/// Read a line with terminal echo off (falls back to a plain read when stdin is not a tty).
fn prompt_secret(text: &str) -> Result<String, String> {
    print!("{text}");
    std::io::stdout().flush().map_err(|e| e.to_string())?;
    let fd = libc::STDIN_FILENO;
    // SAFETY: termios structs are plain data; we restore the original settings before returning.
    let saved = unsafe {
        let mut t: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(fd, &mut t) == 0 {
            let orig = t;
            t.c_lflag &= !libc::ECHO;
            libc::tcsetattr(fd, libc::TCSANOW, &t);
            Some(orig)
        } else {
            None
        }
    };
    let mut line = String::new();
    let read = std::io::stdin().lock().read_line(&mut line);
    if let Some(orig) = saved {
        // SAFETY: restoring the settings we captured above.
        unsafe { libc::tcsetattr(fd, libc::TCSANOW, &orig) };
        println!();
    }
    read.map_err(|e| e.to_string())?;
    Ok(line.trim().to_string())
}

async fn configure(args: &Args) -> Result<(), String> {
    register_app_id().await;
    let existing = config::load()?;
    let default_origin = args
        .origin
        .clone()
        .or_else(|| existing.as_ref().map(|c| c.origin.clone()))
        .or_else(|| DEFAULT_ORIGIN.map(str::to_string));
    let origin = if let Some(o) = &args.origin {
        config::normalize_origin(o)?
    } else {
        loop {
            let hint = default_origin
                .as_deref()
                .map(|d| format!(" [{d}]"))
                .unwrap_or_default();
            let entered = prompt(&format!("Server origin{hint}: "))?;
            let candidate = if entered.is_empty() {
                default_origin.clone().unwrap_or_default()
            } else {
                entered
            };
            match config::normalize_origin(&candidate) {
                Ok(o) => break o,
                Err(e) => println!("  {e}"),
            }
        }
    };

    let token = if args.token_stdin {
        let mut t = String::new();
        std::io::stdin()
            .lock()
            .read_line(&mut t)
            .map_err(|e| e.to_string())?;
        t.trim().to_string()
    } else {
        println!(
            "Create an API token on your Account page at {origin}/account (it is shown once)."
        );
        prompt_secret("API token (not echoed): ")?
    };
    if token.is_empty() {
        return Err("no token entered".into());
    }

    print!("Testing connection to {origin} … ");
    std::io::stdout().flush().ok();
    let client = api::client()?;
    match api::ping(&client, &origin, &token).await {
        api::PingOutcome::Ok => println!("ok"),
        api::PingOutcome::Unauthorized => {
            println!("rejected");
            return Err("the server rejected that token (HTTP 401): nothing saved".into());
        }
        api::PingOutcome::Failed(m) => {
            println!("failed");
            return Err(format!("{m} Nothing saved."));
        }
    }

    let store = match args.token_store.as_deref() {
        Some("keyring") => TokenStore::Keyring,
        Some("file") => TokenStore::File,
        Some(other) => {
            return Err(format!(
                "--token-store must be keyring or file, not {other:?}"
            ))
        }
        None => {
            if secrets::keyring_available().await {
                TokenStore::Keyring
            } else {
                println!(
                    "No Secret Service keyring answered; the token will be kept in a 0600 file."
                );
                TokenStore::File
            }
        }
    };
    secrets::store(store, &token).await?;
    // Switching stores must not leave a copy behind in the other one.
    if let Some(prev) = existing
        .as_ref()
        .map(|c| c.token_store)
        .filter(|p| *p != store)
    {
        if let Err(e) = secrets::delete(prev).await {
            logx::debug(format!("could not remove the previous token copy: {e}"));
        }
    }

    let answer = match args.configure_autostart.as_deref() {
        Some("yes") | Some("on") => Some(true),
        Some("no") | Some("off") => Some(false),
        Some("ask") | None => {
            if args.token_stdin && args.origin.is_some() {
                None // fully non-interactive: leave autostart as it is
            } else {
                let a = prompt("Start snapping-turtle at login (tray icon and shortcuts)? [Y/n] ")?;
                Some(!(a.eq_ignore_ascii_case("n") || a.eq_ignore_ascii_case("no")))
            }
        }
        Some(other) => return Err(format!("--autostart must be yes, no or ask, not {other:?}")),
    };
    let mut autostart_state = existing.as_ref().and_then(|c| c.autostart);
    if let Some(enable) = answer {
        match autostart::set(enable).await {
            Ok(how) => {
                autostart_state = Some(enable);
                println!(
                    "Autostart {} ({}).",
                    if enable { "enabled" } else { "disabled" },
                    match how {
                        autostart::How::Portal => "via the Background portal",
                        autostart::How::File => "autostart entry written directly",
                    }
                );
            }
            Err(e) => println!("Autostart not changed: {e}"),
        }
    }

    let cfg = Config {
        origin: origin.clone(),
        token_store: store,
        autostart: autostart_state,
    };
    let path = config::save(&cfg)?;
    println!(
        "Saved {} — server {origin}, token {} in the {}.",
        path.display(),
        redact::prefix(&token),
        match store {
            TokenStore::Keyring => "keyring",
            TokenStore::File => "0600 token file",
        }
    );
    println!("Disable autostart any time with: snapping-turtle --autostart off");
    Ok(())
}

async fn set_autostart(state: &str) -> Result<(), String> {
    let enable = match state {
        "on" | "yes" | "true" => true,
        "off" | "no" | "false" => false,
        other => return Err(format!("--autostart takes on or off, not {other:?}")),
    };
    register_app_id().await;
    let how = autostart::set(enable).await?;
    if let Some(mut cfg) = config::load()? {
        cfg.autostart = Some(enable);
        config::save(&cfg)?;
    }
    println!(
        "Autostart {} ({}).",
        if enable { "enabled" } else { "disabled" },
        match how {
            autostart::How::Portal => "via the Background portal".to_string(),
            autostart::How::File => autostart::autostart_path().display().to_string(),
        }
    );
    Ok(())
}

// ---- capture → upload → open --------------------------------------------------

struct Session {
    config: Config,
    token: String,
    client: reqwest::Client,
}

async fn load_session() -> Result<Session, String> {
    let Some(config) = config::load()? else {
        return Err("not configured yet — run: snapping-turtle --configure".into());
    };
    let Some(token) = secrets::load(config.token_store).await? else {
        return Err("no API token stored — run: snapping-turtle --configure".into());
    };
    Ok(Session {
        config,
        token,
        client: api::client()?,
    })
}

struct Uploaded {
    page_url: String,
}

/// Upload PNG bytes with a title; notifies on every outcome. `Ok(None)` = a
/// reported failure (already notified), `Err` = something before the upload.
async fn upload_png(
    session: &Session,
    png: Vec<u8>,
    title: &str,
    api_used: &str,
) -> Result<Option<Uploaded>, String> {
    if let Some(msg) = api::oversize_message(png.len() as u64) {
        notify::failure(&msg).await;
        return Ok(None);
    }
    match api::upload(
        &session.client,
        &session.config.origin,
        &session.token,
        png,
        title,
    )
    .await
    {
        api::UploadOutcome::Created { page_url, .. } => {
            logx::info(api::created_log(&page_url, api_used));
            Ok(Some(Uploaded { page_url }))
        }
        api::UploadOutcome::Unauthorized => {
            let msg = api::unauthorized_message();
            logx::warn(&msg);
            notify::notify(
                notify::ID_RESULT,
                "Capture not uploaded — reconfigure",
                &msg,
                true,
            )
            .await;
            Ok(None)
        }
        api::UploadOutcome::Failed(msg) => {
            logx::warn(&msg);
            notify::failure(&msg).await;
            Ok(None)
        }
    }
}

async fn open_page(page_url: &str) {
    match open::open_url(page_url).await {
        Ok(()) => notify::success("Opening the capture page in your browser.").await,
        Err(e) => {
            logx::warn(format!(
                "could not open the browser ({e}); page: {}",
                redact::url(page_url)
            ));
            notify::success("Uploaded, but the browser could not be opened. Use “Open last capture” from the tray.").await;
        }
    }
}

/// The whole pipeline for one mode. Returns the page URL on success.
async fn run_capture(
    conn: &zbus::Connection,
    session: &Session,
    mode: Mode,
    open_after: bool,
) -> Result<Option<String>, String> {
    let captured = match capture::capture(conn, mode).await {
        Ok(c) => c,
        Err(capture::CaptureError::Cancelled) => {
            logx::info(format!("{}: cancelled", mode.label()));
            return Ok(None);
        }
        Err(capture::CaptureError::Failed(m)) => {
            logx::warn(format!("{}: {m}", mode.label()));
            notify::failure(&m).await;
            return Ok(None);
        }
    };
    logx::debug(format!(
        "{} via {}: {}x{} px, {} bytes",
        mode.label(),
        captured.api,
        captured.width,
        captured.height,
        captured.png.len()
    ));
    let title = title::capture_title(mode);
    let Some(up) = upload_png(session, captured.png, &title, captured.api).await? else {
        return Ok(None);
    };
    if open_after {
        open_page(&up.page_url).await;
    } else {
        notify::success("Uploaded.").await;
    }
    Ok(Some(up.page_url))
}

async fn capture_command(mode: &str, open_after: bool, print_url: bool) -> Result<(), String> {
    let mode = Mode::parse(mode)
        .ok_or_else(|| format!("--capture takes full, region or window, not {mode:?}"))?;
    register_app_id().await;
    let conn = zbus::Connection::session()
        .await
        .map_err(|e| format!("session bus: {e}"))?;
    if ipc::forward(&conn, mode).await? {
        logx::debug("forwarded to the running instance");
        return Ok(());
    }
    let session = load_session().await?;
    let url = run_capture(&conn, &session, mode, open_after).await?;
    if let (true, Some(u)) = (print_url, url) {
        println!("{u}");
    }
    Ok(())
}

async fn upload_file(
    path: &str,
    title: Option<&str>,
    open_after: bool,
    print_url: bool,
) -> Result<(), String> {
    register_app_id().await;
    let session = load_session().await?;
    let png = std::fs::read(path).map_err(|e| format!("cannot read {path}: {e}"))?;
    let (w, h) = capture::raw_image::png_dimensions(&png)
        .map_err(|e| format!("{path} is not a PNG: {e}"))?;
    capture::raw_image::check_dimensions(w, h)?;
    let title = title
        .map(str::to_string)
        .unwrap_or_else(|| title::capture_title(Mode::Full));
    let Some(up) = upload_png(&session, png, &title, "file").await? else {
        return Err("upload failed (see the notification / messages above)".into());
    };
    if open_after {
        open_page(&up.page_url).await;
    }
    if print_url {
        println!("{}", up.page_url);
    } else {
        println!("uploaded: {}", redact::url(&up.page_url));
    }
    Ok(())
}

// ---- resident --------------------------------------------------------------------

async fn resident() -> Result<(), String> {
    register_app_id().await;
    let (tx, mut rx) = mpsc::unbounded_channel::<Command>();
    let conn = match ipc::serve(tx.clone()).await? {
        ipc::Serve::Owned(c) => c,
        ipc::Serve::AlreadyRunning => {
            logx::info("already running (the tray icon belongs to that instance)");
            return Ok(());
        }
    };
    let session = match load_session().await {
        Ok(s) => Some(s),
        Err(e) => {
            logx::warn(&e);
            notify::notify(
                notify::ID_STATE,
                "snapping-turtle is not configured",
                "Run `snapping-turtle --configure` in a terminal, then capture from the tray.",
                false,
            )
            .await;
            None
        }
    };
    let tray = match tray::spawn(tx.clone()).await {
        Ok(h) => Some(h),
        Err(e) => {
            logx::warn(format!(
                "tray icon unavailable ({e}); desktop actions and shortcuts still work"
            ));
            None
        }
    };
    {
        let tx = tx.clone();
        tokio::spawn(async move {
            if let Err(e) = shortcuts::run(tx).await {
                logx::warn(format!("global shortcuts unavailable: {e}"));
            }
        });
    }
    logx::info(format!(
        "resident as {APP_ID}; tray {}",
        if tray.is_some() { "shown" } else { "absent" }
    ));

    let mut last_page: Option<String> = None;
    let mut busy = false;
    let (done_tx, mut done_rx) =
        mpsc::unbounded_channel::<(Mode, Result<Option<String>, String>)>();
    let session = std::sync::Arc::new(session);
    loop {
        tokio::select! {
            cmd = rx.recv() => {
                let Some(cmd) = cmd else { break };
                match cmd {
                    Command::Quit => break,
                    Command::OpenLast => {
                        if let Some(u) = &last_page { open_page(u).await; }
                    }
                    Command::Capture(mode) => {
                        if busy {
                            notify::notify(notify::ID_STATE, "A capture is already in progress", "Finish or cancel it first.", false).await;
                            continue;
                        }
                        if session.is_none() {
                            notify::notify(notify::ID_STATE, "snapping-turtle is not configured", "Run `snapping-turtle --configure` in a terminal first.", true).await;
                            continue;
                        }
                        busy = true;
                        if let Some(t) = &tray { t.update(|tr| { tr.busy = true; tr.status = format!("Capturing {}…", mode.label().to_lowercase()); }).await; }
                        let (conn, done_tx, session) = (conn.clone(), done_tx.clone(), session.clone());
                        tokio::spawn(async move {
                            let s = session.as_ref().as_ref().expect("checked above");
                            let r = run_capture(&conn, s, mode, true).await;
                            let _ = done_tx.send((mode, r));
                        });
                    }
                }
            }
            done = done_rx.recv() => {
                let Some((mode, result)) = done else { break };
                busy = false;
                let status = match &result {
                    Ok(Some(url)) => { last_page = Some(url.clone()); format!("Last: {} uploaded ({})", mode.label().to_lowercase(), redact::url(url)) }
                    Ok(None) => format!("Last: {} not uploaded", mode.label().to_lowercase()),
                    Err(e) => { logx::warn(e); format!("Last: {} failed", mode.label().to_lowercase()) }
                };
                if let Some(t) = &tray { t.update(|tr| { tr.busy = false; tr.status = status; tr.has_last = last_page.is_some(); }).await; }
            }
            _ = tokio::signal::ctrl_c() => break,
            _ = sigterm() => break,
        }
    }
    if let Some(t) = tray {
        t.shutdown().await;
    }
    logx::info("exiting");
    Ok(())
}

async fn sigterm() {
    match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
        Ok(mut s) => {
            s.recv().await;
        }
        Err(_) => std::future::pending::<()>().await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Args {
        parse_args(&list.iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap()
    }

    #[test]
    fn parses_the_documented_forms() {
        assert!(args(&[]).capture.is_none());
        assert_eq!(
            args(&["--capture", "window", "--no-open"])
                .capture
                .as_deref(),
            Some("window")
        );
        let c = args(&[
            "--configure",
            "--origin",
            "https://s.test:28443",
            "--token-stdin",
            "--token-store",
            "file",
            "--autostart",
            "no",
        ]);
        assert!(c.configure && c.token_stdin);
        assert_eq!(c.configure_autostart.as_deref(), Some("no"));
        assert!(c.autostart.is_none());
        assert_eq!(
            args(&["--autostart", "off"]).autostart.as_deref(),
            Some("off")
        );
        assert!(parse_args(&["--bogus".to_string()]).is_err());
        assert!(parse_args(&["--capture".to_string()]).is_err());
    }
}
