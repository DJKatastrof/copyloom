//! Updates from GitHub Releases. Each release carries a latest.json that names its installer and the
//! installer's signature; the updater plugin checks both against the public key in tauri.conf.json.
//! Copyloom looks shortly after start and then once a day, and installs only when the user asks.
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const FIRST_CHECK: Duration = Duration::from_secs(30);
const TICK: Duration = Duration::from_secs(60 * 60);
const INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Default)]
pub struct UpdateState { found: Mutex<Option<Update>>, installing: AtomicBool }

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Available { pub version: String }

fn enabled(app: &tauri::AppHandle) -> bool {
    app.state::<crate::RuntimeState>().library.lock().map(|library| library.settings.check_updates).unwrap_or(false)
}

async fn check(app: &tauri::AppHandle) -> Result<Option<Available>, String> {
    let exit_app = app.clone();
    // The installer replaces the running exe: stop storage work and the tray icon before Copyloom exits.
    let updater = app.updater_builder().on_before_exit(move || {
        let state = exit_app.state::<crate::RuntimeState>();
        if let Ok(guard) = state.storage_maintenance.lock() { std::mem::forget(guard); }
        if let Ok(guard) = state.storage.lock() { std::mem::forget(guard); }
        #[cfg(windows)]
        { let _ = crate::window_state::save(&exit_app); crate::tray_worker::shutdown(); }
        exit_app.cleanup_before_exit();
    }).build().map_err(|error| error.to_string())?;
    let update = updater.check().await.map_err(|_| "Couldn't check for updates. Check your internet connection and try again.".to_string())?;
    let result = update.as_ref().map(|update| Available { version: update.version.clone() });
    *app.state::<UpdateState>().found.lock().map_err(|_| crate::lock_error())? = update;
    if let Some(found) = &result { let _ = app.emit("update:available", found); }
    Ok(result)
}

/// Checks in the background while "Check for updates" is on. Development builds and the startup probe never check.
pub fn start(app: tauri::AppHandle) {
    if cfg!(debug_assertions) || crate::startup::probe_dir().is_some() { return; }
    let _ = std::thread::Builder::new().name("copyloom-updates".into()).spawn(move || {
        std::thread::sleep(FIRST_CHECK);
        let mut last: Option<Instant> = None;
        loop {
            // A failed check (offline, no release yet) waits for the next day like a successful one; it is never shown.
            if enabled(&app) && last.is_none_or(|at| at.elapsed() >= INTERVAL) {
                let _ = tauri::async_runtime::block_on(check(&app));
                last = Some(Instant::now());
            }
            std::thread::sleep(TICK);
        }
    });
}

#[tauri::command]
pub fn get_update(app: tauri::AppHandle) -> Option<Available> {
    app.state::<UpdateState>().found.lock().ok()?.as_ref().map(|update| Available { version: update.version.clone() })
}

#[tauri::command]
pub async fn check_for_update(app: tauri::AppHandle) -> Result<Option<Available>, String> { check(&app).await }

/// Downloads and verifies the installer, then hands over to it; on success Copyloom exits and the installer starts it again.
#[tauri::command]
pub async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    if !app.state::<crate::RuntimeState>().editors.lock().map_err(|_| crate::lock_error())?.is_empty() {
        return Err("Close the image editor first, so no changes are lost.".into());
    }
    let state = app.state::<UpdateState>();
    let update = state.found.lock().map_err(|_| crate::lock_error())?.clone().ok_or("No update is available.")?;
    if state.installing.swap(true, Ordering::SeqCst) { return Err("The update is already downloading.".into()); }
    let result = update.download_and_install(|_, _| {}, || {}).await;
    state.installing.store(false, Ordering::SeqCst);
    result.map_err(|_| "Couldn't download the update. Try again.".into())
}
