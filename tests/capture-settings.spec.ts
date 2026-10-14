import { expect, test } from '@playwright/test';
const sections = (page: import('@playwright/test').Page) => page.getByRole('navigation', { name: "Settings sections" });
test('capture shortcut can be enabled, recorded and disabled', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: "Settings", exact: true }).click();
  await sections(page).getByRole('button', { name: "Screenshot", exact: true }).click();
  // Each choice takes effect at once.
  const recorder = page.locator('.settings-section').getByRole('button', { name: "Keyboard shortcut", exact: true });
  await expect(recorder).toHaveText("Off");
  await page.getByRole('button', { name: 'Print Screen', exact: true }).click();
  await expect(recorder).toHaveText('Print Screen');
  await recorder.click(); await page.keyboard.press('F8');
  await expect(recorder).toHaveText('F8');
  await page.getByRole('button', { name: "Turn off", exact: true }).click();
  await expect(recorder).toHaveText("Off");
  await expect(page.getByRole('button', { name: "Save settings" })).toHaveCount(0);
});

test('F12 explains the Windows restriction and F11 still works in both recorders', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: "Settings", exact: true }).click();
  const recorder = page.locator('.settings-section').getByRole('button', { name: "Keyboard shortcut", exact: true });
  await recorder.click(); await page.keyboard.press('Control+Shift+F12');
  await expect(page.getByRole('alert')).toContainText('F12 is reserved by Windows');
  await page.keyboard.press('Control+Shift+F11');
  await expect(recorder).toHaveText('Ctrl+Shift+F11');
  await sections(page).getByRole('button', { name: 'Screenshot', exact: true }).click();
  await recorder.click(); await page.keyboard.press('Control+Shift+F12');
  await expect(page.getByRole('alert')).toContainText('F12 is reserved by Windows');
  await page.keyboard.press('Control+Alt+F11');
  await expect(recorder).toHaveText('Ctrl+Alt+F11');
  await sections(page).getByRole('button', { name: 'General', exact: true }).click();
  await expect(recorder).toHaveText('Ctrl+Shift+F11');
});
