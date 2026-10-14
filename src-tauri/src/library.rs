use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::{SystemTime, UNIX_EPOCH}};
use uuid::Uuid;

pub const MAX_CONTENT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_IMAGE_CONTENT_BYTES: usize = 128 * 1024 * 1024;
pub const MAX_IMAGE_RGBA_BYTES: usize = 256 * 1024 * 1024;
const CATEGORY_COLORS: [&str; 6] = [
    "#00a9e6", "#f0554d", "#52cc64", "#62a8f5", "#fa9214", "#fab700",
];

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    #[serde(default)]
    pub source_app: Option<SourceApp>,
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub custom_title: bool,
    pub kind: String,
    pub content: String,
    #[serde(default)]
    pub html: Option<String>,
    pub created_at: u64,
    pub last_used_at: Option<u64>,
    pub favorite: bool,
    pub category_ids: Vec<String>,
}

/// Clips a user deleted, with media inlined by storage, and their places in manual category orders.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Removed {
    pub clips: Vec<Arc<Clip>>,
    pub orders: Vec<(String, Vec<(usize, String)>)>,
    /// Inlined media, counted against the undo budget.
    pub bytes: usize,
}

/// User deletions, newest last, undone one at a time like any undo history. Kept in memory only:
/// gone after a restart, and the oldest fall away beyond `LIMIT` entries or the media budget.
/// `None` marks a deletion whose media was too large to keep.
#[derive(Default)]
pub struct Deletions { entries: Vec<Option<Removed>> }
impl Deletions {
    pub const LIMIT: usize = 50;
    pub fn push(&mut self, removed: Option<Removed>, budget: usize) {
        self.entries.push(removed);
        while self.entries.len() > Self::LIMIT || self.entries.iter().flatten().map(|removed| removed.bytes).sum::<usize>() > budget { self.entries.remove(0); }
    }
    /// The most recent deletion: `None` when there is nothing left, `Some(None)` when it cannot be undone.
    pub fn pop(&mut self) -> Option<Option<Removed>> { self.entries.pop() }
    /// Puts back a deletion whose restore failed, so it can be retried.
    pub fn restore_failed(&mut self, removed: Removed) { self.entries.push(Some(removed)); }
    pub fn can_undo(&self) -> bool { matches!(self.entries.last(), Some(Some(_))) }
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: String,
    pub name: String,
    pub color: String,
    pub clip_order: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub shortcut: String,
    #[serde(default)]
    pub capture_shortcut: Option<String>,
    pub retention_days: Option<u32>,
    #[serde(default)]
    pub keep_categorized: bool,
    pub theme: String,
    #[serde(default)]
    pub start_minimized: bool,
    #[serde(default = "enabled_by_default")]
    pub paste_directly: bool,
    #[serde(default)]
    pub edit_after_capture: bool,
    #[serde(default)]
    pub capture_behavior: Option<String>,
    #[serde(default = "default_language")]
    pub language: String,
    /// Win+V also opens the quick panel, once Windows has released it.
    #[serde(default)]
    pub win_v: bool,
    #[serde(default)]
    pub excluded_programs: Vec<String>,
    /// Where the quick panel opens: "pointer", "caret", "center" or "last".
    #[serde(default = "default_panel_position")]
    pub panel_position: String,
    /// What uses a clip in the quick panel: "single" click (default) or "double" click, which leaves a click to select.
    #[serde(default = "default_panel_click")]
    pub panel_click: String,
    /// The trash button on the quick panel's rows: "always" (default), on "hover", or "off".
    #[serde(default = "default_panel_trash")]
    pub panel_trash: String,
}

fn enabled_by_default() -> bool { true }
fn default_language() -> String { "en".into() }
fn default_panel_position() -> String { "pointer".into() }
fn default_panel_click() -> String { "single".into() }
fn default_panel_trash() -> String { "always".into() }

impl Default for Settings {
    fn default() -> Self {
        Self {
            shortcut: "Ctrl+Shift+V".into(),
            capture_shortcut: None,
            retention_days: Some(30),
            keep_categorized: false,
            theme: "system".into(),
            start_minimized: false,
            paste_directly: true,
            edit_after_capture: false,
            capture_behavior: None,
            language: default_language(),
            win_v: false,
            excluded_programs: vec![],
            panel_position: default_panel_position(),
            panel_click: default_panel_click(),
            panel_trash: default_panel_trash(),
        }
    }
}

#[derive(Clone, Default, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub revision: u64,
    /// Shared so a library snapshot clones pointers; edits copy only the changed clip.
    pub clips: Vec<Arc<Clip>>,
    pub categories: Vec<Category>,
    pub settings: Settings,
    pub paused: bool,
    pub storage: String,
    pub storage_path: Option<String>,
}

