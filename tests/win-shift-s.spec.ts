import { expect, test, type Page } from '@playwright/test';
import type { Action, Library } from '../src/domain/library';

type ScreenshotHost = {
  library: Library;
  letters: string;
  error: string;
  commands: string[];
  recording: boolean;
  emitShortcut?: (shortcut: string) => void;
};
type HostWindow = Window & { screenshotHost: ScreenshotHost };
async function host(page: Page, language: 'en' | 'sv' = 'en', saved = false, letters = 'V') {
  await page.addInitScript(({ language, saved, letters }) => {
    type Args = { event?: string; handler?: number; action?: Action; recording?: boolean };
    const root = window as HostWindow & {
      isTauri: boolean;
      __TAURI_INTERNALS__: { transformCallback: (callback: (event: unknown) => void) => number; invoke: (command: string, args: Args) => Promise<unknown> };
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => void };
    };
    const library: Library = { revision: 1, clips: [], categories: [], paused: false, storage: 'encrypted', settings: {
      shortcut: 'Ctrl+Shift+V', winV: true, captureShortcut: saved ? 'Shift+Super+S' : 'F8', retentionDays: 30, theme: 'light', language,
    } };
    const state: ScreenshotHost = root.screenshotHost = {
      library, letters, error: '', commands: [], recording: false,
    };
    let id = 0;
    const callbacks = new Map<number, (event: unknown) => void>(), listeners = new Map<string, number>();
    state.emitShortcut = shortcut => {
      callbacks.get(listeners.get('shortcut:recorded') ?? -1)?.({ event: 'shortcut:recorded', id: 2, payload: shortcut });
    };
    const changed = () => {
      library.revision++;
      callbacks.get(listeners.get('library:changed') ?? -1)?.({ event: 'library:changed', id: 1, payload: { ...library } });
      return { ...library };
    };
    const environment = () => ({ printScreenEnabled: false, registered: !!library.settings.captureShortcut });
    root.isTauri = true;
    root.__TAURI_INTERNALS__ = {
      transformCallback: callback => { callbacks.set(++id, callback); return id; },
      invoke: async (command, args) => {
        state.commands.push(command);
        if (command === 'plugin:event|listen' && args.event && args.handler) { listeners.set(args.event, args.handler); return ++id; }
        if (command.startsWith('plugin:event|')) return ++id;
        if (command === 'load_library') return library;
        if (command === 'frontend_ready') return;
        if (command === 'set_capture_recording') { state.recording = args.recording === true; return; }
        if (command === 'get_autostart') return { enabled: false, currentExecutable: false };
        if (command === 'get_win_v') return { released: true, registered: true };
        if (command === 'get_update') return null;
        if (command === 'get_capture_environment') return environment();
        if (command === 'apply_action' && args.action?.type === 'setSettings') {
          if (state.error) throw state.error;
          library.settings = args.action.settings;
          return changed();
        }
        throw Error(command);
      },
    };
    root.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  }, { language, saved, letters });
  await page.goto('/');
  await page.getByRole('button', { name: language === 'sv' ? 'Inställningar' : 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: language === 'sv' ? 'Inställningsområden' : 'Settings sections' })
    .getByRole('button', { name: language === 'sv' ? 'Skärmbild' : 'Screenshot', exact: true }).click();
}

const state = (page: Page) => page.evaluate(() => (window as HostWindow).screenshotHost);
const recorder = (page: Page) => page.getByRole('button', { name: 'Keyboard shortcut', exact: true });

async function enable(page: Page) {
  await recorder(page).click();
  await expect(recorder(page)).toHaveText('Press your key…');
  await page.keyboard.press('Shift+Meta+S');
  await expect(recorder(page)).toHaveText('Win+Shift+S');
}

