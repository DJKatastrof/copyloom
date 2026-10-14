import { expect, test } from '@playwright/test';
import { captureEditor, dragImage, editorHost, imagePoint, savedPixels } from './editor-host';

test('block size updates existing pixels, undo, redo and full resolution export', async ({ page }) => {
  await editorHost(page, { gradient: true }); await page.goto('/editor.html');
  await expect(page.locator('.editor-stage')).toBeVisible();
  await page.getByRole('button', { name: 'Pixelate', exact: true }).click();
  const size = page.getByRole('combobox', { name: 'Block size' });
  await size.click(); await page.getByRole('option', { name: '4 px', exact: true }).click();
  await dragImage(page, [100, 300], [400, 440]);
  const preview = () => page.locator('.editor-stage').evaluate(node => {
    const stage = node as HTMLElement, canvas = node.querySelectorAll('canvas')[1];
    const ratio = canvas.width / stage.clientWidth;
    const x = (Number(stage.dataset.offsetX) + 120 * Number(stage.dataset.zoom)) * ratio;
    const y = (Number(stage.dataset.offsetY) + 360 * Number(stage.dataset.zoom)) * ratio;
    return Array.from(canvas.getContext('2d')!.getImageData(Math.floor(x), Math.floor(y), 1, 1).data);
  });
  await expect.poll(async () => (await preview())[3]).toBe(255);
  const fine = await preview();
  await size.click(); await page.getByRole('option', { name: '64 px', exact: true }).click();
  const coarse = await preview(); expect(coarse).not.toEqual(fine);
  await page.keyboard.press('Control+z');
  // Reselecting restores the same selection handles as before undo.
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  const point = await imagePoint(page, 200, 370); await page.mouse.click(point.x, point.y);
  await expect(size).toContainText('4 px'); expect(await preview()).toEqual(fine);
  await page.keyboard.press('Control+Shift+z'); await page.mouse.click(point.x, point.y);
  await expect(size).toContainText('64 px'); expect(await preview()).toEqual(coarse);
  await page.keyboard.press('Control+s');
  const output = await savedPixels(page, [[120, 360], [140, 360], [190, 360]]);
  expect(output).toMatchObject({ width: 800, height: 480 });
  expect(output.points[0]).toEqual(output.points[1]); expect(output.points[0]).not.toEqual(output.points[2]);
});

