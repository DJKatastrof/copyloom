import { loadSamples } from '../scripts/test-samples.mjs';
import { expect, test } from '@playwright/test';

test('empty library, add text, search and favorite', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: "Your next copy starts here" })).toBeVisible();
  await page.getByRole('button', { name: "Add text", exact: true }).click();
  await page.getByLabel("Add a clip").fill('Hej världen\nEn anteckning att återanvända.');
  await page.getByRole('button', { name: "Add clip", exact: true }).click();
  await expect(page.getByRole('button', { name: 'Show Hej världen', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Favorite Hej världen', exact: true }).click();
  await page.getByRole('navigation', { name: "Library", exact: true }).getByRole('button', { name: "Favorites" }).click();
  await expect(page.getByRole('button', { name: 'Show Hej världen', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: "Search your clips" }).fill('saknas');
  await expect(page.getByRole('heading', { name: "No matching clips" })).toBeVisible();
  await page.getByRole('button', { name: "Clear search", exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Show Hej världen', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: "Your next copy starts here" })).toBeVisible();
});

test('categorise a clip and delete the category without deleting the content', async ({ page }) => {
  await page.goto('/');
  await loadSamples(page);
  await expect(page.locator('.clip-row')).toHaveCount(6);
  await page.getByRole('button', { name: "Create category", exact: true }).click();
  await page.getByLabel("New category", { exact: true }).fill('Arbete');
  await page.getByRole('button', { name: "Create", exact: true }).click();
  await page.getByRole('button', { name: 'Show Projektanteckningar', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Add to category', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Arbete', exact: true }).click();
  const arbete = page.getByRole('navigation', { name: "Categories", exact: true }).getByRole('button', { name: 'Arbete' });
  await arbete.click();
  await expect(page.locator('.clip-row')).toHaveCount(1);
  // Categories are renamed and deleted where they are listed, not in a settings tab.
  await arbete.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Jobb');
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  const jobb = page.getByRole('navigation', { name: "Categories", exact: true }).getByRole('button', { name: 'Jobb' });
  await jobb.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete category', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: "Delete", exact: true }).click();
  await expect(jobb).toHaveCount(0);
  await page.getByRole('navigation', { name: "Library", exact: true }).getByRole('button', { name: "All clips" }).click();
  await expect(page.locator('.clip-row')).toHaveCount(6);
});

test('own shortcut and theme; the panel opens as a compact list', async ({ page }) => {
  await page.goto('/');
  await loadSamples(page);
  await expect(page.locator('.clip-row')).toHaveCount(6);
  await page.getByRole('button', { name: "Settings", exact: true }).click();
  // Settings take effect at once; there is nothing to save.
  await page.getByRole('button', { name: "Keyboard shortcut", exact: true }).click();
  await page.keyboard.press('Control+Alt+K');
  await expect(page.getByRole('button', { name: "Keyboard shortcut", exact: true })).toHaveText('Ctrl+Alt+K');
  await page.getByRole('combobox', { name: "Theme", exact: true }).click();
  await page.getByRole('option', { name: "Dark", exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: "Save settings" })).toHaveCount(0);
  await page.keyboard.press('Control+Alt+K');
  await expect(page.locator('.quick-panel')).toBeVisible();
  const panel = await page.locator('.quick-panel').boundingBox();
  expect(panel!.width).toBeLessThanOrEqual(400); expect(panel!.height).toBeLessThanOrEqual(480);
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.quick-panel .clip-row.active')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: "All clips", exact: true })).toBeVisible();
});

test('multiple selection and confirmed deletion', async ({ page }) => {
  await page.goto('/');
  await loadSamples(page);
  await expect(page.locator('.clip-row')).toHaveCount(6);
  // As in File Explorer, Ctrl+click adds to the clip already selected.
  await page.getByRole('button', { name: 'Show Violett', exact: true }).click();
  await page.getByRole('button', { name: 'Show Grönt', exact: true }).click({ modifiers: ["Control"] });
  await expect(page.locator('.clip-row.checked')).toHaveCount(2);
  await expect(page.getByRole('heading', { name: '2 clips selected' })).toBeVisible();
  await page.keyboard.press('Delete');
  await page.getByRole('dialog', { name: 'Delete 2 clips?' }).getByRole('button', { name: "Cancel" }).click();
  await expect(page.locator('.clip-row')).toHaveCount(6);
  await page.keyboard.press('Delete');
  await page.getByRole('dialog', { name: 'Delete 2 clips?' }).getByRole('button', { name: "Delete", exact: true }).click();
  await expect(page.locator('.clip-row')).toHaveCount(4);
});

test('deleted clips come back with Undo and Ctrl+Z, but not from a text field', async ({ page }) => {
  await page.goto('/'); await loadSamples(page);
  await page.getByRole('button', { name: 'Show Violett', exact: true }).click();
  await page.getByRole('button', { name: 'Favorite Violett', exact: true }).click();
  await page.getByRole('button', { name: 'Show Grönt', exact: true }).click({ modifiers: ["Control"] });
  await page.keyboard.press('Delete');
  await expect(page.getByRole('dialog', { name: 'Delete 2 clips?' })).toContainText('You can undo with Ctrl+Z.');
  await page.getByRole('dialog', { name: 'Delete 2 clips?' }).getByRole('button', { name: "Delete", exact: true }).click();
  await expect(page.locator('.clip-row')).toHaveCount(4);
  const toast = page.getByRole('status').filter({ hasText: '2 clips deleted.' });
  await page.screenshot({ path: '.impeccable/review/undo-delete-toast.png' });
  await toast.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.clip-row')).toHaveCount(6);
  await expect(page.getByRole('status').filter({ hasText: '2 clips restored.' })).toBeVisible();
  await page.getByRole('button', { name: 'Show Violett', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove Violett from favorites', exact: true })).toBeVisible();
  // Separate deletions come back one Ctrl+Z at a time, newest first, like any undo history.
  const names = ['Grönt', 'Violett', 'Projektanteckningar'];
  for (const [index, name] of names.entries()) {
    await page.getByRole('button', { name: 'Show ' + name, exact: true }).click(); await page.keyboard.press('Delete');
    await expect(page.locator('.clip-row')).toHaveCount(5 - index);
  }
  for (const [index, name] of [...names].reverse().entries()) {
    await page.keyboard.press('Control+z'); await expect(page.locator('.clip-row')).toHaveCount(4 + index);
    await expect(page.getByRole('button', { name: 'Show ' + name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('status').filter({ hasText: 'Clip restored.' }).getByRole('button', { name: 'Undo' })).toHaveCount(0);
  await page.keyboard.press('Control+z'); await expect(page.locator('.clip-row')).toHaveCount(6);
  // In the search field Ctrl+Z belongs to the text.
  await page.getByRole('button', { name: 'Show Grönt', exact: true }).click(); await page.keyboard.press('Delete');
  const search = page.getByRole('textbox', { name: "Search your clips" }); await search.fill('x'); await search.press('Control+z');
  await expect(page.locator('.clip-row')).toHaveCount(5);
});

test('manual order can be changed with buttons and a narrow library does not overlap', async ({ page }) => {
  await page.goto('/');
  await loadSamples(page);
  await expect(page.locator('.clip-row')).toHaveCount(6);
  await page.getByRole('button', { name: "Create category", exact: true }).click();
  await page.getByLabel("New category", { exact: true }).fill('Arbete');
  await page.getByRole('button', { name: "Create", exact: true }).click();
  for (const name of ['Projektanteckningar', 'Violett']) {
    await page.getByRole('button', { name: `Show ${name}`, exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Add to category', exact: true }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Arbete', exact: true }).click();
  }
  await page.getByRole('navigation', { name: "Categories", exact: true }).getByRole('button', { name: 'Arbete' }).click();
  await page.getByRole('combobox', { name: "Sort clips" }).click();
  await page.getByRole('option', { name: "Custom order", exact: true }).click();
  await page.getByRole('button', { name: 'Show Violett', exact: true }).click();
  await page.getByRole('button', { name: "Move earlier", exact: true }).click();
  await expect(page.locator('.clip-row').first()).toHaveAttribute('aria-label', 'Show Violett');
  await expect(page.getByRole('button', { name: "Move earlier", exact: true })).toBeDisabled();
  // A narrow library is one column; Space shows the preview with the same move buttons.
  await page.setViewportSize({ width: 700, height: 820 });
  await expect(page.locator('.preview-pane')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.clip-row').first().focus(); await page.keyboard.press(' ');
  await expect(page.getByRole('dialog').getByRole('button', { name: "Move later", exact: true })).toBeEnabled();
  await page.keyboard.press(' ');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('the quick panel closes on a click outside', async ({ page }) => {
  await page.goto('/');
  await loadSamples(page);
  await page.getByRole('button', { name: "Quick panel", exact: true }).click();
  await page.locator('.panel-more summary').click();
  await expect(page.locator('.panel-menu')).toBeVisible();
  await page.locator('.panel-more summary').click();
  await expect(page.locator('.quick-panel')).toBeVisible();
  await page.locator('.preview-workspace header').click();
  await expect(page.locator('.quick-panel')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: "All clips", exact: true })).toBeVisible();
});

test('the panel closes at once without leaving the content transparent', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  await loadSamples(page);
  await page.getByRole('button', { name: "Quick panel", exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: "All clips", exact: true })).toBeVisible();
  expect(await page.locator('.main-pane').evaluate(element => getComputedStyle(element).opacity)).toBe('1');
});

test('a PowerCLI script shows as dark PowerShell with syntax colours', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: "Add text", exact: true }).click();
  const code = '#Requires -Modules VMware.PowerCLI\r\n\r\nparam(\r\n [string]$vCenter = "10.0.2.15"\r\n)\r\nGet-VM | Select-Object Name';
  await page.getByLabel("Add a clip", { exact: true }).fill(code);
  await page.getByRole('button', { name: "Add clip", exact: true }).click();
  const row = page.locator('.clip-row').first(), preview = page.locator('.preview-pane .clip-preview');
  await expect(row).toHaveClass(/row-code/);
  await expect(row.locator('time')).toContainText("Just now");
  await expect(preview).toHaveClass(/preview-code/);
  await expect(preview.locator('code')).toHaveAttribute('data-language', 'powershell');
  expect(await preview.locator('.hljs-variable').count()).toBeGreaterThan(0);
  expect(await preview.locator('.code-preview').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(38, 38, 38)');
  await expect(preview).toContainText('PowerShell');
});

test('Delete removes the selected clip in the panel; in the search field it deletes text', async ({ page }) => {
  await page.goto('/');
  await loadSamples(page);
  await page.getByRole('button', { name: "Quick panel", exact: true }).click();
  const rows = page.locator('.quick-panel .clip-row');
  // Walk to Violett with the arrow keys; a click would use the clip.
  for (let step = 0; step < 6 && await page.locator('.clip-row.active').getAttribute('aria-label') !== 'Show Violett'; step++) await page.keyboard.press('ArrowDown');
  await expect(page.locator('.clip-row.active')).toHaveAttribute('aria-label', 'Show Violett');
  await page.keyboard.press('Delete');
  await expect(rows).toHaveCount(5);
  await expect(page.getByRole('button', { name: 'Show Violett', exact: true })).toHaveCount(0);
  await expect(page.locator('.clip-row.active')).toHaveCount(1);
  await expect(page.locator('.quick-panel')).toBeVisible();
  const search = page.getByRole('textbox', { name: "Search your clips" });
  await search.fill('Projekt'); await search.press('Home');
  await page.keyboard.press('Delete');
  await expect(search).toHaveValue('rojekt');
  await page.keyboard.press('Escape');
  await expect(search).toHaveValue('');
  await expect(rows).toHaveCount(5);
});

test('rows have no action buttons and Backspace deletes the selected clip', async ({ page }) => {
  await page.goto('/'); await loadSamples(page);
  await expect(page.locator('.card-delete, .copy-button')).toHaveCount(0);
  const color = page.getByRole('button', { name: 'Show Violett', exact: true });
  await color.click(); await page.keyboard.press('Backspace');
  await expect(color).toHaveCount(0);
  await expect(page.locator('.clip-row')).toHaveCount(5);
  const search = page.getByRole('textbox', { name: "Search your clips" });
  await search.fill('Projekt'); await search.press('Backspace');
  await expect(search).toHaveValue('Projek');
  await expect(page.getByRole('button', { name: 'Show Projektanteckningar', exact: true })).toBeVisible();
});

test('own shortcut opens and closes the panel again', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Control+Shift+V');
  await expect(page.locator('.quick-panel')).toBeVisible();
  const panel = await page.locator('.quick-panel').boundingBox();
  expect(panel!.height).toBeLessThanOrEqual(480);
  await page.keyboard.press('Control+Shift+V');
  await expect(page.locator('.quick-panel')).toHaveCount(0);
  await page.keyboard.press('Control+Shift+V');
  await expect(page.locator('.quick-panel')).toBeVisible();
  await loadSamples(page);
  const row = await page.locator('.quick-panel .clip-row').first().boundingBox();
  // Every panel row has one height.
  expect(row!.height).toBe(48);
});
