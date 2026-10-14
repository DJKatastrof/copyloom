#[cfg(windows)]
mod window_state;
mod win_v;
mod panel_place;
mod autostart;
mod backup;
mod capture_settings;
mod startup;
mod editor;
mod export;
mod file_dialog;
mod storage_transfer;
mod storage_usage;
#[cfg(windows)]
mod tray_worker;
#[cfg(windows)]
mod screenshot;
#[cfg(windows)]
mod ocr;
use startup::frontend_ready;
mod key_protection;
mod library;
mod platform;
mod rich_text;
mod preferences;
mod storage;
mod library_update;
#[cfg(windows)]
mod source_app;

use library::{Action, Deletions, Library};
use library_update::{LibraryUpdate, defer_media};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex, Condvar,
};
use tauri::{
    Emitter, Manager, PhysicalPosition, PhysicalSize, State,
};
#[cfg(not(windows))]
use tauri::{menu::{Menu, MenuItem}, tray::TrayIconBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[derive(Default)]
pub struct RuntimeState {
    library: Mutex<Library>,
    last_content: Mutex<Option<(String, Option<String>)>>,
    view: Mutex<String>,
    previous_window: Mutex<isize>,
    panel_epoch: AtomicU64,
    panel_closing: AtomicBool,
    panel_shown: AtomicBool,
    panel_ready: AtomicBool,
    changing_view: AtomicBool,
    panel_style: Mutex<Option<(isize, isize)>>,
    library_placement_loaded: AtomicBool,
    startup_error: Mutex<Option<String>>,
    shortcut_recording: AtomicBool,
    shortcut_change: Mutex<()>,
    shortcut_held: AtomicBool,
    capture_shortcut_held: AtomicBool,
    storage: Mutex<Option<storage::Storage>>,
    storage_maintenance: Mutex<()>,
    startup_ready: Mutex<bool>,
    startup_wake: Condvar,
    editors: Mutex<std::collections::HashMap<String, editor::EditorWindow>>,
    editor_serial: AtomicU64,
    deletions: Mutex<Deletions>,
}

fn lock_error() -> String {
    "Couldn't read the app's state. Restart Copyloom.".into()
}

#[tauri::command]
async fn load_library(app: tauri::AppHandle) -> Result<Library, String> {
    startup::mark("frontend_requested_library");
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<RuntimeState>();
        let mut ready = state.startup_ready.lock().map_err(|_| lock_error())?;
        while !*ready { ready = state.startup_wake.wait(ready).map_err(|_| lock_error())?; }
        drop(ready);
        if let Some(error) = state.startup_error.lock().map_err(|_| lock_error())?.take() {
            let _ = app.emit("runtime:error", error);
        }
        let snapshot = state.library.lock().map_err(|_| lock_error())?.clone();
        startup::mark("library_returned");
        Ok(snapshot)
    }).await.map_err(|_| lock_error())?
}

fn register_shortcut(app: &tauri::AppHandle, shortcut: &str) -> Result<(), String> {
    app.state::<RuntimeState>().shortcut_held.store(false,Ordering::SeqCst);
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _, event| {
            let state = app.state::<RuntimeState>();
            if event.state == ShortcutState::Released {
                state.shortcut_held.store(false, Ordering::SeqCst);
                return;
            }
            let library_focused=app.get_webview_window("main").is_some_and(|window|window.is_focused().unwrap_or(false));
            if !panel_shortcut_allowed(state.shortcut_recording.load(Ordering::SeqCst),library_focused) { return; }
            if event.state == ShortcutState::Pressed
                && !state.shortcut_held.swap(true, Ordering::SeqCst)
            {
                if let Err(error) = toggle_panel(app) {
                    let _ = app.emit("runtime:error", error);
                }
            }
        })
        .map_err(|_| {
            "The shortcut is in use or could not be registered. Choose another one.".into()
        })
}

/// Win+V replaces the panel's own shortcut. Until Windows releases Win+V the own shortcut stays
/// active, so the panel is never without one; this never fails a save, the settings page shows the state.
fn sync_win_v(app: &tauri::AppHandle, settings: &library::Settings) {
    let shortcuts = app.global_shortcut();
    if settings.shortcut == win_v::SHORTCUT { return; }
    if settings.win_v && !shortcuts.is_registered(win_v::SHORTCUT) { let _ = register_shortcut(app, win_v::SHORTCUT); }
    let win_v_active = settings.win_v && shortcuts.is_registered(win_v::SHORTCUT);
    if !settings.win_v && shortcuts.is_registered(win_v::SHORTCUT) { let _ = shortcuts.unregister(win_v::SHORTCUT); }
    let own = settings.shortcut.as_str();
    if win_v_active && shortcuts.is_registered(own) { let _ = shortcuts.unregister(own); }
    if !win_v_active && !shortcuts.is_registered(own) { let _ = register_shortcut(app, own); }
}
fn win_v_status(app: &tauri::AppHandle) -> Result<win_v::Status, String> {
    let settings = app.state::<RuntimeState>().library.lock().map_err(|_| lock_error())?.settings.clone();
    Ok(win_v::Status { released: win_v::released().unwrap_or(false), registered: (settings.win_v || settings.shortcut == win_v::SHORTCUT) && app.global_shortcut().is_registered(win_v::SHORTCUT) })
}
#[tauri::command]
fn get_win_v(app: tauri::AppHandle) -> Result<win_v::Status, String> { win_v_status(&app) }
/// Turns Win+V on (released by Windows, then registered) or gives it back to Windows.
#[tauri::command]
async fn set_win_v(app: tauri::AppHandle, enabled: bool) -> Result<win_v::Status, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if enabled { win_v::set_released(true)?; }
        let mut settings = app.state::<RuntimeState>().library.lock().map_err(|_| lock_error())?.settings.clone();
        settings.win_v = enabled;
        apply_core(&app, Action::SetSettings { settings }, false)?;
        if !enabled { win_v::set_released(false)?; }
        win_v_status(&app)
    }).await.map_err(|_| lock_error())?
}
/// Restarts Explorer so Windows reads the change, then registers Win+V as soon as it is free.
#[tauri::command]
async fn restart_explorer(app: tauri::AppHandle) -> Result<win_v::Status, String> {
    tauri::async_runtime::spawn_blocking(move || {
        win_v::restart_explorer()?;
        for _ in 0..20 {
            let settings = app.state::<RuntimeState>().library.lock().map_err(|_| lock_error())?.settings.clone();
            if !settings.win_v || app.state::<RuntimeState>().shortcut_recording.load(Ordering::SeqCst) { break; }
            sync_win_v(&app, &settings);
            if app.global_shortcut().is_registered(win_v::SHORTCUT) { break; }
            std::thread::sleep(std::time::Duration::from_millis(300));
        }
        win_v_status(&app)
    }).await.map_err(|_| lock_error())?
}

fn register_capture_shortcut(app: &tauri::AppHandle, shortcut: &str) -> Result<(), String> {
    #[cfg(windows)] {
        capture_settings::ensure_available(shortcut, capture_settings::print_screen_enabled().unwrap_or(None))?;
        app.state::<RuntimeState>().capture_shortcut_held.store(false,Ordering::SeqCst);
        app.global_shortcut().on_shortcut(shortcut, |app, _, event| {
            let state=app.state::<RuntimeState>();
            if event.state==ShortcutState::Released { state.capture_shortcut_held.store(false,Ordering::SeqCst); }
            else if !state.shortcut_recording.load(Ordering::SeqCst) && !state.capture_shortcut_held.swap(true,Ordering::SeqCst) { screenshot::start(app); }
        }).map_err(|_| "The screenshot key is in use. Choose another key or release it in Greenshot or Snipping Tool.".into())
    }
    #[cfg(not(windows))] { let _=(app,shortcut); Err("Screenshots are only available on Windows.".into()) }
}

