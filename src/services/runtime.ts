import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { emptyLibrary, reduceLibrary, removal, restoreRemoval } from '../domain/library';
import type { Action, Clip, Library, Removal } from '../domain/library';
import { imageFileName } from '../domain/fileName';
import { mergeLibraryUpdate } from '../domain/libraryUpdate';
import type { LibraryUpdate } from '../domain/libraryUpdate';
import { clearMediaCache } from './media';

export const desktop = isTauri();
export const panelWindow = desktop && (window as Window & { __COPYLOOM_PANEL__?: boolean }).__COPYLOOM_PANEL__ === true;
let browserLibrary = emptyLibrary();
// Same undo history as the Windows app: newest last, at most 50 deletions.
const browserRemovals: Removal[] = [];
const browserListeners = new Set<(library: Library) => void>();
const localErrors = new Set<(message: string) => void>();

let desktopLibrary: Library | null = null;
let pendingLoad: Promise<Library> | null = null;
export async function loadLibrary(): Promise<Library> {
  if (!desktop) return browserLibrary;
  if (pendingLoad) return pendingLoad;
  pendingLoad = invoke<Library>('load_library').then(next => {
    if (!desktopLibrary || next.revision >= desktopLibrary.revision) desktopLibrary = next;
    return desktopLibrary;
  }).finally(() => { pendingLoad = null; });
  return pendingLoad;
}
async function receiveUpdate(update: Library | LibraryUpdate): Promise<Library> {
  // Full snapshots are also accepted for startup and existing test hosts.
  if ('clips' in update) {
    if (!desktopLibrary || update.revision >= desktopLibrary.revision) desktopLibrary = update;
    return desktopLibrary;
  }
  if (desktopLibrary && update.revision <= desktopLibrary.revision) return desktopLibrary;
  if (!desktopLibrary || update.baseRevision !== desktopLibrary.revision) return loadLibrary();
  desktopLibrary = mergeLibraryUpdate(desktopLibrary, update);
  return desktopLibrary;
}

export async function dispatch(action: Action): Promise<Library> {
  if (desktop) return receiveUpdate(await invoke<LibraryUpdate | Library>('apply_action', { action }));
  const removed = action.type === 'deleteClips' ? removal(browserLibrary, action.ids) : null;
  browserLibrary = reduceLibrary(browserLibrary, action);
  if (removed?.clips.length) { browserRemovals.push(removed); if (browserRemovals.length > 50) browserRemovals.shift(); }
  browserListeners.forEach(listener => listener(browserLibrary));
  return browserLibrary;
}

/** Restores the most recent deletion, one step per call; resolves to the number of clips restored, 0 when none are left. */
export async function undoDelete(): Promise<number> {
  if (desktop) return invoke('undo_delete');
  const removed = browserRemovals.pop();
  if (!removed) return 0;
  browserLibrary = restoreRemoval(browserLibrary, removed);
  browserListeners.forEach(listener => listener(browserLibrary));
  return removed.clips.length;
}
export async function canUndoDelete(): Promise<boolean> {
  return desktop ? invoke('can_undo_delete') : browserRemovals.length > 0;
}

export async function subscribeLibrary(callback: (library: Library) => void): Promise<() => void> {
  if (desktop) {
    const off = await listen<LibraryUpdate | Library>('library:changed', event => { void receiveUpdate(event.payload).then(callback).catch(() => { localErrors.forEach(listener => listener('Could not update history. Try again or restart Copyloom.')); }); });
    try { const reset = await listen('library:restored', clearMediaCache); return () => { off(); reset(); }; }
    catch (error) { off(); throw error; }
  }
  browserListeners.add(callback);
  return () => { browserListeners.delete(callback); };
}

export async function changeView(view: 'library' | 'panel' | 'settings'): Promise<void> {
  if (desktop) await invoke('change_view', { view });
}

export async function copyImageText(id: string): Promise<void> {
  if (desktop) await invoke('copy_image_text', { id });
}

export async function hidePanel(): Promise<void> {
  if (desktop) await invoke('hide_panel');
}

/** Moves the panel with the mouse while the button is held. */
export async function dragPanel(): Promise<void> {
  if (desktop) await invoke('drag_panel');
}

