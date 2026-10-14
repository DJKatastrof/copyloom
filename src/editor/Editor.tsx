import { t, message, setLanguage, useAppLanguage } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { ArrowUpRight, Check, Copy, Crop, Grid2X2, Highlighter, ListOrdered, MousePointer2, Redo2, Save, Scan, Square, SquareDashed, Type, Undo2, X, ZoomIn, ZoomOut } from 'lucide-react';
import { commit, cropShape, emptyHistory, imageBounds, moveShape, nextStepNumber, PALETTE, redo, signature, STEP_FONT_SIZE, undo } from './model';
import type { Shape, ShapeKind } from './model';
import { exportPng, measureStep, measureText } from './render';
import type { PixelCache } from './render';
import { imageFileName } from '../domain/fileName';
import { needsSave, saveOrCopy } from './save';
import type { SaveResult, SaveState } from './save';
import CanvasEditor from './CanvasEditor';
import type { CanvasHandle } from './CanvasEditor';
import type { Settings } from '../domain/library';
import Select from '../components/Select';
import { runEditorProbe } from './probe';

type OpenRequest = { id: string; capture: boolean; requestedAt?: number; createdAt: number; source?: string | null; customTitle?: string | null };
type LoadedImage = { id: string; bitmap: ImageBitmap; original: Blob };
const tools = [
  ['select', 'Select', MousePointer2], ['arrow', 'Arrow', ArrowUpRight], ['rectangle', 'Rectangle', Square],
  ['text', 'Text', Type], ['redact', 'Redact', SquareDashed], ['pixelate', 'Pixelate', Grid2X2],
  ['highlight', 'Highlighter', Highlighter], ['step', 'Numbered steps', ListOrdered], ['crop', 'Crop', Crop],
] as const;
const toolKeys: Record<string, 'select' | ShapeKind> = { a: 'arrow', r: 'rectangle', t: 'text', o: 'pixelate', h: 'highlight', i: 'step', c: 'crop', d: 'redact' };

function UnsavedDialog({ busy, error, onCancel, onDiscard, onSave }: { busy: boolean; error: string; onCancel: () => void; onDiscard: () => void; onSave: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), saveButton = useRef<HTMLButtonElement>(null);
  // showModal focuses the first button; Enter should save, as in Windows' own save prompts.
  useEffect(() => { dialog.current?.showModal(); saveButton.current?.focus(); return () => dialog.current?.close(); }, []);
  // Same compact dialog as the library; the destructive choice stands apart from Cancel and Save.
  return <dialog ref={dialog} className="clip-editor delete-confirmation editor-confirm" aria-labelledby="unsaved-title" aria-describedby="unsaved-description" onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }} onKeyDown={event => event.stopPropagation()} onClick={event => {
    if (busy || event.target !== event.currentTarget) return;
    const r = event.currentTarget.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) onCancel();
  }}>
    <h2 id="unsaved-title">{t("Copy your changes?")}</h2>
    <p id="unsaved-description">{t("Otherwise they are lost when the window closes.")}</p>
    {error && <p role="alert" className="inline-error">{message(error)}</p>}
    <div className="form-actions">
      <button className="text-button danger editor-discard" disabled={busy} onClick={onDiscard}>{t("Discard")}</button>
      <button className="subtle-button" disabled={busy} onClick={onCancel}>{t("Cancel")}</button>
      <button ref={saveButton} className="primary-button" disabled={busy} onClick={onSave}>{busy ? t("Copying…") : t("Copy and close")}</button>
    </div>
  </dialog>;
}

