import { useEffect, useId, useRef, useState } from 'react';
import { message, t } from '../i18n';
import type { Clip } from '../domain/library';

/** Edits a text clip in place. Ctrl+Enter saves, Escape cancels; formatting is dropped once the text changes. */
export default function EditTextDialog({ clip, onSave, onClose }: { clip: Clip; onSave: (content: string) => Promise<void>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), field = useRef<HTMLTextAreaElement>(null), id = useId();
  const [text, setText] = useState(clip.content), [saving, setSaving] = useState(false), [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); field.current?.focus(); field.current?.setSelectionRange(0, 0); return () => dialog.current?.close(); }, []);
  const changed = text !== clip.content && !!text.trim();
  async function save() {
    if (saving || !changed) return;
    setSaving(true); setError('');
    try { await onSave(text); onClose(); }
    catch (cause) { setError(message(String(cause))); setSaving(false); }
  }
  return <dialog ref={dialog} className="clip-editor edit-text" aria-labelledby={id + '-heading'} onPointerDown={event => event.stopPropagation()} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save(); } }} onCancel={event => { event.preventDefault(); if (!saving) onClose(); }}>
    <div className="editor-heading"><h2 id={id + '-heading'}>{t("Edit text")}</h2></div>
    <form autoComplete="off" onSubmit={event => { event.preventDefault(); void save(); }}>
      <textarea ref={field} aria-labelledby={id + '-heading'} value={text} disabled={saving} spellCheck={false} onChange={event => setText(event.target.value)} />
      {clip.html && <p className="field-help">{t("Formatting is removed when the text changes.")}</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="form-actions"><button type="button" className="subtle-button" disabled={saving} onClick={onClose}>{t("Cancel")}</button><button className="primary-button" type="submit" title="Ctrl+Enter" disabled={saving || !changed}>{saving ? t("Saving…") : t("Save")}</button></div>
    </form>
  </dialog>;
}
