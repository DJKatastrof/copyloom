import { expect, test } from '@playwright/test';
import { loadSamples } from '../scripts/test-samples.mjs';

test('settings show one group at a time and keep changes between groups', async ({ page }) => {
  await page.goto('/');
  await loadSamples(page);
  await page.getByRole('button', { name: "Settings", exact: true }).click();
  const nav = page.getByRole('navigation', { name: "Settings sections" });
  // Three groups; the panel's shortcut sits with the panel, the capture key with screenshots.
  await expect(nav.getByRole('button')).toHaveText(['General', 'Screenshot', 'History']);
  await expect(nav.getByRole('button', { name: "General" })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('button', { name: "Save settings" })).toHaveCount(0);
  await page.getByRole('button', { name: "Keyboard shortcut", exact: true }).click();
  await page.keyboard.press('Control+Alt+K');
  await page.screenshot({ path: '.impeccable/review/settings-general-light.png' });
  await nav.getByRole('button', { name: "Screenshot" }).click();
  await expect(page.getByRole('combobox', { name: "Theme" })).toHaveCount(0);
  await nav.getByRole('button', { name: "General" }).click();
  await expect(page.getByRole('button', { name: "Keyboard shortcut", exact: true })).toContainText('Ctrl+Alt+K');
  await nav.getByRole('button', { name: "History" }).click();
  await expect(page.getByRole('combobox', { name: "Keep clips for" })).toBeVisible();
  await expect(page.getByText('Only on your computer')).toHaveCount(0);
  await page.setViewportSize({ width: 700, height: 820 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: '.impeccable/review/settings-privacy-small-dark.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('the panel is a small box with a thin rim and rounded corners', async ({ page }) => {
  await page.goto('/');
  await loadSamples(page);
  await page.getByRole('button', { name: "Quick panel", exact: true }).click();
  const panel = page.locator('.quick-panel');
  const bounds = (await panel.boundingBox())!;
  expect(bounds.width).toBe(400);
  expect(bounds.height).toBe(480);
  expect(await panel.evaluate(element => getComputedStyle(element).borderTopWidth)).toBe('1px');
  expect(await panel.evaluate(element => getComputedStyle(element).borderTopLeftRadius)).toBe('8px');
  await page.screenshot({ path: '.impeccable/review/quick-panel-light.png' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: '.impeccable/review/quick-panel-dark.png' });
});

test('the startup choice is a single option and fits in a narrow window', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: "Settings", exact: true }).click();
  const mode = page.getByRole('combobox', { name: "Start with Windows" });
  await expect(mode).toContainText("Off");
  await expect(page.getByRole('combobox', { name: "When Copyloom starts" })).toHaveCount(0);
  await page.screenshot({ path: '.impeccable/review/startup-settings-light.png' });
  await page.setViewportSize({ width: 700, height: 820 });
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.impeccable/review/startup-settings-small-dark.png' });
});
