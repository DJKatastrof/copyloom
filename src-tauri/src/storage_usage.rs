//! Read-only counts and sizes of the current history and Copyloom-owned local files.
use crate::{lock_error, RuntimeState};
use serde::Serialize;
use std::{collections::HashSet, ffi::OsString, path::{Path, PathBuf}};
use tauri::Manager;

const FAILED: &str = "Could not read storage usage. Check that the data folder is available and try again.";

#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    clip_count: u64,
    image_count: u64,
    image_bytes: u64,
    database_bytes: u64,
    backup_count: u64,
    backup_bytes: u64,
    other_bytes: u64,
}

fn disk_usage(dir: &Path) -> Result<Usage, String> {
    let copies: HashSet<OsString> = crate::storage_transfer::backup_files(dir).into_iter()
        .filter_map(|path| path.file_name().map(OsString::from)).collect();
    let mut usage = Usage::default(); let mut database_found = false;
    for entry in std::fs::read_dir(dir).map_err(|_| FAILED)? {
        let entry = entry.map_err(|_| FAILED)?;
        if !entry.file_type().map_err(|_| FAILED)?.is_file() { continue; }
        let name = entry.file_name(); let Some(name) = name.to_str() else { continue; };
        let base = ["-wal", "-shm", "-journal"].iter().find_map(|suffix| name.strip_suffix(suffix)).unwrap_or(name);
        let category = if base == "library.db" { 0 }
            else if base == "library-key.dpapi" { 2 }
            else if copies.contains(std::ffi::OsStr::new(base)) { if base.starts_with("library.damaged-") { 2 } else { 1 } }
            else { continue; };
        let size = match entry.metadata() {
            Ok(metadata) => metadata.len(),
            // A WAL file can disappear after a checkpoint; it no longer occupies disk space.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err(FAILED.into()),
        };
        match category {
            0 => { usage.database_bytes += size; if name == "library.db" { database_found = true; } },
            1 => { usage.backup_bytes += size; if name == base { usage.backup_count += 1; } },
            _ => usage.other_bytes += size,
        }
    }
    if !database_found { return Err(FAILED.into()); }
    Ok(usage)
}

#[tauri::command]
pub async fn get_storage_usage(app: tauri::AppHandle) -> Result<Usage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<RuntimeState>();
        let _maintenance = state.storage_maintenance.lock().map_err(|_| lock_error())?;
        let dir = {
            let library = state.library.lock().map_err(|_| lock_error())?;
            if library.storage != "encrypted" { return Err(FAILED.into()); }
            PathBuf::from(library.storage_path.as_ref().ok_or(FAILED)?)
        };
        let storage = state.storage.lock().map_err(|_| lock_error())?;
        let content = storage.as_ref().ok_or(FAILED)?.content_usage()?;
        let mut usage = disk_usage(&dir)?;
        usage.clip_count = content.clip_count; usage.image_count = content.image_count; usage.image_bytes = content.image_bytes;
        Ok(usage)
    }).await.map_err(|_| lock_error())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn counts_owned_files_and_sidecars_without_double_counting_images_or_unrelated_files() {
        let dir = std::env::temp_dir().join(format!("copyloom-usage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let copy = format!("library.before-restore-{}.db", uuid::Uuid::new_v4());
        for (name, bytes) in [("library.db", 100), ("library.db-wal", 50), ("library.db-shm", 20), ("library-key.dpapi", 10), ("library.backup-20261009T120000Z.bak", 100), ("library.schema-v3.bak", 60), (&copy, 80), ("library.damaged-20261008T120000Z.db", 90), ("personal.txt", 500), ("export.copyloom", 800), ("library.backup-invalid.bak", 700), ("library.backup-20261009T120001Z.bak.tmp", 900)] {
            std::fs::write(dir.join(name), vec![0; bytes]).unwrap();
        }
        std::fs::create_dir(dir.join("library.backup-20261009T120002Z.bak")).unwrap();
        std::fs::write(dir.join(format!("{copy}-wal")), [0; 16]).unwrap();
        std::fs::write(dir.join("library.damaged-20261008T120000Z.db-shm"), [0; 8]).unwrap();
        let before = std::fs::read(dir.join("library.db")).unwrap();
        let usage = disk_usage(&dir).unwrap();
        assert_eq!((usage.database_bytes, usage.backup_count, usage.backup_bytes, usage.other_bytes), (170, 3, 256, 108));
        assert_eq!(std::fs::read(dir.join("library.db")).unwrap(), before);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn missing_database_or_folder_is_an_error_instead_of_zero_usage() {
        let dir = std::env::temp_dir().join(format!("copyloom-usage-{}", uuid::Uuid::new_v4()));
        assert!(disk_usage(&dir).is_err());
        std::fs::create_dir_all(&dir).unwrap(); assert!(disk_usage(&dir).is_err());
        std::fs::write(dir.join("library.db-wal"), [0; 16]).unwrap(); assert!(disk_usage(&dir).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
