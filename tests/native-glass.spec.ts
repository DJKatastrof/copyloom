import { expect, test } from '@playwright/test';

for (const theme of ['light', 'dark']) {
  test('native panel keeps transparent corners and a light overlay: ' + theme, async ({ page }) => {
    await page.addInitScript(theme => {
      const host = window as unknown as Record<string, unknown>;
      let id = 0;
      host.isTauri = true;
      host.__TAURI_INTERNALS__ = { transformCallback: () => ++id, invoke: async (command: string) => {
        if (command === 'load_library') return { revision: 1, clips: [], categories: [], paused: false, settings: { shortcut: 'Ctrl+Shift+V', retentionDays: 30, theme }, storage: 'encrypted', storagePath: null };
        if (command.startsWith('plugin:event|')) return ++id;
        return undefined;
      }};
      host.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    }, theme);
    await page.goto('/?view=panel');
    const panel = page.locator('.panel-mode:not(.browser-preview) .quick-panel');
    await expect(panel).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const colors = await panel.evaluate(element => ({
      html: getComputedStyle(document.documentElement).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor,
      panel: getComputedStyle(element).backgroundColor,
      radius: getComputedStyle(element).borderTopLeftRadius,
    }));
    expect(colors.html).toBe('rgba(0, 0, 0, 0)');
    expect(colors.body).toBe('rgba(0, 0, 0, 0)');
    expect(colors.panel).toBe(theme === 'dark' ? 'rgba(36, 36, 38, 0.84)' : 'rgba(249, 249, 249, 0.84)');
    expect(colors.radius).toBe('8px');
  });
}
