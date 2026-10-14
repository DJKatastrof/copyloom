import { invoke } from '@tauri-apps/api/core';
import { drawShape, exportPng, measureText } from './render';
import type { PixelCache } from './render';
import type { Shape } from './model';

// Runs only in an explicitly isolated startup probe, with a synthetic image.
export async function runEditorProbe(image: { id: string; bitmap: ImageBitmap; original: Blob }, cache: PixelCache, openMs: number, windowOpenMs: number | null) {
  const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 675;
  const ctx = canvas.getContext('2d')!;
  const originalSaved = await invoke<{ id: string }>('save_edited_image', await image.original.arrayBuffer(), { headers: { 'x-source-id': image.id } });
  const shape: Shape = { id: 'probe-arrow', kind: 'arrow', x1: 100, y1: 100, x2: 1000, y2: 600, color: '#e52d45', stroke: 8 };
  const drag: number[] = [], zoom: number[] = [], typing: number[] = [];
  for (let i = 0; i < 100; i++) {
    let start = performance.now(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, 1200, 675); ctx.scale(0.3125, 0.3125);
    drawShape(ctx, { ...shape, x2: 1000 + i }, image.bitmap, cache); ctx.getImageData(0, 0, 1, 1); drag.push(performance.now() - start);
    start = performance.now(); ctx.setTransform(0.3125 + i / 1000, 0, 0, 0.3125 + i / 1000, 0, 0); ctx.drawImage(image.bitmap, 0, 0); ctx.getImageData(0, 0, 1, 1); zoom.push(performance.now() - start);
    start = performance.now(); const text = measureText({ ...shape, id: 'probe-text', kind: 'text', text: 'Synthetic measurement ' + i, fontSize: 36 }); drawShape(ctx, text, image.bitmap, cache); ctx.getImageData(0, 0, 1, 1); typing.push(performance.now() - start);
  }
  const start = performance.now(); const blob = await exportPng(image.bitmap, [shape, { ...shape, id: 'probe-redact', kind: 'redact', color: '#000000', x1: 200, y1: 800, x2: 800, y2: 900 }], cache); const exportMs = performance.now() - start;
  const saved = await invoke<{ id: string; copied: boolean; elapsedMs: number }>('save_edited_image', await blob.arrayBuffer(), { headers: { 'x-source-id': image.id } });
  const summarize = (values: number[]) => ({ meanMs: values.reduce((a, b) => a + b, 0) / values.length, maxMs: Math.max(...values) });
  canvas.width = canvas.height = 0;
  await invoke('editor_probe_report', { report: { originalSavedId: originalSaved.id, savedId: saved.id, width: image.bitmap.width, height: image.bitmap.height, windowOpenMs, openMs, exportMs, encodedBytes: blob.size, nativeSaveMs: saved.elapsedMs, saved: saved.copied, drag: summarize(drag), zoom: summarize(zoom), text: summarize(typing), note: 'Synthetic 4K. Timings include canvas raster/readback on a 1200×675 canvas; input-to-display latency is not measured. Native clipboard data is prepared but clipboard writes are suppressed.' } });
}
