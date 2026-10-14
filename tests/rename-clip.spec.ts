import { expect, test } from '@playwright/test';

for (const view of ['library', 'panel'] as const) {
  test('rename changes the heading, preserves content and cancels safely: ' + view, async ({ page }) => {
    const panel = view === 'panel';
    await page.setViewportSize(panel ? { width: 400, height: 480 } : { width: 1280, height: 820 });
    await page.goto(panel ? '/?view=panel' : '/');
    const original = await page.evaluate(async ({ panel }) => {
      const runtime = await import('/src/services/runtime.ts'), model = await import('/src/domain/library.ts');
      const library = await runtime.loadLibrary();
      await runtime.dispatch({ type: 'setSettings', settings: { ...library.settings, language: panel ? 'sv' : 'en', theme: panel ? 'dark' : 'light' } });
      const clip = { ...model.makeClip('Get-VM | Select-Object Name'), html: '<pre>Original</pre>', favorite: true };
      await runtime.dispatch({ type: 'addClip', clip }); return clip;
    }, { panel });
    // Both list the clip as a row; the library also names it in the preview.
    const card = page.locator('.clip-row'), focusTarget = card;
    if (panel) await expect(card).toHaveClass(/row-code/);
    else await expect(page.locator('.preview-meta')).toContainText('PowerShell');
    await focusTarget.focus(); await page.keyboard.press('Shift+F10');
    await page.screenshot({ path: `.impeccable/review/rename-menu-${view}.png` });
    await page.getByRole('menuitem', { name: panel ? 'Byt namn' : 'Rename', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: panel ? 'Byt namn på clip' : 'Rename clip' });
    const input = dialog.getByRole('textbox', { name: panel ? 'Namn' : 'Name', exact: true });
    await expect(input).toBeFocused(); await expect(input).toHaveValue(original.title);
    await expect(input).toHaveAttribute('maxlength', '120');
    await input.fill('  '); await expect(dialog.getByRole('button', { name: panel ? 'Spara' : 'Save', exact: true })).toBeDisabled();
    await input.fill('Mina servrar');
    await page.screenshot({ path: `.impeccable/review/rename-dialog-${view}.png` });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0); await expect(focusTarget).toBeFocused();
    if (!panel) await expect(page.locator('.preview-title')).toHaveCount(0);
    if (panel) await expect(page.locator('.quick-panel')).toBeVisible();
    await page.keyboard.press('Shift+F10'); await page.getByRole('menuitem', { name: panel ? 'Byt namn' : 'Rename', exact: true }).click();
    await input.fill('  Mina servrar  '); await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0); await expect(card).toContainText('Mina servrar');
    if (!panel) { await expect(page.locator('.preview-pane').getByRole('heading', { name: 'Mina servrar' })).toBeVisible(); await expect(page.locator('.preview-meta')).toContainText('PowerShell'); }
    const renamed = await page.evaluate(async () => (await (await import('/src/services/runtime.ts')).loadLibrary()).clips[0]);
    expect(renamed).toEqual({ ...original, title: 'Mina servrar', customTitle: true });
    await page.screenshot({ path: `.impeccable/review/rename-result-${view}.png` });
    await card.click({ button: 'right' }); await page.getByRole('menuitem', { name: panel ? 'Byt namn' : 'Rename', exact: true }).click();
    await expect(input).toHaveValue('Mina servrar');
    await dialog.getByRole('button', { name: panel ? 'Avbryt' : 'Cancel', exact: true }).click();
  });
}

test('native panel keeps rename open on save failure and Enter never copies the clip', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 480 });
  await page.addInitScript(() => {
    const root = window as any; let callback = 0;
    const clip = { id: 'test', title: 'Original', kind: 'text', content: 'Original content', createdAt: Date.now(), lastUsedAt: null, favorite: false, categoryIds: [] };
    const library = { revision: 1, clips: [clip], categories: [], settings: { shortcut: 'Ctrl+Shift+V', retentionDays: null, theme: 'light', language: 'en' }, paused: false, storage: 'encrypted' };
    root.renameHost = { attempts: 0, copies: 0, hidden: 0 };
    root.isTauri = true; root.__COPYLOOM_PANEL__ = true;
    root.__TAURI_INTERNALS__ = { transformCallback: () => ++callback, invoke: async (command: string, args: any) => {
      if (command.startsWith('plugin:event|')) return ++callback;
      if (command === 'load_library') return library;
      if (command === 'apply_action') {
        if (args.action.type !== 'renameClip') throw Error('Unexpected mutation');
        if (++root.renameHost.attempts === 1) throw 'Could not save. Try again.';
        library.clips[0] = { ...clip, title: args.action.title, customTitle: true } as typeof clip;
        return { ...library, revision: ++library.revision };
      }
      if (command === 'copy_clip') { root.renameHost.copies++; return { pasted: true }; }
      if (command === 'hide_panel') root.renameHost.hidden++;
    }}; root.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  });
  await page.goto('/?view=panel');
  await page.locator('.clip-row').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Rename clip' });
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Saved title'); await page.keyboard.press('Enter');
  await expect(dialog.getByRole('alert')).toContainText('Could not save');
  await expect(dialog.getByRole('textbox')).toHaveValue('Saved title');
  await page.screenshot({ path: '.impeccable/review/rename-error-panel.png' });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(page.locator('.clip-row')).toContainText('Saved title');
  expect(await page.evaluate(() => (window as any).renameHost)).toEqual({ attempts: 2, copies: 0, hidden: 0 });
});