#[derive(Clone, Deserialize, Debug)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Action {
    AddClip {
        clip: Clip,
    },
    /// From the image editor. A repeated copy in the same editor window replaces its earlier result.
    AddEditedImage {
        clip: Clip,
        #[serde(default)]
        replaces: Option<String>,
    },
    Favorite {
        id: String,
        value: bool,
    },
    RenameClip {
        id: String,
        title: String,
    },
    DeleteClips {
        ids: Vec<String>,
    },
    // Undo of DeleteClips, built natively from a snapshot; never accepted from a window.
    #[serde(skip_deserializing)]
    RestoreClips {
        removed: Removed,
    },
    SetClipCategories {
        id: String,
        category_ids: Vec<String>,
    },
    /// Replaces a text clip's content; its formatting no longer matches and is dropped.
    EditClip {
        id: String,
        content: String,
    },
    // The same formatted text copied again, matched against stored formatting; never accepted from a window.
    #[serde(skip_deserializing)]
    Recopied {
        id: String,
        clip: Clip,
    },
    AddCategory {
        category: Category,
    },
    RenameCategory {
        id: String,
        name: String,
    },
    DeleteCategory {
        id: String,
    },
    ReorderCategory {
        id: String,
        clip_order: Vec<String>,
    },
    SetSettings {
        settings: Settings,
    },
    SetPaused {
        value: bool,
    },
    /// `top`: used from the quick panel, so it becomes the newest clip, as a fresh copy would.
    MarkUsed {
        id: String,
        at: u64,
        #[serde(default)]
        top: bool,
    },
    Prune {
        now: u64,
    },
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn is_powershell(content: &str) -> bool {
    content.lines().any(|line| {
        let text = line.trim().to_ascii_lowercase();
        if text.starts_with("#requires ")
            || text.starts_with("#requires\t")
            || text
                .strip_prefix("param")
                .is_some_and(|rest| rest.trim_start().starts_with('('))
        {
            return true;
        }
        if let Some(rest) = text.strip_prefix('$') {
            let name: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '.')
                .collect();
            let tail = rest[name.len()..].trim_start();
            if !name.is_empty() && (tail.starts_with('=') || tail.starts_with('|')) {
                return true;
            }
        }
        for kind in [
            "string",
            "bool",
            "int",
            "switch",
            "hashtable",
            "datetime",
            "pscustomobject",
            "psobject",
        ] {
            for prefix in [format!("[{kind}]"), format!("[{kind}[]]")] {
                if text.strip_prefix(&prefix).is_some_and(|rest| {
                    rest.trim_start().starts_with('$') || rest.trim_start().starts_with("@{")
                }) {
                    return true;
                }
            }
        }
        let command = text.split_whitespace().next().unwrap_or("");
        if let Some((verb, noun)) = command.split_once('-') {
            let verbs = [
                "get",
                "set",
                "new",
                "remove",
                "invoke",
                "import",
                "export",
                "write",
                "read",
                "connect",
                "disconnect",
                "test",
                "start",
                "stop",
                "foreach",
                "where",
                "select",
                "sort",
                "measure",
                "add",
                "clear",
                "copy",
                "move",
                "join",
                "split",
                "convertfrom",
                "convertto",
                "out",
                "format",
                "enable",
                "disable",
                "register",
                "unregister",
                "update",
                "install",
                "uninstall",
            ];
            return verbs.contains(&verb)
                && noun.starts_with(|c: char| c.is_ascii_alphabetic())
                && noun.chars().all(|c| c.is_ascii_alphanumeric());
        }
        false
    })
}

pub fn classify(content: &str) -> &'static str {
    let trimmed = content.trim();
    if trimmed.starts_with("data:image/png;base64,") {
        return "image";
    }
    if trimmed.len() == 7
        && trimmed.starts_with('#')
        && trimmed[1..].bytes().all(|b| b.is_ascii_hexdigit())
    {
        return "color";
    }
    if (trimmed.starts_with("https://") || trimmed.starts_with("http://"))
        && !trimmed.chars().any(char::is_whitespace)
    {
        return "link";
    }
    if is_powershell(content) {
        return "code";
    }
    if [
        "const ",
        "function ",
        "import ",
        "export ",
        "SELECT ",
        "async ",
        "def ",
        "=>",
        "{\n",
    ]
    .iter()
    .any(|pattern| content.contains(pattern))
    {
        return "code";
    }
    "text"
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceApp { pub id: String, pub name: String, pub icon: Option<String> }

impl Clip {
    pub fn captured(content: String) -> Self {
        let kind = classify(&content).to_string();
        let title = if kind == "image" {
            "Copied image".into()
        } else {
            content
                .trim()
                .lines()
                .next()
                .unwrap_or("Text")
                .chars()
                .take(80)
                .collect()
        };
        Self {
            source_app: None,
            html: None,
            id: Uuid::new_v4().to_string(),
            title,
            custom_title: false,
            kind,
            content,
            created_at: now_ms(),
            last_used_at: None,
            favorite: false,
            category_ids: vec![],
        }
    }
}

pub fn validate_capture_shortcut(shortcut: &str) -> Result<(), String> {
    let mut parts:Vec<&str>=shortcut.split('+').collect(); let key=parts.pop().unwrap_or("");
    if key=="F12" { return Err("F12 is reserved by Windows, even with Ctrl/Shift. Choose another key.".into()); }
    let function=key.strip_prefix('F').and_then(|n|n.parse::<u8>().ok()).is_some_and(|n|(1..=24).contains(&n));
    let letter=key.len()==1 && key.bytes().all(|b|b.is_ascii_uppercase() || b.is_ascii_digit());
    if parts.len()>3 || parts.iter().any(|p|!["Ctrl","Alt","Shift","Super"].contains(p)) || parts.iter().enumerate().any(|(i,p)|parts[..i].contains(p))
        || !(key=="PrintScreen" || function || letter) || (letter && !parts.iter().any(|p|["Ctrl","Alt","Super"].contains(p))) {
        return Err("Choose Print Screen, a function key, or Ctrl/Alt/Win with a letter or number.".into());
    }
    Ok(())
}

pub fn program_excluded(path: &str, programs: &[String]) -> bool {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    programs.iter().any(|program| program.eq_ignore_ascii_case(name))
}

