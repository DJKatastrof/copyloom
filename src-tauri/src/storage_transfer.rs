//! Consistent encrypted exports and verified relocation. No decrypted clip files are written.
use crate::{library::Library, library_update::{defer_media, LibraryUpdate}, lock_error, storage::{key_hex, Storage, SCHEMA}, RuntimeState};
use rusqlite::{Connection, OpenFlags};
use std::{io::Write, path::{Path, PathBuf}};
use tauri::{Emitter, Manager};
use zeroize::Zeroizing;

const EXPORT_ID: i64 = 0x434c4f4d;
const FAILED: &str = "Could not transfer history. Check free space and file access. Existing history has not been replaced.";
const BAD_EXPORT: &str = "Could not open the export. Check the password and that the file is a complete Copyloom export.";
pub enum Secret<'a> { Raw(&'a [u8]), Password(&'a str) }
impl Secret<'_> {
    fn sql(&self) -> Zeroizing<String> {
        match self {
            Self::Raw(key) => Zeroizing::new(format!("\"x'{}'\"", &*key_hex(key))),
            Self::Password(password) => {
                // The fixed prefix also prevents a password that looks like SQLCipher's raw-key syntax.
                let mut quoted = Zeroizing::new(String::from("'copyloom-export-v1:"));
                for c in password.chars() { quoted.push(c); if c == '\'' { quoted.push(c); } }
                quoted.push('\''); quoted
            },
        }
    }
}
fn reader(path: &Path, key: &Secret<'_>) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(|_| BAD_EXPORT)?;
    unlock(&connection, key)?; Ok(connection)
}
fn unlock(connection: &Connection, key: &Secret<'_>) -> Result<(), String> {
    connection.execute_batch(&Zeroizing::new(format!("PRAGMA key={}; PRAGMA busy_timeout=5000; PRAGMA temp_store=MEMORY;", &*key.sql()))).map_err(|_| BAD_EXPORT)?;
    Ok(())
}
fn verify(connection: &Connection, exported: bool) -> Result<i64, String> {
    let schema: i64 = connection.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(|_| BAD_EXPORT)?;
    if !(1..=SCHEMA).contains(&schema) { return Err("This export database version is not supported. Update Copyloom and try again.".into()); }
    if exported && connection.query_row("PRAGMA application_id", [], |r| r.get::<_, i64>(0)).map_err(|_| BAD_EXPORT)? != EXPORT_ID { return Err(BAD_EXPORT.into()); }
    let check: String = connection.query_row("PRAGMA quick_check", [], |r| r.get(0)).map_err(|_| BAD_EXPORT)?;
    if check != "ok" { return Err(BAD_EXPORT.into()); }
    if connection.prepare("PRAGMA cipher_integrity_check").map_err(|_| BAD_EXPORT)?.query([]).map_err(|_| BAD_EXPORT)?.next().map_err(|_| BAD_EXPORT)?.is_some() { return Err(BAD_EXPORT.into()); }
    if connection.prepare("PRAGMA foreign_key_check").map_err(|_| BAD_EXPORT)?.query([]).map_err(|_| BAD_EXPORT)?.next().map_err(|_| BAD_EXPORT)?.is_some() { return Err(BAD_EXPORT.into()); }
    Ok(schema)
}
pub fn encrypted_copy(source: &Path, from: Secret<'_>, target: &Path, to: Secret<'_>, exported: bool) -> Result<(), String> {
    if target.exists() { return Err(FAILED.into()); }
    // ATTACH inherits the connection's open flags. Keep the existing source writable but never create it,
    // and reserve the destination explicitly before attaching it with the same no-create flags.
    let connection = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(|_| BAD_EXPORT)?;
    unlock(&connection, &from)?;
    let schema = verify(&connection, false)?;
    std::fs::OpenOptions::new().write(true).create_new(true).open(target).map_err(|_| FAILED)?;
    let target_name = target.to_string_lossy().replace('\'', "''");
    let result = (|| {
        let failure = |stage: &str, error: rusqlite::Error| { #[cfg(test)] eprintln!("transfer failed at {stage}: {:?}", error.sqlite_error_code()); #[cfg(not(test))] let _ = (stage, error); FAILED.to_string() };
        connection.execute_batch(&Zeroizing::new(format!("ATTACH DATABASE '{target_name}' AS transfer KEY {};", &*to.sql()))).map_err(|e| failure("attach", e))?;
        connection.execute_batch("BEGIN;").map_err(|e| failure("begin", e))?;
        connection.query_row("SELECT sqlcipher_export('transfer')", [], |_| Ok(())).map_err(|e| failure("export", e))?;
        connection.execute_batch(&format!("PRAGMA transfer.user_version={schema}; PRAGMA transfer.application_id={}; COMMIT; DETACH DATABASE transfer;", if exported { EXPORT_ID } else { 0 })).map_err(|e| failure("commit", e))?;
        verify(&reader(target, &to)?, exported)?;
        std::fs::OpenOptions::new().write(true).open(target).and_then(|f| f.sync_all()).map_err(|_| FAILED)?;
        Ok(())
    })();
    drop(connection);
    if result.is_err() { cleanup_database(target); }
    result
}

pub fn atomic_replace(from: &Path, to: &Path) -> Result<(), String> {
    #[cfg(windows)] {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};
        let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) } == 0 { return Err(FAILED.into()); }
        Ok(())
    }
    #[cfg(not(windows))] { std::fs::rename(from, to).map_err(|_| FAILED.into()) }
}
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|_| FAILED)?;
        file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|_| FAILED)?; drop(file);
        atomic_replace(&temporary, path)
    })();
    if result.is_err() { let _ = std::fs::remove_file(temporary); } result
}
fn sidecar(path: &Path, suffix: &str) -> PathBuf { let mut name = path.as_os_str().to_owned(); name.push(suffix); PathBuf::from(name) }
fn cleanup_database(path: &Path) { for p in [path.to_path_buf(), sidecar(path, "-wal"), sidecar(path, "-shm"), sidecar(path, "-journal")] { let _ = std::fs::remove_file(p); } }
pub(crate) fn backup_files(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<_> = crate::backup::list(dir).into_iter().map(|(_, p)| p).collect();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = entry.file_name(); let Some(name) = name.to_str() else { continue; };
        let schema = (1..SCHEMA).any(|version| name == format!("library.schema-v{version}.bak"));
        let previous = name.strip_prefix("library.before-restore-").and_then(|n| n.strip_suffix(".db")).is_some_and(|id| uuid::Uuid::parse_str(id).is_ok());
        let damaged = name.strip_prefix("library.damaged-").and_then(|n| n.strip_suffix(".db")).is_some_and(|stamp| stamp.len() == 16 && stamp.as_bytes()[8] == b'T' && stamp.as_bytes()[15] == b'Z' && stamp.chars().all(|c| c.is_ascii_digit() || c == 'T' || c == 'Z'));
        if schema || previous || damaged { files.push(entry.path()); }
    }
    files
}
fn cleanup_stage(dir: &Path) {
    // This is a freshly created, UUID-named staging directory, containing only our encrypted files.
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() { if entry.path().is_file() { let _ = std::fs::remove_file(entry.path()); } }
    let _ = std::fs::remove_dir(dir);
}
struct PreparedMove { storage: Option<Storage>, files: Vec<PathBuf> }
impl Drop for PreparedMove {
    fn drop(&mut self) { drop(self.storage.take()); for file in &self.files { cleanup_database(file); } }
}
fn prepare_move(old: &Path, target: &Path, key: &[u8], original: &Storage) -> Result<PreparedMove, String> {
    if std::fs::read_dir(target).map_err(|_| FAILED)?.next().is_some() { return Err("Choose an empty folder so no existing files are replaced.".into()); }
    let mut prepared = PreparedMove { storage: None, files: vec![] };
    let db = target.join("library.db"); encrypted_copy(&old.join("library.db"), Secret::Raw(key), &db, Secret::Raw(key), false)?; prepared.files.push(db.clone());
    let new_key = target.join("library-key.dpapi"); prepared.files.push(new_key.clone()); write_atomic(&new_key, &std::fs::read(old.join("library-key.dpapi")).map_err(|_| FAILED)?)?;
    if &*crate::key_protection::load_or_create(&new_key, true)? != key { return Err(FAILED.into()); }
    for backup in backup_files(old) {
        for from in [backup.clone(), sidecar(&backup, "-wal"), sidecar(&backup, "-shm")] {
            if !from.exists() { continue; }
            let copy = target.join(from.file_name().ok_or(FAILED)?); prepared.files.push(copy.clone()); std::fs::copy(from, &copy).map_err(|_| FAILED)?;
            std::fs::OpenOptions::new().write(true).open(copy).and_then(|f| f.sync_all()).map_err(|_| FAILED)?;
        }
    }
    let replacement = Storage::open(&db, key)?; let mut checked = Library::default(); replacement.load_metadata(&mut checked)?;
    let mut before = Library::default(); original.load_metadata(&mut before)?;
    if checked.clips != before.clips || checked.categories != before.categories { return Err(FAILED.into()); }
    prepared.storage = Some(replacement); Ok(prepared)
}

