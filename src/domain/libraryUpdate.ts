import type { Clip, Library } from './library';
export type LibraryUpdate = Omit<Library, 'clips' | 'categories'> & {
  baseRevision: number; upserted: Clip[]; removed: string[]; categories?: Library['categories'];
};
export function mergeLibraryUpdate(current: Library, update: LibraryUpdate): Library {
  if (update.revision <= current.revision) return current;
  if (update.baseRevision !== current.revision) throw new Error('The history needs to be read again.');
  const removed = new Set(update.removed), changed = new Map(update.upserted.map(clip => [clip.id, clip]));
  const ids = new Set(current.clips.map(clip => clip.id));
  return { revision: update.revision, clips: [...update.upserted.filter(clip => !ids.has(clip.id) && !removed.has(clip.id)), ...current.clips.filter(clip => !removed.has(clip.id)).map(clip => changed.get(clip.id) ?? clip)], categories: update.categories ?? current.categories, settings: update.settings, paused: update.paused, storage: update.storage, storagePath: update.storagePath };
}
