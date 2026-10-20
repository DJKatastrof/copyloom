import { t, getLanguage } from '../i18n';
import { memo, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { ChevronDown, Code2, Image as ImageIcon, Link2, Star, Type } from 'lucide-react';
import type { Category, Clip } from '../domain/library';
import { kindOf, typeLabel, type ClipHandlers } from './ClipCard';
import StoredImage from './StoredImage';

export type ListEntry = { type: 'day'; key: string; label: string; count: number; collapsed: boolean } | { type: 'clip'; clip: Clip; index: number };
export type ListHandle = { scrollToIndex: (index: number) => void };
// The quick panel gives every clip one row height: 48 px, room for two lines of text or a 40 px thumbnail.
// The library keeps 40 px rows with one line.
const ROW = 40, PANEL_ROW = 48, DAY = 34, OVERSCAN = 400;
const entryHeight = (entry: ListEntry, panel: boolean) => entry.type === 'day' ? DAY : panel ? PANEL_ROW : ROW;

function startOfDay(timestamp: number) { const date = new Date(timestamp); date.setHours(0, 0, 0, 0); return date.getTime(); }
/** The heading a clip falls under: its local calendar day. */
export const dayKey = (timestamp: number) => 'day-' + startOfDay(timestamp);
export function dayLabel(timestamp: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(timestamp)) / 86_400_000);
  if (days <= 0) return t("Today");
  if (days === 1) return t("Yesterday");
  const date = new Date(timestamp), language = getLanguage();
  const label = days < 7 ? new Intl.DateTimeFormat(language, { weekday: 'long' }).format(date)
    : new Intl.DateTimeFormat(language, { day: 'numeric', month: 'long', ...(date.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}) }).format(date);
  return label.charAt(0).toLocaleUpperCase(language) + label.slice(1);
}
/** Day headings only where the order is by time; search results and manual order are one run.
 * `shown` is the clips outside folded days, in list order; keyboard navigation and Ctrl+1…9 use it. */
export function listEntries(clips: Clip[], grouped: boolean, collapsed: (key: string) => boolean = () => false, now = Date.now()): { entries: ListEntry[]; shown: Clip[] } {
  const entries: ListEntry[] = [], shown: Clip[] = [];
  let heading = null as Extract<ListEntry, { type: 'day' }> | null;
  for (const clip of clips) {
    if (grouped) {
      const key = dayKey(clip.createdAt);
      if (heading?.key !== key) { heading = { type: 'day', key, label: dayLabel(clip.createdAt, now), count: 0, collapsed: collapsed(key) }; entries.push(heading); }
      heading.count++;
      if (heading.collapsed) continue;
    }
    entries.push({ type: 'clip', clip, index: shown.length }); shown.push(clip);
  }
  return { entries, shown };
}
function rowTime(timestamp: number, grouped: boolean): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return t("Just now");
  if (minutes < 60) return t('{count} min', { count: minutes });
  return new Intl.DateTimeFormat(getLanguage(), grouped ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short' }).format(timestamp);
}

