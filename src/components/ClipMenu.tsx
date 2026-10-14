import { t } from '../i18n';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight } from 'lucide-react';
import type { Category, Clip } from '../domain/library';

type Props = { categories: Category[]; categoryIds: string[]; hasPins: boolean; onUnpin: () => void; onCategory: (id: string, assigned: boolean) => void; clip: Clip; x: number; y: number; onClose: () => void; onCopy: () => void; onRename: () => void; onFavorite: () => void; onDelete: () => void; onEdit?: () => void; onCopyText?: () => void; onPreview?: () => void; onSaveAs?: () => void; onCopyJoined?: () => void; favoriteLabel?: string; deleteLabel?: string };

export default function ClipMenu({ categories, categoryIds, hasPins, onUnpin, onCategory, clip, x, y, onClose, onCopy, onRename, onFavorite, onDelete, onEdit, onCopyText, onPreview, onSaveAs, onCopyJoined, favoriteLabel, deleteLabel }: Props) {
  const [pinOpen, setPinOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const submenu = useRef<HTMLDivElement>(null);
  const pin = useRef<HTMLButtonElement>(null);
  const focusPinItems = useRef(false);
  const origin = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const [position, setPosition] = useState({ left: x, top: y });
  const [pinPosition, setPinPosition] = useState({ left: x, top: y });
  const close = useRef(onClose); close.current = onClose;
  function dismiss(restoreFocus = true) {
    close.current();
    if (restoreFocus && origin.current?.isConnected) origin.current.focus({ preventScroll: true });
  }
  function openPin(keyboard = false) { if (pinOpen && keyboard) submenu.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true }); else { focusPinItems.current = keyboard; setPinOpen(true); } }
  useLayoutEffect(() => {
    const bounds = menu.current!.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(x, innerWidth - bounds.width - 8)), top: Math.max(8, Math.min(y, innerHeight - bounds.height - 8)) });
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [x, y]);
  useLayoutEffect(() => {
    if (!pinOpen || !submenu.current || !pin.current) return;
    const root = menu.current!.getBoundingClientRect(), row = pin.current.getBoundingClientRect(), sub = submenu.current.getBoundingClientRect();
    const left = root.right + 4 + sub.width <= innerWidth - 8 ? root.right + 4 : Math.max(8, root.left - sub.width - 4);
    setPinPosition({ left, top: Math.max(8, Math.min(row.top, innerHeight - sub.height - 8)) });
    if (focusPinItems.current) { submenu.current.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true }); focusPinItems.current = false; }
  }, [pinOpen, position]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) dismiss(false); };
    const scroll = (event: Event) => { if (!menu.current?.contains(event.target as Node)) dismiss(false); };
    const blur = () => dismiss(false);
    // Close on intentional outside scrolling, not a queued focus/layout scroll
    // from the card that has just opened this menu.
    document.addEventListener('pointerdown', outside, true); window.addEventListener('wheel', scroll, { capture: true, passive: true }); window.addEventListener('touchmove', scroll, { capture: true, passive: true }); window.addEventListener('resize', blur); window.addEventListener('blur', blur);
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('wheel', scroll, true); window.removeEventListener('touchmove', scroll, true); window.removeEventListener('resize', blur); window.removeEventListener('blur', blur); };
  }, []);
  const run = (action: () => void) => { dismiss(); action(); };
  return createPortal(<div ref={menu} className="clip-context-menu" role="menu" aria-label={t("Actions for ") + clip.title} style={position}
    onPointerDown={event => event.stopPropagation()} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
    onKeyDown={event => {
      event.stopPropagation();
      if ((event.key === 'Delete' || event.key === 'Backspace') && !event.ctrlKey && !event.altKey && !event.metaKey) { event.preventDefault(); if (!event.repeat) run(onDelete); return; }
      if ((event.key === 'Escape' || event.key === 'ArrowLeft') && pinOpen) { event.preventDefault(); setPinOpen(false); pin.current?.focus(); return; }
      if (event.key === 'ArrowRight' && document.activeElement === pin.current) { event.preventDefault(); openPin(true); return; }
      if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); dismiss(); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const container = submenu.current?.contains(document.activeElement) ? submenu.current : menu.current!;
      const items = Array.from(container.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')).filter(item => !item.disabled && (container === submenu.current || !submenu.current?.contains(item)));
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }}>
    <button role="menuitem" onMouseEnter={() => setPinOpen(false)} onClick={() => run(onCopy)}>{t("Copy")}</button>
    {onPreview && <button role="menuitem" onMouseEnter={() => setPinOpen(false)} onClick={() => run(onPreview)}>{t("Preview")}</button>}
    {onCopyJoined && <button role="menuitem" onMouseEnter={() => setPinOpen(false)} onClick={() => run(onCopyJoined)}>{t("Copy selected together")}</button>}
    {clip.kind === 'image' && onCopyText && <button role="menuitem" onMouseEnter={() => setPinOpen(false)} onClick={() => run(onCopyText)}>{t("Copy text from image")}</button>}
    {onEdit && <button role="menuitem" onMouseEnter={() => setPinOpen(false)} onClick={() => run(onEdit)}>{t("Edit")}</button>}
    {clip.kind === 'image' && onSaveAs && <button role="menuitem" onMouseEnter={() => setPinOpen(false)} onClick={() => run(onSaveAs)}>{t("Save as…")}</button>}
    <button role="menuitem" onMouseEnter={() => setPinOpen(false)} onClick={() => run(onRename)}>{t("Rename")}</button>
    <button role="menuitem" onMouseEnter={() => setPinOpen(false)} onClick={() => run(onFavorite)}>{favoriteLabel ?? (clip.favorite ? t("Remove from favorites") : t("Add to favorites"))}</button>
    {categories.length > 0 && <button ref={pin} role="menuitem" aria-haspopup="menu" aria-expanded={pinOpen} onMouseEnter={() => openPin()} onClick={() => openPin(true)}><span>{t("Add to category")}</span><ChevronRight size={14} className="menu-trailing" /></button>}
    <div role="separator" />
    <button role="menuitem" className="danger" onMouseEnter={() => setPinOpen(false)} onClick={() => run(onDelete)}>{deleteLabel ?? t("Delete clip")}</button>
    {pinOpen && <div ref={submenu} className="clip-pin-menu" role="menu" aria-label={t("Categories")} style={pinPosition}>
      {categories.map(category => <button key={category.id} role="menuitemcheckbox" aria-checked={categoryIds.includes(category.id)} onClick={() => run(() => onCategory(category.id, true))}><span className="pin-check">{categoryIds.includes(category.id) && <Check size={14} />}</span><span className="category-dot" style={{ backgroundColor: category.color }} /><span>{category.name}</span></button>)}
      {hasPins && <><div role="separator" /><button role="menuitem" onClick={() => run(onUnpin)}>{t("Remove from categories")}</button></>}
    </div>}
  </div>, document.body);
}