fn panel_shortcut_allowed(recording:bool,library_focused:bool)->bool { !recording && !library_focused }
// "Start in the tray" is a sign-in choice: started by hand, Copyloom always shows its library.
// At sign-in another app often holds the key first, so stay in the tray; the error waits in the library.
// Storage and tray failures open the library themselves.
fn library_at_start(minimized:bool,autostarted:bool)->bool { !(minimized && autostarted) }
#[tauri::command]
async fn set_capture_recording(app: tauri::AppHandle, recording: bool) -> Result<(), String> {
    if recording { app.state::<RuntimeState>().shortcut_recording.store(true,Ordering::SeqCst); }
    tauri::async_runtime::spawn_blocking(move||set_shortcut_recording(&app,recording)).await.map_err(|_|lock_error())?
}
fn set_shortcut_recording(app:&tauri::AppHandle,recording:bool)->Result<(),String> {
    let state=app.state::<RuntimeState>();
    let _change=state.shortcut_change.lock().map_err(|_|lock_error())?;
    let settings=state.library.lock().map_err(|_|lock_error())?.settings.clone();
    state.shortcut_recording.store(recording,Ordering::SeqCst);
    state.shortcut_held.store(false,Ordering::SeqCst); state.capture_shortcut_held.store(false,Ordering::SeqCst);
    if recording {
        for key in std::iter::once(settings.shortcut.as_str()).chain(settings.capture_shortcut.as_deref()).chain(settings.win_v.then_some(win_v::SHORTCUT)) {
            if app.global_shortcut().is_registered(key) { app.global_shortcut().unregister(key).map_err(|e|e.to_string())?; }
        }
    } else {
        if !app.global_shortcut().is_registered(settings.shortcut.as_str()) { register_shortcut(app,&settings.shortcut)?; }
        sync_win_v(app,&settings);
        if let Some(key)=settings.capture_shortcut { if !app.global_shortcut().is_registered(key.as_str()) { register_capture_shortcut(app,&key)?; } }
    }
    Ok(())
}

fn toggle_panel(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<RuntimeState>();
    let is_panel = state.view.lock().map_err(|_| lock_error())?.as_str() == "panel";
    let visible = app.get_webview_window("panel").map(|window|window.is_visible().unwrap_or(false)).unwrap_or(false);
    if is_panel && visible && !state.panel_closing.load(Ordering::SeqCst) {
        request_panel_close(app).map(|_| ())
    } else {
        set_view(app, "panel")
    }
}

#[tauri::command]
async fn apply_action(app: tauri::AppHandle, action: Action) -> Result<LibraryUpdate, String> {
    tauri::async_runtime::spawn_blocking(move || apply_core(&app, action, false))
        .await
        .map_err(|_| lock_error())?
}

/// Media kept in memory for undo across recent deletions; a single larger deletion is still carried
/// out but cannot be undone, and older deletions fall away when newer ones need the room.
const UNDO_LIMIT: usize = 64 * 1024 * 1024;

/// Restores the most recent deletion, one step per call like any undo; returns how many clips came
/// back, 0 when there is nothing left to undo.
#[tauri::command]
async fn undo_delete(app: tauri::AppHandle) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<RuntimeState>();
        let latest = state.deletions.lock().map_err(|_| lock_error())?.pop();
        let removed = match latest {
            None => return Ok(0),
            Some(None) => return Err("The last deletion cannot be undone.".into()),
            Some(Some(removed)) => removed,
        };
        let count = removed.clips.len();
        if let Err(error) = apply_core(&app, Action::RestoreClips { removed: removed.clone() }, false) {
            state.deletions.lock().map_err(|_| lock_error())?.restore_failed(removed);
            return Err(error);
        }
        Ok(count)
    }).await.map_err(|_| lock_error())?
}

#[tauri::command]
fn can_undo_delete(state: State<'_, RuntimeState>) -> Result<bool, String> {
    Ok(state.deletions.lock().map_err(|_| lock_error())?.can_undo())
}

fn apply_core(app: &tauri::AppHandle, mut action: Action, captured: bool) -> Result<LibraryUpdate, String> {
    let state = app.state::<RuntimeState>();
    // Settings and recorder suspension share an ordering; never re-register an old key over a newer save.
    let _shortcut_change=if matches!(&action,Action::SetSettings { .. }) { Some(state.shortcut_change.lock().map_err(|_|lock_error())?) } else { None };
    let mut library = state.library.lock().map_err(|_| lock_error())?;
    if library.storage != "encrypted" {
        return Err("Your history is not available. Collection is paused; restart once the storage problem is solved.".into());
    }
    if captured && library.paused {
        return Ok(LibraryUpdate::between(&library, &library));
    }
    if captured {
        if let Action::AddClip { clip } = &action {
            if clip.source_app.as_ref().is_some_and(|source| library::program_excluded(&format!("{}.exe", source.name), &library.settings.excluded_programs)) { return Ok(LibraryUpdate::between(&library, &library)); }
        }
    }
    // Periodic prunes (Rust monitor and each window) must not save, bump the revision or re-render when idle.
    if let Action::Prune { now } = &action {
        if !library.has_expired(*now) { return Ok(LibraryUpdate::between(&library, &library)); }
    }
    let captured_content = if captured {
        if let Action::AddClip { clip } = &action {
            let last = state.last_content.lock().map_err(|_| lock_error())?;
            if last.as_ref().is_some_and(|(content, html)| content == &clip.content && html == &clip.html) {
                return Ok(LibraryUpdate::between(&library, &library));
            }
            Some((clip.content.clone(), clip.html.clone()))
        } else {
            None
        }
    } else {
        None
    };
    // Formatting of older clips stays in the database; the same formatted text copied again moves that clip up.
    if let Action::AddClip { clip } = &action {
        if let Some(html) = clip.html.as_ref().filter(|_| library::classify(&clip.content) != "image") {
            let storage = state.storage.lock().map_err(|_| lock_error())?;
            let same = library.clips.iter().find(|c| c.content == clip.content && c.html.as_deref() == Some(&format!("copyloom-html:{}", c.id)) && storage.as_ref().and_then(|storage| storage.read_html(&c.id).ok().flatten()).as_ref() == Some(html));
            if let Some(same) = same { action = Action::Recopied { id: same.id.clone(), clip: clip.clone() }; }
        }
    }
    // Undo media is read before the rows go; a failed read only means this deletion cannot be undone.
    let removal = if let Action::DeleteClips { ids } = &action {
        let storage = state.storage.lock().map_err(|_| lock_error())?;
        Some(storage.as_ref().and_then(|storage| storage.removal(&library, ids, UNDO_LIMIT).ok().flatten()))
    } else { None };
    let mut next = library.clone();
    next.apply(action.clone())?;
    let old_shortcut = library.settings.shortcut.clone();
    let old_capture = library.settings.capture_shortcut.clone();
    if let Action::SetSettings { settings } = &action {
        let path = startup::config_dir(app)?.join("preferences.json");
        let recording=state.shortcut_recording.load(Ordering::SeqCst);
        if !recording && settings.shortcut != old_shortcut {
            register_shortcut(app, &settings.shortcut)?;
            if app.global_shortcut().is_registered(old_shortcut.as_str()) && app.global_shortcut().unregister(old_shortcut.as_str()).is_err()
            {
                let _ = app.global_shortcut().unregister(settings.shortcut.as_str());
                return Err("Couldn't replace the old shortcut.".into());
            }
        }
        if !recording && settings.capture_shortcut != old_capture {
            if let Some(key) = &settings.capture_shortcut {
                if let Err(error) = register_capture_shortcut(app,key) {
                    if settings.shortcut != old_shortcut { let _=app.global_shortcut().unregister(settings.shortcut.as_str()); let _=register_shortcut(app,&old_shortcut); }
                    return Err(error);
                }
            }
            if let Some(old) = &old_capture {
                if app.global_shortcut().is_registered(old.as_str()) && app.global_shortcut().unregister(old.as_str()).is_err() {
                    if let Some(key)=&settings.capture_shortcut { let _=app.global_shortcut().unregister(key.as_str()); }
                    if settings.shortcut != old_shortcut { let _=app.global_shortcut().unregister(settings.shortcut.as_str()); let _=register_shortcut(app,&old_shortcut); }
                    return Err("Couldn't replace the old screenshot key.".into());
                }
            }
        }
        if !recording { sync_win_v(app, settings); }
        if let Err(error) = preferences::save(&path, &next) {
            if !recording && settings.capture_shortcut != old_capture { if let Some(key)=&settings.capture_shortcut { let _=app.global_shortcut().unregister(key.as_str()); } if let Some(key)=&old_capture { let _=register_capture_shortcut(app,key); } }
            if !recording && settings.shortcut != old_shortcut {
                let _ = app.global_shortcut().unregister(settings.shortcut.as_str());
                let _ = register_shortcut(app, &old_shortcut);
            }
            return Err(error);
        }
    } else if !matches!(&action, Action::SetPaused { .. }) {
        state
            .storage
            .lock()
            .map_err(|_| lock_error())?
            .as_mut()
            .ok_or("The database is not available.")?
            .save_changes(&library, &next)?;
    }
    defer_media(&mut next);
    let snapshot = LibraryUpdate::between(&library, &next);
    *library = next;
    match removal {
        Some(Some(removed)) if removed.clips.is_empty() => {}
        Some(removed) => state.deletions.lock().map_err(|_| lock_error())?.push(removed, UNDO_LIMIT),
        None => {}
    }
    if let Some(content) = captured_content {
        *state.last_content.lock().map_err(|_| lock_error())? = Some(content);
    }
    drop(library);
    #[cfg(windows)]
    if matches!(&action, Action::SetSettings { .. }) { tray_worker::refresh_language(); }
    #[cfg(windows)]
    if matches!(&action, Action::SetSettings { .. }) && app.get_webview_window("panel").is_some() {
        if let Err(error) = apply_panel_glass(app) { let _ = app.emit("runtime:error", error); }
    }
    // A committed save stays successful even if the interface has disconnected.
    let _ = app.emit("library:changed", &snapshot);
    Ok(snapshot)
}

