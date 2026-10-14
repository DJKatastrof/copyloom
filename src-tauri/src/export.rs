//! Save as: writes a decrypted PNG to a file the user picks. History in the database is untouched.
use crate::{lock_error, RuntimeState};
use tauri::Manager;

fn is_png(bytes: &[u8]) -> bool { bytes.starts_with(b"\x89PNG\r\n\x1a\n") }

// Header values are ASCII, so the editor percent-encodes names such as "Kvitto å.png".
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes(); let mut out = Vec::with_capacity(bytes.len()); let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(a), Some(b)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) { out.push((a * 16 + b) as u8); i += 3; continue; }
        }
        out.push(bytes[i]); i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A Windows-safe file name with a .png extension; reserved characters and device names are replaced.
fn file_name(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { '-' } else { c }).collect();
    let mut stem = cleaned.trim().trim_end_matches(".png").trim_end_matches(".PNG").trim_end_matches(['.', ' ']).chars().take(120).collect::<String>();
    stem = stem.trim_end_matches(['.', ' ']).to_owned();
    let reserved = ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"];
    if stem.is_empty() || reserved.iter().any(|device| device.eq_ignore_ascii_case(stem.split('.').next().unwrap_or(""))) { stem = format!("Copyloom {stem}").trim().to_owned(); }
    stem + ".png"
}

#[cfg(not(windows))]
fn choose_path(_: isize, _: &str, _: Option<std::path::PathBuf>, _: bool) -> Result<Option<std::path::PathBuf>, String> { Err("Save as is available in the Windows app.".into()) }
#[cfg(windows)]
fn owner(window: &tauri::WebviewWindow) -> Result<isize, String> { Ok(window.hwnd().map_err(|e| e.to_string())?.0 as isize) }
#[cfg(not(windows))]
fn owner(_: &tauri::WebviewWindow) -> Result<isize, String> { Ok(0) }
// The common dialog needs a single-threaded COM apartment; a dedicated thread keeps the UI thread's loop untouched.
#[cfg(windows)]
fn choose_path(owner: isize, name: &str, initial: Option<std::path::PathBuf>, swedish: bool) -> Result<Option<std::path::PathBuf>, String> {
    let name = name.to_owned();
    std::thread::spawn(move || unsafe {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        use windows_sys::Win32::{System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE}, UI::Controls::Dialogs::*};
        let initialized = CoInitializeEx(std::ptr::null(), (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32) >= 0;
        let mut file = vec![0u16; 32768];
        for (slot, unit) in file.iter_mut().zip(name.encode_utf16().take(32000)) { *slot = unit; }
        let filter: Vec<u16> = format!("{}\0*.png\0\0", if swedish { "PNG-bild (*.png)" } else { "PNG image (*.png)" }).encode_utf16().collect();
        let extension: Vec<u16> = "png\0".encode_utf16().collect();
        // Passing the same initial folder every time lets Windows reopen the folder the user chose last.
        let folder: Option<Vec<u16>> = initial.map(|path| path.as_os_str().encode_wide().chain(Some(0)).collect());
        let mut dialog: OPENFILENAMEW = std::mem::zeroed();
        dialog.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32;
        dialog.hwndOwner = owner as _;
        dialog.lpstrFilter = filter.as_ptr();
        dialog.nFilterIndex = 1;
        dialog.lpstrFile = file.as_mut_ptr();
        dialog.nMaxFile = file.len() as u32;
        dialog.lpstrInitialDir = folder.as_ref().map_or(std::ptr::null(), |folder| folder.as_ptr());
        dialog.lpstrDefExt = extension.as_ptr();
        dialog.Flags = OFN_EXPLORER | OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR | OFN_HIDEREADONLY;
        let chosen = GetSaveFileNameW(&mut dialog) != 0;
        let error = if chosen { 0 } else { CommDlgExtendedError() };
        if initialized { CoUninitialize(); }
        if !chosen { return if error == 0 { Ok(None) } else { Err(format!("Couldn't open the save dialog ({error:#x}).")) }; }
        let length = file.iter().position(|unit| *unit == 0).unwrap_or(file.len());
        Ok(Some(std::path::PathBuf::from(std::ffi::OsString::from_wide(&file[..length]))))
    }).join().map_err(|_| "The save dialog closed unexpectedly.".to_string())?
}

fn write(path: &std::path::Path, png: &[u8]) -> Result<(), String> {
    std::fs::write(path, png).map_err(|error| format!("The image could not be saved as a file: {error}"))
}

async fn save(app: &tauri::AppHandle, owner: isize, name: String, png: Vec<u8>) -> Result<Option<String>, String> {
    if !is_png(&png) || png.len() > crate::library::MAX_IMAGE_CONTENT_BYTES / 4 * 3 { return Err("Invalid or too large image.".into()); }
    let swedish = app.state::<RuntimeState>().library.lock().map_err(|_| lock_error())?.settings.language == "sv";
    let initial = app.path().picture_dir().ok();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = choose_path(owner, &file_name(&name), initial, swedish)? else { return Ok(None); };
        write(&path, &png)?;
        Ok(Some(path.to_string_lossy().into_owned()))
    }).await.map_err(|_| lock_error())?
}

