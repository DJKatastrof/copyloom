use serde::Serialize;
use std::{ffi::OsString, path::Path};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    enabled: bool,
    current_executable: bool,
}

// --background is retained as a legacy autostart marker.
pub fn autostart_requested(args: impl IntoIterator<Item = OsString>) -> bool {
    args.into_iter().any(|arg| arg == "--autostart" || arg == "--background")
}

fn command(executable: &Path) -> Result<String, String> {
    let path = executable.to_str().ok_or("Couldn't read Copyloom's path.")?;
    if !executable.is_absolute() || path.contains(['"', '\0']) {
        return Err("Copyloom's path can't be used to start with Windows.".into());
    }
    let command = format!("\"{}\" --autostart", path);
    if command.encode_utf16().count() > 260 {
        return Err("The path is too long for starting with Windows. Move the app to a shorter path.".into());
    }
    Ok(command)
}

#[cfg(windows)]
mod registry {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::{Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS}, System::Registry::*};
    pub const RUN: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(Some(0)).collect() }
    struct Key(HKEY);
    impl Drop for Key { fn drop(&mut self) { unsafe { RegCloseKey(self.0); } } }

    fn read_value(root: HKEY, subkey: &str, name: &str) -> Result<Option<String>, String> {
        let subkey = wide(subkey);
        let name = wide(name);
        let mut bytes = 0;
        let result = unsafe { RegGetValueW(root, subkey.as_ptr(), name.as_ptr(), RRF_RT_REG_SZ, null_mut(), null_mut(), &mut bytes) };
        if result == ERROR_FILE_NOT_FOUND { return Ok(None); }
        if result != ERROR_SUCCESS || bytes > 16_384 || bytes % 2 != 0 { return Err("Couldn't read Windows' startup entries.".into()); }
        let mut data = vec![0u16; (bytes as usize / 2).max(1)];
        let result = unsafe { RegGetValueW(root, subkey.as_ptr(), name.as_ptr(), RRF_RT_REG_SZ, null_mut(), data.as_mut_ptr().cast(), &mut bytes) };
        if result != ERROR_SUCCESS { return Err("Couldn't read Windows' startup entries.".into()); }
        let end = data.iter().position(|value| *value == 0).unwrap_or(data.len());
        String::from_utf16(&data[..end]).map(Some).map_err(|_| "Windows' startup entry contains an invalid path.".into())
    }

    pub fn read(subkey: &str) -> Result<Option<String>, String> { read_value(HKEY_CURRENT_USER, subkey, "Copyloom") }

    pub fn is_installed(executable: &std::path::Path) -> Result<bool, String> {
        let actual = std::fs::canonicalize(executable).map_err(|_| "Couldn't read the app's path.")?;
        for root in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
            if let Some(location) = read_value(root, "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Copyloom", "InstallLocation")? {
                let installed = std::path::Path::new(location.trim_matches('"')).join("copyloom.exe");
                if let Ok(installed) = std::fs::canonicalize(installed) {
                    if installed.to_string_lossy().to_lowercase() == actual.to_string_lossy().to_lowercase() { return Ok(true); }
                }
            }
        }
        Ok(false)
    }

    pub fn reconcile(subkey: &str, expected: &str, installed: bool) -> Result<super::Status, String> {
        let mut saved = read(subkey)?;
        let enabled = saved.as_ref().is_some_and(|value| !value.is_empty());
        if installed && enabled && saved.as_deref() != Some(expected) {
            write(subkey, expected, true)?; saved = Some(expected.into());
        }
        Ok(super::Status { enabled, current_executable: saved.as_deref() == Some(expected) })
    }

    pub fn write(subkey: &str, command: &str, enabled: bool) -> Result<(), String> {
        let subkey_wide = wide(subkey);
        let name = wide("Copyloom");
        let mut handle = null_mut();
        let result = unsafe {
            if enabled { RegCreateKeyExW(HKEY_CURRENT_USER, subkey_wide.as_ptr(), 0, null(), REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, null(), &mut handle, null_mut()) }
            else { RegOpenKeyExW(HKEY_CURRENT_USER, subkey_wide.as_ptr(), 0, KEY_SET_VALUE, &mut handle) }
        };
        if !enabled && result == ERROR_FILE_NOT_FOUND { return Ok(()); }
        if result != ERROR_SUCCESS { return Err("Windows did not allow the startup setting to change.".into()); }
        let key = Key(handle);
        let result = unsafe {
            if enabled {
                let data = wide(command);
                RegSetValueExW(key.0, name.as_ptr(), 0, REG_SZ, data.as_ptr().cast(), (data.len() * 2) as u32)
            } else { RegDeleteValueW(key.0, name.as_ptr()) }
        };
        if result != ERROR_SUCCESS && (enabled || result != ERROR_FILE_NOT_FOUND) { return Err("Couldn't save the startup setting in Windows.".into()); }
        let saved = read(subkey)?;
        if (enabled && saved.as_deref() != Some(command)) || (!enabled && saved.is_some()) { return Err("Windows couldn't confirm the startup setting. Try again.".into()); }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        struct Cleanup(String);
        impl Drop for Cleanup { fn drop(&mut self) { unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, wide(&self.0).as_ptr()); } } }
        #[test]
        fn registration_survives_readback_and_disable_preserves_other_values() {
            // Never touch the real Windows Run key in tests.
            let cleanup = Cleanup(format!("Software\\CopyloomTests\\{}", uuid::Uuid::new_v4()));
            let path = &cleanup.0;
            assert!(read(path).unwrap().is_none());
            let command = super::super::command(Path::new("C:\\Program Files\\Copyloom\\copyloom.exe")).unwrap();
            write(path, &command, true).unwrap();
            assert_eq!(read(path).unwrap().as_deref(), Some(command.as_str()));
            let mut raw = null_mut();
            assert_eq!(unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, wide(path).as_ptr(), 0, KEY_SET_VALUE, &mut raw) }, ERROR_SUCCESS);
            let key = Key(raw);
            let data = wide("keep");
            assert_eq!(unsafe { RegSetValueExW(key.0, wide("Unrelated").as_ptr(), 0, REG_SZ, data.as_ptr().cast(), (data.len() * 2) as u32) }, ERROR_SUCCESS);
            drop(key);
            write(path, &command, false).unwrap();
            assert!(read(path).unwrap().is_none());
            write(path, &command, false).unwrap();
            let mut bytes = 0;
            assert_eq!(unsafe { RegGetValueW(HKEY_CURRENT_USER, wide(path).as_ptr(), wide("Unrelated").as_ptr(), RRF_RT_REG_SZ, null_mut(), null_mut(), &mut bytes) }, ERROR_SUCCESS);
            write(path, &command.replace("copyloom.exe", "copyloom-new.exe"), true).unwrap();
            assert!(read(path).unwrap().unwrap().contains("copyloom-new.exe"));
        }
        #[test]
        fn repairs_enabled_registration_but_preserves_disabled_and_development_runs() {
            let cleanup = Cleanup(format!("Software\\CopyloomTests\\{}", uuid::Uuid::new_v4())); let path = &cleanup.0;
            let old = "\"C:\\old\\copyloom.exe\" --background";
            let current = "\"C:\\Program Files\\Copyloom\\copyloom.exe\" --autostart";
            assert!(!reconcile(path, current, true).unwrap().enabled); assert!(read(path).unwrap().is_none());
            write(path, old, true).unwrap();
            assert!(!reconcile(path, current, false).unwrap().current_executable); assert_eq!(read(path).unwrap().as_deref(), Some(old));
            assert!(reconcile(path, current, true).unwrap().current_executable); assert_eq!(read(path).unwrap().as_deref(), Some(current));
            assert!(reconcile(path, current, true).unwrap().enabled);
            write(path, current, false).unwrap(); assert!(!reconcile(path, current, true).unwrap().enabled); assert!(read(path).unwrap().is_none());
        }
        use std::path::Path;
    }
}

