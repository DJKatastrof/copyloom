use crate::library::{Clip, MAX_CONTENT_BYTES, MAX_IMAGE_CONTENT_BYTES, MAX_IMAGE_RGBA_BYTES};
use arboard::{Clipboard, ImageData};
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{codecs::png::PngEncoder, ExtendedColorType, ImageEncoder};
use std::{io::Cursor, thread, time::Duration};

pub fn read_clipboard_filtered(excluded: &[String]) -> Result<Option<Clip>, String> {
    #[cfg(windows)]
    if crate::source_app::excluded(excluded) { return Ok(None); }
    #[cfg(not(windows))]
    let _ = excluded;
    #[cfg(windows)]
    let source = crate::source_app::capture();
    let mut clipboard = Clipboard::new().map_err(|_| "The clipboard is not available.")?;
    for attempt in 0..8 {
        #[cfg(windows)]
        match windows::history_allowed() {
            Ok(false) => return Ok(None),
            Err(()) => {
                thread::sleep(Duration::from_millis(40 * (attempt + 1)));
                continue;
            }
            Ok(true) => {}
        }
        if let Ok(text) = clipboard.get_text() {
            if text.trim().is_empty() {
                return Ok(None);
            }
            if text.len() > MAX_CONTENT_BYTES {
                return Err("The text is larger than 16 MB and was not saved.".into());
            }
            let mut clip = Clip::captured(text);
            #[cfg(windows)] { clip.html = windows::read_html(); }
            #[cfg(not(windows))] { clip.html = clipboard.get().html().ok().filter(|html| !html.is_empty() && html.len() <= MAX_CONTENT_BYTES); }
            #[cfg(windows)] { clip.source_app = source; }
            return Ok(Some(clip));
        }
        // Keep an existing PNG as-is: no decode/re-encode, and our own writes read back byte-identical.
        #[cfg(windows)]
        if let Some(content) = windows::read_png().and_then(|png| png_content(&png).ok()) {
            let mut clip = Clip::captured(content);
            clip.source_app = source;
            return Ok(Some(clip));
        }
        if let Ok(image) = clipboard.get_image() {
            let content = encode_clipboard_image(&image)?;
            let mut clip = Clip::captured(content);
            #[cfg(windows)] { clip.source_app = source; }
            return Ok(Some(clip));
        }
        if attempt < 7 {
            thread::sleep(Duration::from_millis(40 * (attempt + 1)));
        }
    }
    Ok(None)
}