test('recorded Win+Shift+S applies directly without changing search or history', async ({ page }) => {
  await host(page);
  await expect(page.getByRole('button', { name: 'Print Screen', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Win+Shift+S', exact: true })).toHaveCount(0);
  await enable(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Win+Shift+S takes screenshots in Copyloom. Win+S and Win+V are unchanged.')).toBeVisible();
  const result = await state(page);
  expect(result).toMatchObject({ letters: 'V', library: { settings: { winV: true, shortcut: 'Ctrl+Shift+V' } } });
  expect(result.commands).not.toContain('use_win_shift_s');
  expect(result.commands).not.toContain('set_win_v');
  expect(result.commands).not.toContain('restart_explorer');
  await page.screenshot({ path: '.impeccable/review/win-shift-s-selective-light.png' });
});

test('Windows-consumed keys reach the recorder through the temporary native listener', async ({ page }) => {
  await host(page);
  await recorder(page).click(); await expect(recorder(page)).toHaveText('Press your key…');
  await page.evaluate(() => (window as HostWindow).screenshotHost.emitShortcut?.('Shift+Super+S'));
  await expect(recorder(page)).toHaveText('Win+Shift+S');
  expect((await state(page)).recording).toBe(false);
  expect((await state(page)).letters).toBe('V');
});

test('native recording stops on Escape and focus loss, and late keys are ignored', async ({ page }) => {
  await host(page);
  await recorder(page).click(); await expect(recorder(page)).toHaveText('Press your key…');
  await page.keyboard.press('Escape');
  await expect(recorder(page)).toHaveText('F8');
  await page.evaluate(() => (window as HostWindow).screenshotHost.emitShortcut?.('Shift+Super+S'));
  await expect(recorder(page)).toHaveText('F8');
  await recorder(page).click(); await expect(recorder(page)).toHaveText('Press your key…');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(recorder(page)).toHaveText('F8');
  await expect.poll(async () => (await state(page)).recording).toBe(false);
  await page.evaluate(() => (window as HostWindow).screenshotHost.emitShortcut?.('PrintScreen'));
  await expect(recorder(page)).toHaveText('F8');
  expect((await state(page)).commands).not.toContain('restart_explorer');
});

test('custom combinations and native Print Screen remain available without presets', async ({ page }) => {
  await host(page);
  for (const [combo, label] of [['Control+Alt+K', 'Ctrl+Alt+K'], ['Shift+Meta+F8', 'Shift+Win+F8'], ['F9', 'F9']]) {
    await recorder(page).click(); await expect(recorder(page)).toHaveText('Press your key…');
    await page.keyboard.press(combo);
    await expect(recorder(page)).toHaveText(label);
  }
  await recorder(page).click(); await expect(recorder(page)).toHaveText('Press your key…');
  await page.evaluate(() => (window as HostWindow).screenshotHost.emitShortcut?.('PrintScreen'));
  await expect(recorder(page)).toHaveText('Print Screen');
  expect(await state(page)).toMatchObject({ letters: 'V', library: { settings: { winV: true, shortcut: 'Ctrl+Shift+V' } } });
});

test('changing or disabling the screenshot shortcut requires no Explorer restart', async ({ page }) => {
  await host(page); await enable(page);
  await recorder(page).click(); await expect(recorder(page)).toHaveText('Press your key…');
  await page.keyboard.press('Control+Alt+S');
  await expect(recorder(page)).toHaveText('Ctrl+Alt+S');
  await enable(page);
  await page.getByRole('button', { name: 'Turn off', exact: true }).click();
  await expect(recorder(page)).toHaveText('Off');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await state(page)).toMatchObject({ letters: 'V', library: { settings: { winV: true } } });
  expect((await state(page)).commands).not.toContain('restart_explorer');
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'General', exact: true }).click();
  await expect(recorder(page)).toHaveText('Win+V');
});

test('a saved selective shortcut reopens without recovery controls or confirmation', async ({ page }) => {
  await host(page, 'en', true);
  await expect(recorder(page)).toHaveText('Win+Shift+S');
  await expect(page.getByRole('button', { name: 'Restore Win+S', exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await state(page)).letters).toBe('V');
});

test('external S settings are not changed and do not offer restoration', async ({ page }) => {
  await host(page, 'en', true, 'VS');
  await expect(page.getByRole('button', { name: 'Restore Win+S', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Turn off', exact: true }).click();
  await expect(recorder(page)).toHaveText('Off');
  expect((await state(page)).letters).toBe('VS');
  expect((await state(page)).commands).not.toContain('restart_explorer');
});

test('Swedish selective shortcut fits a narrow dark settings window', async ({ page }) => {
  await host(page, 'sv');
  await page.setViewportSize({ width: 700, height: 740 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  const input = page.getByRole('button', { name: 'Kortkommando', exact: true });
  await input.click(); await expect(input).toHaveText('Tryck din tangent…');
  await page.keyboard.press('Shift+Meta+S');
  await expect(input).toHaveText('Win+Shift+S');
  await expect(page.getByText('Win+Shift+S tar skärmbilder i Copyloom. Win+S och Win+V ändras inte.')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.screenshot({ path: '.impeccable/review/win-shift-s-selective-sv-dark.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
