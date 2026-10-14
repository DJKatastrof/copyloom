//! Daily encrypted copies of the history beside library.db, and recovery from them when the
//! database itself is damaged. Copies use the database key, so they are as protected as the
//! history and hold clips the user has since deleted until they rotate out.
use crate::storage::{key_hex, SCHEMA};
use rusqlite::{Connection, ErrorCode, OpenFlags};
use std::{ffi::OsString, path::{Path, PathBuf}, time::Duration};
use tauri::{Emitter, Manager};
use zeroize::Zeroizing;

pub const KEEP: usize = 3;
const INTERVAL_SECS: u64 = 24 * 60 * 60;
const PREFIX: &str = "library.backup-";
const SUFFIX: &str = ".bak";
const FAILED: &str = "The automatic backup could not be created. Your history is unchanged.";
const NO_SPACE: &str = "Not enough free disk space for the automatic backup. Your history is unchanged.";

pub struct Restored { pub label: String }

pub fn start(app: tauri::AppHandle) {
    let _ = std::thread::Builder::new().name("copyloom-backup".into()).spawn(move || {
        // Leave sign-in alone; then check hourly so a session running for days still gets daily copies.
        std::thread::sleep(Duration::from_secs(60));
        let mut reported = false;
        loop {
            let result = (|| {
                let state = app.state::<crate::RuntimeState>();
                let _maintenance = state.storage_maintenance.lock().map_err(|_| crate::lock_error())?;
                let library = state.library.lock().map_err(|_| crate::lock_error())?;
                if library.storage != "encrypted" { return Ok::<_, String>(()); }
                let dir = PathBuf::from(library.storage_path.as_ref().ok_or(FAILED)?); drop(library);
                let now = crate::library::now_ms() / 1000;
                if due(&dir, now) { let key = crate::key_protection::load_or_create(&dir.join("library-key.dpapi"), true)?; create(&dir.join("library.db"), &key, now)?; }
                Ok(())
            })();
            match result { Ok(_) => reported = false, Err(error) => if !reported { reported = true; let _ = app.emit("runtime:error", error); } }
            std::thread::sleep(Duration::from_secs(60 * 60));
        }
    });
}

fn unlock(connection: &Connection, key: &[u8]) -> rusqlite::Result<()> {
    connection.execute_batch(&Zeroizing::new(format!("PRAGMA key = \"x'{}'\"; PRAGMA busy_timeout=5000;", &*key_hex(key))))
}

// Civil date from days since 1970 (H. Hinnant); names sort by time and stay readable.
fn stamp(secs: u64) -> String {
    let days = (secs / 86_400) as i64; let rest = secs % 86_400;
    let z = days + 719_468; let era = z.div_euclid(146_097); let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1; let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}{month:02}{day:02}T{:02}{:02}{:02}Z", rest / 3600, rest / 60 % 60, rest % 60)
}

fn parse(name: &str) -> Option<u64> {
    let s = name.strip_prefix(PREFIX)?.strip_suffix(SUFFIX)?;
    if s.len() != 16 || s.as_bytes()[8] != b'T' || s.as_bytes()[15] != b'Z' { return None; }
    let n = |from: usize, to: usize| -> Option<i64> { s.get(from..to)?.parse().ok() };
    let (year, month, day, hour, minute, second) = (n(0, 4)?, n(4, 6)?, n(6, 8)?, n(9, 11)?, n(11, 13)?, n(13, 15)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 59 { return None; }
    let year = year - i64::from(month <= 2); let era = year.div_euclid(400); let yoe = year - era * 400;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    u64::try_from(days * 86_400 + hour * 3600 + minute * 60 + second).ok()
}

/// Automatic copies in this folder, newest first.
pub fn list(dir: &Path) -> Vec<(u64, PathBuf)> {
    let mut found: Vec<(u64, PathBuf)> = std::fs::read_dir(dir).into_iter().flatten().flatten()
        .filter_map(|entry| Some((parse(entry.file_name().to_str()?)?, entry.path()))).collect();
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found
}

/// A copy dated in the future (clock moved back) does not postpone the next one.
pub fn due(dir: &Path, now: u64) -> bool {
    list(dir).first().is_none_or(|(at, _)| now.saturating_sub(*at) >= INTERVAL_SECS || *at > now + 60 * 60)
}

fn sidecar(db: &Path, suffix: &str) -> PathBuf { let mut name: OsString = db.as_os_str().to_owned(); name.push(suffix); name.into() }

#[cfg(windows)]
fn free_space(dir: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut free = 0u64;
    let ok = unsafe { windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut()) };
    (ok != 0).then_some(free)
}
#[cfg(not(windows))]
fn free_space(_: &Path) -> Option<u64> { None }

