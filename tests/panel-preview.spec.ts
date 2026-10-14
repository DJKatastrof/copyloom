import { expect, test } from '@playwright/test';
import { loadSamples } from '../scripts/test-samples.mjs';

test('Space previews the whole clip in the panel; arrows change clip, Enter uses it', async ({ page }) => {
  await page.goto('/'); await loadSamples(page);
  await page.getByRole('button', { name: 'Quick panel', exact: true }).click();
  const panel = page.locator('.quick-panel');
  await page.keyboard.press(' ');
  const preview = page.getByRole('dialog', { name: /^Preview / });
  await expect(preview).toBeVisible();
  // The whole clip, inside the panel, with its type and source on top.
  expect(await preview.evaluate((element, panel) => { const a = element.getBoundingClientRect(), b = panel!.getBoundingClientRect(); return a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom; }, await panel.elementHandle())).toBe(true);
  const first = await preview.getAttribute('aria-label');
  await page.locator('.quick-panel').screenshot({ path: '.impeccable/review/panel-preview-text.png' });
  await page.keyboard.press('ArrowDown');
  await expect(preview).not.toHaveAttribute('aria-label', first!);
  await expect(page.locator('.quick-panel .clip-row.active')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await expect(panel).toBeVisible();
  // With the mouse: Back, top left, returns to the list.
  await page.keyboard.press(' ');
  await preview.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect(page.locator('.quick-panel .clip-row').first()).toBeVisible();
  // The right-click menu offers the preview too; Enter in the preview uses the clip.
  await page.locator('.quick-panel .clip-row').last().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Preview', exact: true }).click();
  await expect(preview).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(preview).toHaveCount(0);
  await expect(page.locator('.app-toast')).toContainText('Copied');
});

test('with double-click chosen, a click in the panel selects and a double-click uses the clip', async ({ page }) => {
  await page.goto('/'); await loadSamples(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const click = page.getByRole('combobox', { name: 'Use a clip with', exact: true });
  await expect(click).toContainText('One click');
  await click.click(); await page.getByRole('option', { name: 'Double-click', exact: true }).click();
  await expect(click).toContainText('Double-click');
  await page.getByRole('navigation', { name: 'Library', exact: true }).getByRole('button', { name: /All clips/ }).click();
  await page.getByRole('button', { name: 'Quick panel', exact: true }).click();
  const row = page.locator('.quick-panel .clip-row').nth(2);
  await row.click();
  await expect(row).toHaveClass(/active/);
  await expect(page.locator('.app-toast')).toHaveCount(0);
  await page.keyboard.press(' ');
  await expect(page.getByRole('dialog', { name: /^Preview / })).toBeVisible();
  await page.keyboard.press(' ');
  await row.dblclick();
  await expect(page.locator('.app-toast')).toContainText('Copied');
});