/** New panel size in CSS pixels; Copyloom remembers it when the panel closes. */
export async function resizePanel(width: number, height: number): Promise<void> {
  if (desktop) await invoke('resize_panel', { width, height });
}

export async function copyClip(clip: Clip, plain = false): Promise<{ pasted: boolean }> {
  if (desktop) return invoke('copy_clip', { id: clip.id, plain });
  if (clip.kind === 'image') {
    const blob = await (await fetch(clip.content)).blob();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  } else if (!plain && clip.html && !clip.html.startsWith('copyloom-html:')) {
    await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([clip.content], { type: 'text/plain' }), 'text/html': new Blob([clip.html], { type: 'text/html' }) })]);
  } else await navigator.clipboard.writeText(clip.content);
  return { pasted: false };
}

export async function subscribeView(callback: (view: 'library' | 'panel' | 'settings') => void): Promise<() => void> {
  if (!desktop) return () => {};
  return listen<'library' | 'panel' | 'settings'>('view:changed', event => callback(event.payload));
}

export async function subscribeErrors(callback: (message: string) => void): Promise<() => void> {
  if (!desktop) return () => {};
  localErrors.add(callback);
  try {
    const unlisten = await listen<string>('runtime:error', event => callback(event.payload));
    return () => { unlisten(); localErrors.delete(callback); };
  } catch (error) { localErrors.delete(callback); throw error; }
}

export async function subscribePanelMotion(callback: (phase: 'opening' | 'closing', epoch?: number) => void): Promise<() => void> {
  if (!desktop) return () => {};
  const opened = await listen<number>('panel:prepared', event => callback('opening', event.payload));
  try {
    const closing = await listen<number>('panel:closing', event => callback('closing', event.payload));
    return () => { opened(); closing(); };
  } catch (error) { opened(); throw error; }
}

export async function finishHidePanel(epoch: number): Promise<void> {
  if (desktop) await invoke('finish_hide_panel', { epoch });
}

export async function showPanel(epoch: number): Promise<void> {
  if (desktop) await invoke('show_panel', { epoch });
}

export type AutostartStatus = { enabled: boolean; currentExecutable: boolean };
export async function getAutostart(): Promise<AutostartStatus> {
  return desktop ? invoke("get_autostart") : { enabled: false, currentExecutable: false };
}
export async function setAutostart(enabled: boolean): Promise<AutostartStatus> {
  if (!desktop) throw new Error("Automatic startup is available in the Windows app.");
  return invoke("set_autostart", { enabled });
}

export async function reportFrontendReady(): Promise<void> {
  if (desktop) await invoke('frontend_ready');
}

export async function setCaptureRecording(recording: boolean): Promise<void> {
  if (desktop) await invoke('set_capture_recording', { recording });
}

export async function openEditor(id: string): Promise<void> {
  if (!desktop) throw new Error('Image editing is available in the Windows app.');
  await invoke('open_editor', { id });
}

/** Saves the stored original as a PNG file; resolves to the chosen path, or null when cancelled. */
export async function saveClipImage(clip: Clip): Promise<string | null> {
  if (!desktop) throw new Error('Save as is available in the Windows app.');
  return invoke('save_clip_image', { id: clip.id, name: imageFileName({ createdAt: clip.createdAt, source: clip.sourceApp?.name, customTitle: clip.customTitle ? clip.title : null }) });
}

export type CaptureEnvironment = { printScreenEnabled: boolean | null; registered: boolean };
export async function getCaptureEnvironment(): Promise<CaptureEnvironment> {
  return desktop ? invoke('get_capture_environment') : { printScreenEnabled: null, registered: false };
}
export async function retryCaptureShortcut(): Promise<CaptureEnvironment> { return invoke('retry_capture_shortcut'); }
export async function openKeyboardSettings(): Promise<void> { await invoke('open_keyboard_settings'); }
export async function openDataFolder(): Promise<void> { await invoke('open_data_folder'); }
/** released: Windows has let go of Win+V (after Explorer restarts); registered: Win+V opens the panel. */
export type WinVStatus = { released: boolean; registered: boolean };
export async function getWinV(): Promise<WinVStatus> { return invoke('get_win_v'); }
export async function setWinV(enabled: boolean): Promise<WinVStatus> { return invoke('set_win_v', { enabled }); }
export async function restartExplorer(): Promise<WinVStatus> { return invoke('restart_explorer'); }
