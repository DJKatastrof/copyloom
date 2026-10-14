import { expect, test } from '@playwright/test';

for (const theme of ['light', 'dark'] as const) {
  test('language labels and taller previews: ' + theme, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('/');
    await page.locator('.loading-state').waitFor({ state: 'hidden' });
    await page.evaluate(async () => {
      const runtimePath = '/src/services/runtime.ts', domainPath = '/src/domain/library.ts';
      const runtime = await import(runtimePath), domain = await import(domainPath);
      const samples = [
        ['SQL script', '/*\nTEST IN TASK: byt sender\npå en specifik task\n*/\nDECLARE @name nvarchar(80);\nSELECT Id, Name\nFROM dbo.Users\nWHERE Active = 1;\n\nSELECT COUNT(*) FROM dbo.Users;'],
        ['PowerShell script', '#Requires -Modules VMware.PowerCLI\nparam([string]$Server)\n\nConnect-VIServer $Server\nGet-VM |\n  Select-Object Name, PowerState\n\nDisconnect-VIServer $Server'],
        ['Vanlig anteckning', 'En vanlig svensk anteckning\nmed lite längre innehåll.\n\nNamn: Magnus\nTelefon: kontakta växeln'],
        ['Okänd kod', 'return value;'],
      ];
      for (const [title, content] of samples) {
        // Existing native clips can have generic kind=text; display detection works for these too.
        await runtime.dispatch({ type: 'addClip', clip: { ...domain.makeClip(content), title, kind: title === 'Okänd kod' ? 'code' : 'text' } });
      }
    });
    // The library lists code rows in a monospace face and shows the whole highlighted clip beside them.
    const row = (name: string) => page.getByRole('button', { name: 'Show ' + name, exact: true });
    const preview = page.locator('.preview-pane .clip-preview'), meta = preview.locator('.preview-meta');
    await expect(row('SQL script')).toHaveClass(/row-code/);
    await expect(row('Vanlig anteckning')).toHaveClass(/row-text/);
    await row('SQL script').click();
    await expect(meta).toContainText('SQL');
    await expect(preview.locator('code')).toHaveAttribute('data-language', 'sql');
    await expect(preview.locator('.hljs-keyword').first()).toBeVisible();
    expect(await preview.locator('.hljs-comment').first().evaluate(element => getComputedStyle(element).color)).toBe('rgb(122, 203, 136)');
    await row('PowerShell script').click(); await expect(meta).toContainText('PowerShell');
    await row('Vanlig anteckning').click(); await expect(meta).toContainText('Text'); await expect(preview).toHaveClass(/preview-text/);
    await row('Okänd kod').click(); await expect(meta).toContainText('Code');
    await row('SQL script').click();
    await page.screenshot({ path: '.impeccable/review/languages-library-' + theme + '.png' });
    await page.getByRole('button', { name: "Quick panel", exact: true }).click();
    const panel = page.locator('.quick-panel');
    const inPanel = (name: string) => panel.getByRole('button', { name: 'Show ' + name, exact: true });
    await expect(inPanel('SQL script')).toHaveClass(/row-code/);
    await expect(inPanel('PowerShell script')).toHaveClass(/row-code/);
    await expect(inPanel('Okänd kod')).toHaveClass(/row-code/);
    await expect(inPanel('Vanlig anteckning')).toHaveClass(/row-text/);
    const dimensions = await page.evaluate(() => ({ height: innerHeight, scrollHeight: document.documentElement.scrollHeight }));
    expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.height + 2);
    await page.screenshot({ path: '.impeccable/review/languages-panel-' + theme + '.png' });
  });
}
