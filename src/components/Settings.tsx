import { t, message, getLanguage } from '../i18n';
import { useConfirmation } from './ConfirmDialog';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { DEFAULT_SETTINGS, clipsBefore, expiredClips, normalizeCaptureShortcut, normalizeShortcut, validateSettings } from '../domain/library';
import type { Action, Library, Settings as AppSettings } from '../domain/library';
import { desktop, setCaptureRecording as suspendCaptureShortcut, getWinV, setWinV, restartExplorer } from '../services/runtime';
import type { WinVStatus } from '../services/runtime';
import AutostartSettings from './AutostartSettings';
import type { StartMode } from './AutostartSettings';
import CaptureWarning from './CaptureWarning';
import { version } from '../../package.json';
import { getAutostart, setAutostart, getCaptureEnvironment } from '../services/runtime';
import type { AutostartStatus } from '../services/runtime';
import Select from './Select';
import HistoryTransfer from './HistoryTransfer';
import ProgramExclusions from './ProgramExclusions';

const RETENTION = [1, 7, 30, 90, 365];
function retentionLabel(days: number | null): string {
  if (days === null) return t("Forever");
  if (days === 1) return t("1 day");
  if (days === 365) return t("1 year");
  return t('{count} days', { count: days });
}

/** Every change takes effect at once, as in Windows' own settings; only deleting history asks first. */
export default function Settings({ library, act, deleteClips }: { library: Library; act: (action: Action) => Promise<boolean>; deleteClips: (ids: string[]) => Promise<boolean> }) {
  const { confirm, dialog } = useConfirmation();
  const settings = library.settings;
  const [section, setSection] = useState<'general' | 'capture' | 'history'>('general');
  const [recording, setRecording] = useState<'panel' | 'capture' | null>(null);
  const [error, setError] = useState('');
  const [autostart, setAutostartStatus] = useState<AutostartStatus | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [autostartError, setAutostartError] = useState('');
  const [reload, setReload] = useState(0);
  // Print Screen chosen while Windows still owns the key: kept here until Windows lets go.
  const [pendingCapture, setPendingCapture] = useState<string | null>(null);
  const [winV, setWinVStatus] = useState<WinVStatus | null>(null);
  const [winVBusy, setWinVBusy] = useState(false);
  useEffect(() => { if (desktop) void getWinV().then(setWinVStatus).catch(() => {}); }, [settings.winV]);
  useEffect(() => {
    if (!desktop) return;
    let active = true; setAutostartError('');
    void getAutostart().then(status => { if (active) setAutostartStatus(status); }).catch(() => { if (active) setAutostartError(t("Could not read the startup setting. Try again.")); });
    return () => { active = false; };
  }, [reload]);
  useEffect(() => {
    if (!recording) return;
    void suspendCaptureShortcut(true).catch(cause => { setError(String(cause)); setRecording(null); });
    return () => { void suspendCaptureShortcut(false).catch(cause => setError(String(cause))); };
  }, [!!recording]);

  async function apply(update: Partial<AppSettings>, expiry = false): Promise<boolean> {
    setError('');
    let next: AppSettings;
    try { next = validateSettings({ ...settings, ...update }); } catch (cause) { setError((cause as Error).message); return false; }
    const affected = expiry ? expiredClips(library, Date.now(), next.retentionDays, next.keepCategorized ?? false) : [];
    if (affected.length && !await confirm({ title: t("Change how long clips are kept?"), description: affected.length + t(" clips will be deleted. Favorites will be kept."), confirmLabel: t("Change and delete") })) return false;
    if (!await act({ type: 'setSettings', settings: next })) return false;
    if (affected.length) await act({ type: 'prune', now: Date.now() });
    return true;
  }
  // Cleanup by date: everything created before the start of the chosen day, kept clips excepted.
  const [before, setBefore] = useState('');
  const cutoff = /^\d{4}-\d{2}-\d{2}$/.test(before) ? (([year, month, day]) => new Date(year, month - 1, day).getTime())(before.split('-').map(Number)) : null;
  const older = cutoff === null ? [] : clipsBefore(library, cutoff);
  const keptText = settings.keepCategorized ? t("Favorites and clips in categories are kept.") : t("Favorites are kept.");
  async function cleanUp() {
    if (cutoff === null || !older.length) return;
    const ids = older.map(clip => clip.id), images = older.some(clip => clip.kind === 'image');
    const date = new Intl.DateTimeFormat(getLanguage(), { day: 'numeric', month: 'long', year: 'numeric' }).format(cutoff);
    if (!await confirm({ title: ids.length === 1 ? t('Delete 1 clip created before {date}?', { date }) : t('Delete {count} clips created before {date}?', { count: ids.length, date }), description: [keptText, images ? '' : t("You can undo with Ctrl+Z.")].filter(Boolean).join(' ') })) return;
    if (await deleteClips(ids)) setBefore('');
  }
  const today = new Date(), todayValue = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const latestApply = useRef(apply); latestApply.current = apply;
  const pendingRef = useRef(pendingCapture); pendingRef.current = pendingCapture;
  // Windows has released Print Screen (checked again on focus): use the key that was waiting for it.
  const blocked = useCallback((value: boolean) => {
    const key = pendingRef.current;
    if (!value && key) { setPendingCapture(null); void latestApply.current({ captureShortcut: key }); }
  }, []);
  async function chooseCapture(key: string | null) {
    setError('');
    if (desktop && key === 'PrintScreen') {
      try { if ((await getCaptureEnvironment()).printScreenEnabled) { setPendingCapture(key); return; } }
      catch { setError(t("Could not check the Windows setting. Try again.")); return; }
    }
    setPendingCapture(null); await apply({ captureShortcut: key });
  }
  async function chooseStart(mode: StartMode) {
    setAutostartBusy(true); setAutostartError('');
    try {
      if (mode === 'off') { if (autostart?.enabled) setAutostartStatus(await setAutostart(false)); return; }
      if (!autostart?.enabled || !autostart.currentExecutable) setAutostartStatus(await setAutostart(true));
      if (!!settings.startMinimized !== (mode === 'tray')) await apply({ startMinimized: mode === 'tray' });
    } catch (cause) { setAutostartError(t("Could not save the startup setting. ") + message(String(cause))); }
    finally { setAutostartBusy(false); }
  }
  // Windows reads the change only when Explorer starts again, so both directions offer that restart.
  async function chooseWinV(enabled: boolean, restartOnly = false) {
    setWinVBusy(true); setError('');
    try {
      if (!restartOnly) setWinVStatus(await setWinV(enabled));
      if (await confirm({ title: t("Restart File Explorer now?"), description: enabled ? t("Windows releases Win+V only when File Explorer restarts. Open folder windows close and the taskbar returns after a few seconds. You can also sign out and in later.") : t("Windows clipboard history gets Win+V back when File Explorer restarts. Open folder windows close. You can also sign out and in later."), confirmLabel: t("Restart"), destructive: false })) setWinVStatus(await restartExplorer());
    } catch (cause) { setError(String(cause)); }
    finally { setWinVBusy(false); }
  }
  // Win+V and the own shortcut are one choice: Win+V replaces it, any other shortcut gives Win+V back.
  const own = settings.shortcut.replace('Super', 'Win');
  const shortcutText = !desktop ? t("Works in this preview window. Global shortcuts are available in the Windows app.")
    : settings.winV ? (winV?.registered ? t("Win+V replaces Windows clipboard history. Choose another shortcut to give Win+V back to Windows.") : t("Windows still holds Win+V; until then {shortcut} works. Restart File Explorer, or sign out and in.", { shortcut: own }))
    : winV?.released ? t("Windows gets Win+V back when File Explorer restarts.")
    : t("In Remote Desktop, the shortcut may go to the remote computer.");
  async function chooseShortcut(shortcut: string) {
    if (!settings.winV) { await apply({ shortcut }); return; }
    // Leaving Win+V: Windows gets it back, then the new shortcut takes over.
    setWinVBusy(true);
    try { setWinVStatus(await setWinV(false)); } catch (cause) { setError(String(cause)); setWinVBusy(false); return; }
    setWinVBusy(false);
    // The settings in hand still say Win+V; say otherwise explicitly so it is not switched back on.
    if (await apply({ shortcut, winV: false })) await chooseWinV(false, true);
  }
  function record(target: 'panel' | 'capture', event: React.KeyboardEvent) {
    if (recording !== target) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Escape') { setRecording(null); return; }
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return;
    const key = target === 'capture' && event.key === 'PrintScreen' ? 'PrintScreen' : event.key.toUpperCase();
    const combo = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Super', key].filter(Boolean).join('+');
    try {
      const shortcut = target === 'panel' ? normalizeShortcut(combo) : normalizeCaptureShortcut(combo);
      setRecording(null);
      void (target === 'panel' ? chooseShortcut(shortcut) : chooseCapture(shortcut));
    } catch (cause) { setError((cause as Error).message); }
  }
  const retention = settings.retentionDays;
  const retentionOptions = [...new Set([...RETENTION, ...(retention !== null ? [retention] : [])])].sort((a, b) => a - b).map(days => ({ value: String(days), label: retentionLabel(days) }));
  const captureLabel = (key: string | null | undefined) => key ? key.replace('PrintScreen', 'Print Screen').replace('Super', 'Win') : t("Off");

  return <div className="settings-content">{dialog}
    <div className="settings-topline"><nav className="settings-nav" aria-label={t("Settings sections")}>{([['general', t("General")], ['capture', t("Screenshot")], ['history', t("History")]] as const).map(([id, label]) => <button key={id} aria-current={section === id ? 'page' : undefined} onClick={() => { setRecording(null); setSection(id); }}>{label}</button>)}</nav><span className="settings-version">Copyloom {version}</span></div>
    {section === 'general' && <>
      <section className="settings-section"><h2>{t("Quick panel")}</h2>
        <div className="setting-row"><div><label id="shortcut-label">{t("Keyboard shortcut")}</label><p>{shortcutText}</p></div>
          <div className="shortcut-controls"><button className={`shortcut-recorder${recording === 'panel' ? ' recording' : ''}`} aria-labelledby="shortcut-label" disabled={winVBusy} onClick={() => setRecording('panel')} onBlur={() => setRecording(current => current === 'panel' ? null : current)} onKeyDown={event => record('panel', event)}>{recording === 'panel' ? t("Press your shortcut…") : settings.winV ? 'Win+V' : own}</button>
            {(settings.winV || settings.shortcut !== DEFAULT_SETTINGS.shortcut) && <button className="icon-button" title={t("Reset shortcut")} aria-label={t("Reset shortcut")} disabled={winVBusy} onClick={() => void chooseShortcut(DEFAULT_SETTINGS.shortcut)}><RotateCcw size={17} /></button>}
            {desktop && !settings.winV && <button className="text-button" disabled={winVBusy} onClick={() => void chooseWinV(true)}>Win+V</button>}
            {desktop && (settings.winV ? !winV?.registered : winV?.released) && <button className="text-button" disabled={winVBusy} onClick={() => void chooseWinV(!!settings.winV, true)}>{t("Restart File Explorer")}</button>}
          </div>
        </div>
        <div className="setting-row"><div><label htmlFor="panel-position">{t("Open at")}</label>{settings.panelPosition === 'caret' && <p>{t("Where an app shows no text cursor, the panel opens at the mouse pointer.")}</p>}</div>
          <Select id="panel-position" label={t("Open at")} value={settings.panelPosition ?? 'pointer'} onChange={value => void apply({ panelPosition: value as AppSettings['panelPosition'] })} options={[{ value: 'pointer', label: t("Mouse pointer") }, { value: 'caret', label: t("Text cursor") }, { value: 'center', label: t("Center of the screen") }, { value: 'last', label: t("Where it was last") }]} />
        </div>
        <div className="setting-row"><div><label htmlFor="panel-click">{t("Use a clip with")}</label><p>{t("Space previews the selected clip.")}</p></div>
          <Select id="panel-click" label={t("Use a clip with")} value={settings.panelClick ?? 'single'} onChange={value => void apply({ panelClick: value as AppSettings['panelClick'] })} options={[{ value: 'single', label: t("One click") }, { value: 'double', label: t("Double-click") }]} />
        </div>
        <div className="setting-row"><div><label htmlFor="panel-trash">{t("Trash button on rows")}</label><p>{t("Delete removes the selected clip without it too.")}</p></div>
          <Select id="panel-trash" label={t("Trash button on rows")} value={settings.panelTrash ?? 'always'} onChange={value => void apply({ panelTrash: value as AppSettings['panelTrash'] })} options={[{ value: 'always', label: t("Always shown") }, { value: 'hover', label: t("Shown on hover") }, { value: 'off', label: t("Hidden") }]} />
        </div>
        <div className="setting-row"><div><label htmlFor="paste-mode">{t("When you use a clip")}</label><p>{t("Hold Shift for plain text.")}</p></div>
          <Select id="paste-mode" label={t("When you use a clip")} value={settings.pasteDirectly === false ? 'clipboard' : 'direct'} onChange={value => void apply({ pasteDirectly: value === 'direct' })} options={[{ value: 'direct', label: t("Paste directly") }, { value: 'clipboard', label: t("Copy to clipboard") }]} />
        </div>
      </section>
      <section className="settings-section"><h2>{t("Startup")}</h2>
        <AutostartSettings status={autostart} minimized={!!settings.startMinimized} busy={autostartBusy} error={autostartError} onChange={mode => void chooseStart(mode)} onRepair={() => void chooseStart(settings.startMinimized ? 'tray' : 'library')} onRetry={() => setReload(value => value + 1)} />
      </section>
      <section className="settings-section"><h2>{t("Appearance")}</h2>
        <div className="setting-row"><label htmlFor="theme">{t("Theme")}</label><Select id="theme" label={t("Theme")} value={settings.theme} onChange={value => void apply({ theme: value as AppSettings["theme"] })} options={[{ value: "system", label: t("Follow Windows") }, { value: "light", label: t("Light") }, { value: "dark", label: t("Dark") }]} /></div>
        <div className="setting-row"><label htmlFor="language">{t("Language")}</label><Select id="language" label={t("Language")} value={settings.language ?? 'en'} onChange={value => void apply({ language: value as 'en' | 'sv' })} options={[{ value: 'en', label: 'English' }, { value: 'sv', label: 'Svenska' }]} /></div>
      </section>
    </>}
    {section === 'capture' && <section className="settings-section"><h2>{t("Screenshot")}</h2>
      <div className="setting-row"><div><label id="capture-shortcut-label">{t("Keyboard shortcut")}</label><p>{t("Drag to select an area. Escape cancels.")}</p></div><div className="shortcut-controls">
        <button className={`shortcut-recorder${recording === 'capture' ? ' recording' : ''}`} aria-labelledby="capture-shortcut-label" onClick={() => setRecording('capture')} onBlur={() => setRecording(current => current === 'capture' ? null : current)} onKeyDown={event => record('capture', event)}>{recording === 'capture' ? t("Press your key…") : captureLabel(pendingCapture ?? settings.captureShortcut)}</button>
        {(pendingCapture ?? settings.captureShortcut) !== 'PrintScreen' && <button className="text-button" onClick={() => void chooseCapture('PrintScreen')}>Print Screen</button>}
        {(pendingCapture ?? settings.captureShortcut) && <button className="text-button" onClick={() => void chooseCapture(null)}>{t("Turn off")}</button>}
      </div></div>
      <CaptureWarning selected={pendingCapture ?? settings.captureShortcut ?? null} saved={settings.captureShortcut ?? null} recording={!!recording} onBlocked={blocked} />
      <div className="setting-row"><div><label htmlFor="after-capture">{t("After screenshot")}</label><p>{t("The original is always kept in the history.")}</p></div>
        <Select id="after-capture" label={t("After screenshot")} value={settings.captureBehavior ?? (settings.editAfterCapture ? 'edit' : 'copy')} onChange={value => void apply({ captureBehavior: value as 'copy' | 'edit' | 'choose', editAfterCapture: value === 'edit' })} options={[{ value: 'copy', label: t("Copy to clipboard") }, { value: 'edit', label: t("Open in editor") }, { value: 'choose', label: t("Show Copy / Edit menu") }]} />
      </div>
    </section>}
    {section === 'history' && <section className="settings-section"><h2>{t("History")}</h2>
      <div className="setting-row"><div><label htmlFor="retention">{t("Keep clips for")}</label><p>{t("Favorites stay until you delete them.")}</p></div>
        <Select id="retention" label={t("Keep clips for")} value={retention === null ? 'forever' : String(retention)} onChange={value => void apply({ retentionDays: value === 'forever' ? null : Number(value) }, true)} options={[...retentionOptions, { value: 'forever', label: retentionLabel(null) }]} />
      </div>
      <div className="setting-row"><div><label htmlFor="keep-categorized">{t("Keep clips in categories")}</label><p id="keep-categorized-help">{t("Clips in a category are not deleted automatically.")}</p></div>
        <label className="setting-switch"><input id="keep-categorized" role="switch" type="checkbox" aria-describedby="keep-categorized-help" checked={settings.keepCategorized ?? false} onChange={event => void apply({ keepCategorized: event.target.checked }, true)} /><span aria-hidden="true">{settings.keepCategorized ? t("On") : t("Off")}</span></label>
      </div>
      <div className="setting-row"><div><label htmlFor="clean-before">{t("Delete clips created before")}</label><p>{keptText}</p></div>
        <div className="setting-actions"><input id="clean-before" type="date" max={todayValue} value={before} onChange={event => setBefore(event.target.value)} />
          <button className="subtle-button danger" disabled={!older.length} onClick={() => void cleanUp()}>{cutoff === null ? t("Delete") : older.length === 1 ? t("Delete 1 clip") : t("Delete {count} clips", { count: older.length })}</button></div>
      </div>
      <ProgramExclusions programs={settings.excludedPrograms ?? []} onChange={excludedPrograms => apply({ excludedPrograms })} />
      {desktop && <HistoryTransfer library={library} />}
    </section>}
    {error && <p className="inline-error" role="alert">{message(error)}</p>}
  </div>;
}
