import { expect, test } from '@playwright/test';

for (const language of ['en', 'sv'] as const) {
  test('shorter retention always asks, but longer retention applies directly: ' + language, async ({ page }) => {
    const sv = language === 'sv';
    await page.goto('/'); await page.locator('.loading-state').waitFor({ state: 'hidden' });
    await page.evaluate(async language => {
      const runtime = await import('/src/services/runtime.ts'), model = await import('/src/domain/library.ts');
      const library = await runtime.loadLibrary();
      await runtime.dispatch({ type: 'setSettings', settings: { ...library.settings, language, keepCategorized: true, theme: language === 'sv' ? 'dark' : 'light' } });
      await runtime.dispatch({ type: 'addCategory', category: { id: 'work', name: 'Work', color: '#00a9e6', clipOrder: [] } });
      await runtime.dispatch({ type: 'addClip', clip: model.makeClip('Recent clip') });
      await runtime.dispatch({ type: 'addClip', clip: { ...model.makeClip('Old favorite', Date.now() - 40 * 86400000), favorite: true } });
      await runtime.dispatch({ type: 'addClip', clip: { ...model.makeClip('Old categorized clip', Date.now() - 40 * 86400000), categoryIds: ['work'] } });
    }, language);
    await page.getByRole('button', { name: sv ? 'Inställningar' : 'Settings', exact: true }).click();
    await page.getByRole('navigation', { name: sv ? 'Inställningsområden' : 'Settings sections' }).getByRole('button', { name: sv ? 'Historik' : 'History', exact: true }).click();
    const retention = page.getByRole('combobox', { name: sv ? 'Spara clips i' : 'Keep clips for', exact: true });
    const choose = async (label: string) => { await retention.click(); await page.getByRole('option', { name: label, exact: true }).click(); };
    const state = () => page.evaluate(async () => { const library = await (await import('/src/services/runtime.ts')).loadLibrary(); return { days: library.settings.retentionDays, clips: library.clips.length }; });
    const dialog = page.getByRole('dialog', { name: sv ? 'Ändra lagringstiden?' : 'Change how long clips are kept?' });
    const cancel = dialog.getByRole('button', { name: sv ? 'Avbryt' : 'Cancel', exact: true });
    await choose(sv ? '7 dagar' : '7 days');
    await expect(dialog).toContainText(sv ? 'Clips äldre än 7 dagar kommer att raderas automatiskt.' : 'Clips older than 7 days will be deleted automatically.');
    await expect(dialog).toContainText(sv ? 'Inga clips kommer att raderas nu.' : 'No clips will be deleted now.');
    await expect(dialog).toContainText(sv ? 'Favoriter och clips i kategorier behålls.' : 'Favorites and clips in categories are kept.');
    await expect(cancel).toBeFocused(); expect(await state()).toEqual({ days: 30, clips: 3 });
    if (sv) await page.setViewportSize({ width: 740, height: 650 });
    await page.screenshot({ path: `.impeccable/review/shorter-retention-empty-${language}.png` });
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); expect(await state()).toEqual({ days: 30, clips: 3 });
    await choose(sv ? '7 dagar' : '7 days'); await cancel.click(); expect(await state()).toEqual({ days: 30, clips: 3 });
    await choose(sv ? '7 dagar' : '7 days'); await page.mouse.click(5, 5); await expect(dialog).toBeVisible(); expect(await state()).toEqual({ days: 30, clips: 3 });
    await dialog.getByRole('button', { name: sv ? 'Ändra lagringstid' : 'Change retention', exact: true }).click();
    await expect.poll(state).toEqual({ days: 7, clips: 3 });
    await choose(sv ? '30 dagar' : '30 days'); await expect(dialog).toHaveCount(0); await expect.poll(state).toEqual({ days: 30, clips: 3 });
    await choose(sv ? 'För alltid' : 'Forever'); await expect(dialog).toHaveCount(0); await expect.poll(state).toEqual({ days: null, clips: 3 });
    await choose(sv ? '90 dagar' : '90 days'); await expect(dialog).toBeVisible(); await cancel.click(); expect(await state()).toEqual({ days: null, clips: 3 });
    await choose(sv ? 'Egen' : 'Custom');
    const days = page.getByRole('spinbutton', { name: sv ? 'Antal dagar' : 'Number of days' }), save = page.getByRole('button', { name: sv ? 'Spara' : 'Save', exact: true });
    await days.fill('14'); await save.click(); await expect(dialog).toContainText(sv ? '14 dagar' : '14 days'); await cancel.click();
    expect(await state()).toEqual({ days: null, clips: 3 });
    await save.click(); await dialog.getByRole('button', { name: sv ? 'Ändra lagringstid' : 'Change retention', exact: true }).click();
    await expect.poll(state).toEqual({ days: 14, clips: 3 });
    await days.fill('21'); await save.click(); await expect(dialog).toHaveCount(0); await expect.poll(state).toEqual({ days: 21, clips: 3 });
    await days.fill('14'); await save.click(); await expect(dialog).toBeVisible(); await cancel.click(); expect(await state()).toEqual({ days: 21, clips: 3 });
  });

  test('shortening a preset shows the deletion count and preserves protected clips: ' + language, async ({ page }) => {
    const sv = language === 'sv';
    await page.goto('/'); await page.locator('.loading-state').waitFor({ state: 'hidden' });
    await page.evaluate(async language => {
      const runtime = await import('/src/services/runtime.ts'), model = await import('/src/domain/library.ts');
      const library = await runtime.loadLibrary();
      await runtime.dispatch({ type: 'setSettings', settings: { ...library.settings, language, retentionDays: null, keepCategorized: true } });
      await runtime.dispatch({ type: 'addCategory', category: { id: 'work', name: 'Work', color: '#00a9e6', clipOrder: [] } });
      for (const content of ['Old clip one', 'Old clip two']) await runtime.dispatch({ type: 'addClip', clip: model.makeClip(content, Date.now() - 40 * 86400000) });
      await runtime.dispatch({ type: 'addClip', clip: { ...model.makeClip('Old favorite', Date.now() - 40 * 86400000), favorite: true } });
      await runtime.dispatch({ type: 'addClip', clip: { ...model.makeClip('Old categorized clip', Date.now() - 40 * 86400000), categoryIds: ['work'] } });
    }, language);
    await page.getByRole('button', { name: sv ? 'Inställningar' : 'Settings', exact: true }).click();
    await page.getByRole('navigation', { name: sv ? 'Inställningsområden' : 'Settings sections' }).getByRole('button', { name: sv ? 'Historik' : 'History', exact: true }).click();
    const retention = page.getByRole('combobox', { name: sv ? 'Spara clips i' : 'Keep clips for', exact: true });
    await retention.click(); await page.getByRole('option', { name: sv ? '30 dagar' : '30 days', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: sv ? 'Ändra lagringstiden?' : 'Change how long clips are kept?' });
    await expect(dialog).toContainText(sv ? '2 clips kommer att raderas nu.' : '2 clips will be deleted now.');
    await page.mouse.click(5, 5); await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: sv ? 'Avbryt' : 'Cancel', exact: true }).click();
    const state = () => page.evaluate(async () => { const library = await (await import('/src/services/runtime.ts')).loadLibrary(); return { days: library.settings.retentionDays, clips: library.clips.map(clip => clip.content).sort() }; });
    expect((await state()).days).toBeNull(); expect((await state()).clips).toHaveLength(4);
    await retention.click(); await page.getByRole('option', { name: sv ? '30 dagar' : '30 days', exact: true }).click();
    await dialog.getByRole('button', { name: sv ? 'Ändra och radera' : 'Change and delete', exact: true }).click();
    await expect.poll(state).toEqual({ days: 30, clips: ['Old categorized clip', 'Old favorite'] });
  });

  test('custom retention validates days and confirms before deleting: ' + language, async ({ page }) => {
    const sv = language === 'sv';
    await page.goto('/');
    await page.locator('.loading-state').waitFor({ state: 'hidden' });
    await page.evaluate(async language => {
      const runtime = await import('/src/services/runtime.ts'), model = await import('/src/domain/library.ts');
      const library = await runtime.loadLibrary();
      await runtime.dispatch({ type: 'setSettings', settings: { ...library.settings, language } });
      await runtime.dispatch({ type: 'addClip', clip: model.makeClip('Old clip', Date.now() - 20 * 86400000) });
      await runtime.dispatch({ type: 'addClip', clip: { ...model.makeClip('Old favorite', Date.now() - 20 * 86400000), favorite: true } });
    }, language);
    await expect(page.locator('.library-header').getByRole('button', { name: sv ? 'Snabbpanel' : 'Quick panel', exact: true })).toHaveCount(0);
    await expect(page.locator('.library-header').getByRole('button', { name: sv ? 'Lägg till' : 'Add', exact: true })).toHaveCount(0);
    const openHistory = async () => {
      await page.getByRole('button', { name: sv ? 'Inställningar' : 'Settings', exact: true }).click();
      await page.getByRole('navigation', { name: sv ? 'Inställningsområden' : 'Settings sections' }).getByRole('button', { name: sv ? 'Historik' : 'History', exact: true }).click();
    };
    await openHistory();
    const retention = page.getByRole('combobox', { name: sv ? 'Spara clips i' : 'Keep clips for', exact: true });
    await retention.click(); await page.getByRole('option', { name: sv ? 'Egen' : 'Custom', exact: true }).click();
    const days = page.getByRole('spinbutton', { name: sv ? 'Antal dagar' : 'Number of days' }), save = page.getByRole('button', { name: sv ? 'Spara' : 'Save', exact: true });
    const state = () => page.evaluate(async () => { const library = await (await import('/src/services/runtime.ts')).loadLibrary(); return { days: library.settings.retentionDays, clips: library.clips.length }; });
    for (const invalid of ['', '0', '1.5', '36501']) { await days.fill(invalid); await expect(save).toBeDisabled(); }
    await days.fill('14'); expect(await state()).toEqual({ days: 30, clips: 2 });
    await save.click();
    const dialog = page.getByRole('dialog', { name: sv ? 'Ändra lagringstiden?' : 'Change how long clips are kept?' });
    await expect(dialog).toContainText(sv ? '1 clip kommer att raderas nu.' : '1 clip will be deleted now.');
    await page.mouse.click(5, 5); await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: sv ? 'Avbryt' : 'Cancel', exact: true }).click();
    expect(await state()).toEqual({ days: 30, clips: 2 });
    await save.click(); await dialog.getByRole('button', { name: sv ? 'Ändra och radera' : 'Change and delete', exact: true }).click();
    await expect.poll(state).toEqual({ days: 14, clips: 1 });
    await page.getByRole('navigation', { name: sv ? 'Bibliotek' : 'Library', exact: true }).getByRole('button', { name: sv ? /Alla clips/ : /All clips/ }).click();
    await openHistory(); await expect(days).toHaveValue('14');
    await page.setViewportSize({ width: 740, height: 840 });
    await page.screenshot({ path: `.impeccable/review/custom-retention-${language}.png` });
    await retention.click(); await page.getByRole('option', { name: sv ? 'För alltid' : 'Forever', exact: true }).click();
    await expect.poll(state).toEqual({ days: null, clips: 1 }); await expect(days).toHaveCount(0);
  });

  test('category retention can be saved and disabling it asks before deletion: ' + language, async ({ page }) => {
    const sv = language === 'sv';
    await page.goto('/');
    await page.evaluate(async ({ language }) => {
      const runtime = await import('/src/services/runtime.ts');
      const model = await import('/src/domain/library.ts');
      const library = await runtime.loadLibrary();
      await runtime.dispatch({ type: 'setSettings', settings: { ...library.settings, language, theme: language === 'sv' ? 'dark' : 'light' } });
      await runtime.dispatch({ type: 'addCategory', category: { id: 'work', name: 'Work', color: '#00a9e6', clipOrder: [] } });
      for (const [content, favorite] of [['Saved in category', false], ['Favorite', true]] as const) {
        await runtime.dispatch({ type: 'addClip', clip: { ...model.makeClip(content, Date.now() - 40 * 86400000), categoryIds: ['work'], favorite } });
      }
    }, { language });
    const settingsButton = page.getByRole('button', { name: sv ? 'Inställningar' : 'Settings', exact: true });
    const historyTab = page.getByRole('navigation', { name: sv ? 'Inställningsområden' : 'Settings sections' }).getByRole('button', { name: sv ? 'Historik' : 'History', exact: true });
    await settingsButton.click(); await historyTab.click();
    const protect = page.getByRole('switch', { name: sv ? 'Behåll clips i kategorier' : 'Keep clips in categories' });
    await expect(protect).not.toBeChecked();
    await protect.check();
    const savedState = () => page.evaluate(async () => (await (await import('/src/services/runtime.ts')).loadLibrary()).settings.keepCategorized);
    // Turning protection on never deletes anything, so it applies without asking.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await savedState()).toBe(true);
    await page.getByRole('navigation', { name: sv ? 'Bibliotek' : 'Library', exact: true }).getByRole('button', { name: sv ? /Alla clips/ : /All clips/ }).click();
    await expect(page.locator('.clip-row')).toHaveCount(2);
    await page.getByRole('navigation', { name: sv ? 'Kategorier' : 'Categories', exact: true }).getByRole('button', { name: /Work/ }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: sv ? 'Ta bort kategori' : 'Delete category' }).click();
    await expect(page.getByRole('dialog')).toContainText(sv ? 'kan raderas vid nästa rensning' : 'may be deleted at the next cleanup');
    await page.keyboard.press('Escape');
    await settingsButton.click(); await historyTab.click(); await expect(protect).toBeChecked();
    if (sv) await page.setViewportSize({ width: 740, height: 840 });
    await protect.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `.impeccable/review/category-retention-${language}.png` });
    await protect.click();
    const dialog = page.getByRole('dialog', { name: sv ? 'Ändra lagringstiden?' : 'Change how long clips are kept?' });
    await expect(dialog).toContainText(sv ? '1 clip kommer att raderas nu.' : '1 clip will be deleted now.');
    await page.screenshot({ path: `.impeccable/review/category-retention-confirm-${language}.png` });
    await dialog.getByRole('button', { name: sv ? 'Avbryt' : 'Cancel', exact: true }).click();
    expect(await savedState()).toBe(true); await expect(protect).toBeChecked();
    await protect.click(); await dialog.getByRole('button', { name: sv ? 'Ändra och radera' : 'Change and delete' }).click();
    await expect(protect).not.toBeChecked();
    expect(await savedState()).toBe(false);
    await page.getByRole('navigation', { name: sv ? 'Bibliotek' : 'Library', exact: true }).getByRole('button', { name: sv ? /Alla clips/ : /All clips/ }).click();
    await expect(page.locator('.clip-row')).toHaveCount(1);
    await expect(page.locator('.clip-row')).toContainText('Favorite');
  });
}