#[cfg(test)]
mod exclusion_tests {
    use super::*;
    #[test]
    fn exclusions_match_exact_executable_names_in_both_windows_path_forms() {
        let excluded = vec!["KeePass.exe".into(), "mstsc.exe".into()];
        assert!(program_excluded(r"C:\Program Files\KeePass\KEEPASS.EXE", &excluded));
        assert!(program_excluded("C:/Windows/System32/mstsc.exe", &excluded));
        assert!(!program_excluded("C:/tools/keepass.exe.backup", &excluded));
        assert!(!program_excluded("notkeepass.exe", &excluded));
        let mut settings = Settings::default(); settings.excluded_programs = excluded; assert!(validate_settings(&settings).is_ok());
        for invalid in ["*pass.exe", "C:/KeePass.exe", "keepass", "bad\n.exe"] { settings.excluded_programs = vec![invalid.into()]; assert!(validate_settings(&settings).is_err()); }
        let legacy: Settings = serde_json::from_str(r#"{"shortcut":"Ctrl+Shift+V","retentionDays":30,"theme":"system"}"#).unwrap(); assert!(legacy.excluded_programs.is_empty());
    }
}

pub fn validate_settings(settings: &Settings) -> Result<(), String> {
    if settings.excluded_programs.len() > 100 || settings.excluded_programs.iter().any(|name| name.len() > 260 || name.len() <= 4 || !name.to_ascii_lowercase().ends_with(".exe") || name.chars().any(|c| c.is_control() || r#"<>:"/\|?*"#.contains(c))) {
        return Err("Enter the executable name, such as KeePass.exe (up to 100 programs).".into());
    }
    if !["en", "sv"].contains(&settings.language.as_str()) { return Err("Invalid language.".into()); }
    if !["pointer", "caret", "center", "last"].contains(&settings.panel_position.as_str()) { return Err("Invalid quick panel position.".into()); }
    if !["single", "double"].contains(&settings.panel_click.as_str()) { return Err("Invalid quick panel click setting.".into()); }
    if !["always", "hover", "off"].contains(&settings.panel_trash.as_str()) { return Err("Invalid quick panel trash button setting.".into()); }
    if settings.capture_behavior.as_deref().is_some_and(|value| !["copy", "edit", "choose"].contains(&value)) { return Err("Invalid action after screenshot.".into()); }
    let mut parts: Vec<&str> = settings.shortcut.split('+').collect();
    let key = parts.pop().ok_or("Ogiltigt snabbkommando.")?;
    if key=="F12" { return Err("F12 is reserved by Windows, even with Ctrl/Shift. Choose another key.".into()); }
    if parts.is_empty()
        || parts.len() > 3
        || !parts.iter().any(|p| ["Ctrl", "Alt", "Super"].contains(p))
        || parts
            .iter()
            .any(|p| !["Ctrl", "Alt", "Shift", "Super"].contains(p))
        || parts
            .iter()
            .enumerate()
            .any(|(i, p)| parts[..i].contains(p))
    {
        return Err("Choose Ctrl, Alt or Win with a letter, digit or F key.".into());
    }
    let valid_key = (key.len() == 1
        && key
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()))
        || key
            .strip_prefix('F')
            .and_then(|n| n.parse::<u8>().ok())
            .is_some_and(|n| (1..=12).contains(&n));
    if !valid_key {
        return Err("Ogiltig tangent i snabbkommandot.".into());
    }
    if let Some(capture) = &settings.capture_shortcut {
        validate_capture_shortcut(capture)?;
        if capture == &settings.shortcut || (settings.win_v && capture == "Super+V") { return Err("The panel and screenshot need different shortcuts.".into()); }
    }
    if settings.retention_days.is_some_and(|n| n == 0 || n > 36500) {
        return Err("Choose 1–36,500 days or keep forever.".into());
    }
    if !["system", "light", "dark"].contains(&settings.theme.as_str()) {
        return Err("Invalid theme.".into());
    }
    Ok(())
}

fn valid_name(value: &str, maximum: usize) -> Result<String, String> {
    let name = value.trim();
    if name.is_empty() || name.chars().count() > maximum {
        return Err(format!("The name must contain 1–{maximum} characters."));
    }
    Ok(name.to_string())
}

impl Library {
    /// Clips about to be deleted and their manual positions; storage inlines the media.
    pub fn removal(&self, ids: &[String]) -> Removed {
        Removed {
            clips: self.clips.iter().filter(|clip| ids.contains(&clip.id)).cloned().collect(),
            orders: self.categories.iter().filter_map(|category| {
                let positions: Vec<(usize, String)> = category.clip_order.iter().enumerate().filter(|(_, id)| ids.contains(id)).map(|(position, id)| (position, id.clone())).collect();
                (!positions.is_empty()).then(|| (category.id.clone(), positions))
            }).collect(),
            bytes: 0,
        }
    }

    fn remove(&mut self, ids: &[String]) {
        self.clips.retain(|clip| !ids.contains(&clip.id));
        for category in &mut self.categories {
            category.clip_order.retain(|id| !ids.contains(id));
        }
    }

    /// Moves a clip to the top as if it had just been copied; everything the user gave it stays.
    fn bring_to_top(&mut self, index: usize, at: u64, source: Option<SourceApp>) {
        let mut clip = self.clips.remove(index);
        let edited = Arc::make_mut(&mut clip);
        edited.created_at = at;
        if source.is_some() { edited.source_app = source; }
        self.clips.insert(0, clip);
    }

