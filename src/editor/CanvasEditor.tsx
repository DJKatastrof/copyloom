import { t } from '../i18n';
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { bounds, clamp, clampView, cropShape, fitView, hitHandle, hitTest, imageBounds, moveShape, normalizeShape, resizeShape, snapView, toImage, toScreen, zoomAt } from './model';
import type { Handle, Point, Shape, ShapeKind, Viewport } from './model';
import { drawSelection, drawShape, FONT, measureStep, measureText, paintOrder } from './render';
import type { PixelCache } from './render';

// Viewport zoom is CSS pixels per image pixel. zoomTo and onZoom use screen pixels per image pixel,
// so 100 % shows a capture at its actual size regardless of Windows display scaling.
export type CanvasHandle = { fit: () => void; zoomTo: (scale: number) => void; view: () => Viewport; metrics: () => { frames: number[] } };
const pixelRatio = () => window.devicePixelRatio || 1;
// Device-pixel transform; a scale within rounding of 1 is exactly 1 so actual size never resamples.
function deviceTransform(ctx: CanvasRenderingContext2D, view: Viewport) {
  const ratio = pixelRatio(), raw = view.zoom * ratio, scale = Math.abs(raw - 1) < 1e-6 ? 1 : raw;
  ctx.setTransform(scale, 0, 0, scale, Math.round(view.x * ratio), Math.round(view.y * ratio));
  return scale;
}
type Props = {
  image: ImageBitmap; shapes: Shape[]; selected: string | null; tool: 'select' | ShapeKind;
  color: string; stroke: number; fontSize: number; stepFontSize: number; background: boolean; blockSize: number; disabled: boolean; stepNumber: number;
  cropDraft: Shape | null; onCropDraft: (shape: Shape | null) => void;
  editing: Shape | null; onEdit: (shape: Shape | null) => void; onFinishText: (cancel?: boolean) => void;
  onSelect: (id: string | null) => void; onCommit: (shapes: Shape[]) => void; onStepPlaced: () => void;
  onZoom: (zoom: number) => void; cache: PixelCache;
};
type Gesture = { mode: 'draw' | 'move' | 'resize' | 'pan'; start: Point; screen: Point; shape?: Shape; handle?: Handle; initial: Shape[]; view: Viewport; moved: boolean };

