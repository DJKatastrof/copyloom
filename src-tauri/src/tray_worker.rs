//! Windows Shell_NotifyIcon can wait seconds for Explorer. Keep that work and
//! the native menu message loop off the WebView/UI thread.
use std::sync::{atomic::{AtomicBool, AtomicU32, Ordering}, Mutex};
use tauri::{Emitter, Manager};
use windows_sys::Win32::{System::Threading::GetCurrentThreadId, UI::WindowsAndMessaging::*};
static PROBE_DOUBLE_CLICK: AtomicBool = AtomicBool::new(false);
static PROBE_PAUSE_COMMAND: AtomicU32 = AtomicU32::new(0);
static READY: AtomicBool = AtomicBool::new(false);
static FAILED: AtomicBool = AtomicBool::new(false);
static STOP: AtomicBool = AtomicBool::new(false);
static THREAD: AtomicU32 = AtomicU32::new(0);
static WORKER: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);
const LANGUAGE_CHANGED: u32 = WM_APP + 71;
fn labels(swedish: bool) -> [&'static str; 4] {
    if swedish { ["Öppna bibliotek", "Öppna snabbpanel", "Pausa / återuppta insamling", "Avsluta Copyloom"] }
    else { ["Open library", "Open quick panel", "Pause / resume collection", "Quit Copyloom"] }
}
fn swedish(app: &tauri::AppHandle) -> bool { app.state::<crate::RuntimeState>().library.lock().map(|library| library.settings.language == "sv").unwrap_or(false) }
pub fn refresh_language() { let id = THREAD.load(Ordering::SeqCst); if id != 0 { unsafe { PostThreadMessageW(id, LANGUAGE_CHANGED, 0, 0); } } }

pub fn start(app: tauri::AppHandle) -> Result<(), String> {
    let worker = std::thread::Builder::new().name("copyloom-tray".into()).spawn(move || {
        unsafe {
            let mut message: MSG = std::mem::zeroed();
            PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_NOREMOVE);
            THREAD.store(GetCurrentThreadId(), Ordering::SeqCst);
            crate::startup::mark("tray_begin");
            if crate::startup::probe_dir().is_some() {
                if let Ok(delay) = std::env::var("COPYLOOM_TEST_TRAY_DELAY_MS") {
                    if let Ok(ms) = delay.parse::<u64>() { std::thread::sleep(std::time::Duration::from_millis(ms.min(10_000))); }
                }
            }
            let (icon, items) = match create_tray(swedish(&app)) {
                Ok(icon) => icon,
                Err(error) => {
                    FAILED.store(true, Ordering::SeqCst);
                    let message = format!("Couldn't create the system tray icon: {error}");
                    if let Ok(mut pending) = app.state::<crate::RuntimeState>().startup_error.lock() { *pending = Some(message.clone()); }
                    let _ = app.emit("runtime:error", message);
                    if crate::startup::probe_dir().is_none() { let _ = crate::set_view(&app, "library"); }
                    THREAD.store(0, Ordering::SeqCst);
                    return;
                }
            };
            // Subclass receives both posted and sent Shell_NotifyIcon callbacks.
            let hwnd = find_tray_window();
            if hwnd != 0 { windows_sys::Win32::UI::Shell::SetWindowSubclass(hwnd as _, Some(tray_procedure), 0x434c, (&app as *const tauri::AppHandle) as usize); }
            crate::startup::mark("tray_created");
            READY.store(true, Ordering::SeqCst);
            while !STOP.load(Ordering::SeqCst) && GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
                if message.message == LANGUAGE_CHANGED {
                    for (item, label) in items.iter().zip(labels(swedish(&app))) { item.set_text(label); }
                    continue;
                }
                TranslateMessage(&message); DispatchMessageW(&message);
            }
            drop(icon); // Remove the icon on its owning thread.
            THREAD.store(0, Ordering::SeqCst);
        }
    }).map_err(|error| error.to_string())?;
    *WORKER.lock().map_err(|_| "Couldn't keep the system tray thread.")? = Some(worker);
    Ok(())
}
fn create_tray(swedish: bool) -> Result<(tray_icon::TrayIcon, [tray_icon::menu::MenuItem; 4]), String> {
    use tray_icon::{menu::{ContextMenu, Menu, MenuItem}, Icon, TrayIconBuilder};
    let menu = Menu::new();
    let text = labels(swedish);
    let items = [
        MenuItem::with_id("library", text[0], true, None),
        MenuItem::with_id("panel", text[1], true, None),
        MenuItem::with_id("pause", text[2], true, None),
        MenuItem::with_id("quit", text[3], true, None),
    ];
    for item in &items { menu.append(item).map_err(|error| error.to_string())?; }
    if crate::startup::probe_dir().is_some() {
        PROBE_PAUSE_COMMAND.store(unsafe { GetMenuItemID(menu.hpopupmenu() as _, 2) }, Ordering::SeqCst);
    }
    let image = image::load_from_memory(include_bytes!("../icons/icon.png")).map_err(|error| error.to_string())?.into_rgba8();
    let (width, height) = image.dimensions();
    let icon = Icon::from_rgba(image.into_raw(), width, height).map_err(|error| error.to_string())?;
    let tray = TrayIconBuilder::new().with_icon(icon).with_tooltip("Copyloom")
        .with_menu_on_left_click(false).with_menu(Box::new(menu)).build().map_err(|error| error.to_string())?;
    Ok((tray, items))
}
pub fn shutdown() {
    STOP.store(true, Ordering::SeqCst);
    let id = THREAD.load(Ordering::SeqCst);
    if id != 0 { unsafe { PostThreadMessageW(id, WM_QUIT, 0, 0); } }
    if let Ok(mut worker) = WORKER.lock() {
        if let Some(handle) = worker.take() {
            // Explorer may also stall icon deletion. Do not stall application exit.
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(200);
            while !handle.is_finished() && std::time::Instant::now() < deadline { std::thread::sleep(std::time::Duration::from_millis(5)); }
            if handle.is_finished() { let _ = handle.join(); }
        }
    }
}