fn install_restore(storage: &mut Option<Storage>, db: &Path, staged: &Path, key: &[u8]) -> Result<PathBuf, String> {
    let kept = db.parent().ok_or(FAILED)?.join(format!("library.before-restore-{}.db", uuid::Uuid::new_v4()));
    // Both generations exist before the one atomic replacement: interruption cannot leave a missing database.
    encrypted_copy(db, Secret::Raw(key), &kept, Secret::Raw(key), false)?;
    storage.as_ref().ok_or(FAILED)?.checkpoint()?;
    drop(storage.take());
    if let Err(error) = atomic_replace(staged, db) { *storage = Storage::open(db, key).ok(); return Err(error); }
    match Storage::open(db, key) {
        Ok(opened) => { *storage = Some(opened); Ok(kept) },
        Err(error) => {
            for suffix in ["-wal", "-shm", "-journal"] { let _ = std::fs::remove_file(sidecar(db, suffix)); }
            let _ = atomic_replace(&kept, db); *storage = Storage::open(db, key).ok(); Err(error)
        }
    }
}

pub fn location(config: &Path, default: PathBuf) -> Result<PathBuf, String> {
    let path = config.join("storage-location.json");
    if !path.exists() { return Ok(default); }
    let chosen: PathBuf = serde_json::from_slice(&std::fs::read(path).map_err(|_| FAILED)?).map_err(|_| FAILED)?;
    // An unplugged drive must never silently turn into a newly created empty history.
    if !chosen.is_absolute() || !chosen.join("library.db").is_file() || !chosen.join("library-key.dpapi").is_file() { return Err("The selected data folder is unavailable. Connect the drive and restart Copyloom.".into()); }
    Ok(chosen)
}
fn active(library: &Library) -> Result<PathBuf, String> {
    if library.storage != "encrypted" { return Err("History is unavailable.".into()); }
    library.storage_path.as_ref().map(PathBuf::from).ok_or_else(|| FAILED.into())
}
fn owner(window: &tauri::WebviewWindow) -> Result<isize, String> {
    if window.label() != "main" { return Err("Wrong window.".into()); }
    #[cfg(windows)] { Ok(window.hwnd().map_err(|_| FAILED)?.0 as isize) }
    #[cfg(not(windows))] { Ok(0) }
}
pub fn password_valid(password: &str) -> Result<(), String> {
    if password.chars().count() < 10 || password.len() > 1024 || password.contains('\0') { return Err("Use an export password with at least 10 characters (up to 1,024 bytes).".into()); }
    Ok(())
}

