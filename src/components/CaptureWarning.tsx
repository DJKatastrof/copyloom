import { t, message } from '../i18n';
import { useEffect, useState } from 'react';
import { AlertCircle, ExternalLink } from 'lucide-react';
import { desktop, getCaptureEnvironment, retryCaptureShortcut, openKeyboardSettings } from '../services/runtime';
import type { CaptureEnvironment } from '../services/runtime';

export default function CaptureWarning({ selected, saved, recording, onBlocked }: { selected: string | null; saved: string | null; recording: boolean; onBlocked: (blocked: boolean) => void }) {
  const [status, setStatus] = useState<CaptureEnvironment | null>(null), [error, setError] = useState(''), [checking, setChecking] = useState(false);
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    const read = () => { void getCaptureEnvironment().then(value => { if (active) { setStatus(value); onBlocked(value.printScreenEnabled === true); } }).catch(() => { if (active) { setStatus(null); onBlocked(false); } }); };
    read(); window.addEventListener('focus', read);
    return () => { active = false; window.removeEventListener('focus', read); };
  }, [saved, recording, onBlocked]);
  if (!desktop || (selected !== 'PrintScreen' && !status?.printScreenEnabled)) return null;
  return <div className={'settings-notice' + (status?.printScreenEnabled ? ' warning' : '')}><AlertCircle size={18} aria-hidden="true" /><div>
    <p className="notice-title" role={status?.printScreenEnabled ? 'alert' : 'status'}>{status?.printScreenEnabled ? t("Windows is using Print Screen") : status?.printScreenEnabled === false ? t("Windows’ Print Screen shortcut is off") : t("Check Print Screen in Windows")}</p>
    {status?.printScreenEnabled !== false ? <p>{t("Open Accessibility → Keyboard in Windows. Turn off “Use the Print screen key to open screen capture” to use the key in Copyloom. You can also choose another key above.")}</p> : <p>{status.registered && selected === saved ? t("Copyloom uses Print Screen.") : t("Select Check again to use Print Screen in Copyloom.")}</p>}
    <div className="notice-actions"><button className="subtle-button" onClick={() => { void openKeyboardSettings().catch(cause => setError(String(cause))); }}><ExternalLink size={14} />{t("Open Windows settings")}</button><button className="text-button" disabled={checking || recording} onClick={async () => {
      setChecking(true); setError('');
      try { const value = selected === saved ? await retryCaptureShortcut() : await getCaptureEnvironment(); setStatus(value); onBlocked(value.printScreenEnabled === true); }
      catch (cause) { setError(String(cause)); }
      finally { setChecking(false); }
    }}>{checking ? t("Checking…") : t("Check again")}</button></div>
    {error && <p className="inline-error" role="alert">{message(error)}</p>}
  </div></div>;
}
