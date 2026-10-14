import { t, getLanguage } from '../i18n';
import { Copy, MoreHorizontal, Pencil, Star } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import type { Category, Clip } from '../domain/library';
import { ClipContent, kindOf, typeLabel, type ClipHandlers } from './ClipCard';
import StoredImage from './StoredImage';

/** The whole clip with its main actions: the library's right-hand pane, and the Space preview elsewhere. */
export default function ClipPreview({ clip, categories, handlers, onEdit, actions }: {
  clip: Clip; categories: Category[]; handlers: ClipHandlers; onEdit?: (id: string) => void; actions?: ReactNode;
}) {
  const kind = kindOf(clip);
  const when = new Intl.DateTimeFormat(getLanguage(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(clip.createdAt);
  const memberships = categories.filter(category => clip.categoryIds.includes(category.id));
  return <section className={`clip-preview preview-${kind}`} aria-label={t('Preview of {title}', { title: clip.title })} data-clip-id={clip.id}>
    <header className="preview-header">
      <div className="preview-meta">
        {clip.sourceApp?.icon && <StoredImage className="preview-app" source={clip.sourceApp.icon} alt="" />}
        <span>{[typeLabel(clip), clip.sourceApp?.name, when].filter(Boolean).join(' · ')}</span>
      </div>
      <div className="preview-actions">
        {actions}
        {onEdit && <button className="subtle-button" onClick={() => onEdit(clip.id)}><Pencil size={15} />{t("Edit")}</button>}
        <button className="primary-button preview-copy" title={t("Copy (Enter)")} onClick={() => handlers.copy(clip.id, false)}><Copy size={15} />{t("Copy")}</button>
        <button className={'icon-button favorite' + (clip.favorite ? ' is-favorite' : '')} aria-label={clip.favorite ? t('Remove {title} from favorites', { title: clip.title }) : t('Favorite {title}', { title: clip.title })} aria-pressed={clip.favorite} onClick={() => handlers.favorite(clip.id)}><Star size={17} /></button>
        <button className="icon-button" aria-label={t("More actions")} title={t("More actions")} onClick={event => { const bounds = event.currentTarget.getBoundingClientRect(); handlers.menu(clip.id, bounds.right - 190, bounds.bottom + 4); }}><MoreHorizontal size={18} /></button>
      </div>
    </header>
    {(clip.customTitle || memberships.length > 0) && <div className="preview-labels">
      {clip.customTitle && <h2 className="preview-title">{clip.title}</h2>}
      {memberships.length > 0 && <span className="preview-categories">{memberships.map(category => <span key={category.id}><span className="category-dot" style={{ backgroundColor: category.color }} />{category.name}</span>)}</span>}
    </div>}
    <div className="preview-body"><ClipContent clip={clip} full /></div>
  </section>;
}

/** Space preview where there is no pane: the quick panel and a narrow library. Space or Escape closes it. */
export function PreviewDialog({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  // The dialog itself holds focus, so Space closes and Enter copies, as in the list behind it.
  useEffect(() => { dialog.current?.showModal(); dialog.current?.focus(); return () => dialog.current?.close(); }, []);
  return <dialog ref={dialog} className="preview-dialog" tabIndex={-1} onCancel={event => { event.preventDefault(); onClose(); }} onPointerDown={event => event.stopPropagation()} onKeyDown={event => {
    event.stopPropagation();
    if (event.target !== event.currentTarget) return;
    if (event.key === ' ') { event.preventDefault(); onClose(); }
    else if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.querySelector<HTMLButtonElement>('.preview-copy')?.click(); }
  }} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const r = event.currentTarget.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) onClose();
  }}>{children}</dialog>;
}
