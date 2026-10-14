//! Win+V for the quick panel. Windows keeps Win+V for its own clipboard history; Explorer
//! releases a Win shortcut whose letter is listed in the per-user DisabledHotkeys value, after
//! Explorer restarts. Restoring removes the letter again. Nothing here needs administrator rights.

pub const SHORTCUT: &str = "Super+V";

/// The letters in DisabledHotkeys with V added or removed; other letters stay as they were.
pub fn edit_letters(current: &str, release: bool) -> String {
    let mut letters: String = current.chars().filter(|letter| !letter.eq_ignore_ascii_case(&'v')).collect();
    if release { letters.push('V'); }
    letters
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status { pub released: bool, pub registered: bool }

#[cfg(windows)]
mod registry {
    use std::ptr::null_mut;
    use windows_sys::Win32::{Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS}, System::Registry::*};
    const ADVANCED: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced";
    // Remembers that Copyloom, not the user or another tool, released Win+V, so uninstalling can give it back.
    const OWN: &str = "Software\\Copyloom";
    fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(Some(0)).collect() }

    fn read(subkey: &str, name: &str) -> Result<Option<String>, String> {
        let (subkey, name) = (wide(subkey), wide(name));
        let mut bytes = 0;
        let result = unsafe { RegGetValueW(HKEY_CURRENT_USER, subkey.as_ptr(), name.as_ptr(), RRF_RT_REG_SZ, null_mut(), null_mut(), &mut bytes) };
        if result == ERROR_FILE_NOT_FOUND { return Ok(None); }
        if result != ERROR_SUCCESS || bytes > 4096 { return Err("Windows shortcuts could not be read.".into()); }
        let mut data = vec![0u16; (bytes as usize / 2).max(1)];
        if unsafe { RegGetValueW(HKEY_CURRENT_USER, subkey.as_ptr(), name.as_ptr(), RRF_RT_REG_SZ, null_mut(), data.as_mut_ptr().cast(), &mut bytes) } != ERROR_SUCCESS { return Err("Windows shortcuts could not be read.".into()); }
        let end = data.iter().position(|value| *value == 0).unwrap_or(data.len());
        Ok(Some(String::from_utf16_lossy(&data[..end])))
    }

    fn write(subkey: &str, name: &str, value: Option<&str>) -> Result<(), String> {
        let (subkey, name) = (wide(subkey), wide(name));
        let mut key = null_mut();
        if unsafe { RegCreateKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, std::ptr::null(), REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, std::ptr::null(), &mut key, null_mut()) } != ERROR_SUCCESS {
            return Err("Windows did not allow the shortcut to change.".into());
        }
        let result = unsafe {
            match value {
                Some(value) => { let data = wide(value); RegSetValueExW(key, name.as_ptr(), 0, REG_SZ, data.as_ptr().cast(), (data.len() * 2) as u32) }
                None => RegDeleteValueW(key, name.as_ptr()),
            }
        };
        unsafe { RegCloseKey(key); }
        if result != ERROR_SUCCESS && !(value.is_none() && result == ERROR_FILE_NOT_FOUND) { return Err("Windows did not allow the shortcut to change.".into()); }
        Ok(())
    }

    pub fn released() -> Result<bool, String> {
        Ok(read(ADVANCED, "DisabledHotkeys")?.is_some_and(|letters| letters.chars().any(|letter| letter.eq_ignore_ascii_case(&'v'))))
    }

    pub fn set_released(release: bool) -> Result<(), String> {
        let current = read(ADVANCED, "DisabledHotkeys")?.unwrap_or_default();
        let was_released = current.chars().any(|letter| letter.eq_ignore_ascii_case(&'v'));
        let letters = super::edit_letters(&current, release);
        write(ADVANCED, "DisabledHotkeys", (!letters.is_empty()).then_some(letters.as_str()))?;
        if release && !was_released { write(OWN, "ReleasedWinV", Some("1"))?; }
        if !release { write(OWN, "ReleasedWinV", None)?; }
        if released()? != release { return Err("Windows could not confirm the change. Try again.".into()); }
        Ok(())
    }
}

#[cfg(windows)]
pub use registry::{released, set_released};
#[cfg(not(windows))]
pub fn released() -> Result<bool, String> { Ok(false) }
#[cfg(not(windows))]
pub fn set_released(_: bool) -> Result<(), String> { Err("Finns bara i Windows-appen.".into()) }

/// Restarts the Windows shell so it reads DisabledHotkeys again. Open File Explorer windows close.
#[cfg(windows)]
pub fn restart_explorer() -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const NO_WINDOW: u32 = 0x0800_0000;
    let running = || std::process::Command::new("tasklist").args(["/FI", "IMAGENAME eq explorer.exe", "/NH"]).creation_flags(NO_WINDOW).output()
        .map(|output| String::from_utf8_lossy(&output.stdout).to_lowercase().contains("explorer.exe")).unwrap_or(false);
    // Only this user's shell can be ended without administrator rights.
    let _ = std::process::Command::new("taskkill").args(["/F", "/IM", "explorer.exe"]).creation_flags(NO_WINDOW).status();
    // Windows usually restarts its shell itself; starting a second one would open a folder window instead.
    for _ in 0..20 {
        std::thread::sleep(std::time::Duration::from_millis(150));
        if running() { return Ok(()); }
    }
    std::process::Command::new("explorer.exe").spawn().map(|_| ()).map_err(|_| "File Explorer could not start. Sign out and in again.".into())
}
#[cfg(not(windows))]
pub fn restart_explorer() -> Result<(), String> { Err("Finns bara i Windows-appen.".into()) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_v_is_added_or_removed_and_other_letters_stay() {
        assert_eq!(edit_letters("", true), "V");
        assert_eq!(edit_letters("XE", true), "XEV");
        assert_eq!(edit_letters("XvE", true), "XEV");
        assert_eq!(edit_letters("XVE", false), "XE");
        assert_eq!(edit_letters("V", false), "");
    }
}
