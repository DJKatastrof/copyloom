//! Explorer's per-user Win-key reservations. Each feature owns only its own letter.

pub fn edit_letters(current: &str, letter: char, release: bool) -> String {
    let mut letters: String = current.chars().filter(|value| !value.eq_ignore_ascii_case(&letter)).collect();
    if release { letters.push(letter.to_ascii_uppercase()); }
    letters
}

#[cfg(windows)]
mod registry {
    use std::ptr::null_mut;
    use windows_sys::Win32::{Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS}, System::Registry::*};
    const ADVANCED: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced";
    const OWN: &str = "Software\\Copyloom";
    static CHANGE: std::sync::Mutex<()> = std::sync::Mutex::new(());
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

    pub fn released(letter: char) -> Result<bool, String> {
        Ok(read(ADVANCED, "DisabledHotkeys")?.is_some_and(|letters| letters.chars().any(|value| value.eq_ignore_ascii_case(&letter))))
    }

    pub fn set_released(letter: char, marker: &str, release: bool) -> Result<(), String> {
        set_released_at(ADVANCED, OWN, letter, marker, release)
    }

    fn set_released_at(advanced: &str, own: &str, letter: char, marker: &str, release: bool) -> Result<(), String> {
        let _change = CHANGE.lock().map_err(|_| crate::lock_error())?;
        let original = read(advanced, "DisabledHotkeys")?;
        let ownership = read(own, marker)?;
        let was_released = original.as_deref().unwrap_or("").chars().any(|value| value.eq_ignore_ascii_case(&letter));
        let letters = super::edit_letters(original.as_deref().unwrap_or(""), letter, release);
        let change = (|| {
            if release && !was_released { write(own, marker, Some("1"))?; }
            write(advanced, "DisabledHotkeys", (!letters.is_empty()).then_some(letters.as_str()))?;
            if !release { write(own, marker, None)?; }
            let actual = read(advanced, "DisabledHotkeys")?.is_some_and(|letters| letters.chars().any(|value| value.eq_ignore_ascii_case(&letter)));
            if actual != release { return Err("Windows could not confirm the change. Try again.".into()); }
            Ok(())
        })();
        if let Err(error) = change {
            let restore = write(advanced, "DisabledHotkeys", original.as_deref())
                .and_then(|_| write(own, marker, ownership.as_deref()));
            return Err(match restore { Ok(()) => error, Err(restore) => format!("{error} Could not restore Windows shortcuts: {restore}") });
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn history_ownership_and_restoration_preserve_other_windows_shortcuts() {
            let root = format!("Software\\CopyloomTests\\{}", uuid::Uuid::new_v4());
            struct Cleanup(Vec<u16>);
            impl Drop for Cleanup { fn drop(&mut self) { unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, self.0.as_ptr()); } } }
            let _cleanup = Cleanup(wide(&root));
            let advanced = format!("{root}\\Advanced");
            let own = format!("{root}\\Own");
            write(&advanced, "DisabledHotkeys", Some("XS")).unwrap();
            set_released_at(&advanced, &own, 'V', "ReleasedWinV", true).unwrap();
            assert_eq!(read(&advanced, "DisabledHotkeys").unwrap().as_deref(), Some("XSV"));
            assert_eq!(read(&own, "ReleasedWinV").unwrap().as_deref(), Some("1"));
            set_released_at(&advanced, &own, 'V', "ReleasedWinV", false).unwrap();
            assert_eq!(read(&advanced, "DisabledHotkeys").unwrap().as_deref(), Some("XS"));
            assert_eq!(read(&own, "ReleasedWinV").unwrap(), None);
            write(&advanced, "DisabledHotkeys", Some("Sv")).unwrap();
            set_released_at(&advanced, &own, 'V', "ReleasedWinV", true).unwrap();
            assert_eq!(read(&own, "ReleasedWinV").unwrap(), None);
            assert_eq!(read(&advanced, "DisabledHotkeys").unwrap().as_deref(), Some("SV"));
        }
    }
}

#[cfg(windows)]
pub use registry::{released, set_released};
#[cfg(not(windows))]
pub fn released(_: char) -> Result<bool, String> { Ok(false) }
#[cfg(not(windows))]
pub fn set_released(_: char, _: &str, _: bool) -> Result<(), String> { Err("Screenshots are only available on Windows.".into()) }

#[cfg(windows)]
pub fn restart_explorer() -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetShellWindow, GetWindowThreadProcessId, IsHungAppWindow};
    let shell = unsafe { GetShellWindow() };
    if shell.is_null() { return Err("The Windows desktop is not available. Sign out and in again.".into()); }
    let mut process_id = 0;
    unsafe { GetWindowThreadProcessId(shell, &mut process_id); }
    if process_id == 0 { return Err("The Windows desktop is not available. Sign out and in again.".into()); }
    let explorer = std::env::var_os("WINDIR").map(|path| std::path::PathBuf::from(path).join("explorer.exe"))
        .ok_or("File Explorer could not start. Sign out and in again.")?;
    let status = std::process::Command::new("taskkill").args(["/F", "/PID", &process_id.to_string()])
        .creation_flags(0x0800_0000).output().map_err(|_| "File Explorer could not restart. Try again.")?;
    if !status.status.success() { return Err("File Explorer could not restart. Try again.".into()); }
    let ready = || unsafe {
        let window = GetShellWindow();
        !window.is_null() && IsHungAppWindow(window) == 0
    };
    for _ in 0..30 {
        std::thread::sleep(std::time::Duration::from_millis(150));
        if ready() { return Ok(()); }
    }
    std::process::Command::new(explorer).spawn().map_err(|_| "File Explorer could not start. Sign out and in again.")?;
    for _ in 0..100 {
        std::thread::sleep(std::time::Duration::from_millis(150));
        if ready() { return Ok(()); }
    }
    Err("File Explorer could not start. Sign out and in again.".into())
}
#[cfg(not(windows))]
pub fn restart_explorer() -> Result<(), String> { Err("Screenshots are only available on Windows.".into()) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn screenshot_and_history_letters_are_independent() {
        assert_eq!(edit_letters("V", 'S', true), "VS");
        assert_eq!(edit_letters("VS", 'S', false), "V");
        assert_eq!(edit_letters("VS", 'V', false), "S");
        assert_eq!(edit_letters("XsvE", 'S', true), "XvES");
        assert_eq!(edit_letters("XsvE", 'S', false), "XvE");
        assert_eq!(edit_letters("sS", 'S', true), "S");
        assert_eq!(edit_letters("S", 'S', false), "");
    }
}
