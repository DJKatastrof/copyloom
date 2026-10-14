import { loadSamples } from '../scripts/test-samples.mjs';
import { expect, test } from '@playwright/test';

test('the clip menu is compact, toggles favorite and deletes the right clip', async ({ page }) => {
  await page.goto('/');
  await loadSamples(page);
  const target = page.getByRole('button', { name: 'Show Projektanteckningar', exact: true });
  await target.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Actions for Projektanteckningar' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: "Add to favorites", exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove Projektanteckningar from favorites' })).toHaveAttribute('aria-pressed', 'true');
  await expect(target.locator('.row-star')).toBeVisible();
  await expect(menu).toHaveCount(0);
  await target.click({ button: 'right' });
  await expect(menu.getByRole('menuitem', { name: 'Namn och kategorier' })).toHaveCount(0);
  expect((await menu.boundingBox())!.width).toBe(190);
  await page.keyboard.press('Delete');
  await expect(target).toHaveCount(0);
  await expect(page.locator('.clip-row')).toHaveCount(5);
});

test('Shift+F10 opens the menu and Escape restores focus', async ({ page }) => {
  await page.goto('/');
  await loadSamples(page);
  const card = page.getByRole('button', { name: 'Show Projektanteckningar', exact: true });
  await card.focus();
  await page.keyboard.press('Shift+F10');
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: "Copy", exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Edit', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Rename', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: "Add to favorites", exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem', { name: "Delete clip" })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(card).toBeFocused();
});

test('the menu fits in the small panel and a click outside closes it', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 480 });
  await page.goto('/?view=panel');
  await loadSamples(page);
  const row = page.locator('.quick-panel .clip-row').last();
  await row.click({ button: 'right', position: { x: 300, y: 20 } });
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const bounds = (await menu.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(400);
  expect(bounds.y).toBeGreaterThanOrEqual(8);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(472);
  await page.getByRole('textbox', { name: 'Search your clips' }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.locator('.quick-panel')).toBeVisible();
});
