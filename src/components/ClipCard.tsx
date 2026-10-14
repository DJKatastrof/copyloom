import { t } from '../i18n';
import { Link2 } from 'lucide-react';
import type { Clip } from '../domain/library';
import { lazy, Suspense } from 'react';
import { codePreview, detectCodeLanguage, LANGUAGE_LABELS, type CodeLanguage } from '../domain/code';
import StoredImage from './StoredImage';
const CodePreview = lazy(() => import('./CodePreview'));

const TYPE_LABELS = { text: 'Text', link: 'Link', code: 'Code', color: 'Color', image: 'Image' };

/** Row and preview share one set of actions; ids keep the callbacks stable so memoized clips skip re-rendering. */
export type ClipHandlers = {
  select: (id: string, event: React.MouseEvent) => void;
  menu: (id: string, x: number, y: number) => void;
  copy: (id: string, plain: boolean) => void;
  favorite: (id: string) => void;
  dragIds: (id: string) => string[];
  dragEnd: () => void;
  canReorder: () => boolean;
  reorder: (source: string, target: string) => void;
};

export function contrastText(color: string): string {
  const channels = color.replace('#', '').match(/.{2}/g)?.map(value => parseInt(value, 16) / 255);
  if (!channels || channels.length !== 3 || channels.some(Number.isNaN)) return '#fff';
  const linear = channels.map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  const luminance = .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
  const ink = [23, 21, 27].map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  const inkLuminance = .2126 * ink[0] + .7152 * ink[1] + .0722 * ink[2];
  return (luminance + .05) / (inkLuminance + .05) > 1.05 / (luminance + .05) ? '#17151b' : '#ffffff';
}

// Detection runs regexes over up to 16 kB; each clip object is inspected once, however often it renders.
const languages = new WeakMap<Clip, CodeLanguage | null>();
export function languageOf(clip: Clip): CodeLanguage | undefined {
  if (clip.kind !== 'text' && clip.kind !== 'code') return undefined;
  let language = languages.get(clip);
  if (language === undefined) { language = detectCodeLanguage(clip.content) ?? null; languages.set(clip, language); }
  return language ?? undefined;
}
export function kindOf(clip: Clip) { return languageOf(clip) ? 'code' : clip.kind; }
export function typeLabel(clip: Clip): string {
  const language = languageOf(clip);
  return language ? LANGUAGE_LABELS[language] : t(TYPE_LABELS[kindOf(clip)]);
}

// A short preview shows about ten lines; laying out a 6 000-character note only to clip it is wasted work.
const CARD_TEXT = 600;
export function ClipContent({ clip, full = false }: { clip: Clip; full?: boolean }) {
  const language = languageOf(clip);
  if (clip.kind === 'image') return <StoredImage className="clip-image" source={clip.content} alt={clip.title} original={full} />;
  if (clip.kind === 'color') return <div className="color-preview" style={{ backgroundColor: clip.content.trim(), color: contrastText(clip.content.trim()) }}><span>{clip.content.toUpperCase()}</span></div>;
  if (clip.kind === 'code' || language) return <Suspense fallback={<pre className="code-preview">{full ? clip.content : codePreview(clip.content)}</pre>}><CodePreview content={clip.content} language={language} full={full} /></Suspense>;
  if (clip.kind === 'link') {
    let host = clip.content;
    try { host = new URL(clip.content).hostname; } catch { /* Render as plain text. */ }
    return <div className="link-preview"><Link2 size={26} /><strong>{host}</strong><span>{clip.content}</span></div>;
  }
  return <p className="text-preview">{full ? clip.content : clip.content.slice(0, CARD_TEXT)}</p>;
}