#[tauri::command]
pub async fn choose_data_folder(window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    let owner = owner(&window)?;
    tauri::async_runtime::spawn_blocking(move || crate::file_dialog::folder(owner).map(|p| p.map(|p| p.to_string_lossy().into_owned()))).await.map_err(|_| lock_error())?
}

#[tauri::command]
pub async fn choose_export_file(window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    let owner = owner(&window)?;
    tauri::async_runtime::spawn_blocking(move || crate::file_dialog::file(owner, "", "copyloom", true).map(|p| p.map(|p| p.to_string_lossy().into_owned()))).await.map_err(|_| lock_error())?
}

#[tauri::command]
pub async fn choose_excluded_program(window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    let owner = owner(&window)?;
    tauri::async_runtime::spawn_blocking(move || crate::file_dialog::file(owner, "", "exe", true).map(|p| p.and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase())))).await.map_err(|_| lock_error())?
}

#[tauri::command]
pub async fn export_history(app: tauri::AppHandle, window: tauri::WebviewWindow, password: String) -> Result<Option<String>, String> {
    let password = Zeroizing::new(password); password_valid(&password)?; let owner = owner(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(target) = crate::file_dialog::file(owner, "Copyloom.copyloom", "copyloom", false)? else { return Ok(None); };
        if !target.extension().is_some_and(|ext| ext.to_string_lossy().eq_ignore_ascii_case("copyloom")) { return Err("Use the .copyloom extension for the export.".into()); }
        let state = app.state::<RuntimeState>(); let _maintenance = state.storage_maintenance.lock().map_err(|_| lock_error())?;
        let library = state.library.lock().map_err(|_| lock_error())?; let dir = active(&library)?; drop(library);
        if target.parent().and_then(|p| p.canonicalize().ok()) == dir.canonicalize().ok() && target.file_name().is_some_and(|n| n.to_string_lossy().to_lowercase().starts_with("library")) { return Err("Choose an export name outside the database’s own files.".into()); }
        let db = dir.join("library.db"); let key = crate::key_protection::load_or_create(&dir.join("library-key.dpapi"), true)?;
        let temporary = target.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        encrypted_copy(&db, Secret::Raw(&key), &temporary, Secret::Password(&password), true)?;
        if let Err(error) = atomic_replace(&temporary, &target) { cleanup_database(&temporary); return Err(error); }
        Ok(Some(target.to_string_lossy().into_owned()))
    }).await.map_err(|_| lock_error())?
}

