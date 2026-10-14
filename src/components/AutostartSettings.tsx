import { t } from '../i18n';
import type { AutostartStatus } from '../services/runtime';
import { desktop } from '../services/runtime';
import Select from './Select';
export type StartMode = 'off' | 'tray' | 'library';
/** One choice for sign-in: not at all, quietly in the tray, or with the library open. */
export default function AutostartSettings({ status, minimized, busy, error, onChange, onRepair, onRetry }: { status: AutostartStatus | null; minimized: boolean; busy: boolean; error: string; onChange: (value: StartMode) => void; onRepair: () => void; onRetry: () => void }) {
  const value: StartMode = !status?.enabled ? 'off' : minimized ? 'tray' : 'library';
  return <>
    <div className="setting-row"><div><label htmlFor="start-mode">{t("Start with Windows")}</label>{(!desktop || (!status && !error)) && <p>{!desktop ? t("Available in the Windows app.") : t("Reading setting…")}</p>}</div>
      <Select id="start-mode" label={t("Start with Windows")} disabled={!desktop || !status || busy} value={value} onChange={next => onChange(next as StartMode)} options={[{ value: 'off', label: t("Off") }, { value: 'tray', label: t("In the system tray") }, { value: 'library', label: t("Open the library") }]} />
    </div>
    {status?.enabled && !status.currentExecutable && <div className="settings-inline-notice"><p>{t("Startup points to another version of Copyloom.")}</p><button className="text-button" disabled={busy} onClick={onRepair}>{t("Update startup")}</button></div>}
    {error && <div className="settings-inline-notice"><p className="inline-error" role="alert">{error}</p><button className="text-button" onClick={onRetry}>{t("Read again")}</button></div>}
  </>;
}