test('compact icon toolbar fits small captures in both languages and themes', async ({ page }) => {
  await editorHost(page, { width: 441, height: 346 });
  await page.setViewportSize({ width: 640, height: 534 }); await page.goto('/editor.html');
  await expect(page.locator('.editor-stage')).toBeVisible();
  expect(await page.evaluate(() => (window as any).editorHost.ready)).toEqual({ width: 441, height: 346 });
  await expect(page.locator('.editor-colors')).toHaveCount(0);
  await expect(page.locator('.editor-tools button span')).toHaveCount(0);
  await page.screenshot({ path: '.impeccable/review/compact-editor-light.png' });
  await page.getByRole('button', { name: 'Pixelate', exact: true }).click();
  await dragImage(page, [40, 190], [390, 270]);
  await page.getByRole('combobox', { name: 'Block size' }).click();
  await page.screenshot({ path: '.impeccable/review/compact-editor-pixelate.png' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.setViewportSize({ width: 640, height: 400 });
  await page.evaluate(async () => { document.documentElement.dataset.theme = 'dark'; const { setLanguage } = await import('/src/i18n.ts'); setLanguage('sv'); });
  await expect(page.getByRole('combobox', { name: 'Textstorlek' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.impeccable/review/compact-editor-dark-sv.png' });
});

test('original resolution, binary saving and a new copy attempt without a new clip', async ({ page }) => {
  await editorHost(page, { copyFailure: true }); await page.goto('/editor.html?id=source-1');
  await expect(page.locator('.editor-stage')).toBeVisible();
  await page.getByRole('button', { name: "Copy and close", exact: true }).click();
  await expect(page.getByRole('button', { name: "Copy again" })).toBeVisible();
  expect(await savedPixels(page, [[0, 0]])).toMatchObject({ width: 800, height: 480 });
  await page.getByRole('button', { name: "Copy again" }).click();
  expect(await page.evaluate(() => (window as any).editorHost.saves.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).editorHost.closed)).toBe(0);
  await page.evaluate(() => { (window as any).editorHost.copyFailure = false; });
  await page.getByRole('button', { name: "Copy again" }).click();
  expect(await page.evaluate(() => (window as any).editorHost.copies)).toEqual(['saved-1', 'saved-1']);
  expect(await page.evaluate(() => (window as any).editorHost.closed)).toBe(1);
});

test('an arrow at 200 percent exports at the right coordinates; undo and redo', async ({ page }) => {
  await editorHost(page); await page.goto('/editor.html'); await expect(page.locator('.editor-stage')).toBeVisible();
  await page.getByTitle('View at 100%', { exact: true }).click();
  const stage = page.locator('.editor-stage'); await stage.hover(); await page.keyboard.down('Control'); await page.mouse.wheel(0, -Math.log(2) / .002); await page.keyboard.up('Control');
  await expect.poll(async () => Number(await stage.getAttribute('data-zoom'))).toBeCloseTo(2, 2);
  await page.getByRole('button', { name: "Arrow", exact: true }).click(); await dragImage(page, [230, 210], [410, 210]);
  await expect(stage).toHaveAttribute('data-shapes', '1');
  await page.keyboard.press('Control+z'); await expect(stage).toHaveAttribute('data-shapes', '0');
  await page.keyboard.press('Control+Shift+z'); await expect(stage).toHaveAttribute('data-shapes', '1');
  await page.keyboard.press('Control+s');
  expect((await savedPixels(page, [[300, 210]])).points[0]).toEqual([229, 45, 69, 255]);
});

test('a rectangle moves, resizes and is deleted without losing the undo history', async ({ page }) => {
  await editorHost(page); await page.goto('/editor.html'); await expect(page.locator('.editor-stage')).toBeVisible();
  await page.getByRole('button', { name: "Rectangle", exact: true }).click(); await dragImage(page, [100, 100], [200, 180]);
  await page.getByRole('button', { name: "Select", exact: true }).click(); await dragImage(page, [150, 140], [250, 240]);
  await dragImage(page, [300, 280], [350, 300]);
  await page.keyboard.press('Delete'); await expect(page.locator('.editor-stage')).toHaveAttribute('data-shapes', '0');
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+s');
  expect((await savedPixels(page, [[200, 220], [350, 250]])).points).toEqual([[229, 45, 69, 255], [229, 45, 69, 255]]);
});

test('Redact is opaque even where pixelation overlaps; the blocks are uniform', async ({ page }) => {
  await editorHost(page); await page.goto('/editor.html'); await expect(page.locator('.editor-stage')).toBeVisible();
  await page.getByRole('button', { name: "Redact", exact: true }).click(); await dragImage(page, [60.2, 210.1], [330.5, 244.7]);
  await page.getByRole('button', { name: "Pixelate", exact: true }).click(); await dragImage(page, [40, 195], [450, 290]);
  // Guidance is a tooltip on the tool, not a line of text in the toolbar.
  await expect(page.getByRole('button', { name: "Pixelate", exact: true })).toHaveAttribute('title', /Use Redact for sensitive information/);
  await page.keyboard.press('Control+s');
  const output = await savedPixels(page, [[61, 211], [329, 244], [355, 270], [356, 271]]);
  expect(output.points[0]).toEqual([0, 0, 0, 255]); expect(output.points[1]).toEqual([0, 0, 0, 255]); expect(output.points[2]).toEqual(output.points[3]);
});

test('text can be typed, changed and undone; Delete in the text field does not delete the shape', async ({ page }) => {
  await editorHost(page); await page.goto('/editor.html'); await expect(page.locator('.editor-stage')).toBeVisible();
  await page.getByRole('button', { name: 'Text', exact: true }).click(); const point = await imagePoint(page, 300, 350); await page.mouse.click(point.x, point.y);
  const text = page.getByRole('textbox', { name: "Text on image" }); await text.fill('Kontrollera här'); await page.keyboard.press('Control+Enter');
  await expect(page.locator('.editor-stage')).toHaveAttribute('data-shapes', '1');
  await page.getByRole('button', { name: "Select", exact: true }).click(); await page.mouse.dblclick(point.x + 15, point.y + 15);
  await expect(text).toHaveValue('Kontrollera här'); await page.keyboard.press('Backspace'); await expect(text).toHaveValue('Kontrollera hä');
  await text.fill('Klart'); await page.keyboard.press('Control+Enter'); await page.keyboard.press('Control+z');
  await page.mouse.dblclick(point.x + 15, point.y + 15); await expect(text).toHaveValue('Kontrollera här');
  await page.keyboard.press('Escape'); await expect(text).toHaveCount(0);
});

test('one window per image: closing affects only that window and unsaved work is protected', async ({ page }) => {
  await editorHost(page); await page.goto('/editor.html'); await expect(page.locator('.editor-stage')).toBeVisible();
  // Close requests are only accepted when addressed to this editor window.
  expect(await page.evaluate(() => (window as any).editorHost.listeners.find((listener: any) => listener.event === 'editor:close-requested')?.target)).toEqual({ kind: 'WebviewWindow', label: 'editor-1' });
  await page.getByRole('button', { name: "Arrow", exact: true }).click(); await dragImage(page, [50, 100], [220, 160]);
  await page.evaluate(() => (window as any).editorHost.emit('editor:close-requested'));
  const dialog = page.getByRole('dialog', { name: 'Copy your changes?' }); await expect(dialog).toBeVisible();
  // Compact like the library's dialogs: one button row, Discard apart on the left, Copy and close focused.
  const box = (await dialog.boundingBox())!, buttons = await Promise.all(["Discard", 'Cancel', 'Copy and close'].map(name => dialog.getByRole('button', { name, exact: true }).boundingBox()));
  expect(box.width).toBeLessThanOrEqual(360); expect(new Set(buttons.map(button => Math.round(button!.y))).size).toBe(1);
  expect(buttons[1]!.x - (buttons[0]!.x + buttons[0]!.width)).toBeGreaterThan(24);
  await expect(dialog.getByRole('button', { name: 'Copy and close', exact: true })).toBeFocused();
  await page.screenshot({ path: '.impeccable/review/editor-unsaved-light.png' });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; }); await page.screenshot({ path: '.impeccable/review/editor-unsaved-dark.png' });
  await page.getByRole('button', { name: "Cancel", exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.locator('.editor-stage')).toHaveAttribute('data-shapes', '1');
  expect(await page.evaluate(() => (window as any).editorHost.closed)).toBe(0);
  await page.evaluate(() => (window as any).editorHost.emit('editor:close-requested'));
  await page.getByRole('button', { name: "Copy and close", exact: true }).last().click();
  await expect.poll(() => page.evaluate(() => (window as any).editorHost.closed)).toBe(1);
  expect(await page.evaluate(() => (window as any).editorHost.saves.map((save: any) => save.source))).toEqual(['source-1']);
  expect(await page.evaluate(() => (window as any).editorHost.loads)).toEqual(['source-1']);
});

test('Save as writes what is shown at the original resolution to a file, without closing or creating a clip', async ({ page }) => {
  await editorHost(page); await page.goto('/editor.html'); await expect(page.locator('.editor-stage')).toBeVisible();
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click(); await dragImage(page, [100, 100], [200, 180]);
  const stage = page.locator('.editor-stage'), view = () => stage.evaluate(node => [(node as HTMLElement).dataset.zoom, (node as HTMLElement).dataset.offsetX, (node as HTMLElement).dataset.offsetY]);
  await page.getByTitle('View at 100%', { exact: true }).click(); const before = await view();
  await page.getByRole('button', { name: 'Save as…', exact: true }).click();
  // Program and capture time of the source clip, like Snipping Tool's "Screenshot 2026-10-07 090503.png".
  await expect(page.getByRole('status').filter({ hasText: 'Saved as Microsoft Teams 2026-10-07 090503.png' })).toBeVisible();
  const file = await page.evaluate(async () => {
    const saved = (window as any).editorHost.files[0];
    const image = await createImageBitmap(new Blob([new Uint8Array(saved.bytes)], { type: 'image/png' }));
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
    return { name: saved.name, width: image.width, height: image.height, edge: Array.from(ctx.getImageData(100, 140, 1, 1).data) };
  });
  expect(file).toEqual({ name: 'Microsoft Teams 2026-10-07 090503.png', width: 800, height: 480, edge: [229, 45, 69, 255] });
  // The confirmation floats, so the canvas keeps its zoom and position.
  expect(await view()).toEqual(before);
  await page.screenshot({ path: '.impeccable/review/editor-save-as.png' });
  // Ctrl+Shift+S saves a file too, not to history; a cancelled dialog shows nothing.
  await page.evaluate(() => { (window as any).editorHost.saveAsCancel = true; });
  await page.keyboard.press('Control+Shift+S');
  await expect.poll(() => page.evaluate(() => (window as any).editorHost.files.length)).toBe(2);
  await expect(page.locator('.editor-notice')).toHaveCount(0);
  expect(await page.evaluate(() => ({ saves: (window as any).editorHost.saves.length, closed: (window as any).editorHost.closed }))).toEqual({ saves: 0, closed: 0 });
});

test('closing without changes does not ask; Discard closes without saving', async ({ page }) => {
  await editorHost(page); await page.goto('/editor.html'); await expect(page.locator('.editor-stage')).toBeVisible();
  await page.evaluate(() => (window as any).editorHost.emit('editor:close-requested'));
  await expect.poll(() => page.evaluate(() => (window as any).editorHost.closed)).toBe(1); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: "Rectangle", exact: true }).click(); await dragImage(page, [60, 120], [250, 200]);
  await page.evaluate(() => (window as any).editorHost.emit('editor:close-requested'));
  await page.getByRole('button', { name: "Discard", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).editorHost.closed)).toBe(2);
  expect(await page.evaluate(() => (window as any).editorHost.saves.length)).toBe(0);
});

