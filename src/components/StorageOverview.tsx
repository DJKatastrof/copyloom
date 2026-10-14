import { useEffect, useId, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { RefreshCw } from 'lucide-react';
import type { Library } from '../domain/library';
import { getLanguage, message, t } from '../i18n';

type Usage = { clipCount: number; imageCount: number; imageBytes: number; databaseBytes: number; backupCount: number; backupBytes: number; otherBytes: number };
function bytes(value: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unit = value > 0 ? Math.min(units.length - 1, Math.floor(Math.log10(value) / 3)) : 0;
  return new Intl.NumberFormat(getLanguage(), { maximumFractionDigits: unit ? 1 : 0 }).format(value / 1000 ** unit) + ' ' + units[unit];
}
const count = (value: number) => new Intl.NumberFormat(getLanguage()).format(value);

export default function StorageOverview({ library, refresh }: { library: Library; refresh: number }) {
  const id = useId(), [retry, setRetry] = useState(0), [pending, setPending] = useState(true), [error, setError] = useState('');
  const [snapshot, setSnapshot] = useState<{ path: Library['storagePath']; usage: Usage } | null>(null);
  const available = library.storage === 'encrypted';
  useEffect(() => {
    if (!available) { setSnapshot(null); setPending(false); return; }
    setPending(true);
    let active = true, reading = false;
    async function read() {
      if (!active || reading || document.hidden) return;
      reading = true; setPending(true); setError('');
      try {
        const usage = await invoke<Usage>('get_storage_usage');
        if (active) setSnapshot({ path: library.storagePath, usage });
      } catch (cause) { if (active) { setSnapshot(null); setError(String(cause)); } }
      finally { reading = false; if (active) setPending(false); }
    }
    const scheduled = window.setTimeout(() => void read(), 200);
    const periodic = window.setInterval(() => void read(), 30_000);
    const focus = () => void read();
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    return () => { active = false; window.clearTimeout(scheduled); window.clearInterval(periodic); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [available, library.storagePath, library.revision, refresh, retry]);
  if (!available) return null;
  const usage = snapshot?.path === library.storagePath ? snapshot?.usage : null;
  return <section className="setting-row storage-overview" aria-labelledby={id} aria-busy={pending}>
    <div className="storage-overview-heading"><h3 id={id}>{t('Storage overview')}</h3><button className="icon-button" title={error ? t('Try again') : t('Refresh storage overview')} aria-label={error ? t('Try again') : t('Refresh storage overview')} disabled={pending} onClick={() => setRetry(value => value + 1)}><RefreshCw size={15} /></button></div>
    {error ? <p className="inline-error" role="alert">{message(error)}</p> : usage ? <>
      <dl className="storage-usage">
        <div><dt>{t('Clips')}</dt><dd>{count(usage.clipCount)}</dd></div>
        <div><dt>{t('Images')}</dt><dd>{count(usage.imageCount)} · {bytes(usage.imageBytes)}</dd></div>
        <div><dt title={t("Includes the database's working files.")}>{t('Database')}</dt><dd>{bytes(usage.databaseBytes)}</dd></div>
        <div><dt>{t('Backups')}</dt><dd>{count(usage.backupCount)} · {bytes(usage.backupBytes)}</dd></div>
        {usage.otherBytes > 0 && <div><dt title={t('Database key and any files retained during database recovery.')}>{t('Other history files')}</dt><dd>{bytes(usage.otherBytes)}</dd></div>}
        <div className="storage-usage-total"><dt>{t('Total on disk')}</dt><dd>{bytes(usage.databaseBytes + usage.backupBytes + usage.otherBytes)}</dd></div>
      </dl>
      <p>{t('Images are included in the database.')}</p>
    </> : <p role="status">{t('Reading storage usage…')}</p>}
  </section>;
}