export default forwardRef<CanvasHandle, Props>(function CanvasEditor(props, ref) {
  const stage = useRef<HTMLDivElement>(null), base = useRef<HTMLCanvasElement>(null), overlay = useRef<HTMLCanvasElement>(null), textarea = useRef<HTMLTextAreaElement>(null);
  const [area, setArea] = useState({ width: 1, height: 1, pixelWidth: 1, pixelHeight: 1 });
  const [view, setRawView] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const setView = (next: Viewport | ((view: Viewport) => Viewport)) => setRawView(v => {
    const { props: { image, shapes }, area } = current.current;
    const crop = imageBounds(image, shapes), candidate = typeof next === 'function' ? next(v) : next;
    const adjusted = clampView({ ...candidate, x: candidate.x + crop.x * candidate.zoom, y: candidate.y + crop.y * candidate.zoom }, crop, area);
    return snapView({ ...adjusted, x: adjusted.x - crop.x * adjusted.zoom, y: adjusted.y - crop.y * adjusted.zoom }, pixelRatio());
  });
  const [preview, setPreview] = useState<Shape[] | null>(null), [space, setSpace] = useState(false);
  const gesture = useRef<Gesture | null>(null), frame = useRef(0), nextPoint = useRef<Point | null>(null), metrics = useRef<number[]>([]);
  const current = useRef({ props, view, area }); current.current = { props, view, area };
  const previewRef = useRef<Shape[] | null>(null);
  const crop = imageBounds(props.image, props.shapes), cropKey = JSON.stringify(crop);
  const pixelGeometry = JSON.stringify((preview ?? props.shapes).filter(shape => shape.kind === 'pixelate' && gesture.current?.shape?.id !== shape.id).map(shape => [shape.x1, shape.y1, shape.x2, shape.y2]));
  function showPreview(shapes: Shape[] | null) { previewRef.current = shapes; setPreview(shapes); }
  function fit() { const p = current.current, crop = imageBounds(p.props.image, p.props.shapes), fitted = fitView(crop.width, crop.height, p.area, 1 / pixelRatio()); setView({ ...fitted, x: fitted.x - crop.x * fitted.zoom, y: fitted.y - crop.y * fitted.zoom }); }
  useImperativeHandle(ref, () => ({ fit, zoomTo: scale => setView(v => zoomAt(v, { x: area.width / 2, y: area.height / 2 }, scale / pixelRatio())), view: () => view, metrics: () => ({ frames: metrics.current.slice() }) }), [view, area]);
  useLayoutEffect(() => {
    const node = stage.current!;
    // The canvas backing store must match its on-screen device pixels exactly, or the browser rescales it.
    // Emulated scaling can report CSS-sized device boxes, so they are trusted only when consistent.
    const resize = new ResizeObserver(([entry]) => {
      const device = entry?.devicePixelContentBoxSize?.[0], width = entry?.contentRect.width ?? node.clientWidth, height = entry?.contentRect.height ?? node.clientHeight;
      const pixels = (measured: number | undefined, css: number) => measured !== undefined && Math.abs(measured - css * pixelRatio()) <= 1 ? measured : Math.round(css * pixelRatio());
      setArea({ width, height, pixelWidth: pixels(device?.inlineSize, width), pixelHeight: pixels(device?.blockSize, height) });
    });
    try { resize.observe(node, { box: 'device-pixel-content-box' }); } catch { resize.observe(node); }
    return () => resize.disconnect();
  }, []);
  useLayoutEffect(() => { fit(); }, [props.image, cropKey, area.width, area.height, area.pixelWidth]);
  useEffect(() => props.onZoom(view.zoom * pixelRatio()), [view.zoom, area.pixelWidth]);
  useLayoutEffect(() => {
    const canvas = base.current!;
    canvas.width = Math.max(1, area.pixelWidth); canvas.height = Math.max(1, area.pixelHeight);
    const ctx = canvas.getContext('2d')!, scale = deviceTransform(ctx, view);
    // Nearest-neighbour at actual size and above keeps text in screenshots sharp.
    ctx.imageSmoothingEnabled = scale < 1; ctx.imageSmoothingQuality = 'high';
    ctx.save(); ctx.beginPath(); ctx.rect(crop.x, crop.y, crop.width, crop.height); ctx.clip(); ctx.drawImage(props.image, 0, 0);
    // Leave room for translucent effect pixels without blending the original into them again.
    for (const [x1, y1, x2, y2] of JSON.parse(pixelGeometry) as number[][]) {
      const x = Math.floor(Math.min(x1, x2)), y = Math.floor(Math.min(y1, y2));
      ctx.clearRect(x, y, Math.ceil(Math.max(x1, x2)) - x, Math.ceil(Math.max(y1, y2)) - y);
    }
    ctx.restore();
  }, [props.image, view, area, pixelGeometry, cropKey]);
  useLayoutEffect(() => {
    const started = performance.now(), canvas = overlay.current!;
    const width = Math.max(1, area.pixelWidth), height = Math.max(1, area.pixelHeight);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const ctx = canvas.getContext('2d')!; ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, width, height);
    deviceTransform(ctx, view);
    ctx.save(); ctx.beginPath(); ctx.rect(crop.x, crop.y, crop.width, crop.height); ctx.clip();
    const shapes = preview ?? props.shapes;
    for (const shape of paintOrder(shapes)) if (shape.id !== props.editing?.id) {
      // Rebuild the pixel grid on release; during a gesture the outline stays responsive.
      const drawing = shape.kind === 'pixelate' && gesture.current?.shape?.id === shape.id ? { ...shape, kind: 'rectangle' as const, color: '#00a9e6' } : shape;
      drawShape(ctx, drawing, props.image, props.cache);
    }
    ctx.restore();
    const draft = gesture.current?.shape?.kind === 'crop' ? preview?.find(shape => shape.id === gesture.current?.shape?.id) : props.cropDraft;
    if (draft) {
      const b = bounds(draft); ctx.save(); ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.beginPath();
      ctx.rect(crop.x, crop.y, crop.width, crop.height); ctx.rect(b.x, b.y, b.width, b.height); ctx.fill('evenodd'); ctx.restore(); drawSelection(ctx, draft, view);
    }
    const selected = shapes.find(shape => shape.id === props.selected && shape.kind !== 'crop');
    if (selected && !props.editing) drawSelection(ctx, selected, view);
    metrics.current.push(performance.now() - started); if (metrics.current.length > 500) metrics.current.shift();
  }, [props.shapes, props.selected, props.editing, props.image, preview, view, area, props.cache, props.cropDraft]);
  useEffect(() => {
    const liveIds = new Set(props.shapes.map(shape => shape.id));
    for (const [id, entry] of props.cache) if (!liveIds.has(id)) { entry.canvas.width = entry.canvas.height = 0; props.cache.delete(id); }
  }, [props.shapes, props.cache]);
  useEffect(() => {
    if (props.editing) { textarea.current?.focus(); textarea.current?.setSelectionRange(textarea.current.value.length, textarea.current.value.length); }
  }, [props.editing?.id]);
  useEffect(() => {
    const down = (event: KeyboardEvent) => { if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLButtonElement || document.querySelector('dialog[open]')) return; if (event.code === 'Space') { event.preventDefault(); setSpace(true); } };
    const up = (event: KeyboardEvent) => { if (event.code === 'Space') setSpace(false); };
    const cancel = () => { setSpace(false); gesture.current = null; showPreview(null); };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', cancel);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', cancel); cancelAnimationFrame(frame.current); };
  }, []);
  useEffect(() => {
    const node = stage.current!;
    const wheel = (event: WheelEvent) => {
      if (current.current.props.disabled || current.current.props.editing) return;
      event.preventDefault();
      const r = node.getBoundingClientRect();
      if (event.ctrlKey) setView(v => zoomAt(v, { x: event.clientX - r.left, y: event.clientY - r.top }, v.zoom * Math.exp(-event.deltaY * 0.002)));
      else setView(v => ({ ...v, x: v.x - (event.shiftKey ? event.deltaY : event.deltaX), y: v.y - (event.shiftKey ? 0 : event.deltaY) }));
    };
    node.addEventListener('wheel', wheel, { passive: false }); return () => node.removeEventListener('wheel', wheel);
  }, []);
  function local(event: { clientX: number; clientY: number }) { const r = stage.current!.getBoundingClientRect(); return { x: event.clientX - r.left, y: event.clientY - r.top }; }
  function imagePoint(screen: Point, v = view) { const p = toImage(screen, v); return { x: clamp(p.x, crop.x, crop.x + crop.width), y: clamp(p.y, crop.y, crop.y + crop.height) }; }
  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (props.disabled || props.editing || ![0, 1].includes(event.button)) return;
    event.preventDefault(); stage.current!.focus(); stage.current!.setPointerCapture(event.pointerId);
    const screen = local(event), point = imagePoint(screen);
    const original = toImage(screen, view);
    if (space || event.button === 1) { gesture.current = { mode: 'pan', start: point, screen, view, initial: props.shapes, moved: false }; return; }
    if (original.x < crop.x || original.y < crop.y || original.x > crop.x + crop.width || original.y > crop.y + crop.height) { props.onSelect(null); return; }
    if (props.tool === 'crop' && props.cropDraft) {
      const handle = hitHandle(props.cropDraft, point, view.zoom);
      if (handle || hitTest(props.cropDraft, point, 0)) {
        gesture.current = { mode: handle ? 'resize' : 'move', start: point, screen, shape: props.cropDraft, handle, initial: [...props.shapes, props.cropDraft], view, moved: false }; showPreview([...props.shapes, props.cropDraft]); return;
      }
    }
    if (props.tool === 'select') {
      const selected = props.shapes.find(shape => shape.id === props.selected), handle = selected && hitHandle(selected, point, view.zoom);
      const hit = handle ? selected : [...props.shapes].reverse().find(shape => shape.kind !== 'crop' && hitTest(shape, point, 5 / view.zoom));
      props.onSelect(hit?.id ?? null);
      if (hit) {
        gesture.current = { mode: handle ? 'resize' : 'move', start: point, screen, shape: hit, handle, initial: props.shapes, view, moved: false };
        // Even a click without movement must repaint the effect after the gesture ends.
        showPreview(props.shapes);
      }
      return;
    }
    const shape: Shape = { id: crypto.randomUUID(), kind: props.tool, x1: point.x, y1: point.y, x2: point.x, y2: point.y, color: props.color, stroke: props.stroke, ...(props.tool === 'pixelate' ? { blockSize: props.blockSize } : {}), ...(props.tool === 'text' ? { text: '', fontSize: props.fontSize, background: props.background } : {}) };
    props.onSelect(shape.id);
    if (props.tool === 'text') { props.onEdit(measureText(shape)); return; }
    if (props.tool === 'step') {
      props.onCommit([...props.shapes, measureStep({ ...shape, number: props.stepNumber, fontSize: props.stepFontSize }, crop)]); props.onStepPlaced(); return;
    }
    gesture.current = { mode: 'draw', start: point, screen, shape, initial: props.shapes, view, moved: false };
    showPreview([...props.shapes, shape]);
  }
  function applyPoint(screen: Point) {
    const drag = gesture.current; if (!drag) return;
    if (Math.hypot(screen.x - drag.screen.x, screen.y - drag.screen.y) >= 2) drag.moved = true;
    if (drag.mode === 'pan') { setView({ ...drag.view, x: drag.view.x + screen.x - drag.screen.x, y: drag.view.y + screen.y - drag.screen.y }); return; }
    const p = imagePoint(screen, drag.view), original = drag.shape!;
    let changed = drag.mode === 'draw' ? { ...original, x2: p.x, y2: p.y } : drag.mode === 'resize' ? resizeShape(original, drag.handle!, p) : moveShape(original, p.x - drag.start.x, p.y - drag.start.y, props.image.width, props.image.height);
    if (changed.kind === 'text') changed = measureText(changed);
    if (changed.kind === 'step' && drag.mode === 'resize') changed = measureStep(changed, crop);
    showPreview(drag.mode === 'draw' ? [...drag.initial, changed] : drag.initial.map(shape => shape.id === changed.id ? changed : shape));
  }
  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!gesture.current) return; nextPoint.current = local(event);
    if (!frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; if (nextPoint.current) applyPoint(nextPoint.current); });
  }
  function finish(event: ReactPointerEvent<HTMLDivElement>, cancel = false) {
    cancelAnimationFrame(frame.current); frame.current = 0;
    if (!cancel) applyPoint(local(event));
    const drag = gesture.current;
    if (drag && !cancel && drag.moved && previewRef.current && drag.mode !== 'pan') {
      if (drag.shape?.kind === 'crop') { const draft = previewRef.current.find(s => s.id === drag.shape!.id); if (draft) props.onCropDraft(cropShape(draft, crop)); }
      else props.onCommit(previewRef.current.map(normalizeShape));
    }
    gesture.current = null; showPreview(null);
    if (stage.current?.hasPointerCapture(event.pointerId)) stage.current.releasePointerCapture(event.pointerId);
  }
  const text = props.editing, textPosition = text && toScreen({ x: text.x1, y: text.y1 }, view), textBounds = text && bounds(text);
  return <div ref={stage} className={'editor-stage' + (space ? ' panning' : props.tool === 'select' ? ' selecting' : ' drawing')} tabIndex={0} aria-label="Redigeringsyta" role="region"
    data-zoom={view.zoom} data-offset-x={view.x} data-offset-y={view.y} data-shapes={props.shapes.length}
    onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)}
    onKeyDown={event => { if (event.key === 'Escape' && gesture.current) { event.preventDefault(); event.stopPropagation(); cancelAnimationFrame(frame.current); frame.current = 0; gesture.current = null; showPreview(null); } }}
    onDoubleClick={event => {
      if (props.disabled || props.editing) return;
      const point = imagePoint(local(event)); const shape = [...props.shapes].reverse().find(shape => hitTest(shape, point, 5 / view.zoom));
      if (shape?.kind === 'text') { props.onSelect(shape.id); props.onEdit(shape); }
    }}>
    <canvas ref={base} className="editor-base" aria-hidden="true" /><canvas ref={overlay} className="editor-overlay" aria-hidden="true" />
    {text && textPosition && textBounds && <textarea ref={textarea} className="editor-text-input" aria-label={t("Text on image")} autoComplete="off" spellCheck={false} wrap="off" value={text.text ?? ''} maxLength={10000}
      style={{ left: textPosition.x, top: textPosition.y, width: Math.max(180, textBounds.width * view.zoom + 8), height: Math.max(40, textBounds.height * view.zoom + 4), fontFamily: FONT, fontSize: (text.fontSize ?? 28) * view.zoom, lineHeight: 1.25, padding: 6 * view.zoom, color: text.color, background: text.background ? '#ffffff' : 'transparent' }}
      onPointerDown={event => event.stopPropagation()} onChange={event => props.onEdit(measureText({ ...text, text: event.target.value }))}
      onBlur={() => props.onFinishText()} onKeyDown={event => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); props.onFinishText(); return; }
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); props.onFinishText(true); }
        else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); props.onFinishText(); }
      }} />}
  </div>;
});