test.describe('Windows-skalning 150 %', () => {
  test.use({ deviceScaleFactor: 1.5 });
  test('100 % shows one image pixel per screen pixel without blurry edges', async ({ page }) => {
    await editorHost(page); await page.setViewportSize({ width: 1000, height: 700 }); await page.goto('/editor.html');
    const stage = page.locator('.editor-stage'); await expect(stage).toBeVisible();
    // An 800 px wide capture fits at its actual size: 533⅓ CSS px on a 150 % display.
    await expect(page.getByTitle('View at 100%', { exact: true })).toHaveText('100 %');
    expect(Number(await stage.getAttribute('data-zoom')) * 1.5).toBeCloseTo(1, 9);
    // Edges of the cyan button at image x 40–209 must land on whole screen pixels, both in the
    // canvas and in the composited window, with no blended pixels in between.
    const cyan = [0, 169, 230, 255], paper = [246, 247, 251, 255], columns = [39, 40, 209, 210];
    const canvasPixels = await stage.evaluate((node, columns) => {
      const element = node as HTMLElement, canvas = node.querySelector('canvas')!, ctx = canvas.getContext('2d')!;
      const x = Math.round(Number(element.dataset.offsetX) * 1.5), y = Math.round(Number(element.dataset.offsetY) * 1.5);
      return { ratio: canvas.width / element.getBoundingClientRect().width, pixels: columns.map(column => Array.from(ctx.getImageData(x + column, y + 353, 1, 1).data)) };
    }, columns);
    expect(canvasPixels.ratio).toBeCloseTo(1.5, 2);
    expect(canvasPixels.pixels).toEqual([paper, cyan, cyan, paper]);
    const origin = await stage.evaluate(node => { const r = node.getBoundingClientRect(), element = node as HTMLElement; return { x: r.x + Number(element.dataset.offsetX), y: r.y + Number(element.dataset.offsetY) }; });
    const shot = await page.screenshot({ scale: 'device' });
    const screenPixels = await page.evaluate(async ({ bytes, origin, columns }) => {
      const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
      const x = Math.round(origin.x * 1.5), y = Math.round(origin.y * 1.5);
      return columns.map(column => Array.from(ctx.getImageData(x + column, y + 353, 1, 1).data));
    }, { bytes: Array.from(shot), origin, columns });
    expect(screenPixels).toEqual([paper, cyan, cyan, paper]);
    await page.screenshot({ path: '.impeccable/review/editor-150-percent.png' });
  });
});

