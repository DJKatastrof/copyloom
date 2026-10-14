use serde::Serialize;
use tauri::Manager;
use tauri_plugin_global_shortcut::GlobalShortcutExt;

pub const PRINT_SCREEN_CONFLICT: &str = "Windows is using Print Screen for screen capture. Turn it off in Windows settings → Accessibility → Keyboard, or choose another key in Copyloom.";

pub fn ensure_available(shortcut: &str, windows_enabled: Option<bool>) -> Result<(), String> {
    if shortcut.eq_ignore_ascii_case("PrintScreen") && windows_enabled == Some(true) {
        Err(PRINT_SCREEN_CONFLICT.into())
    } else { Ok(()) }
}

#[cfg(windows)]
fn read_at(subkey: &str) -> Result<Option<bool>, String> {
    use windows_sys::Win32::{Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS}, System::Registry::*};
    let key: Vec<u16> = subkey.encode_utf16().chain(Some(0)).collect();
    let name: Vec<u16> = "PrintScreenKeyForSnippingEnabled".encode_utf16().chain(Some(0)).collect();
    let mut value = 0u32;
    let mut bytes = 4;
    let result = unsafe { RegGetValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr(), RRF_RT_REG_DWORD, std::ptr::null_mut(), (&mut value as *mut u32).cast(), &mut bytes) };
    if result == ERROR_FILE_NOT_FOUND { return Ok(None); }
    if result != ERROR_SUCCESS || bytes != 4 { return Err("Could not read the Windows Print Screen setting.".into()); }
    // Missing/unrecognised values do not prove that Windows has released the key.
    Ok(match value { 0 => Some(false), 1 => Some(true), _ => None })
}

pub fn print_screen_enabled() -> Result<Option<bool>, String> {
    #[cfg(windows)] { read_at("Control Panel\\Keyboard") }
    #[cfg(not(windows))] { Ok(None) }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment { print_screen_enabled: Option<bool>, registered: bool }

#[tauri::command]
pub fn get_capture_environment(app: tauri::AppHandle) -> Result<Environment, String> {
    let state = app.state::<crate::RuntimeState>();
    let settings = state.library.lock().map_err(|_| crate::lock_error())?.settings.clone();
    Ok(Environment { print_screen_enabled: print_screen_enabled()?, registered: settings.capture_shortcut.as_deref().is_some_and(|key| app.global_shortcut().is_registered(key)) })
}

#[tauri::command]
pub async fn retry_capture_shortcut(app: tauri::AppHandle) -> Result<Environment, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::RuntimeState>();
        let _change = state.shortcut_change.lock().map_err(|_| crate::lock_error())?;
        if state.shortcut_recording.load(std::sync::atomic::Ordering::SeqCst) { return Err("Finish choosing a key first.".into()); }
        let settings = state.library.lock().map_err(|_| crate::lock_error())?.settings.clone();
        if let Some(key) = settings.capture_shortcut {
            ensure_available(&key, print_screen_enabled()?)?;
            if !app.global_shortcut().is_registered(key.as_str()) { crate::register_capture_shortcut(&app, &key)?; }
        }
        get_capture_environment(app.clone())
    }).await.map_err(|_| crate::lock_error())?
}

#[tauri::command]
pub fn open_keyboard_settings() -> Result<(), String> {
    shell_open("ms-settings:easeofaccess-keyboard").map_err(|_| "Could not open Windows settings. Open Accessibility → Keyboard manually.".into())
}

/// Opens a folder or settings URI the way Explorer would.
pub fn shell_open(target: &str) -> Result<(), ()> {
    #[cfg(windows)] {
        use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};
        let wide: Vec<u16> = target.encode_utf16().chain(Some(0)).collect();
        let result = unsafe { ShellExecuteW(std::ptr::null_mut(), std::ptr::null(), wide.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL) };
        if result as isize > 32 { Ok(()) } else { Err(()) }
    }
    #[cfg(not(windows))] { let _ = target; Err(()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn warns_only_for_known_enabled_print_screen() {
        assert!(ensure_available("PrintScreen", Some(true)).unwrap_err().contains("Accessibility"));
        assert!(ensure_available("F8", Some(true)).is_ok());
        assert!(ensure_available("Ctrl+PrintScreen", Some(true)).is_ok());
        assert!(ensure_available("PrintScreen", Some(false)).is_ok());
        assert!(ensure_available("PrintScreen", None).is_ok());
    }
    #[cfg(windows)]
    #[test]
    fn reads_enabled_disabled_and_unknown_without_touching_user_settings() {
        use windows_sys::Win32::{Foundation::ERROR_SUCCESS, System::Registry::*};
        let path = format!("Software\\CopyloomTests\\{}", uuid::Uuid::new_v4());
        let key: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
        let name: Vec<u16> = "PrintScreenKeyForSnippingEnabled".encode_utf16().chain(Some(0)).collect();
        struct Cleanup(Vec<u16>);
        impl Drop for Cleanup { fn drop(&mut self) { unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, self.0.as_ptr()); } } }
        let _cleanup = Cleanup(key.clone());
        assert_eq!(read_at(&path).unwrap(), None);
        unsafe {
            let mut handle = std::ptr::null_mut();
            assert_eq!(RegCreateKeyExW(HKEY_CURRENT_USER, key.as_ptr(), 0, std::ptr::null(), 0, KEY_SET_VALUE, std::ptr::null(), &mut handle, std::ptr::null_mut()), ERROR_SUCCESS);
            for (value, expected) in [(1u32, Some(true)), (0, Some(false)), (7, None)] {
                let result = RegSetValueExW(handle, name.as_ptr(), 0, REG_DWORD, (&value as *const u32).cast(), 4);
                assert_eq!(result, ERROR_SUCCESS);
                assert_eq!(read_at(&path).unwrap(), expected);
            }
            RegCloseKey(handle);
        }
    }
}
