import { expect, test } from '@playwright/test';
import { dragImage, editorHost, imagePoint, savedPixels } from './editor-host';

for (const [tool, key] of [['Pixelate', 'o'], ['Rectangle', 'r'], ['Redact', 'd'], ['Highlighter', 'h']]) {
  test(`${tool} shows directional resize cursors and keeps one shape when dragging a handle`, async ({ page }) => {
    await editorHost(page); await page.goto('/editor.html'); await expect(page.locator('.editor-stage')).toBeVisible();
    await page.keyboard.press(key); await dragImage(page, [100, 100], [300, 300]);
    const stage = page.locator('.editor-stage');
    const handles: [number, number, string][] = [
      [100, 100, 'nwse-resize'], [200, 100, 'ns-resize'], [300, 100, 'nesw-resize'], [300, 200, 'ew-resize'],
      [300, 300, 'nwse-resize'], [200, 300, 'ns-resize'], [100, 300, 'nesw-resize'], [100, 200, 'ew-resize'],
    ];
    for (const [x, y, cursor] of handles) {
      const p = await imagePoint(page, x, y); await page.mouse.move(p.x, p.y); await expect(stage).toHaveCSS('cursor', cursor);
    }
    const corner = await imagePoint(page, 300, 300), resized = await imagePoint(page, 350, 350);
    await page.mouse.move(corner.x, corner.y); await page.mouse.down(); await page.mouse.move(resized.x, resized.y, { steps: 4 });
    await expect(stage).toHaveCSS('cursor', 'nwse-resize'); await page.mouse.up();
    await expect(stage).toHaveAttribute('data-shapes', '1'); await expect(stage).toHaveCSS('cursor', 'nwse-resize');
    await page.keyboard.press('Control+z'); await expect(stage).toHaveCSS('cursor', 'crosshair');
    await page.keyboard.press('Control+y'); await expect(stage).toHaveCSS('cursor', 'crosshair');
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    const inside = await imagePoint(page, 200, 200), empty = await imagePoint(page, 500, 100);
    await page.mouse.move(inside.x, inside.y); await expect(stage).toHaveCSS('cursor', 'move');
    await page.mouse.click(inside.x, inside.y); await page.mouse.move(resized.x, resized.y); await expect(stage).toHaveCSS('cursor', 'nwse-resize');
    await page.mouse.move(empty.x, empty.y); await expect(stage).toHaveCSS('cursor', 'default');
    await page.keyboard.press(key); await dragImage(page, [500, 100], [600, 200]);
    await expect(stage).toHaveAttribute('data-shapes', '2');
  });
}

test('crop, arrow and text handles use the same manipulation cursors', async ({ page }) => {
  await editorHost(page); await page.goto('/editor.html'); await expect(page.locator('.editor-stage')).toBeVisible();
  const stage = page.locator('.editor-stage');
  await page.keyboard.press('c'); await dragImage(page, [100, 100], [300, 300]);
  for (const [x, y, cursor] of [[100, 100, 'nwse-resize'], [300, 100, 'nesw-resize'], [200, 100, 'ns-resize'], [300, 200, 'ew-resize'], [200, 200, 'move']] as const) {
    const p = await imagePoint(page, x, y); await page.mouse.move(p.x, p.y); await expect(stage).toHaveCSS('cursor', cursor);
  }
  await page.keyboard.press('Escape'); await page.keyboard.press('a'); await dragImage(page, [100, 100], [300, 200]);
  const endpoint = await imagePoint(page, 300, 200); await page.mouse.move(endpoint.x, endpoint.y); await expect(stage).toHaveCSS('cursor', 'move');
  await dragImage(page, [300, 200], [350, 250]); await expect(stage).toHaveAttribute('data-shapes', '1');
  await page.keyboard.press('t'); const text = await imagePoint(page, 450, 100); await page.mouse.click(text.x, text.y);
  await page.getByRole('textbox', { name: 'Text on image' }).fill('Cursor test'); await page.keyboard.press('Control+Enter');
  await page.mouse.move(text.x, text.y); await expect(stage).toHaveCSS('cursor', 'nwse-resize');
});

test('panning overrides hover cursors and releases them without moving the mouse', async ({ page }) => {
  await editorHost(page); await page.goto('/editor.html'); await expect(page.locator('.editor-stage')).toBeVisible();
  await page.keyboard.press('o'); await dragImage(page, [100, 100], [300, 300]);
  const stage = page.locator('.editor-stage'), corner = await imagePoint(page, 100, 100);
  await page.mouse.move(corner.x, corner.y); await expect(stage).toHaveCSS('cursor', 'nwse-resize');
  await page.keyboard.down('Space'); await expect(stage).toHaveCSS('cursor', 'grab');
  await page.mouse.down(); await expect(stage).toHaveCSS('cursor', 'grabbing');
  await page.mouse.up(); await expect(stage).toHaveCSS('cursor', 'grab');
  await page.keyboard.up('Space'); await expect(stage).toHaveCSS('cursor', 'nwse-resize');
  await page.mouse.down({ button: 'middle' }); await expect(stage).toHaveCSS('cursor', 'grabbing');
  await page.mouse.up({ button: 'middle' }); await expect(stage).toHaveCSS('cursor', 'nwse-resize');
});

