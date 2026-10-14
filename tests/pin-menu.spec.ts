import { expect, test } from '@playwright/test';
import { loadSamples } from '../scripts/test-samples.mjs';

for (const theme of ['light', 'dark'] as const) {
  test('compact Pin menu shows Unpin only when assigned: ' + theme, async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 340 });
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('/?view=panel'); await loadSamples(page);
    await page.evaluate(async () => {
      const path = '/src/services/runtime.ts', runtime = await import(path);
      for (const [id, name, color] of [['scripts', 'Scripts', '#00a9e6'], ['work', 'Arbete', '#fa9214']]) await runtime.dispatch({ type: 'addCategory', category: { id, name, color, clipOrder: [] } });
    });
    const target = page.getByRole('button', { name: 'Show Projektanteckningar', exact: true });
    await target.click({ button: 'right' });
    const root = page.getByRole('menu', { name: 'Actions for Projektanteckningar', exact: true });
    expect((await root.boundingBox())!.width).toBe(190);
    expect((await root.boundingBox())!.height).toBeLessThan(240);
    await expect(root.getByRole('menuitem', { name: 'Namn och kategorier' })).toHaveCount(0);
    await root.getByRole('menuitem', { name: 'Add to category', exact: true }).hover();
    const pins = page.getByRole('menu', { name: 'Categories', exact: true });
    await expect(pins).toBeVisible();
    await expect(pins.getByRole('menuitem', { name: 'Remove from categories' })).toHaveCount(0);
    await pins.getByRole('menuitemcheckbox', { name: 'Scripts' }).click();
    await target.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Add to category', exact: true }).click();
    await expect(pins.getByRole('menuitemcheckbox', { name: 'Scripts' })).toHaveAttribute('aria-checked', 'true');
    await expect(pins.getByRole('menuitem', { name: 'Remove from categories' })).toBeVisible();
    const bounds = (await pins.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(8); expect(bounds.y + bounds.height).toBeLessThanOrEqual(332);
    await page.screenshot({ path: '.impeccable/review/compact-pin-' + theme + '.png' });
    await pins.getByRole('menuitem', { name: 'Remove from categories' }).click();
    await target.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Add to category', exact: true }).click();
    await expect(pins.getByRole('menuitem', { name: 'Remove from categories' })).toHaveCount(0);
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    await expect(page.locator('.card-delete, .copy-button')).toHaveCount(0);
  });
}

test('Pin submenu works with keyboard and Backspace deletes via menu', async ({ page }) => {
  await page.goto('/'); await loadSamples(page);
  await page.evaluate(async () => {
    const path = '/src/services/runtime.ts', runtime = await import(path);
    await runtime.dispatch({ type: 'addCategory', category: { id: 'work', name: 'Arbete', color: '#00a9e6', clipOrder: [] } });
  });
  const target = page.getByRole('button', { name: 'Show Projektanteckningar', exact: true });
  await target.focus(); await page.keyboard.press('Shift+F10');
  for (let step = 0; step < 4; step++) await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('menuitemcheckbox', { name: 'Arbete' })).toBeFocused();
  await page.keyboard.press('Enter');
  await target.focus(); await page.keyboard.press('Shift+F10'); await page.keyboard.press('Backspace');
  await expect(target).toHaveCount(0);
});
