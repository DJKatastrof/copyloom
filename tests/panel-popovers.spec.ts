import { expect, test } from '@playwright/test';

test('the panel\'s menu closes outside and with Escape, and menu actions close it', async ({ page }) => {
  await page.goto('/?view=panel');
  const more = page.locator('.panel-more summary');
  const menu = page.locator('.panel-menu');
  await more.click();
  await expect(menu).toBeVisible();
  await page.getByRole('textbox', { name: 'Search your clips' }).click();
  await expect(menu).toBeHidden();
  await more.click();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();
  await expect(page.locator('.quick-panel')).toBeVisible();
  await more.click();
  await page.getByRole('button', { name: 'Pause collection', exact: true }).click();
  await expect(menu).toBeHidden();
  await more.click();
  await expect(page.getByRole('button', { name: 'Resume collection', exact: true })).toBeVisible();
});