/// Exports one consistent copy through a separate reader, so capture and the UI never wait on it.
pub fn create(db: &Path, key: &[u8], now: u64) -> Result<PathBuf, String> {
    let dir = db.parent().ok_or(FAILED)?;
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        if entry.file_name().to_str().is_some_and(|name| name.starts_with(PREFIX) && name.ends_with(".bak.tmp")) { let _ = std::fs::remove_file(entry.path()); }
    }
    let size: u64 = [db.to_path_buf(), sidecar(db, "-wal")].iter().filter_map(|path| std::fs::metadata(path).ok()).map(|meta| meta.len()).sum();
    if free_space(dir).is_some_and(|free| free < size.saturating_mul(2).saturating_add(64 << 20)) { return Err(NO_SPACE.into()); }
    let target = dir.join(format!("{PREFIX}{}{SUFFIX}", stamp(now)));
    let temporary = target.with_extension("bak.tmp");
    let result = (|| -> Result<(), String> {
        let connection = Connection::open(db).map_err(|_| FAILED)?;
        unlock(&connection, key).map_err(|_| FAILED)?;
        let schema: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0)).map_err(|_| FAILED)?;
        let escaped = temporary.to_string_lossy().replace('\'', "''");
        connection.execute_batch(&Zeroizing::new(format!("ATTACH DATABASE '{}' AS auto_backup KEY \"x'{}'\";", escaped, &*key_hex(key)))).map_err(|_| FAILED)?;
        // One read transaction: clips, categories and order all come from the same moment.
        let exported = connection.execute_batch("BEGIN;")
            .and_then(|_| connection.query_row("SELECT sqlcipher_export('auto_backup')", [], |_| Ok(())))
            .and_then(|_| connection.execute_batch(&format!("PRAGMA auto_backup.user_version={schema}; COMMIT;")));
        if exported.is_err() { let _ = connection.execute_batch("ROLLBACK;"); }
        let _ = connection.execute_batch("DETACH DATABASE auto_backup;");
        exported.map_err(|_| FAILED)?;
        drop(connection);
        verify(&temporary, key).map_err(|_| FAILED)?;
        std::fs::rename(&temporary, &target).map_err(|_| FAILED.into())
    })();
    if result.is_err() { let _ = std::fs::remove_file(&temporary); }
    result?;
    for (_, old) in list(dir).into_iter().skip(KEEP) { let _ = std::fs::remove_file(old); }
    Ok(target)
}

fn verify(path: &Path, key: &[u8]) -> Result<(), ()> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(|_| ())?;
    unlock(&connection, key).map_err(|_| ())?;
    let check: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0)).map_err(|_| ())?;
    let schema: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0)).map_err(|_| ())?;
    if check == "ok" && (1..=SCHEMA).contains(&schema) { Ok(()) } else { Err(()) }
}

/// Only real damage counts: a locked, unreadable or newer database is never replaced.
fn damaged(db: &Path, key: &[u8]) -> bool {
    match std::fs::metadata(db) { Ok(meta) if meta.len() == 0 => return true, Ok(_) => {}, Err(_) => return false }
    let Ok(connection) = Connection::open(db) else { return false };
    if unlock(&connection, key).is_err() { return false; }
    match connection.query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0)) {
        Ok(check) => check != "ok",
        Err(rusqlite::Error::SqliteFailure(error, _)) => matches!(error.code, ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase),
        Err(_) => false,
    }
}