pub fn status() -> Result<Status, String> {
    #[cfg(windows)] {
        let expected = command(&std::env::current_exe().map_err(|_| "Couldn't read the app's path.")?)?;
        registry::reconcile(registry::RUN, &expected, registry::is_installed(&std::env::current_exe().map_err(|_| "Couldn't read the app's path.")?)?)
    }
    #[cfg(not(windows))] { Err("Starting with Windows is only available in the Windows app.".into()) }
}

pub fn set(enabled: bool) -> Result<Status, String> {
    #[cfg(windows)] {
        let expected = command(&std::env::current_exe().map_err(|_| "Couldn't read the app's path.")?)?;
        registry::write(registry::RUN, &expected, enabled)?;
        status()
    }
    #[cfg(not(windows))] { let _ = enabled; Err("Starting with Windows is only available in the Windows app.".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn autostart_flag_and_legacy_background_flag_are_exact() {
        assert!(autostart_requested([OsString::from("copyloom.exe"), OsString::from("--background")]));
        assert!(autostart_requested([OsString::from("--autostart")]));
        assert!(!autostart_requested([OsString::from("copyloom.exe"), OsString::from("--background-other")]));
    }
    #[cfg(windows)]
    #[test]
    fn command_quotes_unicode_paths_and_rejects_invalid_or_long_paths() {
        assert_eq!(command(Path::new("C:\\Mina program\\Åäö\\copyloom.exe")).unwrap(), "\"C:\\Mina program\\Åäö\\copyloom.exe\" --autostart");
        assert!(command(Path::new("relative.exe")).is_err());
        assert!(command(Path::new("C:\\bad\"name.exe")).is_err());
        assert!(command(Path::new(&format!("C:\\{}.exe", "a".repeat(260)))).is_err());
    }
}
