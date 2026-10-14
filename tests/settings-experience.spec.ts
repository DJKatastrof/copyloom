import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;

async function host(page: Page, saved: string | null = null, enabled: boolean | null = true) {
  await page.addInitScript(({ saved, enabled }) => {
    const root = window as any; let callback=0;
    const settings={ shortcut:'Ctrl+Shift+V',captureShortcut:saved,retentionDays:30,theme:'light',language:'en',editAfterCapture:false,pasteDirectly:true,startMinimized:false };
    const library={ revision:1,clips:[],categories:[],paused:false,settings,storage:'encrypted' };
    const state=root.settingsHost={enabled,registered:false,opened:0,writes:[] as any[],autostart:false,autostartWrites:0};
    root.isTauri=true;
    root.__TAURI_INTERNALS__={transformCallback:()=>++callback,invoke:async(command:string,args:any)=>{
      if(command.startsWith('plugin:event|'))return ++callback;
      if(command==='frontend_ready')return;
      if(command==='load_library')return library;
      if(command==='get_autostart')return {enabled:state.autostart,currentExecutable:state.autostart};
      if(command==='set_autostart'){state.autostartWrites++;state.autostart=args.enabled;return {enabled:state.autostart,currentExecutable:state.autostart};}
      if(command==='get_capture_environment')return {printScreenEnabled:state.enabled,registered:state.registered};
      if(command==='retry_capture_shortcut'){if(state.enabled)throw 'Windows is using Print Screen';state.registered=true;return {printScreenEnabled:state.enabled,registered:true};}
      if(command==='open_keyboard_settings'){state.opened++;return;}
      if(command==='set_capture_recording')return;
      if(command==='apply_action'){if(args.action.type==='setSettings'){library.settings=args.action.settings;state.writes.push(args.action.settings);state.registered=!!library.settings.captureShortcut;}library.revision++;return {...library};}
      throw Error(command);
    }};root.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
  },{saved,enabled});
  await page.goto('/');await page.getByRole('button',{name:'Settings',exact:true}).click();
}
const capture = (page: Page) => page.getByRole('navigation',{name:'Settings sections'}).getByRole('button',{name:'Screenshot',exact:true});

test('Print Screen conflict is actionable and rechecked after returning from Windows',async({page})=>{
  await host(page);await capture(page).click();
  await page.getByRole('button',{name:'Print Screen',exact:true}).click();
  await expect(page.getByRole('alert')).toHaveText('Windows is using Print Screen');
  // Print Screen waits until Windows lets go of it; nothing is saved meanwhile.
  expect(await page.evaluate(()=>(window as any).settingsHost.writes.length)).toBe(0);
  await page.screenshot({path:'.impeccable/review/settings-capture-en.png'});
  await page.getByRole('button',{name:'Open Windows settings'}).click();
  expect(await page.evaluate(()=>(window as any).settingsHost.opened)).toBe(1);
  await page.evaluate(()=>{(window as any).settingsHost.enabled=false;window.dispatchEvent(new Event('focus'));});
  await expect.poll(()=>page.evaluate(()=>(window as any).settingsHost.writes.at(-1)?.captureShortcut)).toBe('PrintScreen');
});

test('a blocked saved shortcut can be activated again without changing settings',async({page})=>{
  await host(page,'PrintScreen');await capture(page).click();
  await page.evaluate(()=>{(window as any).settingsHost.enabled=false;window.dispatchEvent(new Event('focus'));});
  await expect(page.getByText('Windows’ Print Screen shortcut is off')).toBeVisible();
  await page.getByRole('button',{name:'Check again'}).click();
  await expect(page.getByText('Copyloom uses Print Screen.')).toBeVisible();
  expect(await page.evaluate(()=>(window as any).settingsHost.writes.length)).toBe(0);
});

test('unknown Windows state stays uncertain; another key remains usable',async({page})=>{
  await host(page,null,null);await capture(page).click();
  await page.getByRole('button',{name:'Print Screen',exact:true}).click();
  await expect(page.getByText('Check Print Screen in Windows')).toBeVisible();
  expect(await page.evaluate(()=>(window as any).settingsHost.writes.at(-1).captureShortcut)).toBe('PrintScreen');
  const recorder=page.locator('.settings-section').getByRole('button',{name:'Keyboard shortcut',exact:true});
  await recorder.click();await page.keyboard.press('F8');
  await expect.poll(()=>page.evaluate(()=>(window as any).settingsHost.writes.at(-1).captureShortcut)).toBe('F8');
});

