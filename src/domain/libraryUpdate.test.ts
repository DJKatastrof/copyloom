import { expect, it } from 'vitest';
import { emptyLibrary, makeClip } from './library';
import { mergeLibraryUpdate } from './libraryUpdate';
it('merges changes, deletions and new clips without reordering untouched clips', () => {
  const first = makeClip('ett'), second = makeClip('två'), added = makeClip('tre');
  const before = { ...emptyLibrary(), revision: 7, clips: [first, second] };
  const update = { ...before, baseRevision: 7, revision: 8, upserted: [added, { ...first, favorite: true }], removed: [second.id], categories: undefined };
  const next = mergeLibraryUpdate(before, update);
  expect(next.clips.map(clip => clip.id)).toEqual([added.id, first.id]);
  expect(next.clips[1].favorite).toBe(true);
  expect(before.clips).toHaveLength(2);
  expect(mergeLibraryUpdate(next, update)).toBe(next);
  expect(() => mergeLibraryUpdate(before, { ...update, baseRevision: 6 })).toThrow();
});
it('keeps unchanged objects so search and image caches remain reusable', () => {
  const clip = makeClip('oförändrad');
  const before = { ...emptyLibrary(), clips: [clip] };
  const next = mergeLibraryUpdate(before, { ...before, categories: undefined, baseRevision: 0, revision: 1, upserted: [], removed: [] });
  expect(next.clips[0]).toBe(clip);
  expect(next.categories).toBe(before.categories);
});
