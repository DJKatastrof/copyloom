import { useEffect, useRef } from 'react';
import { ArrowLeft } from 'lucide-react';
import { t, getLanguage } from '../i18n';
import type { Clip } from '../domain/library';
import { ClipContent, kindOf, typeLabel } from './ClipCard';

/** The whole clip inside the quick panel, in place of the list. Back, the mouse's back button,
 * Space and Escape return to the list; Up/Down show the previous or next clip; Enter uses it
 * (Shift+Enter as plain text). */
export default function PanelPreview({ clip, onClose, onMove, onUse }: {
  clip: Clip; onClose: () => void; onMove: (step: 1 | -1) => void; onUse: (plain: boolean) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { root.current?.focus({ preventScroll: true }); }, [clip.id]);
  const when = new Intl.DateTimeFormat(getLanguage(), { dateStyle: 'medium', timeStyle: 'short' }).format(clip.createdAt);
  return <div ref={root} className={`panel-preview preview-${kindOf(clip)}`} role="dialog" aria-modal="true" aria-label={t('Preview {title}', { title: clip.title })} tabIndex={-1}
    onMouseUp={event => { if (event.button === 3) { event.preventDefault(); onClose(); } }}
    onKeyDown={event => {
      if (event.key === 'Escape' || (event.key === ' ' && !event.ctrlKey && !event.altKey)) { event.preventDefault(); event.stopPropagation(); onClose(); }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); onMove(event.key === 'ArrowDown' ? 1 : -1); }
      else if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); onUse(event.shiftKey); }
    }}>
    <header className="panel-preview-head">
      <button className="text-button panel-preview-back" title={t("Back to the list (Space)")} onClick={onClose}><ArrowLeft size={16} />{t("Back")}</button>
      <span>{clip.customTitle ? clip.title + ' · ' : ''}{typeLabel(clip)}{clip.sourceApp ? ' · ' + clip.sourceApp.name : ''} · {when}</span>
    </header>
    <div className="preview-body panel-preview-body"><ClipContent clip={clip} full /></div>
  </div>;
}