/// Editor: saves what is on screen, with annotations, at the original resolution.
#[tauri::command]
pub async fn save_image_file(app: tauri::AppHandle, window: tauri::WebviewWindow, request: tauri::ipc::Request<'_>) -> Result<Option<String>, String> {
    if !crate::editor::is_editor(window.label()) { return Err("Wrong window.".into()); }
    let name = request.headers().get("x-file-name").and_then(|value| value.to_str().ok()).map(percent_decode).unwrap_or_default();
    let tauri::ipc::InvokeBody::Raw(png) = request.body() else { return Err("Invalid or too large image.".into()); };
    let owner = owner(&window)?;
    save(&app, owner, name, png.clone()).await
}

/// Library and quick panel: saves the stored original without opening the editor.
#[tauri::command]
pub async fn save_clip_image(app: tauri::AppHandle, window: tauri::WebviewWindow, id: String, name: String) -> Result<Option<String>, String> {
    let owner = match window.label() {
        "main" => owner(&window)?,
        "panel" => {
            // The panel hides on blur; close it first so it does not fight the dialog for focus.
            let (send, receive) = std::sync::mpsc::sync_channel(1); let handle = app.clone();
            app.run_on_main_thread(move || { let _ = send.send(crate::request_panel_close(&handle).and_then(|epoch| crate::finish_hide_panel_on_main(handle.clone(), epoch))); }).map_err(|e| e.to_string())?;
            receive.recv().map_err(|e| e.to_string())??;
            0
        }
        _ => return Err("Wrong window.".into()),
    };
    let handle = app.clone();
    let png = tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<RuntimeState>();
        let storage = state.storage.lock().map_err(|_| lock_error())?;
        storage.as_ref().ok_or("The database is not available.")?.read_media(&id, false)
    }).await.map_err(|_| lock_error())??;
    save(&app, owner, name, png).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn names_are_safe_windows_png_files() {
        assert_eq!(file_name("Copyloom 2026-10-07 103512.png"), "Copyloom 2026-10-07 103512.png");
        assert_eq!(file_name("Kvitto: mars/april?"), "Kvitto- mars-april-.png");
        assert_eq!(file_name("  rapport.  "), "rapport.png");
        assert_eq!(file_name("CON"), "Copyloom CON.png"); assert_eq!(file_name("nul.txt"), "Copyloom nul.txt.png");
        assert_eq!(file_name(""), "Copyloom.png"); assert_eq!(file_name("rad\nbrytning"), "rad-brytning.png");
        assert_eq!(file_name(&"å".repeat(300)).chars().count(), 124);
    }
    #[test]
    fn header_names_decode_percent_encoded_utf8() {
        assert_eq!(percent_decode("Kvitto%20%C3%A5%C3%A4%C3%B6.png"), "Kvitto åäö.png");
        assert_eq!(percent_decode("100%"), "100%"); assert_eq!(percent_decode("%zz%4"), "%zz%4");
    }
    #[test]
    fn writes_only_valid_pngs_and_reports_unwritable_paths() {
        let png = crate::platform::encode_png(&arboard::ImageData { width: 2, height: 1, bytes: std::borrow::Cow::Borrowed(&[1, 2, 3, 255, 4, 5, 6, 255]) }).unwrap();
        assert!(is_png(&png)); assert!(!is_png(b"GIF89a"));
        let dir = std::env::temp_dir().join(format!("copyloom-export-{}", uuid::Uuid::new_v4())); std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(file_name("Kvitto å"));
        write(&path, &png).unwrap(); assert_eq!(std::fs::read(&path).unwrap(), png);
        assert!(write(&dir.join("saknas").join("x.png"), &png).unwrap_err().starts_with("The image could not be saved as a file"));
        std::fs::remove_dir_all(dir).unwrap();
    }
    // Opens the real dialog and drives it; run explicitly with `cargo test -- --ignored save_dialog`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn save_dialog_returns_the_chosen_path_and_none_on_cancel() {
        use windows_sys::Win32::UI::WindowsAndMessaging::*;
        let dir = std::env::temp_dir().join(format!("copyloom-dialog-{}", uuid::Uuid::new_v4())); std::fs::create_dir_all(&dir).unwrap();
        let drive = |accept: bool| { std::thread::spawn(move || unsafe {
            let class: Vec<u16> = "#32770\0".encode_utf16().collect();
            for _ in 0..100 {
                std::thread::sleep(std::time::Duration::from_millis(100));
                let mut found = std::ptr::null_mut(); let pid = std::process::id();
                let mut next = FindWindowW(class.as_ptr(), std::ptr::null());
                while !next.is_null() { let mut owner = 0; windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(next, &mut owner); if owner == pid { found = next; break; } next = FindWindowExW(std::ptr::null_mut(), next, class.as_ptr(), std::ptr::null()); }
                if !found.is_null() { std::thread::sleep(std::time::Duration::from_millis(300)); PostMessageW(found, WM_COMMAND, if accept { 1 } else { 2 }, 0); return; }
            }
        }) };
        let robot = drive(true);
        let chosen = choose_path(0, "Copyloom test.png", Some(dir.clone()), true).unwrap();
        robot.join().unwrap();
        // Windows may return the long form of a short (8.3) temp path; the file must land in the same folder.
        write(&chosen.unwrap(), b"test").unwrap(); assert!(dir.join("Copyloom test.png").exists());
        let robot = drive(false);
        assert_eq!(choose_path(0, "Avbryt.png", Some(dir.clone()), false).unwrap(), None);
        robot.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
}
