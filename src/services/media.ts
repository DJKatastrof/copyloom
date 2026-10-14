import { invoke } from '@tauri-apps/api/core';
type Entry = { users: number; promise: Promise<Blob> };
export type MediaKind = 'clip' | 'icon' | 'original';
type Job = { entry: Entry; key: string; id: string; kind: MediaKind; resolve: (blob: Blob) => void; reject: (error: unknown) => void };
// Bounded decoded-preview cache; object URLs belong to mounted components.
const cache = new Map<string, Entry>();
const queue: Job[] = [];
export function clearMediaCache() { cache.clear(); window.dispatchEvent(new Event('copyloom:media-reset')); }
let active = 0;
function pump() {
  while (active < 3 && queue.length) {
    const job = queue.shift()!;
    if (job.entry.users === 0) {
      if (cache.get(job.key) === job.entry) cache.delete(job.key);
      job.reject(new Error('Loading the image was cancelled.'));
      continue;
    }
    active++;
    void (async () => {
      try {
        const bytes = await invoke<ArrayBuffer | number[]>('load_media', job.kind === 'original' ? { id: job.id, kind: 'clip', original: true } : { id: job.id, kind: job.kind });
        const data = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes);
        // List pictures are JPEG; originals and icons PNG.
        job.resolve(new Blob([data], { type: data[0] === 0xff && data[1] === 0xd8 ? 'image/jpeg' : 'image/png' }));
      } catch (error) {
        if (cache.get(job.key) === job.entry) cache.delete(job.key);
        job.reject(error);
      } finally { active--; pump(); }
    })();
  }
}
// Originals fill the preview pane; they are large, so they leave the cache once nothing shows them.
export function acquireMedia(id: string, kind: MediaKind) {
  const key = kind + ':' + id;
  let entry = cache.get(key);
  if (entry) { cache.delete(key); cache.set(key, entry); }
  else {
    const created: Entry = { users: 0, promise: null! };
    created.promise = new Promise<Blob>((resolve, reject) => queue.push({ entry: created, key, id, kind, resolve, reject }));
    entry = created; cache.set(key, created);
    if (cache.size > 48) cache.delete(cache.keys().next().value!);
  }
  entry.users++; pump();
  const owned = entry;
  return { promise: entry.promise, release() { owned.users = Math.max(0, owned.users - 1); if (kind === 'original' && !owned.users && cache.get(key) === owned) cache.delete(key); } };
}
