import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X } from 'lucide-react';
import { t, message } from '../i18n';
import { desktop } from '../services/runtime';

export default function ProgramExclusions({ programs, onChange }: { programs: string[]; onChange: (programs: string[]) => Promise<boolean> }) {
  const [name, setName] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function change(next: string[]) { setBusy(true); setError(''); try { return await onChange(next); } catch (cause) { setError(message(String(cause))); return false; } finally { setBusy(false); } }
  async function add(value: string) {
    const candidate = value.trim().toLowerCase();
    if (!candidate) return;
    if (programs.some(program => program.toLowerCase() === candidate)) { setName(''); return; }
    if (await change([...programs, candidate])) setName('');
  }
  async function choose() {
    setBusy(true); setError('');
    try { const program = await invoke<string | null>('choose_excluded_program'); if (program) await add(program); }
    catch (cause) { setError(message(String(cause))); }
    finally { setBusy(false); }
  }
  return <div className="setting-row program-exclusions"><div><label htmlFor="excluded-program">{t('Excluded programs')}</label><p>{t('Copies from these programs are not saved in history.')}</p>
    <form className="program-entry" onSubmit={event => { event.preventDefault(); void add(name); }}><input id="excluded-program" value={name} maxLength={260} placeholder="KeePass.exe" disabled={busy} onChange={event => setName(event.target.value)} /><button className="subtle-button" disabled={busy || !name.trim()}>{t('Add')}</button>{desktop && <button type="button" className="text-button" disabled={busy} onClick={() => void choose()}>{t('Choose program…')}</button>}</form>
    {programs.length > 0 && <ul className="excluded-program-list">{programs.map(program => <li key={program}><span>{program}</span><button type="button" className="icon-button" aria-label={t('Remove the exclusion for {program}', { program })} disabled={busy} onClick={() => void change(programs.filter(p => p !== program))}><X size={15} /></button></li>)}</ul>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div></div>;
}
