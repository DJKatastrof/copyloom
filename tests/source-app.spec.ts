import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('rows show the copy time and app icons', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Prova med exempel' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: "Add text", exact: true })).toBeVisible();
  const icon = 'data:image/png;base64,' + readFileSync('src-tauri/icons/icon.png').toString('base64');
  await page.evaluate(async icon => {
    const url = performance.getEntriesByType('resource').map(entry => entry.name).find(name => name.includes('/src/services/runtime.ts'));
    const runtime = await import(url!);
    const domainUrl = '/src/domain/library.ts', domain = await import(domainUrl);
    await runtime.dispatch({ type: 'addClip', clip: { ...domain.makeClip('Tidigare anteckning', Date.now() - 3 * 60 * 60000), title: 'Äldre clip' } });
    await runtime.dispatch({ type: 'addClip', clip: { ...domain.makeClip(icon), title: "Copied image", sourceApp: { id: 'copyloom', name: 'Copyloom', icon } } });
  }, icon);
  // The library preview names the program the clip came from.
  await expect(page.locator('.preview-meta')).toContainText('Image · Copyloom');
  await expect(page.locator('.preview-meta .preview-app')).toBeVisible();
  await page.getByRole('button', { name: "Quick panel", exact: true }).click();
  const image = page.locator('.quick-panel .clip-row.row-image');
  await expect(image.locator('.row-picture')).toBeVisible();
  await expect(image.locator('time')).toContainText("Just now");
  const old = page.locator('.quick-panel .clip-row.row-text');
  await expect(old).toContainText('Tidigare anteckning');
  await expect(old.locator('.row-app')).toHaveCount(0);
  await expect(old.locator('time')).not.toContainText('min');
  await page.screenshot({ path: '.impeccable/review/source-app-light.png' });
  await page.setViewportSize({ width: 700, height: 820 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: '.impeccable/review/source-app-small-dark.png' });
});
