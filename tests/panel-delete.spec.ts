import { expect, test } from '@playwright/test';
import { loadSamples } from '../scripts/test-samples.mjs';

test('the trash button in the panel deletes a clip without pasting; always shown, on hover or hidden', async ({ page }) => {
  await page.goto('/'); await loadSamples(page);
  await page.getByRole('button', { name: 'Quick panel', exact: true }).click();
  const rows = page.locator('.quick-panel .clip-row');
  await expect(rows).toHaveCount(6);
  const trash = page.getByRole('button', { name: 'Delete Violett', exact: true });
  // Shown on every row by default.
  await expect(trash).toHaveCSS('opacity', '1');
  await page.locator('.quick-panel').screenshot({ path: '.impeccable/review/panel-trash.png' });
  await trash.click();
  await expect(rows).toHaveCount(5);
  await expect(page.getByRole('button', { name: 'Show Violett', exact: true })).toHaveCount(0);
  const toast = page.locator('.app-toast');
  await expect(toast).toContainText('Clip deleted.');
  await expect(toast).not.toContainText('Copied');
  await toast.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(rows).toHaveCount(6);
  // Settings → Quick panel: shown on hover only, or not at all.
  const choose = async (label: string) => {
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const setting = page.getByRole('combobox', { name: 'Trash button on rows', exact: true });
    await setting.click(); await page.getByRole('option', { name: label, exact: true }).click();
    await expect(setting).toContainText(label);
    await page.getByRole('navigation', { name: 'Library', exact: true }).getByRole('button', { name: /All clips/ }).click();
    await page.getByRole('button', { name: 'Quick panel', exact: true }).click();
  };
  await choose('Shown on hover');
  await expect(trash).toHaveCSS('opacity', '0');
  await page.getByRole('button', { name: 'Show Violett', exact: true }).hover();
  await expect(trash).toHaveCSS('opacity', '1');
  await choose('Hidden');
  await expect(page.locator('.quick-panel .row-delete')).toHaveCount(0);
});