pub fn encode_clipboard_image(data: &ImageData<'_>) -> Result<String,String> { png_content(&encode_png(data)?) }
pub fn encode_png(data: &ImageData<'_>) -> Result<Vec<u8>,String> {
    let bytes=data.width.checked_mul(data.height).and_then(|n|n.checked_mul(4)).ok_or("The image size is invalid.")?;
    if bytes==0 || bytes>MAX_IMAGE_RGBA_BYTES || data.bytes.len()!=bytes || data.width>u32::MAX as usize || data.height>u32::MAX as usize { return Err("The image is too large or has invalid dimensions (64 megapixels at most).".into()); }
    let mut png=Vec::new();
    PngEncoder::new(Cursor::new(&mut png)).write_image(&data.bytes,data.width as u32,data.height as u32,ExtendedColorType::Rgba8).map_err(|_|"Couldn't read the image.")?;
    Ok(png)
}
/// Stored clip content for PNG bytes. Only the header is read; size limits match decoded images.
pub fn png_content(png: &[u8]) -> Result<String,String> {
    let (width,height)=image::ImageReader::with_format(Cursor::new(png),image::ImageFormat::Png).into_dimensions().map_err(|_|"Couldn't read the image.")?;
    if width==0 || height==0 || u64::from(width)*u64::from(height)*4>MAX_IMAGE_RGBA_BYTES as u64 { return Err("The image is too large or has invalid dimensions (64 megapixels at most).".into()); }
    let content=format!("data:image/png;base64,{}",STANDARD.encode(png));
    if content.len()>MAX_IMAGE_CONTENT_BYTES { return Err("The image is too large to save after PNG compression.".into()); }
    Ok(content)
}
pub fn decode_clip_image(bytes:&[u8]) -> Result<image::RgbaImage,String> {
    let mut reader=image::ImageReader::with_format(Cursor::new(bytes),image::ImageFormat::Png);
    let mut limits=image::Limits::default(); limits.max_alloc=Some((MAX_IMAGE_RGBA_BYTES as u64)*2); reader.limits(limits);
    let decoded=reader.decode().map_err(|_|"Couldn't read the image.")?;
    if u64::from(decoded.width())*u64::from(decoded.height())*4>MAX_IMAGE_RGBA_BYTES as u64 { return Err("The image is too large to copy.".into()); }
    Ok(decoded.to_rgba8())
}

pub fn write_clipboard(clip: &Clip) -> Result<(), String> {
    #[cfg(windows)]
    if let Some(html) = &clip.html { return windows::write_html(html, &clip.content); }
    if clip.kind == "image" {
        let data = clip
            .content
            .strip_prefix("data:image/png;base64,")
            .ok_or("Ogiltigt bildformat.")?;
        let bytes = STANDARD
            .decode(data)
            .map_err(|_| "Couldn't read the image.")?;
        return write_png_clipboard(&bytes);
    }
    let mut clipboard = Clipboard::new().map_err(|_| "The clipboard is busy. Try again.")?;
    if let Some(html) = &clip.html {
        clipboard.set_html(html.as_str(), Some(clip.content.as_str()))
            .map_err(|_| "Couldn't copy the text. Try again.".into())
    } else {
        clipboard
            .set_text(&clip.content)
            .map_err(|_| "Couldn't copy the text. Try again.".into())
    }
}

pub fn write_text(text: &str) -> Result<(), String> {
    Clipboard::new().map_err(|_| "The clipboard is busy. Try again.")?
        .set_text(text).map_err(|_| "Couldn't copy the text. Try again.".into())
}

/// Writes stored PNG bytes unchanged; only the bitmap fallback needs decoded pixels.
pub fn write_png_clipboard(png: &[u8]) -> Result<(), String> {
    let image = decode_clip_image(png)?;
    write_image(png, image.width() as usize, image.height() as usize, image.as_raw())
}

/// `rgba` must be the pixels of `png`. Unlike arboard's `set_image`, the PNG is never re-encoded.
pub fn write_image(png: &[u8], width: usize, height: usize, rgba: &[u8]) -> Result<(), String> {
    #[cfg(windows)]
    return windows::write_image(png, width, height, rgba);
    #[cfg(not(windows))]
    {
        let _ = png;
        Clipboard::new().map_err(|_| "The clipboard is busy. Try again.")?
            .set_image(ImageData { width, height, bytes: std::borrow::Cow::Borrowed(rgba) })
            .map_err(|_| "Couldn't copy the image. Try again.".into())
    }
}

#[cfg(windows)]
pub mod windows {
    use std::ptr::null_mut;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HWND},
        System::{
            DataExchange::{
                CloseClipboard, GetClipboardData, GetClipboardOwner, GetClipboardSequenceNumber,
                IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW,
            },
            Memory::{GlobalLock, GlobalSize, GlobalUnlock},
        },
        UI::{
            Input::KeyboardAndMouse::{
                SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_CONTROL,
            },
            WindowsAndMessaging::{
                GetForegroundWindow, GetWindowLongPtrW, GetWindowThreadProcessId,
                SetForegroundWindow, SetWindowLongPtrW, SetWindowPos, GWL_STYLE, HWND_TOPMOST,
                SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, WS_BORDER,
                WS_CAPTION, WS_DLGFRAME, WS_POPUP, WS_THICKFRAME, WS_SYSMENU, WS_MINIMIZEBOX, WS_MAXIMIZEBOX,
            },
        },
    };

    fn format(name: &str) -> u32 {
        let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        unsafe { RegisterClipboardFormatW(name.as_ptr()) }
    }

    pub fn read_html() -> Option<String> {
        let _guard = clipboard_win::Clipboard::new_attempts(2).ok()?;
        unsafe {
            let handle = GetClipboardData(format("HTML Format"));
            if handle.is_null() { return None; }
            let size = GlobalSize(handle);
            if size == 0 || size > crate::library::MAX_CONTENT_BYTES { return None; }
            let ptr = GlobalLock(handle);
            if ptr.is_null() { return None; }
            let result = crate::rich_text::validate_cf_html(std::slice::from_raw_parts(ptr as *const u8, size));
            GlobalUnlock(handle);
            result
        }
    }

    pub fn write_html(html: &str, text: &str) -> Result<(), String> {
        let _guard = clipboard_win::Clipboard::new_attempts(10).map_err(|_| "The clipboard is busy. Try again.")?;
        clipboard_win::raw::set_string(text).map_err(|_| "Couldn't copy the text.")?;
        if !html.starts_with("Version:") {
            return clipboard_win::raw::set_html(format("HTML Format"), html).map_err(|_| "Couldn't copy the formatting.".into());
        }
        clipboard_win::raw::set_without_clear(format("HTML Format"), html.as_bytes()).map_err(|_| "Couldn't copy the formatting.".into())
    }

    /// Raw "PNG" clipboard format, the same one arboard prefers when reading images.
    pub fn read_png() -> Option<Vec<u8>> {
        let _guard = clipboard_win::Clipboard::new_attempts(2).ok()?;
        let png = format("PNG");
        if !clipboard_win::raw::is_format_avail(png) { return None; }
        if clipboard_win::raw::size(png)?.get() > crate::library::MAX_IMAGE_CONTENT_BYTES / 4 * 3 { return None; }
        let mut bytes = Vec::new();
        clipboard_win::raw::get_vec(png, &mut bytes).ok()?;
        Some(bytes)
    }

    /// PNG first (preferred by most apps), then a bottom-up DIBv5 for apps without PNG support.
    pub fn write_image(png: &[u8], width: usize, height: usize, rgba: &[u8]) -> Result<(), String> {
        let dib = dibv5(width, height, rgba)?;
        let _guard = clipboard_win::Clipboard::new_attempts(10).map_err(|_| "The clipboard is busy. Try again.")?;
        clipboard_win::raw::empty().map_err(|_| "Couldn't copy the image. Try again.")?;
        clipboard_win::raw::set_without_clear(format("PNG"), png).map_err(|_| "Couldn't copy the image. Try again.")?;
        clipboard_win::raw::set_without_clear(CF_DIBV5, &dib).map_err(|_| "Couldn't copy the image. Try again.".into())
    }

    const CF_DIBV5: u32 = 17;
    pub(crate) fn dibv5(width: usize, height: usize, rgba: &[u8]) -> Result<Vec<u8>, String> {
        use windows_sys::Win32::Graphics::Gdi::{BITMAPV5HEADER, BI_BITFIELDS};
        if width == 0 || rgba.len() != width * height * 4 || width > i32::MAX as usize || height > i32::MAX as usize { return Err("The image size is invalid.".into()); }
        let mut header: BITMAPV5HEADER = unsafe { std::mem::zeroed() };
        header.bV5Size = std::mem::size_of::<BITMAPV5HEADER>() as u32;
        // Positive height (bottom-up rows): Word and WordPad reject top-down clipboard bitmaps.
        header.bV5Width = width as i32; header.bV5Height = height as i32; header.bV5Planes = 1; header.bV5BitCount = 32;
        header.bV5Compression = BI_BITFIELDS; header.bV5SizeImage = rgba.len() as u32;
        header.bV5RedMask = 0x00ff_0000; header.bV5GreenMask = 0x0000_ff00; header.bV5BlueMask = 0x0000_00ff; header.bV5AlphaMask = 0xff00_0000;
        header.bV5CSType = 0x7352_4742; // LCS_sRGB
        header.bV5Intent = 4; // LCS_GM_IMAGES
        let size = header.bV5Size as usize;
        let mut dib = Vec::with_capacity(size + rgba.len());
        dib.extend_from_slice(unsafe { std::slice::from_raw_parts((&header as *const BITMAPV5HEADER).cast::<u8>(), size) });
        for row in rgba.chunks_exact(width * 4).rev() {
            for pixel in row.chunks_exact(4) { dib.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]); }
        }
        Ok(dib)
    }

    /// Sleeps until a message reaches this thread's queue (the clipboard listener) or `timeout` passes.
    pub fn wait_for_message(timeout: std::time::Duration) {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MsgWaitForMultipleObjects, QS_ALLINPUT};
        unsafe { MsgWaitForMultipleObjects(0, std::ptr::null(), 0, timeout.as_millis().min(u32::MAX as u128) as u32, QS_ALLINPUT); }
    }

    pub fn clipboard_sequence() -> u32 {
        unsafe { GetClipboardSequenceNumber() }
    }

    fn remote_owner() -> bool {
        // Identify the clipboard owner, never the foreground application.
        unsafe {
            let owner = GetClipboardOwner();
            if owner.is_null() {
                return false;
            }
            let mut pid = 0;
            GetWindowThreadProcessId(owner, &mut pid);
            use windows_sys::Win32::System::Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
            };
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return false;
            }
            let mut buffer = vec![0u16; 32768];
            let mut length = buffer.len() as u32;
            let success = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length);
            CloseHandle(process);
            if success == 0 {
                return false;
            }
            let path = String::from_utf16_lossy(&buffer[..length as usize]);
            is_remote_client(&path)
        }
    }

    fn is_remote_client(path: &str) -> bool {
        let name = path.rsplit(['\\', '/']).next().unwrap_or("");
        ["mstsc.exe", "msrdc.exe", "rdpclip.exe"]
            .iter()
            .any(|candidate| name.eq_ignore_ascii_case(candidate))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use windows_sys::Win32::Foundation::RECT;
        #[derive(Default)]
        struct FrameTrace { paints: usize, activation: Vec<isize> }
        unsafe extern "system" fn trace_frame(hwnd: HWND, msg: u32, wp: usize, lp: isize, _: usize, data: usize) -> isize {
            use windows_sys::Win32::UI::WindowsAndMessaging::{WM_NCACTIVATE, WM_NCPAINT};
            let trace = &mut *(data as *mut FrameTrace);
            if msg == WM_NCACTIVATE { trace.activation.push(lp); }
            if msg == WM_NCPAINT { trace.paints += 1; }
            windows_sys::Win32::UI::Shell::DefSubclassProc(hwnd, msg, wp, lp)
        }
        #[test]
        fn panel_stays_borderless_when_window_library_reapplies_styles() {
            use windows_sys::Win32::UI::WindowsAndMessaging::*;
            unsafe {
                let class: Vec<u16> = "STATIC".encode_utf16().chain(Some(0)).collect();
                let hwnd = CreateWindowExW(0, class.as_ptr(), class.as_ptr(), WS_OVERLAPPEDWINDOW, 0, 0, 600, 340, null_mut(), null_mut(), null_mut(), null_mut());
                assert!(!hwnd.is_null());
                let original = GetWindowLongPtrW(hwnd, GWL_STYLE);
                let original_extended = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                let mut saved = None;
                let mut trace = FrameTrace::default();
                assert_ne!(windows_sys::Win32::UI::Shell::SetWindowSubclass(hwnd, Some(trace_frame), 99, (&mut trace as *mut FrameTrace) as usize), 0);
                let result = || {
                    place_panel(hwnd as isize, &mut saved, 0, 0, 600, 340).unwrap();
                    // Tao reconstructs these flags on show/hide and other state changes.
                    SetWindowLongPtrW(hwnd, GWL_STYLE, (WS_CAPTION | WS_SYSMENU | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_CLIPCHILDREN) as isize);
                    let actual = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
                    assert_eq!(actual & (WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX), 0);
                    assert_ne!(actual & WS_CLIPCHILDREN, 0);
                    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, WS_EX_APPWINDOW as isize);
                    let extended = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
                    assert_eq!(extended & WS_EX_APPWINDOW, 0);
                    assert_ne!(extended & WS_EX_TOOLWINDOW, 0);
                    let mut client: RECT = std::mem::zeroed();
                    GetClientRect(hwnd, &mut client);
                    assert_eq!((client.right, client.bottom), (600, 340));
                    trace.activation.clear(); trace.paints = 0;
                    for active in [1, 0, 1, 0] {
                        SendMessageW(hwnd, WM_NCACTIVATE, active, 0);
                        SendMessageW(hwnd, WM_NCPAINT, 1, 0);
                    }
                    assert_eq!(trace.activation, vec![-1; 4]);
                    assert_eq!(trace.paints, 0, "Native captions must not be painted on blur");
                    let active = foreground();
                    set_panel_topmost(hwnd as isize, false).unwrap();
                    assert_eq!(GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOPMOST, 0);
                    assert_eq!(foreground(), active);
                    assert_eq!(IsWindowVisible(hwnd), 0);
                    restore_panel_frame(hwnd as isize, &mut saved).unwrap();
                    assert_eq!(GetWindowLongPtrW(hwnd, GWL_STYLE), original);
                    assert_eq!(GetWindowLongPtrW(hwnd, GWL_EXSTYLE), original_extended);
                };
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(result));
                windows_sys::Win32::UI::Shell::RemoveWindowSubclass(hwnd, Some(trace_frame), 99);
                DestroyWindow(hwnd);
                if let Err(error) = outcome { std::panic::resume_unwind(error); }
            }
        }
        #[test]
        fn desktop_origin_uses_pointer_instead_of_spanning_window_center() {
            use windows_sys::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetDesktopWindow};
            assert!(is_desktop_class("Progman"));
            assert!(is_desktop_class("WorkerW"));
            assert!(!is_desktop_class("Shell_TrayWnd"));
            assert!(!is_desktop_class("Chrome_WidgetWin_1"));
            unsafe {
                let desktop = GetDesktopWindow() as isize;
                assert!(is_desktop_window(desktop));
                assert!(is_focus_target(desktop, 0));
                let mut before: windows_sys::Win32::Foundation::POINT = std::mem::zeroed();
                let mut after = before;
                GetCursorPos(&mut before);
                let point = window_monitor_center(desktop).unwrap();
                GetCursorPos(&mut after);
                // Do not move the user's pointer. Only compare while stationary.
                if before.x == after.x && before.y == after.y {
                    assert_eq!(point, (before.x as f64, before.y as f64));
                }
            }
        }
        #[test]
        fn capture_handoff_only_matches_actual_capture_executables() {
            assert!(is_capture_process("C:/Program Files/Greenshot/Greenshot.exe"));
            assert!(is_capture_process(r"C:\Windows\SystemApps\ScreenClippingHost.exe"));
            assert!(is_capture_process("C:/tools/SNIPPINGTOOL.EXE"));
            assert!(!is_capture_process("C:/tools/greenshot.exe.backup"));
            assert!(!is_capture_process("C:/Windows/explorer.exe"));
            assert!(!is_capture_process(""));
            assert!(!is_focus_target(0, 0));
            assert!(window_monitor_center(0).is_none());
        }
        #[test]
        fn remote_exception_is_scoped_to_clipboard_owner_process() {
            assert!(is_remote_client("C:/Windows/System32/mstsc.exe"));
            assert!(is_remote_client("C:/client/MSRDC.EXE"));
            assert!(!is_remote_client("C:/Windows/notepad.exe"));
            assert!(!is_remote_client("C:/client/mstsc.exe.backup"));
            assert!(!is_remote_client(""));
        }
    }

    pub fn history_allowed() -> Result<bool, ()> {
        // An occupied clipboard is retryable; an explicit privacy flag is not.
        unsafe {
            if OpenClipboard(null_mut()) == 0 {
                return Err(());
            }
            let result = (|| {
                let exclude = format("ExcludeClipboardContentFromMonitorProcessing");
                let history = format("CanIncludeInClipboardHistory");
                if exclude == 0 || history == 0 {
                    return Err(());
                }
                // The user wants redirected RDP clips captured. The bridge's Windows
                // history opt-out must not disable Clip's own history.
                if remote_owner() {
                    return Ok(true);
                }
                if IsClipboardFormatAvailable(exclude) != 0 {
                    return Ok(false);
                }
                if IsClipboardFormatAvailable(history) == 0 {
                    return Ok(true);
                }
                let handle = GetClipboardData(history);
                if handle.is_null() || GlobalSize(handle) < std::mem::size_of::<u32>() {
                    return Err(());
                }
                let pointer = GlobalLock(handle);
                if pointer.is_null() {
                    return Err(());
                }
                let value = std::ptr::read_unaligned(pointer.cast::<u32>());
                GlobalUnlock(handle);
                Ok(value != 0)
            })();
            CloseClipboard();
            result
        }
    }

    pub fn hide_window_border(handle: isize) {
        let color = windows_sys::Win32::Graphics::Dwm::DWMWA_COLOR_NONE;
        unsafe { let _ = windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute(handle as HWND, windows_sys::Win32::Graphics::Dwm::DWMWA_BORDER_COLOR as u32, (&color as *const u32).cast(), std::mem::size_of::<u32>() as u32); }
    }

    /// Unowned app windows without the tool-window flag get their own taskbar button.
    pub fn on_taskbar(handle: isize) -> bool {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindow, GWL_EXSTYLE, GW_OWNER, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW};
        unsafe {
            let style = GetWindowLongPtrW(handle as HWND, GWL_EXSTYLE) as u32;
            style & WS_EX_APPWINDOW != 0 && style & WS_EX_TOOLWINDOW == 0 && GetWindow(handle as HWND, GW_OWNER).is_null()
        }
    }

    const PANEL_SUBCLASS: usize = 0x434c4950;
    fn panel_style(style: u32) -> u32 {
        (style & !(WS_CAPTION | WS_THICKFRAME | WS_BORDER | WS_DLGFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX)) | WS_POPUP
    }

    fn panel_extended_style(style: u32) -> u32 {
        use windows_sys::Win32::UI::WindowsAndMessaging::{WS_EX_APPWINDOW, WS_EX_TOOLWINDOW};
        (style & !WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW
    }

    unsafe extern "system" fn panel_proc(hwnd: HWND, message: u32, wparam: usize, lparam: isize, id: usize, _: usize) -> isize {
        use windows_sys::Win32::UI::{Shell::{DefSubclassProc, RemoveWindowSubclass}, WindowsAndMessaging::{WM_STYLECHANGING, WM_NCCALCSIZE, WM_NCDESTROY, STYLESTRUCT}};
        if message == WM_STYLECHANGING && wparam as i32 == GWL_STYLE && lparam != 0 {
            let change = &mut *(lparam as *mut STYLESTRUCT);
            change.styleNew = panel_style(change.styleNew);
        }
        if message == WM_STYLECHANGING && wparam as i32 == windows_sys::Win32::UI::WindowsAndMessaging::GWL_EXSTYLE && lparam != 0 {
            let change = &mut *(lparam as *mut STYLESTRUCT);
            change.styleNew = panel_extended_style(change.styleNew);
        }
        if message == WM_NCCALCSIZE || message == windows_sys::Win32::UI::WindowsAndMessaging::WM_NCPAINT { return 0; }
        if message == windows_sys::Win32::UI::WindowsAndMessaging::WM_NCACTIVATE {
            // Let Tao update focus and deliver Focused(false), but prevent Windows
            // from painting an inactive caption over the acrylic client area.
            return DefSubclassProc(hwnd, message, wparam, -1);
        }
        if message == WM_NCDESTROY { RemoveWindowSubclass(hwnd, Some(panel_proc), id); }
        DefSubclassProc(hwnd, message, wparam, lparam)
    }

    pub fn place_panel(
        handle: isize,
        original_style: &mut Option<(isize, isize)>,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
    ) -> Result<(), String> {
        unsafe {
            let hwnd = handle as HWND;
            let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
            original_style.get_or_insert((style, GetWindowLongPtrW(hwnd, windows_sys::Win32::UI::WindowsAndMessaging::GWL_EXSTYLE)));
            if windows_sys::Win32::UI::Shell::SetWindowSubclass(hwnd, Some(panel_proc), PANEL_SUBCLASS, 0) == 0 {
                return Err("Couldn't set up the panel's window frame.".into());
            }
            let borderless = panel_style(style as u32) as isize;
            SetWindowLongPtrW(hwnd, GWL_STYLE, borderless);
            let extended = windows_sys::Win32::UI::WindowsAndMessaging::GWL_EXSTYLE;
            SetWindowLongPtrW(hwnd, extended, panel_extended_style(GetWindowLongPtrW(hwnd, extended) as u32) as isize);
            let glass = windows_sys::Win32::UI::Controls::MARGINS {
                cxLeftWidth: -1,
                cxRightWidth: -1,
                cyTopHeight: -1,
                cyBottomHeight: -1,
            };
            let _ = windows_sys::Win32::Graphics::Dwm::DwmExtendFrameIntoClientArea(hwnd, &glass);
            // Windows 11 draws a one-pixel DWM border unless explicitly disabled.
            let border = windows_sys::Win32::Graphics::Dwm::DWMWA_COLOR_NONE;
            let _ = windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute(
                hwnd,
                windows_sys::Win32::Graphics::Dwm::DWMWA_BORDER_COLOR as u32,
                (&border as *const u32).cast(),
                std::mem::size_of::<u32>() as u32,
            );
            // Custom regions disable DWM composition/rounding. Keep the window rectangular
            // and let the compositor clip both the WebView and the glass together.
            windows_sys::Win32::Graphics::Gdi::SetWindowRgn(hwnd, std::ptr::null_mut(), 0);
            let corner: u32 = 2; // DWMWCP_ROUND, including borderless popup windows.
            let _ = windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute(
                hwnd,
                33,
                (&corner as *const u32).cast(),
                4,
            );
            if SetWindowPos(
                hwnd,
                HWND_TOPMOST,
                x,
                y,
                width as i32,
                height as i32,
                SWP_FRAMECHANGED | SWP_NOACTIVATE,
            ) == 0
            {
                return Err("Couldn't update the panel's position.".into());
            }
        }
        Ok(())
    }

    pub fn set_panel_topmost(handle: isize, topmost: bool) -> Result<(), String> {
        // Tao's flag setter also calls ShowWindow(SW_SHOW). On focus loss that
        // can reactivate us over Greenshot, so change only Z order here.
        let insert_after = if topmost { HWND_TOPMOST }
            else { windows_sys::Win32::UI::WindowsAndMessaging::HWND_NOTOPMOST };
        if unsafe { SetWindowPos(handle as HWND, insert_after, 0, 0, 0, 0,
            SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE) } == 0
        { return Err("Couldn't update the panel's window order.".into()); }
        Ok(())
    }

    pub fn apply_panel_acrylic(handle: isize, dark: bool) -> Result<(), String> {
        // The system backdrop ignores custom tint on Windows 11 and paints its
        // own non-client surface. Use the same accent acrylic path as the
        // Windows 10 implementation in window-vibrancy, with explicit opacity.
        #[repr(C)]
        struct Accent { state: u32, flags: u32, color: u32, animation: u32 }
        #[repr(C)]
        struct Composition { attribute: u32, data: *mut std::ffi::c_void, size: usize }
        unsafe {
            use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
            let module_name: Vec<u16> = "user32.dll".encode_utf16().chain(Some(0)).collect();
            let module = GetModuleHandleW(module_name.as_ptr());
            let address = GetProcAddress(module, c"SetWindowCompositionAttribute".as_ptr().cast()).ok_or("Windows doesn't support the panel's blur.")?;
            let apply: unsafe extern "system" fn(HWND, *mut Composition) -> i32 = std::mem::transmute(address);
            let mut accent = Accent { state: 4, flags: 0, color: if dark { 0x38202020 } else { 0x38fafafa }, animation: 0 };
            let mut data = Composition { attribute: 19, data: (&mut accent as *mut Accent).cast(), size: std::mem::size_of::<Accent>() };
            if apply(handle as HWND, &mut data) == 0 { return Err("Windows couldn't turn on the panel's blur.".into()); }
        }
        Ok(())
    }

    pub fn set_glass_theme(handle: isize, dark: bool) {
        let value = u32::from(dark);
        unsafe { let _ = windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute(handle as HWND, windows_sys::Win32::Graphics::Dwm::DWMWA_USE_IMMERSIVE_DARK_MODE as u32, (&value as *const u32).cast(), std::mem::size_of::<u32>() as u32); }
    }

    pub fn restore_panel_frame(
        handle: isize,
        original_style: &mut Option<(isize, isize)>,
    ) -> Result<(), String> {
        if let Some((style, extended_style)) = original_style.take() {
            unsafe {
                let hwnd = handle as HWND;
                windows_sys::Win32::UI::Shell::RemoveWindowSubclass(hwnd, Some(panel_proc), PANEL_SUBCLASS);
                windows_sys::Win32::Graphics::Gdi::SetWindowRgn(hwnd, std::ptr::null_mut(), 1);
                SetWindowLongPtrW(hwnd, GWL_STYLE, style);
                SetWindowLongPtrW(hwnd, windows_sys::Win32::UI::WindowsAndMessaging::GWL_EXSTYLE, extended_style);
                let glass = windows_sys::Win32::UI::Controls::MARGINS {
                    cxLeftWidth: 0,
                    cxRightWidth: 0,
                    cyTopHeight: 0,
                    cyBottomHeight: 0,
                };
                let _ =
                    windows_sys::Win32::Graphics::Dwm::DwmExtendFrameIntoClientArea(hwnd, &glass);
                let border = windows_sys::Win32::Graphics::Dwm::DWMWA_COLOR_NONE;
                let _ = windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute(
                    hwnd,
                    windows_sys::Win32::Graphics::Dwm::DWMWA_BORDER_COLOR as u32,
                    (&border as *const u32).cast(),
                    std::mem::size_of::<u32>() as u32,
                );
                let corner: u32 = 0;
                let _ = windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute(
                    hwnd,
                    33,
                    (&corner as *const u32).cast(),
                    4,
                );
                let z_order = if extended_style as u32 & windows_sys::Win32::UI::WindowsAndMessaging::WS_EX_TOPMOST != 0 {
                    HWND_TOPMOST
                } else { windows_sys::Win32::UI::WindowsAndMessaging::HWND_NOTOPMOST };
                if SetWindowPos(
                    hwnd,
                    z_order,
                    0,
                    0,
                    0,
                    0,
                    SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                ) == 0
                {
                    return Err("Couldn't restore the library's window frame.".into());
                }
            }
        }
        Ok(())
    }

    pub fn foreground() -> isize {
        unsafe { GetForegroundWindow() as isize }
    }

    fn window_class(handle: isize) -> String {
        let mut class = [0u16; 128];
        let length = unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetClassNameW(handle as HWND, class.as_mut_ptr(), class.len() as i32) };
        String::from_utf16_lossy(&class[..length.max(0) as usize])
    }

    fn is_desktop_class(class: &str) -> bool { matches!(class, "Progman" | "WorkerW") }

    fn is_desktop_window(handle: isize) -> bool {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetDesktopWindow, GetShellWindow};
        handle != 0 && (unsafe { handle as HWND == GetDesktopWindow() || handle as HWND == GetShellWindow() }
            || is_desktop_class(&window_class(handle)))
    }

    pub fn is_focus_target(handle: isize, panel: isize) -> bool {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            IsIconic, IsWindow, IsWindowVisible,
        };
        unsafe {
            let hwnd = handle as HWND;
            if handle == 0 || handle == panel || IsWindow(hwnd) == 0
                || IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0
            { return false; }
            // Explorer's desktop is a valid origin too. Skipping it leaves an old
            // application as the target and sends the next toggle to its monitor.
            !matches!(window_class(handle).as_str(), "Shell_TrayWnd" | "Shell_SecondaryTrayWnd")
        }
    }

    fn is_capture_process(path: &str) -> bool {
        let name = path.rsplit(['\\', '/']).next().unwrap_or("");
        ["greenshot.exe", "snippingtool.exe", "screenclippinghost.exe", "snippingtoolhost.exe", "sharex.exe"]
            .iter().any(|candidate| name.eq_ignore_ascii_case(candidate))
    }

    pub fn is_capture_window(handle: isize) -> bool {
        use windows_sys::Win32::System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        if handle == 0 { return false; }
        unsafe {
            let mut pid = 0;
            GetWindowThreadProcessId(handle as HWND, &mut pid);
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() { return false; }
            let mut path = [0u16; 32768];
            let mut length = path.len() as u32;
            let ok = QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut length);
            CloseHandle(process);
            ok != 0 && is_capture_process(&String::from_utf16_lossy(&path[..length as usize]))
        }
    }

    pub fn restore_panel_focus(panel: isize, target: isize) {
        // Restore before hiding: otherwise Windows chooses another window, possibly
        // on a different monitor. Never override an outside click or a capture tool.
        if foreground() == panel && is_focus_target(target, panel) {
            unsafe { SetForegroundWindow(target as HWND); }
        }
    }

    pub fn window_monitor_center(handle: isize) -> Option<(f64, f64)> {
        use windows_sys::Win32::Graphics::Gdi::{
            GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
        };
        if handle == 0 || unsafe { windows_sys::Win32::UI::WindowsAndMessaging::IsWindow(handle as HWND) } == 0 {
            return None;
        }
        if is_desktop_window(handle) {
            // The desktop spans all monitors. Its rectangle has no useful center.
            let mut point: windows_sys::Win32::Foundation::POINT = unsafe { std::mem::zeroed() };
            return (unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut point) } != 0)
                .then_some((point.x as f64, point.y as f64));
        }
        let monitor = unsafe { MonitorFromWindow(handle as HWND, MONITOR_DEFAULTTONEAREST) };
        let mut info: MONITORINFO = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if monitor.is_null() || unsafe { GetMonitorInfoW(monitor, &mut info) } == 0 { return None; }
        // Use Windows' largest-overlap monitor, even for windows spanning displays.
        Some(((info.rcWork.left as f64 + info.rcWork.right as f64) / 2.0,
              (info.rcWork.top as f64 + info.rcWork.bottom as f64) / 2.0))
    }

    pub fn cursor_position() -> Option<(i32, i32)> {
        let mut point: windows_sys::Win32::Foundation::POINT = unsafe { std::mem::zeroed() };
        (unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut point) } != 0).then_some((point.x, point.y))
    }

    /// The text cursor in `target`'s thread as x, y, width, height in screen pixels. Classic Win32
    /// controls report it directly; browsers, Electron apps and Office through accessibility (MSAA).
    /// None when the app shows no caret or does not tell where it is.
    pub fn caret_rect(target: isize) -> Option<(i32, i32, i32, i32)> {
        use windows_sys::Win32::{Foundation::POINT, Graphics::Gdi::ClientToScreen, UI::WindowsAndMessaging::{GetGUIThreadInfo, GUITHREADINFO}};
        if target == 0 { return None; }
        unsafe {
            let thread = GetWindowThreadProcessId(target as HWND, std::ptr::null_mut());
            let mut info: GUITHREADINFO = std::mem::zeroed();
            info.cbSize = std::mem::size_of::<GUITHREADINFO>() as u32;
            if thread == 0 || GetGUIThreadInfo(thread, &mut info) == 0 { return None; }
            let caret = info.rcCaret;
            if !info.hwndCaret.is_null() && caret.bottom > caret.top {
                let mut start = POINT { x: caret.left, y: caret.top };
                let mut end = POINT { x: caret.right, y: caret.bottom };
                if ClientToScreen(info.hwndCaret, &mut start) != 0 && ClientToScreen(info.hwndCaret, &mut end) != 0 {
                    return Some((start.x, start.y, (end.x - start.x).max(1), end.y - start.y));
                }
            }
            accessible_caret(if info.hwndFocus.is_null() { target } else { info.hwndFocus as isize })
        }
    }

    fn accessible_caret(window: isize) -> Option<(i32, i32, i32, i32)> {
        use windows::core::Interface;
        use windows::Win32::{Foundation::HWND as Window, System::Variant::{VARIANT, VT_I4}, UI::Accessibility::{AccessibleObjectFromWindow, IAccessible}};
        const OBJID_CARET: u32 = 0xFFFF_FFF8;
        unsafe {
            let mut raw = std::ptr::null_mut();
            AccessibleObjectFromWindow(Window(window as _), OBJID_CARET, &IAccessible::IID, &mut raw).ok()?;
            if raw.is_null() { return None; }
            let caret = IAccessible::from_raw(raw);
            // CHILDID_SELF: the caret object itself.
            let mut child = VARIANT::default();
            (*child.Anonymous.Anonymous).vt = VT_I4;
            let (mut x, mut y, mut width, mut height) = (0, 0, 0, 0);
            caret.accLocation(&mut x, &mut y, &mut width, &mut height, &child).ok()?;
            (height > 0 && (x != 0 || y != 0)).then_some((x, y, width.max(1), height))
        }
    }

    pub fn paste_into(handle: isize) -> bool {
        if handle == 0 {
            return false;
        }
        unsafe {
            if SetForegroundWindow(handle as HWND) == 0 {
                return false;
            }
            std::thread::sleep(std::time::Duration::from_millis(60));
            if GetForegroundWindow() != handle as HWND {
                return false;
            }
            let key = |code, flags| INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: code,
                        wScan: 0,
                        dwFlags: flags,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            };
            let inputs = [
                key(VK_CONTROL, 0),
                key(0x56, 0),
                key(0x56, KEYEVENTF_KEYUP),
                key(VK_CONTROL, KEYEVENTF_KEYUP),
            ];
            SendInput(
                inputs.len() as u32,
                inputs.as_ptr(),
                std::mem::size_of::<INPUT>() as i32,
            ) == inputs.len() as u32
        }
    }
}

