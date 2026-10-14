import { useEffect, useId, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FolderOpen, X } from 'lucide-react';
import { t, message } from '../i18n';
import type { Library } from '../domain/library';
import { openDataFolder } from '../services/runtime';
import { useConfirmation } from './ConfirmDialog';
import StorageOverview from './StorageOverview';

function TransferDialog({ mode, path, count, onClose, onDone }: { mode: 'export' | 'restore'; path: string | null; count: number; onClose: () => void; onDone: (notice: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null), id = useId(), working = useRef(false);
  const [password, setPassword] = useState(''), [repeat, setRepeat] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  const restoring = mode === 'restore';
  function close() { if (working.current) return; setPassword(''); setRepeat(''); onClose(); }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (working.current) return;
    if ([...password].length < 10) { setError(t('Use at least 10 characters.')); return; }
    if (!restoring && password !== repeat) { setError(t('Passwords do not match.')); return; }
    working.current = true; setBusy(true); setError('');
    try {
      if (restoring) {
        const restored = await invoke<number>('restore_history', { path, password });
        setPassword(''); setRepeat(''); onDone(t('History restored ({count} clips).', { count: restored }));
      } else {
        const saved = await invoke<string | null>('export_history', { password });
        setPassword(''); setRepeat(''); if (saved) onDone(t('Export saved.')); else onClose();
      }
    } catch (cause) { setError(message(String(cause))); }
    finally { working.current = false; setBusy(false); }
  }
  return <dialog ref={dialog} className="clip-editor history-transfer-dialog" aria-labelledby={id + '-title'} onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => event.stopPropagation()}>
    <form onSubmit={event => void submit(event)}>
      <h2 id={id + '-title'}>{restoring ? t('Restore history') : t('Export history')}</h2>
      <p>{restoring ? t('The export replaces your {count} clips and categories. An encrypted copy of your current history is saved first.', { count }) : t('Choose a separate export password. You will need it to restore the file on this or another computer.')}</p>
      {path && <p className="transfer-file">{path.split(/[\\/]/).pop()}</p>}
      <label htmlFor={id + '-password'}>{t('Export password')}</label>
      <input autoFocus id={id + '-password'} type="password" autoComplete={restoring ? 'current-password' : 'new-password'} minLength={10} maxLength={512} required value={password} disabled={busy} onChange={event => setPassword(event.target.value)} />
      {!restoring && <><label htmlFor={id + '-repeat'}>{t('Repeat password')}</label><input id={id + '-repeat'} type="password" autoComplete="new-password" minLength={10} maxLength={512} required value={repeat} disabled={busy} onChange={event => setRepeat(event.target.value)} /><p className="field-help">{t('At least 10 characters. A forgotten export password cannot be recovered.')}</p></>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="form-actions"><button type="button" className="subtle-button" disabled={busy} onClick={close}>{t('Cancel')}</button><button className="primary-button" disabled={busy}>{busy ? t('Working…') : restoring ? t('Restore and replace') : t('Save export…')}</button></div>
    </form>
  </dialog>;
}

export default function HistoryTransfer({ library }: { library: Library }) {
  const { confirm, dialog } = useConfirmation();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [transfer, setTransfer] = useState<{ mode: 'export' | 'restore'; path: string | null } | null>(null);
  const [storageRefresh, setStorageRefresh] = useState(0);
  const available = library.storage === 'encrypted';
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(timer); }, [notice]);
  async function move() {
    setBusy(true); setError('');
    try {
      const path = await invoke<string | null>('choose_data_folder'); if (!path) return;
      if (!await confirm({ title: t('Change data folder?'), description: t('History and backups will move to {path}. Choose an empty folder.', { path }), confirmLabel: t('Move history'), destructive: false })) return;
      await invoke('move_data_folder', { path }); setStorageRefresh(value => value + 1); setNotice(t('Data folder changed.'));
    } catch (cause) { setError(message(String(cause))); }
    finally { setBusy(false); }
  }
  async function restore() {
    setBusy(true); setError('');
    try { const path = await invoke<string | null>('choose_export_file'); if (path) setTransfer({ mode: 'restore', path }); }
    catch (cause) { setError(message(String(cause))); }
    finally { setBusy(false); }
  }
  return <>
    {dialog}
    <div className="setting-row"><div><label>{t('Data folder')}</label><p className="storage-path">{available ? library.storagePath : t('Could not open history. Collection is paused.')}</p></div><div className="setting-actions">
      {library.storagePath && <button className="subtle-button" disabled={busy || !!transfer} onClick={() => void openDataFolder().catch(cause => setError(message(String(cause))))}><FolderOpen size={15} />{t('Open folder')}</button>}
      <button className="subtle-button" disabled={!available || busy || !!transfer} onClick={() => void move()}>{t('Change data folder…')}</button>
    </div></div>
    <StorageOverview library={library} refresh={storageRefresh} />
    <div className="setting-row"><div><label>{t('Export and restore')}</label><p>{t('An encrypted file with all clips, images and categories.')}</p></div><div className="setting-actions">
      <button className="subtle-button" disabled={!available || busy || !!transfer} onClick={() => { setError(''); setTransfer({ mode: 'export', path: null }); }}>{t('Export…')}</button>
      <button className="subtle-button" disabled={!available || busy || !!transfer} onClick={() => void restore()}>{t('Restore…')}</button>
    </div></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {notice && <div className="app-toast" role="status"><span>{notice}</span><button className="icon-button" aria-label={t('Dismiss message')} onClick={() => setNotice('')}><X size={15} /></button></div>}
    {transfer && <TransferDialog {...transfer} count={library.clips.length} onClose={() => setTransfer(null)} onDone={text => { setTransfer(null); setStorageRefresh(value => value + 1); setNotice(text); }} />}
  </>;
}
