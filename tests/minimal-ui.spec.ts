import { loadSamples } from '../scripts/test-samples.mjs';
import { expect, test } from '@playwright/test';

test('Ctrl and Shift select rows without checkboxes or a toolbar', async ({ page }) => {
  await page.goto('/');
  await loadSamples(page);
  const rows = page.locator('.clip-row');
  await rows.nth(0).click();
  await expect(page.locator('.selection-bar')).toHaveCount(0);
  await expect(rows.locator('input[type="checkbox"]')).toHaveCount(0);
  await rows.nth(2).click({ modifiers: ['Control'] });
  await expect(page.locator('.clip-row[aria-pressed="true"]')).toHaveCount(2);
  await rows.nth(2).click({ modifiers: ['Control'] });
  await expect(page.locator('.clip-row[aria-pressed="true"]')).toHaveCount(1);
  await rows.nth(0).click();
  await rows.nth(3).click({ modifiers: ['Shift'] });
  await expect(page.locator('.clip-row[aria-pressed="true"]')).toHaveCount(4);
  await expect(page.getByRole('heading', { name: '4 clips selected' })).toBeVisible();
  await page.screenshot({ path: '.impeccable/review/minimal-selection.png' });
  await rows.nth(5).click();
  await expect(page.locator('.selection-bar')).toHaveCount(0);
  await expect(page.locator('.clip-row[aria-pressed="true"]')).toHaveCount(1);
});

test('the toast does not affect the layout and the menu has no editing options', async ({ page }) => {
  await page.goto('/');
  await loadSamples(page);
  const list = page.locator('.clip-list');
  const before = await list.boundingBox();
  await page.getByRole('button', { name: 'Show Projektanteckningar', exact: true }).dblclick();
  await expect(page.locator('.app-toast')).toContainText("Copied");
  expect((await list.boundingBox())!.y).toBe(before!.y);
  await page.screenshot({ path: '.impeccable/review/minimal-toast.png' });
  await expect(page.locator('.app-toast')).toHaveCount(0, { timeout: 6000 });
  await page.getByRole('button', { name: 'Show Projektanteckningar', exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Namn och kategorier' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 700, height: 820 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: '.impeccable/review/minimal-small-dark.png' });
});

test('multiple selection from the menu uses Copyloom\'s confirmation and Escape cancels', async ({ page }) => {
  await page.goto('/');
  await loadSamples(page);
  const rows = page.locator('.clip-row');
  await rows.nth(0).click();
  await rows.nth(2).click({ modifiers: ['Shift'] });
  await expect(page.locator('.selection-bar')).toHaveCount(0);
  await rows.nth(0).click({ button: 'right' });
  await page.getByRole('menuitem', { name: "Favorite selected clips" }).click();
  await expect(rows.locator('.row-star')).toHaveCount(3);
  await rows.nth(0).click({ button: 'right' });
  await page.getByRole('menuitem', { name: "Delete selected clips" }).click();
  const confirmation = page.getByRole('dialog', { name: 'Delete 3 clips?' });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByRole('button', { name: "Cancel" })).toBeFocused();
  await page.screenshot({ path: '.impeccable/review/delete-confirm-light.png' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: '.impeccable/review/delete-confirm-dark.png' });
  await page.keyboard.press('Escape');
  await expect(confirmation).toHaveCount(0);
  await expect(rows).toHaveCount(6);
  await page.keyboard.press('Delete');
  await confirmation.getByRole('button', { name: "Delete", exact: true }).click();
  await expect(rows).toHaveCount(3);
});

test('Copy together joins the selected texts in copy order into a new clip', async ({ page }) => {
  await page.goto('/');
  await loadSamples(page);
  await page.getByRole('button', { name: 'Show Projektanteckningar', exact: true }).click();
  await page.getByRole('button', { name: 'Show Violett', exact: true }).click({ modifiers: ['Control'] });
  await page.getByRole('button', { name: 'Copy together', exact: true }).click();
  await expect(page.locator('.app-toast')).toContainText('Copied');
  // Oldest first, as they were copied; the joined text becomes the newest clip and is selected.
  const joined = await page.evaluate(async () => (await (await import('/src/services/runtime.ts')).loadLibrary()).clips[0].content);
  expect(joined).toBe('#6C4DDE\nEn plats för det du vill hitta igen.\n\nSamla idéer, bra formuleringar och små detaljer som gör nästa steg enklare.');
  await expect(page.locator('.clip-row')).toHaveCount(7);
  await expect(page.locator('.clip-row.active')).toHaveCount(1);
  await expect(page.locator('.clip-row[aria-pressed="true"]')).toHaveCount(1);
});
