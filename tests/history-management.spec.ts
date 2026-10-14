import { expect, test, type Page } from '@playwright/test';

async function host(page: Page, language = 'en') {
  await page.addInitScript(language => {
    const root = window as any; let callback = 0;
    const callbacks = new Map<number, (event: any) => void>(), events = new Map<string, number[]>();
    const library = { revision: 1, clips: [], categories: [], paused: false, storage: 'encrypted', storagePath: 'C:/Copyloom', settings: { shortcut: 'Ctrl+Shift+V', retentionDays: null, theme: 'light', language, excludedPrograms: [] as string[] } };
    const state = root.historyHost = { library, exports: [] as any[], restores: [] as any[], moves: [] as any[], failRestore: true, folder: 'D:/History', file: 'D:/Backup.copyloom', failUsage: false, usageReads: 0,
      usage: { clipCount: 120, imageCount: 30, imageBytes: 2_500_000, databaseBytes: 4_000_000, backupCount: 3, backupBytes: 12_000_000, otherBytes: 244 },
      emitLibrary() { for (const id of events.get('library:changed') ?? []) callbacks.get(id)?.({ event: 'library:changed', id, payload: { ...library } }); } };
    root.isTauri = true;
    root.__TAURI_INTERNALS__ = { transformCallback: (fn: (event: any) => void) => { const id = ++callback; callbacks.set(id, fn); return id; }, invoke: async (command: string, args: any) => {
      if (command === 'plugin:event|listen') { events.set(args.event, [...(events.get(args.event) ?? []), args.handler]); return args.handler; }
      if (command.startsWith('plugin:event|')) return ++callback;
      if (command === 'load_library') return library;
      if (command === 'get_autostart') return { enabled: false, currentExecutable: false };
      if (command === 'get_win_v') return { released: false, registered: false };
      if (command === 'get_storage_usage') { state.usageReads++; if (state.failUsage) throw 'Could not read storage usage. Check that the data folder is available and try again.'; return { ...state.usage }; }
      if (command === 'frontend_ready') return;
      if (command === 'apply_action') { if (args.action.type === 'setSettings') library.settings = args.action.settings; library.revision++; return { ...library }; }
      if (command === 'choose_excluded_program') return 'keepass.exe';
      if (command === 'choose_data_folder') return state.folder;
      if (command === 'move_data_folder') { state.moves.push(args); library.storagePath = args.path; return args.path; }
      if (command === 'choose_export_file') return state.file;
      if (command === 'export_history') { state.exports.push(args); return 'D:/Backup.copyloom'; }
      if (command === 'restore_history') { state.restores.push(args); if (state.failRestore) throw 'Could not open the export. Check the password and that the file is a complete Copyloom export.'; state.usage.clipCount = 5; return 5; }
      throw new Error('Unexpected bridge call: ' + command);
    }}; root.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  }, language);
  await page.goto('/'); await page.getByRole('button', { name: language === 'sv' ? 'Inställningar' : 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: language === 'sv' ? 'Inställningsområden' : 'Settings sections' }).getByRole('button', { name: language === 'sv' ? 'Historik' : 'History', exact: true }).click();
}

test('program exclusions validate executable names, avoid duplicates and can be removed', async ({ page }) => {
  await host(page);
  await page.getByRole('textbox', { name: 'Excluded programs' }).fill('bad/path.exe'); await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('executable name');
  await page.getByRole('textbox', { name: 'Excluded programs' }).fill('KEEPASS.EXE'); await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('.excluded-program-list li')).toHaveCount(1); await page.getByRole('button', { name: 'Choose program…' }).click(); await expect(page.locator('.excluded-program-list li')).toHaveCount(1);
  await page.getByRole('button', { name: 'Remove the exclusion for keepass.exe' }).click(); await expect(page.locator('.excluded-program-list li')).toHaveCount(0);
});

