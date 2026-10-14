use crate::library::SourceApp;
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{codecs::png::PngEncoder, ExtendedColorType, ImageEncoder};
use std::{collections::HashMap, hash::{Hash, Hasher}, ptr::null_mut, sync::{Mutex, OnceLock}};
use windows_sys::Win32::{Foundation::CloseHandle, Graphics::Gdi::*, System::{DataExchange::GetClipboardOwner, Threading::*}, UI::{Shell::SHDefExtractIconW, WindowsAndMessaging::*}};

const ICON_SIZE: u32 = 64;
static CACHE: OnceLock<Mutex<HashMap<String, SourceApp>>> = OnceLock::new();

pub fn capture() -> Option<SourceApp> {
    // Snapshot before clipboard reads/retries can change focus.
    unsafe {
        let foreground = GetForegroundWindow();
        source_for_window(foreground).or_else(|| source_for_window(GetClipboardOwner()))
    }
}

pub fn capture_path() -> Option<String> {
    unsafe { path_for_window(GetForegroundWindow()).or_else(||path_for_window(GetClipboardOwner())) }
}
pub fn excluded(programs: &[String]) -> bool {
    unsafe { [path_for_window(GetForegroundWindow()), path_for_window(GetClipboardOwner())].into_iter().flatten().any(|path| crate::library::program_excluded(&path, programs)) }
}
pub fn from_path(path:&str)->Option<SourceApp> { source_for_path(path) }
unsafe fn source_for_window(window: windows_sys::Win32::Foundation::HWND)->Option<SourceApp> {
    source_for_path(&path_for_window(window)?)
}
unsafe fn path_for_window(window: windows_sys::Win32::Foundation::HWND) -> Option<String> {
    if window.is_null() { return None; }
    let mut pid = 0;
    GetWindowThreadProcessId(window, &mut pid);
    if pid == 0 || pid == GetCurrentProcessId() { return None; }
    let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if process.is_null() { return None; }
    let mut buffer = vec![0u16; 32768];
    let mut length = buffer.len() as u32;
    let success = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length);
    CloseHandle(process);
    if success == 0 { return None; }
    let path = String::from_utf16_lossy(&buffer[..length as usize]);
    Some(path)
}

fn source_for_path(path: &str) -> Option<SourceApp> {
    // Read only local program resources; inaccessible apps simply have no icon.
    if path.starts_with("\\\\") { return None; }
    let key = path.to_lowercase();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(source) = cache.lock().ok()?.get(&key).cloned() { return Some(source); }
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    key.hash(&mut hash);
    let name = std::path::Path::new(path).file_stem()?.to_string_lossy().chars().take(120).collect();
    // New IDs keep old low-resolution cache entries from replacing new images.
    let source = SourceApp { id: format!("icon64-{:016x}", hash.finish()), name, icon: extract_png(path).map(|png| format!("data:image/png;base64,{}", STANDARD.encode(png))) };
    let mut entries = cache.lock().ok()?;
    if entries.len() >= 128 { entries.clear(); }
    entries.insert(key, source.clone());
    Some(source)
}

fn extract_png(path: &str) -> Option<Vec<u8>> {
    unsafe {
        let path: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
        let mut icon = null_mut();
        let result = SHDefExtractIconW(path.as_ptr(), 0, 0, &mut icon, null_mut(), ICON_SIZE);
        if result != 0 || icon.is_null() { if !icon.is_null() { DestroyIcon(icon); } return None; }
        let pixels = render_icon(icon);
        DestroyIcon(icon);
        let pixels = pixels?;
        let mut png = Vec::new();
        PngEncoder::new(&mut png).write_image(&pixels, ICON_SIZE, ICON_SIZE, ExtendedColorType::Rgba8).ok()?;
        Some(png)
    }
}

unsafe fn render_icon(icon: HICON) -> Option<Vec<u8>> {
    let dc = CreateCompatibleDC(null_mut());
    if dc.is_null() { return None; }
    let mut info: BITMAPINFO = std::mem::zeroed();
    info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    info.bmiHeader.biWidth = ICON_SIZE as i32;
    info.bmiHeader.biHeight = -(ICON_SIZE as i32);
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB;
    let mut bits = null_mut();
    let bitmap = CreateDIBSection(dc, &info, DIB_RGB_COLORS, &mut bits, null_mut(), 0);
    if bitmap.is_null() || bits.is_null() { if !bitmap.is_null() { DeleteObject(bitmap); } DeleteDC(dc); return None; }
    let previous = SelectObject(dc, bitmap);
    let result = (|| {
        let pixels = std::slice::from_raw_parts_mut(bits as *mut u8, (ICON_SIZE * ICON_SIZE * 4) as usize);
        pixels.fill(0);
        if DrawIconEx(dc, 0, 0, icon, ICON_SIZE as i32, ICON_SIZE as i32, 0, null_mut(), DI_NORMAL) == 0 { return None; }
        GdiFlush();
        let black = pixels.to_vec();
        pixels.fill(255);
        if DrawIconEx(dc, 0, 0, icon, ICON_SIZE as i32, ICON_SIZE as i32, 0, null_mut(), DI_NORMAL) == 0 { return None; }
        GdiFlush();
        Some(straight_rgba(&black, pixels))
    })();
    SelectObject(dc, previous);
    DeleteObject(bitmap);
    DeleteDC(dc);
    result
}

fn straight_rgba(black: &[u8], white: &[u8]) -> Vec<u8> {
    // Two backgrounds preserve both modern alpha and legacy icon masks.
    black.chunks_exact(4).zip(white.chunks_exact(4)).flat_map(|(b,w)| {
        let alpha = 255u16 - u16::from(w[0].saturating_sub(b[0]));
        let channel = |i:usize| if alpha == 0 { 0 } else { ((u16::from(b[i]) * 255 + alpha / 2) / alpha).min(255) as u8 };
        [channel(2), channel(1), channel(0), alpha as u8]
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transparency_and_bgra_are_preserved() {
        assert_eq!(straight_rgba(&[0,0,0,0, 10,20,30,0, 0,0,128,0], &[255,255,255,0, 10,20,30,0, 127,127,255,0]), vec![0,0,0,0, 30,20,10,255, 255,0,0,128]);
    }
    #[test]
    fn windows_resource_is_extracted_at_64_pixels() {
        let executable = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("icons/icon.ico");
        let png = extract_png(executable.to_str().unwrap()).expect("Copyloom ICO is extractable");
        let decoded = image::load_from_memory(&png).unwrap().to_rgba8();
        assert_eq!(decoded.dimensions(), (64,64));
        assert!(decoded.pixels().any(|pixel| pixel.0[3] != 0));
    }
}
