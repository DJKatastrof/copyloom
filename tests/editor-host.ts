import { expect, type Page } from '@playwright/test';

export async function editorHost(page: Page, options: { width?: number; height?: number; theme?: string; language?: string; gradient?: boolean; copyFailure?: boolean; saveFailure?: boolean } = {}) {
  await page.addInitScript(options => {
    const root = window as any;
    const width = options.width ?? 800, height = options.height ?? 480;
    let callbackId = 0;
    const callbacks = new Map<number, (event: unknown) => void>(), events = new Map<string, number[]>();
    let bytes: Promise<ArrayBuffer> | null = null;
    const image = () => bytes ??= (async () => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#f6f7fb'; ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#26374b'; ctx.fillRect(0, 0, width, 68); ctx.font = '22px "Segoe UI"'; ctx.fillStyle = '#ffffff'; ctx.fillText('Supportärende #1842', 28, 43);
      ctx.fillStyle = '#26374b'; ctx.font = 'bold 26px "Segoe UI"'; ctx.fillText('Syntetisk testbild', 40, 123);
      ctx.fillStyle = '#526475'; ctx.font = '18px "Segoe UI"'; ctx.fillText('Markera det som behöver förklaras.', 40, 158);
      ctx.fillStyle = '#ffffff'; ctx.fillRect(40, 194, width - 80, 120); ctx.fillStyle = '#26374b'; ctx.fillText('Kontakt: test@example.invalid', 62, 236); ctx.fillText('Status: Väntar på återkoppling', 62, 279);
      ctx.fillStyle = '#00a9e6'; ctx.fillRect(40, 350, 170, 45); ctx.fillStyle = '#062b3b'; ctx.fillText('Visa detaljer', 61, 379);
      if (options.gradient) { for (let x = 0; x < width; x++) { ctx.fillStyle = `rgb(${x % 256}, 90, 130)`; ctx.fillRect(x, 300, 1, height - 300); } }
      return await (await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'))).arrayBuffer();
    })();
    const host = root.editorHost = { ready: null as any,
      request: { id: 'source-1', capture: false, createdAt: new Date(2026, 9, 7, 9, 5, 3).getTime(), source: 'Microsoft Teams' } as any, files: [] as { name: string; bytes: number[] }[], saveAsCancel: false, saves: [] as { id: string; bytes: number[]; source: string }[], copies: [] as string[], closed: 0,
      loads: [] as string[], copyFailure: options.copyFailure ?? false, saveFailure: options.saveFailure ?? false, loadFailure: false,
      saveDelay: 0, listeners: [] as { event: string; target: unknown }[],
      emit(event: string, payload: unknown = null) { for (const id of events.get(event) ?? []) callbacks.get(id)?.({ event, id, payload }); },
    };
    root.isTauri = true;
    root.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'editor-1' }, currentWebview: { windowLabel: 'editor-1', label: 'editor-1' } },
      transformCallback(callback: (event: unknown) => void) { const id = ++callbackId; callbacks.set(id, callback); return id; },
      async invoke(command: string, args: any, invokeOptions: any) {
        if (command === 'plugin:event|listen') { host.listeners.push({ event: args.event, target: args.target }); events.set(args.event, [...(events.get(args.event) ?? []), args.handler]); return args.handler; }
        if (command === 'plugin:event|unlisten') { events.set(args.event, (events.get(args.event) ?? []).filter(id => id !== args.eventId)); return; }
        if (command === 'editor_request') return host.request;
        if (command === 'editor_ready') { host.ready = args; return; }
        if (command === 'editor_settings') return { theme: options.theme ?? 'light', language: options.language ?? 'en' };
        if (command === 'load_media') {
          if (!args.original || args.kind !== 'clip') throw new Error('Expected original PNG');
          host.loads.push(args.id); if (host.loadFailure) throw new Error('Bilden saknas'); return image();
        }
        if (command === 'save_edited_image') {
          if (host.saveDelay) await new Promise(resolve => setTimeout(resolve, host.saveDelay));
          if (host.saveFailure) throw new Error('Kunde inte skriva till databasen.');
          if (!(args instanceof ArrayBuffer)) throw new Error('Expected binary IPC');
          const id = 'saved-' + (host.saves.length + 1);
          host.saves.push({ id, bytes: Array.from(new Uint8Array(args)), source: invokeOptions.headers['x-source-id'], replaces: invokeOptions.headers['x-replace-id'] ?? null });
          return { id, copied: !host.copyFailure, error: host.copyFailure ? 'The image is saved, but the clipboard is busy.' : null };
        }
        if (command === 'save_image_file') { const name = decodeURIComponent(invokeOptions.headers['x-file-name']); host.files.push({ name, bytes: Array.from(new Uint8Array(args)) }); return host.saveAsCancel ? null : 'C:\\Users\\test\\Pictures\\' + name; }
        if (command === 'copy_clip') { host.copies.push(args.id); if (host.copyFailure) throw new Error('The clipboard is busy.'); return { pasted: false }; }
        if (command === 'close_editor') { host.closed++; return; }
        throw new Error('Unexpected command: ' + command);
      },
    };
    root.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  }, options);
}
export async function imagePoint(page: Page, x: number, y: number) {
  return page.locator('.editor-stage').evaluate((node, point) => {
    const r = node.getBoundingClientRect(), element = node as HTMLElement;
    return { x: r.x + Number(element.dataset.offsetX) + point.x * Number(element.dataset.zoom), y: r.y + Number(element.dataset.offsetY) + point.y * Number(element.dataset.zoom) };
  }, { x, y });
}
export async function dragImage(page: Page, from: [number, number], to: [number, number]) {
  const a = await imagePoint(page, ...from), b = await imagePoint(page, ...to);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up();
}
export async function savedPixels(page: Page, points: [number, number][]) {
  await page.waitForFunction(() => (window as any).editorHost.saves.length > 0);
  return page.evaluate(async points => {
    const saved = (window as any).editorHost.saves.at(-1);
    const image = await createImageBitmap(new Blob([new Uint8Array(saved.bytes)], { type: 'image/png' }));
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
    const result = { width: image.width, height: image.height, points: points.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data)) };
    image.close(); return result;
  }, points);
}

export async function captureEditor(page: Page, name: string) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  // Flush pending software raster work and verify the source image before capturing the compositor.
  const pixel = await page.locator('.editor-stage').evaluate(node => {
    const stage = node as HTMLElement, canvas = node.querySelector('canvas')!;
    const scale = canvas.width / stage.clientWidth;
    const x = (Number(stage.dataset.offsetX) + 10 * Number(stage.dataset.zoom)) * scale;
    const y = (Number(stage.dataset.offsetY) + 450 * Number(stage.dataset.zoom)) * scale;
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
    const index = (Math.floor(y) * canvas.width + Math.floor(x)) * 4;
    return Array.from(pixels.data.slice(index, index + 4));
  });
  expect(pixel).toEqual([246, 247, 251, 255]);
  await page.screenshot({ path: '.impeccable/review/' + name });
}
