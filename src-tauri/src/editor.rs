use crate::{library::{Action, Clip, Settings}, lock_error, platform, RuntimeState};
use tauri::{Emitter, Manager};

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    pub id: String, pub capture: bool, pub requested_at: u64,
    // Used for the suggested file name in Save as.
    pub created_at: u64, pub source: Option<String>, pub custom_title: Option<String>,
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult { pub id: String, pub copied: bool, pub error: Option<String>, pub elapsed_ms: u128 }

// Each image gets its own window, so a new capture never waits behind unsaved work.
pub struct EditorWindow { id: String, serial: u64, request: OpenRequest, initialized: bool }

pub fn is_editor(label: &str) -> bool { label.starts_with("editor-") }

pub fn initialized(app: &tauri::AppHandle, label: &str) -> bool {
    app.state::<RuntimeState>().editors.lock().is_ok_and(|editors| editors.get(label).is_some_and(|editor| editor.initialized))
}

fn newest(app: &tauri::AppHandle, except: &str) -> Option<tauri::WebviewWindow> {
    let label = app.state::<RuntimeState>().editors.lock().ok()?.iter()
        .filter(|(label, editor)| editor.initialized && label.as_str() != except)
        .max_by_key(|(_, editor)| editor.serial).map(|(label, _)| label.clone())?;
    app.get_webview_window(&label)
}

pub fn save_newest(app: &tauri::AppHandle) {
    #[cfg(windows)]
    if let Some(window) = newest(app, "") { let _ = crate::window_state::save_editor(&window); }
    #[cfg(not(windows))]
    let _ = app;
}

// Called from a worker: window creation and all requests are serialized on the UI thread.
pub fn open(app: &tauri::AppHandle, id: String, capture: bool) -> Result<(), String> {
    {
        let state = app.state::<RuntimeState>();
        let library = state.library.lock().map_err(|_| lock_error())?;
        if !library.clips.iter().any(|clip| clip.id == id && clip.kind == "image") {
            return Err("The image is no longer in your history.".into());
        }
    }
    let handle = app.clone();
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || { let _ = send.send(open_on_main(&handle, id, capture)); }).map_err(|e| e.to_string())?;
    receive.recv().map_err(|e| e.to_string())?
}

fn open_on_main(app: &tauri::AppHandle, id: String, capture: bool) -> Result<(), String> {
    let requested_at = crate::library::now_ms();
    if app.get_webview_window("panel").is_some() {
        let epoch = crate::request_panel_close(app)?;
        crate::finish_hide_panel_on_main(app.clone(), epoch)?;
    }
    let state = app.state::<RuntimeState>();
    // Reopening an image focuses its window instead of starting a second, diverging edit.
    let existing = state.editors.lock().map_err(|_| lock_error())?.iter().find(|(_, editor)| editor.id == id).map(|(label, editor)| (label.clone(), editor.initialized));
    if let Some((label, initialized)) = existing {
        if let Some(window) = app.get_webview_window(&label) { if initialized { show(&window)?; } return Ok(()); }
    }
    let serial = state.editor_serial.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let label = format!("editor-{serial}");
    let (swedish, request) = {
        let library = state.library.lock().map_err(|_| lock_error())?;
        let clip = library.clips.iter().find(|clip| clip.id == id).ok_or("The image is no longer in your history.")?;
        (library.settings.language == "sv", OpenRequest { id: id.clone(), capture, requested_at, created_at: clip.created_at, source: clip.source_app.as_ref().map(|app| app.name.clone()), custom_title: clip.custom_title.then(|| clip.title.clone()) })
    };
    // The lock is released before building: window creation dispatches window events.
    state.editors.lock().map_err(|_| lock_error())?.insert(label.clone(), EditorWindow { id, serial, request, initialized: false });
    let probe = crate::startup::probe_dir();
    let mut builder = tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::App("editor.html".into()))
        .additional_browser_args(crate::BROWSER_ARGS)
        .title(if swedish { "Bildredigering – Copyloom" } else { "Image editor – Copyloom" }).visible(false).skip_taskbar(false)
        .inner_size(640.0, 480.0).min_inner_size(640.0, 400.0)
        .resizable(true).decorations(true).disable_drag_drop_handler()
        // The measuring probe runs in the first window only; later windows are plain editors.
        .devtools(false).general_autofill_enabled(false).initialization_script(if probe.is_some() && serial == 1 { "window.__COPYLOOM_EDITOR_PROBE__ = true;" } else { "" });
    if let Some(dir) = &probe { builder = builder.data_directory(dir.join("webview")); }
    if let Some(monitor) = app.get_webview_window("main").and_then(|w| w.current_monitor().ok().flatten()) {
        let area = monitor.work_area(); let scale = monitor.scale_factor();
        builder = builder.position((area.position.x as f64 + 32.0) / scale, (area.position.y as f64 + 32.0) / scale);
    }
    if let Err(error) = builder.build() {
        if let Ok(mut editors) = state.editors.lock() { editors.remove(&label); }
        return Err(error.to_string());
    }
    Ok(())
}