    /// True when `Action::Prune { now }` would remove at least one clip.
    pub fn has_expired(&self, now: u64) -> bool {
        self.settings.retention_days.is_some_and(|days| {
            let cutoff = now.saturating_sub(days as u64 * 86_400_000);
            self.clips.iter().any(|clip| !clip.favorite && !(self.settings.keep_categorized && !clip.category_ids.is_empty()) && clip.created_at <= cutoff)
        })
    }

    pub fn apply(&mut self, action: Action) -> Result<(), String> {
        let (edited_image, replaces) = match &action { Action::AddEditedImage { replaces, .. } => (true, replaces.clone()), _ => (false, None) };
        match action {
            Action::AddClip { mut clip } | Action::AddEditedImage { mut clip, .. } => {
                if edited_image && clip.kind != "image" { return Err("Only images can be saved from the editor.".into()); }
                if clip.html.as_ref().is_some_and(|html| html.len() > MAX_CONTENT_BYTES || html.starts_with("copyloom-html:")) { return Err("Ogiltig formatering.".into()); }
                if clip.kind == "image" { clip.html = None; }
                let limit=if clip.content.starts_with("data:image/png;base64,") { MAX_IMAGE_CONTENT_BYTES } else { MAX_CONTENT_BYTES };
                if clip.content.trim().is_empty() || clip.content.len() > limit {
                    return Err("The clip is empty or larger than the size limit.".into());
                }
                if clip
                    .category_ids
                    .iter()
                    .any(|id| !self.categories.iter().any(|c| &c.id == id))
                {
                    return Err("The category no longer exists.".into());
                }
                if let Some(source) = &mut clip.source_app {
                    if source.id.is_empty() || source.id.len() > 64 || !source.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') { return Err("Invalid source app.".into()); }
                    source.name = valid_name(&source.name, 120)?;
                    if let Some(icon) = &source.icon {
                        use base64::Engine;
                        let encoded = icon.strip_prefix("data:image/png;base64,").ok_or("Ogiltig programikon.")?;
                        if encoded.len() > 90_000 { return Err("The app icon is too large.".into()); }
                        let png = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| "Ogiltig programikon.")?;
                        let (width, height) = image::ImageReader::with_format(std::io::Cursor::new(&png), image::ImageFormat::Png).into_dimensions().map_err(|_| "Ogiltig programikon.")?;
                        if width == 0 || height == 0 || width > 64 || height > 64 { return Err("Ogiltig programikonstorlek.".into()); }
                    }
                }
                clip.kind = classify(&clip.content).into();
                clip.title = valid_name(&clip.title, 120)?;
                // Copying something already in the history moves that clip up instead of adding a duplicate.
                if !edited_image && clip.kind != "image" {
                    if let Some(index) = self.clips.iter().position(|c| c.kind != "image" && c.content == clip.content && c.html == clip.html) {
                        if index == 0 { return Ok(()); }
                        self.bring_to_top(index, clip.created_at, clip.source_app);
                        self.revision += 1;
                        return Ok(());
                    }
                }
                if Uuid::parse_str(&clip.id).is_err() || self.clips.iter().any(|c| c.id == clip.id)
                {
                    return Err("Invalid or duplicate clip ID.".into());
                }
                // The earlier result gives way to the new one, which keeps its favorite, name, categories and place in them.
                if let Some(index) = replaces.as_deref().and_then(|old| self.clips.iter().position(|c| c.id == old && c.kind == "image")) {
                    let previous = self.clips.remove(index);
                    clip.favorite = previous.favorite;
                    clip.category_ids = previous.category_ids.clone();
                    if previous.custom_title { clip.title = previous.title.clone(); clip.custom_title = true; }
                    for category in &mut self.categories {
                        for id in category.clip_order.iter_mut().filter(|id| **id == previous.id) { *id = clip.id.clone(); }
                    }
                }
                self.clips.insert(0, Arc::new(clip));
            }
            Action::Favorite { id, value } => {
                if let Some(clip) = self.clips.iter_mut().find(|c| c.id == id).map(Arc::make_mut) {
                    clip.favorite = value;
                }
            }
            Action::RenameClip { id, title } => {
                let name = valid_name(&title, 120)?;
                if let Some(clip) = self.clips.iter_mut().find(|c| c.id == id).map(Arc::make_mut) {
                    clip.title = name;
                    clip.custom_title = true;
                }
            }
            Action::DeleteClips { ids } => self.remove(&ids),
            Action::RestoreClips { removed } => {
                let exists = |library: &Library, id: &str| library.clips.iter().any(|clip| clip.id == id);
                let mut restored = Vec::new();
                // Newest first, like every other insertion; lists sort by time, so placement is unchanged.
                for mut clip in removed.clips.into_iter().rev() {
                    if exists(self, &clip.id) { continue; }
                    if clip.category_ids.iter().any(|id| !self.categories.iter().any(|category| &category.id == id)) {
                        let categories: Vec<String> = self.categories.iter().map(|category| category.id.clone()).collect();
                        Arc::make_mut(&mut clip).category_ids.retain(|id| categories.contains(id));
                    }
                    restored.push(clip.id.clone());
                    self.clips.insert(0, clip);
                }
                for (category_id, positions) in removed.orders {
                    let Some(category) = self.categories.iter_mut().find(|category| category.id == category_id) else { continue; };
                    for (position, id) in positions {
                        if restored.contains(&id) && !category.clip_order.contains(&id) {
                            let at = position.min(category.clip_order.len()); category.clip_order.insert(at, id);
                        }
                    }
                }
            }
            Action::SetClipCategories {
                id,
                mut category_ids,
            } => {
                if category_ids
                    .iter()
                    .any(|id| !self.categories.iter().any(|c| &c.id == id))
                {
                    return Err("The category no longer exists.".into());
                }
                category_ids.sort();
                category_ids.dedup();
                if let Some(clip) = self.clips.iter_mut().find(|c| c.id == id).map(Arc::make_mut) {
                    clip.category_ids = category_ids;
                }
            }
            Action::AddCategory { mut category } => {
                category.name = valid_name(&category.name, 40)?;
                if self
                    .categories
                    .iter()
                    .any(|c| c.name.to_lowercase() == category.name.to_lowercase())
                {
                    return Err("A category with this name already exists.".into());
                }
                if Uuid::parse_str(&category.id).is_err()
                    || self.categories.iter().any(|c| c.id == category.id)
                    || !(CATEGORY_COLORS.contains(&category.color.as_str()) || category.color == "#b663e0")
                {
                    return Err("Ogiltig kategori.".into());
                }
                category.clip_order.clear();
                self.categories.push(category);
            }
            Action::RenameCategory { id, name } => {
                let name = valid_name(&name, 40)?;
                if self
                    .categories
                    .iter()
                    .any(|c| c.id != id && c.name.to_lowercase() == name.to_lowercase())
                {
                    return Err("A category with this name already exists.".into());
                }
                if let Some(category) = self.categories.iter_mut().find(|c| c.id == id) {
                    category.name = name;
                }
            }
            Action::DeleteCategory { id } => {
                self.categories.retain(|c| c.id != id);
                for clip in self.clips.iter_mut().filter(|clip| clip.category_ids.contains(&id)) {
                    Arc::make_mut(clip).category_ids.retain(|category_id| category_id != &id);
                }
            }
            Action::ReorderCategory { id, clip_order } => {
                let mut expected: Vec<String> = self
                    .clips
                    .iter()
                    .filter(|c| c.category_ids.contains(&id))
                    .map(|c| c.id.clone())
                    .collect();
                let mut actual = clip_order.clone();
                expected.sort();
                actual.sort();
                if expected != actual {
                    return Err("The order must include every clip in the category.".into());
                }
                if let Some(category) = self.categories.iter_mut().find(|c| c.id == id) {
                    category.clip_order = clip_order;
                }
            }
            Action::SetSettings { settings } => {
                validate_settings(&settings)?;
                self.settings = settings;
            }
            Action::SetPaused { value } => self.paused = value,
            Action::MarkUsed { id, at, top } => {
                if let Some(clip) = self.clips.iter_mut().find(|c| c.id == id).map(Arc::make_mut) {
                    clip.last_used_at = Some(at);
                }
                if let Some(index) = self.clips.iter().position(|c| c.id == id).filter(|index| top && *index > 0) { self.bring_to_top(index, at, None); }
            }
            Action::Recopied { id, clip } => {
                match self.clips.iter().position(|c| c.id == id) {
                    Some(0) | None => return Ok(()),
                    Some(index) => self.bring_to_top(index, clip.created_at, clip.source_app),
                }
            }
            Action::EditClip { id, content } => {
                let Some(clip) = self.clips.iter_mut().find(|c| c.id == id).map(Arc::make_mut) else { return Err("The clip no longer exists.".into()); };
                if clip.kind == "image" { return Err("Images are edited in the image editor.".into()); }
                if content.trim().is_empty() || content.len() > MAX_CONTENT_BYTES || content.trim_start().starts_with("data:image/") { return Err("The clip is empty or larger than the size limit.".into()); }
                clip.kind = classify(&content).into();
                clip.html = None;
                if !clip.custom_title { clip.title = Clip::captured(content.clone()).title; }
                clip.content = content;
            }
            Action::Prune { now } => {
                if let Some(days) = self.settings.retention_days {
                    let cutoff = now.saturating_sub(days as u64 * 86_400_000);
                    let ids: Vec<String> = self
                        .clips
                        .iter()
                        .filter(|c| !c.favorite && !(self.settings.keep_categorized && !c.category_ids.is_empty()) && c.created_at <= cutoff)
                        .map(|c| c.id.clone())
                        .collect();
                    self.remove(&ids);
                }
            }
        }
        self.revision += 1;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn category_protection_applies_to_expiry_and_prune_until_last_membership_is_removed() {
        let now = 100 * 86_400_000;
        let mut library = Library::default();
        library.settings.keep_categorized = true;
        let work = Uuid::new_v4().to_string(); let home = Uuid::new_v4().to_string();
        for id in [work.as_str(), home.as_str()] {
            library.apply(Action::AddCategory { category: Category { id: id.into(), name: id.into(), color: "#00a9e6".into(), clip_order: vec![] } }).unwrap();
        }
        let mut clip = Clip::captured("saved".into()); clip.created_at = 1;
        clip.category_ids = vec![work.clone(), home];
        let id = clip.id.clone(); library.apply(Action::AddClip { clip }).unwrap();
        assert!(!library.has_expired(now));
        library.apply(Action::Prune { now }).unwrap(); assert_eq!(library.clips.len(), 1);
        let mut disabled = library.clone(); disabled.settings.keep_categorized = false;
        assert!(disabled.has_expired(now)); disabled.apply(Action::Prune { now }).unwrap(); assert!(disabled.clips.is_empty());
        let mut manual = library.clone(); manual.apply(Action::DeleteClips { ids: vec![id.clone()] }).unwrap(); assert!(manual.clips.is_empty());
        library.apply(Action::DeleteCategory { id: work }).unwrap();
        assert!(!library.has_expired(now));
        library.apply(Action::SetClipCategories { id, category_ids: vec![] }).unwrap();
        assert!(library.has_expired(now)); library.apply(Action::Prune { now }).unwrap(); assert!(library.clips.is_empty());
    }