fn open_library(path: &std::path::Path, key: &[u8], library: &Library) -> Result<(storage::Storage, Library), String> {
    let mut storage = storage::Storage::open(path, key)?;
    storage.import_legacy_categories(library)?;
    let mut restored = library.clone();
    storage.load_metadata(&mut restored)?;
    Ok((storage, restored))
}

/// Returns the database and key for the daily backup thread.
fn initialize_storage(app: &tauri::AppHandle) -> Result<(std::path::PathBuf, zeroize::Zeroizing<Vec<u8>>), String> {
    let state = app.state::<RuntimeState>();
    let dir = startup::data_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|_| "Couldn't create the history folder.")?;
    let path = dir.join("library.db");
    let preferences_path = startup::config_dir(app)?.join("preferences.json");
    if path.exists() && !preferences_path.exists() {
        return Err("The settings for your existing history are missing. Collection is paused so nothing is cleared with the wrong retention.".into());
    }
    let key = key_protection::load_or_create(&dir.join("library-key.dpapi"), path.exists())?;
    let library = state.library.lock().map_err(|_| lock_error())?.clone();
    let needs_preferences_save = !preferences_path.exists() || !library.categories.is_empty();
    let now = library::now_ms();
    // An emptied file would otherwise open as a new, empty history.
    let mut recovered = if std::fs::metadata(&path).is_ok_and(|meta| meta.len() == 0) { backup::restore(&path, &key, now / 1000)? } else { None };
    let (mut storage, mut restored) = match open_library(&path, &key, &library) {
        Ok(opened) => opened,
        Err(error) => match backup::restore(&path, &key, now / 1000) {
            Ok(Some(copy)) => { recovered = Some(copy); open_library(&path, &key, &library)? }
            _ => return Err(error),
        },
    };
    restored.storage_path = Some(dir.to_string_lossy().into_owned());
    let expired = restored.has_expired(now);
    if expired {
        let before = restored.clone();
        restored.apply(Action::Prune { now })?;
        storage.save_changes(&before, &restored)?;
    }
    if needs_preferences_save {
        // Remove legacy category names only after the encrypted migration and readback succeeded.
        preferences::save(&preferences_path, &restored)?;
    }
    *state.library.lock().map_err(|_| lock_error())? = restored;
    *state.storage.lock().map_err(|_| lock_error())? = Some(storage);
    if let Some(copy) = recovered {
        // Shown when the library is opened; the date stays last so the sentence can be translated.
        let message = format!("Your history was damaged and has been restored from the latest working backup. Clips copied after the backup are missing, and the damaged file is kept in the history folder. The backup is from {}.", copy.label);
        let mut startup = state.startup_error.lock().map_err(|_| lock_error())?;
        *startup = Some(match startup.take() { Some(previous) => format!("{} {}", previous, message), None => message });
    }
    Ok((path, key))
}

#[cfg(windows)]
fn apply_panel_glass(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("panel").ok_or("The app window is missing.")?;
    let theme = app.state::<RuntimeState>().library.lock().map_err(|_| lock_error())?.settings.theme.clone();
    let dark = theme == "dark" || (theme == "system" && window.theme().map_err(|e| e.to_string())? == tauri::Theme::Dark);
    platform::windows::set_glass_theme(window.hwnd().map_err(|e| e.to_string())?.0 as isize, dark);
    let _ = window_vibrancy::clear_blur(&window);
    let _ = window_vibrancy::clear_acrylic(&window);
    platform::windows::apply_panel_acrylic(window.hwnd().map_err(|e| e.to_string())?.0 as isize, dark)
}

fn set_view(app: &tauri::AppHandle, view: &str) -> Result<(), String> {
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    let handle = app.clone();
    let view = view.to_owned();
    app.run_on_main_thread(move || { let _ = send.send(set_view_on_main(&handle, &view)); }).map_err(|e| e.to_string())?;
    receive.recv().map_err(|e| e.to_string())?
}

/// WebView2 arguments for every window; windows sharing a data directory must use identical values.
/// Tauri's defaults plus `--disable-gpu`: the GPU process held ~130 MB even with all windows hidden,
/// and CPU rendering is enough for the panel and library (measured 2026-10-06, see PERFORMANCE.md).
/// `--disable-smooth-scrolling`: a wheel notch moves the list at once, as in native Windows lists, instead of gliding there.
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required --disable-gpu --disable-smooth-scrolling";

