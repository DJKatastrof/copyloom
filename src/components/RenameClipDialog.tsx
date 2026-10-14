import { useEffect, useId, useRef, useState } from 'react';
import { message, t } from '../i18n';
import type { Clip } from '../domain/library';

/** A one-field naming dialog: Enter saves, Escape cancels. */
export function NameDialog({ heading, initial, maxLength, help, onSave, onClose }: { heading: string; initial: string; maxLength: number; help?: string; onSave: (name: string) => Promise<void>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null), id = useId();
  const [name, setName] = useState(initial), [saving, setSaving] = useState(false), [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); input.current?.select(); return () => dialog.current?.close(); }, []);
  return <dialog ref={dialog} className="clip-editor rename-clip" aria-labelledby={id + '-heading'} onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onCancel={event => { event.preventDefault(); if (!saving) onClose(); }}>
    <div className="editor-heading"><h2 id={id + '-heading'}>{heading}</h2></div>
    <form autoComplete="off" onSubmit={async event => {
      event.preventDefault(); if (saving || !name.trim()) return;
      setSaving(true); setError('');
      try { await onSave(name.trim()); onClose(); }
      catch (cause) { setError(message(String(cause))); setSaving(false); }
    }}>
      <label htmlFor={id + '-name'}>{t("Name")}</label>
      <input ref={input} id={id + '-name'} autoFocus autoComplete="off" value={name} maxLength={maxLength} disabled={saving} aria-describedby={help ? id + '-help' : undefined} onChange={event => setName(event.target.value)} />
      {help && <p id={id + '-help'} className="field-help">{help}</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="form-actions"><button type="button" className="subtle-button" disabled={saving} onClick={onClose}>{t("Cancel")}</button><button className="primary-button" type="submit" disabled={saving || !name.trim()}>{saving ? t("Saving…") : t("Save")}</button></div>
    </form>
  </dialog>;
}

export default function RenameClipDialog({ clip, onSave, onClose }: { clip: Clip; onSave: (title: string) => Promise<void>; onClose: () => void }) {
  return <NameDialog heading={t("Rename clip")} initial={clip.title} maxLength={120} help={t("Only the name changes. The copied content stays the same.")} onSave={onSave} onClose={onClose} />;
}
