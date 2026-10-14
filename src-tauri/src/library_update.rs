use crate::library::{Category, Clip, Library, Settings};
use serde::Serialize;
use std::{collections::{HashMap, HashSet}, sync::Arc};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryUpdate {
    pub base_revision: u64,
    pub revision: u64,
    pub upserted: Vec<Arc<Clip>>,
    pub removed: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub categories: Option<Vec<Category>>,
    pub settings: Settings,
    pub paused: bool,
    pub storage: String,
    pub storage_path: Option<String>,
}
impl LibraryUpdate {
    pub fn between(before: &Library, after: &Library) -> Self {
        // Unchanged clips share their Arc, so equality is a pointer check.
        let old: HashMap<&str, &Arc<Clip>> = before.clips.iter().map(|clip| (clip.id.as_str(), clip)).collect();
        let ids: HashSet<&str> = after.clips.iter().map(|clip| clip.id.as_str()).collect();
        Self {
            base_revision: before.revision, revision: after.revision,
            upserted: after.clips.iter().filter(|clip| old.get(clip.id.as_str()).copied() != Some(*clip)).cloned().collect(),
            removed: before.clips.iter().filter(|clip| !ids.contains(clip.id.as_str())).map(|clip| clip.id.clone()).collect(),
            categories: (before.categories != after.categories).then(|| after.categories.clone()),
            settings: after.settings.clone(), paused: after.paused,
            storage: after.storage.clone(), storage_path: after.storage_path.clone(),
        }
    }
}

pub fn defer_media(library: &mut Library) {
    // Only new clips still carry media; already deferred clips keep their shared Arc untouched.
    let pending = |clip: &Clip| clip.html.as_ref().is_some_and(|html| !html.starts_with("copyloom-html:"))
        || (clip.kind == "image" && !clip.content.starts_with("copyloom-image:"))
        || clip.source_app.as_ref().and_then(|source| source.icon.as_ref()).is_some_and(|icon| !icon.starts_with("copyloom-icon:"));
    for clip in library.clips.iter_mut().filter(|clip| pending(clip)) {
        let clip = Arc::make_mut(clip);
        if clip.html.is_some() { clip.html = Some(format!("copyloom-html:{}", clip.id)); }
        if clip.kind == "image" { clip.content = format!("copyloom-image:{}", clip.id); }
        if let Some(source) = &mut clip.source_app {
            if source.icon.is_some() { source.icon = Some(format!("copyloom-icon:{}", source.id)); }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::Action;
    #[test]
    fn single_change_does_not_resend_the_history() {
        let mut before = Library::default();
        before.clips = (0..10000).map(|index| Arc::new(Clip::captured(format!("note {index}")))).collect();
        let mut after = before.clone();
        after.apply(Action::Favorite { id: before.clips[500].id.clone(), value: true }).unwrap();
        // Only the edited clip is copied; every other clip is still shared with the snapshot.
        assert!(!Arc::ptr_eq(&before.clips[500], &after.clips[500]));
        assert!(before.clips.iter().zip(&after.clips).enumerate().all(|(index, (a, b))| index == 500 || Arc::ptr_eq(a, b)));
        let update = LibraryUpdate::between(&before, &after);
        assert_eq!(update.upserted.len(), 1);
        assert_eq!(update.upserted[0].id, before.clips[500].id);
        assert!(update.categories.is_none());
        assert!(serde_json::to_vec(&update).unwrap().len() < 1500);
        assert!(serde_json::to_vec(&before).unwrap().len() > 1_000_000);
        let id = after.clips[500].id.clone();
        let previous = after.clone();
        after.apply(Action::DeleteClips { ids: vec![id.clone()] }).unwrap();
        assert_eq!(LibraryUpdate::between(&previous, &after).removed, vec![id]);
    }
    #[test]
    fn deferring_media_only_rewrites_new_clips() {
        let mut library = Library::default();
        let mut image = Clip::captured("data:image/png;base64,AAAA".into());
        image.html = Some("<b>x</b>".into());
        library.clips.push(Arc::new(image));
        defer_media(&mut library);
        let id = library.clips[0].id.clone();
        assert_eq!(library.clips[0].content, format!("copyloom-image:{id}"));
        let deferred = library.clips[0].clone();
        library.apply(Action::AddClip { clip: Clip::captured("new text".into()) }).unwrap();
        defer_media(&mut library);
        assert!(Arc::ptr_eq(&library.clips[1], &deferred));
    }
}