export default function Editor() {
  const language = useAppLanguage();
  useEffect(() => { document.title = t('Image editor – Copyloom'); }, [language]);
  const [loaded, setLoaded] = useState<LoadedImage | null>(null), loadedRef = useRef<LoadedImage | null>(null);
  const [history, setHistory] = useState(emptyHistory), historyRef = useRef(history); historyRef.current = history;
  const [selected, setSelected] = useState<string | null>(null), [tool, setTool] = useState<'select' | ShapeKind>('select');
  const [cropDraft, setCropDraft] = useState<Shape | null>(null), [stepNumber, setStepNumber] = useState(1);
  const [stepFontSize, setStepFontSize] = useState(STEP_FONT_SIZE);
  const [color, setColor] = useState(PALETTE[0]), [stroke, setStroke] = useState(4), [fontSize, setFontSize] = useState(28), [background, setBackground] = useState(false), [blockSize, setBlockSize] = useState(18);
  const [editing, setEditing] = useState<Shape | null>(null), editingRef = useRef(editing); editingRef.current = editing;
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [zoom, setZoom] = useState(1);
  const [confirming, setConfirming] = useState(false), [notice, setNotice] = useState('');
  const request = useRef<OpenRequest | null>(null);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(timer); }, [notice]);
  const cache = useRef<PixelCache>(new Map()), canvas = useRef<CanvasHandle>(null), saveState = useRef<SaveState>({ saved: null, busy: false });
  const blocked = useRef(false), mounted = useRef(true), probed = useRef(false);
  const callbacks = useRef({ close: () => {} });
  const selectedShape = history.present.find(shape => shape.id === selected);
  const currentStyle = editing ?? selectedShape;
  const effectiveKind = currentStyle?.kind ?? tool;
  function commitShapes(shapes: Shape[]) {
    const changedStep = shapes.filter(shape => shape.kind === 'step' && shape.fontSize !== historyRef.current.present.find(previous => previous.id === shape.id)?.fontSize).at(-1);
    if (changedStep?.fontSize) setStepFontSize(changedStep.fontSize);
    const next = commit(historyRef.current, shapes); historyRef.current = next; setHistory(next); setStepNumber(nextStepNumber(shapes));
  }
  function chooseTool(kind: 'select' | ShapeKind) {
    finishText(); setTool(kind); setSelected(null); setCropDraft(null);
    if (kind === 'redact') setColor('#000000');
    if (kind === 'highlight') setColor('#ffcf33');
  }
  function applyCrop(): Shape[] {
    const image = loadedRef.current;
    if (!cropDraft || !image) return historyRef.current.present;
    const cropped = cropShape(cropDraft, imageBounds(image.bitmap, historyRef.current.present));
    setCropDraft(null); setSelected(null); setTool('select');
    if (cropped) commitShapes([...historyRef.current.present, cropped]);
    return historyRef.current.present;
  }
  function finishText(cancel = false): Shape[] {
    const text = editingRef.current; if (!text) return historyRef.current.present;
    editingRef.current = null; setEditing(null);
    if (cancel) return historyRef.current.present;
    const present = historyRef.current.present;
    const shapes = text.text?.trim() ? present.some(shape => shape.id === text.id) ? present.map(shape => shape.id === text.id ? measureText(text) : shape) : [...present, measureText(text)] : present.filter(shape => shape.id !== text.id);
    commitShapes(shapes); return shapes;
  }
  function dirty(): boolean { const shapes = finishText(); return !!cropDraft || signature(shapes) !== (saveState.current.saved?.signature ?? '[]'); }
  function clearCache() { for (const entry of cache.current.values()) entry.canvas.width = entry.canvas.height = 0; cache.current.clear(); }
  async function load(request: OpenRequest) {
    blocked.current = true; setLoading(true); setError('');
    const started = performance.now();
    try {
      const bytes = await invoke<ArrayBuffer | number[]>('load_media', { id: request.id, kind: 'clip', original: true });
      const original = new Blob([bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes)], { type: 'image/png' });
      const bitmap = await createImageBitmap(original);
      if (!mounted.current) { bitmap.close(); return; }
      const image = { id: request.id, bitmap, original }; loadedRef.current = image; setLoaded(image);
      document.title = t("Image editor – Copyloom");
      await invoke('editor_ready', { width: bitmap.width, height: bitmap.height });
      if ((window as Window & { __COPYLOOM_EDITOR_PROBE__?: boolean }).__COPYLOOM_EDITOR_PROBE__ && !probed.current) {
        probed.current = true;
        const openMs = performance.now() - started;
        const windowOpenMs = request.requestedAt ? Date.now() - request.requestedAt : null;
        setTimeout(() => { void runEditorProbe(image, cache.current, openMs, windowOpenMs).catch(cause => invoke('editor_probe_report', { report: { error: String(cause) } })); }, 100);
      }
    } catch (cause) { setError(t("Could not open the image. ") + String(cause)); await invoke('editor_ready', { width: 0, height: 0 }).catch(() => {}); }
    finally { blocked.current = false; if (mounted.current) setLoading(false); }
  }
  async function close() {
    setConfirming(false);
    try { await invoke('close_editor'); } catch (cause) { setError(String(cause)); }
  }
  callbacks.current = {
    close: () => {
      if (blocked.current) return;
      if (dirty()) { setError(''); setConfirming(true); } else void close();
    },
  };
  useEffect(() => {
    mounted.current = true;
    const unlisteners: (() => void)[] = [];
    let disposed = false;
    const register = async (subscribe: Promise<() => void>) => { const off = await subscribe; if (disposed) off(); else unlisteners.push(off); };
    void (async () => {
      try {
        // Each image has its own window; a close request is addressed to this window only.
        await register(getCurrentWebviewWindow().listen('editor:close-requested', () => callbacks.current.close()));
        const settings = await invoke<Settings>('editor_settings');
        document.documentElement.dataset.theme = settings.theme; setLanguage(settings.language ?? 'en');
        await register(listen('library:changed', () => { void invoke<Settings>('editor_settings').then(settings => { document.documentElement.dataset.theme = settings.theme; setLanguage(settings.language ?? 'en'); }); }));
        const opened = await invoke<OpenRequest | null>('editor_request');
        if (disposed) return;
        if (opened) { request.current = opened; await load(opened); }
        else { setLoading(false); await invoke('editor_ready', { width: 0, height: 0 }).catch(() => {}); }
      } catch (cause) { if (!disposed) { setError(t("Could not start the editor. ") + String(cause)); setLoading(false); await invoke('editor_ready', { width: 0, height: 0 }).catch(() => {}); } }
    })();
    return () => { disposed = true; mounted.current = false; unlisteners.forEach(off => off()); loadedRef.current?.bitmap.close(); clearCache(); };
  }, []);
  // Copying adds the edited image to the history; a later copy from this window replaces that clip instead of adding another.
  async function copy(closeAfter: boolean) {
    if (!loadedRef.current || blocked.current) return;
    finishText(); const shapes = applyCrop(), image = loadedRef.current, key = signature(shapes);
    blocked.current = true; setBusy(true); setError(''); setNotice('');
    try {
      await saveOrCopy(saveState.current, key, async () => {
        const blob = shapes.length ? await exportPng(image.bitmap, shapes, cache.current) : image.original;
        const previous = saveState.current.saved?.id;
        return invoke<SaveResult>('save_edited_image', await blob.arrayBuffer(), { headers: { 'x-source-id': image.id, ...(previous ? { 'x-replace-id': previous } : {}) } });
      }, id => invoke('copy_clip', { id }));
      blocked.current = false;
      if (closeAfter) await close(); else setNotice(t("Copied"));
    } catch (cause) { setError(String(cause).replace(/^Error: /, '')); }
    finally { blocked.current = false; setBusy(false); }
  }
  // Writes what is on screen to a PNG file; the editor stays open and history is untouched.
  async function saveAs() {
    if (!loadedRef.current || blocked.current) return;
    finishText(); const shapes = applyCrop(), image = loadedRef.current, opened = request.current;
    blocked.current = true; setError(''); setNotice('');
    try {
      const blob = shapes.length ? await exportPng(image.bitmap, shapes, cache.current) : image.original;
      const name = imageFileName({ createdAt: opened?.createdAt ?? Date.now(), source: opened?.source, customTitle: opened?.customTitle });
      const path = await invoke<string | null>('save_image_file', await blob.arrayBuffer(), { headers: { 'x-file-name': encodeURIComponent(name) } });
      if (path) setNotice(t("Saved as {name}", { name: path.split(/[\\/]/).pop() ?? path }));
    } catch (cause) { setError(String(cause).replace(/^Error: /, '')); }
    finally { blocked.current = false; }
  }
  function changeStyle(update: Partial<Shape>) {
    if (blocked.current) return;
    if (editingRef.current) { const next = measureText({ ...editingRef.current, ...update }); editingRef.current = next; setEditing(next); }
    else if (selectedShape) commitShapes(history.present.map(shape => {
      if (shape.id !== selected) return shape;
      const changed = { ...shape, ...update };
      if (shape.kind === 'text') return measureText(changed);
      if (shape.kind === 'step' && (update.fontSize !== undefined || update.number !== undefined)) return measureStep(changed, loaded ? imageBounds(loaded.bitmap, history.present) : undefined);
      return changed;
    }));
    if (update.blockSize) setBlockSize(update.blockSize);
    if (update.color) setColor(update.color); if (update.stroke) setStroke(update.stroke);
    if (update.fontSize) { if (effectiveKind === 'step') setStepFontSize(update.fontSize); else setFontSize(update.fontSize); }
    if (update.background !== undefined) setBackground(update.background);
  }
  function travel(direction: 'undo' | 'redo') {
    finishText(); setCropDraft(null); const next = direction === 'undo' ? undo(historyRef.current) : redo(historyRef.current); historyRef.current = next; setHistory(next); setSelected(null); setStepNumber(nextStepNumber(next.present));
    setStepFontSize(next.present.filter(shape => shape.kind === 'step').at(-1)?.fontSize ?? STEP_FONT_SIZE);
  }
  const keyHandler = useRef((_: KeyboardEvent) => {});
  keyHandler.current = event => {
    if (confirming || blocked.current) return;
    const input = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || (event.target as HTMLElement)?.isContentEditable;
    // Ctrl+S or Ctrl+Enter copies and closes; Ctrl+Shift+S saves a file and Ctrl+Shift+C copies.
    const command = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
    if (command && key === 's') { event.preventDefault(); void (event.shiftKey ? saveAs() : copy(true)); return; }
    if (input && event.key === 'Escape' && !editingRef.current) { event.preventDefault(); (event.target as HTMLElement).blur(); chooseTool('select'); return; }
    if (input || event.altKey || event.isComposing) return;
    if (!command && !event.shiftKey && toolKeys[key]) { event.preventDefault(); chooseTool(toolKeys[key]); return; }
    if (event.key === 'Enter' && cropDraft && !command) { event.preventDefault(); applyCrop(); return; }
    if (command && key === 'enter') { event.preventDefault(); void copy(true); return; }
    if (command && event.shiftKey && key === 'c') { event.preventDefault(); void copy(false); return; }
    if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); travel(event.key.toLowerCase() === 'y' || event.shiftKey ? 'redo' : 'undo'); }
    else if (['Delete', 'Backspace'].includes(event.key) && selected) { event.preventDefault(); commitShapes(history.present.filter(shape => shape.id !== selected)); setSelected(null); }
    else if (event.key === 'Escape') { setCropDraft(null); setSelected(null); setTool('select'); }
    else if (event.key.startsWith('Arrow') && selectedShape && loaded) {
      event.preventDefault(); const step = event.shiftKey ? 10 : 1;
      const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0, dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
      commitShapes(history.present.map(shape => shape.id === selected ? moveShape(shape, dx, dy, loaded.bitmap.width, loaded.bitmap.height) : shape));
    }
  };
  useEffect(() => { const key = (event: KeyboardEvent) => keyHandler.current(event); window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, []);
  const retry = !needsSave(saveState.current, signature(history.present)) && !saveState.current.saved?.copied;
  const disabled = busy || loading || !loaded;
  // Guidance lives in tooltips; the toolbar itself carries only tools and actions.
  const help = (kind: string) => kind === 'select' ? t("Click a shape to move or resize it.") : kind === 'crop' ? t("Drag the area to keep. Enter crops, Escape cancels.") : kind === 'step' ? t("Click to place a number. Adjust it with the handles. Select the tool again for the next number.") : kind === 'highlight' ? t("Drag over the text to highlight.") : kind === 'arrow' ? t("Drag from the start to the tip to draw an arrow.") : kind === 'rectangle' ? t("Drag over the area you want to outline.") : kind === 'text' ? t("Click the image and type. Double-click to edit text.") : kind === 'redact' ? t("Drag over sensitive information to cover it completely.") : t("Visual effect. Use Redact for sensitive information.");
  return <main className="image-editor">
    <div className="editor-toolbar" role="toolbar" aria-label={t("Image tools")}>
      <div className="editor-tools">{tools.map(([id, label, Icon]) => <button key={id} className="editor-tool" title={t(label) + ' (' + (Object.entries(toolKeys).find(([, kind]) => kind === id)?.[0].toUpperCase() ?? 'Esc') + ') – ' + help(id)} aria-label={t(label)} aria-keyshortcuts={Object.entries(toolKeys).find(([, kind]) => kind === id)?.[0] ?? 'Escape'} aria-pressed={tool === id} disabled={disabled} onClick={() => chooseTool(id)}><Icon size={18} /></button>)}</div>
      <div className="editor-history"><button className="icon-button" title={t("Undo (Ctrl+Z)")} aria-label={t("Undo")} disabled={disabled || !history.past.length} onClick={() => travel('undo')}><Undo2 size={17} /></button><button className="icon-button" title={t("Redo (Ctrl+Y)")} aria-label={t("Redo")} disabled={disabled || !history.future.length} onClick={() => travel('redo')}><Redo2 size={17} /></button></div>
      <div className="editor-zoom"><button className="icon-button" title={t("Zoom out")} aria-label={t("Zoom out")} disabled={disabled} onClick={() => canvas.current?.zoomTo(zoom / 1.25)}><ZoomOut size={16} /></button><button className="text-button editor-zoom-value" title={t("View at 100%")} disabled={disabled} onClick={() => canvas.current?.zoomTo(1)}>{Math.round(zoom * 100)} %</button><button className="icon-button" title={t("Zoom in")} aria-label={t("Zoom in")} disabled={disabled} onClick={() => canvas.current?.zoomTo(zoom * 1.25)}><ZoomIn size={16} /></button><button className="icon-button" title={t("Fit to window")} aria-label={t("Fit to window")} disabled={disabled} onClick={() => canvas.current?.fit()}><Scan size={16} /></button></div>
      <div className="editor-actions"><button className="icon-button editor-save-as" title={t("Save as PNG file (Ctrl+Shift+S)")} aria-label={t("Save as…")} disabled={disabled} onClick={() => void saveAs()}><Save size={17} /></button>
        <button className="subtle-button editor-copy" title={t("Copy and keep editing (Ctrl+Shift+C)")} disabled={disabled} onClick={() => void copy(false)}><Copy size={15} />{t("Copy")}</button>
        <button className="primary-button editor-save" title={t("Ctrl+S. The original stays in the history.")} disabled={disabled} onClick={() => void copy(true)}><Check size={16} />{busy ? t("Copying…") : retry ? t("Copy again") : t("Copy and close")}</button></div>
    </div>
    <div className="editor-options">{effectiveKind === 'crop' ? <><span className="editor-option-label">{t('Crop')}</span><button className="subtle-button" disabled={disabled || !cropDraft} onClick={applyCrop}><Check size={15} />{t('Crop')}</button><button className="text-button" disabled={disabled} onClick={() => chooseTool('select')}>{t('Cancel')}</button></> : effectiveKind !== 'select' && <>
      <span className="editor-option-label" title={help(effectiveKind)}>{t(tools.find(([id]) => id === effectiveKind)?.[1] ?? '')}</span>
      {effectiveKind !== 'pixelate' && <div className="editor-colors" role="group" aria-label={t("Shape color")}>{PALETTE.map(candidate => <button key={candidate} className="editor-swatch" title={candidate} aria-label={t("Color ") + candidate} aria-pressed={(currentStyle?.color ?? color) === candidate} disabled={disabled} style={{ backgroundColor: candidate }} onClick={() => changeStyle({ color: candidate })}>{(currentStyle?.color ?? color) === candidate && <Check size={13} color={['#ffffff', '#ffcf33', '#00a9e6'].includes(candidate) ? '#18171d' : '#ffffff'} />}</button>)}</div>}
      {effectiveKind === 'step' ? <>
        <label className="editor-step-number" htmlFor="editor-step-number"><span>{t('Number')}</span><input id="editor-step-number" type="number" min={1} max={9999} value={currentStyle?.number ?? stepNumber} disabled={disabled} onChange={event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1 && value <= 9999) { if (selectedShape?.kind === 'step') changeStyle({ number: value }); else setStepNumber(value); } }} /></label>
        <Select disabled={disabled} id="editor-step-font-size" label={t('Text size')} value={String(currentStyle?.fontSize ?? stepFontSize)} onChange={value => changeStyle({ fontSize: Number(value) })} options={[...new Set([8, 12, 14, 16, 18, 20, 24, 28, 36, 48, 64, 96, currentStyle?.fontSize ?? stepFontSize])].sort((a, b) => a - b).map(size => ({ value: String(size), label: size + ' px' }))} />
      </> : effectiveKind === 'pixelate' ? <label className="editor-block-size" htmlFor="editor-block-size"><span>{t("Block size")}</span><Select disabled={disabled} id="editor-block-size" label={t("Block size")} value={String(currentStyle?.blockSize ?? blockSize)} onChange={value => changeStyle({ blockSize: Number(value) })} options={[4, 8, 12, 18, 24, 32, 48, 64].map(size => ({ value: String(size), label: size + ' px' }))} /></label> : effectiveKind === 'text' ? <><Select disabled={disabled} id="editor-font-size" label={t("Text size")} value={String(currentStyle?.fontSize ?? fontSize)} onChange={value => changeStyle({ fontSize: Number(value) })} options={[16, 20, 28, 36, 48, 64, 96].map(size => ({ value: String(size), label: size + ' px' }))} /><label className="editor-background"><input type="checkbox" checked={currentStyle?.background ?? background} onChange={event => changeStyle({ background: event.target.checked })} disabled={disabled} />{t("White background")}</label></> : !['redact', 'highlight'].includes(effectiveKind) ? <Select disabled={disabled} id="editor-stroke" label={t("Line width")} value={String(currentStyle?.stroke ?? stroke)} onChange={value => changeStyle({ stroke: Number(value) })} options={[2, 4, 8, 12].map(size => ({ value: String(size), label: size + ' px' }))} /> : null}
    </>}{loaded && <span className="editor-dimensions" title={t('Ctrl + scroll: zoom · Space + drag: pan')}>{imageBounds(loaded.bitmap, history.present).width} × {imageBounds(loaded.bitmap, history.present).height}</span>}</div>
    {notice && !error && <div className="app-toast editor-notice" role="status"><span>{notice}</span><button className="icon-button" aria-label={t("Dismiss message")} onClick={() => setNotice('')}><X size={15} /></button></div>}
    {error && !confirming && <div className="editor-error" role="alert"><span>{message(error)}</span><button className="icon-button" aria-label={t("Dismiss error")} onClick={() => setError('')}><X size={16} /></button></div>}
    {loaded ? <CanvasEditor ref={canvas} image={loaded.bitmap} shapes={history.present} selected={selected} tool={tool} color={color} stroke={stroke} fontSize={fontSize} stepFontSize={stepFontSize} background={background} blockSize={blockSize} stepNumber={stepNumber} cropDraft={cropDraft} onCropDraft={setCropDraft} disabled={busy || loading || confirming} editing={editing} onEdit={shape => { editingRef.current = shape; setEditing(shape); }} onFinishText={finishText} onSelect={setSelected} onCommit={commitShapes} onStepPlaced={() => setTool('select')} onZoom={setZoom} cache={cache.current} /> : <div className="editor-empty" role="status">{loading ? t("Opening image…") : t("Open an image using Edit in history.")}</div>}
    {confirming && <UnsavedDialog busy={busy} error={error} onCancel={() => { setConfirming(false); setError(''); }} onDiscard={() => void close()} onSave={() => void copy(true)} />}
  </main>;
}
