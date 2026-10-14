import { expect, test } from '@playwright/test';
import { loadSamples } from '../scripts/test-samples.mjs';
for (const theme of ['light', 'dark'] as const) {
  test('category right-click deletion preserves clips and uses an app dialog: ' + theme, async ({ page }) => {
    let browserDialogs = 0;
    page.on('dialog', async dialog => { browserDialogs++; await dialog.dismiss(); });
    await page.emulateMedia({ colorScheme: theme }); await page.goto('/'); await loadSamples(page);
    await page.evaluate(async () => {
      const path = '/src/services/runtime.ts', runtime = await import(path);
      await runtime.dispatch({ type: 'addCategory', category: { id: 'work', name: 'Arbete', color: '#00a9e6', clipOrder: [] } });
      const library = await runtime.loadLibrary();
      await runtime.dispatch({ type: 'setClipCategories', id: library.clips[0].id, categoryIds: ['work'] });
    });
    const category = page.getByRole('navigation', { name: "Categories", exact: true }).getByRole('button', { name: /Arbete/ });
    await category.click(); await category.click({ button: 'right' });
    await page.getByRole('menuitem', { name: "Delete category" }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete “Arbete”?' });
    await expect(dialog).toBeVisible(); await expect(dialog).toContainText("Your clips will be kept.");
    await page.screenshot({ path: '.impeccable/review/category-delete-' + theme + '.png' });
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(category).toBeVisible();
    await category.click({ button: 'right' }); await page.keyboard.press('Escape'); await expect(page.getByRole('menu')).toHaveCount(0);
    await category.click({ button: 'right' }); await page.getByRole('menuitem', { name: "Delete category" }).click();
    await dialog.getByRole('button', { name: "Delete", exact: true }).click();
    await expect(category).toHaveCount(0); await expect(page.locator('.clip-row')).toHaveCount(6);
    expect(browserDialogs).toBe(0);
  });
}
test('retention change can be cancelled and confirmed without browser dialogs', async ({ page }) => {
  let browserDialogs = 0; page.on('dialog', async dialog => { browserDialogs++; await dialog.dismiss(); });
  await page.goto('/'); await loadSamples(page);
  await page.evaluate(async () => {
    const path = '/src/services/runtime.ts', runtime = await import(path);
    const library = await runtime.loadLibrary(); const clip = library.clips[0];
    await runtime.dispatch({ type: 'addClip', clip: { ...clip, id: 'old-test', title: 'Gammalt klipp', content: 'Unikt gammalt testklipp', favorite: false, createdAt: Date.now() - 10 * 86400000 } });
  });
  await page.getByRole('button', { name: "Settings", exact: true }).click();
  await page.getByRole('navigation', { name: "Settings sections" }).getByRole('button', { name: "History", exact: true }).click();
  const retention = page.getByRole('combobox', { name: "Keep clips for" });
  await expect(retention).toHaveText('30 days');
  await retention.click(); await page.getByRole('option', { name: '1 day', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: "Change how long clips are kept?" }); await expect(dialog).toContainText('1 clips will be deleted.');
  await dialog.getByRole('button', { name: "Cancel" }).click(); await expect(dialog).toHaveCount(0);
  await expect(retention).toHaveText('30 days');
  await retention.click(); await page.getByRole('option', { name: '1 day', exact: true }).click();
  await dialog.getByRole('button', { name: "Change and delete" }).click();
  await expect(retention).toHaveText('1 day');
  await page.getByRole('navigation', { name: "Library", exact: true }).getByRole('button', { name: "All clips" }).click();
  await expect(page.locator('.clip-row')).toHaveCount(6); expect(browserDialogs).toBe(0);
});
