use std::{path::PathBuf, sync::{Mutex, OnceLock}, time::Instant};
use tauri::{Manager,Emitter};
#[derive(serde::Serialize)]
struct Stage { name: &'static str, elapsed_ms: u128, unix_ms: u128 }
struct Trace { start: Instant, process_created_unix_ms: Option<u64>, probe: Option<PathBuf>, stages: Mutex<Vec<Stage>> }
static TRACE: OnceLock<Trace> = OnceLock::new();
pub fn begin() {
    let probe = std::env::args_os().find_map(|arg| arg.to_str().and_then(|arg| arg.strip_prefix("--startup-probe=")).map(PathBuf::from));
    // A probe must be explicitly isolated; never fall back to personal app data.
    if probe.as_ref().is_some_and(|path| !path.is_absolute()) { panic!("Startup probe requires an absolute directory"); }
    let _ = TRACE.set(Trace { start: Instant::now(), process_created_unix_ms: process_created_unix_ms(), probe, stages: Mutex::new(Vec::new()) });
    mark("process_entry");
}
pub fn probe_dir() -> Option<PathBuf> { TRACE.get().and_then(|trace| trace.probe.clone()) }
pub fn mark(name: &'static str) {
    if let Some(trace) = TRACE.get() { if let Ok(mut stages) = trace.stages.lock() {
        if !stages.iter().any(|stage| stage.name == name) { stages.push(Stage { name, elapsed_ms: trace.start.elapsed().as_millis(), unix_ms: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() }); }
    } }
}
pub fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let default = probe_dir().map(|path| Ok(path.join("data"))).unwrap_or_else(|| app.path().app_local_data_dir().map_err(|e| e.to_string()))?;
    crate::storage_transfer::location(&config_dir(app)?, default)
}
pub fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    probe_dir().map(|path| Ok(path.join("config"))).unwrap_or_else(|| app.path().app_config_dir().map_err(|e| e.to_string()))
}
#[tauri::command]
pub fn frontend_ready(app: tauri::AppHandle, window:tauri::WebviewWindow) {
    if window.label()=="panel" {
        let state=app.state::<crate::RuntimeState>();
        state.panel_ready.store(true,std::sync::atomic::Ordering::SeqCst);
        let epoch=state.panel_epoch.load(std::sync::atomic::Ordering::SeqCst);
        mark("panel_frontend_ready");
        let _=app.emit_to("panel","panel:prepared",epoch);
        let _=crate::show_panel(app.clone(),epoch);
        return;
    }
    mark("frontend_ready");
    write_report(&app);
    if probe_dir().is_some() {
        std::thread::spawn(move || {
            #[cfg(windows)]
            {
                let deadline = Instant::now() + std::time::Duration::from_secs(20);
                while !crate::tray_worker::ready() && !crate::tray_worker::failed() && Instant::now() < deadline {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                let verified = crate::tray_worker::ready() && crate::tray_worker::probe_menu(&app);
                mark(if verified { "tray_menu_verified" } else { "tray_menu_failed" });
                write_report(&app);
                let windows_verified=verified && crate::probe_window_separation(&app);
                mark(if windows_verified { "window_separation_verified" } else { "window_separation_failed" });
                write_report(&app);
                let shortcuts_verified=windows_verified && crate::probe_shortcut_settings(&app);
                mark(if shortcuts_verified { "shortcut_settings_verified" } else { "shortcut_settings_failed" });
                write_report(&app);
                let editor_verified = shortcuts_verified && crate::editor::probe(&app);
                mark(if editor_verified { "editor_window_verified" } else { "editor_window_failed" });
                write_report(&app);
                app.exit(if editor_verified { 0 } else { 2 });
            }
            #[cfg(not(windows))]
            app.exit(0);
        });
    }
}
fn write_report(app: &tauri::AppHandle) {
    if let Some(trace) = TRACE.get() { if let Ok(stages) = trace.stages.lock() {
        if let Ok(dir) = data_dir(app) {
            let report = serde_json::json!({ "build": if cfg!(debug_assertions) { "debug" } else { "release" }, "probe": trace.probe.is_some(), "process_created_unix_ms": trace.process_created_unix_ms, "stages": &*stages });
            let _ = std::fs::create_dir_all(&dir);
            if let Ok(bytes) = serde_json::to_vec_pretty(&report) { let _ = std::fs::write(dir.join("startup-timing.json"), bytes); }
        }
    } }
}

#[cfg(windows)]
fn process_created_unix_ms() -> Option<u64> {
    use windows_sys::Win32::{Foundation::FILETIME, System::Threading::{GetCurrentProcess, GetProcessTimes}};
    unsafe {
        let mut created: FILETIME = std::mem::zeroed();
        let mut exited = created; let mut kernel = created; let mut user = created;
        if GetProcessTimes(GetCurrentProcess(), &mut created, &mut exited, &mut kernel, &mut user) == 0 { return None; }
        let ticks = ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64;
        Some(ticks / 10_000 - 11_644_473_600_000)
    }
}
#[cfg(not(windows))]
fn process_created_unix_ms() -> Option<u64> { None }