fn ensure_panel(app:&tauri::AppHandle)->Result<tauri::WebviewWindow,String> {
    if let Some(window)=app.get_webview_window("panel") { return Ok(window); }
    let mut builder = tauri::WebviewWindowBuilder::new(app,"panel",tauri::WebviewUrl::App("index.html".into()))
        .additional_browser_args(BROWSER_ARGS)
        .title("Copyloom").visible(false).inner_size(panel_place::DEFAULT_SIZE.0,panel_place::DEFAULT_SIZE.1).min_inner_size(panel_place::MIN_SIZE.0,panel_place::MIN_SIZE.1)
        .decorations(false).resizable(false).maximizable(false).minimizable(false).closable(false)
        .skip_taskbar(true).transparent(true).shadow(false).disable_drag_drop_handler()
        .background_color(tauri::window::Color(0,0,0,0))
        .initialization_script("window.__COPYLOOM_PANEL__ = true;");
    if let Some(dir) = startup::probe_dir() { builder = builder.data_directory(dir.join("webview")); }
    builder.build().map_err(|e|e.to_string())
}
/// Where the quick panel opens, and a point on the monitor it belongs to. Without a caret to
/// follow, or a remembered position, it opens at the mouse pointer.
fn panel_anchor(app:&tauri::AppHandle, previous:isize)->(panel_place::Anchor,Option<(f64,f64)>) {
    use panel_place::Anchor;
    let mode=app.state::<RuntimeState>().library.lock().map(|library| library.settings.panel_position.clone()).unwrap_or_default();
    #[cfg(windows)]
    {
        let center=|| (Anchor::Center,platform::windows::window_monitor_center(previous));
        match mode.as_str() {
            "center" => return center(),
            "caret" => if let Some((x,y,_,height))=platform::windows::caret_rect(previous) { return (Anchor::Caret{x,y,height},Some((x as f64,y as f64))); },
            "last" => {
                let saved=panel_place::load(app);
                return match (saved.x,saved.y) { (Some(x),Some(y)) => (Anchor::At(x,y),Some((x as f64+1.0,y as f64+1.0))), _ => center() };
            }
            _ => {}
        }
        match platform::windows::cursor_position() { Some((x,y)) => (Anchor::Pointer(x,y),Some((x as f64,y as f64))), None => center() }
    }
    #[cfg(not(windows))]
    { let _=(previous,mode); (Anchor::Center,None) }
}
/// Size and position for the next opening; the size also counts in the other placement modes.
fn remember_panel(app:&tauri::AppHandle, window:&tauri::WebviewWindow) {
    if let (Ok(position),Ok(size),Ok(scale))=(window.outer_position(),window.outer_size(),window.scale_factor()) {
        panel_place::save(app,panel_place::Saved{width:size.width as f64/scale,height:size.height as f64/scale,x:Some(position.x),y:Some(position.y)});
    }
}
/// The corner grip resizes the panel from its top-left corner.
#[tauri::command]
fn resize_panel(window: tauri::WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    if window.label()!="panel" { return Err("Only the quick panel can be resized here.".into()); }
    let scale=window.scale_factor().map_err(|e|e.to_string())?;
    let (mut width,mut height)=(width.max(panel_place::MIN_SIZE.0)*scale,height.max(panel_place::MIN_SIZE.1)*scale);
    if let Some(monitor)=window.current_monitor().map_err(|e|e.to_string())? { let area=monitor.work_area(); width=width.min(area.size.width as f64); height=height.min(area.size.height as f64); }
    window.set_size(PhysicalSize::new(width.round() as u32,height.round() as u32)).map_err(|e|e.to_string())
}
/// Moves the panel with the mouse, from its header.
#[tauri::command]
fn drag_panel(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label()!="panel" { return Err("Only the quick panel can be moved here.".into()); }
    window.start_dragging().map_err(|e|e.to_string())
}
fn set_view_on_main(app: &tauri::AppHandle, view: &str) -> Result<(), String> {
    let state=app.state::<RuntimeState>();
    if view=="library" || view=="settings" {
        if app.get_webview_window("panel").is_some() {
            let epoch=request_panel_close(app)?;
            finish_hide_panel_on_main(app.clone(),epoch)?;
        }
        let window=app.get_webview_window("main").ok_or("The app window is missing.")?;
        if !state.library_placement_loaded.load(Ordering::SeqCst) {
            #[cfg(windows)]
            let _=window_state::restore(app);
        }
        state.library_placement_loaded.store(true,Ordering::SeqCst);
        app.emit_to("main","view:changed",view).map_err(|e|e.to_string())?;
        if startup::probe_dir().is_none() { window.show().map_err(|e|e.to_string())?; window.set_focus().map_err(|e|e.to_string())?; }
        return Ok(());
    }
    if view!="panel" { return Err("Unknown app view.".into()); }
    #[cfg(windows)]
    let current=platform::windows::foreground();
    let window=ensure_panel(app)?;
    #[cfg(windows)]
    if platform::windows::is_focus_target(current,window.hwnd().map_err(|e|e.to_string())?.0 as isize) {
        *state.previous_window.lock().map_err(|_|lock_error())?=current;
    }
    let epoch=state.panel_epoch.fetch_add(1,Ordering::SeqCst)+1;
    state.panel_closing.store(false,Ordering::SeqCst); state.panel_shown.store(false,Ordering::SeqCst);
    state.changing_view.store(true,Ordering::SeqCst);
    let result=(||->Result<(),String>{
        window.set_always_on_top(true).map_err(|e|e.to_string())?;
        let previous=*state.previous_window.lock().map_err(|_|lock_error())?;
        let (anchor,point)=panel_anchor(app,previous);
        let mut monitor=window.current_monitor().map_err(|e|e.to_string())?;
        if let Some((x,y))=point { monitor=window.monitor_from_point(x,y).map_err(|e|e.to_string())?.or(monitor); }
        let mut geometry_changed=false;
        let unstyled=state.panel_style.lock().map_err(|_|lock_error())?.is_none();
        if let Some(monitor)=monitor {
            let work=monitor.work_area(); let scale=monitor.scale_factor();
            let area=panel_place::Area{x:work.position.x,y:work.position.y,width:work.size.width as i32,height:work.size.height as i32};
            let saved=panel_place::load(app);
            let (width,height)=panel_place::fit_size((saved.width,saved.height),scale,area);
            let (x,y)=panel_place::place(anchor,(width,height),area,scale);
            let (position,size)=(PhysicalPosition::new(x,y),PhysicalSize::new(width as u32,height as u32));
            if window.outer_position().map_err(|e|e.to_string())?!=position || window.outer_size().map_err(|e|e.to_string())?!=size || unstyled {
                geometry_changed=true;
                window.set_size(size).map_err(|e|e.to_string())?; window.set_position(position).map_err(|e|e.to_string())?;
                #[cfg(windows)]
                {
                    let hwnd=window.hwnd().map_err(|e|e.to_string())?.0 as isize;
                    platform::windows::place_panel(hwnd,&mut *state.panel_style.lock().map_err(|_|lock_error())?,x,y,size.width,size.height)?;
                    // Moving to a monitor with another scale lets Windows rescale the window; put it back.
                    if window.outer_size().map_err(|e|e.to_string())?!=size || window.outer_position().map_err(|e|e.to_string())?!=position {
                        platform::windows::place_panel(hwnd,&mut *state.panel_style.lock().map_err(|_|lock_error())?,x,y,size.width,size.height)?;
                    }
                }
            }
        }
        #[cfg(windows)]
        if geometry_changed { apply_panel_glass(app)?; }
        *state.view.lock().map_err(|_|lock_error())?="panel".into();
        app.emit_to("panel","view:changed","panel").map_err(|e|e.to_string())?;
        app.emit_to("panel","panel:prepared",epoch).map_err(|e|e.to_string())?;
        let delay=if state.panel_ready.load(Ordering::SeqCst) {250} else {3000};
        let handle=app.clone();
        std::thread::spawn(move|| {std::thread::sleep(std::time::Duration::from_millis(delay));let _=show_panel(handle,epoch);});
        Ok(())
    })();
    state.changing_view.store(false,Ordering::SeqCst); result
}

#[tauri::command]
fn change_view(app: tauri::AppHandle, view: String) -> Result<(), String> {
    set_view(&app, &view)
}

#[tauri::command]
fn show_panel(app: tauri::AppHandle, epoch: u64) -> Result<(), String> {
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    let handle = app.clone();
    app.run_on_main_thread(move || { let _ = send.send(show_panel_on_main(handle, epoch)); }).map_err(|e| e.to_string())?;
    receive.recv().map_err(|e| e.to_string())?
}

fn show_panel_on_main(app: tauri::AppHandle, epoch: u64) -> Result<(), String> {
    let state = app.state::<RuntimeState>();
    if state.panel_epoch.load(Ordering::SeqCst) != epoch
        || state.panel_closing.load(Ordering::SeqCst)
    {
        return Ok(());
    }
    if state.view.lock().map_err(|_| lock_error())?.as_str() != "panel" {
        return Ok(());
    }
    let window = app
        .get_webview_window("panel")
        .ok_or("The app window is missing.")?;
    if !claim_panel_show(&state, epoch) { return Ok(()); }
    if startup::probe_dir().is_some() { return Ok(()); }
    state.changing_view.store(true, Ordering::SeqCst);
    let result = window
        .show()
        .and_then(|_| window.set_focus())
        .map_err(|e| e.to_string());
    state.changing_view.store(false, Ordering::SeqCst);
    if result.is_err() { state.panel_shown.store(false, Ordering::SeqCst); }
    result
}

