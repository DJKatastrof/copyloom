import { t, message, useAppLanguage } from './i18n';
import ConfirmDialog from './components/ConfirmDialog';
import CategoryMenu from './components/CategoryMenu';
import { reportFrontendReady } from './services/runtime';
import { flushSync } from 'react-dom';
import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowDownUp, ArrowUp, Check, ChevronsDownUp, ChevronsUpDown, Clipboard, Copy, Folder, LayoutGrid, MoreHorizontal, PanelBottom, Pause, Play, Plus, Search, Settings2, Star, Trash2, X } from 'lucide-react';
import type { Action, Category, Clip, Library } from './domain/library';
import { CATEGORY_COLORS, emptyLibrary, makeClip, normalizeShortcut, visibleClips } from './domain/library';
import { changeView, copyClip, copyImageText, openEditor, saveClipImage, undoDelete, canUndoDelete, desktop, panelWindow, dispatch, hidePanel, dragPanel, resizePanel, loadLibrary, subscribeErrors, subscribeLibrary, subscribeView, subscribePanelMotion, finishHidePanel, showPanel } from './services/runtime';
import { ClipContent, type ClipHandlers } from './components/ClipCard';
const Settings = lazy(() => import('./components/Settings'));
import Select from './components/Select';
import ClipMenu from './components/ClipMenu';
import RenameClipDialog, { NameDialog } from './components/RenameClipDialog';
import EditTextDialog from './components/EditTextDialog';
import ClipList, { ClipRow, listEntries, type ListHandle } from './components/ClipList';
import ClipPreview, { PreviewDialog } from './components/ClipPreview';
import PanelPreview from './components/PanelPreview';

type View = 'library' | 'panel';
type Page = 'clips' | 'settings';
// Physical keys, so AZERTY's Shift-free digits and the number pad work too.
const QUICK_KEY = /^(?:Digit|Numpad)([1-9])$/;
// Below this width the library has no preview pane; Space opens the preview instead.
const PANE_QUERY = '(min-width: 900px)';
// The list width is a per-window convenience; without it the layout falls back to its default split.
const LIST_WIDTH = 'copyloom.listWidth', MIN_LIST = 260, MIN_PREVIEW = 320, FOLD_DAYS = 'copyloom.foldDays';
function storedListWidth(): number | null { try { const value = Number(localStorage.getItem(LIST_WIDTH)); return value >= MIN_LIST ? value : null; } catch { return null; } }

function NewCategory({ onAdd, onCancel }: { onAdd: (category: Category) => Promise<boolean>; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(CATEGORY_COLORS[0]);
  const [saving, setSaving] = useState(false);
  return <form autoComplete="off" className="new-category" onSubmit={async event => { event.preventDefault(); if (saving) return; setSaving(true); if (await onAdd({ id: crypto.randomUUID(), name, color, clipOrder: [] })) onCancel(); setSaving(false); }}>
    <label htmlFor="category-name">{t("New category")}</label><input autoComplete="off" id="category-name" autoFocus value={name} maxLength={40} placeholder={t("For example, Work")} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onCancel(); } }} />
    <div className="category-colors" aria-label={t("Category color")}>{CATEGORY_COLORS.map(candidate => <button type="button" key={candidate} aria-label={t('Color {color}', { color: candidate })} aria-pressed={candidate === color} style={{ backgroundColor: candidate }} onClick={() => setColor(candidate)}>{candidate === color && <Check size={13} />}</button>)}</div>
    <div className="form-actions"><button className="subtle-button" type="button" onClick={onCancel}>{t("Cancel")}</button><button className="primary-button" disabled={!name.trim() || saving} type="submit">{t("Create")}</button></div>
  </form>;
}

function focusClip(id: string | null): boolean {
  if (!id) return false;
  const selector = '[data-clip-id="' + CSS.escape(id) + '"]';
  const target = document.querySelector<HTMLElement>('.clip-row' + selector);
  target?.focus({ preventScroll: true });
  return !!target;
}

