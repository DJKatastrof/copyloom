import { detectCodeLanguage } from './code';
import { createMatcher, wordsOf, type Tier } from './search';
export type ClipKind = 'text' | 'link' | 'code' | 'color' | 'image';
export type Theme = 'system' | 'light' | 'dark';

export interface Clip {
  id: string;
  title: string;
  customTitle?: boolean;
  kind: ClipKind;
  content: string;
  html?: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  favorite: boolean;
  categoryIds: string[];
  sourceApp?: { id: string; name: string; icon: string | null } | null;
}

export interface Category {
  id: string;
  name: string;
  color: string;
  clipOrder: string[];
}

export interface Settings {
  shortcut: string;
  captureShortcut?: string | null;
  retentionDays: number | null;
  keepCategorized?: boolean;
  theme: Theme;
  startMinimized?: boolean;
  pasteDirectly?: boolean;
  editAfterCapture?: boolean;
  captureBehavior?: 'copy' | 'edit' | 'choose';
  language?: 'en' | 'sv';
  winV?: boolean;
  excludedPrograms?: string[];
  /** Where the quick panel opens; the mouse pointer unless chosen otherwise. */
  panelPosition?: 'pointer' | 'caret' | 'center' | 'last';
  /** What uses a clip in the quick panel: one click (default) or a double-click, which leaves a click to select. */
  panelClick?: 'single' | 'double';
  /** The trash button on the quick panel's rows: always shown (default), on hover, or off. */
  panelTrash?: 'always' | 'hover' | 'off';
}

export interface Library {
  revision: number;
  clips: Clip[];
  categories: Category[];
  settings: Settings;
  paused: boolean;
  storage: string;
  storagePath?: string | null;
}

export type Action =
  | { type: 'addClip'; clip: Clip }
  | { type: 'favorite'; id: string; value: boolean }
  | { type: 'renameClip'; id: string; title: string }
  | { type: 'deleteClips'; ids: string[] }
  | { type: 'setClipCategories'; id: string; categoryIds: string[] }
  | { type: 'editClip'; id: string; content: string }
  | { type: 'addCategory'; category: Category }
  | { type: 'renameCategory'; id: string; name: string }
  | { type: 'deleteCategory'; id: string }
  | { type: 'reorderCategory'; id: string; clipOrder: string[] }
  | { type: 'setSettings'; settings: Settings }
  | { type: 'setPaused'; value: boolean }
  | { type: 'markUsed'; id: string; at: number; top?: boolean }
  | { type: 'prune'; now: number };

export const DEFAULT_SETTINGS: Settings = { shortcut: 'Ctrl+Shift+V', captureShortcut: null, retentionDays: 30, keepCategorized: false, theme: 'system', startMinimized: false, pasteDirectly: true, editAfterCapture: false, language: 'en' };
export const CATEGORY_COLORS = ['#00a9e6', '#f0554d', '#52cc64', '#62a8f5', '#fa9214', '#fab700'];
export const MAX_CLIP_BYTES = 16 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 128 * 1024 * 1024;

export function emptyLibrary(): Library {
  return { revision: 0, clips: [], categories: [], settings: { ...DEFAULT_SETTINGS }, paused: false, storage: 'memory' };
}