fn show(window: &tauri::WebviewWindow) -> Result<(), String> {
    if crate::startup::probe_dir().is_none() {
        window.show().map_err(|e| e.to_string())?;
        window.unminimize().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// The editor's 100% is one image pixel per screen pixel, so logical size shrinks with display scaling.
fn fitted_size(image: (u32, u32), scale: f64, available: (f64, f64)) -> (f64, f64) {
    ((image.0 as f64 / scale + 48.0).max(640.0).min(available.0),
     (image.1 as f64 / scale + 188.0).max(400.0).min(available.1))
}

#[tauri::command]
pub async fn editor_ready(app: tauri::AppHandle, window: tauri::WebviewWindow, width: u32, height: u32) -> Result<(), String> {
    if !is_editor(window.label()) { return Err("Wrong window.".into()); }
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    app.clone().run_on_main_thread(move || {
        let result = (|| -> Result<(), String> {
            let state = app.state::<RuntimeState>();
            if initialized(&app, window.label()) { return Ok(()); }
            // A new window takes the size of the newest open editor, offset so both stay visible.
            #[cfg(windows)]
            let restored = crate::startup::probe_dir().is_none() && crate::window_state::restore_editor(&window, newest(&app, window.label()).as_ref()).unwrap_or(false);
            #[cfg(not(windows))]
            let restored = false;
            if !restored {
                if let Some(monitor) = window.current_monitor().map_err(|e| e.to_string())? {
                    let area = monitor.work_area(); let scale = monitor.scale_factor();
                    let outer = window.outer_size().map_err(|e| e.to_string())?;
                    let inner = window.inner_size().map_err(|e| e.to_string())?;
                    let frame = (outer.width.saturating_sub(inner.width), outer.height.saturating_sub(inner.height));
                    let available = ((area.size.width as f64 - frame.0 as f64) / scale - 24.0, (area.size.height as f64 - frame.1 as f64) / scale - 24.0);
                    let size = fitted_size((width, height), scale, available);
                    window.set_min_size(Some(tauri::LogicalSize::new(640.0_f64.min(available.0), 400.0_f64.min(available.1)))).map_err(|e| e.to_string())?;
                    window.set_size(tauri::LogicalSize::new(size.0, size.1)).map_err(|e| e.to_string())?;
                    window.set_position(tauri::PhysicalPosition::new(area.position.x + ((area.size.width as f64 - size.0 * scale - frame.0 as f64) / 2.0).round() as i32, area.position.y + ((area.size.height as f64 - size.1 * scale - frame.1 as f64) / 2.0).round() as i32)).map_err(|e| e.to_string())?;
                }
            }
            if let Some(editor) = state.editors.lock().map_err(|_| lock_error())?.get_mut(window.label()) { editor.initialized = true; }
            show(&window)
        })();
        let _ = send.send(result);
    }).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || receive.recv().map_err(|e| e.to_string())?).await.map_err(|_| lock_error())?
}

#[tauri::command]
pub async fn open_editor(app: tauri::AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open(&app, id, false)).await.map_err(|_| lock_error())?
}

#[tauri::command]
pub fn editor_request(window: tauri::WebviewWindow, state: tauri::State<'_, RuntimeState>) -> Result<Option<OpenRequest>, String> {
    if !is_editor(window.label()) { return Err("Wrong window.".into()); }
    Ok(state.editors.lock().map_err(|_| lock_error())?.get(window.label()).map(|editor| editor.request.clone()))
}

#[tauri::command]
pub fn editor_settings(state: tauri::State<'_, RuntimeState>) -> Result<Settings, String> {
    Ok(state.library.lock().map_err(|_| lock_error())?.settings.clone())
}

#[tauri::command]
pub fn close_editor(window: tauri::WebviewWindow) -> Result<(), String> {
    if !is_editor(window.label()) { return Err("Wrong window.".into()); }
    #[cfg(windows)]
    crate::window_state::save_editor(&window)?;
    window.destroy().map_err(|e| e.to_string())
}

