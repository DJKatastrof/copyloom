//! Library placement is independent of the quick panel's temporary geometry.
use serde::{Deserialize, Serialize};
use tauri::Manager;
use windows_sys::Win32::{Foundation::RECT, UI::WindowsAndMessaging::*};
#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct Placement { left:i32, top:i32, right:i32, bottom:i32, maximized:bool }
impl Placement {
    fn valid(&self)->bool { let w=self.right as i64-self.left as i64; let h=self.bottom as i64-self.top as i64; (200..=32768).contains(&w) && (150..=32768).contains(&h) }
}
fn should_remember(loaded:bool,view:&str)->bool { loaded && view=="main" }
pub fn save(app:&tauri::AppHandle)->Result<(),String> {
    let state=app.state::<crate::RuntimeState>();
    let loaded=state.library_placement_loaded.load(std::sync::atomic::Ordering::SeqCst);
    if !should_remember(loaded,"main") { return Ok(()); }
    let Some(window)=app.get_webview_window("main") else { return Ok(()); };
    save_window(&window, "window-state.json")
}
pub fn save_editor(window:&tauri::WebviewWindow)->Result<(),String> {
    if !crate::editor::initialized(window.app_handle(), window.label()) { return Ok(()); }
    save_window(window, "editor-window-state.json")
}
fn placement(window:&tauri::WebviewWindow)->Result<Placement,String> {
    let mut native:WINDOWPLACEMENT=unsafe { std::mem::zeroed() }; native.length=std::mem::size_of::<WINDOWPLACEMENT>() as u32;
    if unsafe { GetWindowPlacement(window.hwnd().map_err(|e|e.to_string())?.0,&mut native) }==0 { return Err("Couldn't read the window size.".into()); }
    let r=native.rcNormalPosition;
    Ok(Placement{left:r.left,top:r.top,right:r.right,bottom:r.bottom,maximized:native.showCmd==SW_SHOWMAXIMIZED as u32 || native.flags & WPF_RESTORETOMAXIMIZED!=0})
}
fn save_window(window:&tauri::WebviewWindow,file:&str)->Result<(),String> {
    let value=placement(window)?;
    if !value.valid() { return Ok(()); }
    let path=crate::startup::config_dir(window.app_handle())?.join(file);
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e|e.to_string())?;
    let temporary=path.with_extension("tmp");
    std::fs::write(&temporary,serde_json::to_vec(&value).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    use std::os::windows::ffi::OsStrExt;
    let source:Vec<u16>=temporary.as_os_str().encode_wide().chain(Some(0)).collect();
    let target:Vec<u16>=path.as_os_str().encode_wide().chain(Some(0)).collect();
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW,MOVEFILE_REPLACE_EXISTING};
    if unsafe { MoveFileExW(source.as_ptr(),target.as_ptr(),MOVEFILE_REPLACE_EXISTING) }==0 { return Err("Couldn't save the window size.".into()); }
    Ok(())
}
fn read(app:&tauri::AppHandle,file:&str)->Result<Option<Placement>,String> {
    let path=crate::startup::config_dir(app)?.join(file);
    if !path.exists() { return Ok(None); }
    let bytes=std::fs::read(path).map_err(|e|e.to_string())?;
    Ok(serde_json::from_slice::<Placement>(&bytes).ok().filter(Placement::valid))
}
fn apply(window:&tauri::WebviewWindow,value:&Placement,hidden:bool)->Result<(),String> {
    let mut native:WINDOWPLACEMENT=unsafe { std::mem::zeroed() }; native.length=std::mem::size_of::<WINDOWPLACEMENT>() as u32;
    native.showCmd=if hidden { SW_HIDE } else if value.maximized { SW_SHOWMAXIMIZED } else { SW_SHOWNORMAL } as u32;
    native.rcNormalPosition=RECT{left:value.left,top:value.top,right:value.right,bottom:value.bottom};
    if unsafe { SetWindowPlacement(window.hwnd().map_err(|e|e.to_string())?.0,&native) }==0 { return Err("Couldn't restore the window size.".into()); }
    Ok(())
}
pub fn restore(app:&tauri::AppHandle)->Result<bool,String> {
    let Some(value)=read(app,"window-state.json")? else { return Ok(false); };
    apply(&app.get_webview_window("main").ok_or("The app window is missing.")?,&value,false)?;
    Ok(true)
}
// With another editor open, the new window copies it with an offset; otherwise the last closed editor is used.
pub fn restore_editor(window:&tauri::WebviewWindow,template:Option<&tauri::WebviewWindow>)->Result<bool,String> {
    let value=match template {
        Some(other)=>Some(cascade(placement(other)?,(32.0*other.scale_factor().map_err(|e|e.to_string())?).round() as i32)),
        None=>read(window.app_handle(),"editor-window-state.json")?,
    };
    let Some(value)=value else { return Ok(false); };
    // WINDOWPLACEMENT uses workspace coordinates. Windows restores/relocates it first;
    // only then do we inspect the actual window in screen coordinates.
    apply(window,&value,true)?;
    if let Some(monitor)=window.current_monitor().map_err(|e|e.to_string())? {
        let outer=window.outer_size().map_err(|e|e.to_string())?;
        let inner=window.inner_size().map_err(|e|e.to_string())?;
        let position=window.outer_position().map_err(|e|e.to_string())?;
        let frame=(outer.width.saturating_sub(inner.width),outer.height.saturating_sub(inner.height));
        let (position,size,minimum)=editor_bounds(position,outer,frame,monitor.work_area(),monitor.scale_factor());
        window.set_min_size(Some(minimum)).map_err(|e|e.to_string())?;
        window.set_size(size).map_err(|e|e.to_string())?;
        window.set_position(position).map_err(|e|e.to_string())?;
    }
    if value.maximized && crate::startup::probe_dir().is_none() { window.maximize().map_err(|e|e.to_string())?; }
    Ok(true)
}
fn cascade(value:Placement,offset:i32)->Placement {
    Placement{left:value.left.saturating_add(offset),top:value.top.saturating_add(offset),right:value.right.saturating_add(offset),bottom:value.bottom.saturating_add(offset),..value}
}
fn editor_bounds(position:tauri::PhysicalPosition<i32>,outer:tauri::PhysicalSize<u32>,frame:(u32,u32),area:&tauri::PhysicalRect<i32,u32>,scale:f64)->(tauri::PhysicalPosition<i32>,tauri::PhysicalSize<u32>,tauri::LogicalSize<f64>) {
    let available=(area.size.width.saturating_sub(frame.0).max(1),area.size.height.saturating_sub(frame.1).max(1));
    let minimum=tauri::LogicalSize::new(640.0_f64.min(available.0 as f64/scale),400.0_f64.min(available.1 as f64/scale));
    let width=outer.width.max((minimum.width*scale).round() as u32+frame.0).min(area.size.width);
    let height=outer.height.max((minimum.height*scale).round() as u32+frame.1).min(area.size.height);
    let x=position.x.clamp(area.position.x,area.position.x+(area.size.width-width) as i32);
    let y=position.y.clamp(area.position.y,area.position.y+(area.size.height-height) as i32);
    (tauri::PhysicalPosition::new(x,y),tauri::PhysicalSize::new(width.saturating_sub(frame.0).max(1),height.saturating_sub(frame.1).max(1)),minimum)
}
pub fn probe_editor(first:&tauri::WebviewWindow,second:&tauri::WebviewWindow)->Result<(),String> {
    first.set_size(tauri::LogicalSize::new(720.0,500.0)).map_err(|e|e.to_string())?;
    save_editor(first)?;
    let expected=first.inner_size().map_err(|e|e.to_string())?;
    first.set_size(tauri::LogicalSize::new(640.0,400.0)).map_err(|e|e.to_string())?;
    if !restore_editor(first,None)? || first.inner_size().map_err(|e|e.to_string())?!=expected || first.is_visible().unwrap_or(true) { return Err("Editor window size did not restore while hidden".into()); }
    if !restore_editor(second,Some(first))? || second.inner_size().map_err(|e|e.to_string())?!=expected || second.outer_position().ok()==first.outer_position().ok() || second.is_visible().unwrap_or(true) { return Err("Second editor window did not cascade from the first".into()); }
    Ok(())
}
#[cfg(test)] mod tests { use super::*;
    #[test] fn editor_bounds_use_actual_screen_coordinates_with_top_and_left_taskbars() {
        let area=tauri::PhysicalRect { position:tauri::PhysicalPosition::new(80,60),size:tauri::PhysicalSize::new(1440,900) };
        let (position,size,minimum)=editor_bounds(tauri::PhysicalPosition::new(10,10),tauri::PhysicalSize::new(816,638),(16,38),&area,1.0);
        assert_eq!(position,tauri::PhysicalPosition::new(80,60));
        assert_eq!(size,tauri::PhysicalSize::new(800,600));
        assert_eq!(minimum,tauri::LogicalSize::new(640.0,400.0));
    }
    #[test] fn editor_bounds_handle_negative_monitors_and_smaller_high_dpi_work_areas() {
        let area=tauri::PhysicalRect { position:tauri::PhysicalPosition::new(-1200,40),size:tauri::PhysicalSize::new(1000,700) };
        let (position,size,minimum)=editor_bounds(tauri::PhysicalPosition::new(-1800,-50),tauri::PhysicalSize::new(1800,1200),(32,76),&area,2.0);
        assert_eq!(position,area.position); assert_eq!(size,tauri::PhysicalSize::new(968,624));
        assert_eq!(minimum,tauri::LogicalSize::new(484.0,312.0));
    }
    #[test] fn cascaded_editor_keeps_size_and_maximized_state() {
        let value=cascade(Placement{left:-1600,top:40,right:-800,bottom:640,maximized:true},48);
        assert_eq!(value,Placement{left:-1552,top:88,right:-752,bottom:688,maximized:true});
        assert!(cascade(Placement{left:0,top:0,right:800,bottom:600,maximized:false},i32::MAX).right==i32::MAX);
    }
    #[test] fn first_library_open_is_remembered_but_panel_and_background_start_are_not() {
        assert!(should_remember(true,"main"));
        assert!(!should_remember(true,"panel"));
        assert!(!should_remember(false,""));
    }
    #[test] fn placement_round_trip_preserves_negative_monitor_and_maximized() {
        let value=Placement{left:-1600,top:40,right:-400,bottom:840,maximized:true}; assert!(value.valid());
        let bytes=serde_json::to_vec(&value).unwrap(); assert_eq!(serde_json::from_slice::<Placement>(&bytes).unwrap(),value);
    }
    #[test] fn invalid_or_minimized_rectangles_are_rejected() {
        assert!(!Placement{left:0,top:0,right:0,bottom:0,maximized:false}.valid());
        assert!(!Placement{left:i32::MIN,top:0,right:i32::MAX,bottom:800,maximized:false}.valid());
    }
}