fn claim_panel_show(state: &RuntimeState, epoch: u64) -> bool {
    // Frontend readiness and the fallback timer race to show the same panel.
    // The loser must never reactivate it after another application takes focus.
    state.panel_epoch.load(Ordering::SeqCst) == epoch
        && !state.panel_closing.load(Ordering::SeqCst)
        && !state.panel_shown.swap(true, Ordering::SeqCst)
}

#[cfg(windows)]
fn watch_panel_blur(app: &tauri::AppHandle) {
    let epoch = app.state::<RuntimeState>().panel_epoch.load(Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || {
        // Foreground can briefly be zero or the old app while an overlay opens.
        std::thread::sleep(std::time::Duration::from_millis(120));
        loop {
            let (send, receive) = std::sync::mpsc::sync_channel(1);
            let handle = app.clone();
            if app.run_on_main_thread(move || {
                let result = check_panel_blur(&handle, epoch);
                if let Err(error) = &result { let _ = handle.emit("runtime:error", error); }
                let _ = send.send(result.unwrap_or(false));
            }).is_err() { break; }
            if !receive.recv().unwrap_or(false) { break; }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    });
}

#[cfg(windows)]
fn check_panel_blur(app: &tauri::AppHandle, epoch: u64) -> Result<bool, String> {
    let state = app.state::<RuntimeState>();
    if state.panel_epoch.load(Ordering::SeqCst) != epoch
        || state.panel_closing.load(Ordering::SeqCst)
        || state.changing_view.load(Ordering::SeqCst)
        || state.view.lock().map_err(|_| lock_error())?.as_str() != "panel"
    { return Ok(false); }
    let window = app.get_webview_window("panel").ok_or("The app window is missing.")?;
    if !window.is_visible().map_err(|e| e.to_string())? { return Ok(false); }
    let panel = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    let current = platform::windows::foreground();
    if current == panel { return Ok(false); }
    if platform::windows::is_capture_window(current) {
        // Leave the panel visible for the screenshot, but below the capture overlay.
        // No Print Screen registration or keyboard interception is needed.
        platform::windows::set_panel_topmost(panel, false)?;
        return Ok(true);
    }
    request_panel_close(app)?;
    Ok(false)
}

fn request_panel_close(app: &tauri::AppHandle) -> Result<u64, String> {
    let state = app.state::<RuntimeState>();
    let epoch = state.panel_epoch.load(Ordering::SeqCst);
    if state.view.lock().map_err(|_| lock_error())?.as_str() != "panel" {
        return Ok(epoch);
    }
    if state.panel_closing.swap(true, Ordering::SeqCst) {
        return Ok(epoch);
    }
    app.emit_to("panel", "panel:closing", epoch)
        .map_err(|e| e.to_string())?;
    // A bounded fallback also dismisses the panel if the webview is unresponsive.
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(220));
        let _ = finish_hide_panel(handle, epoch);
    });
    Ok(epoch)
}

#[tauri::command]
fn hide_panel(app: tauri::AppHandle) -> Result<(), String> {
    request_panel_close(&app).map(|_| ())
}

#[tauri::command]
fn finish_hide_panel(app: tauri::AppHandle, epoch: u64) -> Result<(), String> {
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    let handle = app.clone();
    app.run_on_main_thread(move || { let _ = send.send(finish_hide_panel_on_main(handle, epoch)); }).map_err(|e| e.to_string())?;
    receive.recv().map_err(|e| e.to_string())?
}

fn finish_hide_panel_on_main(app: tauri::AppHandle, epoch: u64) -> Result<(), String> {
    let state = app.state::<RuntimeState>();
    if state.panel_epoch.load(Ordering::SeqCst) != epoch
        || !state.panel_closing.load(Ordering::SeqCst)
    {
        return Ok(());
    }
    if state.view.lock().map_err(|_| lock_error())?.as_str() == "panel" {
        let window = app.get_webview_window("panel").ok_or("The app window is missing.")?;
        if !window.is_visible().map_err(|e| e.to_string())? { return Ok(()); }
        // Keep native focus changes serialized with opening and epoch checks.
        // No mutex may be held across activation: Windows can call us back.
        #[cfg(windows)]
        let target = *state.previous_window.lock().map_err(|_| lock_error())?;
        #[cfg(windows)]
        let panel = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        state.changing_view.store(true, Ordering::SeqCst);
        remember_panel(&app, &window);
        #[cfg(windows)]
        platform::windows::restore_panel_focus(panel, target);
        let result = window.hide().map_err(|e| e.to_string());
        state.changing_view.store(false, Ordering::SeqCst);
        result?;
    }
    Ok(())
}

#[tauri::command]
async fn load_media(app: tauri::AppHandle, id: String, kind: String, original: Option<bool>) -> Result<tauri::ipc::Response, String> {
    if kind != "clip" && kind != "icon" { return Err("Unknown image type.".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<RuntimeState>();
        let preview = kind == "clip" && !original.unwrap_or(false);
        let png = {
            let storage = state.storage.lock().map_err(|_| lock_error())?;
            let storage = storage.as_ref().ok_or("The database is not available.")?;
            // Lists show a stored thumbnail; only the first showing reads the original.
            if preview { if let Some(thumbnail) = storage.read_thumbnail(&id)? { return Ok(tauri::ipc::Response::new(thumbnail)); } }
            storage.read_media(&id, kind == "icon")?
        };
        if !preview { return Ok(tauri::ipc::Response::new(png)); }
        // Decode and resize outside the database lock; originals stay encrypted.
        let thumbnail = list_thumbnail(&png)?;
        if let Ok(storage) = state.storage.lock() { if let Some(storage) = storage.as_ref() { let _ = storage.write_thumbnail(&id, &thumbnail); } }
        Ok(tauri::ipc::Response::new(thumbnail))
    }).await.map_err(|_| lock_error())?
}

/// The list picture: sharp at 200 % in the quick panel's 108 px tall box, and whole, so the library's
/// small thumbnail looks as before. At least 216 px tall or 560 px wide, never enlarged. JPEG, a few
/// percent of a screenshot's size; images with transparency stay PNG.
fn list_thumbnail(png: &[u8]) -> Result<Vec<u8>, String> {
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(png), image::ImageFormat::Png);
    let mut limits = image::Limits::default(); limits.max_alloc = Some((library::MAX_IMAGE_RGBA_BYTES as u64)*2);
    reader.limits(limits);
    let image = reader.decode().map_err(|_| "Couldn't read the image.")?;
    let (width, height) = thumbnail_size(image.width().max(1), image.height().max(1));
    let scaled = image.resize_exact(width, height, image::imageops::FilterType::Triangle);
    let mut bytes = std::io::Cursor::new(Vec::new());
    let encoded = if scaled.to_rgba8().pixels().any(|pixel| pixel[3] < 255) { scaled.write_to(&mut bytes, image::ImageFormat::Png) }
        else { image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 82).encode_image(&scaled.to_rgb8()) };
    encoded.map_err(|_| "Couldn't create the preview.")?;
    Ok(bytes.into_inner())
}

fn thumbnail_size(width: u32, height: u32) -> (u32, u32) {
    // Wide strips keep their full height and tall pages their full width, up to these sizes.
    let scale = (216.0 / height as f64).max(560.0 / width as f64).min(1.0);
    // A screenshot of a long page would otherwise stay huge; about 1.5 megapixels at most.
    let scale = scale.min((1_500_000.0 / (width as f64 * height as f64)).sqrt());
    (((width as f64 * scale).floor() as u32).max(1), ((height as f64 * scale).floor() as u32).max(1))
}

#[derive(serde::Serialize)]
struct CopyResult {
    pasted: bool,
}

