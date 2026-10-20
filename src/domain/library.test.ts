import { describe, expect, it } from 'vitest';
import { classify, clipsBefore, emptyLibrary, expiredClips, makeClip, normalizeShortcut, reduceLibrary, visibleClips } from './library';
import type { Category } from './library';

describe('history and categories', () => {
  it('renames only the display name and finds the clip by the new name', () => {
    const clip = { ...makeClip('Get-VM | Select-Object Name'), html: '<pre>original</pre>', favorite: true, categoryIds: ['work'] };
    const library = { ...emptyLibrary(), clips: [clip] };
    // Populate the search cache before the rename.
    expect(visibleClips(library, 'all', 'mina servrar', 'newest')).toEqual([]);
    const renamed = reduceLibrary(library, { type: 'renameClip', id: clip.id, title: '  Mina servrar  ' });
    expect(renamed.clips[0]).toEqual({ ...clip, title: 'Mina servrar', customTitle: true });
    expect(visibleClips(renamed, 'all', 'mina servrar', 'newest')).toEqual(renamed.clips);
    for (const title of ['', '   ', 'a'.repeat(121)]) expect(() => reduceLibrary(renamed, { type: 'renameClip', id: clip.id, title })).toThrow();
  });
  it('protects categorised clips when the option is on, but allows deleting them by hand', () => {
    const now = 100 * 86_400_000;
    const saved = { ...makeClip('sparad', 1), categoryIds: ['work'] };
    const library = { ...emptyLibrary(), clips: [saved, makeClip('gammal', 1), { ...makeClip('favorit', 1), favorite: true }, makeClip('ny', now)] };
    expect(expiredClips(library, now).map(c => c.content)).toEqual(['sparad', 'gammal']);
    library.settings.keepCategorized = true;
    const pruned = reduceLibrary(library, { type: 'prune', now });
    expect(pruned.clips.map(c => c.content)).toEqual(['sparad', 'favorit', 'ny']);
    expect(reduceLibrary(pruned, { type: 'deleteClips', ids: [saved.id] }).clips.map(c => c.content)).toEqual(['favorit', 'ny']);
    expect(expiredClips(library, now, null)).toEqual([]);
  });

  it('returns to the original retention after the last category or when protection is off', () => {
    const now = 100 * 86_400_000;
    let library = emptyLibrary(); library.settings.keepCategorized = true;
    library.categories = ['work', 'home'].map(id => ({ id, name: id, color: '#00a9e6', clipOrder: [] }));
    library.clips = [{ ...makeClip('sparad', 1), categoryIds: ['work', 'home'] }];
    expect(expiredClips(library, now, 30, false)).toHaveLength(1); // Preview proposed setting, before saving it.
    expect(expiredClips(library, now)).toHaveLength(0);
    library = reduceLibrary(library, { type: 'deleteCategory', id: 'work' });
    expect(expiredClips(library, now)).toHaveLength(0);
    library = reduceLibrary(library, { type: 'setClipCategories', id: library.clips[0].id, categoryIds: [] });
    expect(reduceLibrary(library, { type: 'prune', now }).clips).toHaveLength(0);
  });

  it('deletes at the retention limit but keeps favorites and newer clips', () => {
    const now = 100 * 86_400_000;
    const library = { ...emptyLibrary(), clips: [makeClip('gräns', now - 30 * 86_400_000), { ...makeClip('favorit', 1), favorite: true }, makeClip('ny', now)] };
    expect(expiredClips(library, now).map(c => c.content)).toEqual(['gräns']);
    expect(reduceLibrary(library, { type: 'prune', now }).clips.map(c => c.content)).toEqual(['favorit', 'ny']);
    expect(expiredClips({ ...library, settings: { ...library.settings, retentionDays: null } }, now)).toEqual([]);
  });

  it('cleans up clips created before a date but keeps what the history limit keeps', () => {
    const cutoff = 50 * 86_400_000;
    const saved = { ...makeClip('sparad', 1), categoryIds: ['work'] };
    const library = { ...emptyLibrary(), clips: [makeClip('gammal', 1), saved, { ...makeClip('favorit', 1), favorite: true }, makeClip('gräns', cutoff), makeClip('ny', cutoff + 1)] };
    expect(clipsBefore(library, cutoff).map(c => c.content)).toEqual(['gammal', 'sparad']);
    library.settings.keepCategorized = true;
    expect(clipsBefore(library, cutoff).map(c => c.content)).toEqual(['gammal']);
  });

  it('keeps the content when a category is deleted and only clears the membership', () => {
    const category: Category = { id: 'work', name: 'Arbete', color: '#7357cf', clipOrder: [] };
    const clip = { ...makeClip('text'), categoryIds: ['work', 'other'] };
    const next = reduceLibrary({ ...emptyLibrary(), clips: [clip], categories: [category] }, { type: 'deleteCategory', id: 'work' });
    expect(next.clips[0].content).toBe('text');
    expect(next.clips[0].categoryIds).toEqual(['other']);
    expect(next.categories).toEqual([]);
  });

  it('saves a manual order and rejects missing or duplicate clips', () => {
    const first = { ...makeClip('ett', 1), categoryIds: ['work'] };
    const second = { ...makeClip('två', 2), categoryIds: ['work'] };
    const library = { ...emptyLibrary(), clips: [second, first], categories: [{ id: 'work', name: 'Arbete', color: '#7357cf', clipOrder: [] }] };
    const next = reduceLibrary(library, { type: 'reorderCategory', id: 'work', clipOrder: [first.id, second.id] });
    expect(visibleClips(next, 'work', '', 'manual').map(c => c.content)).toEqual(['ett', 'två']);
    expect(() => reduceLibrary(library, { type: 'reorderCategory', id: 'work', clipOrder: [first.id, first.id] })).toThrow();
    expect(() => reduceLibrary(library, { type: 'reorderCategory', id: 'work', clipOrder: [first.id] })).toThrow();
  });

  it('searches categories and text but not encoded image data', () => {
    const clip = { ...makeClip('en anteckning'), categoryIds: ['work'] };
    const library = { ...emptyLibrary(), clips: [clip, makeClip('data:image/png;base64,SECRET')], categories: [{ id: 'work', name: 'Arbete', color: '#7357cf', clipOrder: [] }] };
    expect(visibleClips(library, 'all', 'ARBETE', 'newest')).toEqual([clip]);
    expect(visibleClips(library, 'all', 'SECRET', 'newest')).toEqual([]);
  });

  it('merges identical copies and moves earlier text to the top', () => {
    let library = reduceLibrary(emptyLibrary(), { type: 'addClip', clip: makeClip('ett') });
    library = reduceLibrary(library, { type: 'addClip', clip: makeClip('ett') });
    expect(library.clips).toHaveLength(1);
    library = reduceLibrary(library, { type: 'addClip', clip: makeClip('två') });
    library = reduceLibrary(library, { type: 'addClip', clip: makeClip('ett') });
    expect(library.clips).toHaveLength(2);
    expect(library.clips.map(clip => clip.content)).toEqual(['ett', 'två']);
  });
});

