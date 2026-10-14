import { loadSamples } from '../scripts/test-samples.mjs';
import { expect, test } from '@playwright/test';

test('dropdowns support the keyboard, clicks outside and Escape', async ({ page }) => {
  await page.goto('/');
  await loadSamples(page);
  const sort = page.getByRole('combobox', { name: "Sort clips" });
  await sort.click();
  await expect(page.getByRole('listbox', { name: "Sort clips" })).toBeVisible();
  await page.screenshot({ path: '.impeccable/review/dropdown-sort.png' });
  await page.getByRole('textbox', { name: "Search your clips" }).click();
  await expect(sort).toHaveAttribute('aria-expanded', 'false');
  await sort.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(sort).toContainText("Oldest first");
  await sort.click();
  await page.keyboard.press('Escape');
  await expect(sort).toHaveAttribute('aria-expanded', 'false');
  await expect(sort).toBeFocused();
});

test('the logo is not a link and interface text cannot be selected', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.brand')).toHaveCount(1);
  await expect(page.locator('a.brand')).toHaveCount(0);
  expect(await page.locator('.brand').evaluate(element => getComputedStyle(element).userSelect)).toBe('none');
  expect(await page.getByRole('textbox', { name: "Search your clips" }).evaluate(element => getComputedStyle(element).userSelect)).toBe('text');
  await page.getByRole('button', { name: "Quick panel", exact: true }).click();
  await page.locator('.quick-panel').focus();
  expect(await page.locator('.quick-panel').evaluate(element => getComputedStyle(element).outlineStyle)).toBe('none');
});