test('a save error keeps the shapes; changes after a copy error give a new clip', async ({ page }) => {
  await editorHost(page, { saveFailure: true, copyFailure: true }); await page.goto('/editor.html'); await expect(page.locator('.editor-stage')).toBeVisible();
  await page.getByRole('button', { name: "Rectangle", exact: true }).click(); await dragImage(page, [80, 80], [300, 160]);
  await page.keyboard.press('Control+s'); await expect(page.getByRole('alert')).toContainText('databasen'); await expect(page.locator('.editor-stage')).toHaveAttribute('data-shapes', '1');
  await page.evaluate(() => { (window as any).editorHost.saveFailure = false; }); await page.keyboard.press('Control+s');
  await expect(page.getByRole('button', { name: "Copy again" })).toBeVisible(); await dragImage(page, [300, 330], [500, 400]);
  await expect(page.getByRole('button', { name: "Copy and close", exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).editorHost.copyFailure = false; }); await page.keyboard.press('Control+s');
  await expect.poll(() => page.evaluate(() => (window as any).editorHost.saves.length), { timeout: 15000 }).toBe(2);
});

test('panning and fitting; the editor in light, dark and the smallest window', async ({ page }) => {
  await editorHost(page); await page.goto('/editor.html'); await expect(page.locator('.editor-stage')).toBeVisible();
  const stage = page.locator('.editor-stage'), offset = async () => ({ x: Number(await stage.getAttribute('data-offset-x')), y: Number(await stage.getAttribute('data-offset-y')) });
  // A fitted image cannot be scrolled or dragged away.
  const fitted = await offset(); await stage.hover(); await page.mouse.wheel(300, 2000);
  await page.keyboard.down('Space'); await dragImage(page, [150, 150], [250, 150]); await page.keyboard.up('Space');
  expect(await offset()).toEqual(fitted);
  // Zoomed in it pans, but its edges stop 24 px inside the canvas.
  for (let i = 0; i < 4; i++) await page.getByRole('button', { name: "Zoom in" }).click();
  await stage.focus();
  const zoomed = await offset();
  await page.keyboard.down('Space'); await dragImage(page, [150, 150], [250, 150]); await page.keyboard.up('Space');
  expect((await offset()).x).not.toBe(zoomed.x);
  await stage.hover(); for (let i = 0; i < 6; i++) await page.mouse.wheel(4000, 4000);
  const box = await stage.evaluate(node => ({ width: node.clientWidth, height: node.clientHeight, zoom: Number((node as HTMLElement).dataset.zoom) }));
  const end = await offset(); expect(end.x).toBeCloseTo(box.width - 800 * box.zoom - 24, 0); expect(end.y).toBeCloseTo(box.height - 480 * box.zoom - 24, 0);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(-4000, -4000);
  expect(await offset()).toEqual({ x: 24, y: 24 });
  await page.getByRole('button', { name: "Fit to window" }).click();
  await page.getByRole('button', { name: "Arrow", exact: true }).click(); await dragImage(page, [390, 350], [235, 365]);
  await page.getByRole('button', { name: "Redact", exact: true }).click(); await dragImage(page, [140, 216], [390, 243]);
  await page.getByRole('button', { name: 'Text', exact: true }).click(); const point = await imagePoint(page, 420, 340); await page.mouse.click(point.x, point.y);
  await page.getByRole('textbox', { name: "Text on image" }).fill('Se detaljer'); await page.keyboard.press('Control+Enter');
  await captureEditor(page, 'editor-light.png');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await captureEditor(page, 'editor-dark.png');
  await page.setViewportSize({ width: 640, height: 480 }); await page.getByRole('button', { name: "Fit to window" }).click();
  await expect(page.getByRole('button', { name: "Copy and close", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await captureEditor(page, 'editor-dark-small.png');
});

test('Ctrl+S while typing saves the text, and the text field follows the image background', async ({ page }) => {
  await editorHost(page, { theme: 'dark' }); await page.goto('/editor.html'); await expect(page.locator('.editor-stage')).toBeVisible();
  await page.getByRole('button', { name: 'Text', exact: true }).click(); await page.getByRole('button', { name: 'Color #000000', exact: true }).click();
  const point = await imagePoint(page, 300, 350); await page.mouse.click(point.x, point.y);
  const input = page.getByRole('textbox', { name: "Text on image" }); await input.fill('Svart text');
  await expect(input).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)'); await expect(input).toHaveCSS('color', 'rgb(0, 0, 0)');
  await captureEditor(page, 'editor-dark-text-input.png');
  await page.keyboard.press('Control+s');
  await expect.poll(() => page.evaluate(() => (window as any).editorHost.closed)).toBe(1);
  const pixels = await savedPixels(page, [[312, 365]]); expect(pixels.width).toBe(800);
  expect(await page.evaluate(() => (window as any).editorHost.saves.length)).toBe(1);
});

test('text on a dark image in the light theme, and controls locked during a slow save', async ({ page }) => {
  await editorHost(page); await page.goto('/editor.html'); await expect(page.locator('.editor-stage')).toBeVisible();
  await page.getByRole('button', { name: 'Text', exact: true }).click(); await page.getByRole('button', { name: 'Color #ffffff', exact: true }).click();
  const point = await imagePoint(page, 420, 12); await page.mouse.click(point.x, point.y);
  const input = page.getByRole('textbox', { name: "Text on image" }); await input.fill('Vit text');
  await expect(input).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)'); await expect(input).toHaveCSS('color', 'rgb(255, 255, 255)');
  await captureEditor(page, 'editor-light-text-input.png');
  await page.keyboard.press('Control+Enter');
  await page.evaluate(() => { (window as any).editorHost.saveDelay = 600; (window as any).editorHost.saveFailure = true; });
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('combobox', { name: "Text size" })).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('databasen');
  await expect(page.getByRole('combobox', { name: "Text size" })).toBeEnabled();
  await page.getByRole('button', { name: "Rectangle", exact: true }).click(); await dragImage(page, [100, 120], [220, 170]);
  await page.keyboard.press('Control+s'); await expect(page.getByRole('combobox', { name: "Line width" })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: "Line width" })).toBeEnabled();
});

