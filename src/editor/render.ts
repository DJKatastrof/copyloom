import { bounds, clamp, handles, imageBounds, pixelateGrid, STEP_FONT_SIZE } from './model';
import type { Box, Shape, Viewport } from './model';
export const FONT = 'Segoe UI';
export type PixelCache = Map<string, { key: string; canvas: HTMLCanvasElement }>;
// Opaque redactions stay above visual effects, which sample the source image.
export const paintOrder = (shapes: Shape[]) => [...shapes.filter(shape => shape.kind !== 'redact' && shape.kind !== 'crop'), ...shapes.filter(shape => shape.kind === 'redact')];
export function measureText(shape: Shape): Shape {
  const context = document.createElement('canvas').getContext('2d')!;
  const size = shape.fontSize ?? 28; context.font = `${size}px "${FONT}"`;
  const lines = (shape.text || '').split('\n');
  return { ...shape, x2: shape.x1 + Math.max(size, ...lines.map(line => context.measureText(line).width)) + 12, y2: shape.y1 + lines.length * size * 1.25 + 12 };
}
// The numeral determines the circle, with proportional padding for every number of digits.
export function measureStep(shape: Shape, limit?: Box): Shape {
  const context = document.createElement('canvas').getContext('2d')!;
  const fontSize = shape.fontSize ?? STEP_FONT_SIZE; context.font = `bold ${fontSize}px "${FONT}"`;
  let size = Math.ceil(Math.max(fontSize * 5 / 3, context.measureText(String(shape.number ?? 1)).width + fontSize * 0.7));
  if (limit) size = Math.min(size, limit.width, limit.height);
  const box = bounds(shape), centerX = box.x + box.width / 2, centerY = box.y + box.height / 2;
  const x = limit ? clamp(centerX - size / 2, limit.x, limit.x + limit.width - size) : centerX - size / 2;
  const y = limit ? clamp(centerY - size / 2, limit.y, limit.y + limit.height - size) : centerY - size / 2;
  return { ...shape, x1: x, y1: y, x2: x + size, y2: y + size, fontSize };
}
export function drawShape(ctx: CanvasRenderingContext2D, shape: Shape, image: CanvasImageSource, cache: PixelCache) {
  ctx.save(); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = shape.color; ctx.fillStyle = shape.color; ctx.lineWidth = shape.stroke; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const box = bounds(shape);
  if (shape.kind === 'arrow') {
    const angle = Math.atan2(shape.y2 - shape.y1, shape.x2 - shape.x1), length = Math.min(Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1) * 0.45, Math.max(12, shape.stroke * 4));
    ctx.beginPath(); ctx.moveTo(shape.x1, shape.y1); ctx.lineTo(shape.x2, shape.y2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(shape.x2 - length * Math.cos(angle - Math.PI / 6), shape.y2 - length * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(shape.x2, shape.y2); ctx.lineTo(shape.x2 - length * Math.cos(angle + Math.PI / 6), shape.y2 - length * Math.sin(angle + Math.PI / 6)); ctx.stroke();
  } else if (shape.kind === 'rectangle') ctx.strokeRect(box.x, box.y, box.width, box.height);
  else if (shape.kind === 'highlight') { ctx.globalAlpha = 0.35; ctx.fillRect(box.x, box.y, box.width, box.height); }
  else if (shape.kind === 'step') {
    ctx.beginPath(); ctx.ellipse(box.x + box.width / 2, box.y + box.height / 2, box.width / 2, box.height / 2, 0, 0, Math.PI * 2); ctx.fill();
    const hex = shape.color.replace('#', ''), linear = [0, 2, 4].map(i => { const value = parseInt(hex.slice(i, i + 2), 16) / 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; });
    ctx.fillStyle = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722 > 0.179 ? '#000000' : '#ffffff';
    const label = String(shape.number ?? 1), fontSize = shape.fontSize ?? STEP_FONT_SIZE;
    ctx.font = `bold ${fontSize}px "${FONT}"`;
    const size = fontSize * Math.min(1, box.height * 0.7 / fontSize, box.width * 0.8 / Math.max(1, ctx.measureText(label).width));
    ctx.font = `bold ${size}px "${FONT}"`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, box.x + box.width / 2, box.y + box.height / 2);
  }
  else if (shape.kind === 'redact') {
    // Outward rounding + opaque fill ensures complete pixel replacement, including fractional bounds.
    ctx.fillRect(Math.floor(box.x), Math.floor(box.y), Math.ceil(box.x + box.width) - Math.floor(box.x), Math.ceil(box.y + box.height) - Math.floor(box.y));
  } else if (shape.kind === 'text') {
    if (shape.background) { ctx.fillStyle = '#ffffff'; ctx.fillRect(box.x, box.y, box.width, box.height); ctx.fillStyle = shape.color; }
    const size = shape.fontSize ?? 28; ctx.font = `${size}px "${FONT}"`; ctx.textBaseline = 'top';
    (shape.text ?? '').split('\n').forEach((line, index) => ctx.fillText(line, box.x + 6, box.y + 6 + index * size * 1.25));
  } else if (shape.kind === 'pixelate') {
    const x = Math.floor(box.x), y = Math.floor(box.y), width = Math.max(1, Math.ceil(box.x + box.width) - x), height = Math.max(1, Math.ceil(box.y + box.height) - y), block = Math.max(2, Math.min(100, Math.round(shape.blockSize ?? 18)));
    const key = `${x}:${y}:${width}:${height}:${block}`; let entry = cache.get(shape.id);
    if (!entry || entry.key !== key) {
      // Bounded strips avoid retaining another full-resolution buffer for each effect.
      const canvas = document.createElement('canvas'); canvas.width = Math.ceil(width / block); canvas.height = Math.ceil(height / block);
      const target = canvas.getContext('2d')!;
      const strip = document.createElement('canvas'); strip.width = width; strip.height = block;
      const reader = strip.getContext('2d', { willReadFrequently: true })!;
      for (let row = 0; row < height; row += block) {
        const rows = Math.min(block, height - row); reader.clearRect(0, 0, width, block);
        reader.drawImage(image, x, y + row, width, rows, 0, 0, width, rows);
        const grid = pixelateGrid(reader.getImageData(0, 0, width, rows).data, width, rows, block);
        target.putImageData(new ImageData(new Uint8ClampedArray(grid.data), grid.width, 1), 0, row / block);
      }
      strip.width = strip.height = 0; if (entry) entry.canvas.width = entry.canvas.height = 0; entry = { key, canvas }; cache.set(shape.id, entry);
    }
    ctx.imageSmoothingEnabled = false; ctx.beginPath(); ctx.rect(x, y, width, height); ctx.clip();
    ctx.clearRect(x, y, width, height);
    ctx.drawImage(entry.canvas, x, y, entry.canvas.width * block, entry.canvas.height * block);
  }
  ctx.restore();
}
export function drawSelection(ctx: CanvasRenderingContext2D, shape: Shape, view: Viewport) {
  const b = bounds(shape); ctx.save(); ctx.strokeStyle = '#00a9e6'; ctx.lineWidth = 1 / view.zoom;
  ctx.setLineDash([4 / view.zoom, 3 / view.zoom]); ctx.strokeRect(b.x, b.y, b.width, b.height); ctx.setLineDash([]);
  for (const handle of handles(shape)) {
    const size = 7 / view.zoom; ctx.fillStyle = '#ffffff'; ctx.fillRect(handle.point.x - size / 2, handle.point.y - size / 2, size, size); ctx.strokeRect(handle.point.x - size / 2, handle.point.y - size / 2, size, size);
  }
  ctx.restore();
}
export async function exportPng(image: ImageBitmap, shapes: Shape[], cache: PixelCache): Promise<Blob> {
  const crop = imageBounds(image, shapes);
  const canvas = document.createElement('canvas'); canvas.width = crop.width; canvas.height = crop.height;
  try {
    const ctx = canvas.getContext('2d')!; ctx.translate(-crop.x, -crop.y); ctx.drawImage(image, 0, 0);
    for (const shape of paintOrder(shapes)) drawShape(ctx, shape, image, cache);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Couldn't export the image. Try again.")), 'image/png'));
  } finally { canvas.width = canvas.height = 0; }
}
