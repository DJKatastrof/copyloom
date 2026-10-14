// Test harness data; the shipped app has no example-loading action.
export async function loadSamples(page) {
  await page.locator('.loading-state').waitFor({ state: 'hidden' });
  await page.evaluate(async () => {
    const runtimePath = performance.getEntriesByType('resource').map(entry => entry.name).find(name => name.includes('/src/services/runtime.ts')) ?? '/src/services/runtime.ts', domainPath = '/src/domain/library.ts';
    const runtime = await import(runtimePath), domain = await import(domainPath);
    const samples = [
      ['Projektanteckningar', 'En plats för det du vill hitta igen.\n\nSamla idéer, bra formuleringar och små detaljer som gör nästa steg enklare.'],
      ['En liten kodsnutt', 'const greeting = (name: string) => {\n  return ' + String.fromCharCode(96) + 'Hej '+ '$' + '{name}!' + String.fromCharCode(96) + ';\n};\n\nexport default greeting;'],
      ['Project wiki', 'https://example.com/wiki/handover'], ['Violett', '#6C4DDE'],
      ['Ett återanvändbart svar', 'Hej! Tack för ditt meddelande. Jag tittar på det och återkommer så snart jag kan.'], ['Grönt', '#33836A'],
    ];
    for (let index = 0; index < samples.length; index++) {
      const [title, content] = samples[index];
      await runtime.dispatch({ type: 'addClip', clip: { ...domain.makeClip(content, Date.now() - index * 13 * 60000), title, favorite: index === 1 } });
    }
  });
}
