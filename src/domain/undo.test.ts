import { expect, it } from 'vitest';
import { emptyLibrary, reduceLibrary, removal, restoreRemoval } from './library';

it('undoing a deletion restores clips, categories and manual places, but not deleted categories', () => {
  let library = emptyLibrary();
  for (const [id, name] of [['c1', 'Jobb'], ['c2', 'Hem']]) library = reduceLibrary(library, { type: 'addCategory', category: { id, name, color: '#00a9e6', clipOrder: [] } });
  for (const text of ['a', 'b', 'c']) library = reduceLibrary(library, { type: 'addClip', clip: { id: text, title: text, kind: 'text', content: text, createdAt: text.charCodeAt(0), lastUsedAt: null, favorite: text === 'a', categoryIds: [] } });
  for (const id of ['a', 'b', 'c']) library = reduceLibrary(library, { type: 'setClipCategories', id, categoryIds: ['c1', 'c2'] });
  library = reduceLibrary(library, { type: 'reorderCategory', id: 'c1', clipOrder: ['a', 'b', 'c'] });
  const original = library, removed = removal(library, ['a', 'c']);
  library = reduceLibrary(library, { type: 'deleteClips', ids: ['a', 'c'] });
  library = reduceLibrary(library, { type: 'deleteCategory', id: 'c2' });
  const restored = restoreRemoval(library, removed);
  expect(restored.revision).toBe(library.revision + 1);
  expect(restored.clips.map(clip => clip.id).sort()).toEqual(original.clips.map(clip => clip.id).sort());
  expect(restored.clips.find(clip => clip.id === 'a')).toMatchObject({ favorite: true, categoryIds: ['c1'] });
  expect(restored.categories.find(category => category.id === 'c1')?.clipOrder).toEqual(['a', 'b', 'c']);
  expect(restoreRemoval(restored, removed).clips).toHaveLength(3);
});
