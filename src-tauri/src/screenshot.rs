//! Frozen, physical-pixel desktop selection. Allocates only while capturing.
use std::{ptr::null_mut, sync::atomic::{AtomicBool, AtomicU32, Ordering}};
use windows_sys::Win32::{Foundation::*, Graphics::Gdi::*, System::LibraryLoader::GetModuleHandleW, UI::{WindowsAndMessaging::*, Input::KeyboardAndMouse::{SetCapture, ReleaseCapture, SetFocus}, HiDpi::*}};
use tauri::{Emitter, Manager};
use windows_sys::Win32::UI::Controls::{MEASUREITEMSTRUCT, DRAWITEMSTRUCT, ODT_MENU, ODS_SELECTED};
const CANCEL_CAPTURE:u32=WM_APP+44;
static CANCEL:AtomicBool=AtomicBool::new(false);
static THREAD:AtomicU32=AtomicU32::new(0);
static ACTIVE: AtomicBool = AtomicBool::new(false);
pub fn active() -> bool { ACTIVE.load(Ordering::SeqCst) }
pub fn start(app: &tauri::AppHandle) {
    if ACTIVE.swap(true, Ordering::SeqCst) {
        CANCEL.store(true,Ordering::SeqCst);
        let id=THREAD.load(Ordering::SeqCst);
        if id!=0 { unsafe { PostThreadMessageW(id,CANCEL_CAPTURE,0,0); } }
        return;
    }
    CANCEL.store(false,Ordering::SeqCst);
    let app = app.clone();
    let failed = app.clone();
    if let Err(error) = std::thread::Builder::new().name("copyloom-capture".into()).spawn(move || {
        let result = unsafe { capture(&app) };
        ACTIVE.store(false, Ordering::SeqCst);
        if let Err(error) = result { let _ = app.emit("runtime:error", error); }
    }) { ACTIVE.store(false, Ordering::SeqCst); let _ = failed.emit("runtime:error", error.to_string()); }
}
fn selection(a: (i32,i32), b: (i32,i32), w: i32, h: i32) -> Option<RECT> {
    let rect = RECT { left: a.0.min(b.0).clamp(0,w), top: a.1.min(b.1).clamp(0,h), right: a.0.max(b.0).clamp(0,w), bottom: a.1.max(b.1).clamp(0,h) };
    (rect.right > rect.left && rect.bottom > rect.top).then_some(rect)
}
/// Full-desktop top-down 32-bit DIB selected into its own memory DC.
struct Surface { dc: HDC, bitmap: HBITMAP, old: HGDIOBJ, bits: *mut u8, len: usize }
impl Surface {
    unsafe fn new(screen:HDC,info:&BITMAPINFO)->Option<Surface> {
        let dc=CreateCompatibleDC(screen); let mut bits=null_mut(); let bitmap=CreateDIBSection(screen,info,DIB_RGB_COLORS,&mut bits,null_mut(),0);
        if dc.is_null() || bitmap.is_null() { if !dc.is_null(){DeleteDC(dc);} if !bitmap.is_null(){DeleteObject(bitmap);} return None; }
        let len=info.bmiHeader.biWidth as usize*info.bmiHeader.biHeight.unsigned_abs() as usize*4;
        Some(Surface { old:SelectObject(dc,bitmap),dc,bitmap,bits:bits.cast(),len })
    }
    unsafe fn pixels(&self)->&[u8] { std::slice::from_raw_parts(self.bits,self.len) }
}
impl Drop for Surface { fn drop(&mut self) { unsafe { SelectObject(self.dc,self.old); DeleteObject(self.bitmap); DeleteDC(self.dc); } } }
/// `desktop` is the frozen snapshot and is never drawn on; `back` is the paint buffer.
struct Overlay {
    w: i32, h: i32, desktop: Surface, back: Surface,
    closing: bool, restore_focus: bool, cursor: (i32,i32), anchor: Option<(i32,i32)>, result: Option<RECT>,
    choose: bool, choosing: bool, swedish: bool, dark: bool, menu_scale: f64, action: Option<bool>,
}
/// Selection tint in place: 12 % accent over the original BGRA pixels.
fn tint(pixels:&mut [u8]) {
    for pixel in pixels.chunks_exact_mut(4) { pixel[0]=((pixel[0] as u16*88+230*12)/100) as u8; pixel[1]=((pixel[1] as u16*88+169*12)/100) as u8; pixel[2]=(pixel[2] as u16*88/100) as u8; pixel[3]=255; }
}
const MAGNIFIER:i32=240;
fn intersect(a:RECT,b:RECT)->Option<RECT> {
    let rect=RECT { left:a.left.max(b.left),top:a.top.max(b.top),right:a.right.min(b.right),bottom:a.bottom.min(b.bottom) };
    (rect.right>rect.left && rect.bottom>rect.top).then_some(rect)
}
/// `a` minus `b` as at most four rectangles.
fn subtract(a:RECT,b:RECT)->Vec<RECT> {
    let Some(i)=intersect(a,b) else { return vec![a]; };
    [RECT { left:a.left,top:a.top,right:a.right,bottom:i.top }, RECT { left:a.left,top:i.bottom,right:a.right,bottom:a.bottom },
     RECT { left:a.left,top:i.top,right:i.left,bottom:i.bottom }, RECT { left:i.right,top:i.top,right:a.right,bottom:i.bottom }]
        .into_iter().filter(|r|r.right>r.left && r.bottom>r.top).collect()
}
type Pointer=((i32,i32),Option<(i32,i32)>);
/// What `render` draws over the (tinted) desktop for one pointer state: magnifier, selection border and labels.
fn decorations(w:i32,h:i32,(cursor,anchor):Pointer)->Vec<RECT> {
    let (x,y)=(cursor.0.clamp(0,w-1),cursor.1.clamp(0,h-1));
    let (left,top)=magnifier_position((x,y),w,h);
    let mut parts=vec![RECT { left:left-4,top:top-4,right:left+MAGNIFIER+4,bottom:top+MAGNIFIER+4 }];
    if let Some(s)=anchor.and_then(|a|selection(a,cursor,w,h)) {
        parts.extend([RECT { left:s.left-3,top:s.top-3,right:s.right+3,bottom:s.top+3 }, RECT { left:s.left-3,top:s.bottom-3,right:s.right+3,bottom:s.bottom+3 },
            RECT { left:s.left-3,top:s.top-3,right:s.left+3,bottom:s.bottom+3 }, RECT { left:s.right-3,top:s.top-3,right:s.right+3,bottom:s.bottom+3 }]);
        parts.extend(label_boxes(s));
    }
    parts
}
/// 2 px selection border centered on the edges.
fn border(s:RECT)->[RECT;4] {
    [RECT { left:s.left-1,top:s.top-1,right:s.right+1,bottom:s.top+1 }, RECT { left:s.left-1,top:s.bottom-1,right:s.right+1,bottom:s.bottom+1 },
     RECT { left:s.left-1,top:s.top-1,right:s.left+1,bottom:s.bottom+1 }, RECT { left:s.right-1,top:s.top-1,right:s.right+1,bottom:s.bottom+1 }]
}
/// Merges rectangles whose bounding box adds little area, so overlapping magnifier bands paint once.
fn coalesce(mut rects:Vec<RECT>)->Vec<RECT> {
    let area=|r:&RECT|(r.right-r.left) as i64*(r.bottom-r.top) as i64;
    'merge: loop {
        for i in 0..rects.len() { for j in i+1..rects.len() {
            let (a,b)=(rects[i],rects[j]);
            let union=RECT { left:a.left.min(b.left),top:a.top.min(b.top),right:a.right.max(b.right),bottom:a.bottom.max(b.bottom) };
            if area(&union)<=(area(&a)+area(&b))*5/4+1024 { rects[i]=union; rects.swap_remove(j); continue 'merge; }
        } }
        return rects;
    }
}
/// Generous bounds of the width label (above/inside the top edge) and height label (beside the left edge).
fn label_boxes(s:RECT)->[RECT;2] {
    let (cx,cy)=((s.left+s.right)/2,(s.top+s.bottom)/2);
    [RECT { left:cx-64,top:s.top-32,right:cx+64,bottom:s.top+32 }, RECT { left:s.left-96,top:cy-24,right:s.left+96,bottom:cy+24 }]
}
/// Areas whose pixels can differ between two pointer states. A drag repaints edges, not the whole selection.
fn damage(w:i32,h:i32,before:Pointer,after:Pointer)->Vec<RECT> {
    let mut rects=decorations(w,h,before); rects.extend(decorations(w,h,after));
    let selected=|(cursor,anchor):Pointer|anchor.and_then(|a|selection(a,cursor,w,h));
    match (selected(before),selected(after)) {
        (Some(a),Some(b)) => { rects.extend(subtract(a,b)); rects.extend(subtract(b,a)); }
        (Some(s),None)|(None,Some(s)) => rects.push(s),
        (None,None) => {}
    }
    let screen=RECT { left:0,top:0,right:w,bottom:h };
    rects.into_iter().filter_map(|rect|intersect(rect,screen)).collect()
}
fn magnifier_position((x,y):(i32,i32),w:i32,h:i32)->(i32,i32) {
    let z=MAGNIFIER;
    let left=if x+z-18<w { x-26 } else { x-z+26 };
    let top=if y+z-18<h { y-26 } else { y-z+26 };
    (left.clamp(0,(w-z).max(0)),top.clamp(0,(h-z).max(0)))
}
unsafe fn draw_measurements(dc:HDC,rect:RECT,w:i32,h:i32) {
    let saved=SaveDC(dc);
    let name:Vec<u16>="Segoe UI\0".encode_utf16().collect();
    let font=CreateFontW(-14,0,0,0,600,0,0,0,DEFAULT_CHARSET as u32,0,0,ANTIALIASED_QUALITY as u32,0,name.as_ptr());
    SelectObject(dc,font); SetBkColor(dc,0x00ffffff); SetTextColor(dc,0x00807900);
    let width:Vec<u16>=(rect.right-rect.left).to_string().encode_utf16().collect();
    let height:Vec<u16>=(rect.bottom-rect.top).to_string().encode_utf16().collect();
    let mut size:SIZE=std::mem::zeroed();
    GetTextExtentPoint32W(dc,width.as_ptr(),width.len() as i32,&mut size);
    let tx=((rect.left+rect.right-size.cx)/2).clamp(0,(w-size.cx).max(0));
    let ty=if rect.top>=size.cy+5 { rect.top-size.cy-5 } else { rect.top+5 };
    TextOutW(dc,tx,ty,width.as_ptr(),width.len() as i32);
    GetTextExtentPoint32W(dc,height.as_ptr(),height.len() as i32,&mut size);
    let tx=if rect.left>=size.cx+5 { rect.left-size.cx-5 } else { rect.left+5 };
    let ty=((rect.top+rect.bottom-size.cy)/2).clamp(0,(h-size.cy).max(0));
    TextOutW(dc,tx,ty,height.as_ptr(),height.len() as i32);
    RestoreDC(dc,saved); DeleteObject(font);
}
/// Repaints only `clip`; every pixel outside it is left untouched in both the back buffer and `dc`.
unsafe fn render(state: &Overlay, dc: HDC, clip: RECT) {
    let back=state.back.dc; let (cw,ch)=(clip.right-clip.left,clip.bottom-clip.top);
    if cw<=0 || ch<=0 { return; }
    let outer=SaveDC(back); IntersectClipRect(back,clip.left,clip.top,clip.right,clip.bottom);
    BitBlt(back,clip.left,clip.top,cw,ch,state.desktop.dc,clip.left,clip.top,SRCCOPY);
    if let Some(rect) = state.anchor.and_then(|a| selection(a,state.cursor,state.w,state.h)) {
        if let Some(area)=intersect(rect,clip) {
            GdiFlush(); // The blit must land before the tint edits DIB memory directly.
            let stride=state.w as usize*4; let pixels=std::slice::from_raw_parts_mut(state.back.bits,state.back.len);
            for row in area.top as usize..area.bottom as usize { tint(&mut pixels[row*stride+area.left as usize*4..row*stride+area.right as usize*4]); }
        }
        // Filled edges instead of a wide pen: GDI widens a pen outline for the whole rectangle before clipping.
        let brush=CreateSolidBrush(0x00e6a900);
        for edge in border(rect) { FillRect(back,&edge,brush); }
        DeleteObject(brush);
    }
    if state.choosing {
        BitBlt(dc,clip.left,clip.top,cw,ch,back,clip.left,clip.top,SRCCOPY);
        RestoreDC(back,outer); return;
    }
    let (x,y)=(state.cursor.0.clamp(0,state.w-1),state.cursor.1.clamp(0,state.h-1));
    let z=MAGNIFIER; let source=40; let zoom=6;
    let (left,top)=magnifier_position((x,y),state.w,state.h);
    let sx=(x-source/2).clamp(0,(state.w-source).max(0)); let sy=(y-source/2).clamp(0,(state.h-source).max(0));
    if intersect(clip,RECT { left:left-4,top:top-4,right:left+z+4,bottom:top+z+4 }).is_some() {
        let saved=SaveDC(back);
        let circle=CreateEllipticRgn(left,top,left+z,top+z); ExtSelectClipRgn(back,circle,RGN_AND); DeleteObject(circle);
        SetStretchBltMode(back,COLORONCOLOR);
        StretchBlt(back,left,top,z,z,state.desktop.dc,sx,sy,source,source,SRCCOPY);
        let cx=left+(x-sx)*zoom+zoom/2; let cy=top+(y-sy)*zoom+zoom/2;
        // White outline and black center remain visible over every desktop color.
        for (width,color) in [(9,0x00ffffff),(5,0x00000000)] {
            let pen=CreatePen(PS_SOLID,width,color); let previous=SelectObject(back,pen);
            MoveToEx(back,left,cy,null_mut()); LineTo(back,cx-12,cy);
            MoveToEx(back,cx+12,cy,null_mut()); LineTo(back,left+z,cy);
            MoveToEx(back,cx,top,null_mut()); LineTo(back,cx,cy-12);
            MoveToEx(back,cx,cy+12,null_mut()); LineTo(back,cx,top+z);
            SelectObject(back,previous); DeleteObject(pen);
        }
        RestoreDC(back,saved);
        let pen=CreatePen(PS_SOLID,2,0x00ffffff); let previous=SelectObject(back,pen);
        let brush=SelectObject(back,GetStockObject(NULL_BRUSH)); Ellipse(back,left,top,left+z,top+z);
        SelectObject(back,brush); SelectObject(back,previous); DeleteObject(pen);
    }
    if let Some(rect)=state.anchor.and_then(|a|selection(a,state.cursor,state.w,state.h)) {
        if label_boxes(rect).into_iter().any(|label|intersect(label,clip).is_some()) { draw_measurements(back,rect,state.w,state.h); }
    }
    RestoreDC(back,outer);
    if dc!=back { BitBlt(dc,clip.left,clip.top,cw,ch,back,clip.left,clip.top,SRCCOPY); }
}
/// Moves the pointer state and invalidates only the pixels that change.
unsafe fn update(hwnd:HWND,state:&mut Overlay,cursor:(i32,i32),anchor:Option<(i32,i32)>) {
    let before=(state.cursor,state.anchor); state.cursor=cursor; state.anchor=anchor;
    for rect in damage(state.w,state.h,before,(cursor,anchor)) { InvalidateRect(hwnd,&rect,0); }
}
/// The pending update region as separate rectangles; its bounding box would span both sides of a drag.
unsafe fn update_rects(hwnd:HWND)->Vec<RECT> {
    let region=CreateRectRgn(0,0,0,0); let mut rects=Vec::new();
    if GetUpdateRgn(hwnd,region,0)>NULLREGION {
        let size=GetRegionData(region,0,null_mut()); let header=std::mem::size_of::<RGNDATAHEADER>()/std::mem::size_of::<RECT>();
        let mut buffer=vec![RECT { left:0,top:0,right:0,bottom:0 };(size as usize).div_ceil(std::mem::size_of::<RECT>())];
        if size>0 && GetRegionData(region,size,buffer.as_mut_ptr().cast())==size {
            let count=(*buffer.as_ptr().cast::<RGNDATAHEADER>()).nCount as usize;
            rects.extend_from_slice(&buffer[header..(header+count).min(buffer.len())]);
        }
    }
    DeleteObject(region); rects
}
unsafe extern "system" fn procedure(hwnd: HWND, message:u32, wp:usize, lp:isize)->isize {
    if message==WM_NCCREATE {
        let create=&*(lp as *const CREATESTRUCTW); SetWindowLongPtrW(hwnd,GWLP_USERDATA,create.lpCreateParams as isize);
    }
    let ptr=GetWindowLongPtrW(hwnd,GWLP_USERDATA) as *mut Overlay;
    if ptr.is_null() { return DefWindowProcW(hwnd,message,wp,lp); }
    let point=|| ((lp as i16) as i32,((lp>>16) as i16) as i32);
    match message {
        WM_MEASUREITEM => {
            let item=&mut *(lp as *mut MEASUREITEMSTRUCT);
            if item.CtlType!=ODT_MENU { return DefWindowProcW(hwnd,message,wp,lp); }
            item.itemWidth=(164.0*(*ptr).menu_scale).round() as u32;
            item.itemHeight=(40.0*(*ptr).menu_scale).round() as u32; 1
        },
        WM_DRAWITEM => {
            let item=&*(lp as *const DRAWITEMSTRUCT);
            if item.CtlType!=ODT_MENU { return DefWindowProcW(hwnd,message,wp,lp); }
            draw_action(item.hDC,item.rcItem,item.itemID,item.itemState & ODS_SELECTED!=0,(*ptr).swedish,(*ptr).dark,(*ptr).menu_scale); 1
        },
        WM_MENUCHAR => {
            let key=char::from_u32((wp & 0xffff) as u32).unwrap_or(' ').to_ascii_lowercase();
            let keys=if (*ptr).swedish { ['k','r'] } else { ['c','e'] };
            keys.iter().position(|candidate| *candidate==key).map(|index| ((MNC_EXECUTE as isize)<<16) | index as isize).unwrap_or(0)
        },
        WM_ERASEBKGND => 1,
        WM_PAINT => {
            let rects=update_rects(hwnd); let mut paint: PAINTSTRUCT=std::mem::zeroed(); let dc=BeginPaint(hwnd,&mut paint);
            if rects.is_empty() { render(&*ptr,dc,paint.rcPaint); } else { for rect in coalesce(rects) { render(&*ptr,dc,rect); } }
            EndPaint(hwnd,&paint); 0
        },
        WM_MOUSEMOVE => { if !(*ptr).choosing && (*ptr).cursor!=point() { update(hwnd,&mut *ptr,point(),(*ptr).anchor); } 0 },
        WM_LBUTTONDOWN => { if !(*ptr).choosing { let p=point(); update(hwnd,&mut *ptr,p,Some(p)); SetCapture(hwnd); } 0 },
        WM_LBUTTONUP => {
            if (*ptr).choosing { return 0; }
            (*ptr).cursor=point(); (*ptr).result=(*ptr).anchor.and_then(|a|selection(a,(*ptr).cursor,(*ptr).w,(*ptr).h));
            let selected=(*ptr).result.is_some(); ReleaseCapture();
            if selected {
                if (*ptr).choose {
                    (*ptr).choosing=true;
                    InvalidateRect(hwnd,std::ptr::null(),0); UpdateWindow(hwnd);
                    (*ptr).action=choose_action(hwnd,(*ptr).cursor,&mut *ptr);
                    if CANCEL.load(Ordering::SeqCst) { (*ptr).result=None; }
                }
                (*ptr).closing=true; DestroyWindow(hwnd);
            } else { (*ptr).anchor=None; }
            0
        },
        WM_TIMER if (*ptr).choosing && CANCEL.load(Ordering::SeqCst) => { EndMenu(); 0 },
        WM_KEYDOWN if wp==27 => { (*ptr).closing=true; DestroyWindow(hwnd); 0 },
        WM_RBUTTONDOWN|WM_CLOSE => { (*ptr).closing=true; DestroyWindow(hwnd); 0 },
        WM_ACTIVATE if wp & 0xffff == WA_INACTIVE as usize && !(*ptr).closing => { (*ptr).closing=true; (*ptr).restore_focus=false; DestroyWindow(hwnd); 0 },
        WM_DESTROY => { PostQuitMessage(0); 0 },
        _ => DefWindowProcW(hwnd,message,wp,lp),
    }
}
fn menu_action(command: i32) -> Option<bool> { match command { 1 => Some(false), 2 => Some(true), _ => None } }
unsafe fn action_menu(swedish: bool) -> HMENU {
    let menu=CreatePopupMenu(); if menu.is_null() { return menu; }
    for (id,label) in [(1,if swedish { "&Kopiera" } else { "&Copy" }), (2,if swedish { "&Redigera" } else { "&Edit" })] {
        let text:Vec<u16>=label.encode_utf16().chain(Some(0)).collect(); AppendMenuW(menu,MF_STRING,id,text.as_ptr());
        // Keep the native string for accessibility while drawing the icon and label ourselves.
        let info=MENUITEMINFOW { cbSize:std::mem::size_of::<MENUITEMINFOW>() as u32,fMask:MIIM_FTYPE,fType:MFT_OWNERDRAW,..std::mem::zeroed() };
        SetMenuItemInfoW(menu,id as u32,0,&info);
    }
    SetMenuDefaultItem(menu,1,0);
    menu
}
// Compact action rows, using the same Segoe UI and cyan tokens as the editor.
unsafe fn draw_action(dc:HDC,rect:RECT,id:u32,selected:bool,swedish:bool,dark:bool,scale:f64) {
    let saved=SaveDC(dc); let px=|n:f64|(n*scale).round() as i32;
    let surface=if dark { 0x002b2224 } else { 0x00ffffff };
    let accent=if dark { 0x00f1c959 } else { 0x00956d00 };
    let ink=if selected { accent } else if dark { 0x00f7eef1 } else { 0x00312628 };
    let brush=CreateSolidBrush(surface); FillRect(dc,&rect,brush); DeleteObject(brush);
    if selected {
        let brush=CreateSolidBrush(if dark { 0x004b3b15 } else { 0x00fcf4e0 });
        let old=SelectObject(dc,brush); let pen=SelectObject(dc,GetStockObject(NULL_PEN));
        RoundRect(dc,rect.left+px(3.0),rect.top+px(2.0),rect.right-px(3.0),rect.bottom-px(2.0),px(10.0),px(10.0));
        SelectObject(dc,pen); SelectObject(dc,old); DeleteObject(brush);
    }
    let pen=CreatePen(PS_SOLID,px(1.5).max(1),accent); let old_pen=SelectObject(dc,pen); let old_brush=SelectObject(dc,GetStockObject(NULL_BRUSH));
    let x=rect.left+px(14.0); let y=rect.top+(rect.bottom-rect.top-px(18.0))/2;
    if id==1 {
        RoundRect(dc,x+px(5.0),y+px(5.0),x+px(17.0),y+px(17.0),px(3.0),px(3.0));
        MoveToEx(dc,x+px(11.0),y+px(1.0),null_mut()); LineTo(dc,x+px(1.0),y+px(1.0)); LineTo(dc,x+px(1.0),y+px(11.0));
    } else {
        let points=[POINT{x:x+px(2.0),y:y+px(12.0)},POINT{x:x+px(12.0),y:y+px(2.0)},POINT{x:x+px(16.0),y:y+px(6.0)},POINT{x:x+px(6.0),y:y+px(16.0)},POINT{x:x+px(1.0),y:y+px(17.0)},POINT{x:x+px(2.0),y:y+px(12.0)}];
        Polyline(dc,points.as_ptr(),points.len() as i32);
        MoveToEx(dc,x+px(10.0),y+px(4.0),null_mut()); LineTo(dc,x+px(14.0),y+px(8.0));
    }
    SelectObject(dc,old_pen); SelectObject(dc,old_brush); DeleteObject(pen);
    let name:Vec<u16>="Segoe UI\0".encode_utf16().collect();
    let font=CreateFontW(-px(13.0),0,0,0,500,0,0,0,DEFAULT_CHARSET as u32,0,0,ANTIALIASED_QUALITY as u32,0,name.as_ptr());
    let old=SelectObject(dc,font); SetBkMode(dc,TRANSPARENT as i32); SetTextColor(dc,ink);
    let label=match (id,swedish) { (1,true)=>"&Kopiera",(1,false)=>"&Copy",(_,true)=>"&Redigera",_=>"&Edit" };
    let text:Vec<u16>=label.encode_utf16().collect(); let mut text_rect=RECT{left:rect.left+px(44.0),right:rect.right-px(12.0),..rect};
    DrawTextW(dc,text.as_ptr(),text.len() as i32,&mut text_rect,DT_SINGLELINE|DT_VCENTER);
    SelectObject(dc,old); DeleteObject(font); RestoreDC(dc,saved);
}
unsafe fn choose_action(hwnd: HWND, point: (i32,i32), state: &mut Overlay) -> Option<bool> {
    let menu=action_menu(state.swedish); if menu.is_null() { return None; }
    let mut screen=POINT { x:point.0,y:point.1 }; ClientToScreen(hwnd,&mut screen);
    let mut dpi_x=96; let mut dpi_y=96;
    let monitor=MonitorFromPoint(screen,MONITOR_DEFAULTTONEAREST);
    let _=GetDpiForMonitor(monitor,MDT_EFFECTIVE_DPI,&mut dpi_x,&mut dpi_y);
    state.menu_scale=dpi_x as f64/96.0;
    let brush=CreateSolidBrush(if state.dark { 0x002b2224 } else { 0x00ffffff });
    let info=MENUINFO { cbSize:std::mem::size_of::<MENUINFO>() as u32,fMask:MIM_BACKGROUND|MIM_STYLE,hbrBack:brush,dwStyle:MNS_NOCHECK,..std::mem::zeroed() };
    SetMenuInfo(menu,&info);
    // Native popup placement, keyboard navigation and cancellation remain in Windows.
    SetTimer(hwnd,77,100,None);
    let command=TrackPopupMenuEx(menu,TPM_RETURNCMD|TPM_NONOTIFY|TPM_RIGHTBUTTON,screen.x,screen.y,hwnd,std::ptr::null());
    KillTimer(hwnd,77); DestroyMenu(menu); DeleteObject(brush); menu_action(command)
}
unsafe fn dispatch_capture_message(hwnd:HWND,state:*mut Overlay,message:&MSG) {
    if message.message==CANCEL_CAPTURE {
        (*state).result=None; (*state).closing=true; DestroyWindow(hwnd);
    } else { TranslateMessage(message); DispatchMessageW(message); }
}
unsafe fn capture(app: &tauri::AppHandle)->Result<(),String> {
    let id=windows_sys::Win32::System::Threading::GetCurrentThreadId();
    let mut queued:MSG=std::mem::zeroed(); PeekMessageW(&mut queued,null_mut(),0,0,PM_NOREMOVE);
    THREAD.store(id,Ordering::SeqCst);
    struct ThreadScope;
    impl Drop for ThreadScope { fn drop(&mut self) { THREAD.store(0,Ordering::SeqCst); } }
    let _thread=ThreadScope;
    let previous_dpi=SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    struct Dpi(windows_sys::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT);
    impl Drop for Dpi { fn drop(&mut self) { unsafe { if !self.0.is_null() { SetThreadDpiAwarenessContext(self.0); } } } }
    let _dpi=Dpi(previous_dpi);
    let source_path=crate::source_app::capture_path(); let foreground=GetForegroundWindow();
    let x=GetSystemMetrics(SM_XVIRTUALSCREEN); let y=GetSystemMetrics(SM_YVIRTUALSCREEN);
    let w=GetSystemMetrics(SM_CXVIRTUALSCREEN); let h=GetSystemMetrics(SM_CYVIRTUALSCREEN);
    if w<31 || h<31 || (w as i64)*(h as i64)>64_000_000 { return Err("Couldn't capture the screen area.".into()); }
    let mut info:BITMAPINFO=std::mem::zeroed(); info.bmiHeader=BITMAPINFOHEADER { biSize:std::mem::size_of::<BITMAPINFOHEADER>() as u32,biWidth:w,biHeight:-h,biPlanes:1,biBitCount:32,biCompression:BI_RGB,..std::mem::zeroed() };
    let screen=GetDC(null_mut()); if screen.is_null() { return Err("The screen is not available.".into()); }
    let (Some(desktop),Some(back))=(Surface::new(screen,&info),Surface::new(screen,&info)) else { ReleaseDC(null_mut(),screen); return Err("Couldn't create the screenshot.".into()); };
    let success=BitBlt(desktop.dc,0,0,w,h,screen,x,y,SRCCOPY|CAPTUREBLT); ReleaseDC(null_mut(),screen);
    if success==0 { return Err("Windows couldn't read the screenshot.".into()); }
    GdiFlush(); // Complete the desktop blit before its DIB memory is read for the final crop.
    let settings=app.state::<crate::RuntimeState>().library.lock().map_err(|_|crate::lock_error())?.settings.clone();
    let behavior=settings.capture_behavior.as_deref().unwrap_or(if settings.edit_after_capture { "edit" } else { "copy" });
    let mut state=Box::new(Overlay { w,h,desktop,back,closing:false,restore_focus:true,cursor:(w/2,h/2),anchor:None,result:None,choose:behavior=="choose",choosing:false,swedish:settings.language=="sv",dark:settings.theme=="dark" || (settings.theme=="system" && app.get_webview_window("main").is_some_and(|w|w.theme().ok()==Some(tauri::Theme::Dark))),menu_scale:1.0,action:Some(behavior=="edit") });
    let mut cursor:POINT=std::mem::zeroed(); GetCursorPos(&mut cursor); state.cursor=(cursor.x-x,cursor.y-y);
    let class:Vec<u16>="CopyloomCaptureOverlay\0".encode_utf16().collect(); let instance=GetModuleHandleW(std::ptr::null());
    let window_class=WNDCLASSW { lpfnWndProc:Some(procedure),hInstance:instance,lpszClassName:class.as_ptr(),hCursor:LoadCursorW(null_mut(),IDC_CROSS),..std::mem::zeroed() };
    RegisterClassW(&window_class);
    let hwnd=CreateWindowExW(WS_EX_TOPMOST|WS_EX_TOOLWINDOW,class.as_ptr(),class.as_ptr(),WS_POPUP,x,y,w,h,null_mut(),null_mut(),instance,(&mut *state as *mut Overlay).cast());
    if hwnd.is_null() { return Err("Couldn't open the area selection.".into()); }
    if CANCEL.load(Ordering::SeqCst) { state.closing=true; DestroyWindow(hwnd); return Ok(()); }
    ShowWindow(hwnd,SW_SHOW); SetForegroundWindow(hwnd); SetFocus(hwnd);
    let mut message:MSG=std::mem::zeroed(); loop {
        let status=GetMessageW(&mut message,null_mut(),0,0);
        if status<=0 { if IsWindow(hwnd)!=0 { state.closing=true; DestroyWindow(hwnd); } if status<0 { return Err("The area selection couldn't continue.".into()); } break; }
        dispatch_capture_message(hwnd,&mut *state,&message);
    }
    THREAD.store(0,Ordering::SeqCst);
    if state.restore_focus && IsWindow(foreground)!=0 { SetForegroundWindow(foreground); }
    let Some(rect)=state.result else { return Ok(()); };
    let width=(rect.right-rect.left) as usize; let height=(rect.bottom-rect.top) as usize;
    if width*height*4>crate::library::MAX_IMAGE_RGBA_BYTES { return Err("The area is too large. Choose a smaller area (64 megapixels at most).".into()); }
    let mut rgba=Vec::with_capacity(width*height*4); let pixels=state.desktop.pixels();
    for row in rect.top..rect.bottom { for col in rect.left..rect.right { let i=(row as usize*w as usize+col as usize)*4; rgba.extend_from_slice(&[pixels[i+2],pixels[i+1],pixels[i],255]); } }
    let action=state.action;
    drop(state); // Free full desktop buffers before encoding / storing the selected area.
    let png=crate::platform::encode_png(&arboard::ImageData {width,height,bytes:std::borrow::Cow::Borrowed(&rgba)})?;
    let mut clip=crate::library::Clip::captured(crate::platform::png_content(&png)?); clip.source_app=source_path.as_deref().and_then(crate::source_app::from_path);
    if settings.language != "sv" { clip.title="Copied image".into(); }
    let content=clip.content.clone(); let id=clip.id.clone();
    // Paused collection keeps screenshots out of the history too; the image still reaches the clipboard.
    let paused=app.state::<crate::RuntimeState>().library.lock().map_err(|_|crate::lock_error())?.paused;
    if !paused { crate::apply_core(app,crate::library::Action::AddClip{clip},false)?; }
    // The editor opens a stored clip, so a paused edit becomes a copy, with a word on why.
    if paused && action==Some(true) { let _=app.emit("runtime:error","Collection is paused. The screenshot was copied but not saved, so it cannot be edited."); }
    let action=if paused { action.map(|_|false) } else { action };
    if action.is_some() {
        *app.state::<crate::RuntimeState>().last_content.lock().map_err(|_|"Couldn't update the clipboard.")?=Some((content, None));
        crate::platform::write_image(&png,width,height,&rgba)?; // Reuse the encoded PNG and captured pixels.
    }
    let _=app.emit("capture:completed",());
    if action==Some(true) { crate::editor::open(app,id,true)?; }
    Ok(())
}
#[cfg(test)] mod tests {
    use super::*;
    #[test]
    fn styled_capture_actions_render_at_normal_and_high_dpi() { unsafe {
        for (swedish,dark,scale,name) in [(false,false,1.0,"light-en"),(true,true,2.0,"dark-sv-200")] {
            let w=(164.0*scale) as i32; let h=(80.0*scale) as i32;
            let mut info:BITMAPINFO=std::mem::zeroed(); info.bmiHeader=BITMAPINFOHEADER{biSize:std::mem::size_of::<BITMAPINFOHEADER>() as u32,biWidth:w,biHeight:-h,biPlanes:1,biBitCount:32,biCompression:BI_RGB,..std::mem::zeroed()};
            let screen=GetDC(null_mut()); let surface=Surface::new(screen,&info).unwrap(); ReleaseDC(null_mut(),screen);
            draw_action(surface.dc,RECT{left:0,top:0,right:w,bottom:h/2},1,true,swedish,dark,scale);
            draw_action(surface.dc,RECT{left:0,top:h/2,right:w,bottom:h},2,false,swedish,dark,scale);
            assert_eq!(GetPixel(surface.dc,w-12,h/4),if dark { 0x004b3b15 } else { 0x00fcf4e0 });
            GdiFlush(); let mut rgba=surface.pixels().to_vec();
            for pixel in rgba.chunks_exact_mut(4) { pixel.swap(0,2); pixel[3]=255; }
            let path=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join(format!(".impeccable/review/capture-actions-{name}.png"));
            image::RgbaImage::from_raw(w as u32,h as u32,rgba).unwrap().save_with_format(path,image::ImageFormat::Png).unwrap();
        }
    } }
    #[test]
    fn capture_menu_has_two_localized_actions_and_cancel_keeps_clipboard_untouched() { unsafe {
        for (swedish, expected) in [(false, ["&Copy", "&Edit"]), (true, ["&Kopiera", "&Redigera"])] {
            let menu=action_menu(swedish); assert!(!menu.is_null());
            assert_eq!(GetMenuItemCount(menu),2); assert_eq!(GetMenuDefaultItem(menu,0,0),1);
            for (position, label) in expected.iter().enumerate() {
                let mut text=[0u16;32]; let len=GetMenuStringW(menu,position as u32,text.as_mut_ptr(),32,MF_BYPOSITION);
                assert_eq!(String::from_utf16_lossy(&text[..len as usize]),*label);
            }
            DestroyMenu(menu);
        }
        assert_eq!(menu_action(1),Some(false)); assert_eq!(menu_action(2),Some(true)); assert_eq!(menu_action(0),None);
    } }
    #[test] fn selection_tint_is_linear_and_in_place() {
        let mut pixels=vec![200;3840*2160*4]; let start=std::time::Instant::now(); tint(&mut pixels);
        println!("4K selection tint: {:?}",start.elapsed());
        assert_eq!(&pixels[..4],&[203,196,176,255]); assert!(pixels.chunks_exact(4).all(|p|p==[203,196,176,255]));
    }
    #[test] fn rectangle_subtraction_covers_exactly_the_difference() {
        let r=|l,t,r,b|RECT { left:l,top:t,right:r,bottom:b };
        let area=|rects:&[RECT]|rects.iter().map(|x|(x.right-x.left)*(x.bottom-x.top)).sum::<i32>();
        assert_eq!(area(&subtract(r(0,0,100,100),r(0,0,90,95))),100*100-90*95);
        assert_eq!(area(&subtract(r(0,0,100,100),r(200,200,300,300))),100*100);
        assert!(subtract(r(10,10,20,20),r(0,0,100,100)).is_empty());
        assert_eq!(area(&subtract(r(0,0,100,100),r(40,40,60,60))),100*100-20*20);
        // Overlapping magnifier squares merge; the two sides of a large selection stay separate.
        assert_eq!(coalesce(vec![r(0,0,248,248),r(1,1,249,249),r(1,0,249,1)]).len(),1);
        assert_eq!(coalesce(vec![r(197,197,203,1903),r(2997,197,3003,1903)]).len(),2);
    }
    #[test] fn reversed_and_outside_drags_are_clamped() { let r=selection((400,300),(-20,10),300,200).unwrap(); assert_eq!((r.left,r.top,r.right,r.bottom),(0,10,300,200)); assert!(selection((10,10),(10,100),200,200).is_none()); }
    #[test] fn frozen_pixels_and_magnifier_use_top_left_coordinates() { unsafe {
        let w=500; let h=500;
        let mut info:BITMAPINFO=std::mem::zeroed(); info.bmiHeader=BITMAPINFOHEADER{biSize:std::mem::size_of::<BITMAPINFOHEADER>() as u32,biWidth:w,biHeight:-h,biPlanes:1,biBitCount:32,biCompression:BI_RGB,..std::mem::zeroed()};
        let screen=GetDC(null_mut()); let (desktop,back)=(Surface::new(screen,&info).unwrap(),Surface::new(screen,&info).unwrap()); ReleaseDC(null_mut(),screen);
        let mut pixels=Vec::new(); for y in 0..h { for x in 0..w { pixels.extend_from_slice(&[0,(y%256) as u8,(x%256) as u8,255]); } }
        std::slice::from_raw_parts_mut(desktop.bits,desktop.len).copy_from_slice(&pixels);
        let mut state=Overlay{w,h,desktop,back,closing:false,restore_focus:true,cursor:(120,120),anchor:Some((80,80)),result:None,choose:false,choosing:false,swedish:false,dark:false,menu_scale:1.0,action:Some(false)};
        render(&state,state.back.dc,RECT{left:0,top:0,right:w,bottom:h});
        // Red is x and green is y in the original synthetic desktop.
        assert_eq!(GetPixel(state.back.dc,100,90),88 | (99<<8) | (27<<16));
        assert_eq!(GetPixel(state.back.dc,30,30),30 | (30<<8)); // Unselected desktop is unchanged.
        assert_eq!(GetPixel(state.back.dc,94+60,94+72),110 | (112<<8));
        assert_eq!(GetPixel(state.desktop.dc,100,90),100 | (90<<8)); // The frozen snapshot is never drawn on.
        // Moving the cursor only needs the damaged areas repainted.
        let before=(state.cursor,state.anchor); state.cursor=(122,121);
        for rect in damage(w,h,before,(state.cursor,state.anchor)) { render(&state,state.back.dc,rect); }
        assert_eq!(GetPixel(state.back.dc,101,90),88 | (99<<8) | (27<<16));
        assert_eq!(GetPixel(state.back.dc,94+2+60,94+1+72),112 | (113<<8));
        assert_eq!(GetPixel(state.back.dc,450,450),(450%256) | ((450%256)<<8));
        GdiFlush();
        let mut rgba=state.back.pixels().to_vec();
        for pixel in rgba.chunks_exact_mut(4) { pixel.swap(0,2); pixel[3]=255; }
        let preview=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join(".impeccable/review/capture-overlay-native.png");
        image::RgbaImage::from_raw(w as u32,h as u32,rgba).unwrap().save_with_format(preview,image::ImageFormat::Png).unwrap();
        let class:Vec<u16>="CopyloomCaptureTest\0".encode_utf16().collect(); let instance=GetModuleHandleW(std::ptr::null());
        RegisterClassW(&WNDCLASSW{lpfnWndProc:Some(procedure),hInstance:instance,lpszClassName:class.as_ptr(),..std::mem::zeroed()});
        let create=|state:&mut Overlay|CreateWindowExW(WS_EX_TOOLWINDOW,class.as_ptr(),class.as_ptr(),WS_POPUP,0,0,w,h,null_mut(),null_mut(),instance,(state as *mut Overlay).cast());
        let hwnd=create(&mut state); assert!(!hwnd.is_null());
        SendMessageW(hwnd,WM_KEYDOWN,27,0); assert_eq!(IsWindow(hwnd),0); assert!(state.result.is_none());
        let mut message:MSG=std::mem::zeroed(); assert_eq!(GetMessageW(&mut message,null_mut(),0,0),0);
        state.closing=false; let hwnd=create(&mut state); assert!(!hwnd.is_null()); state.anchor=Some((100,90));
        SendMessageW(hwnd,WM_LBUTTONUP,0,(20<<16)|30);
        assert_eq!(IsWindow(hwnd),0); assert_eq!(GetMessageW(&mut message,null_mut(),0,0),0);
        let selected=state.result.unwrap(); assert_eq!((selected.left,selected.top,selected.right,selected.bottom),(30,20,100,90));
        state.closing=false; let hwnd=create(&mut state); assert!(!hwnd.is_null());
        let id=windows_sys::Win32::System::Threading::GetCurrentThreadId();
        assert_ne!(PostThreadMessageW(id,CANCEL_CAPTURE,0,0),0);
        assert!(GetMessageW(&mut message,null_mut(),0,0)>0);
        dispatch_capture_message(hwnd,&mut state,&message);
        assert_eq!(IsWindow(hwnd),0); assert!(state.result.is_none());
        assert_eq!(GetMessageW(&mut message,null_mut(),0,0),0);
    } }
    #[test] fn incremental_repaint_matches_full_render_for_every_drag_direction() { unsafe {
        let (w,h)=(520,400);
        let mut info:BITMAPINFO=std::mem::zeroed(); info.bmiHeader=BITMAPINFOHEADER{biSize:std::mem::size_of::<BITMAPINFOHEADER>() as u32,biWidth:w,biHeight:-h,biPlanes:1,biBitCount:32,biCompression:BI_RGB,..std::mem::zeroed()};
        let screen=GetDC(null_mut());
        let (desktop,back,incremental,full)=(Surface::new(screen,&info).unwrap(),Surface::new(screen,&info).unwrap(),Surface::new(screen,&info).unwrap(),Surface::new(screen,&info).unwrap());
        ReleaseDC(null_mut(),screen);
        let pixels=std::slice::from_raw_parts_mut(desktop.bits,desktop.len);
        for (i,pixel) in pixels.chunks_exact_mut(4).enumerate() { let (x,y)=(i%w as usize,i/w as usize); pixel.copy_from_slice(&[(x*7%256) as u8,(y*5%256) as u8,((x+y)%256) as u8,255]); }
        let all=RECT { left:0,top:0,right:w,bottom:h };
        let mut state=Overlay{w,h,desktop,back,closing:false,restore_focus:true,cursor:(260,200),anchor:None,result:None,choose:false,choosing:false,swedish:false,dark:false,menu_scale:1.0,action:Some(false)};
        render(&state,incremental.dc,all);
        let anchor=Some((260,200));
        // Hover, press, grow in each direction, cross the anchor, hug every screen edge, shrink to a sliver, jump.
        let steps=[((265,204),None),((260,200),anchor),((300,250),anchor),((420,330),anchor),((419,331),anchor),((200,120),anchor),((5,3),anchor),((0,399),anchor),
            ((519,0),anchor),((519,399),anchor),((261,201),anchor),((262,390),anchor),((40,210),anchor),((60,215),anchor),((500,190),anchor)];
        for (index,(cursor,anchor)) in steps.into_iter().enumerate() {
            let before=(state.cursor,state.anchor); state.cursor=cursor; state.anchor=anchor;
            let rects=coalesce(damage(w,h,before,(cursor,anchor)));
            for rect in &rects { render(&state,incremental.dc,*rect); }
            render(&state,full.dc,all); GdiFlush();
            let first=incremental.pixels().chunks_exact(4).zip(full.pixels().chunks_exact(4)).position(|(a,b)|a!=b);
            assert!(first.is_none(),"step {index}: first differing pixel at {:?}",first.map(|i|(i%w as usize,i/w as usize)));
        }
        // 4K: a one-pixel drag of a 2800 x 1700 selection repaints edges, labels and magnifier, not the selection.
        let repainted:i32=damage(3840,2160,((3000,1900),Some((200,200))),((3001,1901),Some((200,200)))).iter().map(|r|(r.right-r.left)*(r.bottom-r.top)).sum();
        assert!(repainted<2800*1700/10,"repainted {repainted} px");
    } }
}