/// Replaces a damaged database with the newest copy that opens with the same key. The damaged
/// files are kept as library.damaged-*.db. With the wrong key no copy verifies and nothing moves.
pub fn restore(db: &Path, key: &[u8], now: u64) -> Result<Option<Restored>, String> {
    const MOVE_FAILED: &str = "The damaged history could not be moved aside. No files were replaced.";
    let dir = db.parent().ok_or(MOVE_FAILED)?;
    let backups = list(dir);
    if backups.is_empty() || !db.exists() || !damaged(db, key) { return Ok(None); }
    let Some((at, source)) = backups.into_iter().find(|(_, path)| verify(path, key).is_ok()) else { return Ok(None) };
    let kept = dir.join(format!("library.damaged-{}.db", stamp(now)));
    // WAL and SHM leave with the damaged file; SQLite would otherwise replay them onto the copy.
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (from, to) in [(sidecar(db, "-wal"), sidecar(&kept, "-wal")), (sidecar(db, "-shm"), sidecar(&kept, "-shm")), (db.to_path_buf(), kept.clone())] {
        if !from.exists() { continue; }
        if std::fs::rename(&from, &to).is_err() {
            for (back, place) in moved.iter().rev() { let _ = std::fs::rename(place, back); }
            return Err(MOVE_FAILED.into());
        }
        moved.push((from, to));
    }
    let temporary = db.with_extension("db.restore");
    if std::fs::copy(&source, &temporary).is_err() || std::fs::rename(&temporary, db).is_err() {
        let _ = std::fs::remove_file(&temporary);
        for (back, place) in moved.iter().rev() { let _ = std::fs::rename(place, back); }
        return Err("The backup could not be restored. No files were replaced.".into());
    }
    Ok(Some(Restored { label: local_label(at) }))
}