export function classify(content: string): ClipKind {
  if (/^data:image\/png;base64,/.test(content)) return 'image';
  if (/^#[\da-f]{6}$/i.test(content.trim())) return 'color';
  if (/^https?:\/\/\S+$/i.test(content.trim())) return 'link';
  if (detectCodeLanguage(content)) return 'code';
  if (/(?:\b(?:const|function|import|export|SELECT|async|def)\b|=>|\{\s*\n)/.test(content)) return 'code';
  return 'text';
}

export function makeClip(content: string, now = Date.now()): Clip {
  const kind = classify(content);
  return {
    id: crypto.randomUUID(), kind, content,
    title: kind === 'image' ? 'Copied image' : content.trim().split('\n')[0].slice(0, 80) || 'Text',
    createdAt: now, lastUsedAt: null, favorite: false, categoryIds: [],
  };
}

export function normalizeCaptureShortcut(shortcut: string): string {
  const parts = shortcut.trim().split('+'), key = parts.pop()!;
  if (key === 'F12') throw new Error("F12 is reserved by Windows, even with Ctrl/Shift. Choose another key.");
  const modifiers = new Set(parts);
  const standalone = key === 'PrintScreen' || /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key);
  if (parts.length > 3 || modifiers.size !== parts.length || parts.some(p => !['Ctrl', 'Alt', 'Shift', 'Super'].includes(p)) || (!standalone && (!/^[A-Z0-9]$/.test(key) || !parts.some(p => ['Ctrl','Alt','Super'].includes(p))))) throw new Error('Choose Print Screen, a function key, or Ctrl/Alt/Win with a letter or number.');
  return [...['Ctrl','Alt','Shift','Super'].filter(p => modifiers.has(p)), key].join('+');
}

export function normalizeShortcut(shortcut: string): string {
  const parts = shortcut.trim().split('+');
  if (parts.length < 2 || parts.length > 4) throw new Error('Use Ctrl, Alt or Win with a letter, number or function key.');
  const key = parts.pop()!;
  if (key === 'F12') throw new Error("F12 is reserved by Windows, even with Ctrl/Shift. Choose another key.");
  const modifiers = new Set(parts);
  if (modifiers.size !== parts.length || parts.some(p => !['Ctrl', 'Alt', 'Shift', 'Super'].includes(p))
    || !parts.some(p => ['Ctrl', 'Alt', 'Super'].includes(p)) || !/^(?:[A-Z0-9]|F(?:[1-9]|1[0-2]))$/.test(key)) {
    throw new Error('Invalid shortcut. Try Ctrl+Shift+V.');
  }
  return [...['Ctrl', 'Alt', 'Shift', 'Super'].filter(p => modifiers.has(p)), key].join('+');
}

export function validateSettings(settings: Settings): Settings {
  if (settings.excludedPrograms && (settings.excludedPrograms.length > 100 || settings.excludedPrograms.some(name => name.length <= 4 || name.length > 260 || !/\.exe$/i.test(name) || /[\x00-\x1f<>:"/\\|?*]/.test(name)))) throw new Error('Enter the executable name, such as KeePass.exe (up to 100 programs).');
  if (settings.keepCategorized !== undefined && typeof settings.keepCategorized !== 'boolean') throw new Error('Invalid setting for clips in categories.');
  if (settings.language !== undefined && !['en', 'sv'].includes(settings.language)) throw new Error('Invalid language.');
  if (settings.panelPosition !== undefined && !['pointer', 'caret', 'center', 'last'].includes(settings.panelPosition)) throw new Error('Invalid quick panel position.');
  if (settings.panelClick !== undefined && !['single', 'double'].includes(settings.panelClick)) throw new Error('Invalid quick panel click setting.');
  if (settings.panelTrash !== undefined && !['always', 'hover', 'off'].includes(settings.panelTrash)) throw new Error('Invalid quick panel trash button setting.');
  if (settings.captureBehavior !== undefined && !['copy', 'edit', 'choose'].includes(settings.captureBehavior)) throw new Error('Invalid action after screenshot.');
  if (settings.editAfterCapture !== undefined && typeof settings.editAfterCapture !== 'boolean') throw new Error('Invalid editor setting after screenshot.');
  if (settings.pasteDirectly !== undefined && typeof settings.pasteDirectly !== 'boolean') throw new Error('Invalid paste setting.');
  const shortcut = normalizeShortcut(settings.shortcut);
  const captureShortcut = settings.captureShortcut ? normalizeCaptureShortcut(settings.captureShortcut) : null;
  if (captureShortcut === shortcut || (settings.winV && captureShortcut === 'Super+V')) throw new Error('The panel and screenshot need different shortcuts.');
  if (settings.retentionDays !== null && (!Number.isInteger(settings.retentionDays) || settings.retentionDays < 1 || settings.retentionDays > 36500)) {
    throw new Error('Choose a whole number of days between 1 and 36,500, or keep forever.');
  }
  if (settings.startMinimized !== undefined && typeof settings.startMinimized !== 'boolean') throw new Error('Invalid startup setting.');
  if (!['system', 'light', 'dark'].includes(settings.theme)) throw new Error('Invalid theme.');
  return { ...settings, shortcut, captureShortcut };
}

export function expiredClips(library: Library, now: number, days = library.settings.retentionDays, keepCategorized = library.settings.keepCategorized ?? false): Clip[] {
  if (days === null) return [];
  return library.clips.filter(clip => !keptByCleanup(clip, keepCategorized) && clip.createdAt <= now - days * 86_400_000);
}
/** Favorites, and with the setting on clips in a category, survive both the history limit and a manual cleanup. */
function keptByCleanup(clip: Clip, keepCategorized: boolean) { return clip.favorite || (keepCategorized && clip.categoryIds.length > 0); }
/** The clips a cleanup removes: created before `cutoff`, except those the history limit would keep too. */
export function clipsBefore(library: Library, cutoff: number, keepCategorized = library.settings.keepCategorized ?? false): Clip[] {
  return library.clips.filter(clip => !keptByCleanup(clip, keepCategorized) && clip.createdAt < cutoff);
}

// The same content copied again, or a clip used from the quick panel, becomes the newest clip; nothing else about it changes.
function bringToTop(clips: Clip[], index: number, at: number, sourceApp?: Clip['sourceApp']): Clip[] {
  const clip = { ...clips[index], createdAt: at, ...(sourceApp ? { sourceApp } : {}) };
  return [clip, ...clips.slice(0, index), ...clips.slice(index + 1)];
}

export function reduceLibrary(library: Library, action: Action): Library {
  let next: Library = { ...library, revision: library.revision + 1 };
  switch (action.type) {
    case 'addClip': {
      if (!action.clip.content.trim()) throw new Error('The clip is empty.');
      if (new TextEncoder().encode(action.clip.content).length > (action.clip.content.startsWith('data:image/png;base64,') ? MAX_IMAGE_BYTES : MAX_CLIP_BYTES)) throw new Error('The clip exceeds the size limit.');
      const same = action.clip.kind === 'image' ? -1 : library.clips.findIndex(clip => clip.kind !== 'image' && clip.content === action.clip.content && (clip.html ?? null) === (action.clip.html ?? null));
      if (same === 0) return library;
      next.clips = same > 0 ? bringToTop(library.clips, same, action.clip.createdAt, action.clip.sourceApp) : [action.clip, ...library.clips];
      break;
    }
    case 'favorite': next.clips = library.clips.map(c => c.id === action.id ? { ...c, favorite: action.value } : c); break;
    case 'renameClip': {
      const title = action.title.trim();
      if (!title || title.length > 120) throw new Error('The name must contain 1–120 characters.');
      next.clips = library.clips.map(c => c.id === action.id ? { ...c, title, customTitle: true } : c); break;
    }
    case 'deleteClips': {
      const ids = new Set(action.ids);
      next.clips = library.clips.filter(c => !ids.has(c.id));
      next.categories = library.categories.map(c => ({ ...c, clipOrder: c.clipOrder.filter(id => !ids.has(id)) })); break;
    }
    case 'setClipCategories': {
      if (action.categoryIds.some(id => !library.categories.some(c => c.id === id))) throw new Error('The category no longer exists.');
      next.clips = library.clips.map(c => c.id === action.id ? { ...c, categoryIds: [...new Set(action.categoryIds)] } : c); break;
    }
    case 'addCategory': {
      const name = action.category.name.trim();
      if (!name || name.length > 40) throw new Error('The category name must contain 1–40 characters.');
      if (library.categories.some(c => c.name.toLocaleLowerCase('sv') === name.toLocaleLowerCase('sv'))) throw new Error('A category with this name already exists.');
      if (!CATEGORY_COLORS.includes(action.category.color) && action.category.color !== '#b663e0') throw new Error('Choose one of the category colors.');
      next.categories = [...library.categories, { ...action.category, name }]; break;
    }
    case 'renameCategory': {
      const name = action.name.trim();
      if (!name || name.length > 40) throw new Error('The category name must contain 1–40 characters.');
      if (library.categories.some(c => c.id !== action.id && c.name.toLocaleLowerCase('sv') === name.toLocaleLowerCase('sv'))) throw new Error('A category with this name already exists.');
      next.categories = library.categories.map(c => c.id === action.id ? { ...c, name } : c); break;
    }
    case 'deleteCategory': {
      next.categories = library.categories.filter(c => c.id !== action.id);
      next.clips = library.clips.map(c => ({ ...c, categoryIds: c.categoryIds.filter(id => id !== action.id) })); break;
    }
    case 'reorderCategory': {
      const members = library.clips.filter(c => c.categoryIds.includes(action.id)).map(c => c.id);
      if (new Set(action.clipOrder).size !== action.clipOrder.length || action.clipOrder.length !== members.length || members.some(id => !action.clipOrder.includes(id))) throw new Error('The order must include every clip in the category.');
      next.categories = library.categories.map(c => c.id === action.id ? { ...c, clipOrder: action.clipOrder } : c); break;
    }
    case 'setSettings': next.settings = validateSettings(action.settings); break;
    case 'setPaused': next.paused = action.value; break;
    case 'markUsed': {
      next.clips = library.clips.map(c => c.id === action.id ? { ...c, lastUsedAt: action.at } : c);
      const index = next.clips.findIndex(c => c.id === action.id);
      if (action.top && index > 0) next.clips = bringToTop(next.clips, index, action.at);
      break;
    }
    case 'editClip': {
      const clip = library.clips.find(c => c.id === action.id);
      if (!clip) throw new Error('The clip no longer exists.');
      if (clip.kind === 'image') throw new Error('Images are edited in the image editor.');
      if (!action.content.trim() || new TextEncoder().encode(action.content).length > MAX_CLIP_BYTES || /^\s*data:image\//.test(action.content)) throw new Error('The clip is empty or larger than the size limit.');
      const edited = makeClip(action.content, clip.createdAt);
      next.clips = library.clips.map(c => c.id === action.id ? { ...c, content: action.content, kind: edited.kind, html: null, title: c.customTitle ? c.title : edited.title } : c); break;
    }
    case 'prune': {
      const ids = new Set(expiredClips(library, action.now).map(c => c.id));
      next = reduceLibrary(library, { type: 'deleteClips', ids: [...ids] }); break;
    }
  }
  return next;
}

const searchText = new WeakMap<Clip, string>();
const searchWords = new WeakMap<Clip, string[]>();
export function visibleClips(library: Library, filter: string, query: string, sort: 'newest' | 'oldest' | 'manual'): Clip[] {
  const searching = query.trim() !== '';
  const match = createMatcher(query);
  const names = new Map(library.categories.map(category => [category.id, category.name.toLocaleLowerCase('sv')]));
  const tiers = new Map<Clip, Tier>();
  const clips = library.clips.filter(clip => {
    if (filter !== 'all' && !(filter === 'favorites' ? clip.favorite : clip.categoryIds.includes(filter))) return false;
    if (!searching) return true;
    let text = searchText.get(clip);
    if (text === undefined) {
      // The source program is searchable too: "teams" finds what was copied in Teams.
      text = (clip.title + '\n' + (clip.kind === 'image' ? '' : clip.content) + '\n' + (clip.sourceApp?.name ?? '')).toLocaleLowerCase('sv');
      searchText.set(clip, text);
    }
    const haystack = text;
    const words = () => { let list = searchWords.get(clip); if (!list) { list = wordsOf(haystack); searchWords.set(clip, list); } return list; };
    const tier = match(text, words, clip.categoryIds.map(id => names.get(id) ?? ''));
    if (tier === null) return false;
    tiers.set(clip, tier);
    return true;
  });
  const order = library.categories.find(category => category.id === filter)?.clipOrder ?? [];
  const positions = new Map(order.map((id, index) => [id, index]));
  return clips.sort((a, b) => {
    const tier = (tiers.get(a) ?? 0) - (tiers.get(b) ?? 0);
    if (tier) return tier;
    if (sort === 'manual' && order.length) {
      const ai = positions.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const bi = positions.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
    }
    return sort === 'oldest' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt;
  });
}

/** A user deletion that can be undone in the browser preview; the Windows app keeps its own copy natively. */
export type Removal = { clips: Clip[]; orders: [string, [number, string][]][] };
export function removal(library: Library, ids: string[]): Removal {
  const removed = new Set(ids);
  return {
    clips: library.clips.filter(clip => removed.has(clip.id)),
    orders: library.categories.map(category => [category.id, category.clipOrder.flatMap((id, index) => removed.has(id) ? [[index, id] as [number, string]] : [])] as [string, [number, string][]]).filter(([, positions]) => positions.length),
  };
}
// Mirrors the native restore: clips come back first, without categories deleted meanwhile, in their manual places.
export function restoreRemoval(library: Library, removed: Removal): Library {
  const existing = new Set(library.clips.map(clip => clip.id)), categories = new Set(library.categories.map(category => category.id));
  const clips = removed.clips.filter(clip => !existing.has(clip.id)).map(clip => ({ ...clip, categoryIds: clip.categoryIds.filter(id => categories.has(id)) }));
  const restored = new Set(clips.map(clip => clip.id));
  return { ...library, revision: library.revision + 1, clips: [...clips, ...library.clips], categories: library.categories.map(category => {
    const order = [...category.clipOrder];
    for (const [position, id] of removed.orders.find(([categoryId]) => categoryId === category.id)?.[1] ?? []) if (restored.has(id) && !order.includes(id)) order.splice(Math.min(position, order.length), 0, id);
    return { ...category, clipOrder: order };
  }) };
}