test('export asks for matching passwords and cancelling sends no export request', async ({ page }) => {
  await host(page); await page.getByRole('button', { name: 'Export…', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Export history' }); await expect(modal).toBeVisible();
  await modal.getByLabel('Export password', { exact: true }).fill('a long password'); await modal.getByLabel('Repeat password').fill('different password');
  await modal.getByRole('button', { name: 'Save export…' }).click(); await expect(modal.getByRole('alert')).toHaveText('Passwords do not match.');
  expect(await page.evaluate(() => (window as any).historyHost.exports)).toEqual([]);
  await page.keyboard.press('Escape'); await expect(modal).toHaveCount(0);
  await page.getByRole('button', { name: 'Export…', exact: true }).click(); await expect(page.getByLabel('Export password', { exact: true })).toHaveValue('');
  await page.getByLabel('Export password', { exact: true }).fill('a long password'); await page.getByLabel('Repeat password').fill('a long password'); await page.getByRole('button', { name: 'Save export…' }).click();
  await expect(page.locator('.app-toast')).toContainText('Export saved.'); expect(await page.evaluate(() => (window as any).historyHost.library.settings)).not.toHaveProperty('password');
});

test('restore describes replacement, stays open after a wrong password and reports a successful retry', async ({ page }) => {
  await host(page); await page.getByRole('button', { name: 'Restore…', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Restore history' }); await expect(modal).toContainText('replaces your 0 clips and categories');
  await modal.getByLabel('Export password', { exact: true }).fill('wrong password'); await modal.getByRole('button', { name: 'Restore and replace' }).click();
  await expect(modal.getByRole('alert')).toContainText('Check the password'); await expect(modal).toBeVisible();
  await page.evaluate(() => { (window as any).historyHost.failRestore = false; }); await modal.getByLabel('Export password', { exact: true }).fill('correct password'); await modal.getByRole('button', { name: 'Restore and replace' }).click();
  await expect(modal).toHaveCount(0); await expect(page.locator('.app-toast')).toContainText('History restored (5 clips).');
  await expect(page.locator('.storage-usage > div').filter({ has: page.locator('dt', { hasText: /^Clips$/ }) }).locator('dd')).toHaveText('5');
});

test('moving data waits for a concrete folder and confirmation; history settings fit at 700px', async ({ page }) => {
  await host(page); await expect(page.locator('.storage-usage')).toBeVisible(); const reads = await page.evaluate(() => (window as any).historyHost.usageReads);
  await page.getByRole('button', { name: 'Change data folder…' }).click();
  const modal = page.getByRole('dialog', { name: 'Change data folder?' }); await expect(modal).toContainText('D:/History'); expect(await page.evaluate(() => (window as any).historyHost.moves)).toEqual([]);
  await modal.getByRole('button', { name: 'Move history' }).click(); await expect(page.locator('.app-toast')).toContainText('Data folder changed.');
  expect(await page.evaluate(() => (window as any).historyHost.moves[0])).toEqual({ path: 'D:/History' });
  await expect.poll(() => page.evaluate(() => (window as any).historyHost.usageReads)).toBeGreaterThan(reads);
  await page.setViewportSize({ width: 700, height: 650 }); await page.screenshot({ path: '.impeccable/review/history-management-small.png' });
  expect(await page.locator('.settings-content').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
});

test('storage overview shows real totals, refreshes changed counts and recovers from an unavailable folder', async ({ page }) => {
  await host(page);
  const overview = page.getByRole('region', { name: 'Storage overview' }); await expect(overview).toBeVisible();
  const value = (label: string) => overview.locator('.storage-usage > div').filter({ has: page.locator('dt').filter({ hasText: new RegExp('^' + label + '$') }) }).locator('dd');
  await expect(value('Clips')).toHaveText('120'); await expect(value('Images')).toHaveText('30 · 2.5 MB');
  await expect(value('Database')).toHaveText('4 MB'); await expect(value('Backups')).toHaveText('3 · 12 MB'); await expect(value('Total on disk')).toHaveText('16 MB');
  await page.evaluate(() => { const state = (window as any).historyHost; state.usage.clipCount = 121; state.usage.imageCount = 31; state.usage.databaseBytes = 5_000_000; });
  await overview.getByRole('button', { name: 'Refresh storage overview' }).click(); await expect(value('Clips')).toHaveText('121'); await expect(value('Total on disk')).toHaveText('17 MB');
  await page.evaluate(() => { const state = (window as any).historyHost; state.usage.clipCount = 119; state.library.revision++; state.emitLibrary(); });
  await expect(value('Clips')).toHaveText('119');
  await page.evaluate(() => { (window as any).historyHost.failUsage = true; }); await overview.getByRole('button', { name: 'Refresh storage overview' }).click();
  await expect(overview.getByRole('alert')).toContainText('Check that the data folder is available'); await expect(overview.locator('.storage-usage')).toHaveCount(0);
  await page.evaluate(() => { const state = (window as any).historyHost; state.failUsage = false; state.usage = { clipCount: 0, imageCount: 0, imageBytes: 0, databaseBytes: 32768, backupCount: 0, backupBytes: 0, otherBytes: 244 }; });
  await overview.getByRole('button', { name: 'Try again', exact: true }).click(); await expect(value('Clips')).toHaveText('0'); await expect(value('Images')).toHaveText('0 · 0 B'); await expect(value('Total on disk')).toHaveText('33 KB');
});

for (const [language, width, theme] of [['sv', 1100, 'light'], ['en', 700, 'dark']] as const) {
  test(`storage overview fits ${language} at ${width}px in ${theme} theme`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 }); await host(page, language);
    await expect(page.locator('.storage-usage')).toBeVisible();
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.locator('.storage-overview').evaluate(node => node.scrollIntoView({ block: 'center' }));
    expect(await page.locator('.settings-content').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: `.impeccable/review/storage-overview-${language}-${theme}.png` });
  });
}
