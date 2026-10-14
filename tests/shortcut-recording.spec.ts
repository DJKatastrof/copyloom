import { expect, test } from '@playwright/test';
test('native recorders pause shortcuts and can restore the previous command without restarting', async ({ page }) => {
  await page.addInitScript(() => {
    const host = window as unknown as Record<string, unknown>;
    let next = 0;
    let library = { revision: 1, clips: [], categories: [], paused: false, settings: { shortcut: 'Ctrl+Shift+V', captureShortcut: null as string | null, retentionDays: 30, theme: 'light' }, storage: 'encrypted' };
    const recordings: boolean[] = []; host.recordings = recordings;
    host.isTauri = true;
    host.__TAURI_INTERNALS__ = { transformCallback: () => ++next, invoke: async (command: string, args?: any) => {
      if (command.startsWith('plugin:event|')) return ++next;
      if (command === 'load_library') return library;
      if (command === 'frontend_ready') return;
      if (command === 'get_autostart') return { enabled: false, currentExecutable: false };
      if (command === 'set_capture_recording') { recordings.push(args.recording); return; }
      if (command === 'apply_action') { if (args.action.type === 'setSettings') library.settings = args.action.settings; library.revision++; return { ...library }; }
      throw new Error('Unexpected command: ' + command);
    }};
    host.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  });
  await page.goto('/'); await page.getByRole('button', { name: "Settings", exact: true }).click();
  const panel = page.getByRole('button', { name: "Keyboard shortcut", exact: true });
  for (const [key, text] of [['Control+Shift+X', 'Ctrl+Shift+X'], ['Control+Shift+V', 'Ctrl+Shift+V']]) {
    await panel.click(); await expect.poll(() => page.evaluate(() => (window as any).recordings.at(-1))).toBe(true);
    await page.keyboard.press(key); await expect(panel).toHaveText(text);
    await expect.poll(() => page.evaluate(() => (window as any).recordings.at(-1))).toBe(false);
    await expect.poll(() => page.evaluate(() => (window as any).recordings.length)).toBeGreaterThan(0); await expect(panel).toHaveText(text);
  }
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Screenshot', exact: true }).click();
  const capture = page.locator('.settings-section').getByRole('button', { name: "Keyboard shortcut", exact: true });
  await capture.click(); await expect.poll(() => page.evaluate(() => (window as any).recordings.at(-1))).toBe(true);
  await page.keyboard.press('Control+Alt+F11'); await expect(capture).toHaveText('Ctrl+Alt+F11');
  await expect.poll(() => page.evaluate(() => (window as any).recordings.at(-1))).toBe(false);
  await capture.click(); await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => (window as any).recordings.at(-1))).toBe(false);
  await expect(capture).toHaveText('Ctrl+Alt+F11');
  await expect(page.locator('.quick-panel')).toHaveCount(0);
});
