import { expect, test } from '@playwright/test';

for (const mode of ['normal', 'write-error', 'old-version'] as const) {
  test('autostart: ' + mode, async ({ page }) => {
    await page.addInitScript(({ mode }) => {
      const host = window as unknown as Record<string, unknown>;
      let callback = 0, revision = 1;
      let status = { enabled: mode === 'old-version', currentExecutable: false };
      let settings: Record<string, unknown> = { shortcut: 'Ctrl+Shift+V', retentionDays: 30, theme: 'light' };
      const library = () => ({ revision, clips: [], categories: [], paused: false, settings, storage: 'encrypted', storagePath: 'C:/Test/Copyloom' });
      host.autostartWrites = 0;
      host.isTauri = true;
      host.__TAURI_INTERNALS__ = {
        transformCallback: () => ++callback,
        invoke: async (command: string, args?: { enabled?: boolean; action?: { type: string; settings?: Record<string, unknown> } }) => {
          if (command === 'get_autostart') return status;
          if (command === 'set_autostart') {
            host.autostartWrites = Number(host.autostartWrites) + 1;
            if (mode === 'write-error') throw new Error("Windows did not allow the startup setting to change.");
            status = { enabled: !!args?.enabled, currentExecutable: !!args?.enabled };
            return status;
          }
          if (command === 'apply_action' && args?.action?.type === 'setSettings') { settings = args.action.settings!; revision++; return library(); }
          if (command.startsWith('plugin:event|')) return ++callback;
          if (command === 'load_library') return library();
          throw new Error('Unexpected call: ' + command);
        }
      };
      host.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    }, { mode });
    await page.goto('/');
    await page.getByRole('button', { name: "Settings", exact: true }).click();
    const start = page.getByRole('combobox', { name: "Start with Windows" });
    const writes = () => page.evaluate(() => (window as any).autostartWrites);
    await expect(start).toBeEnabled();
    if (mode === 'old-version') {
      await expect(start).toHaveText('Open the library');
      await expect(page.getByText('Startup points to another version of Copyloom.')).toBeVisible();
      await page.screenshot({ path: '.impeccable/review/autostart-repair.png' });
      // The repair takes effect at once; there is no separate save.
      await page.getByRole('button', { name: 'Update startup' }).click();
      await expect(page.getByText('Startup points to another version of Copyloom.')).toHaveCount(0);
      expect(await writes()).toBe(1);
      return;
    }
    await expect(start).toHaveText('Off');
    await start.click(); await page.getByRole('option', { name: 'In the system tray', exact: true }).click();
    if (mode === 'write-error') {
      await expect(page.getByRole('alert')).toContainText('Windows did not allow');
      await expect(start).toHaveText('Off');
      await page.screenshot({ path: '.impeccable/review/autostart-error.png' });
      return;
    }
    await expect(start).toHaveText('In the system tray');
    expect(await writes()).toBe(1);
    await page.screenshot({ path: '.impeccable/review/autostart-light.png' });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.screenshot({ path: '.impeccable/review/autostart-dark.png' });
    // Switching between tray and library start keeps the registration; only the start mode changes.
    await start.click(); await page.getByRole('option', { name: 'Open the library', exact: true }).click();
    await expect(start).toHaveText('Open the library');
    expect(await writes()).toBe(1);
    await page.getByRole('navigation', { name: "Library", exact: true }).getByRole('button', { name: "All clips", exact: false }).click();
    await page.getByRole('button', { name: "Settings", exact: true }).click();
    await expect(start).toHaveText('Open the library');
    await start.click(); await page.getByRole('option', { name: 'Off', exact: true }).click();
    await expect(start).toHaveText('Off');
    expect(await writes()).toBe(2);
  });
}

test('starting with Windows cannot be turned on in the browser preview', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: "Settings", exact: true }).click();
  await expect(page.getByRole('combobox', { name: "Start with Windows" })).toBeDisabled();
  await expect(page.locator('.setting-row').filter({ has: page.getByRole('combobox', { name: 'Start with Windows' }) }).getByText('Available in the Windows app.', { exact: true })).toBeVisible();
});