#[tauri::command]
async fn copy_clip(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: State<'_, RuntimeState>,
    id: String,
    plain: Option<bool>,
) -> Result<CopyResult, String> {
    let paste_directly;
    {
        let library = state.library.lock().map_err(|_| lock_error())?;
        paste_directly = library.settings.paste_directly;
        let mut clip = library
            .clips
            .iter()
            .find(|clip| clip.id == id)
            .ok_or("The clip no longer exists.")?.as_ref().clone();
        let mut image_png = None;
        if clip.kind == "image" {
            use base64::Engine;
            let png = state.storage.lock().map_err(|_| lock_error())?.as_ref()
                .ok_or("The database is not available.")?.read_media(&clip.id, false)?;
            clip.content = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&png));
            image_png = Some(png);
        }
        clip.html = if plain.unwrap_or(false) { None } else {
            state.storage.lock().map_err(|_| lock_error())?.as_ref().ok_or("The database is not available.")?.read_html(&clip.id)?
        };
        let mut last_content = state.last_content.lock().map_err(|_| lock_error())?;
        *last_content = Some((clip.content.clone(), clip.html.clone()));
        match &image_png { Some(png) => platform::write_png_clipboard(png)?, None => platform::write_clipboard(&clip)? }
        drop(last_content);
        drop(library);
    }
    let mut pasted = false;
    let in_panel = window.label() == "panel";
    if in_panel {
        let target = *state.previous_window.lock().map_err(|_| lock_error())?;
        let epoch = request_panel_close(&app)?;
        // Hide at once: the panel has no closing animation to wait for, and the paste should feel instant.
        finish_hide_panel(app.clone(), epoch)?;
        #[cfg(windows)]
        {
            if paste_directly { pasted = platform::windows::paste_into(target); }
        }
        #[cfg(not(windows))]
        let _ = target;
    }
    Ok(CopyResult { pasted })
}

/// Copies the text in an image clip; the clipboard monitor then saves it as a new text clip.
#[tauri::command]
async fn copy_image_text(app: tauri::AppHandle, id: String) -> Result<(), String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<RuntimeState>();
        if !state.library.lock().map_err(|_| lock_error())?.clips.iter().any(|clip| clip.id == id && clip.kind == "image") {
            return Err("The clip no longer exists.".into());
        }
        let png = state.storage.lock().map_err(|_| lock_error())?.as_ref().ok_or("The database is not available.")?.read_media(&id, false)?;
        let text = ocr::recognize(&png)?;
        if text.trim().is_empty() { return Err("No text was found in the image.".into()); }
        platform::write_text(&text)
    }).await.map_err(|_| lock_error())?;
    #[cfg(not(windows))]
    { let _ = (app, id); Err("Text recognition is only available in the Windows app.".into()) }
}

fn start_monitor(app: tauri::AppHandle) {
    #[cfg(windows)]
    std::thread::spawn(move || {
        let mut monitor = clipboard_win::monitor::Monitor::new().ok();
        if monitor.is_none() {
            let _ = app.emit(
                "runtime:error",
                "Couldn't register for Windows clipboard notifications. Checking periodically instead.",
            );
        }
        let mut sequence = platform::windows::clipboard_sequence();
        let mut retries_left = 0u8;
        let mut retry_at = std::time::Instant::now();
        let mut prune_at = std::time::Instant::now() + std::time::Duration::from_secs(60);
        loop {
            if std::time::Instant::now() >= prune_at {
                let state = app.state::<RuntimeState>();
                if state
                    .library
                    .lock()
                    .map(|library| library.storage == "encrypted")
                    .unwrap_or(false)
                {
                    if let Err(error) = apply_core(
                        &app,
                        Action::Prune {
                            now: library::now_ms(),
                        },
                        false,
                    ) {
                        let _ = app.emit("runtime:error", error);
                    }
                }
                prune_at = std::time::Instant::now() + std::time::Duration::from_secs(60);
            }
            let mut event = false;
            if let Some(listener) = &mut monitor {
                // Drain only a bounded batch so a busy owner cannot starve capture.
                for _ in 0..32 {
                    match listener.try_recv() {
                        Ok(true) => event = true,
                        Ok(false) => break,
                        Err(_) => {
                            monitor = None;
                            break;
                        }
                    }
                }
            }
            if screenshot::active() { platform::windows::wait_for_message(std::time::Duration::from_millis(50)); continue; }
            let current = platform::windows::clipboard_sequence();
            let changed = current != sequence;
            let retry = retries_left > 0 && std::time::Instant::now() >= retry_at;
            if event || changed || retry {
                if event || changed {
                    retries_left = 3;
                }
                sequence = current;
                let state = app.state::<RuntimeState>();
                let paused = state
                    .library
                    .lock()
                    .map(|library| library.paused)
                    .unwrap_or(true);
                if !paused {
                    // Remote Desktop may render data on demand. Never hold application locks during this read.
                    let excluded = state.library.lock().map(|l| l.settings.excluded_programs.clone()).unwrap_or_default();
                    let result = platform::read_clipboard_filtered(&excluded);
                    if platform::windows::clipboard_sequence() != current {
                        retries_left = 3;
                        retry_at = std::time::Instant::now();
                        continue;
                    }
                    match result {
                        Ok(Some(mut clip)) => {
                            let privacy = platform::windows::history_allowed();
                            if platform::windows::clipboard_sequence() != current {
                                retries_left = 3;
                                retry_at = std::time::Instant::now();
                                continue;
                            }
                            if privacy.is_err() {
                                retries_left = retries_left.saturating_sub(1);
                                retry_at = std::time::Instant::now()
                                    + std::time::Duration::from_millis(500);
                            }
                            if matches!(privacy, Ok(true)) {
                                retries_left = 0;
                                if clip.kind == "image" && app.state::<RuntimeState>().library.lock().map(|library| library.settings.language != "sv").unwrap_or(true) { clip.title = "Copied image".into(); }
                                if let Err(error) = apply_core(&app, Action::AddClip { clip }, true)
                                {
                                    let _ = app.emit("runtime:error", error);
                                }
                            }
                        }
                        Ok(None) => {
                            // Honoured silently, as Windows' own clipboard history does: nothing went wrong.
                            if matches!(platform::windows::history_allowed(), Ok(false)) {
                                retries_left = 0;
                                continue;
                            }
                            retries_left = retries_left.saturating_sub(1);
                            retry_at =
                                std::time::Instant::now() + std::time::Duration::from_millis(500);
                        }
                        Err(message) => {
                            retries_left = 0;
                            let _ = app.emit("runtime:error", message);
                        }
                    }
                } else {
                    retries_left = 0;
                }
            }
            // The listener wakes this thread on every clipboard change; polling is only a fallback.
            let now = std::time::Instant::now();
            let mut wake = prune_at.min(now + std::time::Duration::from_millis(if monitor.is_some() { 1000 } else { 100 }));
            if retries_left > 0 { wake = wake.min(retry_at); }
            platform::windows::wait_for_message(wake.saturating_duration_since(now));
        }
    });
    #[cfg(not(windows))]
    let _ = app;
}

#[tauri::command]
fn get_autostart() -> Result<autostart::Status, String> { autostart::status() }

#[tauri::command]
fn set_autostart(enabled: bool) -> Result<autostart::Status, String> { autostart::set(enabled) }

/// Shows the folder with the encrypted history and its backups in File Explorer.
#[tauri::command]
fn open_data_folder(state: State<'_, RuntimeState>) -> Result<(), String> {
    let path = state.library.lock().map_err(|_| lock_error())?.storage_path.clone().ok_or("The data folder is not known.")?;
    capture_settings::shell_open(&path).map_err(|_| "Couldn't open the folder.".into())
}