const TYPE_ICONS = { text: Type, link: Link2, code: Code2 } as const;
export const ClipRow = memo(function ClipRow({ clip, active, checked, quickKey, grouped, categories, handlers, pictures = false }: {
  // Not read here: a new language or minute re-renders the memoized row so its time and labels follow.
  clip: Clip; active: boolean; checked: boolean; quickKey?: number; grouped: boolean; categories: Category[]; handlers: ClipHandlers; pictures?: boolean; language?: string; minute?: number;
}) {
  const kind = kindOf(clip);
  const Icon = TYPE_ICONS[kind as keyof typeof TYPE_ICONS] ?? Type;
  const picture = pictures && clip.kind === 'image', lines = pictures && (clip.kind === 'text' || clip.kind === 'code') && !clip.customTitle;
  const lead = picture ? clip.sourceApp?.icon ? <StoredImage className="row-app" source={clip.sourceApp.icon} alt="" title={clip.sourceApp.name} /> : <ImageIcon size={16} />
    : clip.kind === 'image' ? <StoredImage className="row-thumb" source={clip.content} alt="" />
    : clip.kind === 'color' ? <span className="row-swatch" style={{ backgroundColor: clip.content.trim() }} />
    : clip.sourceApp?.icon ? <StoredImage className="row-app" source={clip.sourceApp.icon} alt="" title={clip.sourceApp.name} />
    : <Icon size={16} />;
  // One line of the content itself, so a clip opening with "{" or a blank line still says what it is.
  // In the panel, text keeps its line breaks (without blank lines) for its two lines.
  const text = clip.customTitle ? clip.title : picture ? '' : lines ? clip.content.slice(0, 300).replace(/^\s*\n/, '').replace(/\n\s*\n+/g, '\n').trimEnd() : clip.kind === 'image' ? typeLabel(clip) : clip.kind === 'link' ? clip.content.trim().replace(/^https?:\/\//, '') : clip.content.slice(0, 240).replace(/\s+/g, ' ').trim();
  const dots = categories.filter(category => clip.categoryIds.includes(category.id)).slice(0, 3);
  return <button className={`clip-row row-${kind}${pictures ? ' panel-row' : ''}${lines ? ' row-lines' : ''}${active ? ' active' : ''}${checked ? ' checked' : ''}`} data-clip-id={clip.id} aria-label={t('Show {title}', { title: clip.title })} aria-pressed={active || checked}
    onClick={event => handlers.select(clip.id, event)} onDoubleClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey) handlers.copy(clip.id, false); }}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); const bounds = event.currentTarget.getBoundingClientRect(); handlers.menu(clip.id, event.clientX || bounds.left + 16, event.clientY || bounds.bottom); }}
    onKeyDown={event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); event.stopPropagation(); const bounds = event.currentTarget.getBoundingClientRect(); handlers.menu(clip.id, bounds.left + 16, bounds.bottom); } }}
    draggable onDragStart={event => { event.dataTransfer.setData('text/clip-id', clip.id); event.dataTransfer.setData('application/x-copyloom-clips', JSON.stringify(handlers.dragIds(clip.id))); event.dataTransfer.effectAllowed = 'copyMove'; }}
    onDragEnd={handlers.dragEnd} onDragOver={event => { if (handlers.canReorder()) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }}
    onDrop={event => { event.preventDefault(); const id = event.dataTransfer.getData('text/clip-id'); if (id && handlers.canReorder()) handlers.reorder(id, clip.id); }}>
    <span className="row-lead" aria-hidden="true">{lead}</span>
    {picture && <StoredImage className="row-picture" source={clip.content} alt="" />}
    {(!picture || text) && <span className="row-text">{text}</span>}
    <span className="row-meta">
      {dots.map(category => <span key={category.id} className="category-dot" style={{ backgroundColor: category.color }} title={category.name} />)}
      {clip.favorite && <Star size={13} className="row-star" aria-hidden="true" />}
      {quickKey ? <kbd className="quick-key" aria-hidden="true">{quickKey}</kbd> : <time dateTime={new Date(clip.createdAt).toISOString()}>{rowTime(clip.createdAt, grouped)}</time>}
    </span>
  </button>;
});