fn prepare_image(source: &Clip, png: &[u8]) -> Result<(Clip, image::RgbaImage), String> {
    if source.kind != "image" { return Err("The clip is not an image.".into()); }
    // Bound encoded bytes before allocating base64, then fully decode before committing.
    if png.len() > crate::library::MAX_IMAGE_CONTENT_BYTES / 4 * 3 { return Err("The image is too large to save.".into()); }
    let content = platform::png_content(png)?;
    let pixels = platform::decode_clip_image(png)?;
    let mut clip = Clip::captured(content);
    clip.title = "Edited image".into();
    clip.source_app = source.source_app.clone();
    Ok((clip, pixels))
}

// Persistence and clipboard are deliberately separate: clipboard failure never rolls back a saved clip.
fn persist_then_copy(clip: Clip, persist: impl FnOnce(Clip) -> Result<(), String>, copy: impl FnOnce() -> Result<(), String>) -> Result<SaveResult, String> {
    let start = std::time::Instant::now();
    let id = clip.id.clone();
    persist(clip)?;
    let error = copy().err();
    Ok(SaveResult { id, copied: error.is_none(), error, elapsed_ms: start.elapsed().as_millis() })
}

#[tauri::command]
pub async fn save_edited_image(app: tauri::AppHandle, window: tauri::WebviewWindow, request: tauri::ipc::Request<'_>) -> Result<SaveResult, String> {
    if !is_editor(window.label()) { return Err("Wrong window.".into()); }
    let source_id = request.headers().get("x-source-id").and_then(|value| value.to_str().ok()).ok_or("The image ID is missing.")?.to_owned();
    let replaces = request.headers().get("x-replace-id").and_then(|value| value.to_str().ok()).map(str::to_owned);
    let png = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) if bytes.len() <= crate::library::MAX_IMAGE_CONTENT_BYTES / 4 * 3 => bytes.clone(),
        _ => return Err("Invalid or too large image transfer.".into()),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let start = std::time::Instant::now();
        let state = app.state::<RuntimeState>();
        let mut source = state.library.lock().map_err(|_| lock_error())?.clips.iter().find(|clip| clip.id == source_id).map(|clip| clip.as_ref().clone()).ok_or("The original image is no longer in your history. Your edits are still in the window.")?;
        if let Some(source_app) = &mut source.source_app {
            if source_app.icon.as_ref().is_some_and(|icon| icon.starts_with("copyloom-icon:")) {
                use base64::Engine;
                let storage = state.storage.lock().map_err(|_| lock_error())?;
                source_app.icon = storage.as_ref().and_then(|storage| storage.read_media(&source_app.id, true).ok()).map(|png| format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)));
            }
        }
        let (mut clip, pixels) = prepare_image(&source, &png)?;
        if state.library.lock().map_err(|_| lock_error())?.settings.language != "sv" { clip.title = "Edited image".into(); }
        let content = clip.content.clone();
        let mut result = persist_then_copy(clip, |clip| crate::apply_core(&app, Action::AddEditedImage { clip, replaces }, false).map(|_| ()), || {
            *state.last_content.lock().map_err(|_| lock_error())? = Some((content, None));
            if crate::startup::probe_dir().is_some() {
                // Exercise the real fallback preparation without changing the user's clipboard.
                #[cfg(windows)]
                let _ = platform::windows::dibv5(pixels.width() as usize, pixels.height() as usize, pixels.as_raw())?;
                return Ok(());
            }
            platform::write_image(&png, pixels.width() as usize, pixels.height() as usize, pixels.as_raw())
        })?;
        result.elapsed_ms = start.elapsed().as_millis();
        Ok(result)
    }).await.map_err(|_| lock_error())?
}

