import { expect, test } from '@playwright/test';

test('the after-screenshot setting is saved and read back when switching views', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: "Settings", exact: true }).click();
  await page.getByRole('navigation', { name: "Settings sections" }).getByRole('button', { name: "Screenshot", exact: true }).click();
  const mode = page.getByRole('combobox', { name: "After screenshot", exact: true }); await expect(mode).toHaveText("Copy to clipboard");
  await mode.click(); await page.getByRole('option', { name: "Open in editor", exact: true }).click();
  await expect(mode).toHaveText("Open in editor");
  await page.getByRole('navigation', { name: "Library", exact: true }).getByRole('button', { name: /^All clips/ }).click();
  await page.getByRole('button', { name: "Settings", exact: true }).click(); await page.getByRole('navigation', { name: "Settings sections" }).getByRole('button', { name: "Screenshot", exact: true }).click();
  await expect(mode).toHaveText("Open in editor");
});

for (const panel of [false, true]) test('Edit opens the image editor for images and the text dialog for text in the ' + (panel ? 'panel' : 'bibliotek'), async ({ page }) => {
  await page.addInitScript(panel => {
    const root = window as any; let callback = 0; root.isTauri = true; root.__COPYLOOM_PANEL__ = panel; root.editorRequests = []; root.saveRequests = [];
    const clips = ['image', 'text'].map((kind, index) => ({ id: 'test-' + index, title: kind === 'image' ? 'Testbild' : 'Testtext', kind, content: kind === 'image' ? 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' : 'Hej', createdAt: Date.now(), lastUsedAt: null, favorite: false, categoryIds: [] }));
    root.__TAURI_INTERNALS__ = { transformCallback: () => ++callback, invoke: async (command: string, args: any) => {
      if (command === 'load_library') return { revision: 1, clips, categories: [], settings: { shortcut: 'Ctrl+Shift+V', retentionDays: null, theme: 'light' }, storage: 'encrypted', paused: false };
      if (command === 'open_editor') { root.editorRequests.push(args.id); return; }
      if (command === 'save_clip_image') { root.saveRequests.push(args); return 'C:\\Pictures\\' + args.name; }
      if (command.startsWith('plugin:event|')) return ++callback;
      return {};
    }}; root.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  }, panel);
  await page.goto('/'); await page.getByRole('button', { name: 'Show Testbild', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: "Edit", exact: true }).click();
  expect(await page.evaluate(() => (window as any).editorRequests)).toEqual(['test-0']);
  // Save as exports the stored original under program and capture time; Copyloom when the program is unknown.
  await page.getByRole('button', { name: 'Show Testbild', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: "Save as…", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).saveRequests.length)).toBe(1);
  const request = await page.evaluate(() => (window as any).saveRequests[0]);
  expect(request.id).toBe('test-0'); expect(request.name).toMatch(/^Copyloom \d{4}-\d\d-\d\d \d{6}\.png$/);
  if (!panel) await expect(page.getByRole('status').filter({ hasText: 'Saved as ' + request.name })).toBeVisible();
  await page.getByRole('button', { name: 'Show Testtext', exact: true }).click({ button: 'right' }); await page.getByRole('menuitem', { name: "Edit", exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Edit text' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).editorRequests)).toEqual(['test-0']);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Show Testtext', exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: "Save as…", exact: true })).toHaveCount(0);
});