/** One column of fixed-height rows and day headings; only what is on screen is mounted. */
export default function ClipList({ entries, resetKey, handleRef, renderRow, empty, onToggleDay, onDayMenu, pictures = false }: {
  entries: ListEntry[]; resetKey: string; handleRef: RefObject<ListHandle | null>; pictures?: boolean;
  renderRow: (clip: Clip, index: number) => ReactNode; empty: ReactNode; onToggleDay: (key: string) => void;
  onDayMenu?: (day: Extract<ListEntry, { type: 'day' }>, x: number, y: number) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  // Which entries are mounted, and the day heading pinned at the top (-1: none). Only these are state,
  // so scrolling re-renders the list when a row enters or leaves, not on every frame.
  const [range, setRange] = useState({ start: 0, end: 40, sticky: -1 });
  const layout = useMemo(() => {
    const tops: number[] = [], rows: number[] = []; let y = 0;
    entries.forEach((entry, position) => { tops.push(y); if (entry.type === 'clip') rows[entry.index] = position; y += entryHeight(entry, pictures); });
    return { tops, rows, height: y };
  }, [entries, pictures]);
  const measure = useRef(() => {});
  measure.current = () => {
    const element = scroller.current; if (!element) return;
    const top = element.scrollTop, bottom = top + element.clientHeight;
    // First entry whose bottom edge is below the overscanned top.
    let low = 0, high = layout.tops.length;
    while (low < high) { const middle = (low + high) >> 1; if (layout.tops[middle] + entryHeight(entries[middle], pictures) < top - OVERSCAN) low = middle + 1; else high = middle; }
    let end = low;
    while (end < layout.tops.length && layout.tops[end] < bottom + OVERSCAN) end++;
    // The heading of the day at the top edge stays in view while its rows scroll past.
    let sticky = -1;
    if (top > 0) {
      let position = 0;
      for (let first = 0, last = layout.tops.length - 1; first <= last;) { const middle = (first + last) >> 1; if (layout.tops[middle] <= top) { position = middle; first = middle + 1; } else last = middle - 1; }
      for (; position >= 0; position--) if (entries[position]?.type === 'day') { sticky = position; break; }
    }
    setRange(old => old.start === low && old.end === end && old.sticky === sticky ? old : { start: low, end, sticky });
  };
  useLayoutEffect(() => {
    const element = scroller.current; if (!element) return;
    let frame = 0;
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => measure.current()); };
    element.addEventListener('scroll', schedule, { passive: true });
    const observer = new ResizeObserver(schedule); observer.observe(element);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); element.removeEventListener('scroll', schedule); };
  }, []);
  useLayoutEffect(() => { measure.current(); }, [layout]);
  useLayoutEffect(() => { if (scroller.current) scroller.current.scrollTop = 0; measure.current(); }, [resetKey]);
  useImperativeHandle(handleRef, () => ({ scrollToIndex(index) {
    const element = scroller.current, position = layout.rows[index];
    if (!element || position === undefined) return;
    // Keep the day heading above the first row of a day visible too.
    const top = layout.tops[position] - (entries[position - 1]?.type === 'day' ? DAY : 0), bottom = layout.tops[position] + entryHeight(entries[position], pictures);
    if (top < element.scrollTop + DAY) element.scrollTop = Math.max(0, top - (entries[position - 1]?.type === 'day' ? 0 : DAY));
    else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight;
    measure.current();
  } }), [layout, entries]);
  if (!entries.length) return <div ref={scroller} className="clip-list">{empty}</div>;
  const pinned = entries[range.sticky];
  const sticky = pinned?.type === 'day' ? pinned : undefined;
  const heading = (day: Extract<ListEntry, { type: 'day' }>, focusable = true) => <button type="button" aria-expanded={!day.collapsed} tabIndex={focusable ? undefined : -1} onClick={() => onToggleDay(day.key)}
    onContextMenu={onDayMenu && (event => { event.preventDefault(); event.stopPropagation(); const bounds = event.currentTarget.getBoundingClientRect(); onDayMenu(day, event.clientX || bounds.left + 16, event.clientY || bounds.bottom); })}
    onKeyDown={onDayMenu && (event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); event.stopPropagation(); const bounds = event.currentTarget.getBoundingClientRect(); onDayMenu(day, bounds.left + 16, bounds.bottom); } })}>
    <ChevronDown size={13} className="day-chevron" aria-hidden="true" />{day.label}{day.collapsed && <span className="day-count">{day.count}</span>}
  </button>;
  return <div ref={scroller} className="clip-list" tabIndex={-1}>
    {sticky && !sticky.collapsed && <div className="day-heading sticky" aria-hidden="true">{heading(sticky, false)}</div>}
    <div className="clip-list-rows" style={{ height: layout.height }}>
      {entries.slice(range.start, range.end).map((entry, offset) => {
        const position = range.start + offset, style = { top: layout.tops[position] };
        return entry.type === 'day'
          ? <h2 key={entry.key} className={'day-heading' + (entry.collapsed ? ' collapsed' : '')} style={style}>{heading(entry)}</h2>
          : <div key={entry.clip.id} className="clip-row-slot" style={style}>{renderRow(entry.clip, entry.index)}</div>;
      })}
    </div>
  </div>;
}
