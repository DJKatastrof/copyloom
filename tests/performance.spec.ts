import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

test('10,000 clips: loading, search and panel', async ({ page }) => {
  test.setTimeout(120000);
  await page.addInitScript(() => {
    const host = window as unknown as Record<string, unknown>;
    let id = 0;
    host.isTauri = true;
    host.__TAURI_INTERNALS__ = { transformCallback: () => ++id, invoke: async (command: string) => {
      if (command === 'load_library') {
        performance.mark('library-returned');
        return { revision: 1, categories: [], paused: false, settings: { shortcut: 'Ctrl+Shift+V', retentionDays: null, theme: 'light' }, storage: 'encrypted', clips: Array.from({ length: 10000 }, (_, index) => ({ id: 'perf-' + index, title: index === 9999 ? 'Unik slutanteckning' : 'Anteckning ' + index, content: index === 9999 ? 'unikprestandasökning' : 'Vanlig svensk anteckning nummer ' + index + ' med innehåll som går att söka i.', kind: 'text', createdAt: Date.now() - index * 1000, lastUsedAt: null, favorite: false, categoryIds: [] })) };
      }
      if (command.startsWith('plugin:event|')) return ++id;
      return undefined;
    }};
    host.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  });
  await page.goto('/');
  const allClips = page.getByRole('navigation', { name: 'Library', exact: true }).getByRole('button', { name: /All clips/ });
  await expect(allClips).toContainText('10000');
  await expect(page.locator('.clip-row').first()).toBeVisible();
  const loadedMs = await page.evaluate(() => performance.now() - performance.getEntriesByName('library-returned').at(-1)!.startTime);
  const initialCards = await page.locator('.clip-row').count();
  const start = Date.now();
  await page.getByRole('textbox', { name: "Search your clips" }).fill('unikprestandasökning');
  await expect(page.getByRole('button', { name: 'Show Unik slutanteckning', exact: true })).toBeVisible();
  const searchMs = Date.now() - start;
  await page.getByRole('textbox', { name: "Search your clips" }).fill('');
  await expect(page.locator('.results-label')).toHaveCount(0);
  // Scrolling to the end of a long history mounts only the rows on screen.
  await page.locator('.clip-list').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(page.getByRole('button', { name: 'Show Unik slutanteckning', exact: true })).toBeVisible();
  expect(await page.locator('.clip-row').count()).toBeLessThan(100);
  await page.getByRole('button', { name: "Quick panel", exact: true }).click();
  // Native mock does not emit view events; render through the normal query entry.
  await page.goto('/?view=panel');
  await expect(page.locator('.quick-panel .clip-row').first()).toBeVisible();
  const panelCards = await page.locator('.quick-panel .clip-row').count();
  const report = { loadedMs: Math.round(loadedMs), searchMs, initialCards, panelCards, clips: 10000, environment: 'Edge + Vite, syntetisk metadata; inte kall Windows-start' };
  console.log('PERFORMANCE ' + JSON.stringify(report));
  writeFileSync('.cache/performance-' + (process.env.COPYLOOM_PERF_PHASE ?? 'after') + '.json', JSON.stringify(report, null, 2));
  if (process.env.COPYLOOM_PERF_PHASE !== 'before') {
    expect(initialCards).toBeLessThan(100);
    expect(panelCards).toBeLessThan(40);
    await page.locator('.quick-panel .clip-list').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(page.getByRole('button', { name: 'Show Unik slutanteckning', exact: true })).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.clip-row.active')).toHaveCount(1);
  }
});
