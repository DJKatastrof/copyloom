import { expect, test } from '@playwright/test';
import { dragImage, editorHost, imagePoint, savedPixels } from './editor-host';

test('crop can be cancelled, adjusted, applied, undone and exported at its new size', async ({ page }) => {
  await editorHost(page); await page.goto('/editor.html'); await expect(page.locator('.editor-stage')).toBeVisible();
  await page.keyboard.press('c'); await dragImage(page, [100, 100], [700, 400]);
  await page.keyboard.press('Escape'); await expect(page.locator('.editor-dimensions')).toHaveText('800 × 480');
  await page.keyboard.press('c'); await dragImage(page, [100, 100], [700, 400]);
  await dragImage(page, [700, 400], [650, 350]); await page.keyboard.press('Enter');
  await expect(page.locator('.editor-dimensions')).toHaveText('550 × 250');
  await page.keyboard.press('Control+z'); await expect(page.locator('.editor-dimensions')).toHaveText('800 × 480');
  await page.keyboard.press('Control+y'); await expect(page.locator('.editor-dimensions')).toHaveText('550 × 250');
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  const exported = await savedPixels(page, [[10, 230]]); expect(exported.width).toBe(550); expect(exported.height).toBe(250); expect(exported.points[0]).toEqual([246, 247, 251, 255]);
});

test('highlighter blends with the source and numbered steps are placed, renumbered and moved', async ({ page }) => {
  await editorHost(page); await page.goto('/editor.html'); await expect(page.locator('.editor-stage')).toBeVisible();
  await page.keyboard.press('h'); await dragImage(page, [300, 100], [600, 160]);
  for (const [x, y] of [[300, 250], [400, 250]]) { await page.keyboard.press('i'); const p = await imagePoint(page, x, y); await page.mouse.click(p.x, p.y); }
  await expect(page.locator('.editor-stage')).toHaveAttribute('data-shapes', '3');
  await expect(page.getByRole('spinbutton', { name: 'Number', exact: true })).toHaveValue('2');
  await page.getByRole('spinbutton', { name: 'Number', exact: true }).fill('5');
  await page.keyboard.press('Escape'); await dragImage(page, [400, 250], [450, 250]);
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  const pixels = await savedPixels(page, [[580, 140], [438, 250], [380, 250]]);
  expect(pixels.points[0][0]).toBeGreaterThan(246); expect(pixels.points[0][2]).toBeLessThan(210);
  expect(pixels.points[1]).toEqual([255, 207, 51, 255]); expect(pixels.points[2]).toEqual([255, 255, 255, 255]);
  await page.screenshot({ path: '.impeccable/review/editor-tools-light.png' });
});

test('a placed step can be resized immediately and the next number requires selecting the tool again', async ({ page }) => {
  await editorHost(page); await page.goto('/editor.html'); await expect(page.locator('.editor-stage')).toBeVisible();
  await page.keyboard.press('i'); const first = await imagePoint(page, 300, 200); await page.mouse.click(first.x, first.y);
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('spinbutton', { name: 'Number', exact: true })).toHaveValue('1');
  await expect(page.getByRole('combobox', { name: 'Text size' })).toHaveText('18 px');
  await dragImage(page, [315, 215], [345, 245]); await expect(page.locator('.editor-stage')).toHaveAttribute('data-shapes', '1');
  await expect(page.getByRole('combobox', { name: 'Text size' })).toHaveText('36 px');
  const empty = await imagePoint(page, 600, 350); await page.mouse.click(empty.x, empty.y); await expect(page.locator('.editor-stage')).toHaveAttribute('data-shapes', '1');
  await page.getByRole('button', { name: 'Numbered steps', exact: true }).click(); await expect(page.getByRole('spinbutton', { name: 'Number', exact: true })).toHaveValue('2');
  const second = await imagePoint(page, 500, 250); await page.mouse.click(second.x, second.y);
  await expect(page.locator('.editor-stage')).toHaveAttribute('data-shapes', '2'); await expect(page.getByRole('spinbutton', { name: 'Number', exact: true })).toHaveValue('2');
  await expect(page.getByRole('combobox', { name: 'Text size' })).toHaveText('36 px');
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Control+z'); await expect(page.locator('.editor-stage')).toHaveAttribute('data-shapes', '1');
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+y'); await page.keyboard.press('Control+y');
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  const pixels = await savedPixels(page, [[339, 215], [524, 250]]); expect(pixels.points).toEqual([[229, 45, 69, 255], [229, 45, 69, 255]]);
  await page.screenshot({ path: '.impeccable/review/editor-steps-027.png' });
});