#[tauri::command]
pub async fn move_data_folder(app: tauri::AppHandle, window: tauri::WebviewWindow, path: String) -> Result<String, String> {
    owner(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<RuntimeState>(); let _maintenance = state.storage_maintenance.lock().map_err(|_| lock_error())?;
        let mut library = state.library.lock().map_err(|_| lock_error())?;
        let old = active(&library)?; let target = PathBuf::from(path);
        if !target.is_absolute() || target.to_string_lossy().starts_with("\\\\") { return Err("Choose a local folder for history.".into()); }
        let target = target.canonicalize().map_err(|_| FAILED)?;
        if old.canonicalize().ok().as_ref() == Some(&target) { return Ok(target.to_string_lossy().into_owned()); }
        if std::fs::read_dir(&target).map_err(|_| FAILED)?.next().is_some() { return Err("Choose an empty folder so no existing files are replaced.".into()); }
        let mut storage = state.storage.lock().map_err(|_| lock_error())?;
        let key_path = old.join("library-key.dpapi"); let key = crate::key_protection::load_or_create(&key_path, true)?;
        let mut prepared = prepare_move(&old, &target, &key, storage.as_ref().ok_or(FAILED)?)?;
        let replacement = prepared.storage.take().ok_or(FAILED)?;
        let config = crate::startup::config_dir(&app)?;
        write_atomic(&config.join("storage-location.json"), &serde_json::to_vec(&target).map_err(|_| FAILED)?)?;
        // No fallible work remains between saving the location and switching the live handle.
        let before = library.clone(); *storage = Some(replacement); prepared.files.clear();
        library.storage_path = Some(target.to_string_lossy().into_owned()); library.revision += 1;
        let update = LibraryUpdate::between(&before, &library); let _ = app.emit("library:changed", &update);
        // Delete only app-owned source files after the verified switch. Other files in the old folder remain.
        let mut leftovers = false;
        for file in std::iter::once(old.join("library.db")).chain(std::iter::once(key_path)).chain(backup_files(&old)) {
            for p in [file.clone(), sidecar(&file, "-wal"), sidecar(&file, "-shm")] { if p.exists() && std::fs::remove_file(p).is_err() { leftovers = true; } }
        }
        if leftovers { let _ = app.emit("runtime:error", "Data folder changed. Some old encrypted files could not be removed from the previous folder."); }
        Ok(target.to_string_lossy().into_owned())
    }).await.map_err(|_| lock_error())?
}