    #[test]
    fn retention_keeps_favorites_and_removes_old_members() {
        let mut library = Library::default();
        let mut old = Clip::captured("gammal".into());
        old.created_at = 1;
        let mut favorite = Clip::captured("favorit".into());
        favorite.created_at = 1;
        favorite.favorite = true;
        library.apply(Action::AddClip { clip: old }).unwrap();
        library
            .apply(Action::AddClip {
                clip: favorite.clone(),
            })
            .unwrap();
        library
            .apply(Action::Prune {
                now: 31 * 86_400_000,
            })
            .unwrap();
        assert_eq!(library.clips.len(), 1);
        assert_eq!(library.clips[0].id, favorite.id);
    }

    #[test]
    fn expiry_check_matches_prune() {
        let mut library = Library::default();
        let mut old = Clip::captured("old".into());
        old.created_at = 1_000;
        library.clips.push(std::sync::Arc::new(old));
        let day = 86_400_000;
        assert!(!library.has_expired(1_000 + 29 * day));
        assert!(library.has_expired(1_000 + 30 * day));
        std::sync::Arc::make_mut(&mut library.clips[0]).favorite = true;
        assert!(!library.has_expired(1_000 + 365 * day));
        library.settings.retention_days = None;
        assert!(!library.has_expired(u64::MAX));
    }

