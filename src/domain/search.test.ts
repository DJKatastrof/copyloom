import { describe, expect, it } from 'vitest';
import { emptyLibrary, makeClip, visibleClips } from './library';
import { typoDistance } from './search';

describe('search with typos', () => {
  it('counts edits, swapped letters and word beginnings', () => {
    expect(typoDistance('konfigurtion', 'konfiguration', 2)).toBe(1);
    expect(typoDistance('kopeira', 'kopiera', 1)).toBe(1);
    expect(typoDistance('konfg', 'konfiguration', 1)).toBe(1);
    expect(typoDistance('lösenord', 'lösenord', 1)).toBe(0);
    expect(typoDistance('server', 'printer', 1)).toBe(2);
    expect(typoDistance('abcdefgh', 'abc', 2)).toBe(3);
  });

  it('shows exact matches first and then matches with typos', () => {
    const now = Date.now();
    const typo = makeClip('Ny konfiguration för VPN', now);
    const exact = makeClip('konfigurtion som det stavades i mejlet', now - 1000);
    const other = makeClip('Helt annan text', now + 1000);
    const library = { ...emptyLibrary(), clips: [typo, exact, other] };
    expect(visibleClips(library, 'all', 'konfigurtion', 'newest')).toEqual([exact, typo]);
    expect(visibleClips(library, 'all', 'konfigurtion', 'oldest')).toEqual([exact, typo]);
  });

  it('every word in the search must be present, in any order', () => {
    const clip = makeClip('Lösenord till skrivaren på kontoret');
    const library = { ...emptyLibrary(), clips: [clip, makeClip('Skrivaren är trasig')] };
    expect(visibleClips(library, 'all', 'kontoret skrivaren', 'newest')).toEqual([clip]);
    expect(visibleClips(library, 'all', 'kontoret skirvaren', 'newest')).toEqual([clip]);
    expect(visibleClips(library, 'all', 'kontoret skrivaren hemma', 'newest')).toEqual([]);
  });

  it('short words must be spelt right so the search does not get too broad', () => {
    const library = { ...emptyLibrary(), clips: [makeClip('VPN och mail')] };
    expect(visibleClips(library, 'all', 'vnp', 'newest')).toEqual([]);
    expect(visibleClips(library, 'all', 'mial', 'newest')).toEqual([]);
  });

  it('searches source apps but not image data', () => {
    const teams = { ...makeClip('Mötesanteckning'), sourceApp: { id: 'teams', name: 'Microsoft Teams', icon: null } };
    const image = { ...makeClip('data:image/png;base64,TEAMSSECRETPIXELS'), sourceApp: { id: 'paint', name: 'Paint', icon: null } };
    const library = { ...emptyLibrary(), clips: [teams, image] };
    expect(visibleClips(library, 'all', 'teams', 'newest')).toEqual([teams]);
    expect(visibleClips(library, 'all', 'taems', 'newest')).toEqual([teams]);
    expect(visibleClips(library, 'all', 'paint', 'newest')).toEqual([image]);
    expect(visibleClips(library, 'all', 'secretpixels', 'newest')).toEqual([]);
  });

  it('searches 10,000 clips with typos in reasonable time', () => {
    const words = ['server', 'användare', 'lösenord', 'faktura', 'möte', 'projekt', 'leverans', 'kund', 'rapport', 'skrivare'];
    const clips = Array.from({ length: 10_000 }, (_, index) => makeClip(`${words[index % 10]} ${words[(index * 7) % 10]} nummer ${index} ${'text '.repeat(index % 40)}`, index));
    const library = { ...emptyLibrary(), clips };
    const started = performance.now();
    const found = visibleClips(library, 'all', 'levrans rapprot', 'newest');
    const elapsed = performance.now() - started;
    expect(found.length).toBeGreaterThan(0);
    expect(found.every(clip => clip.content.includes('leverans') && clip.content.includes('rapport'))).toBe(true);
    expect(elapsed).toBeLessThan(1500);
  });
});
