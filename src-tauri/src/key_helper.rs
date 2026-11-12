//! Windows does not call a process's low-level keyboard hooks while that process's own WebView2
//! window has focus (tauri-apps/wry#1761). Win+Shift+S and the keys recorded in the shortcut box
//! are therefore watched by a small helper: this executable started with `--keyboard-helper`,
//! without a WebView. It exits when Copyloom closes its stdin or ends.
use crate::{screenshot_shortcut, shortcut_recorder, RuntimeState};
use std::{
    cell::RefCell,
    io::{BufRead, BufReader, Write},
    os::windows::process::CommandExt,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{atomic::{AtomicBool, AtomicIsize, Ordering}, mpsc, Arc},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use windows_sys::Win32::{
    Foundation::{LPARAM, LRESULT, WPARAM},
    System::{LibraryLoader::GetModuleHandleW, Threading::GetCurrentThreadId},
    UI::WindowsAndMessaging::*,
};

pub const ARG: &str = "--keyboard-helper";
const START_ERROR: &str = "Could not activate Win+Shift+S. Choose another shortcut or restart Copyloom.";
const STOPPED_ERROR: &str = "The screenshot shortcut stopped working. Restart Copyloom.";

// Helper process.

static CAPTURE: AtomicBool = AtomicBool::new(false);
static RECORD_WINDOW: AtomicIsize = AtomicIsize::new(0);

struct HookState { capture: screenshot_shortcut::Keys, record: shortcut_recorder::Keys, out: mpsc::Sender<String> }
thread_local! { static HOOK: RefCell<Option<HookState>> = const { RefCell::new(None) }; }

unsafe extern "system" fn keyboard(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
    if code != HC_ACTION as i32 { return CallNextHookEx(std::ptr::null_mut(), code, message, data); }
    let down = message == WM_KEYDOWN as usize || message == WM_SYSKEYDOWN as usize;
    let up = message == WM_KEYUP as usize || message == WM_SYSKEYUP as usize;
    if !down && !up { return CallNextHookEx(std::ptr::null_mut(), code, message, data); }
    let key = (*(data as *const KBDLLHOOKSTRUCT)).vkCode;
    // Only atomics and a channel send here: Windows drops hooks that answer slowly.
    let consumed = HOOK.with(|cell| {
        let mut slot = cell.borrow_mut();
        let Some(state) = slot.as_mut() else { return false; };
        let window = RECORD_WINDOW.load(Ordering::SeqCst);
        let suspended = window != 0 || !CAPTURE.load(Ordering::SeqCst);
        let mut consumed = match state.capture.event(key, down, suspended) {
            screenshot_shortcut::Action::Pass => false,
            screenshot_shortcut::Action::Consume => true,
            screenshot_shortcut::Action::Capture => { let _ = state.out.send("capture".into()); true }
        };
        let foreground = window != 0 && GetForegroundWindow() as isize == window;
        let (taken, shortcut) = state.record.event(key, down, foreground);
        if let Some(shortcut) = shortcut { let _ = state.out.send(format!("recorded {shortcut}")); }
        consumed |= taken;
        consumed
    });
    if consumed { 1 } else { CallNextHookEx(std::ptr::null_mut(), code, message, data) }
}

pub fn run_helper() -> ! {
    let (out, lines) = mpsc::channel::<String>();
    let writer = std::thread::spawn(move || {
        let mut stdout = std::io::stdout().lock();
        for line in lines { if writeln!(stdout, "{line}").and_then(|_| stdout.flush()).is_err() { break; } }
    });
    let code = unsafe {
        let mut message: MSG = std::mem::zeroed();
        PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_NOREMOVE);
        HOOK.with(|cell| *cell.borrow_mut() = Some(HookState {
            capture: screenshot_shortcut::Keys::snapshot(), record: shortcut_recorder::Keys::snapshot(), out: out.clone(),
        }));
        let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), GetModuleHandleW(std::ptr::null()), 0);
        if hook.is_null() {
            let _ = out.send("error".into());
            1
        } else {
            let thread = GetCurrentThreadId();
            let commands = out.clone();
            std::thread::spawn(move || {
                for line in std::io::stdin().lock().lines() {
                    let Ok(line) = line else { break; };
                    let mut parts = line.split_whitespace();
                    let ok = match (parts.next(), parts.next()) {
                        (Some("capture"), Some(value)) => { CAPTURE.store(value == "1", Ordering::SeqCst); true }
                        (Some("record"), Some(value)) => value.parse().map(|window| RECORD_WINDOW.store(window, Ordering::SeqCst)).is_ok(),
                        _ => false,
                    };
                    let _ = commands.send(if ok { "ok" } else { "error" }.into());
                }
                PostThreadMessageW(thread, WM_QUIT, 0, 0);
            });
            let _ = out.send("ready".into());
            while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 { DispatchMessageW(&message); }
            UnhookWindowsHookEx(hook);
            0
        }
    };
    HOOK.with(|cell| *cell.borrow_mut() = None);
    drop(out);
    let _ = writer.join();
    std::process::exit(code);
}

// Copyloom side.

pub struct Helper {
    child: Child,
    stdin: ChildStdin,
    acks: mpsc::Receiver<bool>,
    closing: Arc<AtomicBool>,
    capture: bool,
    record: isize,
}