    #[test]
    fn deleting_category_preserves_clip() {
        let mut library = Library::default();
        let category = Category {
            id: Uuid::new_v4().to_string(),
            name: "Arbete".into(),
            color: CATEGORY_COLORS[0].into(),
            clip_order: vec![],
        };
        library
            .apply(Action::AddCategory {
                category: category.clone(),
            })
            .unwrap();
        let mut clip = Clip::captured("innehåll".into());
        clip.category_ids.push(category.id.clone());
        library.apply(Action::AddClip { clip }).unwrap();
        library
            .apply(Action::DeleteCategory { id: category.id })
            .unwrap();
        assert_eq!(library.clips.len(), 1);
        assert!(library.clips[0].category_ids.is_empty());
    }

    #[test]
    fn powershell_script_and_commands_are_code() {
        let script = "#Requires -Modules VMware.PowerCLI\r\n\r\nparam(\r\n [string]$vCenter = \"10.0.2.15\",\r\n [string[]]$VMNames = @(\"NSVPX-EXT01\")\r\n)";
        assert_eq!(Clip::captured(script.into()).kind, "code");
        for snippet in [
            "Get-VM | Select-Object Name",
            "$vm = Get-VM",
            "[pscustomobject]@{ Name = 'Test' }",
        ] {
            assert_eq!(classify(snippet), "code");
        }
        for note in [
            "Hej, här kommer en anteckning.",
            "Det kostar $100.",
            "Vi har ett e-postkonto.",
            "#FFDC37",
        ] {
            assert_ne!(classify(note), "code");
        }
    }

    #[test]
    fn invalid_settings_leave_previous_settings() {
        let mut library = Library::default();
        let invalid = Settings {
            shortcut: "Shift+V".into(),
            ..Settings::default()
        };
        assert!(library
            .apply(Action::SetSettings { settings: invalid })
            .is_err());
        assert_eq!(library.settings.shortcut, "Ctrl+Shift+V");
    }
}

#[cfg(test)] mod capture_settings_tests {
    use super::*;
    #[test] fn accepts_capture_keys_and_rejects_typing_and_conflicts() {
        for key in ["PrintScreen","F8","F24","Ctrl+Alt+S","Shift+PrintScreen"] { assert!(validate_capture_shortcut(key).is_ok(),"{key}"); }
        for key in ["S","Shift+S","F25","Ctrl+Ctrl+S","Delete",""] { assert!(validate_capture_shortcut(key).is_err(),"{key}"); }
        let mut settings=Settings::default(); settings.capture_shortcut=Some(settings.shortcut.clone()); assert!(validate_settings(&settings).is_err());
        let legacy=r#"{"shortcut":"Ctrl+Shift+V","retentionDays":30,"theme":"system"}"#;
        assert!(serde_json::from_str::<Settings>(legacy).unwrap().capture_shortcut.is_none());
    }
}

#[cfg(test)] mod reserved_hotkey_tests {
    use super::*;
    #[test] fn f12_cannot_replace_working_panel_or_capture_keys() {
        for key in ["F12", "Ctrl+Shift+F12", "Alt+F12"] {
            assert!(validate_capture_shortcut(key).unwrap_err().contains("reserved by Windows"));
        }
        let mut library=Library::default();
        let working=Settings { shortcut:"Ctrl+Shift+F11".into(), capture_shortcut:Some("Ctrl+Alt+F11".into()), ..Settings::default() };
        library.apply(Action::SetSettings { settings:working.clone() }).unwrap();
        for capture in [false,true] {
            let mut invalid=working.clone();
            if capture { invalid.capture_shortcut=Some("Ctrl+Shift+F12".into()); } else { invalid.shortcut="Ctrl+Shift+F12".into(); }
            assert!(library.apply(Action::SetSettings { settings:invalid }).unwrap_err().contains("reserved by Windows"));
            assert_eq!(library.settings.shortcut, working.shortcut);
            assert_eq!(library.settings.capture_shortcut, working.capture_shortcut);
        }
    }
}

