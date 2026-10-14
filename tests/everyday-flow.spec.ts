import { expect, test } from '@playwright/test';
import { loadSamples } from '../scripts/test-samples.mjs';

const contents = (page: import('@playwright/test').Page) => page.evaluate(async () => (await (await import('/src/services/runtime.ts')).loadLibrary()).clips.map((clip: { content: string }) => clip.content));

test('the same text copied again moves to the top instead of becoming a duplicate', async ({ page }) => {
  await page.goto('/'); await loadSamples(page);
  await page.getByRole('button', { name: 'Show Violett', exact: true }).click();
  await page.getByRole('button', { name: 'Favorite Violett', exact: true }).click();
  await page.evaluate(async () => {
    const runtime = await import('/src/services/runtime.ts'), domain = await import('/src/domain/library.ts');
    await runtime.dispatch({ type: 'addClip', clip: domain.makeClip('#6C4DDE') });
  });
  await expect(page.locator('.clip-row')).toHaveCount(6);
  await expect(page.locator('.clip-row').first()).toHaveAttribute('aria-label', 'Show Violett');
  await expect(page.locator('.clip-row').first().locator('.row-star')).toBeVisible();
  expect((await contents(page))[0]).toBe('#6C4DDE');
});

test('a clip used from the panel moves to the top; in the library it stays where it is', async ({ page }) => {
  await page.goto('/'); await loadSamples(page);
  await page.getByRole('button', { name: 'Show Grönt', exact: true }).dblclick();
  await expect(page.locator('.app-toast')).toContainText('Copied');
  await expect(page.locator('.clip-row').last()).toHaveAttribute('aria-label', 'Show Grönt');
  await page.getByRole('button', { name: "Quick panel", exact: true }).click();
  await page.locator('.quick-panel .clip-row').last().click();
  await expect.poll(async () => (await contents(page))[0]).toBe('#33836A');
});

test('a clip\'s text can be edited; the formatting is not kept', async ({ page }) => {
  await page.goto('/'); await loadSamples(page);
  const row = page.getByRole('button', { name: 'Show Ett återanvändbart svar', exact: true });
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit text' });
  const field = dialog.getByRole('textbox');
  await expect(field).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await field.fill('Hej! Jag återkommer i morgon.');
  await page.screenshot({ path: '.impeccable/review/edit-text-light.png' });
  await page.keyboard.press('Control+Enter');
  await expect(dialog).toHaveCount(0);
  // Without a chosen name the title follows the new text; focus returns to the same row.
  await expect(page.getByRole('button', { name: 'Show Hej! Jag återkommer i morgon.', exact: true })).toBeFocused();
  await expect(page.locator('.preview-body')).toContainText('Hej! Jag återkommer i morgon.');
  // Escape leaves the text as it was.
  await page.locator('.preview-actions').getByRole('button', { name: 'Edit', exact: true }).click();
  await field.fill('Ändrat men avbrutet'); await page.keyboard.press('Escape');
  await expect(page.locator('.preview-body')).toContainText('Hej! Jag återkommer i morgon.');
  expect(await contents(page)).toContain('Hej! Jag återkommer i morgon.');
});


test('the divider changes the list width, remembers it, and a double-click resets it', async ({ page }) => {
  await page.goto('/'); await loadSamples(page);
  const list = page.locator('.list-column'), divider = page.getByRole('separator', { name: 'List width' });
  const start = (await list.boundingBox())!.width;
  const handle = (await divider.boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 200); await page.mouse.down();
  await page.mouse.move(handle.x + 300, handle.y + 200, { steps: 4 }); await page.mouse.up();
  const wider = (await list.boundingBox())!.width;
  expect(wider).toBeGreaterThan(start + 250);
  await page.reload(); await loadSamples(page);
  expect(Math.round((await list.boundingBox())!.width)).toBe(Math.round(wider));
  await divider.focus(); await page.keyboard.press('ArrowLeft');
  expect(Math.round((await list.boundingBox())!.width)).toBe(Math.round(wider - 32));
  // The preview always keeps room, however far the divider is dragged.
  const box = (await divider.boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + 200); await page.mouse.down(); await page.mouse.move(2000, box.y + 200); await page.mouse.up();
  expect((await page.locator('.preview-pane').boundingBox())!.width).toBeGreaterThanOrEqual(319);
  await divider.dblclick();
  expect(Math.round((await list.boundingBox())!.width)).toBe(Math.round(start));
});

test('days fold one at a time or all at once; a search still shows everything', async ({ page }) => {
  await page.goto('/');
  await page.locator('.loading-state').waitFor({ state: 'hidden' });
  await page.evaluate(async () => {
    const runtime = await import('/src/services/runtime.ts'), domain = await import('/src/domain/library.ts');
    const day = 86_400_000, now = Date.now();
    for (const [content, age] of [['Förra veckan', 8 * day], ['I förrgår', 2 * day], ['Igår ett', day], ['Igår två', day + 60_000], ['Idag', 0]] as const) await runtime.dispatch({ type: 'addClip', clip: domain.makeClip(content, now - age) });
  });
  const rows = page.locator('.clip-row');
  await expect(rows).toHaveCount(5);
  // A folded heading also tells how many clips it holds, so match on its label.
  const day = (label: string) => page.locator('.day-heading button').filter({ hasText: label });
  const yesterday = day('Yesterday');
  await yesterday.click();
  await expect(yesterday).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.day-heading.collapsed')).toContainText('2');
  await expect(rows).toHaveCount(3);
  // Arrow keys skip the folded day.
  await page.getByRole('button', { name: 'Show Idag', exact: true }).click();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.clip-row.active')).toHaveAttribute('aria-label', 'Show I förrgår');
  await page.getByRole('button', { name: 'Collapse all days', exact: true }).click();
  await expect(rows).toHaveCount(0);
  await expect(page.locator('.day-heading.collapsed')).toHaveCount(4);
  await page.screenshot({ path: '.impeccable/review/folded-days-light.png' });
  // Search ignores folding; the choice to fold everything is remembered.
  await page.getByRole('textbox', { name: 'Search your clips' }).fill('igår');
  await expect(rows).toHaveCount(2);
  await page.getByRole('textbox', { name: 'Search your clips' }).fill('');
  await page.reload(); await page.locator('.loading-state').waitFor({ state: 'hidden' });
  await page.evaluate(async () => { const runtime = await import('/src/services/runtime.ts'), domain = await import('/src/domain/library.ts'); await runtime.dispatch({ type: 'addClip', clip: domain.makeClip('Efter omladdning') }); });
  await expect(page.locator('.day-heading.collapsed')).toHaveCount(1);
  await day('Today').click();
  await expect(rows).toHaveCount(1);
  await page.getByRole('button', { name: 'Expand all days', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Collapse all days', exact: true })).toBeVisible();
});