describe('shortcut and settings', () => {
  it('normalises modifier order and rejects lone or duplicate keys', () => {
    expect(normalizeShortcut('Shift+Ctrl+K')).toBe('Ctrl+Shift+K');
    for (const value of ['V', 'Shift+V', 'Ctrl+Ctrl+V', 'Ctrl+Alt+Delete', 'Ctrl+F13']) expect(() => normalizeShortcut(value)).toThrow();
  });

  it('an invalid retention does not change the previous settings', () => {
    const library = emptyLibrary();
    expect(() => reduceLibrary(library, { type: 'setSettings', settings: { ...library.settings, retentionDays: 0 } })).toThrow();
    expect(library.settings.retentionDays).toBe(30);
  });
});

describe('PowerShell-klipp', () => {
  it('recognises PowerCLI scripts with CRLF, param and types', () => {
    const script = '#Requires -Modules VMware.PowerCLI\r\n\r\nparam(\r\n [string]$vCenter = "10.0.2.15",\r\n [string[]]$VMNames = @("NSVPX-EXT01")\r\n)';
    expect(makeClip(script).kind).toBe('code');
    expect(makeClip(script).content).toBe(script);
    for (const snippet of ['Get-VM | Select-Object Name', '$vm = Get-VM', '[pscustomobject]@{ Name = "Test" }']) expect(classify(snippet)).toBe('code');
    for (const note of ['Hej, här kommer en anteckning.', 'Det kostar $100.', 'Vi har ett e-postkonto.', '#FFDC37']) expect(classify(note)).not.toBe('code');
  });
});