pub fn run() {
    startup::begin();
    let mut context = tauri::generate_context!();
    startup::mark("context_ready");
    context.config_mut().app.windows[0].additional_browser_args = Some(BROWSER_ARGS.into());
    if let Some(dir) = startup::probe_dir() {
        context.config_mut().identifier = "io.copyloom.startup-probe".into();
        context.config_mut().app.windows[0].data_directory = Some(dir.join("webview"));
    }
    tauri::Builder::default()
        .on_page_load(|_, payload| {
            startup::mark(match payload.event() {
                tauri::webview::PageLoadEvent::Started => "webview_navigation_started",
                tauri::webview::PageLoadEvent::Finished => "webview_navigation_finished",
            });
        })
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if !autostart::autostart_requested(args.into_iter().map(std::ffi::OsString::from)) { let _ = set_view(app, "library"); }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .on_menu_event(|app, event| match event.id.as_ref() {
            "library" | "panel" => { let _ = set_view(app, event.id.as_ref()); }
            "pause" => {
                let paused = app.state::<RuntimeState>().library.lock().map(|library| library.paused).unwrap_or(true);
                if let Err(error) = apply_core(app, Action::SetPaused { value: !paused }, false) { let _ = app.emit("runtime:error", error); }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .manage(RuntimeState::default())
        .invoke_handler(tauri::generate_handler![
            frontend_ready,
            set_capture_recording,
            capture_settings::get_capture_environment,
            capture_settings::retry_capture_shortcut,
            capture_settings::open_keyboard_settings,
            open_data_folder,
            storage_usage::get_storage_usage,
            get_win_v,
            set_win_v,
            restart_explorer,
            get_autostart,
            set_autostart,
            load_library,
            apply_action,
            change_view,
            hide_panel,
            resize_panel,
            drag_panel,
            show_panel,
            finish_hide_panel,
            copy_clip,
            copy_image_text,
            load_media,
            undo_delete,
            can_undo_delete,
            editor::open_editor,
            editor::editor_request,
            editor::editor_settings,
            editor::editor_ready,
            editor::close_editor,
            editor::save_edited_image,
            editor::editor_probe_report,
            export::save_image_file,
            export::save_clip_image,
            storage_transfer::choose_data_folder,
            storage_transfer::move_data_folder,
            storage_transfer::choose_excluded_program,
            storage_transfer::choose_export_file,
            storage_transfer::export_history,
            storage_transfer::restore_history
        ])
        .setup(|app| {
            startup::mark("webview_created_setup_enter");
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") { platform::windows::hide_window_border(window.hwnd()?.0 as isize); }
            let state = app.state::<RuntimeState>();
            let path = startup::config_dir(app.handle())?.join("preferences.json");
            let preferences_valid = match preferences::load(&path) {
                Ok(Some(library)) => { *state.library.lock().map_err(|_| lock_error())? = library; true },
                Ok(None) => true,
                Err(error) => { *state.startup_error.lock().map_err(|_| lock_error())? = Some(error); false },
            };
            startup::mark("preferences_loaded");
            #[cfg(windows)]
            tray_worker::start(app.handle().clone())?;
            #[cfg(not(windows))]
            {
            let library_item =
                MenuItem::with_id(app, "library", "Open library", true, None::<&str>)?;
            let panel_item =
                MenuItem::with_id(app, "panel", "Open quick panel", true, None::<&str>)?;
            let pause_item = MenuItem::with_id(
                app,
                "pause",
                "Pause / resume collection",
                true,
                None::<&str>,
            )?;
            let quit_item = MenuItem::with_id(app, "quit", "Avsluta Copyloom", true, None::<&str>)?;
            let menu =
                Menu::with_items(app, &[&library_item, &panel_item, &pause_item, &quit_item])?;
            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))?;
            TrayIconBuilder::new()
                .icon(icon)
                .tooltip("Copyloom – lokal clipboard-historik")
                .menu(&menu)
                .build(app)?;
            startup::mark("tray_created");
            }
            let shortcut = state.library.lock().map_err(|_| lock_error())?.settings.shortcut.clone();
            if startup::probe_dir().is_none() { let settings = state.library.lock().map_err(|_| lock_error())?.settings.clone(); sync_win_v(app.handle(), &settings); }
            // Win+V, once active, stands in for the own shortcut; an own shortcut already registered needs nothing more.
            if let Err(error) = if startup::probe_dir().is_some() || app.global_shortcut().is_registered(shortcut.as_str()) || app.global_shortcut().is_registered(win_v::SHORTCUT) { Ok(()) } else { register_shortcut(app.handle(), &shortcut) } {
                let message = format!("{} Saved shortcut: {}. Open the panel from the system tray or choose another shortcut.", error, shortcut.replace("Super", "Win"));
                let mut startup = state.startup_error.lock().map_err(|_| lock_error())?;
                *startup = Some(match startup.take() { Some(previous) => format!("{} {}", previous, message), None => message });
            }
            if startup::probe_dir().is_none() {
                let capture = state.library.lock().map_err(|_| lock_error())?.settings.capture_shortcut.clone();
                if let Some(key)=capture { if let Err(error)=register_capture_shortcut(app.handle(),&key) { let _=app.emit("runtime:error",error.clone()); *state.startup_error.lock().map_err(|_|lock_error())?=Some(error); } }
            }
            startup::mark("shortcut_registered");
            let background = state.library.lock().map_err(|_| lock_error())?.settings.start_minimized;
            let autostarted = autostart::autostart_requested(std::env::args_os());
            if startup::probe_dir().is_none() && library_at_start(background, autostarted) {
                if let Some(window) = app.get_webview_window("main") {
                    #[cfg(windows)]
                    let _=window_state::restore(app.handle());
                    state.library_placement_loaded.store(true,Ordering::SeqCst);
                    window.show()?; window.set_focus()?;
                }
            }
            let handle = app.handle().clone();
            std::thread::Builder::new().name("copyloom-startup".into()).spawn(move || {
                let state = handle.state::<RuntimeState>();
                startup::mark("storage_begin");
                if startup::probe_dir().is_none() {
                    if let Err(error) = autostart::status() { let _ = handle.emit("runtime:error", error); }
                }
                let result = if preferences_valid { initialize_storage(&handle) } else { Err("Couldn't read the settings. Your history has not changed.".into()) };
                let failed = result.is_err();
                let backups = match result {
                    Ok(database) => Some(database),
                    Err(error) => {
                        if let Ok(mut library) = state.library.lock() {
                            library.storage = "unavailable".into();
                            library.storage_path = handle.path().app_local_data_dir().ok().map(|dir| dir.to_string_lossy().into_owned());
                            library.paused = true;
                        }
                        if let Ok(mut startup) = state.startup_error.lock() { if startup.is_none() { *startup = Some(error); } }
                        None
                    }
                };
                startup::mark("storage_ready");
                if let Ok(mut ready) = state.startup_ready.lock() { *ready = true; state.startup_wake.notify_all(); }
                if failed && startup::probe_dir().is_none() { let _ = set_view(&handle, "library"); }
                else if !failed && startup::probe_dir().is_none() {
                    start_monitor(handle.clone());
                    if backups.is_some() { backup::start(handle.clone()); }
                }
            })?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if editor::is_editor(window.label()) {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    // Only this window may ask about its unsaved changes.
                    let _ = window.emit_to(window.label(), "editor:close-requested", ());
                }
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    if let Ok(mut editors) = window.state::<RuntimeState>().editors.lock() { editors.remove(window.label()); }
                }
                return;
            }
            if window.label()=="main" {
                if let tauri::WindowEvent::CloseRequested {api,..}=event {
                    api.prevent_close();
                    #[cfg(windows)]
                    if let Err(error)=window_state::save(window.app_handle()) { let _=window.emit("runtime:error",error); }
                    let _=window.hide();
                }
                return;
            }
            if window.label()!="panel" { return; }
            #[cfg(windows)]
            if matches!(event, tauri::WindowEvent::ThemeChanged(_)) && window.state::<RuntimeState>().view.lock().map(|view| view.as_str() == "panel").unwrap_or(false) {
                if let Err(error) = apply_panel_glass(window.app_handle()) { let _ = window.emit("runtime:error", error); }
            }
            if let tauri::WindowEvent::Focused(false) = event {
                let state = window.state::<RuntimeState>();
                if !state.changing_view.load(Ordering::SeqCst)
                    && !window.is_focused().unwrap_or(false)
                {
                    #[cfg(windows)]
                    watch_panel_blur(window.app_handle());
                    #[cfg(not(windows))]
                    let _ = request_panel_close(window.app_handle());
                }
            }
            if matches!(event, tauri::WindowEvent::Focused(true)) {
                let state = window.state::<RuntimeState>();
                if !state.changing_view.load(Ordering::SeqCst)
                    && !state.panel_closing.load(Ordering::SeqCst)
                    && state.view.lock().map(|view| view.as_str() == "panel").unwrap_or(false)
                {
                    #[cfg(windows)]
                    if let Ok(hwnd) = window.hwnd() { let _ = platform::windows::set_panel_topmost(hwnd.0 as isize, true); }
                    #[cfg(not(windows))]
                    let _ = window.set_always_on_top(true);
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _=request_panel_close(window.app_handle());
            }
        })
        .build(context)
        .expect("Copyloom couldn't start")
        .run(|app, event| {
            #[cfg(windows)]
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) { let _=window_state::save(app); editor::save_newest(app); }
            #[cfg(windows)]
            if matches!(event, tauri::RunEvent::Exit) { tray_worker::shutdown(); }
        });
}

