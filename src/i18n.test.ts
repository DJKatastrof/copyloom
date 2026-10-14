import { afterEach, expect, it } from 'vitest';
import { getLanguage, setLanguage, t, message } from './i18n';
import sv from './locales/sv.json';
afterEach(() => setLanguage('en'));
it('defaults to English and supports Swedish without rewriting interpolated user text', () => {
  expect(getLanguage()).toBe('en'); expect(t('Settings')).toBe('Settings');
  expect(t('Show {title}', { title: 'Inställningar' })).toBe('Show Inställningar');
  setLanguage('sv'); expect(t('Settings')).toBe('Inställningar');
  expect(t('Show {title}', { title: 'Settings' })).toBe('Visa Settings');
});
it('preserves all translation placeholders', () => {
  for (const [key, value] of Object.entries(sv as Record<string, string>)) expect(value.match(/\{\w+\}/g)?.sort() ?? [], key).toEqual(key.match(/\{\w+\}/g)?.sort() ?? []);
});
it('translates known native errors in Swedish and preserves diagnostic suffixes', () => {
  expect(message('Error: Windows did not allow the startup setting to change.')).toBe('Error: Windows did not allow the startup setting to change.');
  setLanguage('sv');
  expect(message('Error: Windows did not allow the startup setting to change.')).toBe('Error: Windows tillät inte att autostarten ändrades.');
  expect(message('Unrecognised error 42')).toBe('Unrecognised error 42');
});
