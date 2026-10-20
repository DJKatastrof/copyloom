import { expect, test, type Page } from '@playwright/test';
import { loadSamples } from '../scripts/test-samples.mjs';

const DAY = 86_400_000;
// Six samples from today, plus older clips three and twenty days back; one old clip is a favorite.
async function seed(page: Page) {
  await page.goto('/'); await loadSamples(page);
  await page.evaluate(async ({ DAY }) => {
    const path = '/src/services/runtime.ts', domain = '/src/domain/library.ts';
    const runtime = await import(path), { makeClip } = await import(domain);
    const now = Date.now();
    for (const [content, age, favorite] of [['Tre dagar A', 3, false], ['Tre dagar B', 3, true], ['Tre dagar C', 3, false], ['Tjugo dagar', 20, false]] as const)
      await runtime.dispatch({ type: 'addClip', clip: { ...makeClip(content, now - age * DAY), favorite } });
  }, { DAY });
}

test('right-clicking a day heading deletes the clips under it after confirming', async ({ page }) => {
  let browserDialogs = 0; page.on('dialog', async dialog => { browserDialogs++; await dialog.dismiss(); });
  await seed(page);
  const headings = page.locator('.clip-list-rows .day-heading button');
  await expect(headings).toHaveCount(3); await expect(page.locator('.clip-row')).toHaveCount(10);
  const day = (await headings.nth(1).textContent())!;
  await headings.nth(1).click({ button: 'right' });
  await expect(page.getByRole('menu', { name: day })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Delete day' }).click();
  const dialog = page.getByRole('dialog', { name: `Delete 3 clips from “${day}”?` });
  await expect(dialog).toContainText('Includes 1 favorite.');
  await dialog.getByRole('button', { name: 'Cancel' }).click(); await expect(page.locator('.clip-row')).toHaveCount(10);
  await headings.nth(1).focus(); await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Delete day' }).click();
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('.clip-row')).toHaveCount(7); await expect(headings).toHaveCount(2);
  await expect(page.locator('.app-toast')).toContainText('3 clips deleted.');
  expect(browserDialogs).toBe(0);
});

test('history cleanup deletes clips created before a chosen date and keeps favorites', async ({ page }) => {
  await seed(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'History', exact: true }).click();
  const date = page.getByLabel('Delete clips created before'), button = page.locator('.settings-content').getByRole('button', { name: /^Delete/ });
  await expect(button).toBeDisabled();
  const day = new Date(Date.now() - 2 * DAY), value = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  await date.fill(value);
  await expect(button).toHaveText('Delete 3 clips'); await button.click();
  const dialog = page.getByRole('dialog', { name: /^Delete 3 clips created before / });
  await expect(dialog).toContainText('Favorites are kept.');
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(date).toHaveValue('');
  await page.getByRole('button', { name: /All clips/ }).click();
  await expect(page.locator('.clip-row')).toHaveCount(7);
  await expect(page.locator('.clip-row', { hasText: 'Tre dagar B' })).toHaveCount(1);
});

test('day headings and row times follow a language change at once', async ({ page }) => {
  await seed(page);
  await expect(page.locator('.clip-list-rows .day-heading button').first()).toHaveText('Today');
  await page.evaluate(async () => {
    const path = '/src/services/runtime.ts', runtime = await import(path);
    await runtime.dispatch({ type: 'setSettings', settings: { ...(await runtime.loadLibrary()).settings, language: 'sv' } });
  });
  await expect(page.locator('.clip-list-rows .day-heading button').first()).toHaveText('Idag');
  await expect(page.locator('.clip-row').first().locator('time')).toHaveText('Just nu');
});
