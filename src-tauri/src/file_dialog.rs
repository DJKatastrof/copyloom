//! Native choices run on their own STA thread. Only the main settings window calls these.
use std::path::PathBuf;

#[cfg(windows)]
pub fn file(owner: isize, name: &str, extension: &str, open: bool) -> Result<Option<PathBuf>, String> {
    let name = name.to_owned(); let extension = extension.to_owned();
    std::thread::spawn(move || unsafe {
        use std::os::windows::ffi::OsStringExt;
        use windows_sys::Win32::{System::Com::*, UI::Controls::Dialogs::*};
        let initialized = CoInitializeEx(std::ptr::null(), (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32) >= 0;
        let mut buffer = vec![0u16; 32768];
        for (slot, unit) in buffer.iter_mut().zip(name.encode_utf16().take(32000)) { *slot = unit; }
        let filter: Vec<u16> = format!("Copyloom (*.{extension})\0*.{extension}\0\0").encode_utf16().collect();
        let ext: Vec<u16> = extension.encode_utf16().chain(Some(0)).collect();
        let mut dialog: OPENFILENAMEW = std::mem::zeroed();
        dialog.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32; dialog.hwndOwner = owner as _;
        dialog.lpstrFilter = filter.as_ptr(); dialog.lpstrDefExt = ext.as_ptr(); dialog.nFilterIndex = 1;
        dialog.lpstrFile = buffer.as_mut_ptr(); dialog.nMaxFile = buffer.len() as u32;
        dialog.Flags = OFN_EXPLORER | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR | OFN_HIDEREADONLY | if open { OFN_FILEMUSTEXIST } else { OFN_OVERWRITEPROMPT };
        let chosen = if open { GetOpenFileNameW(&mut dialog) } else { GetSaveFileNameW(&mut dialog) } != 0;
        let error = if chosen { 0 } else { CommDlgExtendedError() };
        if initialized { CoUninitialize(); }
        if !chosen { return if error == 0 { Ok(None) } else { Err("Could not open the file dialog. Try again.".into()) }; }
        let len = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
        Ok(Some(PathBuf::from(std::ffi::OsString::from_wide(&buffer[..len]))))
    }).join().map_err(|_| "The file dialog closed unexpectedly.".to_string())?
}

#[cfg(windows)]
pub fn folder(owner: isize) -> Result<Option<PathBuf>, String> {
    std::thread::spawn(move || unsafe {
        use std::os::windows::ffi::OsStringExt;
        use windows_sys::Win32::{System::Com::*, UI::Shell::*};
        if CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32) < 0 { return Err("Could not open the folder dialog.".into()); }
        let mut display = vec![0u16; 32768];
        let mut info: BROWSEINFOW = std::mem::zeroed(); info.hwndOwner = owner as _;
        info.pszDisplayName = display.as_mut_ptr(); info.ulFlags = BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE | BIF_EDITBOX;
        let item = SHBrowseForFolderW(&info);
        if item.is_null() { CoUninitialize(); return Ok(None); }
        let mut buffer = vec![0u16; 32768]; let ok = SHGetPathFromIDListEx(item, buffer.as_mut_ptr(), buffer.len() as u32, 0) != 0;
        CoTaskMemFree(item as _); CoUninitialize();
        if !ok { return Err("Choose a local folder for history.".into()); }
        let len = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
        Ok(Some(PathBuf::from(std::ffi::OsString::from_wide(&buffer[..len]))))
    }).join().map_err(|_| "The folder dialog closed unexpectedly.".to_string())?
}

#[cfg(not(windows))]
pub fn file(_: isize, _: &str, _: &str, _: bool) -> Result<Option<PathBuf>, String> { Err("The file dialog is available in the Windows app.".into()) }
#[cfg(not(windows))]
pub fn folder(_: isize) -> Result<Option<PathBuf>, String> { Err("The folder dialog is available in the Windows app.".into()) }
