use crate::library::{Category, Clip, Library, SourceApp};
use std::sync::Arc;
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use zeroize::Zeroizing;

pub struct Storage {
    connection: Connection,
}
pub struct ContentUsage { pub clip_count: u64, pub image_count: u64, pub image_bytes: u64 }
fn db_error(_: rusqlite::Error) -> String {
    "Couldn't read or save your history. Check the free space and file access. Existing data has not been replaced.".into()
}
/// Newest schema this build reads and writes.
pub const SCHEMA: i64 = 4;
/// Key in the hex form SQLCipher statements take; zeroized on drop.
pub fn key_hex(key: &[u8]) -> Zeroizing<String> {
    use std::fmt::Write;
    let mut hex = Zeroizing::new(String::with_capacity(key.len() * 2));
    for byte in key { let _ = write!(&mut *hex, "{:02x}", byte); }
    hex
}

impl Storage {
    /// Aggregate stored PNG lengths without loading or decoding the images.
    pub fn content_usage(&self) -> Result<ContentUsage, String> {
        self.connection.query_row("SELECT COUNT(*),COALESCE(SUM(image_png IS NOT NULL),0),COALESCE(SUM(LENGTH(image_png)),0) FROM clips", [], |row| {
            let unsigned = |index: usize| { let value = row.get::<_, i64>(index)?; u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(index, value)) };
            Ok(ContentUsage { clip_count: unsigned(0)?, image_count: unsigned(1)?, image_bytes: unsigned(2)? })
        }).map_err(db_error)
    }
    pub fn checkpoint(&self) -> Result<(), String> {
        let busy: i64 = self.connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0)).map_err(db_error)?;
        if busy == 0 { Ok(()) } else { Err("Another program is using the database. Close it and try again.".into()) }
    }
    pub fn open(path: &Path, key: &[u8]) -> Result<Self, String> {
        if key.len() != 32 {
            return Err("Ogiltig databasnyckel.".into());
        }
        let connection = Connection::open(path).map_err(db_error)?;
        let hex = key_hex(key);
        let pragma = Zeroizing::new(format!("PRAGMA key = \"x'{}'\";", &*hex));
        connection.execute_batch(&pragma).map_err(db_error)?;
        let version: String = connection
            .query_row("PRAGMA cipher_version", [], |r| r.get(0))
            .map_err(db_error)?;
        if version.is_empty() {
            return Err(
                "The encrypted database is not available. No unencrypted history was created.".into(),
            );
        }
        connection.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0)).map_err(|_| "Couldn't unlock your history. The key or the database is damaged; no files have been replaced.".to_string())?;

        let schema: i64 = connection
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(db_error)?;
        if schema > SCHEMA {
            return Err(
                "Historiken skapades av en nyare Copyloom-version. Uppdatera appen.".into(),
            );
        }
        connection.execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON; PRAGMA temp_store=MEMORY; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;").map_err(db_error)?;
        if schema == 0 {
            connection.execute_batch("BEGIN IMMEDIATE;
              CREATE TABLE clips(id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, text_content TEXT, image_png BLOB, created_at INTEGER NOT NULL, last_used_at INTEGER, favorite INTEGER NOT NULL, CHECK((text_content IS NULL) != (image_png IS NULL)));
              CREATE TABLE categories(id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, position INTEGER NOT NULL);
              CREATE TABLE memberships(clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE, category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE, position INTEGER NOT NULL, PRIMARY KEY(clip_id,category_id));
              CREATE TABLE category_order(category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE, clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE, position INTEGER NOT NULL, PRIMARY KEY(category_id,clip_id));
              CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
              CREATE INDEX clips_retention ON clips(favorite,created_at);
              CREATE INDEX memberships_category ON memberships(category_id);
              PRAGMA user_version=1; COMMIT;").map_err(db_error)?;
        }
        if schema < 2 {
            // Export a consistent encrypted backup before changing an existing v1 schema.
            if schema == 1 {
                let backup = path.with_extension("schema-v1.bak");
                if !backup.exists() {
                    let temporary = path.with_extension("schema-v1.bak.tmp");
                    if temporary.exists() { std::fs::remove_file(&temporary).map_err(|_| "Couldn't prepare the database backup.")?; }
                    let escaped = temporary.to_string_lossy().replace('\'', "''");
                    let sql = Zeroizing::new(format!("ATTACH DATABASE '{}' AS migration_backup KEY \"x'{}'\";", escaped, &*hex));
                    connection.execute_batch(&sql).map_err(db_error)?;
                    connection.query_row("SELECT sqlcipher_export('migration_backup')", [], |_| Ok(())).map_err(db_error)?;
                    connection.execute_batch("PRAGMA migration_backup.user_version=1; DETACH DATABASE migration_backup;").map_err(db_error)?;
                    std::fs::rename(&temporary, &backup).map_err(|_| "Couldn't save the database backup.")?;
                }
            }
            connection.execute_batch("BEGIN IMMEDIATE; CREATE TABLE source_apps(id TEXT PRIMARY KEY, name TEXT NOT NULL, icon_png BLOB); ALTER TABLE clips ADD COLUMN source_app_id TEXT REFERENCES source_apps(id); CREATE INDEX clips_source_app ON clips(source_app_id); PRAGMA user_version=2; COMMIT;").map_err(db_error)?;
        }
        if schema < 3 {
            if schema == 2 {
                let backup = path.with_extension("schema-v2.bak");
                if !backup.exists() {
                    let temporary = path.with_extension("schema-v2.bak.tmp");
                    if temporary.exists() { std::fs::remove_file(&temporary).map_err(|_| "Couldn't prepare the backup.")?; }
                    let escaped = temporary.to_string_lossy().replace('\'', "''");
                    let sql = Zeroizing::new(format!("ATTACH DATABASE '{}' AS migration_backup KEY \"x'{}'\";", escaped, &*hex));
                    connection.execute_batch(&sql).map_err(db_error)?;
                    connection.query_row("SELECT sqlcipher_export('migration_backup')", [], |_| Ok(())).map_err(db_error)?;
                    connection.execute_batch("PRAGMA migration_backup.user_version=2; DETACH DATABASE migration_backup;").map_err(db_error)?;
                    std::fs::rename(&temporary, &backup).map_err(|_| "Couldn't save the backup.")?;
                }
            }
            connection.execute_batch("BEGIN IMMEDIATE; ALTER TABLE clips ADD COLUMN html_content TEXT; PRAGMA user_version=3; COMMIT;").map_err(db_error)?;
        }
        if schema < 4 {
            if schema == 3 {
                let backup = path.with_extension("schema-v3.bak");
                if !backup.exists() {
                    let temporary = path.with_extension("schema-v3.bak.tmp");
                    if temporary.exists() { std::fs::remove_file(&temporary).map_err(|_| "Couldn't prepare the backup.")?; }
                    let escaped = temporary.to_string_lossy().replace('\'', "''");
                    let sql = Zeroizing::new(format!("ATTACH DATABASE '{}' AS migration_backup KEY \"x'{}'\";", escaped, &*hex));
                    connection.execute_batch(&sql).map_err(db_error)?;
                    connection.query_row("SELECT sqlcipher_export('migration_backup')", [], |_| Ok(())).map_err(db_error)?;
                    connection.execute_batch("PRAGMA migration_backup.user_version=3; DETACH DATABASE migration_backup;").map_err(db_error)?;
                    std::fs::rename(&temporary, &backup).map_err(|_| "Couldn't save the backup.")?;
                }
            }
            connection.execute_batch("BEGIN IMMEDIATE; ALTER TABLE clips ADD COLUMN custom_title INTEGER NOT NULL DEFAULT 0 CHECK(custom_title IN (0,1)); PRAGMA user_version=4; COMMIT;").map_err(db_error)?;
        }
        // List previews, made once from the original. A cache, not part of the schema version: older
        // versions ignore the table, and each picture is deleted together with its clip. 0.1.30–0.1.31
        // kept smaller PNG thumbnails in `thumbnails`; they are replaced.
        connection.execute_batch("CREATE TABLE IF NOT EXISTS list_pictures(clip_id TEXT PRIMARY KEY REFERENCES clips(id) ON DELETE CASCADE, image BLOB NOT NULL); DROP TABLE IF EXISTS thumbnails;").map_err(db_error)?;
        Ok(Self { connection })
    }

    #[cfg(test)]
    pub fn load(&self, library: &mut Library) -> Result<(), String> { self.load_internal(library, true) }

    pub fn load_metadata(&self, library: &mut Library) -> Result<(), String> { self.load_internal(library, false) }

    pub fn read_html(&self, id: &str) -> Result<Option<String>, String> {
        self.connection.query_row("SELECT html_content FROM clips WHERE id=?", [id], |row| row.get(0)).optional().map_err(db_error).map(Option::flatten)
    }

    /// Deleted clips with their images, formatting and program icons inlined, so the deletion can be
    /// undone. Read before the rows go; None when the media exceeds `limit` bytes.
    pub fn removal(&self, library: &Library, ids: &[String], limit: usize) -> Result<Option<crate::library::Removed>, String> {
        let mut removed = library.removal(ids); let mut bytes = 0;
        for clip in &mut removed.clips {
            let clip = Arc::make_mut(clip);
            if clip.kind == "image" && clip.content.starts_with("copyloom-image:") {
                let png = self.read_media(&clip.id, false)?; bytes += png.len();
                if bytes > limit { return Ok(None); }
                clip.content = format!("data:image/png;base64,{}", STANDARD.encode(png));
            }
            if clip.html.as_ref().is_some_and(|html| html.starts_with("copyloom-html:")) {
                clip.html = self.read_html(&clip.id)?; bytes += clip.html.as_ref().map_or(0, String::len);
                if bytes > limit { return Ok(None); }
            }
            if let Some(source) = &mut clip.source_app {
                if source.icon.as_ref().is_some_and(|icon| icon.starts_with("copyloom-icon:")) {
                    source.icon = self.read_media(&source.id, true).ok().map(|png| format!("data:image/png;base64,{}", STANDARD.encode(png)));
                }
            }
        }
        removed.bytes = bytes; Ok(Some(removed))
    }

    pub fn read_media(&self, id: &str, icon: bool) -> Result<Vec<u8>, String> {
        let query = if icon { "SELECT icon_png FROM source_apps WHERE id=?" }
            else { "SELECT image_png FROM clips WHERE id=? AND kind='image'" };
        self.connection.query_row(query, [id], |row| row.get::<_, Option<Vec<u8>>>(0))
            .optional().map_err(db_error)?.flatten().ok_or_else(|| "The image no longer exists.".into())
    }

    pub fn read_thumbnail(&self, id: &str) -> Result<Option<Vec<u8>>, String> {
        self.connection.query_row("SELECT image FROM list_pictures WHERE clip_id=?", [id], |row| row.get(0)).optional().map_err(db_error)
    }

    /// Ignored when the clip was deleted while its thumbnail was being made.
    pub fn write_thumbnail(&self, id: &str, png: &[u8]) -> Result<(), String> {
        self.connection.execute("INSERT OR REPLACE INTO list_pictures(clip_id, image) SELECT id, ? FROM clips WHERE id=? AND kind='image'", rusqlite::params![png, id]).map(|_| ()).map_err(db_error)
    }

    fn load_internal(&self, library: &mut Library, include_media: bool) -> Result<(), String> {
        // Load relationships once instead of issuing a query for every clip/category.
        let mut memberships: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
        let mut orders: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
        for (query, target) in [
            ("SELECT clip_id,category_id FROM memberships ORDER BY clip_id,position", &mut memberships),
            ("SELECT category_id,clip_id FROM category_order ORDER BY category_id,position", &mut orders),
        ] {
            let mut statement = self.connection.prepare(query).map_err(db_error)?;
            let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).map_err(db_error)?;
            for row in rows { let (id, member) = row.map_err(db_error)?; target.entry(id).or_default().push(member); }
        }
        let mut categories = Vec::new();
        let mut statement = self
            .connection
            .prepare("SELECT id,name,color FROM categories ORDER BY position")
            .map_err(db_error)?;
        let rows = statement
            .query_map([], |r| {
                Ok(Category {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    color: r.get(2)?,
                    clip_order: vec![],
                })
            })
            .map_err(db_error)?;
        for row in rows {
            let mut category = row.map_err(db_error)?;
            category.clip_order = orders.remove(&category.id).unwrap_or_default();
            categories.push(category);
        }
        let mut clips = Vec::new();
        let query = if include_media {
            "SELECT c.id,c.title,c.kind,c.text_content,c.image_png,c.created_at,c.last_used_at,c.favorite,s.id,s.name,s.icon_png,c.html_content,c.custom_title FROM clips c LEFT JOIN source_apps s ON c.source_app_id=s.id ORDER BY c.created_at DESC,c.rowid DESC"
        } else {
            // Do not touch image BLOBs when opening the library.
            "SELECT c.id,c.title,c.kind,c.text_content,NULL,c.created_at,c.last_used_at,c.favorite,s.id,s.name,CASE WHEN s.icon_png IS NOT NULL THEN 1 ELSE 0 END,CASE WHEN c.html_content IS NOT NULL THEN 1 ELSE 0 END,c.custom_title FROM clips c LEFT JOIN source_apps s ON c.source_app_id=s.id ORDER BY c.created_at DESC,c.rowid DESC"
        };
        let mut statement = self.connection.prepare(query).map_err(db_error)?;
        let rows = statement
            .query_map([], |r| {
                let image: Option<Vec<u8>> = r.get(4)?;
                let text: Option<String> = r.get(3)?;
                let id: String = r.get(0)?;
                let kind: String = r.get(2)?;
                Ok(Clip {
                    id: id.clone(),
                    html: if include_media { r.get(11)? } else { (r.get::<_, i64>(11)? != 0).then(|| format!("copyloom-html:{id}")) },
                    title: r.get(1)?,
                    custom_title: r.get(12)?,
                    kind: kind.clone(),
                    content: if !include_media && kind == "image" { format!("copyloom-image:{id}") } else { image
                        .map(|png| format!("data:image/png;base64,{}", STANDARD.encode(png)))
                        .or(text)
                        .unwrap_or_default() },
                    created_at: u64::try_from(r.get::<_, i64>(5)?)
                        .map_err(|_| rusqlite::Error::InvalidQuery)?,
                    last_used_at: r
                        .get::<_, Option<i64>>(6)?
                        .map(u64::try_from)
                        .transpose()
                        .map_err(|_| rusqlite::Error::InvalidQuery)?,
                    favorite: r.get(7)?,
                    category_ids: vec![],
                    source_app: r.get::<_, Option<String>>(8)?.map(|id| -> rusqlite::Result<SourceApp> { Ok(SourceApp { id: id.clone(), name: r.get(9)?, icon: if include_media { r.get::<_, Option<Vec<u8>>>(10)?.map(|png| format!("data:image/png;base64,{}", STANDARD.encode(png))) } else { (r.get::<_, i64>(10)? != 0).then(|| format!("copyloom-icon:{id}")) } }) }).transpose()?,
                })
            })
            .map_err(db_error)?;
        for row in rows {
            let mut clip = row.map_err(db_error)?;
            clip.category_ids = memberships.remove(&clip.id).unwrap_or_default();
            clips.push(Arc::new(clip));
        }
        library.categories = categories;
        library.clips = clips;
        library.storage = "encrypted".into();
        Ok(())
    }

    pub fn import_legacy_categories(&mut self, library: &Library) -> Result<(), String> {
        let imported: Option<String> = self
            .connection
            .query_row(
                "SELECT value FROM metadata WHERE key='legacy_categories_imported'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_error)?;
        if imported.is_some() {
            return Ok(());
        }
        let tx = self.connection.transaction().map_err(db_error)?;
        for (position, category) in library.categories.iter().enumerate() {
            tx.execute(
                "INSERT OR IGNORE INTO categories(id,name,color,position) VALUES(?,?,?,?)",
                params![category.id, category.name, category.color, position as i64],
            )
            .map_err(db_error)?;
        }
        tx.execute(
            "INSERT INTO metadata(key,value) VALUES('legacy_categories_imported','1')",
            [],
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)
    }

    pub fn save_changes(&mut self, before: &Library, after: &Library) -> Result<(), String> {
        use std::collections::{HashMap, HashSet};
        let before_clips: HashMap<&str, &Arc<Clip>> = before
            .clips
            .iter()
            .map(|clip| (clip.id.as_str(), clip))
            .collect();
        let after_ids: HashSet<&str> = after.clips.iter().map(|clip| clip.id.as_str()).collect();
        let after_categories: HashSet<&str> = after
            .categories
            .iter()
            .map(|category| category.id.as_str())
            .collect();
        let tx = self.connection.transaction().map_err(db_error)?;
        for clip in &before.clips {
            if !after_ids.contains(clip.id.as_str()) {
                tx.execute("DELETE FROM clips WHERE id=?", [&clip.id])
                    .map_err(db_error)?;
            }
        }
        for category in &before.categories {
            if !after_categories.contains(category.id.as_str()) {
                tx.execute("DELETE FROM categories WHERE id=?", [&category.id])
                    .map_err(db_error)?;
            }
        }
        for (position, category) in after.categories.iter().enumerate() {
            let old = before.categories.iter().position(|c| c.id == category.id);
            if old.is_none_or(|index| index != position || before.categories[index] != *category) {
                tx.execute("INSERT INTO categories(id,name,color,position) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,color=excluded.color,position=excluded.position", params![category.id,category.name,category.color,position as i64]).map_err(db_error)?;
            }
        }
        // Newest-first memory ordering is preserved by reverse insertion and descending rowid.
        for clip in after.clips.iter().rev() {
            let old = before_clips.get(clip.id.as_str()).copied();
            if old == Some(clip) {
                continue;
            }
            let created_at = i64::try_from(clip.created_at).map_err(|_| "Invalid timestamp.")?;
            let last_used_at = clip
                .last_used_at
                .map(i64::try_from)
                .transpose()
                .map_err(|_| "Invalid timestamp.")?;
            // A deferred icon is already stored; only new icon data is written.
            let source_changed = old.is_none_or(|old| old.source_app != clip.source_app);
            if let Some(source) = clip.source_app.as_ref().filter(|_| source_changed) {
                let png = source.icon.as_deref().filter(|icon| !icon.starts_with("copyloom-icon:")).map(|icon| icon.strip_prefix("data:image/png;base64,").ok_or("Ogiltig programikon.").and_then(|encoded| STANDARD.decode(encoded).map_err(|_| "Ogiltig programikon."))).transpose()?;
                tx.execute("INSERT INTO source_apps(id,name,icon_png) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,icon_png=coalesce(excluded.icon_png,source_apps.icon_png)", params![source.id,source.name,png]).map_err(db_error)?;
            }
            if old.is_none() {
                let image = if clip.kind == "image" {
                    let encoded = clip
                        .content
                        .strip_prefix("data:image/png;base64,")
                        .ok_or("Ogiltig bild.")?;
                    Some(
                        STANDARD
                            .decode(encoded)
                            .map_err(|_| "Couldn't save the image.")?,
                    )
                } else {
                    None
                };
                let text = if image.is_some() {
                    None
                } else {
                    Some(&clip.content)
                };
                tx.execute("INSERT INTO clips(id,title,kind,text_content,image_png,created_at,last_used_at,favorite,source_app_id,html_content,custom_title) VALUES(?,?,?,?,?,?,?,?,?,?,?)", params![clip.id,clip.title,clip.kind,text,image,created_at,last_used_at,clip.favorite,clip.source_app.as_ref().map(|source| &source.id),clip.html,clip.custom_title]).map_err(db_error)?;
            } else {
                let old = old.unwrap();
                tx.execute(
                    "UPDATE clips SET title=?,last_used_at=?,favorite=?,custom_title=?,created_at=?,source_app_id=? WHERE id=?",
                    params![clip.title, last_used_at, clip.favorite, clip.custom_title, created_at, clip.source_app.as_ref().map(|source| &source.id), clip.id],
                )
                .map_err(db_error)?;
                // Edited text: images and deferred formatting are never rewritten from memory.
                if clip.kind != "image" && (old.content != clip.content || old.kind != clip.kind) {
                    if clip.html.as_deref().is_some_and(|html| html.starts_with("copyloom-html:")) { return Err("Ogiltig formatering.".into()); }
                    tx.execute("UPDATE clips SET text_content=?,kind=?,html_content=? WHERE id=?", params![clip.content, clip.kind, clip.html, clip.id]).map_err(db_error)?;
                }
            }
            if old.is_none_or(|c| c.category_ids != clip.category_ids) {
                tx.execute("DELETE FROM memberships WHERE clip_id=?", [&clip.id])
                    .map_err(db_error)?;
                for (position, category_id) in clip.category_ids.iter().enumerate() {
                    tx.execute(
                        "INSERT INTO memberships(clip_id,category_id,position) VALUES(?,?,?)",
                        params![clip.id, category_id, position as i64],
                    )
                    .map_err(db_error)?;
                }
            }
        }
        for category in &after.categories {
            if before
                .categories
                .iter()
                .find(|c| c.id == category.id)
                .is_none_or(|c| c.clip_order != category.clip_order)
            {
                tx.execute(
                    "DELETE FROM category_order WHERE category_id=?",
                    [&category.id],
                )
                .map_err(db_error)?;
                for (position, clip_id) in category.clip_order.iter().enumerate() {
                    tx.execute(
                        "INSERT INTO category_order(category_id,clip_id,position) VALUES(?,?,?)",
                        params![category.id, clip_id, position as i64],
                    )
                    .map_err(db_error)?;
                }
            }
        }
        tx.execute("DELETE FROM source_apps WHERE NOT EXISTS (SELECT 1 FROM clips WHERE clips.source_app_id=source_apps.id)", []).map_err(db_error)?;
        tx.commit().map_err(db_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::Action;
    fn temp() -> (std::path::PathBuf, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("copyloom-db-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        (dir.clone(), dir.join("library.db"))
    }
    #[test]
    fn usage_counts_stored_png_bytes_and_tracks_deletion_and_restart() {
        let (dir, path) = temp(); let key = [27u8; 32]; let mut db = Storage::open(&path, &key).unwrap();
        let empty = db.content_usage().unwrap(); assert_eq!((empty.clip_count, empty.image_count, empty.image_bytes), (0, 0, 0));
        let mut png = Vec::new();
        image::ImageEncoder::write_image(image::codecs::png::PngEncoder::new(&mut png), &[0, 169, 230, 255], 1, 1, image::ExtendedColorType::Rgba8).unwrap();
        let image = Clip::captured(format!("data:image/png;base64,{}", STANDARD.encode(&png))); let image_id = image.id.clone();
        let mut text = Clip::captured("Åäö".into()); text.html = Some("<b>Åäö</b>".into());
        let mut library = Library::default(); library.apply(Action::AddClip { clip: image }).unwrap(); library.apply(Action::AddClip { clip: text }).unwrap();
        db.save_changes(&Library::default(), &library).unwrap();
        let usage = db.content_usage().unwrap(); assert_eq!((usage.clip_count, usage.image_count, usage.image_bytes), (2, 1, png.len() as u64));
        drop(db); let mut db = Storage::open(&path, &key).unwrap(); assert_eq!(db.content_usage().unwrap().image_bytes, png.len() as u64);
        let before = library.clone(); library.apply(Action::DeleteClips { ids: vec![image_id] }).unwrap(); db.save_changes(&before, &library).unwrap();
        let usage = db.content_usage().unwrap(); assert_eq!((usage.clip_count, usage.image_count, usage.image_bytes), (1, 0, 0));
        drop(db); std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn v3_migration_and_renaming_preserve_content_and_save_custom_title() {
        let (dir, path) = temp(); let key = [23u8; 32];
        let mut library = Library::default(); let mut clip = Clip::captured("Get-VM | Select-Object Name".into());
        clip.html = Some("<pre>Get-VM | Select-Object Name</pre>".into()); clip.favorite = true;
        let original = clip.clone(); library.apply(Action::AddClip { clip }).unwrap();
        let mut db = Storage::open(&path, &key).unwrap(); db.save_changes(&Library::default(), &library).unwrap();
        db.connection.execute_batch("ALTER TABLE clips DROP COLUMN custom_title; PRAGMA user_version=3;").unwrap(); drop(db);
        let mut db = Storage::open(&path, &key).unwrap(); let mut restored = Library::default(); db.load_metadata(&mut restored).unwrap();
        assert!(!restored.clips[0].custom_title);
        let before = restored.clone();
        for title in ["", "   ", &"x".repeat(121)] { assert!(restored.apply(Action::RenameClip { id: original.id.clone(), title: title.into() }).is_err()); }
        assert_eq!(restored.clips, before.clips);
        restored.apply(Action::RenameClip { id: original.id.clone(), title: "  Mina servrar  ".into() }).unwrap();
        db.save_changes(&before, &restored).unwrap(); drop(db);
        let db = Storage::open(&path, &key).unwrap(); db.load(&mut restored).unwrap();
        let mut expected = original; expected.title = "Mina servrar".into(); expected.custom_title = true;
        assert_eq!(*restored.clips[0], expected);
        assert_eq!(db.connection.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 4);
        let backup = path.with_extension("schema-v3.bak");
        let bytes = std::fs::read(&backup).unwrap(); assert!(!bytes.windows(6).any(|p| p == b"Get-VM"));
        let backup_db = Connection::open(&backup).unwrap();
        backup_db.execute_batch(&format!("PRAGMA key = \"x'{}'\";", "17".repeat(32))).unwrap();
        assert_eq!(backup_db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 3);
        assert_eq!(backup_db.query_row("SELECT title FROM clips", [], |r| r.get::<_, String>(0)).unwrap(), "Get-VM | Select-Object Name");
        drop(backup_db); drop(db); std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn categorized_history_survives_reopen_and_cleanup_with_saved_protection() {
        let (dir, path) = temp(); let key = [21u8; 32];
        let prefs = dir.join("preferences.json"); let now = 100 * 86_400_000;
        let mut library = Library::default(); library.settings.keep_categorized = true;
        library.storage = "encrypted".into();
        let category = uuid::Uuid::new_v4().to_string();
        library.apply(Action::AddCategory { category: Category { id: category.clone(), name: "Saved".into(), color: "#00a9e6".into(), clip_order: vec![] } }).unwrap();
        for (text, categorized, favorite) in [("saved", true, false), ("old", false, false), ("favorite", false, true)] {
            let mut clip = Clip::captured(text.into()); clip.created_at = 1; clip.favorite = favorite;
            if categorized { clip.category_ids.push(category.clone()); }
            library.apply(Action::AddClip { clip }).unwrap();
        }
        let mut db = Storage::open(&path, &key).unwrap();
        db.save_changes(&Library::default(), &library).unwrap();
        crate::preferences::save(&prefs, &library).unwrap(); drop(db);
        let mut restored = crate::preferences::load(&prefs).unwrap().unwrap();
        assert!(restored.settings.keep_categorized);
        let mut db = Storage::open(&path, &key).unwrap(); db.load_metadata(&mut restored).unwrap();
        assert!(restored.has_expired(now));
        let before = restored.clone(); restored.apply(Action::Prune { now }).unwrap();
        db.save_changes(&before, &restored).unwrap(); drop(db);
        let mut restored = crate::preferences::load(&prefs).unwrap().unwrap();
        let db = Storage::open(&path, &key).unwrap(); db.load(&mut restored).unwrap();
        assert_eq!(restored.clips.len(), 2);
        assert!(restored.clips.iter().any(|c| c.content == "saved" && c.category_ids == vec![category.clone()]));
        assert!(restored.clips.iter().any(|c| c.favorite && c.content == "favorite"));
        assert!(!restored.has_expired(now));
        drop(db); std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn rich_text_survives_restart_and_metadata_changes_without_loading_html() {
        let (dir, path) = temp(); let key = [12u8; 32];
        let mut db = Storage::open(&path, &key).unwrap(); let mut library = Library::default();
        let mut clip = Clip::captured("Åäö link and table".into());
        clip.html = Some("<b>Åäö</b><a href='https://example.com'>link</a><table><tr><td>42</td></tr></table>".into());
        let html = clip.html.clone(); let id = clip.id.clone();
        library.apply(Action::AddClip { clip }).unwrap(); db.save_changes(&Library::default(), &library).unwrap(); drop(db);
        let mut db = Storage::open(&path, &key).unwrap(); let mut metadata = Library::default(); db.load_metadata(&mut metadata).unwrap();
        assert_eq!(metadata.clips[0].html, Some(format!("copyloom-html:{id}")));
        let before = metadata.clone(); metadata.apply(Action::Favorite { id: id.clone(), value: true }).unwrap(); db.save_changes(&before, &metadata).unwrap();
        assert_eq!(db.read_html(&id).unwrap(), html);
        let mut full = Library::default(); db.load(&mut full).unwrap(); assert_eq!(full.clips[0].html, html); drop(db);
        assert!(!std::fs::read(&path).unwrap().windows(10).any(|part| part == b"<table><tr")); std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn v2_migration_preserves_plain_clips_and_encrypted_backup() {
        let (dir, path) = temp(); let key = [13u8; 32]; let mut db = Storage::open(&path, &key).unwrap(); let mut library = Library::default();
        library.apply(Action::AddClip { clip: Clip::captured("existing plain note".into()) }).unwrap(); db.save_changes(&Library::default(), &library).unwrap();
        db.connection.execute_batch("ALTER TABLE clips DROP COLUMN custom_title; ALTER TABLE clips DROP COLUMN html_content; PRAGMA user_version=2;").unwrap(); drop(db);
        let db = Storage::open(&path, &key).unwrap(); let mut loaded = Library::default(); db.load(&mut loaded).unwrap();
        assert_eq!(loaded.clips[0].content, "existing plain note"); assert!(loaded.clips[0].html.is_none()); assert!(path.with_extension("schema-v2.bak").exists());
        assert_eq!(db.connection.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 4); drop(db); std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn metadata_load_preserves_originals_and_is_small_for_image_history() {
        let (dir, path) = temp(); let key = [4u8; 32];
        let mut db = Storage::open(&path, &key).unwrap();
        let mut pixels = vec![0u8; 800 * 450 * 4]; let mut random = 0x12345678u32;
        for pixel in pixels.chunks_exact_mut(4) {
            for channel in &mut pixel[..3] { random ^= random << 13; random ^= random >> 17; random ^= random << 5; *channel = random as u8; }
            pixel[3] = 255;
        }
        let mut png = Vec::new();
        image::ImageEncoder::write_image(image::codecs::png::PngEncoder::new(&mut png), &pixels, 800, 450, image::ExtendedColorType::Rgba8).unwrap();
        let mut library = Library::default();
        library.clips = (0..10000).map(|index| Arc::new(Clip::captured(format!("benchmark synthetic note {index}")))).collect();
        let mut icon = Vec::new();
        image::ImageEncoder::write_image(image::codecs::png::PngEncoder::new(&mut icon), &[0,169,230,255], 1, 1, image::ExtendedColorType::Rgba8).unwrap();
        for _ in 0..32 {
            let mut clip = Clip::captured(format!("data:image/png;base64,{}", STANDARD.encode(&png)));
            clip.source_app = Some(SourceApp { id: "benchmark-source".into(), name: "Test Editor".into(), icon: Some(format!("data:image/png;base64,{}", STANDARD.encode(&icon))) });
            library.clips.push(Arc::new(clip));
        }
        db.save_changes(&Library::default(), &library).unwrap(); drop(db);
        let mut full_times = Vec::new(); let mut metadata_times = Vec::new();
        let mut full_bytes = 0; let mut metadata_bytes = 0;
        // Alternate order so the same warm file cache benefits both approaches.
        for round in 0..4 {
            for include_media in if round % 2 == 0 { [true, false] } else { [false, true] } {
                let start = std::time::Instant::now();
                let db = Storage::open(&path, &key).unwrap();
                let mut loaded = Library::default(); db.load_internal(&mut loaded, include_media).unwrap();
                let bytes = serde_json::to_vec(&loaded).unwrap().len();
                let ms = start.elapsed().as_secs_f64() * 1000.0;
                if include_media { full_times.push(ms); full_bytes = bytes; }
                else { metadata_times.push(ms); metadata_bytes = bytes; }
            }
        }
        full_times.sort_by(f64::total_cmp); metadata_times.sort_by(f64::total_cmp);
        println!("PERFORMANCE_NATIVE full_open_load_serialize_ms={:.1} metadata_open_load_serialize_ms={:.1} full_payload_bytes={} metadata_payload_bytes={}", full_times[2], metadata_times[2], full_bytes, metadata_bytes);
        assert!(metadata_bytes * 10 < full_bytes);
        let mut db = Storage::open(&path, &key).unwrap();
        let mut metadata = Library::default(); db.load_metadata(&mut metadata).unwrap();
        let image = metadata.clips.iter().find(|clip| clip.kind == "image").unwrap();
        let image_id = image.id.clone();
        assert_eq!(image.content, format!("copyloom-image:{image_id}"));
        assert_eq!(image.source_app.as_ref().unwrap().icon.as_deref(), Some("copyloom-icon:benchmark-source"));
        assert_eq!(db.read_media(&image_id, false).unwrap(), png);
        assert_eq!(db.read_media("benchmark-source", true).unwrap(), icon);
        assert!(db.read_media("missing", false).is_err());
        // List thumbnails are a cache beside the original: stored per image clip, never for a missing one,
        // and without changing the schema version older Copyloom versions accept.
        assert_eq!(db.read_thumbnail(&image_id).unwrap(), None);
        db.write_thumbnail(&image_id, b"thumb").unwrap(); db.write_thumbnail("missing", b"thumb").unwrap();
        assert_eq!(db.read_thumbnail(&image_id).unwrap().as_deref(), Some(&b"thumb"[..]));
        assert_eq!(db.read_thumbnail("missing").unwrap(), None);
        assert_eq!(db.connection.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), SCHEMA);
        let before = metadata.clone();
        metadata.apply(Action::Favorite { id: image_id.clone(), value: true }).unwrap();
        metadata.apply(Action::RenameClip { id: image_id.clone(), title: "Original preserved".into() }).unwrap();
        db.save_changes(&before, &metadata).unwrap();
        assert_eq!(db.read_media(&image_id, false).unwrap(), png);
        let mut restored = Library::default(); db.load(&mut restored).unwrap();
        let restored_image = restored.clips.iter().find(|clip| clip.id == image_id).unwrap();
        assert!(restored_image.favorite); assert_eq!(restored_image.title, "Original preserved"); assert!(restored_image.custom_title);
        assert_eq!(restored_image.content, format!("data:image/png;base64,{}", STANDARD.encode(&png)));
        let before = metadata.clone();
        metadata.apply(Action::DeleteClips { ids: vec![image_id.clone()] }).unwrap();
        db.save_changes(&before, &metadata).unwrap();
        assert!(db.read_media(&image_id, false).is_err());
        assert_eq!(db.read_thumbnail(&image_id).unwrap(), None);
        drop(db); std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn encrypted_history_roundtrip_images_favorites_categories_and_order() {
        let (dir, path) = temp();
        let key = [9u8; 32];
        let mut db = Storage::open(&path, &key).unwrap();
        let empty = Library::default();
        let mut library = empty.clone();
        let category = Category {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Work".into(),
            color: "#b663e0".into(),
            clip_order: vec![],
        };
        library
            .apply(Action::AddCategory {
                category: category.clone(),
            })
            .unwrap();
        let mut text = Clip::captured("private-test-only-clipboard-text".into());
        text.category_ids.push(category.id.clone());
        text.favorite = true;
        library
            .apply(Action::AddClip { clip: text.clone() })
            .unwrap();
        let mut png = Vec::new();
        use image::ImageEncoder;
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(&[255, 0, 0, 255], 1, 1, image::ExtendedColorType::Rgba8)
            .unwrap();
        let mut image = Clip::captured(format!("data:image/png;base64,{}", STANDARD.encode(&png)));
        image.category_ids.push(category.id.clone());
        library
            .apply(Action::AddClip {
                clip: image.clone(),
            })
            .unwrap();
        library
            .apply(Action::ReorderCategory {
                id: category.id.clone(),
                clip_order: vec![text.id.clone(), image.id.clone()],
            })
            .unwrap();
        db.save_changes(&empty, &library).unwrap();
        drop(db);
        let mut db = Storage::open(&path, &key).unwrap();
        let mut loaded = Library::default();
        db.load(&mut loaded).unwrap();
        assert_eq!(loaded.clips, library.clips);
        assert_eq!(loaded.categories, library.categories);
        assert!(
            loaded
                .clips
                .iter()
                .find(|c| c.id == text.id)
                .unwrap()
                .favorite
        );
        let before = loaded.clone();
        loaded
            .apply(Action::Favorite {
                id: image.id.clone(),
                value: true,
            })
            .unwrap();
        loaded
            .apply(Action::RenameClip {
                id: image.id.clone(),
                title: "Renamed screenshot".into(),
            })
            .unwrap();
        loaded
            .apply(Action::DeleteClips {
                ids: vec![text.id.clone()],
            })
            .unwrap();
        db.save_changes(&before, &loaded).unwrap();
        assert!(Storage::open(&path, &[8u8; 32]).is_err());
        drop(db);
        let db = Storage::open(&path, &key).unwrap();
        db.load(&mut loaded).unwrap();
        assert_eq!(loaded.clips.len(), 1);
        assert!(loaded.clips[0].favorite);
        assert_eq!(loaded.clips[0].title, "Renamed screenshot");
        assert!(loaded.clips[0].custom_title);
        assert_eq!(loaded.clips[0].content, image.content);
        assert_eq!(loaded.categories[0].clip_order, vec![image.id]);
        drop(db);
        for entry in std::fs::read_dir(&dir).unwrap() {
            let bytes = std::fs::read(entry.unwrap().path()).unwrap();
            assert!(!bytes
                .windows(text.content.len())
                .any(|window| window == text.content.as_bytes()));
            assert!(!bytes.starts_with(b"SQLite format 3"));
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn failed_transaction_preserves_existing_history() {
        let (dir, path) = temp();
        let mut db = Storage::open(&path, &[1u8; 32]).unwrap();
        let empty = Library::default();
        let mut before = empty.clone();
        before
            .apply(Action::AddClip {
                clip: Clip::captured("keep-this".into()),
            })
            .unwrap();
        db.save_changes(&empty, &before).unwrap();
        db.connection.execute_batch("CREATE TRIGGER fail_insert BEFORE INSERT ON clips BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END;").unwrap();
        let mut after = before.clone();
        after.clips.clear();
        after
            .apply(Action::AddClip {
                clip: Clip::captured("new-content".into()),
            })
            .unwrap();
        assert!(db.save_changes(&before, &after).is_err());
        let mut loaded = Library::default();
        db.load(&mut loaded).unwrap();
        assert_eq!(loaded.clips, before.clips);
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn import_once_and_prune_does_not_resurrect_deleted_categories() {
        let (dir, path) = temp();
        let mut db = Storage::open(&path, &[2u8; 32]).unwrap();
        let mut legacy = Library::default();
        legacy
            .apply(Action::AddCategory {
                category: Category {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: "Legacy".into(),
                    color: "#b663e0".into(),
                    clip_order: vec![],
                },
            })
            .unwrap();
        db.import_legacy_categories(&legacy).unwrap();
        let mut loaded = Library::default();
        db.load(&mut loaded).unwrap();
        assert_eq!(loaded.categories.len(), 1);
        let mut next = loaded.clone();
        next.categories.clear();
        db.save_changes(&loaded, &next).unwrap();
        db.import_legacy_categories(&legacy).unwrap();
        db.load(&mut loaded).unwrap();
        assert!(loaded.categories.is_empty());
        let before = loaded.clone();
        let mut expired = Clip::captured("expired".into());
        expired.created_at = 1;
        let mut favorite = Clip::captured("favorite".into());
        favorite.created_at = 1;
        favorite.favorite = true;
        loaded.apply(Action::AddClip { clip: expired }).unwrap();
        loaded
            .apply(Action::AddClip {
                clip: favorite.clone(),
            })
            .unwrap();
        db.save_changes(&before, &loaded).unwrap();
        let before = loaded.clone();
        loaded
            .apply(Action::Prune {
                now: 90 * 86_400_000,
            })
            .unwrap();
        db.save_changes(&before, &loaded).unwrap();
        drop(db);
        let db = Storage::open(&path, &[2u8; 32]).unwrap();
        db.load(&mut loaded).unwrap();
        assert_eq!(loaded.clips, vec![Arc::new(favorite)]);
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn corrupt_file_and_newer_schema_are_not_overwritten() {
        let (dir, path) = temp();
        std::fs::write(&path, b"existing-corrupt-test-database").unwrap();
        let original = std::fs::read(&path).unwrap();
        assert!(Storage::open(&path, &[3u8; 32]).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), original);
        // Separate file for an otherwise valid database from a newer version.
        let newer = dir.join("newer.db");
        let db = Storage::open(&newer, &[3u8; 32]).unwrap();
        db.connection
            .execute_batch("PRAGMA user_version=5")
            .unwrap();
        drop(db);
        assert!(Storage::open(&newer, &[3u8; 32]).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn committed_wal_data_is_readable_without_clean_shutdown_and_encrypted_on_disk() {
        let (dir, path) = temp();
        let mut first = Storage::open(&path, &[4u8; 32]).unwrap();
        let before = Library::default();
        let mut after = before.clone();
        let clip = Clip::captured("private-wal-test-payload".into());
        after.apply(Action::AddClip { clip: clip.clone() }).unwrap();
        first.save_changes(&before, &after).unwrap();
        let second = Storage::open(&path, &[4u8; 32]).unwrap();
        let mut loaded = Library::default();
        second.load(&mut loaded).unwrap();
        assert_eq!(loaded.clips, after.clips);
        let wal = std::fs::read(dir.join("library.db-wal")).unwrap();
        assert!(!wal
            .windows(clip.content.len())
            .any(|bytes| bytes == clip.content.as_bytes()));
        drop(second);
        drop(first);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn loads_ten_thousand_clips_with_memberships_and_manual_order() {
        let (dir, path) = temp();
        let mut db = Storage::open(&path, &[23u8;32]).unwrap();
        let empty = Library::default();
        let category_id = uuid::Uuid::new_v4().to_string();
        let mut library = Library::default();
        library.clips = (0..10_000).map(|index| { let mut clip = Clip::captured(format!("Benchmark entry {}",index)); clip.created_at = 20_000 - index as u64; clip.category_ids.push(category_id.clone()); Arc::new(clip) }).collect();
        library.categories.push(Category { id: category_id.clone(), name: "Benchmark".into(), color: "#00a9e6".into(), clip_order: library.clips.iter().rev().map(|clip| clip.id.clone()).collect() });
        db.save_changes(&empty, &library).unwrap();
        let started = std::time::Instant::now();
        let mut restored = Library::default();
        db.load(&mut restored).unwrap();
        eprintln!("10,000 text clips loaded in {:?} (warm database, excludes WebView startup)", started.elapsed());
        assert_eq!(restored.clips, library.clips);
        assert_eq!(restored.categories, library.categories);
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn migrates_v1_without_losing_history_and_keeps_encrypted_backup() {
        let (dir, path) = temp();
        let key = [7u8; 32];
        let mut db = Storage::open(&path, &key).unwrap();
        let mut library = Library::default();
        let mut clip = Clip::captured("old-private-v1-content".into()); clip.favorite = true;
        library.apply(Action::AddClip { clip }).unwrap();
        db.save_changes(&Library::default(), &library).unwrap();
        db.connection.execute_batch("ALTER TABLE clips DROP COLUMN custom_title; ALTER TABLE clips DROP COLUMN html_content; DROP INDEX clips_source_app; ALTER TABLE clips DROP COLUMN source_app_id; DROP TABLE source_apps; PRAGMA user_version=1;").unwrap();
        drop(db);
        let db = Storage::open(&path, &key).unwrap();
        let mut restored = Library::default(); db.load(&mut restored).unwrap();
        assert_eq!(restored.clips, library.clips);
        let backup = path.with_extension("schema-v1.bak");
        let bytes = std::fs::read(&backup).unwrap();
        assert!(!bytes.windows(21).any(|window| window == b"old-private-v1-content"));
        assert!(Connection::open(&backup).unwrap().query_row("SELECT count(*) FROM clips", [], |r| r.get::<_, i64>(0)).is_err());
        let backup_db = Connection::open(&backup).unwrap();
        backup_db.execute_batch(&format!("PRAGMA key = \"x'{}'\";", "07".repeat(32))).unwrap();
        assert_eq!(backup_db.query_row("SELECT text_content FROM clips", [], |r| r.get::<_,String>(0)).unwrap(), "old-private-v1-content");
        assert_eq!(backup_db.query_row("PRAGMA user_version", [], |r| r.get::<_,i64>(0)).unwrap(), 1);
        drop(backup_db); drop(db); std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn deleted_image_text_and_category_places_come_back_after_undo_and_reopen() {
        let (dir, path) = temp(); let key = [31u8; 32];
        let mut png = Vec::new();
        image::ImageEncoder::write_image(image::codecs::png::PngEncoder::new(&mut png), &[0,169,230,255, 229,45,69,255], 2, 1, image::ExtendedColorType::Rgba8).unwrap();
        let data = format!("data:image/png;base64,{}", STANDARD.encode(&png));
        let source = SourceApp { id: "teams".into(), name: "Microsoft Teams".into(), icon: Some(data.clone()) };
        let mut library = Library::default();
        let category = Category { id: uuid::Uuid::new_v4().to_string(), name: "Jobb".into(), color: "#00a9e6".into(), clip_order: vec![] };
        library.apply(Action::AddCategory { category: category.clone() }).unwrap();
        let mut image = Clip::captured(data.clone()); image.source_app = Some(source); image.favorite = true;
        let mut text = Clip::captured("Get-VM".into()); text.html = Some("<b>Get-VM</b>".into());
        let kept = Clip::captured("behålls".into());
        for clip in [image.clone(), text.clone(), kept.clone()] { library.apply(Action::AddClip { clip }).unwrap(); }
        for id in [&image.id, &text.id, &kept.id] { library.apply(Action::SetClipCategories { id: id.clone(), category_ids: vec![category.id.clone()] }).unwrap(); }
        library.apply(Action::RenameClip { id: image.id.clone(), title: "Kvitto".into() }).unwrap();
        library.apply(Action::ReorderCategory { id: category.id.clone(), clip_order: vec![image.id.clone(), kept.id.clone(), text.id.clone()] }).unwrap();
        let mut db = Storage::open(&path, &key).unwrap(); db.save_changes(&Library::default(), &library).unwrap(); drop(db);
        // The running app holds metadata only; media must be read back before the rows are deleted.
        let mut db = Storage::open(&path, &key).unwrap(); let mut metadata = Library::default(); db.load_metadata(&mut metadata).unwrap();
        let mut full = Library::default(); db.load(&mut full).unwrap();
        let ids = vec![image.id.clone(), text.id.clone()];
        assert_eq!(db.removal(&metadata, &ids, png.len() - 1).unwrap(), None);
        let removed = db.removal(&metadata, &ids, 64 * 1024 * 1024).unwrap().unwrap();
        let before = metadata.clone(); metadata.apply(Action::DeleteClips { ids }).unwrap(); db.save_changes(&before, &metadata).unwrap();
        assert_eq!(db.connection.query_row("SELECT count(*) FROM source_apps", [], |r| r.get::<_,i64>(0)).unwrap(), 0);
        let before = metadata.clone(); metadata.apply(Action::RestoreClips { removed }).unwrap(); db.save_changes(&before, &metadata).unwrap(); drop(db);
        let db = Storage::open(&path, &key).unwrap(); let mut reopened = Library::default(); db.load(&mut reopened).unwrap();
        let by_id = |library: &Library, id: &str| library.clips.iter().find(|clip| clip.id == id).cloned().unwrap();
        for id in [&image.id, &text.id, &kept.id] { assert_eq!(by_id(&reopened, id), by_id(&full, id)); }
        assert_eq!(reopened.categories, full.categories);
        drop(db); std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn source_icons_are_shared_persisted_and_removed_when_unused() {
        let (dir, path) = temp(); let key = [8u8; 32];
        let mut db = Storage::open(&path, &key).unwrap();
        let mut png = Vec::new();
        image::ImageEncoder::write_image(image::codecs::png::PngEncoder::new(&mut png), &[0,169,230,255], 1, 1, image::ExtendedColorType::Rgba8).unwrap();
        let source = SourceApp { id: "editor".into(), name: "Test Editor".into(), icon: Some(format!("data:image/png;base64,{}", STANDARD.encode(&png))) };
        let mut library = Library::default();
        for content in ["first-source-test", "second-source-test"] { let mut clip = Clip::captured(content.into()); clip.source_app = Some(source.clone()); library.apply(Action::AddClip { clip }).unwrap(); }
        db.save_changes(&Library::default(), &library).unwrap(); drop(db);
        let mut db = Storage::open(&path, &key).unwrap();
        let mut restored = Library::default(); db.load(&mut restored).unwrap();
        assert_eq!(restored.clips, library.clips);
        assert_eq!(db.connection.query_row("SELECT count(*) FROM source_apps", [], |r| r.get::<_,i64>(0)).unwrap(), 1);
        let before = restored.clone(); restored.apply(Action::DeleteClips { ids: vec![restored.clips[0].id.clone()] }).unwrap(); db.save_changes(&before, &restored).unwrap();
        assert_eq!(db.connection.query_row("SELECT count(*) FROM source_apps", [], |r| r.get::<_,i64>(0)).unwrap(), 1);
        let before = restored.clone(); restored.apply(Action::DeleteClips { ids: vec![restored.clips[0].id.clone()] }).unwrap(); db.save_changes(&before, &restored).unwrap();
        assert_eq!(db.connection.query_row("SELECT count(*) FROM source_apps", [], |r| r.get::<_,i64>(0)).unwrap(), 0);
        drop(db); std::fs::remove_dir_all(dir).unwrap();
    }

}

#[cfg(test)]
mod recopy_storage_tests {
    use super::*;
    use crate::library::{Action, SourceApp};
    #[test]
    fn moved_and_edited_clips_keep_their_place_and_text_after_reopening() {
        let dir = std::env::temp_dir().join(format!("copyloom-db-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let (path, key) = (dir.join("library.db"), [31u8; 32]);
        let mut db = Storage::open(&path, &key).unwrap();
        let mut library = Library::default();
        for (index, text) in ["first", "second", "third"].into_iter().enumerate() {
            let mut clip = Clip::captured(text.into()); clip.created_at = 10 + index as u64;
            clip.html = (text == "second").then(|| "<i>second</i>".to_string());
            library.apply(Action::AddClip { clip }).unwrap();
        }
        db.save_changes(&Library::default(), &library).unwrap();
        let first = library.clips.iter().find(|clip| clip.content == "first").unwrap().id.clone();
        let second = library.clips.iter().find(|clip| clip.content == "second").unwrap().id.clone();
        // Copied again from another program, then edited: both survive a restart in the new order.
        let before = library.clone();
        let mut again = Clip::captured("first".into()); again.created_at = 99;
        again.source_app = Some(SourceApp { id: "teams".into(), name: "Teams".into(), icon: None });
        library.apply(Action::AddClip { clip: again }).unwrap();
        db.save_changes(&before, &library).unwrap();
        let before = library.clone();
        library.apply(Action::EditClip { id: second.clone(), content: "second, edited".into() }).unwrap();
        db.save_changes(&before, &library).unwrap(); drop(db);
        let db = Storage::open(&path, &key).unwrap(); let mut restored = Library::default(); db.load(&mut restored).unwrap();
        let order: Vec<&str> = restored.clips.iter().map(|clip| clip.content.as_str()).collect();
        assert_eq!(order, ["first", "third", "second, edited"]);
        assert_eq!(restored.clips[0].id, first);
        assert_eq!((restored.clips[0].created_at, restored.clips[0].source_app.as_ref().map(|s| s.name.as_str())), (99, Some("Teams")));
        assert_eq!((restored.clips[2].html.as_ref(), restored.clips[2].kind.as_str()), (None, "text"));
        drop(db); let _ = std::fs::remove_dir_all(dir);
    }
}
