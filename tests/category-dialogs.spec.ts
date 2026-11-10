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
    const visibility = await dialog.evaluate(node => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d')!;
      const color = (value: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); return Array.from(ctx.getImageData(0, 0, 1, 1).data); };
      const luminance = (rgb: number[]) => rgb.slice(0, 3).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
      const contrast = (a: number[], b: number[]) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
      const background = color(getComputedStyle(node).backgroundColor), text = color(getComputedStyle(node.querySelector('p')!).color);
      const backdrop = color(getComputedStyle(node, '::backdrop').backgroundColor), alpha = backdrop[3] / 255;
      const surface = color(getComputedStyle(document.documentElement).getPropertyValue('--surface'));
      return { textContrast: contrast(text, background), layerContrast: contrast(background, surface.map(value => value * (1 - alpha))), backdropAlpha: alpha };
    });
    expect(visibility.textContrast).toBeGreaterThanOrEqual(4.5);
    expect(visibility.layerContrast).toBeGreaterThanOrEqual(1.5);
    expect(visibility.backdropAlpha).toBeGreaterThanOrEqual(theme === 'dark' ? 0.6 : 0.4);
    await expect(dialog.locator('p')).toHaveCSS('font-size', '14px');
    await page.screenshot({ path: '.impeccable/review/category-delete-' + theme + '.png' });
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(category).toBeVisible();
    await category.click({ button: 'right' }); await page.getByRole('menuitem', { name: "Delete category" }).click();
    await page.mouse.click(5, 5); await expect(dialog).toHaveCount(0); await expect(category).toBeVisible();
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
  const dialog = page.getByRole('dialog', { name: "Change how long clips are kept?" }); await expect(dialog).toContainText('1 clip will be deleted now.');
  await dialog.getByRole('button', { name: "Cancel" }).click(); await expect(dialog).toHaveCount(0);
  await expect(retention).toHaveText('30 days');
  await retention.click(); await page.getByRole('option', { name: '1 day', exact: true }).click();
  await dialog.getByRole('button', { name: "Change and delete" }).click();
  await expect(retention).toHaveText('1 day');
  await page.getByRole('navigation', { name: "Library", exact: true }).getByRole('button', { name: "All clips" }).click();
  await expect(page.locator('.clip-row')).toHaveCount(6); expect(browserDialogs).toBe(0);
});