test('Copy keeps the window open; the next copy replaces the previous one in the history', async ({ page }) => {
  await editorHost(page); await page.goto('/editor.html'); await expect(page.locator('.editor-stage')).toBeVisible();
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click(); await dragImage(page, [100, 100], [200, 180]);
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).editorHost.closed)).toBe(0);
  // Nothing changed: copying again reuses the saved clip instead of saving another.
  await page.keyboard.press('Control+Shift+C');
  await expect.poll(() => page.evaluate(() => (window as any).editorHost.copies)).toEqual(['saved-1']);
  await page.getByRole('button', { name: 'Arrow', exact: true }).click(); await dragImage(page, [300, 300], [420, 330]);
  await page.keyboard.press('Control+Shift+C');
  await expect.poll(() => page.evaluate(() => (window as any).editorHost.saves.length)).toBe(2);
  // Copy and close after copying: the earlier result is replaced, not added to.
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click(); await dragImage(page, [500, 100], [600, 180]);
  await page.keyboard.press('Control+Enter');
  await expect.poll(() => page.evaluate(() => (window as any).editorHost.closed)).toBe(1);
  expect(await page.evaluate(() => (window as any).editorHost.saves.map((save: any) => save.replaces))).toEqual([null, 'saved-1', 'saved-2']);
  expect(await page.evaluate(() => (window as any).editorHost.saves.map((save: any) => save.source))).toEqual(['source-1', 'source-1', 'source-1']);
});