#[tauri::command]
pub async fn restore_history(app: tauri::AppHandle, window: tauri::WebviewWindow, path: String, password: String) -> Result<usize, String> {
    owner(&window)?; let password = Zeroizing::new(password); password_valid(&password)?;
    tauri::async_runtime::spawn_blocking(move || {
        let source = PathBuf::from(path); verify(&reader(&source, &Secret::Password(&password))?, true)?;
        let state = app.state::<RuntimeState>(); let _maintenance = state.storage_maintenance.lock().map_err(|_| lock_error())?;
        let mut library = state.library.lock().map_err(|_| lock_error())?; let dir = active(&library)?;
        let key = crate::key_protection::load_or_create(&dir.join("library-key.dpapi"), true)?;
        let staging_dir = dir.join(format!("restore-{}", uuid::Uuid::new_v4())); std::fs::create_dir(&staging_dir).map_err(|_| FAILED)?;
        let staged = staging_dir.join("library.db");
        if let Err(error) = encrypted_copy(&source, Secret::Password(&password), &staged, Secret::Raw(&key), false) { cleanup_stage(&staging_dir); return Err(error); }
        let prepared = (|| {
            let imported = Storage::open(&staged, &key)?; let mut next = library.clone(); imported.load_metadata(&mut next)?; drop(imported);
            defer_media(&mut next); next.revision = library.revision + 1; Ok::<_, String>(next)
        })();
        let mut next = match prepared { Ok(next) => next, Err(error) => { cleanup_stage(&staging_dir); return Err(error); } };
        let mut storage = state.storage.lock().map_err(|_| lock_error())?;
        // Keep an encrypted rollback copy before the old handle closes. The local DPAPI key stays unchanged.
        let db = dir.join("library.db");
        if let Err(error) = crate::backup::create(&db, &key, crate::library::now_ms() / 1000) { cleanup_stage(&staging_dir); return Err(error); }
        let mut last_content = match state.last_content.lock() { Ok(guard) => guard, Err(_) => { cleanup_stage(&staging_dir); return Err(lock_error()); } };
        let mut deletions = match state.deletions.lock() { Ok(guard) => guard, Err(_) => { cleanup_stage(&staging_dir); return Err(lock_error()); } };
        let result = install_restore(&mut storage, &db, &staged, &key);
        if let Err(error) = result {
            *storage = Storage::open(&db, &key).ok(); cleanup_stage(&staging_dir);
            if storage.is_none() {
                let before = library.clone(); library.storage = "unavailable".into(); library.paused = true; library.revision += 1;
                let update = LibraryUpdate::between(&before, &library); let _ = app.emit("library:changed", &update);
                let _ = app.emit("runtime:error", "Could not open history. Collection is paused.");
            }
            return Err(error);
        }
        let count = next.clips.len(); let update = LibraryUpdate::between(&library, &next); std::mem::swap(&mut *library, &mut next);
        *last_content = None;
        *deletions = Default::default();
        let _ = app.emit("library:changed", &update);
        let _ = app.emit("library:restored", ());
        cleanup_stage(&staging_dir);
        Ok(count)
    }).await.map_err(|_| lock_error())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::{Action, Category, Clip};
    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("copyloom-transfer-{}", uuid::Uuid::new_v4())); std::fs::create_dir_all(&dir).unwrap(); dir
    }
    fn history(path: &Path, key: &[u8]) -> (Storage, Library) {
        let mut db = Storage::open(path, key).unwrap(); let before = Library::default(); let mut after = before.clone();
        let category_id = uuid::Uuid::new_v4().to_string();
        after.apply(Action::AddCategory { category: Category { id: category_id.clone(), name: "Privat åäö".into(), color: "#00a9e6".into(), clip_order: vec![] } }).unwrap();
        let mut clip = Clip::captured("private-transfer-content åäö".into()); clip.favorite = true; clip.category_ids = vec![category_id]; clip.html = Some("<b>private-transfer-content åäö</b>".into());
        after.apply(Action::AddClip { clip }).unwrap();
        let png = crate::platform::encode_png(&arboard::ImageData { width: 1, height: 1, bytes: std::borrow::Cow::Borrowed(&[10, 20, 30, 255]) }).unwrap();
        after.apply(Action::AddClip { clip: Clip::captured(crate::platform::png_content(&png).unwrap()) }).unwrap();
        db.save_changes(&before, &after).unwrap(); let mut loaded = before; db.load(&mut loaded).unwrap(); (db, loaded)
    }
    #[test]
    fn password_export_restores_on_another_key_with_images_html_categories_and_favorites() {
        let dir = temp(); let source = dir.join("library.db"); let export = dir.join("Återställning.copyloom"); let restored = dir.join("other-account.db");
        let (db, before) = history(&source, &[42; 32]);
        let password = "Långt 'lösenord' åäö";
        encrypted_copy(&source, Secret::Raw(&[42; 32]), &export, Secret::Password(password), true).unwrap();
        verify(&reader(&export, &Secret::Password(password)).unwrap(), true).unwrap();
        assert!(!std::fs::read(&export).unwrap().windows(24).any(|b| b == b"private-transfer-content"));
        assert!(reader(&export, &Secret::Raw(&[42; 32])).and_then(|c| verify(&c, true)).is_err());
        encrypted_copy(&export, Secret::Password(password), &restored, Secret::Raw(&[53; 32]), false).unwrap();
        let other = Storage::open(&restored, &[53; 32]).unwrap(); let mut after = Library::default(); other.load(&mut after).unwrap();
        assert_eq!(before.clips, after.clips); assert_eq!(before.categories, after.categories);
        drop(other); drop(db); std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn wrong_password_tampering_and_newer_schema_do_not_create_a_restore_database() {
        let dir = temp(); let source = dir.join("library.db"); let export = dir.join("export.copyloom"); let output = dir.join("restore.db");
        let (db, _) = history(&source, &[42; 32]);
        encrypted_copy(&source, Secret::Raw(&[42; 32]), &export, Secret::Password("correct-password"), true).unwrap();
        assert!(encrypted_copy(&export, Secret::Password("wrong-password"), &output, Secret::Raw(&[53; 32]), false).is_err()); assert!(!output.exists());
        let mut bytes = std::fs::read(&export).unwrap(); bytes[5000] ^= 1; std::fs::write(&export, bytes).unwrap();
        assert!(verify(&reader(&export, &Secret::Password("correct-password")).unwrap(), true).is_err()); assert!(!output.exists());
        std::fs::remove_file(&export).unwrap();
        encrypted_copy(&source, Secret::Raw(&[42; 32]), &export, Secret::Password("correct-password"), true).unwrap();
        let connection = Connection::open(&export).unwrap(); connection.execute_batch(&Zeroizing::new(format!("PRAGMA key={}; PRAGMA user_version={};", &*Secret::Password("correct-password").sql(), SCHEMA + 1))).unwrap(); drop(connection);
        assert!(verify(&reader(&export, &Secret::Password("correct-password")).unwrap(), true).is_err());
        let mut existing = Library::default(); db.load(&mut existing).unwrap(); assert_eq!(existing.clips.len(), 2);
        drop(db); std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn live_wal_relocation_is_consistent_and_existing_targets_are_never_overwritten() {
        let dir = temp(); let source = dir.join("library.db"); let target = dir.join("moved.db"); let (db, before) = history(&source, &[42; 32]);
        encrypted_copy(&source, Secret::Raw(&[42; 32]), &target, Secret::Raw(&[42; 32]), false).unwrap();
        let moved = Storage::open(&target, &[42; 32]).unwrap(); let mut after = Library::default(); moved.load(&mut after).unwrap(); assert_eq!(before.clips, after.clips);
        let original = std::fs::read(&target).unwrap();
        assert!(encrypted_copy(&source, Secret::Raw(&[42; 32]), &target, Secret::Raw(&[42; 32]), false).is_err()); assert_eq!(std::fs::read(&target).unwrap(), original);
        drop(moved); drop(db); std::fs::remove_dir_all(dir).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn relocation_moves_key_and_all_owned_backups_and_abandoned_switch_rolls_back() {
        let dir = temp(); let old = dir.join("old"); let target = dir.join("chosen"); std::fs::create_dir(&old).unwrap(); std::fs::create_dir(&target).unwrap();
        let key = crate::key_protection::load_or_create(&old.join("library-key.dpapi"), false).unwrap();
        let (original, before) = history(&old.join("library.db"), &key);
        crate::backup::create(&old.join("library.db"), &key, 1_791_435_837).unwrap();
        encrypted_copy(&old.join("library.db"), Secret::Raw(&key), &old.join("library.schema-v3.bak"), Secret::Raw(&key), false).unwrap();
        std::fs::write(old.join("notes.txt"), b"not an app file").unwrap();
        let prepared = prepare_move(&old, &target, &key, &original).unwrap();
        let unlocked = crate::key_protection::load_or_create(&target.join("library-key.dpapi"), true).unwrap(); assert_eq!(&*key, &*unlocked);
        assert_eq!(backup_files(&target).len(), 2); assert!(!target.join("notes.txt").exists());
        drop(prepared); assert_eq!(std::fs::read_dir(&target).unwrap().count(), 0);
        let mut loaded = Library::default(); original.load(&mut loaded).unwrap(); assert_eq!(loaded.clips, before.clips);
        let mut prepared = prepare_move(&old, &target, &key, &original).unwrap();
        write_atomic(&dir.join("storage-location.json"), &serde_json::to_vec(&target).unwrap()).unwrap(); assert_eq!(location(&dir, old.clone()).unwrap(), target);
        let moved = prepared.storage.take().unwrap(); prepared.files.clear(); drop(prepared);
        moved.load(&mut loaded).unwrap(); assert_eq!(loaded.clips, before.clips); assert!(old.join("notes.txt").exists());
        drop(moved); drop(original); std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn missing_selected_drive_never_falls_back_to_empty_default_history() {
        let dir = temp(); let default = dir.join("default"); assert_eq!(location(&dir, default.clone()).unwrap(), default);
        write_atomic(&dir.join("storage-location.json"), &serde_json::to_vec(&dir.join("missing")).unwrap()).unwrap();
        assert!(location(&dir, default).is_err()); assert!(!dir.join("missing").exists()); std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn restore_install_keeps_old_history_and_rolls_back_failed_new_handle() {
        let dir = temp(); let db = dir.join("library.db"); let staged = dir.join("restore.db"); let (original, before) = history(&db, &[42; 32]); let mut storage = Some(original);
        let mut imported = Storage::open(&staged, &[42; 32]).unwrap(); let mut after = Library::default(); after.apply(Action::AddClip { clip: Clip::captured("imported".into()) }).unwrap(); imported.save_changes(&Library::default(), &after).unwrap(); drop(imported);
        let kept = install_restore(&mut storage, &db, &staged, &[42; 32]).unwrap(); let mut loaded = Library::default(); storage.as_ref().unwrap().load(&mut loaded).unwrap(); assert_eq!(loaded.clips[0].content, "imported");
        let previous = Storage::open(&kept, &[42; 32]).unwrap(); previous.load(&mut loaded).unwrap(); assert_eq!(loaded.clips, before.clips); drop(previous);
        // A missing staged file and a file encrypted for a different key must both preserve the live history.
        assert!(install_restore(&mut storage, &db, &staged, &[42; 32]).is_err());
        drop(Storage::open(&staged, &[53; 32]).unwrap()); assert!(install_restore(&mut storage, &db, &staged, &[42; 32]).is_err());
        storage.as_ref().unwrap().load(&mut loaded).unwrap(); assert_eq!(loaded.clips[0].content, "imported"); drop(storage); std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn password_that_looks_like_raw_key_still_uses_password_derivation() {
        let dir = temp(); let source = dir.join("library.db"); let export = dir.join("export.copyloom"); let (db, _) = history(&source, &[42; 32]);
        let password = format!("x'{}'", &*key_hex(&[11; 32]));
        encrypted_copy(&source, Secret::Raw(&[42; 32]), &export, Secret::Password(&password), true).unwrap();
        assert!(verify(&reader(&export, &Secret::Password(&password)).unwrap(), true).is_ok());
        assert!(reader(&export, &Secret::Raw(&[11; 32])).and_then(|c| verify(&c, true)).is_err());
        drop(db); std::fs::remove_dir_all(dir).unwrap();
    }
}