#[cfg(test)]
mod panel_geometry_tests {
    use super::*;
    #[test]
    fn fallback_cannot_reactivate_an_already_open_panel() {
        let state = RuntimeState::default();
        state.panel_epoch.store(1, Ordering::SeqCst);
        assert!(claim_panel_show(&state, 1));
        // Even when Greenshot or another app has taken focus, the second caller
        // does not show or focus this panel again.
        assert!(!claim_panel_show(&state, 1));
        state.panel_closing.store(true, Ordering::SeqCst);
        assert!(!claim_panel_show(&state, 1));
        // Reopen while an old close/show callback is still in flight.
        state.panel_epoch.store(2, Ordering::SeqCst);
        state.panel_closing.store(false, Ordering::SeqCst);
        state.panel_shown.store(false, Ordering::SeqCst);
        assert!(!claim_panel_show(&state, 1));
        assert!(claim_panel_show(&state, 2));
        assert!(!claim_panel_show(&state, 2));
    }
}

/// Isolated native integration check: never shows windows or uses personal history.
pub fn probe_window_separation(app:&tauri::AppHandle)->bool {
    if startup::probe_dir().is_none() { return false; }
    let (send,receive)=std::sync::mpsc::sync_channel(1); let handle=app.clone();
    if app.run_on_main_thread(move|| {
        let result=(||->Result<bool,String>{
            let main=handle.get_webview_window("main").ok_or("main missing")?;
            let size=main.outer_size().map_err(|e|e.to_string())?; let position=main.outer_position().map_err(|e|e.to_string())?;
            let visible=main.is_visible().map_err(|e|e.to_string())?;
            set_view_on_main(&handle,"panel")?;
            let panel=handle.get_webview_window("panel").ok_or("panel missing")?;
            #[cfg(windows)]
            if main.hwnd().map_err(|e|e.to_string())?==panel.hwnd().map_err(|e|e.to_string())? { return Ok(false); }
            let epoch=request_panel_close(&handle)?; finish_hide_panel_on_main(handle.clone(),epoch)?;
            set_view_on_main(&handle,"panel")?;
            Ok(main.outer_size().map_err(|e|e.to_string())?==size && main.outer_position().map_err(|e|e.to_string())?==position && main.is_visible().map_err(|e|e.to_string())?==visible && !panel.is_visible().map_err(|e|e.to_string())?)
        })(); let _=send.send(result.unwrap_or(false));
    }).is_err() { return false; }
    if !receive.recv().unwrap_or(false) { return false; }
    let deadline=std::time::Instant::now()+std::time::Duration::from_secs(10);
    while !app.state::<RuntimeState>().panel_ready.load(Ordering::SeqCst) && std::time::Instant::now()<deadline { std::thread::sleep(std::time::Duration::from_millis(10)); }
    app.state::<RuntimeState>().panel_ready.load(Ordering::SeqCst)
}

#[cfg(test)] mod shortcut_focus_tests {
    use super::*;
    #[test] fn global_panel_key_leaves_active_library_and_recorders_alone() {
        assert!(panel_shortcut_allowed(false,false));
        assert!(!panel_shortcut_allowed(false,true));
        assert!(!panel_shortcut_allowed(true,false));
        assert!(!panel_shortcut_allowed(true,true));
    }
    #[test] fn tray_start_applies_to_sign_in_only() {
        assert!(!library_at_start(true,true));
        assert!(library_at_start(true,false));
        assert!(library_at_start(false,true));
        assert!(library_at_start(false,false));
    }
}

/// Test real registration, replacement, suspension and restoring without sending keys.
pub fn probe_shortcut_settings(app:&tauri::AppHandle)->bool {
    if startup::probe_dir().is_none() { return false; }
    let result=(||->Result<bool,String>{
        let state=app.state::<RuntimeState>();
        let mut a=state.library.lock().map_err(|_|lock_error())?.settings.clone();
        a.shortcut="Ctrl+Alt+Shift+F9".into(); a.capture_shortcut=Some("Ctrl+Alt+Shift+F8".into());
        apply_core(app,Action::SetSettings {settings:a.clone()},false)?;
        state.shortcut_held.store(true,Ordering::SeqCst);
        let mut b=a.clone(); b.shortcut="Ctrl+Alt+Shift+F10".into(); b.capture_shortcut=Some("Ctrl+Alt+Shift+F11".into());
        apply_core(app,Action::SetSettings {settings:b.clone()},false)?;
        if state.shortcut_held.load(Ordering::SeqCst) { return Ok(false); }
        set_shortcut_recording(app,true)?;
        if app.global_shortcut().is_registered(b.shortcut.as_str()) || app.global_shortcut().is_registered(b.capture_shortcut.as_deref().unwrap()) { return Ok(false); }
        apply_core(app,Action::SetSettings {settings:a.clone()},false)?;
        set_shortcut_recording(app,false)?;
        let active=app.global_shortcut().is_registered(a.shortcut.as_str()) && app.global_shortcut().is_registered(a.capture_shortcut.as_deref().unwrap());
        // A → B → A works again, including captured-key guard reset.
        apply_core(app,Action::SetSettings {settings:b.clone()},false)?;
        apply_core(app,Action::SetSettings {settings:a.clone()},false)?;
        Ok(active && app.global_shortcut().is_registered(a.shortcut.as_str()) && app.global_shortcut().is_registered(a.capture_shortcut.as_deref().unwrap()))
    })();
    app.global_shortcut().unregister_all().ok();
    result.unwrap_or(false)
}

#[cfg(test)] mod list_picture_tests {
    use super::*;
    fn png(width: u32, height: u32, alpha: u8) -> Vec<u8> {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(width, height, image::Rgba([40, 90, 200, alpha]))).write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        bytes.into_inner()
    }
    #[test] fn sizes_keep_strips_tall_pages_wide_and_never_enlarge() {
        assert_eq!(thumbnail_size(1920, 1080), (560, 315));
        assert_eq!(thumbnail_size(2560, 100), (2560, 100));
        assert_eq!(thumbnail_size(600, 900), (560, 840));
        assert_eq!(thumbnail_size(140, 40), (140, 40));
        let (width, height) = thumbnail_size(1200, 30000);
        assert!(width * height <= 1_500_000 && height > 216);
    }
    #[test] fn opaque_images_become_jpeg_and_transparent_ones_stay_png() {
        let opaque = list_thumbnail(&png(1920, 1080, 255)).unwrap();
        assert_eq!(&opaque[..2], &[0xff, 0xd8]);
        assert!(opaque.len() < 30_000);
        let clear = list_thumbnail(&png(300, 200, 120)).unwrap();
        assert_eq!(&clear[..4], &[0x89, b'P', b'N', b'G']);
    }
}