#[cfg(test)] mod image_limit_tests {
    use super::*;
    use std::borrow::Cow;
    #[test] fn full_4k_image_roundtrips_without_the_text_limit() {
        let pixels=vec![127;3840*2160*4]; assert!(pixels.len()>MAX_CONTENT_BYTES);
        let content=encode_clipboard_image(&ImageData {width:3840,height:2160,bytes:Cow::Borrowed(&pixels)}).unwrap();
        let mut library=crate::library::Library::default(); library.apply(crate::library::Action::AddClip {clip:Clip::captured(content.clone())}).unwrap();
        let encoded=content.strip_prefix("data:image/png;base64,").unwrap();
        let png=STANDARD.decode(encoded).unwrap();
        let dir=std::env::temp_dir().join(format!("copyloom-4k-{}",uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap(); let path=dir.join("4k.db");
        let mut storage=crate::storage::Storage::open(&path,&[42;32]).unwrap();
        storage.save_changes(&crate::library::Library::default(),&library).unwrap();
        drop(storage); let storage=crate::storage::Storage::open(&path,&[42;32]).unwrap();
        assert_eq!(storage.read_media(&library.clips[0].id,false).unwrap(),png);
        let decoded=decode_clip_image(&png).unwrap();
        assert_eq!(decoded.dimensions(),(3840,2160)); assert_eq!(decoded.into_raw(),pixels);
        drop(storage);
        for name in ["4k.db","4k.db-wal","4k.db-shm"] { let _=std::fs::remove_file(dir.join(name)); }
        std::fs::remove_dir(&dir).unwrap();
    }
    #[test] fn invalid_and_oversized_image_dimensions_are_rejected_before_encoding() {
        for (width,height) in [(usize::MAX,2),(16384,16384),(2,2),(0,1)] {
            assert!(encode_clipboard_image(&ImageData {width,height,bytes:Cow::Borrowed(&[])}).is_err());
        }
    }
    #[test] fn clipboard_png_is_stored_byte_identical_and_validated_from_its_header() {
        let pixels:Vec<u8>=(0..3*2*4).map(|n|n as u8).collect();
        let png=encode_png(&ImageData {width:3,height:2,bytes:Cow::Borrowed(&pixels)}).unwrap();
        let content=png_content(&png).unwrap();
        // Reading back our own write must equal the stored clip so the monitor deduplicates it.
        assert_eq!(content,encode_clipboard_image(&ImageData {width:3,height:2,bytes:Cow::Borrowed(&pixels)}).unwrap());
        assert_eq!(STANDARD.decode(content.strip_prefix("data:image/png;base64,").unwrap()).unwrap(),png);
        assert!(png_content(b"not a png").is_err());
        // A tiny file declaring 16384 x 16384 pixels is rejected without decoding it.
        let mut huge=png.clone(); huge[16..24].copy_from_slice(&[0,0,0x40,0,0,0,0x40,0]);
        let crc=|data:&[u8]|{ let mut c=!0u32; for b in data { c^=*b as u32; for _ in 0..8 { c=if c&1!=0 { 0xEDB8_8320^(c>>1) } else { c>>1 }; } } !c };
        let ihdr_crc=crc(&huge[12..29]); huge[29..33].copy_from_slice(&ihdr_crc.to_be_bytes());
        assert_eq!(image::ImageReader::with_format(Cursor::new(&huge),image::ImageFormat::Png).into_dimensions().unwrap(),(16384,16384));
        assert!(png_content(&huge).is_err());
    }
    #[cfg(windows)] #[test] fn clipboard_bitmap_is_bottom_up_bgra_with_alpha() {
        let rgba=[1,2,3,4, 5,6,7,8, 9,10,11,12, 13,14,15,16]; // 2 x 2, top row first
        let dib=windows::dibv5(2,2,&rgba).unwrap();
        let header=std::mem::size_of::<windows_sys::Win32::Graphics::Gdi::BITMAPV5HEADER>();
        assert_eq!(dib.len(),header+16);
        assert_eq!(i32::from_le_bytes(dib[8..12].try_into().unwrap()),2); // positive height: bottom-up
        assert_eq!(&dib[header..],&[11,10,9,12, 15,14,13,16, 3,2,1,4, 7,6,5,8]);
        assert!(windows::dibv5(2,2,&rgba[..12]).is_err());
    }
}
