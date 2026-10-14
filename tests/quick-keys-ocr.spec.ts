import { expect, test, type Page } from '@playwright/test';

type Recorded = { id: string; plain: boolean }[];
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';

async function open(page: Page, panel: boolean, ocrError: string | null = null) {
  await page.addInitScript(({ panel, ocrError, pixel }) => {
    const root = window as any; root.isTauri = true; root.__COPYLOOM_PANEL__ = panel; root.copies = []; root.ocr = [];
    let callbackId = 0; const now = Date.now();
    const clip = (id: string, title: string, kind: string, content: string, age: number) => ({ id, title, kind, content, createdAt: now - age, lastUsedAt: null, favorite: false, categoryIds: [] });
    const clips = [clip('first', 'First note', 'text', 'First note', 0), clip('second', 'Second note', 'text', 'Second note', 1000), clip('image', 'Screenshot', 'image', pixel, 2000),
      ...Array.from({ length: 9 }, (_, index) => clip('extra-' + index, 'Extra ' + index, 'text', 'Extra ' + index, 3000 + index * 1000))];
    const library = { revision: 1, categories: [], paused: false, storage: 'encrypted', settings: { shortcut: 'Ctrl+Shift+V', retentionDays: null, theme: 'light' }, clips };
    root.__TAURI_INTERNALS__ = { transformCallback: () => ++callbackId, invoke: async (command: string, args: any) => {
      if (command === 'load_library' || command === 'apply_action') return library;
      if (command === 'copy_clip') { root.copies.push({ id: args.id, plain: args.plain }); return { pasted: false }; }
      if (command === 'copy_image_text') { root.ocr.push(args.id); if (ocrError) throw ocrError; return null; }
      return callbackId;
    } };
    root.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  }, { panel, ocrError, pixel: PIXEL });
  await page.goto(panel ? '/?view=panel' : '/');
  await expect(page.getByRole('button', { name: 'Show First note', exact: true })).toBeVisible();
}
const copies = (page: Page) => page.evaluate(() => (window as unknown as { copies: Recorded }).copies);
const ocr = (page: Page) => page.evaluate(() => (window as unknown as { ocr: string[] }).ocr);

test('Ctrl+1–9 uses clips in the order shown, also from the search field; Shift gives plain text', async ({ page }) => {
  await open(page, false);
  await page.keyboard.press('Control+2'); await page.keyboard.press('Control+Shift+1');
  await page.getByRole('searchbox').or(page.locator('.search-box input')).first().fill('second');
  await expect(page.getByRole('button', { name: 'Show First note', exact: true })).toHaveCount(0);
  await page.keyboard.press('Control+1');
  // A number without a card does nothing.
  await page.keyboard.press('Control+9');
  await expect.poll(() => copies(page)).toEqual([{ id: 'second', plain: false }, { id: 'first', plain: true }, { id: 'second', plain: false }]);
});

test('numbers show only when Ctrl is held for a moment', async ({ page }) => {
  await open(page, false);
  const keys = page.locator('.quick-key');
  await page.keyboard.press('Control+2');
  await expect(keys).toHaveCount(0);
  await page.keyboard.down('Control');
  await expect(keys).toHaveCount(9);
  await expect(keys.first()).toHaveText('1'); await expect(keys.last()).toHaveText('9');
  await expect(page.locator('[data-clip-id="first"] .quick-key')).toHaveText('1');
  await expect(page.locator('[data-clip-id="image"] .quick-key')).toHaveText('3');
  await page.keyboard.up('Control');
  await expect(keys).toHaveCount(0);
});

test('Ctrl+1 in the quick panel uses the first clip', async ({ page }) => {
  await open(page, true);
  await page.keyboard.press('Control+1');
  await expect.poll(() => copies(page)).toEqual([{ id: 'first', plain: false }]);
});

for (const panel of [false, true]) test('Copy text in image is only offered for images in the ' + (panel ? 'panel' : 'bibliotek'), async ({ page }) => {
  await open(page, panel);
  await page.getByRole('button', { name: 'Show Screenshot', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy text from image', exact: true }).click();
  await expect.poll(() => ocr(page)).toEqual(['image']);
  await expect(page.getByRole('status').filter({ hasText: 'Text from the image copied.' })).toBeVisible();
  await page.getByRole('button', { name: 'Show First note', exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Copy', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Copy text from image', exact: true })).toHaveCount(0);
});

test('an image without text gives a translated message', async ({ page }) => {
  await open(page, false, 'No text was found in the image.');
  await page.getByRole('button', { name: 'Show Screenshot', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy text from image', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'No text was found in the image.' })).toBeVisible();
});