#[cfg(test)]
mod rich_text_tests {
    use super::*;
    #[test]
    fn identical_text_with_different_formatting_is_not_discarded() {
        let mut library = Library::default();
        let mut bold = Clip::captured("same text".into()); bold.html = Some("<b>same text</b>".into());
        library.apply(Action::AddClip { clip: bold }).unwrap();
        let mut italic = Clip::captured("same text".into()); italic.html = Some("<i>same text</i>".into());
        library.apply(Action::AddClip { clip: italic.clone() }).unwrap(); assert_eq!(library.clips.len(), 2);
        library.apply(Action::AddClip { clip: italic }).unwrap(); assert_eq!(library.clips.len(), 2);
        library.apply(Action::AddClip { clip: Clip::captured("same text".into()) }).unwrap(); assert_eq!(library.clips.len(), 3);
    }
    #[test]
    fn rejects_oversized_formatting_without_losing_history() {
        let mut library = Library::default(); let mut clip = Clip::captured("text".into());
        clip.html = Some("x".repeat(MAX_CONTENT_BYTES + 1));
        assert!(library.apply(Action::AddClip { clip }).is_err()); assert!(library.clips.is_empty());
    }
}

#[cfg(test)] mod restore_tests {
    use super::*;
    #[test]
    fn restore_skips_existing_clips_and_categories_deleted_meanwhile() {
        let mut library = Library::default();
        let [work, home] = ["Jobb", "Hem"].map(|name| Category { id: Uuid::new_v4().to_string(), name: name.into(), color: "#00a9e6".into(), clip_order: vec![] });
        for category in [&work, &home] { library.apply(Action::AddCategory { category: category.clone() }).unwrap(); }
        let [a, b, c] = ["a", "b", "c"].map(|text| Clip::captured(text.into()));
        for clip in [&a, &b, &c] { library.apply(Action::AddClip { clip: clip.clone() }).unwrap(); library.apply(Action::SetClipCategories { id: clip.id.clone(), category_ids: vec![work.id.clone(), home.id.clone()] }).unwrap(); }
        library.apply(Action::ReorderCategory { id: work.id.clone(), clip_order: vec![a.id.clone(), b.id.clone(), c.id.clone()] }).unwrap();
        let original = library.clone();
        let removed = library.removal(&[a.id.clone(), c.id.clone()]);
        library.apply(Action::DeleteClips { ids: vec![a.id.clone(), c.id.clone()] }).unwrap();
        library.apply(Action::DeleteCategory { id: home.id.clone() }).unwrap();
        library.apply(Action::RestoreClips { removed: removed.clone() }).unwrap();
        // Restored clips go first, as new clips do; lists sort by time, and so does the database after restart.
        assert_eq!(library.clips.iter().map(|clip| clip.id.clone()).collect::<Vec<_>>(), vec![c.id.clone(), a.id.clone(), b.id.clone()]);
        assert_eq!(library.clips.len(), original.clips.len());
        assert!(library.clips.iter().all(|clip| clip.category_ids == vec![work.id.clone()]));
        assert_eq!(library.categories[0].clip_order, vec![a.id.clone(), b.id.clone(), c.id.clone()]);
        // A second restore of the same snapshot changes nothing.
        let once = library.clone(); library.apply(Action::RestoreClips { removed }).unwrap();
        assert_eq!(library.clips, once.clips); assert_eq!(library.categories, once.categories);
    }
}

#[cfg(test)] mod deletion_history_tests {
    use super::*;
    fn removed(text: &str, bytes: usize) -> Removed { Removed { clips: vec![Arc::new(Clip::captured(text.into()))], orders: vec![], bytes } }
    fn first(entry: Option<Option<Removed>>) -> Option<Option<String>> { entry.map(|removed| removed.map(|removed| removed.clips[0].content.clone())) }
    #[test]
    fn deletions_undo_newest_first_and_drop_the_oldest_beyond_the_limits() {
        let mut history = Deletions::default();
        assert!(!history.can_undo()); assert_eq!(first(history.pop()), None);
        for text in ["a", "b", "c"] { history.push(Some(removed(text, 10)), 100); }
        history.push(None, 100); assert!(!history.can_undo());
        assert_eq!(first(history.pop()), Some(None));
        assert!(history.can_undo());
        for text in ["c", "b", "a"] { assert_eq!(first(history.pop()), Some(Some(text.into()))); }
        assert_eq!(first(history.pop()), None);
        // The media budget drops the oldest deletions first.
        for text in ["a", "b", "c"] { history.push(Some(removed(text, 40)), 100); }
        assert_eq!(first(history.pop()), Some(Some("c".into()))); assert_eq!(first(history.pop()), Some(Some("b".into()))); assert_eq!(first(history.pop()), None);
        for index in 0..Deletions::LIMIT + 5 { history.push(Some(removed(&index.to_string(), 0)), 100); }
        let mut count = 0; while let Some(Some(_)) = history.pop() { count += 1; }
        assert_eq!(count, Deletions::LIMIT);
        history.restore_failed(removed("retry", 0)); assert_eq!(first(history.pop()), Some(Some("retry".into())));
    }
}