#[tauri::command]
pub fn editor_probe_report(app: tauri::AppHandle, report: serde_json::Value) -> Result<(), String> {
    let dir = crate::startup::probe_dir().ok_or("Measuring mode is not active.")?;
    std::fs::write(dir.join("editor-performance.json"), serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    crate::startup::mark("editor_frontend_verified");
    let _ = app.emit("editor:probe-completed", ());
    Ok(())
}

pub fn probe(app: &tauri::AppHandle) -> bool {
    use tauri::Listener;
    let result = (|| -> Result<(), String> {
        let width = 3840; let height = 2160;
        let pixels: Vec<u8> = (0..width * height).flat_map(|i| { let x = i % width; let y = i / width; [(x % 256) as u8, (y % 256) as u8, ((x / 16 + y / 16) % 256) as u8, 255] }).collect();
        let png = platform::encode_png(&arboard::ImageData { width, height, bytes: std::borrow::Cow::Borrowed(&pixels) })?;
        let mut clip = Clip::captured(platform::png_content(&png)?);
        let icon = platform::encode_png(&arboard::ImageData { width: 1, height: 1, bytes: std::borrow::Cow::Borrowed(&[0, 169, 230, 255]) })?;
        clip.source_app = Some(crate::library::SourceApp { id: "editor-probe".into(), name: "Editor probe".into(), icon: Some(platform::png_content(&icon)?) });
        let id = clip.id.clone();
        crate::apply_core(app, Action::AddEditedImage { clip, replaces: None }, false)?;
        drop(pixels); drop(png);
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        let listener = app.listen("editor:probe-completed", move |_| { let _ = send.try_send(()); });
        let opened = open(app, id.clone(), false);
        let completed = opened.and_then(|_| receive.recv_timeout(std::time::Duration::from_secs(25)).map_err(|e| e.to_string()));
        app.unlisten(listener);
        completed?;
        let path = crate::startup::probe_dir().unwrap().join("editor-performance.json");
        let report: serde_json::Value = serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        if report["error"].is_string() || report["saved"] != true || report["width"] != 3840 || report["height"] != 2160 { return Err(format!("Editor probe: {report}")); }
        {
            let state = app.state::<RuntimeState>();
            let library = state.library.lock().map_err(|_| lock_error())?;
            let saved_id = report["originalSavedId"].as_str().ok_or("Original save id missing")?;
            let source = library.clips.iter().find(|clip| clip.id == id).ok_or("Original missing")?;
            let saved = library.clips.iter().find(|clip| clip.id == saved_id).ok_or("Saved image missing")?;
            if source.id == saved.id || saved.title != "Edited image" || saved.source_app != source.source_app { return Err("Edited metadata differs".into()); }
            let storage = state.storage.lock().map_err(|_| lock_error())?;
            let storage = storage.as_ref().ok_or("Storage missing")?;
            if storage.read_media(&id, false)? != storage.read_media(saved_id, false)? { return Err("Original bytes changed".into()); }
            let exported = platform::decode_clip_image(&storage.read_media(report["savedId"].as_str().ok_or("Export missing")?, false)?)?;
            if exported.dimensions() != (3840, 2160) || exported.get_pixel(400, 850).0 != [0, 0, 0, 255] { return Err("Export pixels differ".into()); }
        }
        // A second image opens its own window; opening it again focuses that window.
        let second_id = report["savedId"].as_str().ok_or("Export missing")?.to_owned();
        open(app, second_id.clone(), false)?; open(app, second_id.clone(), false)?;
        let labels = || -> Result<Vec<(String, String, bool)>, String> {
            let state = app.state::<RuntimeState>();
            let editors = state.editors.lock().map_err(|_| lock_error())?;
            let mut labels: Vec<_> = editors.iter().map(|(label, editor)| (editor.serial, label.clone(), editor.id.clone(), editor.initialized)).collect();
            labels.sort(); Ok(labels.into_iter().map(|(_, label, id, initialized)| (label, id, initialized)).collect())
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while !labels()?.iter().all(|(_, _, initialized)| *initialized) && std::time::Instant::now() < deadline { std::thread::sleep(std::time::Duration::from_millis(20)); }
        let windows = labels()?;
        if windows.len() != 2 || windows[0].1 != id || windows[1].1 != second_id || !windows.iter().all(|(_, _, initialized)| *initialized) { return Err(format!("Editor windows: {windows:?}")); }
        let [first, second] = [&windows[0].0, &windows[1].0].map(|label| app.get_webview_window(label));
        let (Some(first), Some(second)) = (first, second) else { return Err("Editor window missing".into()); };
        #[cfg(windows)]
        {
            let (send, receive)=std::sync::mpsc::sync_channel(1); let (a, b)=(first.clone(), second.clone());
            app.run_on_main_thread(move || {
                let taskbar=[&a, &b].iter().all(|window| window.hwnd().is_ok_and(|hwnd| platform::windows::on_taskbar(hwnd.0 as isize)));
                let _=send.send(if taskbar { crate::window_state::probe_editor(&a, &b) } else { Err("Editor window is not on the taskbar".into()) });
            }).map_err(|e|e.to_string())?;
            receive.recv_timeout(std::time::Duration::from_secs(5)).map_err(|e|e.to_string())??;
            crate::startup::mark("editor_size_restored");
            crate::startup::mark("editor_windows_verified");
        }
        first.destroy().map_err(|e| e.to_string())?; second.destroy().map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(error) = &result {
        if let Some(dir) = crate::startup::probe_dir() { let _ = std::fs::write(dir.join("editor-probe-error.txt"), error); }
    }
    result.is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::ImageEncoder;
    #[test]
    fn initial_size_fits_small_images_and_caps_large_images_to_work_area() {
        assert_eq!(fitted_size((758, 614), 1.0, (1900.0, 1000.0)), (806.0, 802.0));
        assert_eq!(fitted_size((1137, 921), 1.5, (1900.0, 1000.0)), (806.0, 802.0));
        assert_eq!(fitted_size((100, 60), 1.0, (1900.0, 1000.0)), (640.0, 400.0));
        assert_eq!(fitted_size((3840, 2160), 1.0, (1200.0, 680.0)), (1200.0, 680.0));
        assert_eq!(fitted_size((100, 60), 1.0, (600.0, 350.0)), (600.0, 350.0));
    }
    #[test]
    fn only_numbered_editor_windows_are_editors() {
        assert!(is_editor("editor-1")); assert!(is_editor("editor-27"));
        assert!(!is_editor("editor")); assert!(!is_editor("main")); assert!(!is_editor("panel"));
    }
    fn image() -> (Clip, Vec<u8>) {
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png).write_image(&[21, 42, 63, 255], 1, 1, image::ExtendedColorType::Rgba8).unwrap();
        let mut clip = Clip::captured(platform::png_content(&png).unwrap());
        clip.source_app = Some(crate::library::SourceApp { id: "test-app".into(), name: "Test".into(), icon: None });
        (clip, png)
    }
    #[test]
    fn validates_decoded_image_and_keeps_source() {
        let (source, png) = image(); let (clip, pixels) = prepare_image(&source, &png).unwrap();
        assert_eq!(clip.title, "Edited image"); assert_eq!(clip.source_app, source.source_app);
        assert_ne!(clip.id, source.id); assert_eq!(pixels.dimensions(), (1, 1));
        assert!(prepare_image(&source, b"invalid").is_err());
        assert!(prepare_image(&source, &png[..33]).is_err()); // Valid header, truncated pixels.
        let mut huge = png.clone(); huge[16..20].copy_from_slice(&100_000u32.to_be_bytes());
        assert!(prepare_image(&source, &huge).is_err());
    }
    #[test]
    fn unchanged_image_is_new_clip_and_clipboard_failure_preserves_it() {
        let (source, png) = image(); let mut library = crate::library::Library::default();
        library.apply(Action::AddClip { clip: source.clone() }).unwrap();
        let (clip, _) = prepare_image(&source, &png).unwrap();
        let result = persist_then_copy(clip, |clip| library.apply(Action::AddEditedImage { clip, replaces: None }), || Err("Upptaget".into())).unwrap();
        assert!(!result.copied); assert_eq!(library.clips.len(), 2); assert_eq!(library.clips[0].id, result.id);
        let (clip, _) = prepare_image(&source, &png).unwrap();
        assert!(persist_then_copy(clip, |_| Err("Diskfel".into()), || panic!("Must not copy after failed persistence")).is_err());
    }
    #[test]
    fn editor_setting_defaults_off_and_survives_preferences() {
        let old = r#"{"shortcut":"Ctrl+Shift+V","retentionDays":30,"theme":"system"}"#;
        assert!(!serde_json::from_str::<Settings>(old).unwrap().edit_after_capture);
        let dir = std::env::temp_dir().join(format!("copyloom-editor-{}", uuid::Uuid::new_v4()));
        let mut library = crate::library::Library::default(); library.settings.edit_after_capture = true;
        crate::preferences::save(&dir.join("preferences.json"), &library).unwrap();
        assert!(crate::preferences::load(&dir.join("preferences.json")).unwrap().unwrap().settings.edit_after_capture);
        assert_eq!(library.settings.language, "en");
        library.settings.language = "sv".into();
        library.settings.capture_behavior = Some("choose".into());
        crate::preferences::save(&dir.join("preferences.json"), &library).unwrap();
        let read = crate::preferences::load(&dir.join("preferences.json")).unwrap().unwrap();
        assert_eq!(read.settings.language, "sv");
        assert_eq!(read.settings.capture_behavior.as_deref(), Some("choose"));
        library.settings.language = "invalid".into(); assert!(crate::library::validate_settings(&library.settings).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
