import { t } from '../i18n';
import { useEffect, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { acquireMedia } from '../services/media';

// original: full resolution, shown at its real screen size (image pixels over the display scale) and never enlarged.
export default function StoredImage({ source, alt, className, title, original = false, onLoad }: { source: string; alt: string; className: string; title?: string; original?: boolean; onLoad?: (image: HTMLImageElement) => void }) {
  const deferred = source.startsWith('copyloom-');
  const [revision, setRevision] = useState(0);
  useEffect(() => { const reset = () => { setState({ source, url: null, failed: false }); setRevision(value => value + 1); }; window.addEventListener('copyloom:media-reset', reset); return () => window.removeEventListener('copyloom:media-reset', reset); }, [source]);
  const [state, setState] = useState<{ source: string; url: string | null; failed: boolean }>({ source, url: null, failed: false });
  useEffect(() => {
    if (!deferred) return;
    let disposed = false, url: string | null = null;
    const icon = source.startsWith('copyloom-icon:');
    const id = source.slice(source.indexOf(':') + 1);
    const media = acquireMedia(id, icon ? 'icon' : original ? 'original' : 'clip');
    void media.promise.then(blob => {
      if (disposed) return;
      url = URL.createObjectURL(blob);
      setState({ source, url, failed: false });
    }).catch(() => { if (!disposed) setState({ source, url: null, failed: true }); });
    return () => { disposed = true; media.release(); if (url) URL.revokeObjectURL(url); };
  }, [source, deferred, original, revision]);
  const current = state.source === source ? state : null;
  if (deferred && !current?.url) return current?.failed && className === 'clip-image'
    ? <span className="image-unavailable" role="img" aria-label={t("Could not load the image")}><ImageOff size={22} /></span>
    : <span className={className + ' image-loading'} aria-hidden="true" />;
  return <img className={className} src={deferred ? current!.url! : source} alt={alt} title={title} loading="lazy" decoding="async" draggable={false} onLoad={original ? event => { const image = event.currentTarget; image.style.width = image.naturalWidth / devicePixelRatio + 'px'; } : onLoad ? event => onLoad(event.currentTarget) : undefined} />;
}