impl Helper {
    fn spawn(app: &tauri::AppHandle) -> Result<Self, String> {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let exe = std::env::current_exe().map_err(|_| START_ERROR.to_string())?;
        let mut child = Command::new(exe).arg(ARG)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW).spawn().map_err(|_| START_ERROR.to_string())?;
        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            let _ = child.kill();
            return Err(START_ERROR.into());
        };
        let (ack, acks) = mpsc::channel();
        let (ready, started) = mpsc::sync_channel(1);
        let closing = Arc::new(AtomicBool::new(false));
        let (app, watching) = (app.clone(), closing.clone());
        let reader = std::thread::Builder::new().name("copyloom-keyboard-helper".into()).spawn(move || {
            let mut ready = Some(ready);
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break; };
                match line.as_str() {
                    "ready" => { if let Some(ready) = ready.take() { let _ = ready.send(true); } }
                    "ok" => { let _ = ack.send(true); }
                    "error" => match ready.take() { Some(ready) => { let _ = ready.send(false); } None => { let _ = ack.send(false); } },
                    "capture" => {
                        // The isolated startup probe must never open a screenshot overlay on the desktop.
                        if !app.state::<RuntimeState>().shortcut_recording.load(Ordering::SeqCst) && crate::startup::probe_dir().is_none() { crate::screenshot::start(&app); }
                    }
                    _ => if let Some(shortcut) = line.strip_prefix("recorded ") {
                        if let Err(error) = app.emit_to("main", "shortcut:recorded", shortcut) {
                            let _ = app.emit("runtime:error", format!("Could not record the shortcut. Try again. {error}"));
                        }
                    },
                }
            }
            if !watching.load(Ordering::SeqCst) { let _ = app.emit("runtime:error", STOPPED_ERROR); }
        });
        let helper = Self { child, stdin, acks, closing, capture: false, record: 0 };
        if reader.is_err() || started.recv_timeout(Duration::from_secs(5)) != Ok(true) {
            helper.close();
            return Err(START_ERROR.into());
        }
        Ok(helper)
    }

    fn command(&mut self, line: &str) -> Result<(), String> {
        while self.acks.try_recv().is_ok() {}
        writeln!(self.stdin, "{line}").and_then(|_| self.stdin.flush()).map_err(|_| STOPPED_ERROR.to_string())?;
        match self.acks.recv_timeout(Duration::from_secs(3)) { Ok(true) => Ok(()), _ => Err(STOPPED_ERROR.into()) }
    }

    fn alive(&mut self) -> bool { matches!(self.child.try_wait(), Ok(None)) }

    fn close(mut self) {
        self.closing.store(true, Ordering::SeqCst);
        drop(self.stdin);
        let deadline = Instant::now() + Duration::from_secs(2);
        while matches!(self.child.try_wait(), Ok(None)) {
            if Instant::now() >= deadline { let _ = self.child.kill(); let _ = self.child.wait(); return; }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

fn apply(app: &tauri::AppHandle, capture: Option<bool>, record: Option<isize>) -> Result<(), String> {
    let state = app.state::<RuntimeState>();
    let mut slot = state.key_helper.lock().map_err(|_| crate::lock_error())?;
    if slot.as_mut().is_some_and(|helper| !helper.alive()) { if let Some(helper) = slot.take() { helper.close(); } }
    let (current_capture, current_record) = slot.as_ref().map_or((false, 0), |helper| (helper.capture, helper.record));
    let (capture, record) = (capture.unwrap_or(current_capture), record.unwrap_or(current_record));
    if !capture && record == 0 {
        if let Some(helper) = slot.take() { helper.close(); }
        return Ok(());
    }
    if slot.is_none() { *slot = Some(Helper::spawn(app)?); }
    let helper = slot.as_mut().expect("helper was just started");
    let result = (|| {
        if helper.capture != capture { helper.command(&format!("capture {}", u8::from(capture)))?; helper.capture = capture; }
        if helper.record != record { helper.command(&format!("record {record}"))?; helper.record = record; }
        Ok(())
    })();
    if result.is_err() { if let Some(helper) = slot.take() { helper.close(); } }
    result
}

pub fn set_capture(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> { apply(app, Some(enabled), None) }

pub fn set_recording(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let window = if enabled {
        let window = app.get_webview_window("main").ok_or("The app window is missing.")?;
        window.hwnd().map_err(|error| error.to_string())?.0 as isize
    } else { 0 };
    apply(app, None, Some(window))
}

pub fn capturing(app: &tauri::AppHandle) -> bool {
    match app.state::<RuntimeState>().key_helper.lock() {
        Ok(mut slot) => slot.as_mut().is_some_and(|helper| helper.capture && helper.alive()),
        Err(_) => { let _ = app.emit("runtime:error", crate::lock_error()); false }
    }
}

pub(crate) fn recording(app: &tauri::AppHandle) -> bool {
    app.state::<RuntimeState>().key_helper.lock().is_ok_and(|mut slot| slot.as_mut().is_some_and(|helper| helper.record != 0 && helper.alive()))
}

pub fn shutdown(app: &tauri::AppHandle) {
    if let Ok(mut slot) = app.state::<RuntimeState>().key_helper.lock() { if let Some(helper) = slot.take() { helper.close(); } }
}
