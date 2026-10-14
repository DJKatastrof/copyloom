import { t } from '../i18n';
import { useEffect, useId, useRef, useState } from 'react';
export type Confirmation = { title: string; description: string; confirmLabel?: string; destructive?: boolean };
export default function ConfirmDialog({ title, description, confirmLabel = t("Delete"), destructive = true, onConfirm, onClose }: Confirmation & { onConfirm: () => Promise<boolean>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), id = useId();
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return <dialog ref={dialog} className="clip-editor delete-confirmation" aria-labelledby={id + '-title'} aria-describedby={id + '-description'} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onKeyDown={event => event.stopPropagation()} onClick={event => {
    if (busy || event.target !== event.currentTarget) return;
    const r = event.currentTarget.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) onClose();
  }}>
    <h2 id={id + '-title'}>{title}</h2><p id={id + '-description'}>{description}</p>
    {failed && <p className="inline-error" role="alert">{t("The action failed. Try again.")}</p>}
    <div className="form-actions"><button autoFocus className="subtle-button" disabled={busy} onClick={onClose}>{t("Cancel")}</button><button className={'primary-button' + (destructive ? ' delete-button' : '')} disabled={busy} onClick={async () => {
      setBusy(true); setFailed(false);
      try { if (await onConfirm()) { onClose(); return; } setFailed(true); } catch { setFailed(true); }
      setBusy(false);
    }}>{busy ? t("Working…") : confirmLabel}</button></div>
  </dialog>;
}
export function useConfirmation() {
  const [request, setRequest] = useState<Confirmation | null>(null);
  const resolve = useRef<((accepted: boolean) => void) | null>(null);
  useEffect(() => () => { resolve.current?.(false); resolve.current = null; }, []);
  function finish(value: boolean) { resolve.current?.(value); resolve.current = null; setRequest(null); }
  function confirm(next: Confirmation): Promise<boolean> {
    if (resolve.current) return Promise.resolve(false);
    return new Promise(accept => { resolve.current = accept; setRequest(next); });
  }
  return { confirm, dialog: request && <ConfirmDialog {...request} onClose={() => finish(false)} onConfirm={async () => { finish(true); return true; }} /> };
}