#[cfg(test)] mod edited_image_tests {
    use super::*;
    const PNG: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    fn edited(marker: &str) -> Clip { let mut clip = Clip::captured(format!("{PNG}{marker}")); clip.title = "Edited image".into(); clip }
    #[test]
    fn a_repeated_copy_replaces_the_earlier_result_and_keeps_its_organisation() {
        let mut library = Library::default();
        let category = Uuid::new_v4().to_string();
        library.apply(Action::AddCategory { category: Category { id: category.clone(), name: "Kvitton".into(), color: "#00a9e6".into(), clip_order: vec![] } }).unwrap();
        let first = edited("");
        let first_id = first.id.clone();
        library.apply(Action::AddEditedImage { clip: first, replaces: None }).unwrap();
        library.apply(Action::Favorite { id: first_id.clone(), value: true }).unwrap();
        library.apply(Action::SetClipCategories { id: first_id.clone(), category_ids: vec![category.clone()] }).unwrap();
        library.apply(Action::ReorderCategory { id: category.clone(), clip_order: vec![first_id.clone()] }).unwrap();
        library.apply(Action::RenameClip { id: first_id.clone(), title: "Kvitto".into() }).unwrap();
        let second = edited("AA");
        let second_id = second.id.clone();
        library.apply(Action::AddEditedImage { clip: second, replaces: Some(first_id.clone()) }).unwrap();
        assert_eq!(library.clips.len(), 1);
        let clip = &library.clips[0];
        assert_eq!(clip.id, second_id);
        assert!(clip.favorite && clip.custom_title && clip.title == "Kvitto");
        assert_eq!(clip.category_ids, vec![category.clone()]);
        assert_eq!(library.categories[0].clip_order, vec![second_id.clone()]);
        // A replaced clip that is gone, or is not an image, leaves the history alone and adds the copy.
        library.apply(Action::AddEditedImage { clip: edited("AAAA"), replaces: Some(first_id) }).unwrap();
        library.apply(Action::AddClip { clip: Clip::captured("text".into()) }).unwrap();
        let text_id = library.clips[0].id.clone();
        library.apply(Action::AddEditedImage { clip: edited("AAAAAA"), replaces: Some(text_id) }).unwrap();
        assert_eq!(library.clips.len(), 4);
    }
}

#[cfg(test)] mod recopy_tests {
    use super::*;
    fn source(name: &str) -> SourceApp { SourceApp { id: name.to_lowercase(), name: name.into(), icon: None } }
    #[test]
    fn copying_existing_text_again_moves_it_up_and_keeps_what_the_user_gave_it() {
        let mut library = Library::default();
        let mut first = Clip::captured("TICKET-1024".into()); first.created_at = 1; first.source_app = Some(source("Edge"));
        let id = first.id.clone();
        library.apply(Action::AddClip { clip: first }).unwrap();
        for text in ["server01", "2.4-17.03"] { let mut clip = Clip::captured(text.into()); clip.created_at = 2; library.apply(Action::AddClip { clip }).unwrap(); }
        library.apply(Action::Favorite { id: id.clone(), value: true }).unwrap();
        library.apply(Action::RenameClip { id: id.clone(), title: "Ärende".into() }).unwrap();
        let revision = library.revision;
        let mut again = Clip::captured("TICKET-1024".into()); again.created_at = 50; again.source_app = Some(source("Teams"));
        library.apply(Action::AddClip { clip: again }).unwrap();
        assert_eq!(library.clips.len(), 3);
        let top = &library.clips[0];
        assert_eq!(top.id, id);
        assert_eq!((top.created_at, top.favorite, top.title.as_str()), (50, true, "Ärende"));
        assert_eq!(top.source_app.as_ref().unwrap().name, "Teams");
        assert_eq!(library.revision, revision + 1);
        // Already on top: nothing changes, not even the revision.
        library.apply(Action::AddClip { clip: Clip::captured("TICKET-1024".into()) }).unwrap();
        assert_eq!((library.clips.len(), library.revision), (3, revision + 1));
    }
    #[test]
    fn panel_use_moves_up_while_library_use_and_unknown_ids_do_not() {
        let mut library = Library::default();
        for text in ["a", "b", "c"] { library.apply(Action::AddClip { clip: Clip::captured(text.into()) }).unwrap(); }
        let oldest = library.clips[2].id.clone();
        library.apply(Action::MarkUsed { id: oldest.clone(), at: 70, top: false }).unwrap();
        assert_eq!(library.clips[2].id, oldest);
        library.apply(Action::MarkUsed { id: oldest.clone(), at: 80, top: true }).unwrap();
        assert_eq!((library.clips[0].id.as_str(), library.clips[0].created_at, library.clips[0].last_used_at), (oldest.as_str(), 80, Some(80)));
        library.apply(Action::Recopied { id: "missing".into(), clip: Clip::captured("x".into()) }).unwrap();
        assert_eq!(library.clips.len(), 3);
    }
    #[test]
    fn editing_text_reclassifies_drops_formatting_and_keeps_a_chosen_name() {
        let mut library = Library::default();
        let mut clip = Clip::captured("plain note".into()); clip.html = Some("<b>plain note</b>".into());
        let id = clip.id.clone();
        library.apply(Action::AddClip { clip }).unwrap();
        library.apply(Action::EditClip { id: id.clone(), content: "https://example.com".into() }).unwrap();
        let edited = &library.clips[0];
        assert_eq!((edited.kind.as_str(), edited.html.as_ref(), edited.title.as_str()), ("link", None, "https://example.com"));
        library.apply(Action::RenameClip { id: id.clone(), title: "Link".into() }).unwrap();
        library.apply(Action::EditClip { id: id.clone(), content: "#00a9e6".into() }).unwrap();
        assert_eq!((library.clips[0].kind.as_str(), library.clips[0].title.as_str()), ("color", "Link"));
        for content in ["", "   ", "data:image/png;base64,AAAA"] { assert!(library.apply(Action::EditClip { id: id.clone(), content: content.into() }).is_err()); }
        assert!(library.apply(Action::EditClip { id: "missing".into(), content: "x".into() }).is_err());
    }
}
