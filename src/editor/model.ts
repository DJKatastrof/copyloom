export type Point = { x: number; y: number };
export type ShapeKind = 'arrow' | 'rectangle' | 'text' | 'redact' | 'pixelate' | 'highlight' | 'step' | 'crop';
export type Shape = {
  id: string; kind: ShapeKind; x1: number; y1: number; x2: number; y2: number;
  color: string; stroke: number; text?: string; fontSize?: number; background?: boolean; blockSize?: number; number?: number;
};
export type Viewport = { x: number; y: number; zoom: number };
export type Box = { x: number; y: number; width: number; height: number };
export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'start' | 'end';
export const STEP_FONT_SIZE = 18;
export const PALETTE = ['#e52d45', '#00a9e6', '#ffcf33', '#21864b', '#ffffff', '#000000'];
export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export const toImage = (point: Point, view: Viewport): Point => ({ x: (point.x - view.x) / view.zoom, y: (point.y - view.y) / view.zoom });
export const toScreen = (point: Point, view: Viewport): Point => ({ x: point.x * view.zoom + view.x, y: point.y * view.zoom + view.y });
export function bounds(shape: Shape): Box {
  return { x: Math.min(shape.x1, shape.x2), y: Math.min(shape.y1, shape.y2), width: Math.abs(shape.x2 - shape.x1), height: Math.abs(shape.y2 - shape.y1) };
}
// Crop operations keep original coordinates and pixels, so undo never needs another bitmap.
export function imageBounds(image: { width: number; height: number }, shapes: Shape[]): Box {
  const crop = shapes.filter(shape => shape.kind === 'crop').at(-1);
  return crop ? bounds(crop) : { x: 0, y: 0, width: image.width, height: image.height };
}
export function cropShape(shape: Shape, limit: Box): Shape | null {
  const b = bounds(shape), x = Math.max(limit.x, Math.round(b.x)), y = Math.max(limit.y, Math.round(b.y));
  const right = Math.min(limit.x + limit.width, Math.round(b.x + b.width)), bottom = Math.min(limit.y + limit.height, Math.round(b.y + b.height));
  return right > x && bottom > y ? { ...shape, kind: 'crop', x1: x, y1: y, x2: right, y2: bottom } : null;
}
export const nextStepNumber = (shapes: Shape[]) => Math.min(9999, Math.max(0, ...shapes.filter(s => s.kind === 'step').map(s => s.number ?? 1)) + 1);
// maxZoom is in CSS pixels per image pixel; 1 / devicePixelRatio caps fitting at actual pixels.
export function fitView(width: number, height: number, area: { width: number; height: number }, maxZoom = 1): Viewport {
  const zoom = Math.max(0.02, Math.min(maxZoom, (area.width - 48) / width, (area.height - 48) / height));
  return { zoom, x: (area.width - width * zoom) / 2, y: (area.height - height * zoom) / 2 };
}
// The image cannot be scrolled away: centred on an axis where it fits, otherwise its edges
// stop at most `margin` inside the area (the same margin fitView leaves).
export function clampView(view: Viewport, image: { width: number; height: number }, area: { width: number; height: number }, margin = 24): Viewport {
  const axis = (offset: number, size: number, space: number) => {
    const scaled = size * view.zoom;
    return scaled + 2 * margin <= space ? (space - scaled) / 2 : clamp(offset, space - scaled - margin, margin);
  };
  return { ...view, x: axis(view.x, image.width, area.width), y: axis(view.y, image.height, area.height) };
}
// Whole-pixel offsets keep the image on the screen pixel grid; half pixels blur every edge.
export function snapView(view: Viewport, ratio: number): Viewport {
  return { ...view, x: Math.round(view.x * ratio) / ratio, y: Math.round(view.y * ratio) / ratio };
}
export function zoomAt(view: Viewport, screen: Point, zoom: number): Viewport {
  const image = toImage(screen, view); const next = clamp(zoom, 0.02, 16);
  return { zoom: next, x: screen.x - image.x * next, y: screen.y - image.y * next };
}
function distanceToLine(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = dx || dy ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy), 0, 1) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
export function hitTest(shape: Shape, point: Point, tolerance: number): boolean {
  if (shape.kind === 'arrow') return distanceToLine(point, { x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 }) <= tolerance + shape.stroke * 2;
  const b = bounds(shape);
  return point.x >= b.x - tolerance && point.y >= b.y - tolerance && point.x <= b.x + b.width + tolerance && point.y <= b.y + b.height + tolerance;
}
export function handles(shape: Shape): { name: Handle; point: Point }[] {
  if (shape.kind === 'arrow') return [{ name: 'start', point: { x: shape.x1, y: shape.y1 } }, { name: 'end', point: { x: shape.x2, y: shape.y2 } }];
  const b = bounds(shape), x = b.x, y = b.y, r = x + b.width, bottom = y + b.height;
  return [
    { name: 'nw', point: { x, y } }, { name: 'n', point: { x: (x + r) / 2, y } }, { name: 'ne', point: { x: r, y } },
    { name: 'e', point: { x: r, y: (y + bottom) / 2 } }, { name: 'se', point: { x: r, y: bottom } },
    { name: 's', point: { x: (x + r) / 2, y: bottom } }, { name: 'sw', point: { x, y: bottom } }, { name: 'w', point: { x, y: (y + bottom) / 2 } },
  ];
}
export function hitHandle(shape: Shape, point: Point, zoom: number): Handle | undefined {
  return handles(shape).find(handle => Math.hypot(point.x - handle.point.x, point.y - handle.point.y) <= 7 / zoom)?.name;
}
export function moveShape(shape: Shape, dx: number, dy: number, width: number, height: number): Shape {
  const b = bounds(shape); dx = clamp(dx, -b.x, Math.max(-b.x, width - b.x - b.width)); dy = clamp(dy, -b.y, Math.max(-b.y, height - b.y - b.height));
  return { ...shape, x1: shape.x1 + dx, x2: shape.x2 + dx, y1: shape.y1 + dy, y2: shape.y2 + dy };
}
export function resizeShape(shape: Shape, handle: Handle, p: Point): Shape {
  if (handle === 'start') return { ...shape, x1: p.x, y1: p.y };
  if (handle === 'end') return { ...shape, x2: p.x, y2: p.y };
  const box = bounds(shape); let x1 = box.x, y1 = box.y, x2 = box.x + box.width, y2 = box.y + box.height;
  if (handle.includes('w')) x1 = Math.min(p.x, x2 - 1);
  if (handle.includes('e')) x2 = Math.max(p.x, x1 + 1);
  if (handle.includes('n')) y1 = Math.min(p.y, y2 - 1);
  if (handle.includes('s')) y2 = Math.max(p.y, y1 + 1);
  if (shape.kind === 'step') {
    const horizontal = (x2 - x1) / box.width, vertical = (y2 - y1) / box.height;
    const ratio = handle === 'n' || handle === 's' ? vertical : handle === 'e' || handle === 'w' ? horizontal : Math.max(horizontal, vertical);
    const originalFont = shape.fontSize ?? STEP_FONT_SIZE, fontSize = Math.round(clamp(originalFont * ratio, 8, 240) * 10) / 10;
    const size = box.width * fontSize / originalFont;
    const x = handle.includes('w') ? box.x + box.width - size : handle.includes('e') ? box.x : box.x + (box.width - size) / 2;
    const y = handle.includes('n') ? box.y + box.height - size : handle.includes('s') ? box.y : box.y + (box.height - size) / 2;
    return { ...shape, x1: x, y1: y, x2: x + size, y2: y + size, fontSize };
  }
  if (shape.kind === 'text') {
    const ratio = handle === 'n' || handle === 's' ? (y2 - y1) / box.height : (x2 - x1) / box.width;
    const fontSize = clamp((shape.fontSize ?? 28) * ratio, 8, 240), actualRatio = fontSize / (shape.fontSize ?? 28);
    return { ...shape, x1, y1, x2: x1 + box.width * actualRatio, y2: y1 + box.height * actualRatio, fontSize };
  }
  return { ...shape, x1, y1, x2, y2 };
}
export function normalizeShape(shape: Shape): Shape {
  if (shape.kind === 'arrow') return shape;
  const b = bounds(shape); return { ...shape, x1: b.x, y1: b.y, x2: b.x + b.width, y2: b.y + b.height };
}
export type History = { past: Shape[][]; present: Shape[]; future: Shape[][] };
export const emptyHistory = (): History => ({ past: [], present: [], future: [] });
export const signature = (shapes: Shape[]) => JSON.stringify(shapes);
export function commit(history: History, shapes: Shape[]): History {
  if (signature(history.present) === signature(shapes)) return history;
  return { past: [...history.past, history.present].slice(-100), present: shapes, future: [] };
}
export function undo(history: History): History {
  if (!history.past.length) return history;
  return { past: history.past.slice(0, -1), present: history.past.at(-1)!, future: [history.present, ...history.future] };
}
export function redo(history: History): History {
  if (!history.future.length) return history;
  return { past: [...history.past, history.present], present: history.future[0], future: history.future.slice(1) };
}
// A small grid stores block averages. No full-resolution bitmap is retained per effect.
export function pixelateGrid(data: Uint8ClampedArray, width: number, height: number, block: number): { data: Uint8ClampedArray; width: number; height: number } {
  if (width < 1 || height < 1 || block < 1 || !Number.isInteger(block) || data.length !== width * height * 4) throw new Error('Invalid image dimensions.');
  const columns = Math.ceil(width / block), rows = Math.ceil(height / block), result = new Uint8ClampedArray(columns * rows * 4);
  for (let by = 0; by < rows; by++) for (let bx = 0; bx < columns; bx++) {
    let r = 0, g = 0, b = 0, a = 0, count = 0;
    for (let y = by * block; y < Math.min(height, (by + 1) * block); y++) for (let x = bx * block; x < Math.min(width, (bx + 1) * block); x++) {
      const i = (y * width + x) * 4, alpha = data[i + 3]; r += data[i] * alpha; g += data[i + 1] * alpha; b += data[i + 2] * alpha; a += alpha; count++;
    }
    const i = (by * columns + bx) * 4; result[i] = a ? r / a : 0; result[i + 1] = a ? g / a : 0; result[i + 2] = a ? b / a : 0; result[i + 3] = a / count;
  }
  return { data: result, width: columns, height: rows };
}