test('steps start small and font size changes both the circle and the next step', async ({ page }) => {
  await editorHost(page); await page.goto('/editor.html'); await expect(page.locator('.editor-stage')).toBeVisible();
  await page.keyboard.press('i'); const first = await imagePoint(page, 300, 200); await page.mouse.click(first.x, first.y);
  await expect(page.getByRole('combobox', { name: 'Text size' })).toHaveText('18 px');
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  const small = await savedPixels(page, [[312, 200], [318, 200]]); expect(small.points).toEqual([[229, 45, 69, 255], [255, 255, 255, 255]]);
  await page.getByRole('combobox', { name: 'Text size' }).click(); await page.getByRole('option', { name: '24 px', exact: true }).click();
  await expect(page.locator('.editor-stage')).toHaveAttribute('data-shapes', '1');
  await page.keyboard.press('i'); const second = await imagePoint(page, 500, 250); await page.mouse.click(second.x, second.y);
  await expect(page.getByRole('spinbutton', { name: 'Number', exact: true })).toHaveValue('2'); await expect(page.getByRole('combobox', { name: 'Text size' })).toHaveText('24 px');
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await page.waitForFunction(() => (window as any).editorHost.saves.length === 2);
  const larger = await savedPixels(page, [[318, 200], [518, 250]]); expect(larger.points).toEqual([[229, 45, 69, 255], [229, 45, 69, 255]]);
  await page.screenshot({ path: '.impeccable/review/editor-step-font-027.png' });
  await page.getByRole('spinbutton', { name: 'Number', exact: true }).fill('9999');
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await page.waitForFunction(() => (window as any).editorHost.saves.length === 3);
  const wide = await savedPixels(page, [[531, 250]]); expect(wide.points[0]).toEqual([229, 45, 69, 255]);
  await page.keyboard.press('Control+z'); await page.keyboard.press('i'); await expect(page.getByRole('spinbutton', { name: 'Number', exact: true })).toHaveValue('3');
  await expect(page.getByRole('combobox', { name: 'Text size' })).toHaveText('24 px');
});

test('repeated crop exports preserve opaque redactions even under later effects', async ({ page }) => {
  await editorHost(page); await page.goto('/editor.html'); await expect(page.locator('.editor-stage')).toBeVisible();
  await page.keyboard.press('d'); await dragImage(page, [100, 200], [200, 280]);
  await page.keyboard.press('h'); await dragImage(page, [80, 180], [220, 300]);
  await page.keyboard.press('c'); await dragImage(page, [50, 150], [500, 400]); await page.keyboard.press('Enter');
  await page.keyboard.press('c'); await dragImage(page, [80, 180], [450, 350]); await page.keyboard.press('Enter');
  await expect(page.locator('.editor-dimensions')).toHaveText('370 × 170');
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  const exported = await savedPixels(page, [[50, 50]]); expect(exported.points[0]).toEqual([0, 0, 0, 255]);
});

test.describe('Windows scaling at 150%', () => {
test.use({ deviceScaleFactor: 1.5 });
test('tool letters leave text input alone and crop keeps its pixel dimensions', async ({ page }) => {
  await editorHost(page, { theme: 'dark' }); await page.goto('/editor.html'); await expect(page.locator('.editor-stage')).toBeVisible();
  await page.keyboard.press('t'); const p = await imagePoint(page, 200, 200); await page.mouse.click(p.x, p.y);
  await page.getByRole('textbox', { name: 'Text on image' }).fill('chart and history'); await expect(page.getByRole('button', { name: 'Text', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Control+Enter'); await page.keyboard.press('c'); await dragImage(page, [100, 100], [700, 400]); await page.keyboard.press('Enter');
  await expect(page.locator('.editor-dimensions')).toHaveText('600 × 300');
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  const exported = await savedPixels(page, [[10, 280]]); expect(exported.width).toBe(600); expect(exported.height).toBe(300);
  await page.screenshot({ path: '.impeccable/review/editor-tools-dark.png' });
});
});
