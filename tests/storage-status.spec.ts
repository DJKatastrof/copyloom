import { expect, test } from '@playwright/test';

for (const available of [true, false]) {
  test(available ? 'desktop visar datamappen och kan öppna den' : 'lagringsfel visar paus och påstår inte att historiken sparas', async ({ page }) => {
    await page.addInitScript(({ available }) => {
      const host = window as unknown as Record<string, unknown>;
      let callbackId = 0;
      host.isTauri = true; host.opened = 0;
      host.__TAURI_INTERNALS__ = {
        transformCallback: () => ++callbackId,
        invoke: async (command: string) => {
          if (command === 'get_autostart') return { enabled: false, currentExecutable: false };
          if (command === 'get_storage_usage') return { clipCount: 0, imageCount: 0, imageBytes: 0, databaseBytes: 32768, backupCount: 0, backupBytes: 0, otherBytes: 244 };
          if (command === 'open_data_folder') { host.opened = Number(host.opened) + 1; return; }
          if (command === 'load_library') return {
            revision: 1, clips: [], categories: [], paused: !available,
            settings: { shortcut: 'Ctrl+Shift+V', retentionDays: 30, theme: 'light' },
            storage: available ? 'encrypted' : 'unavailable',
            storagePath: 'C:/Users/Test/AppData/Local/io.clipapp.desktop'
          };
          if (command.startsWith('plugin:event|')) return ++callbackId;
          throw new Error('Unexpected bridge call: ' + command);
        }
      };
      host.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    }, { available });
    await page.goto('/');
    // No reassurance label in the sidebar; only a real problem shows, as paused collection.
    await expect(page.getByText('Only on your computer')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Collection paused/ })).toHaveCount(available ? 0 : 1);
    await page.getByRole('button', { name: "Settings", exact: true }).click();
    await page.getByRole('navigation', { name: "Settings sections" }).getByRole('button', { name: "History", exact: true }).click();
    if (available) {
      await expect(page.getByText('C:/Users/Test/AppData/Local/io.clipapp.desktop', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Open folder', exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as any).opened)).toBe(1);
    } else {
      await expect(page.getByText("Could not open history. Collection is paused.")).toBeVisible();
      await expect(page.getByText('C:/Users/Test/AppData/Local/io.clipapp.desktop', { exact: true })).toHaveCount(0);
    }
  });
}
