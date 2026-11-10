import { expect, test } from '@playwright/test';

// found: what get_update returns at start; check: what check_for_update returns.
async function host(page: import('@playwright/test').Page, { found, check, panel = false }: { found: string | null; check?: string | null; panel?: boolean }) {
  await page.addInitScript(({ found, check, panel }) => {
    const host = window as unknown as Record<string, unknown>;
    let callback = 0, revision = 1;
    let settings: Record<string, unknown> = { shortcut: 'Ctrl+Shift+V', retentionDays: 30, theme: 'light' };
    const library = () => ({ revision, clips: [], categories: [], paused: false, settings, storage: 'encrypted', storagePath: 'C:/Test/Copyloom' });
    host.calls = [] as string[];
    host.isTauri = true;
    if (panel) host.__COPYLOOM_PANEL__ = true;
    host.__TAURI_INTERNALS__ = {
      transformCallback: () => ++callback,
      invoke: async (command: string, args?: { action?: { type: string; settings?: Record<string, unknown> } }) => {
        if (command.startsWith('plugin:event|')) return ++callback;
        (host.calls as string[]).push(command);
        if (command === 'get_update') return found ? { version: found } : null;
        if (command === 'check_for_update') return check ? { version: check } : null;
        if (command === 'install_update') return null;
        if (command === 'apply_action' && args?.action?.type === 'setSettings') { settings = args.action.settings!; revision++; return library(); }
        if (command === 'load_library') return library();
        if (command === 'get_autostart') return { enabled: false, currentExecutable: false };
        if (command === 'get_win_v') return { released: false, registered: false };
        return null;
      }
    };
    host.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  }, { found, check: check ?? null, panel });
}
const calls = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as { calls: string[] }).calls);

test('the library offers a found update in a toast that stays until used', async ({ page }) => {
  await host(page, { found: '0.1.40' });
  await page.goto('/');
  const toast = page.getByRole('status').filter({ hasText: 'Copyloom 0.1.40 is available.' });
  await expect(toast).toBeVisible();
  await page.waitForTimeout(4000);
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(page.getByText('Downloading the update…')).toBeVisible();
  expect(await calls(page)).toContain('install_update');
});

test('the quick panel never offers updates', async ({ page }) => {
  await host(page, { found: '0.1.40', panel: true });
  await page.goto('/?view=panel');
  await page.waitForTimeout(500);
  await expect(page.getByText('Copyloom 0.1.40 is available.')).toHaveCount(0);
});

test('Settings checks on request and switches the daily check off', async ({ page }) => {
  await host(page, { found: null, check: null });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Check now' }).click();
  await expect(page.getByText('You have the latest version.')).toBeVisible();
  const daily = page.getByRole('switch', { name: 'Check for updates' });
  await expect(daily).toBeChecked();
  await daily.click();
  await expect(daily).not.toBeChecked();
});

test('Settings offers a found update and installs it', async ({ page }) => {
  await host(page, { found: null, check: '0.1.40' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Check now' }).click();
  await page.getByRole('button', { name: 'Update to 0.1.40' }).click();
  await expect(page.getByRole('button', { name: 'Downloading…' })).toBeDisabled();
  expect(await calls(page)).toContain('install_update');
});