#[cfg(windows)]
fn local_label(secs: u64) -> String {
    use windows_sys::Win32::{Foundation::{FILETIME, SYSTEMTIME}, Storage::FileSystem::FileTimeToLocalFileTime, System::Time::FileTimeToSystemTime};
    let ticks = (secs + 11_644_473_600) * 10_000_000;
    let utc = FILETIME { dwLowDateTime: ticks as u32, dwHighDateTime: (ticks >> 32) as u32 };
    let mut local = utc; let mut time: SYSTEMTIME = unsafe { std::mem::zeroed() };
    if unsafe { FileTimeToLocalFileTime(&utc, &mut local) == 0 || FileTimeToSystemTime(&local, &mut time) == 0 } { return stamp(secs); }
    format!("{:04}-{:02}-{:02} {:02}:{:02}", time.wYear, time.wMonth, time.wDay, time.wHour, time.wMinute)
}
#[cfg(not(windows))]
fn local_label(secs: u64) -> String { stamp(secs) }

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::{Action, Clip, Library};
    use crate::storage::Storage;
    const DAY: u64 = 86_400;
    fn temp() -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("copyloom-backup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        (dir.clone(), dir.join("library.db"))
    }
    fn history(path: &Path, key: &[u8], texts: &[&str]) -> Storage {
        let mut db = Storage::open(path, key).unwrap();
        let before = Library::default(); let mut after = before.clone();
        for text in texts { after.apply(Action::AddClip { clip: Clip::captured((*text).into()) }).unwrap(); }
        db.save_changes(&before, &after).unwrap();
        db
    }
    fn contents(path: &Path, key: &[u8]) -> Vec<String> {
        let mut loaded = Library::default(); Storage::open(path, key).unwrap().load(&mut loaded).unwrap();
        let mut texts: Vec<String> = loaded.clips.iter().map(|clip| clip.content.clone()).collect(); texts.sort(); texts
    }

    #[test]
    fn names_round_trip_and_sort_by_time() {
        for secs in [0, 951_782_400, 1_791_435_837, 4_102_444_799] { assert_eq!(parse(&format!("{PREFIX}{}{SUFFIX}", stamp(secs))), Some(secs)); }
        assert_eq!(stamp(1_791_435_837), "20261008T050357Z");
        for name in ["library.backup-20261308T050357Z.bak", "library.backup-20261008T050357Z.bak.tmp", "library.schema-v3.bak", "library.backup-2026-10-08.bak"] { assert_eq!(parse(name), None, "{name}"); }
    }

    #[test]
    fn daily_copy_is_encrypted_consistent_and_keeps_three() {
        let (dir, path) = temp(); let key = [31u8; 32];
        let db = history(&path, &key, &["private-backup-payload", "second clip"]);
        let start = 1_791_435_837;
        assert!(due(&dir, start));
        let first = create(&path, &key, start).unwrap();
        assert!(!due(&dir, start + DAY - 1) && due(&dir, start + DAY) && due(&dir, start - 2 * 60 * 60));
        // Encrypted on disk, readable with the database key, and the live database keeps working.
        assert!(!std::fs::read(&first).unwrap().windows(22).any(|bytes| bytes == b"private-backup-payload"));
        assert_eq!(contents(&first, &key), ["private-backup-payload", "second clip"]);
        assert!(Connection::open(&first).unwrap().query_row("SELECT count(*) FROM clips", [], |row| row.get::<_, i64>(0)).is_err());
        for day in 1..=4 { create(&path, &key, start + day * DAY).unwrap(); }
        let kept = list(&dir);
        assert_eq!(kept.iter().map(|(at, _)| *at).collect::<Vec<_>>(), [start + 4 * DAY, start + 3 * DAY, start + 2 * DAY]);
        assert!(!first.exists());
        assert!(std::fs::read_dir(&dir).unwrap().flatten().all(|entry| !entry.file_name().to_string_lossy().ends_with(".tmp")));
        drop(db); std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn damaged_history_is_restored_from_newest_valid_copy_and_kept() {
        let (dir, path) = temp(); let key = [32u8; 32];
        drop(history(&path, &key, &["kept by backup"]));
        create(&path, &key, 1_791_435_837).unwrap();
        // A newer copy that does not verify is skipped.
        std::fs::write(dir.join(format!("{PREFIX}{}{SUFFIX}", stamp(1_791_435_837 + DAY))), b"not a database").unwrap();
        drop(history(&path, &key, &["after backup"]));
        let mut bytes = std::fs::read(&path).unwrap();
        for byte in &mut bytes[100..] { *byte = 0x5a; }
        std::fs::write(&path, &bytes).unwrap();
        assert!(Storage::open(&path, &key).is_err() || { let mut library = Library::default(); Storage::open(&path, &key).unwrap().load(&mut library).is_err() });
        let restored = restore(&path, &key, 1_791_600_000).unwrap().expect("restored");
        assert!(!restored.label.is_empty());
        assert_eq!(contents(&path, &key), ["kept by backup"]);
        let damaged = dir.join(format!("library.damaged-{}.db", stamp(1_791_600_000)));
        assert_eq!(std::fs::read(&damaged).unwrap(), bytes);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn healthy_locked_or_wrong_key_history_is_never_replaced() {
        let (dir, path) = temp(); let key = [33u8; 32];
        let db = history(&path, &key, &["healthy"]);
        create(&path, &key, 1_791_435_837).unwrap();
        assert!(restore(&path, &key, 1_791_500_000).unwrap().is_none());
        drop(db);
        let original = std::fs::read(&path).unwrap();
        // The wrong key cannot open the copies either, so nothing moves.
        assert!(restore(&path, &[34u8; 32], 1_791_500_000).unwrap().is_none());
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert!(std::fs::read_dir(&dir).unwrap().flatten().all(|entry| !entry.file_name().to_string_lossy().starts_with("library.damaged-")));
        // An emptied file counts as damage when a copy exists.
        std::fs::write(&path, b"").unwrap();
        assert!(restore(&path, &key, 1_791_500_000).unwrap().is_some());
        assert_eq!(contents(&path, &key), ["healthy"]);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
