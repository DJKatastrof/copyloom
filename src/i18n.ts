import { useLayoutEffect, useSyncExternalStore } from 'react';
import sv from './locales/sv.json';
export type Language = 'en' | 'sv';
let language: Language = 'en';
const listeners = new Set<() => void>();
export function getLanguage() { return language; }
export function setLanguage(value: Language) {
  if (typeof document !== 'undefined') document.documentElement.lang = value;
  if (value === language) return;
  language = value; listeners.forEach(listener => listener());
}
export function useAppLanguage(value?: Language) {
  const current = useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, getLanguage);
  useLayoutEffect(() => { if (value) setLanguage(value); }, [value]);
  return current;
}
// Texts are written in English in the code; sv.json translates them. Only authored UI strings are passed
// here; clip text, titles and category names are never translated.
export function t(key: string, values?: Record<string, string | number>): string {
  const translated = language === 'sv' ? (sv as Record<string, string>)[key] ?? key : key;
  return values ? translated.replace(/\{(\w+)\}/g, (match, name: string) => String(values[name] ?? match)) : translated;
}
/** Errors from the Windows side and from validation arrive in English; a known one, also followed by a
 * diagnostic suffix, is translated. */
export function message(value: string): string {
  if (language === 'en') return value;
  const prefix = value.startsWith('Error: ') ? 'Error: ' : '';
  const source = value.slice(prefix.length);
  const match = Object.keys(sv).sort((a,b) => b.length - a.length).find(key => source === key || (key.length > 20 && source.startsWith(key)));
  return prefix + (match ? t(match) + source.slice(match.length) : source);
}