pub fn ready() -> bool { READY.load(Ordering::SeqCst) }
pub fn failed() -> bool { FAILED.load(Ordering::SeqCst) }

/// Exercise the real native menu -> Tauri event -> action path, only in isolation.
pub fn probe_menu(app: &tauri::AppHandle) -> bool {
    if crate::startup::probe_dir().is_none() { return false; }
    let hwnd = find_tray_window();
    if hwnd == 0 { return false; }
    let paused = || app.state::<crate::RuntimeState>().library.lock().map(|library| library.paused).ok();
    let Some(before) = paused() else { return false; };
    for expected in [!before, before] {
        if unsafe { PostMessageW(hwnd as _, WM_COMMAND, PROBE_PAUSE_COMMAND.load(Ordering::SeqCst) as usize, 0) } == 0 { return false; }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while paused() != Some(expected) && std::time::Instant::now() < deadline { std::thread::sleep(std::time::Duration::from_millis(10)); }
        if paused() != Some(expected) { return false; }
    }
    unsafe { PostMessageW(hwnd as _, 6002, 0, WM_LBUTTONDBLCLK as isize); }
    let deadline=std::time::Instant::now()+std::time::Duration::from_secs(3);
    while !PROBE_DOUBLE_CLICK.load(Ordering::SeqCst) && std::time::Instant::now()<deadline { std::thread::sleep(std::time::Duration::from_millis(10)); }
    PROBE_DOUBLE_CLICK.load(Ordering::SeqCst)
}

fn find_tray_window() -> isize {
    unsafe extern "system" fn find(hwnd: windows_sys::Win32::Foundation::HWND, data: isize) -> i32 {
        let mut class = [0u16; 64];
        let len = GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32);
        if String::from_utf16_lossy(&class[..len.max(0) as usize]) == "tray_icon_app" {
            *(data as *mut isize) = hwnd as isize; return 0;
        }
        1
    }
    let mut hwnd = 0isize;
    unsafe { EnumThreadWindows(THREAD.load(Ordering::SeqCst), Some(find), (&mut hwnd as *mut isize) as isize); }
    hwnd
}

unsafe extern "system" fn tray_procedure(hwnd:windows_sys::Win32::Foundation::HWND, message:u32, wp:usize, lp:isize, id:usize, data:usize)->isize {
    use windows_sys::Win32::UI::Shell::{DefSubclassProc,RemoveWindowSubclass};
    // Callback number from the pinned tray-icon 0.25.1 Windows implementation.
    if message==6002 && (lp as u32 & 0xffff)==WM_LBUTTONDBLCLK {
        let app=&*(data as *const tauri::AppHandle);
        if crate::startup::probe_dir().is_some() { PROBE_DOUBLE_CLICK.store(true,Ordering::SeqCst); }
        else if let Err(error)=crate::set_view(app,"library") { let _=app.emit("runtime:error",error); }
    }
    if message==WM_NCDESTROY { RemoveWindowSubclass(hwnd,Some(tray_procedure),id); }
    DefSubclassProc(hwnd,message,wp,lp)
}
