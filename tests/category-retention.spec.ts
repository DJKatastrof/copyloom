import { expect, test } from '@playwright/test';

for (const language of ['en', 'sv'] as const) {
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
    await expect(dialog).toContainText(sv ? '1 clips kommer att raderas.' : '1 clips will be deleted.');
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