test('a selected pixelation moves and resizes without drawing another effect', async ({ page }) => {
  await editorHost(page); await page.goto('/editor.html'); await expect(page.locator('.editor-stage')).toBeVisible();
  await page.keyboard.press('o'); await dragImage(page, [100, 100], [200, 200]);
  await dragImage(page, [150, 150], [250, 250]);
  await expect(page.locator('.editor-stage')).toHaveAttribute('data-shapes', '1');
  await dragImage(page, [300, 300], [350, 350]);
  await expect(page.locator('.editor-stage')).toHaveAttribute('data-shapes', '1');
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
  await expect(page.locator('.editor-stage')).toHaveAttribute('data-shapes', '1');
  await page.keyboard.press('Control+z');
  await expect(page.locator('.editor-stage')).toHaveAttribute('data-shapes', '0');
  await page.keyboard.press('Control+y'); await page.keyboard.press('Control+y'); await page.keyboard.press('Control+y');
  await dragImage(page, [500, 100], [600, 200]);
  await expect(page.locator('.editor-stage')).toHaveAttribute('data-shapes', '2');
});

test('pixelation stays visible during drawing, moving and resizing, and restores uncovered pixels', async ({ page }) => {
  await editorHost(page, { gradient: true }); await page.goto('/editor.html'); await expect(page.locator('.editor-stage')).toBeVisible();
  const stage = page.locator('.editor-stage');
  const pixels = (points: [number, number][]) => stage.evaluate((node, points) => {
    const element = node as HTMLElement, canvases = node.querySelectorAll('canvas');
    const read = (canvas: HTMLCanvasElement) => {
      const ratio = canvas.width / element.clientWidth, ctx = canvas.getContext('2d')!;
      return points.map(([x, y]) => Array.from(ctx.getImageData(Math.floor((Number(element.dataset.offsetX) + x * Number(element.dataset.zoom)) * ratio), Math.floor((Number(element.dataset.offsetY) + y * Number(element.dataset.zoom)) * ratio), 1, 1).data));
    };
    return { base: read(canvases[0]), overlay: read(canvases[1]) };
  }, points);
  await page.keyboard.press('o');
  const start = await imagePoint(page, 100, 320), end = await imagePoint(page, 260, 440);
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 4 });
  await expect.poll(async () => (await pixels([[120, 360]])).overlay[0][3]).toBe(255);
  const drawn = await pixels([[120, 360], [121, 360]]);
  expect(drawn.overlay[0]).toEqual(drawn.overlay[1]); expect(drawn.overlay[0][0]).not.toBe(120); expect(drawn.base[0][3]).toBe(0);
  await page.mouse.up();
  const center = await imagePoint(page, 160, 380), moved = await imagePoint(page, 360, 380);
  await page.mouse.move(center.x, center.y); await page.mouse.down(); await page.mouse.move(moved.x, moved.y, { steps: 4 });
  await expect.poll(async () => (await pixels([[320, 360]])).overlay[0][3]).toBe(255);
  const duringMove = await pixels([[320, 360], [321, 360], [120, 360]]);
  expect(duringMove.overlay[0]).toEqual(duringMove.overlay[1]); expect(duringMove.overlay[0]).not.toEqual(drawn.overlay[0]);
  expect(duringMove.base[0][3]).toBe(0); expect(duringMove.overlay[2][3]).toBe(0); expect(duringMove.base[2]).toEqual([120, 90, 130, 255]);
  await page.screenshot({ path: '.impeccable/review/editor-live-pixelation.png' }); await page.mouse.up();
  const corner = await imagePoint(page, 460, 440), resized = await imagePoint(page, 560, 460);
  await page.mouse.move(corner.x, corner.y); await page.mouse.down(); await page.mouse.move(resized.x, resized.y, { steps: 4 });
  await expect.poll(async () => (await pixels([[520, 360]])).overlay[0][3]).toBe(255);
  const duringResize = await pixels([[520, 360], [521, 360]]);
  expect(duringResize.overlay[0]).toEqual(duringResize.overlay[1]); expect(duringResize.base[0][3]).toBe(0);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect.poll(async () => (await pixels([[520, 360]])).overlay[0][3]).toBe(0);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await pixels([[120, 360]])).overlay[0]).toEqual(drawn.overlay[0]);
  await page.keyboard.press('Control+y');
  await expect.poll(async () => (await pixels([[320, 360]])).overlay[0]).toEqual(duringMove.overlay[0]);
  await expect(stage).toHaveAttribute('data-shapes', '1');
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  expect((await savedPixels(page, [[320, 360]])).points[0]).toEqual(duringMove.overlay[0]);
});

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
  const corner = await imagePoint(page, 315, 215); await page.mouse.move(corner.x, corner.y);
  await expect(page.locator('.editor-stage')).toHaveCSS('cursor', 'nwse-resize');
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
test('resize cursors follow zoomed image coordinates', async ({ page }) => {
  await editorHost(page, { theme: 'dark' }); await page.goto('/editor.html'); await expect(page.locator('.editor-stage')).toBeVisible();
  await page.keyboard.press('o'); await dragImage(page, [100, 100], [300, 300]);
  const stage = page.locator('.editor-stage'), corner = await imagePoint(page, 300, 100);
  await page.mouse.move(corner.x, corner.y); await expect(stage).toHaveCSS('cursor', 'nesw-resize');
  await page.keyboard.down('Control'); await page.mouse.wheel(0, -180); await page.keyboard.up('Control');
  const zoomed = await imagePoint(page, 100, 300); await page.mouse.move(zoomed.x, zoomed.y); await expect(stage).toHaveCSS('cursor', 'nesw-resize');
  await dragImage(page, [100, 300], [80, 320]); await expect(stage).toHaveAttribute('data-shapes', '1');
});
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