export default function App() {
  const [, refreshTime] = useState(0);
  useEffect(() => { const timer = window.setInterval(() => refreshTime(value => value + 1), 60000); return () => clearInterval(timer); }, []);
  const [categoryMenu, setCategoryMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [pendingCategory, setPendingCategory] = useState<Category | null>(null);
  const [renamingCategory, setRenamingCategory] = useState<Category | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<string[] | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [listWidth, setListWidth] = useState<number | null>(storedListWidth);
  // Folded days: "fold all" is remembered; single days opened or closed against it are not.
  const [foldAll, setFoldAll] = useState(() => { try { return localStorage.getItem(FOLD_DAYS) === '1'; } catch { return false; } });
  const [foldExceptions, setFoldExceptions] = useState<Set<string>>(new Set());
  const [resizing, setResizing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null), dragOrigin = useRef(0);
  // The panel's corner grip: where the drag started and the window size then, in CSS pixels.
  const gripOrigin = useRef<{ x: number; y: number; width: number; height: number } | null>(null), gripFrame = useRef(0);
  const selectionAnchor = useRef<string | null>(null);
  const [panelSession, setPanelSession] = useState(0);
  const [dropCategory, setDropCategory] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [library, setLibrary] = useState<Library>(emptyLibrary);
  useAppLanguage(library.settings.language ?? 'en');
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<View>(panelWindow || new URLSearchParams(location.search).get('view') === 'panel' ? 'panel' : 'library');
  const [page, setPage] = useState<Page>('clips');
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'newest' | 'oldest' | 'manual'>('newest');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [addingCategory, setAddingCategory] = useState(false);
  const [composer, setComposer] = useState(false);
  const [newText, setNewText] = useState('');
  const [notice, setNotice] = useState<{ text: string; error: boolean; undo?: boolean } | null>(null);
  // An undo offer stays long enough to read and reach; other confirmations are brief.
  useEffect(() => { if (!notice || notice.error) return; const timer = window.setTimeout(() => setNotice(null), notice.undo ? 8000 : 3500); return () => clearTimeout(timer); }, [notice]);
  // Ctrl held on its own for a moment shows 1–9 on the first clips; a quick Ctrl+click or Ctrl+1 shows nothing.
  const [quickKeys, setQuickKeys] = useState(false);
  useEffect(() => {
    let timer = 0;
    const hide = () => { clearTimeout(timer); timer = 0; setQuickKeys(false); };
    const down = (event: KeyboardEvent) => {
      if (event.key === 'Control') { if (!event.repeat && !event.shiftKey && !event.altKey && !event.metaKey) { clearTimeout(timer); timer = window.setTimeout(() => setQuickKeys(true), 400); } }
      else if (!QUICK_KEY.test(event.code)) hide();
    };
    const up = (event: KeyboardEvent) => { if (event.key === 'Control') hide(); };
    document.addEventListener('keydown', down); document.addEventListener('keyup', up); document.addEventListener('pointerdown', hide, true); window.addEventListener('blur', hide);
    return () => { hide(); document.removeEventListener('keydown', down); document.removeEventListener('keyup', up); document.removeEventListener('pointerdown', hide, true); window.removeEventListener('blur', hide); };
  }, []);
  const searchRef = useRef<HTMLInputElement>(null);
  const listHandle = useRef<ListHandle>(null);
  const quickPanelRef = useRef<HTMLElement>(null);
  const categoryPopoverRef = useRef<HTMLDivElement>(null);
  const categoryTriggerRef = useRef<HTMLButtonElement>(null);
  const moreMenuRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (ready) void reportFrontendReady().catch(() => {});
  }, [ready]);
  const latestLibrary = useRef(library);
  const mounted = useRef(true);
  const deletePending = useRef(false);
  latestLibrary.current = library;
  const update = useCallback((next: Library) => { if (mounted.current) setLibrary(current => next.revision >= current.revision ? next : current); }, []);

  const act = useCallback(async (action: Action): Promise<boolean> => {
    try { update(await dispatch(action)); return true; }
    catch (cause) { setNotice({ text: typeof cause === 'string' ? cause : (cause as Error).message, error: true }); return false; }
  }, [update]);

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    void (async () => {
      try {
        for (const subscribe of [subscribeLibrary(next => update(next)), subscribeView(next => { if (desktop && ((panelWindow && next !== 'panel') || (!panelWindow && next === 'panel'))) return; flushSync(() => { setView(next === 'settings' ? 'library' : next); setPage(next === 'settings' ? 'settings' : 'clips'); setComposer(false); setAddingCategory(false); }); }), subscribePanelMotion((phase, epoch) => {
          if (phase === 'opening') {
            // Native hide/show keeps React mounted. Reset the strip before showing it.
            flushSync(() => { setPanelSession(value => value + 1); setRenamingId(null); setPreviewId(null); setActiveId(null); setChecked(new Set()); setContextMenu(null); setQuery(''); });
            selectionAnchor.current = null;
          }
          if (epoch !== undefined) void (phase === 'closing' ? finishHidePanel(epoch) : showPanel(epoch));
        }), subscribeErrors(text => setNotice({ text, error: true }))]) {
          const unsubscribe = await subscribe;
          if (disposed) unsubscribe(); else unlisteners.push(unsubscribe);
        }
        const next = await loadLibrary();
        if (!disposed) { update(next); setReady(true); }
      } catch (cause) { if (!disposed) { setNotice({ text: t('Could not start the app: {error}', { error: message(String(cause)) }), error: true }); setReady(true); } }
    })();
    return () => { disposed = true; mounted.current = false; unlisteners.forEach(unsubscribe => unsubscribe()); };
  }, [update]);

  useEffect(() => {
    if (view !== 'panel') return;
    const closeMore = () => { if (moreMenuRef.current) moreMenuRef.current.open = false; };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (addingCategory && !categoryPopoverRef.current?.contains(target) && !categoryTriggerRef.current?.contains(target)) setAddingCategory(false);
      if (!moreMenuRef.current?.contains(target)) closeMore();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || (!addingCategory && !moreMenuRef.current?.open)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (addingCategory) { setAddingCategory(false); categoryTriggerRef.current?.focus(); }
      else { closeMore(); moreMenuRef.current?.querySelector('summary')?.focus(); }
    };
    const blur = () => { setAddingCategory(false); closeMore(); };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('blur', blur);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', blur);
    };
  }, [view, addingCategory]);

  useEffect(() => { document.documentElement.dataset.theme = library.settings.theme; }, [library.settings.theme]);
  useEffect(() => { document.documentElement.dataset.view = view; }, [view]);
  useEffect(() => { if (view === 'panel') quickPanelRef.current?.focus(); else if (page === 'clips') searchRef.current?.focus(); }, [view, page]);
  useEffect(() => { if (desktop && library.storage !== 'encrypted') return; const interval = setInterval(() => { void act({ type: 'prune', now: Date.now() }); }, 60_000); return () => clearInterval(interval); }, [act, library.storage]);
  useEffect(() => { setChecked(current => { if (!current.size) return current; const ids = new Set(library.clips.map(clip => clip.id)); const next = new Set([...current].filter(id => ids.has(id))); return next.size === current.size ? current : next; }); }, [library.clips]);

  const searchQuery = useDeferredValue(query);
  const clips = useMemo(() => visibleClips(library, filter, searchQuery, sort), [library, filter, searchQuery, sort]);
  const grouped = sort !== 'manual' && !searchQuery.trim();
  // The panel is one run of rows; the library groups them by day.
  const { entries, shown } = useMemo(() => view === 'library' ? listEntries(clips, grouped, key => foldAll !== foldExceptions.has(key)) : listEntries(clips, false), [view, clips, grouped, foldAll, foldExceptions]);
  // What the keyboard walks through: the unfolded rows.
  const listed = shown;
  const quickNumbers = useMemo(() => quickKeys && page === 'clips' ? new Map(listed.slice(0, 9).map((clip, index) => [clip.id, index + 1])) : null, [quickKeys, page, listed]);
  function toggleDay(key: string) { setFoldExceptions(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; }); }
  function foldEveryDay(value: boolean) { setFoldAll(value); setFoldExceptions(new Set()); try { localStorage.setItem(FOLD_DAYS, value ? '1' : '0'); } catch { /* Only a convenience. */ } }
  // Sidebar counts: one pass per history change instead of one per category on every render.
  const counts = useMemo(() => { const categories = new Map<string, number>(); let favorites = 0; for (const clip of library.clips) { if (clip.favorite) favorites++; for (const id of clip.categoryIds) categories.set(id, (categories.get(id) ?? 0) + 1); } return { favorites, categories }; }, [library.clips]);
  useLayoutEffect(() => {
    if (view !== 'panel' || !ready) return;
    // Each opening starts with the first visible clip, before native show_panel.
    // Library updates within an open session must preserve keyboard navigation.
    const first = visibleClips(latestLibrary.current, filter, '', sort)[0];
    setQuery(''); setActiveId(first?.id ?? null); setChecked(new Set());
    selectionAnchor.current = first?.id ?? null;
    quickPanelRef.current?.focus();
  }, [view, panelSession, ready]);
  // The panel and the library preview always show a clip once there is one.
  useEffect(() => {
    if (ready && page === 'clips' && !activeId && listed.length) {
      setActiveId(listed[0].id); selectionAnchor.current = listed[0].id;
    }
  }, [ready, page, activeId, listed]);
  const activeClip = library.clips.find(clip => clip.id === activeId);
  const category = library.categories.find(candidate => candidate.id === filter);
  const title = filter === 'favorites' ? t("Favorites") : category?.name ?? t("All clips");
  useEffect(() => { if (activeId && !clips.some(clip => clip.id === activeId)) setActiveId(null); }, [clips, activeId]);

  useEffect(() => {
    if (filter !== 'all' && filter !== 'favorites' && !library.categories.some(category => category.id === filter)) { setFilter('all'); setActiveId(null); setChecked(new Set()); }
  }, [library.categories, filter]);
  const switchView = useCallback(async (next: View) => {
    try { await changeView(next); if (!desktop) setView(next); setPage('clips'); setComposer(false); setAddingCategory(false); }
    catch (cause) { setNotice({ text: t('Could not open the view: {error}', { error: message(String(cause)) }), error: true }); }
  }, []);

  const dismissPanel = useCallback(async () => {
    if (desktop) { await hidePanel(); return; }
    await switchView('library');
  }, [switchView]);

  // Keyboard focus follows the active clip when it moves by arrow key or after a deletion.
  const pendingFocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (pendingFocus.current && pendingFocus.current === activeId && focusClip(activeId)) pendingFocus.current = null;
  }, [clips, activeId]);
  const deleteSelected = useCallback(async (ids: string[]) => {
    if (!ids.length || deletePending.current) return false;
    deletePending.current = true;
    const removed = new Set(ids);
    const activeWasRemoved = activeId !== null && removed.has(activeId);
    const index = listed.findIndex(clip => removed.has(clip.id));
    const next = listed.slice(index + 1).find(clip => !removed.has(clip.id)) ?? listed.slice(0, Math.max(0, index)).reverse().find(clip => !removed.has(clip.id));
    const focusedCard = document.activeElement?.closest('.clip-row')?.getAttribute('data-clip-id');
    try {
      if (focusedCard && removed.has(focusedCard)) pendingFocus.current = next?.id ?? null;
      if (!await act({ type: 'deleteClips', ids })) { pendingFocus.current = null; return false; }
      const undo = await canUndoDelete().catch(() => false);
      setNotice({ text: ids.length === 1 ? t("Clip deleted.") : t("{count} clips deleted.", { count: ids.length }), error: false, undo });
      setActiveId(current => activeWasRemoved || (current && removed.has(current)) ? next?.id ?? null : current);
      setChecked(current => new Set([...current].filter(id => !removed.has(id))));
      if (focusedCard && removed.has(focusedCard) && !next) quickPanelRef.current?.focus();
      return true;
    } finally { deletePending.current = false; }
  }, [act, listed, activeId]);

  const undo = useCallback(async () => {
    try {
      const count = await undoDelete();
      // Undo steps back one deletion at a time; the button stays while older deletions remain.
      if (count) setNotice({ text: count === 1 ? t("Clip restored.") : t("{count} clips restored.", { count }), error: false, undo: await canUndoDelete().catch(() => false) });
    } catch (cause) { setNotice({ text: typeof cause === 'string' ? cause : (cause as Error).message, error: true }); }
  }, []);

  // A clip used from the quick panel becomes the newest; in the library it stays where it is while you work.
  // A click in the panel uses the clip; the second click of a double-click must not paste it again.
  const clickUsed = useRef(-Infinity);
  const reuse = useCallback(async (clip: Clip, plain = false) => {
    try { const result = await copyClip(clip, plain); await act({ type: 'markUsed', id: clip.id, at: Date.now(), top: view === 'panel' }); setNotice({ text: result.pasted ? t("Pasted") : t("Copied"), error: false }); }
    catch (cause) { setNotice({ text: t('Could not copy. Try again. {error}', { error: message(typeof cause === 'string' ? cause : (cause as Error).message) }), error: true }); }
  }, [act, view]);

  function moveActive(step: number) {
    if (!listed.length) return;
    const current = listed.findIndex(clip => clip.id === activeId);
    const index = Math.max(0, Math.min(listed.length - 1, current < 0 ? 0 : current + step));
    const clip = listed[index];
    setActiveId(clip.id); setChecked(new Set()); selectionAnchor.current = clip.id;
    listHandle.current?.scrollToIndex(index);
    if (document.activeElement?.closest('.clip-row')) pendingFocus.current = clip.id;
  }
  function closePanelPreview() { const id = previewId; setPreviewId(null); requestAnimationFrame(() => { if (!focusClip(id)) quickPanelRef.current?.focus(); }); }
  function movePreview(step: 1 | -1) {
    const index = Math.max(0, Math.min(listed.length - 1, listed.findIndex(clip => clip.id === previewId) + step));
    const clip = listed[index]; if (!clip) return;
    setPreviewId(clip.id); setActiveId(clip.id); selectionAnchor.current = clip.id; listHandle.current?.scrollToIndex(index);
  }
  function resizeList(width: number | null, save = true) {
    const room = (bodyRef.current?.clientWidth ?? 1200) - MIN_PREVIEW;
    const next = width === null ? null : Math.round(Math.max(MIN_LIST, Math.min(width, room)));
    setListWidth(next);
    if (save) try { if (next === null) localStorage.removeItem(LIST_WIDTH); else localStorage.setItem(LIST_WIDTH, String(next)); } catch { /* Width is only a convenience. */ }
  }
  function openPreview(id: string | null) {
    if (!id) return false;
    // The panel shows the whole clip over its list; the library only when it has no preview pane.
    if (view === 'library' && window.matchMedia(PANE_QUERY).matches) return false;
    setPreviewId(id); return true;
  }

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || renamingId || editingTextId || renamingCategory || pendingRemoval || pendingCategory || categoryMenu || previewId) return;
      const target = event.target as HTMLElement;
      const editing = target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target.isContentEditable;
      const onClip = target.classList.contains('clip-row');
      if (!desktop) {
        const combo = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Super', event.key.toUpperCase()].filter(Boolean).join('+');
        try { if (normalizeShortcut(combo) === library.settings.shortcut) { event.preventDefault(); if (!event.repeat) void (view === 'panel' ? dismissPanel() : switchView('panel')); return; } } catch { /* A regular key is not a shortcut. */ }
      }
      if (view === 'panel' && event.key === 'Escape' && query) { event.preventDefault(); setQuery(''); quickPanelRef.current?.focus(); return; }
      if (view === 'panel' && event.key === 'Escape') { event.preventDefault(); void dismissPanel().catch(cause => setNotice({ text: String(cause), error: true })); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); searchRef.current?.focus(); return; }
      // Text fields keep their own undo; elsewhere Ctrl+Z brings back the last deleted clips.
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'z' && !editing && !composer) { event.preventDefault(); if (!event.repeat) void undo(); return; }
      if ((event.key === 'Delete' || event.key === 'Backspace') && !event.ctrlKey && !event.altKey && !event.metaKey && page === 'clips' && !editing && !composer && !addingCategory) {
        const ids = checked.size ? [...checked] : activeId ? [activeId] : [];
        if (ids.length) {
          event.preventDefault();
          if (!event.repeat) void remove(ids);
        }
        return;
      }
      // Ctrl+1–9 uses the nth visible clip like Enter; with Shift as plain text.
      const quick = QUICK_KEY.exec(event.code);
      if (quick && (event.ctrlKey || event.metaKey) && !event.altKey && page === 'clips' && !composer && !addingCategory && (!editing || target === searchRef.current)) {
        event.preventDefault();
        const clip = listed[Number(quick[1]) - 1];
        if (clip && !event.repeat) { setActiveId(clip.id); void reuse(clip, event.shiftKey); }
        return;
      }
      if (page !== 'clips' || composer || (editing && target !== searchRef.current)) return;
      const panel = view === 'panel';
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !event.altKey) {
        event.preventDefault(); moveActive(event.key === 'ArrowDown' ? 1 : -1); return;
      }
      if (event.key === 'Enter' && (target === searchRef.current || target === quickPanelRef.current || onClip) && listed.length) { event.preventDefault(); void reuse(clips.find(clip => clip.id === activeId) ?? listed[0], event.shiftKey); return; }
      if (event.key === ' ' && !event.ctrlKey && !event.altKey && (onClip || target === quickPanelRef.current)) { if (openPreview(activeId)) event.preventDefault(); return; }
      if (panel && (target === quickPanelRef.current || onClip) && event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.altKey && !event.metaKey) { event.preventDefault(); searchRef.current?.focus(); setQuery(current => current + event.key); }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [activeId, clips, listed, composer, library.settings.shortcut, reuse, undo, switchView, dismissPanel, view, page, checked, addingCategory, deleteSelected, renamingId, editingTextId, renamingCategory, pendingRemoval, pendingCategory, categoryMenu, previewId, query]);

  function chooseFilter(next: string) { selectionAnchor.current = null; setFilter(next); setPage('clips'); setChecked(new Set()); setActiveId(null); setSort('newest'); }
  // The copied text lands in the history as its own clip through the clipboard monitor.
  async function copyText(clip: Clip) {
    try { await copyImageText(clip.id); setNotice({ text: t("Text from the image copied."), error: false }); }
    catch (cause) { setNotice({ text: typeof cause === 'string' ? cause : (cause as Error).message, error: true }); }
  }
  // Selected texts become one new clip, oldest first as they were copied, or in the category's own order.
  function joinable(ids: string[]) {
    const chosen = new Set(ids), texts = clips.filter(clip => chosen.has(clip.id) && clip.kind !== 'image');
    return sort === 'manual' ? texts : [...texts].sort((a, b) => a.createdAt - b.createdAt);
  }
  async function copyJoined(ids: string[]) {
    const texts = joinable(ids);
    if (!texts.length) return;
    const clip = makeClip(texts.map(text => text.content).join('\n'));
    try {
      const next = await dispatch({ type: 'addClip', clip }); update(next);
      const added = next.clips.find(candidate => candidate.id === clip.id) ?? next.clips.find(candidate => candidate.content === clip.content);
      if (added) { setChecked(new Set()); setActiveId(added.id); await reuse(added); }
    } catch (cause) { setNotice({ text: typeof cause === 'string' ? cause : (cause as Error).message, error: true }); }
  }
  async function remove(ids: string[]) { if (ids.length === 1) await deleteSelected(ids); else if (ids.length) setPendingRemoval(ids); }
  async function reorder(source: string, target: string) {
    if (!category || query || source === target) return;
    const order = visibleClips(library, filter, '', 'manual').map(clip => clip.id);
    if (!order.includes(source) || !order.includes(target)) return;
    const targetIndex = order.indexOf(target);
    order.splice(order.indexOf(source), 1); order.splice(targetIndex, 0, source);
    await act({ type: 'reorderCategory', id: category.id, clipOrder: order }); setSort('manual');
  }

  async function moveSelected(direction: -1 | 1) {
    if (!category || !activeId || query) return;
    const order = visibleClips(library, filter, '', 'manual').map(clip => clip.id);
    const index = order.indexOf(activeId), nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= order.length) return;
    [order[index], order[nextIndex]] = [order[nextIndex], order[index]];
    if (await act({ type: 'reorderCategory', id: category.id, clipOrder: order })) setNotice({ text: t('“{title}” moved to position {position}.', { title: activeClip?.title ?? '', position: nextIndex + 1 }), error: false });
  }

  function selectClip(id: string, event: React.MouseEvent) {
    const multiple = event.ctrlKey || event.metaKey;
    if (event.shiftKey) {
      const anchor = selectionAnchor.current ?? activeId ?? id;
      const start = listed.findIndex(clip => clip.id === anchor), end = listed.findIndex(clip => clip.id === id);
      const range = start < 0 ? [id] : listed.slice(Math.min(start, end), Math.max(start, end) + 1).map(clip => clip.id);
      setChecked(new Set([...(multiple ? checked : []), ...range]));
      selectionAnchor.current = anchor;
    } else if (multiple) {
      const next = new Set(checked.size ? checked : activeId ? [activeId] : []);
      if (next.has(id)) next.delete(id); else next.add(id);
      setChecked(next); selectionAnchor.current = id;
      setActiveId(next.has(id) ? id : [...next].at(-1) ?? null); return;
    } else { setChecked(new Set()); selectionAnchor.current = id; }
    setActiveId(id);
  }
  function selectedIdsFor(id: string): string[] { return checked.has(id) ? [...checked] : [id]; }
  async function assignCategory(ids: string[], categoryId: string, assigned = true) {
    const target = latestLibrary.current.categories.find(item => item.id === categoryId);
    if (!target) return;
    let changed = 0;
    for (const id of new Set(ids)) {
      const clip = latestLibrary.current.clips.find(item => item.id === id);
      if (!clip || clip.categoryIds.includes(categoryId) === assigned) continue;
      const categoryIds = assigned ? [...clip.categoryIds, categoryId] : clip.categoryIds.filter(value => value !== categoryId);
      if (!await act({ type: 'setClipCategories', id, categoryIds })) return;
      changed++;
    }
    if (changed) setNotice({ text: assigned ? t("Added to ") + target.name : t("Removed from ") + target.name, error: false });
  }
  async function clearCategories(ids: string[]) {
    for (const id of new Set(ids)) {
      const clip = latestLibrary.current.clips.find(item => item.id === id);
      if (clip?.categoryIds.length && !await act({ type: 'setClipCategories', id, categoryIds: [] })) return;
    }
    setNotice({ text: t("Removed from categories"), error: false });
  }
  function categoryDropTarget(categoryId: string) {
    return {
      onDragOver(event: React.DragEvent<HTMLButtonElement>) {
        if (!event.dataTransfer.types.includes('text/clip-id')) return;
        event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDropCategory(categoryId);
      },
      onDragLeave(event: React.DragEvent<HTMLButtonElement>) {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropCategory(null);
      },
      onDrop(event: React.DragEvent<HTMLButtonElement>) {
        event.preventDefault(); event.stopPropagation(); setDropCategory(null);
        let ids: string[] = [];
        try { const value: unknown = JSON.parse(event.dataTransfer.getData('application/x-copyloom-clips')); if (Array.isArray(value)) ids = value.filter((id): id is string => typeof id === 'string'); } catch { /* Accept a single clip from the same app. */ }
        if (!ids.length) ids = [event.dataTransfer.getData('text/clip-id')];
        void assignCategory(ids, categoryId);
      },
      'data-drop-target': dropCategory === categoryId ? 'true' : undefined,
    };
  }
  // Rows and cards receive one stable handler object, so a scroll or a notice does not re-render every clip.
  const current = useRef<ClipHandlers>(null!);
  current.current = {
    select: (id, event) => {
      // In the panel a click uses the clip, as in Windows' own clipboard history; Shift for plain text, Ctrl to
      // select. With double-click chosen in Settings, a click selects like in the library.
      if (view === 'panel' && latestLibrary.current.settings.panelClick !== 'double' && !event.ctrlKey && !event.metaKey) {
        const clip = latestLibrary.current.clips.find(item => item.id === id);
        if (clip && performance.now() - clickUsed.current > 600) { clickUsed.current = performance.now(); setActiveId(id); void reuse(clip, event.shiftKey); }
        return;
      }
      selectClip(id, event);
    },
    menu: (id, x, y) => setContextMenu({ id, x, y }),
    copy: (id, plain) => { if (view === 'panel' && performance.now() - clickUsed.current < 600) return; const clip = latestLibrary.current.clips.find(item => item.id === id); if (clip) { setPreviewId(null); void reuse(clip, plain); } },
    favorite: id => { const clip = latestLibrary.current.clips.find(item => item.id === id); if (clip) void act({ type: 'favorite', id, value: !clip.favorite }); },
    dragIds: id => selectedIdsFor(id),
    dragEnd: () => setDropCategory(null),
    canReorder: () => !!category && sort === 'manual' && !query,
    reorder: (source, target) => void reorder(source, target),
  };
  const handlers = useMemo<ClipHandlers>(() => ({
    select: (id, event) => current.current.select(id, event), menu: (id, x, y) => current.current.menu(id, x, y),
    copy: (id, plain) => current.current.copy(id, plain), favorite: id => current.current.favorite(id),
    dragIds: id => current.current.dragIds(id), dragEnd: () => current.current.dragEnd(),
    canReorder: () => current.current.canReorder(), reorder: (source, target) => current.current.reorder(source, target),
  }), []);
  // Images open the image editor; text is edited in place.
  const edit = useCallback((id: string) => {
    setPreviewId(null);
    if (latestLibrary.current.clips.find(clip => clip.id === id)?.kind !== 'image') { setEditingTextId(id); return; }
    void openEditor(id).catch(cause => setNotice({ text: String(cause), error: true }));
  }, []);
  const renderRow = (clip: Clip) => <ClipRow clip={clip} active={clip.id === activeId} checked={checked.has(clip.id)} quickKey={quickNumbers?.get(clip.id)} grouped={view === 'library' && grouped} categories={library.categories} handlers={handlers} pictures={view === 'panel'} />;
  // The panel's trash button sits beside the row, which is itself a button; it deletes without pasting.
  const renderPanelRow = (clip: Clip) => <>{renderRow(clip)}{library.settings.panelTrash !== 'off' && <button className={'row-delete' + (library.settings.panelTrash === 'hover' ? ' on-hover' : '')} aria-label={t('Delete {title}', { title: clip.title })} title={t("Delete (Del)")} onClick={() => void deleteSelected([clip.id])}><Trash2 size={15} /></button>}</>;

  const search = <div className="search-box"><Search size={18} /><input autoComplete="off" ref={searchRef} aria-label={t("Search your clips")} placeholder={t("Search text, links and categories…")} value={query} onChange={event => setQuery(event.target.value)} />{query ? <button className="icon-button" aria-label={t("Clear search")} onClick={() => { setQuery(''); searchRef.current?.focus(); }}><X size={15} /></button> : <kbd>Ctrl F</kbd>}</div>;
  const empty = <div className="empty-state"><div className="empty-icon"><Clipboard size={32} /></div><h2>{query ? t("No matching clips") : filter === 'favorites' ? t("Keep your favorites close") : category ? t("A place for your clips") : t("Your next copy starts here")}</h2><p>{query ? t("Try another search or clear the search field.") : filter === 'favorites' ? t("Select a clip’s star to keep it as a favorite.") : category ? t("Choose a clip in the library and add it to this category.") : desktop ? t("Copy text or an image in another app. It will appear here.") : t("Add text to start using the library.")}</p><div className="empty-actions">{query ? <button className="subtle-button" onClick={() => setQuery('')}>{t("Clear search")}</button> : !category && filter === 'all' && <><button className="primary-button" onClick={() => setComposer(true)}><Plus size={16} />{t("Add text")}</button></>}</div></div>;

  const renamingClip = renamingId ? library.clips.find(clip => clip.id === renamingId) : undefined;
  useEffect(() => { if (renamingId && !renamingClip) setRenamingId(null); }, [renamingId, renamingClip]);
  function closeRename() {
    const id = renamingId; setRenamingId(null);
    requestAnimationFrame(() => { if (!focusClip(id)) (searchRef.current ?? quickPanelRef.current)?.focus({ preventScroll: true }); });
  }
  const editingText = editingTextId ? library.clips.find(clip => clip.id === editingTextId) : undefined;
  function closeTextEdit() {
    const id = editingTextId; setEditingTextId(null);
    requestAnimationFrame(() => { if (!focusClip(id)) (searchRef.current ?? quickPanelRef.current)?.focus({ preventScroll: true }); });
  }
  const menuClip = contextMenu ? library.clips.find(clip => clip.id === contextMenu.id) : undefined;
  const menuIds = menuClip ? selectedIdsFor(menuClip.id) : [];
  const previewClip = previewId ? library.clips.find(clip => clip.id === previewId) : undefined;
  useEffect(() => { if (previewId && !previewClip) setPreviewId(null); }, [previewId, previewClip]);
  const manualMove = view === 'library' && activeClip && category && sort === 'manual' && !query ? <>
    <button className="icon-button" aria-label={t("Move earlier")} title={t("Move earlier")} disabled={clips[0]?.id === activeId} onClick={() => void moveSelected(-1)}><ArrowUp size={16} /></button>
    <button className="icon-button" aria-label={t("Move later")} title={t("Move later")} disabled={clips.at(-1)?.id === activeId} onClick={() => void moveSelected(1)}><ArrowDown size={16} /></button>
  </> : undefined;
  const selection = checked.size > 1 ? [...checked] : null;
  return <div className={`app-shell ${view === 'panel' ? 'panel-mode' : 'library-mode'}${!desktop ? ' browser-preview' : ''}`} onPointerDown={event => { if (view === 'panel' && !desktop && !quickPanelRef.current?.contains(event.target as Node)) void dismissPanel(); }}>
    {categoryMenu && library.categories.some(category => category.id === categoryMenu.id) && <CategoryMenu x={categoryMenu.x} y={categoryMenu.y} name={library.categories.find(category => category.id === categoryMenu.id)!.name} onClose={() => setCategoryMenu(null)} onRename={() => setRenamingCategory(library.categories.find(category => category.id === categoryMenu.id)!)} onDelete={() => setPendingCategory(library.categories.find(category => category.id === categoryMenu.id)!)} />}
    {renamingClip && <RenameClipDialog key={renamingClip.id} clip={renamingClip} onClose={closeRename} onSave={async title => { update(await dispatch({ type: 'renameClip', id: renamingClip.id, title })); }} />}
    {editingText && <EditTextDialog key={editingText.id} clip={editingText} onClose={closeTextEdit} onSave={async content => { update(await dispatch({ type: 'editClip', id: editingText.id, content })); }} />}
    {renamingCategory && <NameDialog heading={t("Rename category")} initial={renamingCategory.name} maxLength={40} onClose={() => setRenamingCategory(null)} onSave={async name => { update(await dispatch({ type: 'renameCategory', id: renamingCategory.id, name })); }} />}
    {pendingCategory && <ConfirmDialog title={t("Delete “") + pendingCategory.name + '”?'} description={library.settings.keepCategorized && library.settings.retentionDays !== null ? t("Clips without other categories will follow the history limit again and may be deleted at the next cleanup. Favorites are kept.") : t("Your clips will be kept.")} onClose={() => setPendingCategory(null)} onConfirm={() => act({ type: 'deleteCategory', id: pendingCategory.id })} />}
    {contextMenu && menuClip && <ClipMenu key={menuClip.id} clip={menuClip} categories={library.categories} hasPins={menuIds.some(id => library.clips.find(clip => clip.id === id)?.categoryIds.length)} onUnpin={() => void clearCategories(menuIds)} categoryIds={library.categories.filter(category => menuIds.every(id => library.clips.find(clip => clip.id === id)?.categoryIds.includes(category.id))).map(category => category.id)} onCategory={(id, assigned) => void assignCategory(menuIds, id, assigned)} x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)} onCopy={() => void reuse(menuClip)} onCopyJoined={menuIds.length > 1 && joinable(menuIds).length ? () => void copyJoined(menuIds) : undefined} onRename={() => { setActiveId(menuClip.id); setRenamingId(menuClip.id); }} onEdit={() => { setActiveId(menuClip.id); edit(menuClip.id); }} onCopyText={desktop ? () => void copyText(menuClip) : undefined} onPreview={view === 'panel' ? () => { setActiveId(menuClip.id); setPreviewId(menuClip.id); } : undefined} onSaveAs={() => { void saveClipImage(menuClip).then(path => { if (path && !panelWindow) setNotice({ text: t("Saved as {name}", { name: path.split(/[\\/]/).pop() ?? path }), error: false }); }, cause => setNotice({ text: String(cause), error: true })); }} favoriteLabel={menuIds.length > 1 ? t("Favorite selected clips") : undefined} deleteLabel={menuIds.length > 1 ? t("Delete selected clips") : undefined} onFavorite={() => { if (menuIds.length > 1) { for (const id of menuIds) void act({ type: 'favorite', id, value: true }); } else void act({ type: 'favorite', id: menuClip.id, value: !menuClip.favorite }); }} onDelete={() => { if (menuIds.length > 1) void remove(menuIds); else void deleteSelected([menuClip.id]); }} />}
    {view === 'library' && previewClip && <PreviewDialog onClose={() => { const id = previewId; setPreviewId(null); requestAnimationFrame(() => { if (!focusClip(id)) quickPanelRef.current?.focus(); }); }}><ClipPreview clip={previewClip} categories={library.categories} handlers={handlers} onEdit={edit} actions={manualMove} /></PreviewDialog>}
    <div className="sr-only" role="status" aria-live="polite">{view === 'panel' && activeClip ? t('Selected clip: {title}. Press Enter to use it or Delete/Backspace to delete it.', { title: activeClip.title }) : ''}</div>
    {view === 'library' && <aside className="sidebar"><div className="brand"><img src="/clip.svg" width={30} height={30} alt="" /><span>Copyloom</span></div>
      <nav aria-label={t("Library")}><button className={`nav-item${filter === 'all' && page === 'clips' ? ' selected' : ''}`} aria-current={filter === 'all' && page === 'clips' ? 'page' : undefined} onClick={() => chooseFilter('all')}><LayoutGrid size={18} />{t("All clips")}<span>{library.clips.length}</span></button><button className={`nav-item${filter === 'favorites' && page === 'clips' ? ' selected' : ''}`} aria-current={filter === 'favorites' && page === 'clips' ? 'page' : undefined} onClick={() => chooseFilter('favorites')}><Star size={18} />{t("Favorites")}<span>{counts.favorites}</span></button></nav>
      <div className="category-heading"><h2>{t("Categories")}</h2><button className="icon-button" aria-label={t("Create category")} onClick={() => setAddingCategory(!addingCategory)}><Plus size={17} /></button></div>
      {addingCategory && <NewCategory onAdd={category => act({ type: 'addCategory', category })} onCancel={() => setAddingCategory(false)} />}
      <nav className="category-nav" aria-label={t("Categories")}>{library.categories.map(category => <button key={category.id} className={`nav-item${filter === category.id && page === 'clips' ? ' selected' : ''}`} aria-current={filter === category.id && page === 'clips' ? 'page' : undefined} {...categoryDropTarget(category.id)} onContextMenu={event => { event.preventDefault(); setContextMenu(null); setCategoryMenu({ id: category.id, x: event.clientX, y: event.clientY }); }} onClick={() => chooseFilter(category.id)}><span className="category-dot" style={{ backgroundColor: category.color }} /><span className="category-name">{category.name}</span><span>{counts.categories.get(category.id) ?? 0}</span></button>)}</nav>
      {!library.categories.length && !addingCategory && <p className="sidebar-hint"><button className="text-button" onClick={() => setAddingCategory(true)}>{t("Create your first category")}</button></p>}
      <div className="sidebar-bottom"><button className={`nav-item${page === 'settings' ? ' selected' : ''}`} aria-current={page === 'settings' ? 'page' : undefined} onClick={() => setPage('settings')}><Settings2 size={18} />{t("Settings")}</button></div>
    </aside>}
    {view === 'panel' && !desktop && <div className="preview-workspace" aria-hidden="true"><header><span>demo.ts — Copyloom</span> <span>{t("Interface preview")}</span></header><div className="preview-editor"><ClipContent clip={makeClip("function welcome(name: string) {\n  const message = `Hej ${name}`;\n  return message;\n}\n\nwelcome(\"Copyloom\");")} /></div></div>}
    <main ref={quickPanelRef} tabIndex={view === 'panel' ? -1 : undefined} aria-label={view === 'panel' ? t("Quick panel") : undefined} className={view === 'panel' ? 'quick-panel' : 'main-pane'}>
      {view === 'library' ? page === 'settings' ? <header className="main-header"><h1>{t("Settings")}</h1></header>
        : <header className="library-header"><h1 className="sr-only">{title}</h1>{search}<div className="toolbar-right">
          {library.paused && <button className="paused-chip" title={t("Resume collection")} onClick={() => void act({ type: 'setPaused', value: false })}><Pause size={13} />{t("Collection paused")}<span>{t("Resume")}</span></button>}
          {grouped && clips.length > 0 && <button className="icon-button" aria-label={foldAll ? t("Expand all days") : t("Collapse all days")} title={foldAll ? t("Expand all days") : t("Collapse all days")} onClick={() => foldEveryDay(!foldAll)}>{foldAll ? <ChevronsUpDown size={17} /> : <ChevronsDownUp size={17} />}</button>}
          <div className="sort-control"><ArrowDownUp size={16} /><Select label={t("Sort clips")} value={sort} onChange={value => setSort(value as typeof sort)} options={[{ value: "newest", label: t("Newest first") }, { value: "oldest", label: t("Oldest first") }, ...(category ? [{ value: "manual", label: t("Custom order") }] : [])]} /></div>
          <button className="icon-button" aria-label={t("Add")} title={t("Add text")} aria-expanded={composer} onClick={() => setComposer(!composer)}><Plus size={18} /></button>
          <button className="subtle-button" onClick={() => void switchView('panel')}><PanelBottom size={16} />{t("Quick panel")}</button>
        </div></header>
        : <header className="panel-head" title={desktop ? t("Drag to move the panel") : undefined} onPointerDown={event => { if (event.target === event.currentTarget && event.button === 0) void dragPanel(); }}>{search}
          <Select label={t("Filter quick panel")} value={filter} onChange={chooseFilter} options={[{ value: 'all', label: t("All clips") }, { value: 'favorites', label: t("Favorites") }, ...library.categories.map(category => ({ value: category.id, label: category.name }))]} />
          <details ref={moreMenuRef} className="panel-more"><summary aria-label={t("More options")} title={t("More options")}><MoreHorizontal size={18} /></summary><div className="panel-menu" onClick={event => { if ((event.target as HTMLElement).closest("button") && moreMenuRef.current) moreMenuRef.current.open = false; }}><button onClick={() => void switchView('library')}><LayoutGrid size={16} />{t("Open library")}</button><button onClick={() => { if (desktop) void changeView('settings'); else void switchView('library').then(() => setPage('settings')); }}><Settings2 size={16} />{t("Settings")}</button><button onClick={() => void act({ type: 'setPaused', value: !library.paused })}>{library.paused ? <Play size={16} /> : <Pause size={16} />}{library.paused ? t("Resume collection") : t("Pause collection")}</button><button onClick={() => { void dismissPanel(); }}><X size={16} />{t("Close panel")}</button></div></details>
        </header>}

      {!ready ? <div className="loading-state" role="status">{t("Opening library…")}</div> : page === 'settings' ? <Suspense fallback={<p className="settings-loading" role="status">{t("Opening settings…")}</p>}><Settings library={library} act={act} /></Suspense> : <>
        {composer && <form autoComplete="off" className="composer" onSubmit={async event => { event.preventDefault(); if (await act({ type: 'addClip', clip: makeClip(newText) })) { setComposer(false); setNewText(''); chooseFilter('all'); } }}><label htmlFor="new-text">{t("Add a clip")}</label><textarea autoComplete="off" id="new-text" autoFocus placeholder={t("Type or paste text, code, a link or a color…")} value={newText} onChange={event => setNewText(event.target.value)} /><div className="form-actions"><button className="subtle-button" type="button" onClick={() => setComposer(false)}>{t("Cancel")}</button><button className="primary-button" type="submit" disabled={!newText.trim()}>{t("Add clip")}</button></div></form>}
        {view === 'library' ? <div ref={bodyRef} className="library-body">
          <div className="list-column" style={listWidth && clips.length ? { flex: `0 0 ${listWidth}px`, maxWidth: `calc(100% - ${MIN_PREVIEW}px)` } : undefined}>
            {(query || (sort === 'manual' && category)) && <div className="results-label">{query ? t('{count} search results', { count: clips.length }) : t("Drag rows to arrange them")}</div>}
            <ClipList entries={entries} resetKey={filter + '|' + searchQuery + '|' + sort} handleRef={listHandle} renderRow={renderRow} empty={empty} onToggleDay={toggleDay} />
          </div>
          {clips.length > 0 && <div className={'pane-divider' + (resizing ? ' dragging' : '')} role="separator" aria-orientation="vertical" aria-label={t("List width")} title={t("Drag to resize. Double-click to reset.")} tabIndex={0}
            onPointerDown={event => { event.preventDefault(); dragOrigin.current = (event.currentTarget.previousElementSibling as HTMLElement).getBoundingClientRect().left; event.currentTarget.setPointerCapture(event.pointerId); setResizing(true); }}
            onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) resizeList(event.clientX - dragOrigin.current, false); }}
            onPointerUp={event => { event.currentTarget.releasePointerCapture(event.pointerId); setResizing(false); resizeList(event.clientX - dragOrigin.current); }}
            onLostPointerCapture={() => setResizing(false)}
            onDoubleClick={() => resizeList(null)}
            onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const current = (event.currentTarget.previousElementSibling as HTMLElement).getBoundingClientRect().width; resizeList(current + (event.key === 'ArrowRight' ? 32 : -32)); } else if (event.key === 'Home') { event.preventDefault(); resizeList(null); } }} />}
          {clips.length > 0 && <div className="preview-pane">{selection
            ? <section className="clip-preview selection-summary" aria-label={t('{count} clips selected', { count: selection.length })}>
              <h2>{t('{count} clips selected', { count: selection.length })}</h2>
              <div className="preview-actions">
                <button className="primary-button" disabled={!joinable(selection).length} onClick={() => void copyJoined(selection)}><Copy size={15} />{t("Copy together")}</button>
                <button className="subtle-button danger" onClick={() => void remove(selection)}><Trash2 size={15} />{t("Delete")}</button>
              </div>
            </section>
            : activeClip && clips.some(clip => clip.id === activeClip.id) ? <ClipPreview clip={activeClip} categories={library.categories} handlers={handlers} onEdit={edit} actions={manualMove} /> : null}</div>}
        </div>
          : <><ClipList entries={entries} resetKey={filter + '|' + searchQuery + '|' + sort + '|' + panelSession} handleRef={listHandle} renderRow={renderPanelRow} empty={empty} onToggleDay={toggleDay} pictures />
            {desktop && <div className="panel-grip" aria-hidden="true" title={t("Drag to resize")} onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); gripOrigin.current = { x: event.screenX, y: event.screenY, width: window.innerWidth, height: window.innerHeight }; }}
              onPointerMove={event => { const origin = gripOrigin.current; if (!origin || !event.currentTarget.hasPointerCapture(event.pointerId)) return; const size = { width: origin.width + event.screenX - origin.x, height: origin.height + event.screenY - origin.y }; cancelAnimationFrame(gripFrame.current); gripFrame.current = requestAnimationFrame(() => void resizePanel(size.width, size.height)); }}
              onPointerUp={event => { event.currentTarget.releasePointerCapture(event.pointerId); gripOrigin.current = null; }} />}
            {previewClip && <PanelPreview clip={previewClip} onClose={closePanelPreview} onMove={movePreview} onUse={plain => { setPreviewId(null); void reuse(previewClip, plain); }} />}</>}
      </>}
      {notice && <div className={'app-toast' + (notice.error ? ' error' : '')} role={notice.error ? 'alert' : 'status'}><span>{message(notice.text)}</span>{notice.undo && <button className="text-button toast-action" title={t("Undo (Ctrl+Z)")} onClick={() => { setNotice(null); void undo(); }}>{t("Undo")}</button>}<button className="icon-button" aria-label={t("Dismiss message")} onClick={() => setNotice(null)}><X size={15} /></button></div>}
    </main>
    {pendingRemoval && <ConfirmDialog title={t('Delete {count} clips?', { count: pendingRemoval.length })} description={t("You can undo with Ctrl+Z.")} onConfirm={() => deleteSelected(pendingRemoval)} onClose={() => setPendingRemoval(null)} />}
    {view === 'library' && !desktop && <div className="preview-banner"><Folder size={14} />{t("Interface preview. Automatic collection is available in the Windows app.")}</div>}
  </div>;
}
