import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
export type MenuItem = { label: string; onSelect: () => void; danger?: boolean };
/** A small right-click menu of plain actions; destructive ones sit below a separator. */
export default function ActionMenu({ x, y, label, items, onClose }: { x: number; y: number; label: string; items: MenuItem[]; onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  const [position, setPosition] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const r = menu.current!.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(x, innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, innerHeight - r.height - 8)) });
    menu.current?.querySelector('button')?.focus({ preventScroll: true });
  }, [x, y]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) close.current(); };
    const dismiss = () => close.current();
    document.addEventListener('pointerdown', outside, true); window.addEventListener('blur', dismiss); window.addEventListener('resize', dismiss); window.addEventListener('scroll', dismiss, true);
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('blur', dismiss); window.removeEventListener('resize', dismiss); window.removeEventListener('scroll', dismiss, true); };
  }, []);
  return createPortal(<div ref={menu} className="clip-context-menu" role="menu" aria-label={label} style={position} onKeyDown={event => {
    event.stopPropagation();
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); onClose(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')], index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }
  }}>
    {items.map((item, index) => <Fragment key={item.label}>
      {item.danger && index > 0 && !items[index - 1].danger && <div role="separator" />}
      <button role="menuitem" className={item.danger ? 'danger' : undefined} onClick={() => { onClose(); item.onSelect(); }}>{item.label}</button>
    </Fragment>)}
  </div>, document.body);
}
