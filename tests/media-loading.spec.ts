import { expect, test } from '@playwright/test';

const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
test('images load only near the view, with limited concurrency and reused icons', async ({ page }) => {
  await page.addInitScript(pixel => {
    const host = window as unknown as Record<string, unknown>;
    let id = 0, active = 0, revision = 1;
    const requests: string[] = [];
    host.mediaRequests = requests; host.maxMediaRequests = 0;
    const clips = Array.from({ length: 120 }, (_, index) => ({ id: 'image-' + index, title: 'Bild ' + index, content: 'copyloom-image:image-' + index, kind: 'image', createdAt: Date.now() - index * 1000, lastUsedAt: null, favorite: false, categoryIds: [], sourceApp: { id: 'editor', name: 'Editor', icon: 'copyloom-icon:editor' } }));
    const settings = { shortcut: 'Ctrl+Shift+V', retentionDays: null, theme: 'system' };
    const callbacks = new Map<number, (event: unknown) => void>(), listeners = new Map<string, number[]>();
    host.emitMediaEvent = (event: string) => { for (const handler of listeners.get(event) ?? []) callbacks.get(handler)?.({ event, id: handler, payload: null }); };
    host.isTauri = true;
    host.__TAURI_INTERNALS__ = { transformCallback: (callback: (event: unknown) => void) => { callbacks.set(++id, callback); return id; }, invoke: async (command: string, args: { event: string; handler: number; id: string; kind: string; original?: boolean; action: { type: string; id: string; value: boolean; at: number } }) => {
      if (command === 'load_library') return { revision, clips, categories: [], settings, paused: false, storage: 'encrypted' };
      if (command === 'load_media') {
        requests.push((args.original ? 'original' : args.kind) + ':' + args.id); active++; host.maxMediaRequests = Math.max(Number(host.maxMediaRequests), active);
        await new Promise(resolve => setTimeout(resolve, 25)); active--;
        return Array.from(atob(pixel), character => character.charCodeAt(0));
      }
      if (command === 'apply_action') {
        const clip = clips.find(clip => clip.id === args.action.id)!;
        if (args.action.type === 'favorite') clip.favorite = args.action.value;
        if (args.action.type === 'markUsed') clip.lastUsedAt = args.action.at as unknown as null;
        return { baseRevision: revision, revision: ++revision, upserted: [clip], removed: [], settings, paused: false, storage: 'encrypted' };
      }
      if (command === 'plugin:event|listen') { listeners.set(args.event, [...(listeners.get(args.event) ?? []), args.handler]); return args.handler; }
      if (command.startsWith('plugin:event|')) return ++id;
      return { pasted: false };
    }};
    host.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  }, pixel);
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Library', exact: true }).getByRole('button', { name: /All clips/ })).toContainText('120');
  await expect(page.locator('img.row-thumb').first()).toBeVisible();
  // The selected clip fills the preview pane in its original size.
  await expect(page.locator('.preview-pane img.clip-image')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { mediaRequests: string[] }).mediaRequests.length)).toBeGreaterThan(5);
  await expect(page.locator('.image-loading')).toHaveCount(0);
  const requests = await page.evaluate(() => (window as unknown as { mediaRequests: string[] }).mediaRequests);
  expect(requests.length).toBeLessThan(70);
  expect(requests.filter(request => request === 'icon:editor')).toHaveLength(1);
  expect(await page.evaluate(() => (window as unknown as { maxMediaRequests: number }).maxMediaRequests)).toBeLessThanOrEqual(3);
  await page.getByRole('button', { name: 'Favorite Bild 0', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove Bild 0 from favorites', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { mediaRequests: string[] }).mediaRequests.length)).toBe(requests.length);
  // A restored export may reuse IDs with different pixels: mounted previews must reload them.
  const oldSource = await page.locator('.preview-pane img.clip-image').getAttribute('src');
  await page.evaluate(() => (window as unknown as { emitMediaEvent: (event: string) => void }).emitMediaEvent('library:restored'));
  await expect.poll(() => page.locator('.preview-pane img.clip-image').getAttribute('src')).not.toBe(oldSource);
  await expect(page.locator('.preview-pane img.clip-image')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { mediaRequests: string[] }).mediaRequests.filter(request => request === 'clip:image-0').length)).toBe(2);
  await expect.poll(() => page.evaluate(() => (window as unknown as { mediaRequests: string[] }).mediaRequests.filter(request => request === 'original:image-0').length)).toBe(2);
  await page.screenshot({ path: '.impeccable/review/performance-images-light.png' });
  await page.locator('.clip-list').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(page.getByRole('button', { name: 'Show Bild 119', exact: true })).toBeVisible();
  await expect(page.locator('img.row-thumb').last()).toBeVisible();
  await page.setViewportSize({ width: 700, height: 820 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.getByRole('button', { name: 'Show Bild 119', exact: true })).toBeVisible();
  await expect(page.locator('.image-loading')).toHaveCount(0);
  await page.screenshot({ path: '.impeccable/review/performance-images-dark-small.png' });
  await page.getByRole('button', { name: 'Show Bild 119', exact: true }).dblclick();
  await expect(page.locator('.app-toast')).toContainText("Copied");
});
