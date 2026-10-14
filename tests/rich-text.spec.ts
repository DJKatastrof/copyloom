import { expect, test } from '@playwright/test';
import { loadSamples } from '../scripts/test-samples.mjs';

test('Enter and a click preserve formatting; Shift chooses plain text', async ({ page }) => {
  await page.addInitScript(() => {
    const host = window as unknown as Record<string, unknown>; host.isTauri = true; host.__COPYLOOM_PANEL__ = true;
    const callbacks = new Map<number, (event: unknown) => void>(); let callbackId = 0;
    const copies: { id: string; plain: boolean }[] = []; host.copies = copies;
    const library = { revision: 1, categories: [], paused: false, storage: 'encrypted', settings: { shortcut: 'Ctrl+Shift+V', retentionDays: null, theme: 'light' }, clips: [{ id: 'rich', title: 'Formatted text', content: 'Bold link', html: 'copyloom-html:rich', kind: 'text', createdAt: Date.now(), lastUsedAt: null, favorite: false, categoryIds: [] }] };
    host.__TAURI_INTERNALS__ = {
      transformCallback: (callback: (event: unknown) => void) => { callbacks.set(++callbackId, callback); return callbackId; },
      invoke: async (command: string, args: { id: string; plain: boolean }) => {
        if (command === 'load_library' || command === 'apply_action') return library;
        if (command === 'copy_clip') { copies.push({ id: args.id, plain: args.plain }); return { pasted: false }; }
        return callbackId;
      },
    };
    host.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  });
  await page.goto('/?view=panel');
  const card = page.getByRole('button', { name: 'Show Formatted text', exact: true });
  await expect(card).toBeVisible();
  await card.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Shift+Enter');
  await card.click(); await page.waitForTimeout(700); await card.click({ modifiers: ['Shift'] });
  await expect.poll(() => page.evaluate(() => (window as unknown as { copies: unknown[] }).copies)).toEqual([
    { id: 'rich', plain: false }, { id: 'rich', plain: true }, { id: 'rich', plain: false }, { id: 'rich', plain: true },
  ]);
});

test('paste mode saves and remains selected when reopening settings', async ({ page }) => {
  await page.goto('/'); await loadSamples(page);
  await page.getByRole('button', { name: "Settings", exact: true }).click();
  const mode = page.getByRole('combobox', { name: "When you use a clip" });
  await expect(mode).toContainText("Paste directly");
  await mode.click(); await page.getByRole('option', { name: "Copy to clipboard", exact: true }).click();
  await expect(mode).toContainText("Copy to clipboard");
  await page.getByRole('navigation', { name: "Library", exact: true }).getByRole('button', { name: "All clips", exact: false }).click();
  await page.getByRole('button', { name: "Settings", exact: true }).click();
  await expect(mode).toContainText("Copy to clipboard");
  await page.setViewportSize({ width: 700, height: 820 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
