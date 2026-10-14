import { expect, test } from '@playwright/test';
import { loadSamples } from '../scripts/test-samples.mjs';

test('category actions and the category filter work directly in the panel', async ({ page }) => {
  await page.goto('/'); await loadSamples(page);
  await page.evaluate(async () => {
    const path = '/src/services/runtime.ts', runtime = await import(path);
    for (const [id, name, color] of [['scripts', 'Scripts', '#00a9e6'], ['work', 'Arbete', '#fa9214']]) {
      await runtime.dispatch({ type: 'addCategory', category: { id, name, color, clipOrder: [] } });
    }
  });
  await page.getByRole('button', { name: "Quick panel", exact: true }).click();
  const note = page.getByRole('button', { name: 'Show Projektanteckningar', exact: true });
  await note.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Add to category', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Scripts', exact: true }).click();
  await expect(page.locator('.clip-context-menu')).toHaveCount(0);
  await expect(page.locator('.quick-panel')).toBeVisible();
  const filter = page.getByRole('combobox', { name: 'Filter quick panel' });
  await filter.click(); await page.getByRole('option', { name: 'Scripts', exact: true }).click();
  await expect(note).toBeVisible();
  await expect(page.locator('.quick-panel .clip-row')).toHaveCount(1);
  await note.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Add to category', exact: true }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Scripts', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('menuitemcheckbox', { name: 'Arbete', exact: true }).click();
  // Adding to a second category preserves the first membership.
  await filter.click(); await page.getByRole('option', { name: 'Arbete', exact: true }).click();
  await expect(note).toBeVisible();
  await filter.click(); await page.getByRole('option', { name: 'Scripts', exact: true }).click();
  await expect(note).toBeVisible();
  await page.screenshot({ path: '.impeccable/review/qol-category-panel.png' });
});

test('native reopen resets the mounted panel; arrows, Enter and a click use the clip', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 480 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    const host = window as unknown as Record<string, unknown>;
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<string, number>(); let id = 0, epoch = 0;
    const calls: string[] = []; host.nativeCalls = calls;
    const copiedIds: string[] = []; host.copiedIds = copiedIds;
    const emit = (event: string, payload: unknown) => callbacks.get(listeners.get(event)! )?.({ event, id: 1, payload });
    host.emitNative = emit;
    host.isTauri = true;
    host.__COPYLOOM_PANEL__ = true;
    host.__TAURI_INTERNALS__ = {
      transformCallback: (callback: (event: unknown) => void) => { callbacks.set(++id, callback); return id; },
      invoke: async (command: string, args: { event: string; handler: number; view: string; id: string }) => {
        calls.push(command);
        if (command === 'plugin:event|listen') { listeners.set(args.event, args.handler); return ++id; }
        if (command === 'load_library') return { revision: 1, categories: [], paused: false, storage: 'encrypted', settings: { shortcut: 'Ctrl+Shift+V', retentionDays: null, theme: 'dark' }, clips: Array.from({ length: 120 }, (_, index) => ({ id: 'clip-' + index, title: 'Note ' + index, content: 'Ordinary text ' + index, kind: 'text', createdAt: Date.now() - index * 1000, lastUsedAt: null, favorite: false, categoryIds: [] })) };
        if (command === 'copy_clip') { copiedIds.push(args.id); return { pasted: true }; }
        if (command === 'apply_action') return { revision: 0, clips: [], categories: [], paused: false, storage: 'encrypted', settings: { shortcut: 'Ctrl+Shift+V', retentionDays: null, theme: 'dark' } };
        if (command === 'change_view') { emit('view:changed', args.view); if (args.view === 'panel') emit('panel:prepared', ++epoch); }
        return undefined;
      },
    };
    host.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  });
  await page.goto('/?view=panel');
  const row = (index: number) => page.getByRole('button', { name: 'Show Note ' + index, exact: true });
  const copied = () => page.evaluate(() => (window as unknown as { copiedIds: string[] }).copiedIds);
  await expect(row(0)).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(row(1)).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ArrowUp');
  await expect(row(0)).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect.poll(copied).toEqual(['clip-1']);
  // Typing on the list searches; Escape clears the search before it closes the panel.
  await page.keyboard.type('Note 119');
  await expect(page.getByRole('textbox', { name: 'Search your clips' })).toHaveValue('Note 119');
  await expect(page.locator('.clip-row')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('textbox', { name: 'Search your clips' })).toHaveValue('');
  const list = page.locator('.clip-list');
  await list.evaluate(element => { element.scrollTop = 1800; });
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(1500);
  // Native hide keeps the view and DOM mounted; then the same view opens again at the top.
  await page.evaluate(() => {
    const host = window as unknown as { emitNative: (event: string, payload: unknown) => void };
    host.emitNative('panel:closing', 1); host.emitNative('view:changed', 'panel'); host.emitNative('panel:prepared', 2);
  });
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBe(0);
  await expect(row(0)).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Enter');
  await expect.poll(copied).toEqual(['clip-1', 'clip-0']);
  // One click uses a clip; the second click of a double-click does not paste it again.
  await row(2).dblclick();
  await expect.poll(copied).toEqual(['clip-1', 'clip-0', 'clip-2']);
  await page.waitForTimeout(700); expect(await copied()).toHaveLength(3);
  const geometry = await page.evaluate(() => ({ documentHeight: document.documentElement.scrollHeight, viewport: innerHeight, animations: document.getAnimations().length }));
  expect(geometry.documentHeight).toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.animations).toBe(0);
  // The mouse wheel scrolls the list itself, not the page.
  await page.mouse.move(200, 240); await page.mouse.wheel(0, 300);
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(200);
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await page.screenshot({ path: '.impeccable/review/qol-native-panel.png' });
});

test('selected clips can be dragged together and removed through the category menu', async ({ page }) => {
  await page.goto('/'); await loadSamples(page);
  await page.evaluate(async () => {
    const path = '/src/services/runtime.ts', runtime = await import(path);
    await runtime.dispatch({ type: 'addCategory', category: { id: 'work', name: 'Arbete', color: '#00a9e6', clipOrder: [] } });
  });
  const first = page.getByRole('button', { name: 'Show Projektanteckningar', exact: true });
  const second = page.getByRole('button', { name: 'Show En liten kodsnutt', exact: true });
  await first.click(); await second.click({ modifiers: ['Control'] });
  await first.dragTo(page.getByRole('navigation', { name: "Categories" }).getByRole('button', { name: /Arbete/ }));
  await page.getByRole('navigation', { name: "Categories" }).getByRole('button', { name: /Arbete/ }).click();
  await expect(page.locator('.clip-row')).toHaveCount(2);
  await first.click(); await second.click({ modifiers: ['Control'] });
  await first.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Add to category', exact: true }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Arbete', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('menuitem', { name: 'Remove from categories', exact: true }).click();
  await expect(page.locator('.clip-row')).toHaveCount(0);
  await page.getByRole('navigation', { name: "Library", exact: true }).getByRole('button', { name: /All clips/ }).click();
  await expect(page.locator('.clip-row')).toHaveCount(6);
});
