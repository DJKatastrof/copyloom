use crate::library::{validate_settings, Category, Library, Settings};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    version: u32,
    settings: Settings,
    #[serde(default)]
    categories: Vec<Category>,
}

pub fn load(path: &Path) -> Result<Option<Library>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(path).map_err(|_| "Couldn't read the settings.".to_string())?;
    let prefs: Preferences = serde_json::from_slice(&bytes)
        .map_err(|_| "The settings file is damaged. Default settings are used.".to_string())?;
    if prefs.version != 1 {
        return Err("This version of the settings file isn't supported.".into());
    }
    validate_settings(&prefs.settings)?;
    let mut library = Library::default();
    library.settings = prefs.settings;
    for mut category in prefs.categories {
        category.clip_order.clear(); // Clipboard content is not persisted yet.
        library.apply(crate::library::Action::AddCategory { category })?;
    }
    Ok(Some(library))
}

pub fn save(path: &Path, library: &Library) -> Result<(), String> {
    let parent = path.parent().ok_or("The settings folder is missing.")?;
    std::fs::create_dir_all(parent)
        .map_err(|_| "Couldn't create the settings folder.".to_string())?;
    let prefs = Preferences {
        version: 1,
        settings: library.settings.clone(),
        categories: if library.storage == "encrypted" {
            vec![]
        } else {
            library.categories.clone()
        },
    };
    let bytes = serde_json::to_vec_pretty(&prefs)
        .map_err(|_| "Couldn't save the settings.".to_string())?;
    let temporary = path.with_extension("tmp");
    use std::io::Write;
    let mut file = std::fs::File::create(&temporary)
        .map_err(|_| "Couldn't save the settings.".to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Couldn't save the settings.".to_string())?;
    drop(file);
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let source: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
        let target: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        use windows_sys::Win32::Foundation::{GetLastError, ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION};
        let mut replaced = false;
        for attempt in 0..6 {
            if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) } != 0 { replaced = true; break; }
            let error = unsafe { GetLastError() };
            if ![ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION].contains(&error) || attempt == 5 { break; }
            std::thread::sleep(std::time::Duration::from_millis(5 << attempt));
        }
        if !replaced { return Err("Couldn't update the settings file.".into()); }

    }
    #[cfg(not(windows))]
    std::fs::rename(temporary, path)
        .map_err(|_| "Couldn't update the settings file.".to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preferences_survive_restart_and_replacement_without_clipboard_content() {
        let dir = std::env::temp_dir().join(format!("clip-prefs-{}", uuid::Uuid::new_v4()));
        let path = dir.join("preferences.json");
        assert!(load(&path).unwrap().is_none());
        let mut library = Library::default();
        library.settings.shortcut = "Ctrl+Shift+Super+V".into();
        library.settings.theme = "dark".into();
        library.settings.start_minimized = true;
        library.settings.paste_directly = false;
        library.settings.keep_categorized = true;
        library
            .apply(crate::library::Action::AddCategory {
                category: Category {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: "Arbete".into(),
                    color: "#b663e0".into(),
                    clip_order: vec![],
                },
            })
            .unwrap();
        library
            .clips
            .push(std::sync::Arc::new(crate::library::Clip::captured("secret-test-content".into())));
        save(&path, &library).unwrap();
        assert!(!std::fs::read_to_string(&path)
            .unwrap()
            .contains("secret-test-content"));
        let restored = load(&path).unwrap().unwrap();
        assert_eq!(restored.settings.shortcut, "Ctrl+Shift+Super+V");
        assert!(restored.settings.start_minimized);
        assert!(!restored.settings.paste_directly);
        assert!(restored.settings.keep_categorized);
        assert_eq!(restored.categories[0].name, "Arbete");
        assert!(restored.clips.is_empty());
        library.settings.retention_days = Some(14);
        library.settings.keep_categorized = false;
        save(&path, &library).unwrap();
        assert!(!load(&path).unwrap().unwrap().settings.keep_categorized);
        assert_eq!(
            load(&path).unwrap().unwrap().settings.retention_days,
            Some(14)
        );
        std::fs::write(&path, "invalid-json").unwrap();
        assert!(load(&path).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn previous_preferences_without_start_mode_keep_existing_settings() {
        let prefs: Preferences = serde_json::from_str(r#"{"version":1,"settings":{"shortcut":"Ctrl+Alt+K","retentionDays":90,"theme":"dark"},"categories":[]}"#).unwrap();
        assert!(!prefs.settings.start_minimized);
        assert!(!prefs.settings.keep_categorized);
        assert!(prefs.settings.paste_directly);
        assert_eq!(prefs.settings.shortcut, "Ctrl+Alt+K");
    }

    #[test]
    fn encrypted_mode_preferences_do_not_duplicate_database_categories() {
        let dir = std::env::temp_dir().join(format!("copyloom-prefs-{}", uuid::Uuid::new_v4()));
        let path = dir.join("preferences.json");
        let mut library = Library::default();
        library.storage = "encrypted".into();
        library.categories.push(Category {
            id: uuid::Uuid::new_v4().to_string(),
            name: "DatabaseOnly".into(),
            color: "#b663e0".into(),
            clip_order: vec![],
        });
        save(&path, &library).unwrap();
        let restored = load(&path).unwrap().unwrap();
        assert!(restored.categories.is_empty());
        assert!(!std::fs::read_to_string(&path)
            .unwrap()
            .contains("DatabaseOnly"));
        std::fs::remove_dir_all(dir).unwrap();
    }

}

#[cfg(all(test, windows))]
mod file_lock_tests {
    use super::*;
    use std::os::windows::fs::OpenOptionsExt;
    #[test]
    fn saves_after_a_brief_external_file_lock() {
        let dir = std::env::temp_dir().join(format!("copyloom-lock-{}", uuid::Uuid::new_v4()));
        let path = dir.join("preferences.json"); let mut library = Library::default(); save(&path, &library).unwrap();
        let held = std::fs::OpenOptions::new().read(true).share_mode(1).open(&path).unwrap();
        let unlock = std::thread::spawn(move || { std::thread::sleep(std::time::Duration::from_millis(45)); drop(held); });
        library.settings.paste_directly = false; save(&path, &library).unwrap(); unlock.join().unwrap();
        assert!(!load(&path).unwrap().unwrap().settings.paste_directly); std::fs::remove_dir_all(dir).unwrap();
    }
}
