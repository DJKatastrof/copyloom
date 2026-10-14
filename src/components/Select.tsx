import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

type Option = { value: string; label: string };
export default function Select({ id, label, value, options, onChange, disabled = false }: { id?: string; label: string; value: string; options: Option[]; onChange: (value: string) => void; disabled?: boolean }) {
  const unique = useId();
  const menuId = unique + '-options';
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [above, setAbove] = useState(false);
  const [active, setActive] = useState(0);
  const selected = options.findIndex(option => option.value === value);
  function close() { setOpen(false); trigger.current?.focus({ preventScroll: true }); }
  function choose(index: number) { if (disabled) return; const option = options[index]; if (option) onChange(option.value); close(); }
  function show() { if (disabled) return; setActive(Math.max(0, selected)); setOpen(true); }
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    const rect = trigger.current!.getBoundingClientRect();
    const height = Math.min(menu.current!.scrollHeight, 240);
    setAbove(rect.bottom + height + 12 > window.innerHeight && rect.top > window.innerHeight - rect.bottom);
    menu.current?.querySelectorAll<HTMLButtonElement>('[role="option"]')[active]?.focus({ preventScroll: true });
  }, [open, active]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const blur = () => setOpen(false);
    // Intentional scrolling outside closes the list; focus/layout scrolling must
    // not dismiss a list the user has just opened near the viewport edge.
    const scroll = (event: Event) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', blur);
    window.addEventListener('wheel', scroll, { capture: true, passive: true });
    window.addEventListener('touchmove', scroll, { capture: true, passive: true });
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('blur', blur); window.removeEventListener('wheel', scroll, true); window.removeEventListener('touchmove', scroll, true); };
  }, [open]);
  return <div ref={root} className="select-control" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }} onKeyDown={event => {
    if (open) event.stopPropagation();
    if (open && event.key === 'Tab') { setOpen(false); trigger.current?.focus({ preventScroll: true }); return; }
    if (event.key === 'Escape' && open) { event.preventDefault(); close(); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      if (!open) { show(); return; }
      setActive(index => event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
    } else if (open && ['Enter', ' '].includes(event.key)) { event.preventDefault(); choose(active); }
  }}>
    <button id={id} ref={trigger} className="select-trigger" type="button" role="combobox" disabled={disabled} aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={menuId} onClick={() => open ? close() : show()}><span>{options[selected]?.label ?? value}</span><ChevronDown size={15} /></button>
    {open && <div ref={menu} id={menuId} className={'select-menu' + (above ? ' above' : '')} role="listbox" aria-label={label}>{options.map((option, index) => <button key={option.value} type="button" role="option" aria-selected={option.value === value} tabIndex={-1} onPointerMove={() => setActive(index)} onClick={() => choose(index)}><span>{option.label}</span>{option.value === value && <Check size={15} />}</button>)}</div>}
  </div>;
}