test('English default, saved Swedish language, capture menu and staged startup stay consistent',async({page})=>{
  await host(page,null,false);
  await expect(page.locator('.settings-version')).toHaveText('Copyloom ' + version);
  await page.screenshot({path:'.impeccable/review/settings-general-en.png'});
  const startup=page.getByRole('combobox',{name:'Start with Windows'});await startup.click();await page.getByRole('option',{name:'Open the library',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).settingsHost.autostartWrites)).toBe(1);
  await page.getByRole('combobox',{name:'Language',exact:true}).click();await page.getByRole('option',{name:'Svenska',exact:true}).click();
  await expect(page.getByRole('button',{name:'Inställningar',exact:true})).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang','sv');
  await expect(page.getByRole('combobox',{name:'Starta med Windows'})).toHaveText('Öppna biblioteket');
  await page.getByRole('navigation',{name:'Inställningsområden'}).getByRole('button',{name:'Skärmbild',exact:true}).click();
  await page.getByRole('combobox',{name:'Efter skärmbild'}).click();await page.getByRole('option',{name:'Visa Kopiera / Redigera'}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).settingsHost.writes.at(-1).captureBehavior)).toBe('choose');
  await page.setViewportSize({width:740,height:840});await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});
  await page.screenshot({path:'.impeccable/review/settings-capture-sv-dark.png'});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole('navigation',{name:'Bibliotek',exact:true}).getByRole('button',{name:/Alla clips/}).click();
  await page.getByRole('button',{name:'Inställningar',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'Språk',exact:true})).toHaveText('Svenska');
});

test('changing language leaves copied content untouched',async({page})=>{
  await page.goto('/');await page.getByRole('button',{name:'Add text',exact:true}).first().click();
  await page.getByRole('textbox',{name:'Add a clip'}).fill('Inställningar – mina egna ord');
  await page.getByRole('button',{name:'Add clip',exact:true}).click();
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('combobox',{name:'Language',exact:true}).click();await page.getByRole('option',{name:'Svenska',exact:true}).click();
  await page.getByRole('navigation',{name:'Bibliotek',exact:true}).getByRole('button',{name:/Alla clips/}).click();
  await expect(page.getByRole('button',{name:'Visa Inställningar – mina egna ord',exact:true})).toContainText('Inställningar – mina egna ord');
});

test('Win+V replaces the panel\'s shortcut and another shortcut gives it back', async ({ page }) => {
  await page.addInitScript(() => {
    const root = window as any; let id = 0; const callbacks = new Map<number, (event: unknown) => void>(), listeners = new Map<string, number>();
    const library = { revision: 1, clips: [], categories: [], paused: false, settings: { shortcut: 'Ctrl+Alt+Super+V', retentionDays: 30, theme: 'light', language: 'en', winV: false } as any, storage: 'encrypted' };
    const host = root.winVHost = { released: false, registered: false, restarts: 0, sets: [] as boolean[] };
    // Like the app: every settings change reaches the window as library:changed.
    const changed = () => { library.revision++; callbacks.get(listeners.get('library:changed')!)?.({ event: 'library:changed', id: 1, payload: { ...library } }); return { ...library }; };
    root.isTauri = true;
    root.__TAURI_INTERNALS__ = { transformCallback: (callback: (event: unknown) => void) => { callbacks.set(++id, callback); return id; }, invoke: async (command: string, args: any) => {
      if (command === 'plugin:event|listen') { listeners.set(args.event, args.handler); return ++id; }
      if (command.startsWith('plugin:event|')) return ++id;
      if (command === 'load_library') return library;
      if (command === 'get_autostart') return { enabled: false, currentExecutable: false };
      if (command === 'set_capture_recording' || command === 'frontend_ready') return;
      if (command === 'get_win_v') return { released: host.released, registered: host.registered };
      if (command === 'set_win_v') { host.sets.push(args.enabled); host.released = args.enabled; if (!args.enabled) host.registered = false; library.settings = { ...library.settings, winV: args.enabled }; changed(); return { released: host.released, registered: host.registered }; }
      if (command === 'restart_explorer') { host.restarts++; host.registered = library.settings.winV; return { released: host.released, registered: host.registered }; }
      if (command === 'apply_action' && args.action.type === 'setSettings') { library.settings = args.action.settings; return changed(); }
      throw Error(command);
    } };
    root.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  });
  await page.goto('/'); await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const recorder = page.getByRole('button', { name: 'Keyboard shortcut', exact: true });
  await expect(recorder).toHaveText('Ctrl+Alt+Win+V');
  await page.getByRole('button', { name: 'Win+V', exact: true }).click();
  const restart = page.getByRole('dialog', { name: 'Restart File Explorer now?' });
  // Later: until Windows lets go, the own shortcut keeps working.
  await restart.getByRole('button', { name: 'Cancel' }).click();
  await expect(recorder).toHaveText('Win+V');
  await expect(page.getByText('Windows still holds Win+V; until then Ctrl+Alt+Win+V works. Restart File Explorer, or sign out and in.')).toBeVisible();
  await page.getByRole('button', { name: 'Restart File Explorer', exact: true }).click();
  await restart.getByRole('button', { name: 'Restart', exact: true }).click();
  await expect(page.getByText('Win+V replaces Windows clipboard history. Choose another shortcut to give Win+V back to Windows.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Win+V', exact: true })).toHaveCount(0);
  await page.screenshot({ path: '.impeccable/review/win-v-on.png' });
  // A newly recorded shortcut gives Win+V back to Windows.
  await recorder.click(); await page.keyboard.press('Control+Shift+X');
  await restart.getByRole('button', { name: 'Restart', exact: true }).click();
  await expect(recorder).toHaveText('Ctrl+Shift+X');
  await expect(page.getByRole('button', { name: 'Win+V', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).winVHost)).toMatchObject({ sets: [true, false], restarts: 2, released: false });
});
