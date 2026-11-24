use windows::Win32::Foundation::{HWND, HGLOBAL};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL, IPersistFile, CLSCTX_INPROC_SERVER};
use windows::Win32::System::Com::StructuredStorage::{CreateStreamOnHGlobal, GetHGlobalFromStream};
use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
use windows::core::Interface;
use windows::Win32::UI::WindowsAndMessaging::HICON;
use windows::Win32::Graphics::Imaging::{IWICImagingFactory, CLSID_WICImagingFactory, GUID_ContainerFormatPng, WICBitmapEncoderNoCache, GUID_WICPixelFormat32bppPBGRA};
use base64::{Engine as _, engine::general_purpose};
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::Manager;

pub fn resolve_shortcut(path: &str) -> Option<(String, String)> {
    unsafe {
        let shell_link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_ALL).ok()?;
        let persist_file: IPersistFile = shell_link.cast().ok()?;
        
        let wide_path: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        persist_file.Load(windows::core::PCWSTR(wide_path.as_ptr()), windows::Win32::System::Com::STGM(0)).ok()?;
        
        let _ = shell_link.Resolve(HWND(std::ptr::null_mut()), 1 | 16 | 32); 
        
        let mut buffer = [0u16; 260];
        let mut data = windows::Win32::Storage::FileSystem::WIN32_FIND_DATAW::default();
        shell_link.GetPath(&mut buffer, &mut data, 0).ok()?;
        
        let mut arg_buffer = [0u16; 1024];
        let _ = shell_link.GetArguments(&mut arg_buffer);

        let target = String::from_utf16_lossy(&buffer).trim_matches(char::from(0)).to_string();
        let args = String::from_utf16_lossy(&arg_buffer).trim_matches(char::from(0)).to_string();
        
        if target.trim().is_empty() { None } else { Some((target, args)) }
    }
}

pub static ORIGINAL_TRAY_RECT: std::sync::Mutex<Option<windows::Win32::Foundation::RECT>> = std::sync::Mutex::new(None);
static ORIGINAL_SEC_TRAY_RECTS: std::sync::Mutex<Vec<(isize, windows::Win32::Foundation::RECT)>> = std::sync::Mutex::new(Vec::new());
static ORIGINAL_TASKBAR_STATE: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(-1);

const BLOCKED_ATTACH_EXES: &[&str] = &[
    "amdow.exe",
    "werfault.exe",
    "werfaultsecure.exe",
    "wermgr.exe",
    "rtss.exe",
    "rtsshooksloader64.exe",
    "presentmon.exe",
    "gamebar.exe",
    "gamebarftserver.exe",
    "nvcontainer.exe",
    "nvidia overlay.exe",
    "steamwebhelper.exe",
];

pub fn is_blocked_attach_exe(exe_name: &str) -> bool {
    let lower = exe_name.trim().to_ascii_lowercase();
    !lower.is_empty() && BLOCKED_ATTACH_EXES.iter().any(|blocked| lower == *blocked)
}

pub(crate) fn process_image_name_for_pid(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    unsafe {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
            PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(handle);
        if !ok || len == 0 {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        std::path::Path::new(&path)
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_string)
    }
}

pub fn is_hwnd_responsive(hwnd: HWND, timeout_ms: u32) -> bool {
    if hwnd.is_invalid() {
        return false;
    }
    unsafe {
        use windows::Win32::Foundation::{LPARAM, WPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{
            IsHungAppWindow, IsWindow, SendMessageTimeoutW, SMTO_ABORTIFHUNG, SMTO_BLOCK, WM_NULL,
        };
        if !IsWindow(Some(hwnd)).as_bool() || IsHungAppWindow(hwnd).as_bool() {
            return false;
        }
        SendMessageTimeoutW(
            hwnd,
            WM_NULL,
            WPARAM(0),
            LPARAM(0),
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            timeout_ms,
            None,
        )
        .0 != 0
    }
}

pub fn is_hwnd_responsive_for_attach(hwnd: HWND) -> bool {
    if !is_hwnd_responsive(hwnd, 50) {
        return false;
    }
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
        let mut pid = 0u32;
        let tid = GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if tid == 0 || pid == 0 {
            return false;
        }
        if let Some(exe) = process_image_name_for_pid(pid) {
            if is_blocked_attach_exe(&exe) {
                return false;
            }
        }
        true
    }
}

pub fn write_atomic_bytes(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("data.tmp");
    let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp_path = path.with_file_name(format!(".{}.{}.{}.tmp", file_name, std::process::id(), seq));
    if let Err(err) = std::fs::write(&tmp_path, bytes) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(err.to_string());
    }
    if let Err(first_err) = std::fs::rename(&tmp_path, path) {
        std::thread::sleep(std::time::Duration::from_millis(5));
        if std::fs::rename(&tmp_path, path).is_err() {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(first_err.to_string());
        }
    }
    Ok(())
}

pub(crate) fn spawn_shell_open(target: &'static str) {
    let target_bytes = target.as_bytes();
    if !target_bytes.ends_with(b"\0") {
        crate::diagnostics::log(&format!("shell_open: non-nul target {target}"));
        return;
    }
    std::thread::spawn(move || unsafe {
        use windows::Win32::UI::Shell::ShellExecuteA;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let _com = ComApartmentGuard::init_mta();
        let res = ShellExecuteA(
            None,
            windows::core::PCSTR(c"open".as_ptr() as *const u8),
            windows::core::PCSTR(target_bytes.as_ptr()),
            windows::core::PCSTR::null(),
            windows::core::PCSTR::null(),
            SW_SHOWNORMAL,
        );
        if (res.0 as isize) <= 32 {
            crate::diagnostics::log(&format!(
                "shell_open failed for {}: code={}",
                target.trim_end_matches('\0'),
                res.0 as isize
            ));
        }
    });
}

static TASKBAR_MARKER: OnceLock<PathBuf> = OnceLock::new();

/// Point the crash-recovery marker at this user's app config dir (called from setup).
pub fn init_taskbar_marker(app: &tauri::AppHandle) {
    if let Ok(dir) = app.path().app_config_dir() {
        let _ = TASKBAR_MARKER.set(dir.join("taskbar_hidden.flag"));
    }
}

pub fn taskbar_marker_exists() -> bool {
    TASKBAR_MARKER.get().is_some_and(|p| p.exists())
}

fn rect_is_on_screen(r: &windows::Win32::Foundation::RECT) -> bool {
    r.left > -5000 && r.top > -5000
}

unsafe fn monitor_rects() -> Vec<(windows::Win32::Foundation::RECT, bool)> {
    use windows::Win32::Foundation::{LPARAM, RECT};
    use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO};

    unsafe extern "system" fn collect(hmon: HMONITOR, _: HDC, _: *mut RECT, lparam: LPARAM) -> windows::core::BOOL {
        let list = &mut *(lparam.0 as *mut Vec<(RECT, bool)>);
        let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if GetMonitorInfoW(hmon, &mut mi).as_bool() {
            list.push((mi.rcMonitor, mi.dwFlags & 1 != 0));
        }
        windows::core::BOOL(1)
    }
    let mut monitors: Vec<(RECT, bool)> = Vec::new();
    let _ = EnumDisplayMonitors(None, None, Some(collect), LPARAM(&mut monitors as *mut _ as isize));
    monitors
}

fn taskbar_monitor(monitors: &[(windows::Win32::Foundation::RECT, bool)], primary: bool, taskbar: &windows::Win32::Foundation::RECT) -> Option<windows::Win32::Foundation::RECT> {
    if primary {
        monitors.iter().find(|(_, is_primary)| *is_primary).map(|(r, _)| *r)
    } else {
        let width = taskbar.right - taskbar.left;
        monitors.iter().find(|(r, is_primary)| !*is_primary && r.left == taskbar.left && r.right == taskbar.right)
            .or_else(|| monitors.iter().find(|(r, is_primary)| !*is_primary && r.right - r.left == width))
            .or_else(|| monitors.iter().find(|(_, is_primary)| !*is_primary))
            .map(|(r, _)| *r)
    }
}

pub unsafe fn park_below_monitor(hwnd: windows::Win32::Foundation::HWND, primary: bool) {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, SetWindowPos, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER};
    let mut cur = RECT::default();
    let _ = GetWindowRect(hwnd, &mut cur);
    let (x, y) = match taskbar_monitor(&monitor_rects(), primary, &cur) {
        Some(m) => (m.left, m.bottom),
        None => (-10000, -10000),
    };
    let _ = SetWindowPos(hwnd, None, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
}

pub fn hide_and_park_taskbar_window(hwnd: windows::Win32::Foundation::HWND, primary: bool) {
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{IsWindow, IsWindowVisible, ShowWindow, SW_HIDE};
        if hwnd.0.is_null() || !IsWindow(Some(hwnd)).as_bool() || !IsWindowVisible(hwnd).as_bool() {
            return;
        }
        let _ = ShowWindow(hwnd, SW_HIDE);
        park_below_monitor(hwnd, primary);
    }
}

unsafe fn restore_tray_position(hwnd: windows::Win32::Foundation::HWND, primary: bool, saved: Option<windows::Win32::Foundation::RECT>) {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, SetWindowPos, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER};

    if let Some(r) = saved {
        if rect_is_on_screen(&r) {
            let _ = SetWindowPos(hwnd, None, r.left, r.top, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
            return;
        }
    }

    let mut cur = RECT::default();
    let _ = GetWindowRect(hwnd, &mut cur);
    let h = cur.bottom - cur.top;
    let monitors = monitor_rects();
    let inside_a_monitor = monitors.iter().any(|(m, _)| cur.left >= m.left && cur.top >= m.top && cur.right <= m.right && cur.bottom <= m.bottom);
    if inside_a_monitor { return; }

    if let Some(mon) = taskbar_monitor(&monitors, primary, &cur) {
        let _ = SetWindowPos(hwnd, None, mon.left, mon.bottom - h, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    }
}

/// The marker stores the user's own taskbar state from before we forced auto-hide,
/// so a crash can't lose it. Old markers just have "1".
fn marker_contents(original_state: i32) -> String {
    format!("abstate={original_state}")
}

fn parse_marker_state(contents: &str) -> Option<i32> {
    contents.trim().strip_prefix("abstate=")?.parse().ok()
}

/// Restores the taskbar after a session died with it hidden, using the state saved in the marker.
pub fn restore_taskbar_after_crash() {
    let saved = TASKBAR_MARKER
        .get()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|contents| parse_marker_state(&contents));
    if let Some(state) = saved {
        ORIGINAL_TASKBAR_STATE.store(state, std::sync::atomic::Ordering::Relaxed);
    }
    set_taskbar_visibility(true, true);
}

pub fn secondary_taskbars() -> Vec<windows::Win32::Foundation::HWND> {
    use windows::Win32::UI::WindowsAndMessaging::FindWindowExA;
    let mut taskbars = Vec::new();
    let mut previous = None;
    loop {
        let next = unsafe {
            FindWindowExA(None, previous, windows::core::PCSTR(c"Shell_SecondaryTrayWnd".as_ptr() as *const u8), windows::core::PCSTR::null())
        };
        match next {
            Ok(hwnd) if !hwnd.0.is_null() => {
                taskbars.push(hwnd);
                previous = Some(hwnd);
            }
            _ => break,
        }
    }
    taskbars
}

pub fn set_taskbar_visibility(visible: bool, always_on_top: bool) {
    if visible {
        crate::state::NATIVE_TASKBAR_HIDDEN.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE, SW_SHOW, GetWindowRect};
        use windows::Win32::UI::Shell::{SHAppBarMessage, APPBARDATA, ABM_SETSTATE, ABM_GETSTATE};

        // Startup retries and display handlers can try to hide the taskbar after shutdown restored it.
        if !visible && crate::state::SHUTTING_DOWN.load(std::sync::atomic::Ordering::Relaxed) {
            return;
        }

        // Save original taskbar state before modifying
        if ORIGINAL_TASKBAR_STATE.load(std::sync::atomic::Ordering::Relaxed) == -1 {
            let mut get_abd = APPBARDATA { cbSize: std::mem::size_of::<APPBARDATA>() as u32, ..Default::default() };
            let original_state = SHAppBarMessage(ABM_GETSTATE, &mut get_abd);
            ORIGINAL_TASKBAR_STATE.store(original_state as i32, std::sync::atomic::Ordering::Relaxed);
        }

        // Crash marker: written when hidden so the next launch can undo it after a force kill.
        // Written after the original state is known so it can carry it.
        if visible {
            if let Some(p) = TASKBAR_MARKER.get() {
                let _ = std::fs::remove_file(p);
            }
        } else if let Some(p) = TASKBAR_MARKER.get() {
            if !p.exists() {
                let original = ORIGINAL_TASKBAR_STATE.load(std::sync::atomic::Ordering::Relaxed);
                let _ = std::fs::write(p, marker_contents(original));
            }
        }

        let state_val = if visible {
            let orig = ORIGINAL_TASKBAR_STATE.load(std::sync::atomic::Ordering::Relaxed);
            if orig != -1 {
                orig as isize
            } else if always_on_top {
                2
            } else {
                1
            }
        } else {
            1
        };

        // 1. Set the taskbar state (Auto-hide or Always-on-top)
        let mut abd = APPBARDATA { 
            cbSize: std::mem::size_of::<APPBARDATA>() as u32, 
            lParam: windows::Win32::Foundation::LPARAM(state_val), 
            ..Default::default() 
        };
        SHAppBarMessage(ABM_SETSTATE, &mut abd);

        // 2. Control visibility of the primary taskbar (skipping Nectar's tray proxy)
        if let Some(tray_hwnd) = crate::tray_host::explorer_tray_hwnd() {
            use windows::Win32::UI::WindowsAndMessaging::{IsWindowVisible, GetWindowLongA, SetWindowLongA, GWL_EXSTYLE, WS_EX_LAYERED, WS_EX_TRANSPARENT, SetLayeredWindowAttributes, LWA_ALPHA};
            if visible {
                // Revert any lingering WS_EX_LAYERED / WS_EX_TRANSPARENT left by
                // open_system_tray if the user quit before the tray thread cleaned up.
                let ex = GetWindowLongA(tray_hwnd, GWL_EXSTYLE);
                let cleaned = ex & !(WS_EX_LAYERED.0 as i32) & !(WS_EX_TRANSPARENT.0 as i32);
                if cleaned != ex {
                    let _ = SetWindowLongA(tray_hwnd, GWL_EXSTYLE, cleaned);
                    let _ = SetLayeredWindowAttributes(tray_hwnd, windows::Win32::Foundation::COLORREF(0), 255, LWA_ALPHA);
                }
                let saved = ORIGINAL_TRAY_RECT.lock().ok().and_then(|g| *g);
                restore_tray_position(tray_hwnd, true, saved);
                let _ = ShowWindow(tray_hwnd, SW_SHOW);

                {
                    use windows::Win32::Graphics::Gdi::{RedrawWindow, RDW_INVALIDATE, RDW_ALLCHILDREN, RDW_UPDATENOW, RDW_FRAME, RDW_ERASE};
                    let _ = RedrawWindow(Some(tray_hwnd), None, None, RDW_INVALIDATE | RDW_ALLCHILDREN | RDW_UPDATENOW | RDW_FRAME | RDW_ERASE);

                    use windows::Win32::UI::WindowsAndMessaging::{SendMessageTimeoutA, HWND_BROADCAST, WM_SETTINGCHANGE, SMTO_ABORTIFHUNG};
                    use windows::Win32::Foundation::{WPARAM, LPARAM};
                    let param = c"TraySettings";
                    let mut result: usize = 0;
                    let _ = SendMessageTimeoutA(HWND_BROADCAST, WM_SETTINGCHANGE, WPARAM(0), LPARAM(param.as_ptr() as isize), SMTO_ABORTIFHUNG, 100, Some(&mut result));
                }
            } else {
                let has_rect = ORIGINAL_TRAY_RECT.lock().map(|g| g.is_some()).unwrap_or(false);
                if !has_rect {
                    let mut rect = windows::Win32::Foundation::RECT::default();
                    let _ = GetWindowRect(tray_hwnd, &mut rect);
                    if rect_is_on_screen(&rect) && IsWindowVisible(tray_hwnd).as_bool() {
                        if let Ok(mut guard) = ORIGINAL_TRAY_RECT.lock() {
                            *guard = Some(rect);
                        }
                    }
                }
                let _ = ShowWindow(tray_hwnd, SW_HIDE);
                // Move it far off-screen to prevent any "thin line" artifacts or flashes
                park_below_monitor(tray_hwnd, true);
            }
        }

        // 3. Control visibility of secondary taskbars (multi-monitor)
        for secondary_tray_hwnd in secondary_taskbars() {
            use windows::Win32::UI::WindowsAndMessaging::{IsWindowVisible};
            let key = secondary_tray_hwnd.0 as isize;
            if visible {
                let saved = ORIGINAL_SEC_TRAY_RECTS.lock().ok().and_then(|g| g.iter().find(|(k, _)| *k == key).map(|(_, r)| *r));
                restore_tray_position(secondary_tray_hwnd, false, saved);
                let _ = ShowWindow(secondary_tray_hwnd, SW_SHOW);
                {
                    use windows::Win32::Graphics::Gdi::{RedrawWindow, RDW_INVALIDATE, RDW_ALLCHILDREN, RDW_UPDATENOW, RDW_FRAME, RDW_ERASE};
                    let _ = RedrawWindow(Some(secondary_tray_hwnd), None, None, RDW_INVALIDATE | RDW_ALLCHILDREN | RDW_UPDATENOW | RDW_FRAME | RDW_ERASE);
                }
            } else {
                let has_sec_rect = ORIGINAL_SEC_TRAY_RECTS.lock().map(|g| g.iter().any(|(k, _)| *k == key)).unwrap_or(false);
                if !has_sec_rect {
                    let mut rect = windows::Win32::Foundation::RECT::default();
                    let _ = GetWindowRect(secondary_tray_hwnd, &mut rect);
                    if rect_is_on_screen(&rect) && IsWindowVisible(secondary_tray_hwnd).as_bool() {
                        if let Ok(mut guard) = ORIGINAL_SEC_TRAY_RECTS.lock() {
                            guard.push((key, rect));
                        }
                    }
                }
                let _ = ShowWindow(secondary_tray_hwnd, SW_HIDE);
                park_below_monitor(secondary_tray_hwnd, false);
            }
        }

        if visible {
            use windows::Win32::UI::WindowsAndMessaging::{SendMessageTimeoutW, HWND_BROADCAST, WM_SETTINGCHANGE, SMTO_ABORTIFHUNG};
            let setting: Vec<u16> = "TraySettings".encode_utf16().chain(std::iter::once(0)).collect();
            let _ = SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                windows::Win32::Foundation::WPARAM(0),
                windows::Win32::Foundation::LPARAM(setting.as_ptr() as isize),
                SMTO_ABORTIFHUNG,
                1000,
                None,
            );
        } else {
            crate::tray_host::outrank();
        }
    }
}

pub fn exe_description(path: &str) -> Option<String> {
    use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
    static CACHE: OnceLock<std::sync::Mutex<std::collections::HashMap<String, Option<String>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    if let Some(hit) = cache.lock().ok().and_then(|c| c.get(path).cloned()) {
        return hit;
    }

    let result = unsafe {
        let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
        let path_w = wide(path);
        let size = GetFileVersionInfoSizeW(windows::core::PCWSTR(path_w.as_ptr()), None);
        if size == 0 {
            None
        } else {
            let mut buf = vec![0u8; size as usize];
            if GetFileVersionInfoW(windows::core::PCWSTR(path_w.as_ptr()), None, size, buf.as_mut_ptr() as *mut _).is_err() {
                None
            } else {
                let query = |sub: &str| -> Option<(*mut std::ffi::c_void, u32)> {
                    let sub_w = wide(sub);
                    let mut ptr: *mut std::ffi::c_void = std::ptr::null_mut();
                    let mut len = 0u32;
                    let ok = VerQueryValueW(buf.as_ptr() as *const _, windows::core::PCWSTR(sub_w.as_ptr()), &mut ptr, &mut len);
                    if ok.as_bool() && !ptr.is_null() && len > 0 { Some((ptr, len)) } else { None }
                };
                query("\\VarFileInfo\\Translation").and_then(|(ptr, _)| {
                    let lang = *(ptr as *const u16);
                    let codepage = *(ptr as *const u16).add(1);
                    let (desc, _) = query(&format!("\\StringFileInfo\\{:04x}{:04x}\\FileDescription", lang, codepage))?;
                    let s = String::from_utf16_lossy(windows::core::PCWSTR(desc as *const u16).as_wide()).trim().to_string();
                    if s.is_empty() { None } else { Some(s) }
                })
            }
        }
    };

    if let Ok(mut c) = cache.lock() { c.insert(path.to_string(), result.clone()); }
    result
}

pub unsafe fn icon_from_absolute_pidl(pidl: *const windows::Win32::UI::Shell::Common::ITEMIDLIST) -> Option<String> {
    use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON, SHGFI_PIDL};
    use windows::Win32::UI::WindowsAndMessaging::DestroyIcon;
    let mut shfi: SHFILEINFOW = std::mem::zeroed();
    let res = SHGetFileInfoW(
        windows::core::PCWSTR(pidl as *const u16),
        Default::default(),
        Some(&mut shfi),
        std::mem::size_of::<SHFILEINFOW>() as u32,
        SHGFI_ICON | SHGFI_LARGEICON | SHGFI_PIDL,
    );
    if res != 0 && !shfi.hIcon.is_invalid() {
        let b64 = icon_to_base64(shfi.hIcon);
        let _ = DestroyIcon(shfi.hIcon);
        b64
    } else {
        None
    }
}

pub unsafe fn icon_from_parsing_name(name: &str) -> Option<String> {
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::SHParseDisplayName;
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let mut pidl = std::ptr::null_mut();
    SHParseDisplayName(windows::core::PCWSTR(wide.as_ptr()), None, &mut pidl, 0, None).ok()?;
    if pidl.is_null() { return None; }
    let icon = icon_from_absolute_pidl(pidl);
    CoTaskMemFree(Some(pidl as *const _));
    icon
}

pub(crate) unsafe fn wic_source_to_rgba(
    factory: &IWICImagingFactory,
    source: &windows::Win32::Graphics::Imaging::IWICBitmapSource,
    unpremultiply: bool,
) -> Option<image::RgbaImage> {
    use windows::Win32::Graphics::Imaging::{
        GUID_WICPixelFormat32bppBGRA, WICBitmapDitherTypeNone, WICBitmapPaletteTypeMedianCut,
    };

    let (mut width, mut height) = (0u32, 0u32);
    source.GetSize(&mut width, &mut height).ok()?;
    if width == 0 || height == 0 || width > 4096 || height > 4096 {
        return None;
    }

    let converter = factory.CreateFormatConverter().ok()?;
    converter
        .Initialize(
            source,
            &GUID_WICPixelFormat32bppBGRA,
            WICBitmapDitherTypeNone,
            None,
            0.0,
            WICBitmapPaletteTypeMedianCut,
        )
        .ok()?;

    let stride = width.checked_mul(4)?;
    let buf_len = (stride as usize).checked_mul(height as usize)?;
    let mut pixels = vec![0u8; buf_len];
    converter.CopyPixels(std::ptr::null(), stride, &mut pixels).ok()?;

    for px in pixels.chunks_exact_mut(4) {
        px.swap(0, 2);
        if unpremultiply {
            let a = px[3];
            if a > 0 && a < 255 {
                let scale = 255.0 / a as f32;
                px[0] = ((px[0] as f32 * scale).round() as u32).min(255) as u8;
                px[1] = ((px[1] as f32 * scale).round() as u32).min(255) as u8;
                px[2] = ((px[2] as f32 * scale).round() as u32).min(255) as u8;
            }
        }
    }

    image::RgbaImage::from_raw(width, height, pixels)
}

pub(crate) unsafe fn hicon_to_rgba(hicon: HICON) -> Option<image::RgbaImage> {
    let factory: IWICImagingFactory =
        CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).ok()?;
    let bitmap = factory.CreateBitmapFromHICON(hicon).ok()?;
    wic_source_to_rgba(&factory, &bitmap.cast().ok()?, false)
}

pub unsafe fn icon_to_base64(hicon: HICON) -> Option<String> {
    let rgba = hicon_to_rgba(hicon)?;
    normalize_rgba_to_base64_png(rgba)
}

// Drops a near-black plate behind an icon (Figma, Zen).
fn strip_dark_plate(img: &mut image::RgbaImage) {
    let (w, h) = img.dimensions();
    if w < 8 || h < 8 { return; }
    let mut minx = w; let mut miny = h; let mut maxx = 0; let mut maxy = 0;
    for y in 0..h { for x in 0..w {
        if img.get_pixel(x, y)[3] > 200 {
            minx = minx.min(x); maxx = maxx.max(x); miny = miny.min(y); maxy = maxy.max(y);
        }
    } }
    if maxx <= minx + 4 || maxy <= miny + 4 { return; }
    let mut ring: Vec<(u32, u32)> = Vec::new();
    for x in minx..=maxx { ring.push((x, miny + 1)); ring.push((x, maxy - 1)); }
    for y in miny..=maxy { ring.push((minx + 1, y)); ring.push((maxx - 1, y)); }
    let mut counts: std::collections::HashMap<[u8; 3], usize> = std::collections::HashMap::new();
    for &(x, y) in &ring {
        let p = img.get_pixel(x, y);
        if p[3] > 200 { *counts.entry([p[0], p[1], p[2]]).or_insert(0) += 1; }
    }
    let Some((&bg, &n)) = counts.iter().max_by_key(|(_, c)| **c) else { return };
    let luma = (bg[0] as u32 * 299 + bg[1] as u32 * 587 + bg[2] as u32 * 114) / 1000;
    if luma > 55 || n * 100 < ring.len() * 70 { return; }
    let near = |p: &image::Rgba<u8>| {
        (0..3).all(|i| (p[i] as i32 - bg[i] as i32).abs() <= 8)
    };
    let mut stack: Vec<(u32, u32)> = ring;
    let mut seen = vec![false; (w * h) as usize];
    while let Some((x, y)) = stack.pop() {
        let idx = (y * w + x) as usize;
        if seen[idx] { continue; }
        seen[idx] = true;
        let p = *img.get_pixel(x, y);
        if p[3] == 0 || !near(&p) { continue; }
        img.put_pixel(x, y, image::Rgba([0, 0, 0, 0]));
        if x > 0 { stack.push((x - 1, y)); }
        if y > 0 { stack.push((x, y - 1)); }
        if x + 1 < w { stack.push((x + 1, y)); }
        if y + 1 < h { stack.push((x, y + 1)); }
    }
}

fn encode_rgba_to_base64_png(rgba: image::RgbaImage) -> Option<String> {
    let mut out: Vec<u8> = Vec::new();
    image::DynamicImage::ImageRgba8(rgba)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .ok()?;
    Some(format!("data:image/png;base64,{}", general_purpose::STANDARD.encode(&out)))
}

fn normalize_rgba_to_base64_png(mut rgba: image::RgbaImage) -> Option<String> {
    const TARGET_FILL_RATIO: f64 = 0.82;

    for px in rgba.pixels_mut() {
        if px[3] < 40 {
            *px = image::Rgba([0, 0, 0, 0]);
        }
    }
    let (w, h) = rgba.dimensions();
    strip_dark_plate(&mut rgba);

    let mut minx = w;
    let mut miny = h;
    let mut maxx: i64 = 0;
    let mut maxy: i64 = 0;
    let mut found = false;
    for y in 0..h {
        for x in 0..w {
            if rgba.get_pixel(x, y)[3] > 10 {
                found = true;
                if x < minx { minx = x; }
                if (x as i64) > maxx { maxx = x as i64; }
                if y < miny { miny = y; }
                if (y as i64) > maxy { maxy = y as i64; }
            }
        }
    }
    if !found {
        return encode_rgba_to_base64_png(rgba);
    }

    let content_w = (maxx as u32).saturating_sub(minx) + 1;
    let content_h = (maxy as u32).saturating_sub(miny) + 1;
    let content_max = content_w.max(content_h);
    let base_size = w.min(h);
    let current_ratio = content_max as f64 / base_size as f64;

    let canvas_size = if current_ratio > TARGET_FILL_RATIO {
        (content_max as f64 / TARGET_FILL_RATIO).round() as u32
    } else {
        base_size
    };

    let cropped = image::imageops::crop_imm(&rgba, minx, miny, content_w, content_h).to_image();
    let mut canvas = image::RgbaImage::new(canvas_size, canvas_size);
    let ox = ((canvas_size - content_w) / 2) as i64;
    let oy = ((canvas_size - content_h) / 2) as i64;
    image::imageops::overlay(&mut canvas, &cropped, ox, oy);

    encode_rgba_to_base64_png(canvas)
}

pub fn get_now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64
}

fn settings_cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, serde_json::Value>> {
    crate::state::SETTINGS_CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

pub const NECTAR_INJECTED_EXTRA_INFO: usize = 0x4E45_4354_4152;

fn json_value_to_string(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Bool(b) => Some(if *b { "true".to_string() } else { "false".to_string() }),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn cache_bool_setting(
    cache: &std::collections::HashMap<String, serde_json::Value>,
    key: &str,
    default: bool,
) -> bool {
    match cache.get(key) {
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::String(s)) => match s.trim().to_ascii_lowercase().as_str() {
            "true" => true,
            "false" => false,
            _ => default,
        },
        _ => default,
    }
}

fn sync_hook_atomics_from_cache() {
    use std::sync::atomic::Ordering;
    let Some(cache) = crate::state::SETTINGS_CACHE.get() else { return };
    let Ok(guard) = cache.lock() else { return };
    crate::state::HOOK_CUSTOM_START_ENABLED.store(
        cache_bool_setting(&guard, "nectar-start-custom-enabled", true),
        Ordering::SeqCst,
    );
    crate::state::HOOK_WINKEY_ENABLED.store(
        cache_bool_setting(&guard, "nectar-start-winkey-hook", true),
        Ordering::SeqCst,
    );
    crate::state::HOOK_LEGACY_MODE.store(
        cache_bool_setting(&guard, "nectar-legacy-mode", false),
        Ordering::SeqCst,
    );
    crate::state::HOOK_DOCK_WIN_NUMBER_ENABLED.store(
        cache_bool_setting(&guard, "nectar-dock-win-number-enabled", true),
        Ordering::SeqCst,
    );
    crate::state::HOOK_VOLUME_OVERLAY_ENABLED.store(
        cache_bool_setting(&guard, "nectar-volume-overlay-enabled", true),
        Ordering::SeqCst,
    );
    crate::state::HOOK_BRIGHTNESS_OVERLAY_ENABLED.store(
        cache_bool_setting(&guard, "nectar-brightness-overlay-enabled", true),
        Ordering::SeqCst,
    );
    crate::state::HOOK_DOCK_ENABLED.store(
        cache_bool_setting(&guard, "nectar-dock-enabled", true),
        Ordering::SeqCst,
    );
    crate::state::HOOK_DOCK_SHOW_DESKTOP_CORNER.store(
        cache_bool_setting(&guard, "nectar-dock-show-desktop-corner", false),
        Ordering::SeqCst,
    );

    let ram_legacy = cache_bool_setting(&guard, "nectar-ram-saver", false);
    let perf_profile = match guard
        .get("nectar-perf-profile")
        .and_then(json_value_to_string)
        .map(|s| s.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("eco") => 1u8,
        Some("max") => 2u8,
        Some("balanced") => 0u8,
        _ => if ram_legacy { 1u8 } else { 0u8 },
    };
    crate::state::PERF_PROFILE.store(perf_profile, Ordering::Relaxed);
    crate::state::RAM_SAVER_ENABLED.store(perf_profile == 1, Ordering::Relaxed);

    crate::state::GAME_MODE_ENABLED.store(
        cache_bool_setting(&guard, "nectar-game-mode", true),
        Ordering::Relaxed,
    );
    crate::state::GAME_MODE_PAUSE_POLLS.store(
        cache_bool_setting(&guard, "nectar-game-mode-pause-polls", true),
        Ordering::Relaxed,
    );
    crate::state::HOOK_PREVIEW_PRECAPTURE.store(
        cache_bool_setting(&guard, "nectar-preview-precapture", false),
        Ordering::Relaxed,
    );
    crate::state::HOOK_DOCK_PREVIEW_ENABLED.store(
        cache_bool_setting(&guard, "nectar-dock-preview-enabled", true),
        Ordering::Relaxed,
    );

    let dock_icon_size = guard
        .get("nectar-dock-icon-size")
        .and_then(json_value_to_string)
        .and_then(|s| s.trim().parse::<f64>().ok())
        .map(|v| v.round() as i32)
        .unwrap_or(36)
        .clamp(28, 48);
    crate::state::DOCK_ICON_SIZE.store(dock_icon_size, Ordering::Relaxed);

    let overlay_vpos = match guard
        .get("nectar-overlay-vpos")
        .and_then(json_value_to_string)
        .map(|s| s.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("top") => 1u8,
        Some("bottom") => 2u8,
        _ => 0u8,
    };
    crate::state::OVERLAY_VPOS.store(overlay_vpos, Ordering::Relaxed);

    let overlay_width_style = match guard
        .get("nectar-overlay-style")
        .and_then(json_value_to_string)
        .map(|s| s.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("slim") => 1u8,
        Some("wide") => 2u8,
        _ => 0u8,
    };
    crate::state::OVERLAY_WIDTH_STYLE.store(overlay_width_style, Ordering::Relaxed);

    let scale = guard
        .get("nectar-scale")
        .and_then(json_value_to_string)
        .and_then(|s| s.trim().parse::<f32>().ok())
        .filter(|v| v.is_finite())
        .unwrap_or(1.0)
        .clamp(0.75, 1.75);
    crate::state::NECTAR_SCALE_BITS.store(scale.to_bits(), Ordering::Relaxed);

    crate::state::MOUSE_SETTINGS_EPOCH.fetch_add(1, Ordering::Release);

    let reset_win = !crate::state::HOOK_CUSTOM_START_ENABLED.load(Ordering::Relaxed)
        || !crate::state::HOOK_WINKEY_ENABLED.load(Ordering::Relaxed)
        || crate::state::HOOK_LEGACY_MODE.load(Ordering::Relaxed);
    drop(guard);
    if reset_win {
        crate::start_menu::reset_win_hook_state();
    }
}

pub struct ComApartmentGuard {
    initialized: bool,
}

impl ComApartmentGuard {
    pub fn init_mta() -> Self {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        Self { initialized: hr.is_ok() }
    }
}

impl Drop for ComApartmentGuard {
    fn drop(&mut self) {
        if self.initialized {
            unsafe {
                windows::Win32::System::Com::CoUninitialize();
            }
        }
    }
}

static SETTINGS_CACHE_HYDRATED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

pub fn sync_hook_atomics(_app: &tauri::AppHandle) {
    sync_hook_atomics_from_cache();
}

/// Load settings.json into the in-memory cache. Call once at startup.
pub fn init_settings_cache(app: &tauri::AppHandle) {
    use tauri::Manager;
    let _ = settings_cache();
    if let Some(path) = app.path().app_config_dir().ok().map(|p| p.join("settings.json")) {
        if let Ok(content) = std::fs::read_to_string(path) {
            if let Ok(settings) = serde_json::from_str::<std::collections::HashMap<String, serde_json::Value>>(&content) {
                if let Ok(mut cache) = settings_cache().lock() {
                    *cache = settings;
                }
            }
        }
    }
    SETTINGS_CACHE_HYDRATED.store(true, std::sync::atomic::Ordering::Release);
    sync_hook_atomics(app);
}

/// Replace the entire settings cache (used by the file watcher on external changes).
pub fn replace_settings_cache(new_settings: std::collections::HashMap<String, serde_json::Value>) {
    if let Ok(mut cache) = settings_cache().lock() {
        *cache = new_settings;
    }
    SETTINGS_CACHE_HYDRATED.store(true, std::sync::atomic::Ordering::Release);
    sync_hook_atomics_from_cache();
}

pub fn cached_settings_snapshot() -> Option<std::collections::HashMap<String, serde_json::Value>> {
    if !SETTINGS_CACHE_HYDRATED.load(std::sync::atomic::Ordering::Acquire) {
        return None;
    }
    settings_cache().lock().ok().map(|g| g.clone())
}

pub fn store_cached_thumbnail(hwnd_raw: isize, img: String) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::IsWindow;
    let Some(cache) = crate::state::THUMBNAIL_CACHE.get() else { return };
    if let Ok(mut guard) = cache.lock() {
        guard.insert(hwnd_raw, (img, get_now_ms()));
        if guard.len() > 12 {
            guard.retain(|&k, _| unsafe { IsWindow(Some(HWND(k as *mut _))).as_bool() });
            while guard.len() > 12 {
                if let Some(&oldest_k) = guard.iter().min_by_key(|(_, (_, ts))| *ts).map(|(k, _)| k) {
                    guard.remove(&oldest_k);
                } else {
                    break;
                }
            }
        }
    }
}

pub fn get_nectar_scale(_app: &tauri::AppHandle) -> f64 {
    let bits = crate::state::NECTAR_SCALE_BITS.load(std::sync::atomic::Ordering::Relaxed);
    if bits == 0 {
        return 1.0;
    }
    let v = f32::from_bits(bits) as f64;
    if v.is_finite() { v.clamp(0.75, 1.75) } else { 1.0 }
}

/// Read any string value from the settings cache. Returns None if the key is absent.
pub fn setting_flag(key: &str) -> bool {
    let Some(cache) = crate::state::SETTINGS_CACHE.get() else { return false };
    let Ok(guard) = cache.lock() else { return false };
    match guard.get(key) {
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::String(s)) => s == "true",
        _ => false,
    }
}

pub fn get_setting_str(_app: &tauri::AppHandle, key: &str) -> Option<String> {
    let cache = crate::state::SETTINGS_CACHE.get()?;
    let guard = cache.lock().ok()?;
    json_value_to_string(guard.get(key)?)
}

/// Checks whether `hwnd` (or a child/owned window of it) currently holds foreground focus.
pub fn hwnd_owns_foreground(hwnd: HWND) -> bool {
    if hwnd.0.is_null() {
        return false;
    }
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{
            GA_ROOTOWNER, GetAncestor, GetForegroundWindow, IsChild,
        };
        let fg = GetForegroundWindow();
        if fg.is_invalid() {
            return false;
        }
        fg == hwnd || IsChild(hwnd, fg).as_bool() || GetAncestor(fg, GA_ROOTOWNER) == hwnd
    }
}

static FORCE_FG_ALT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct AltKeyGuard {
    released: bool,
    injected: bool,
    alt_seen: bool,
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl AltKeyGuard {
    fn press() -> Self {
        let lock = FORCE_FG_ALT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let already_down = unsafe {
            use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LMENU};
            (GetAsyncKeyState(VK_LMENU.0 as i32) as u16 & 0x8000) != 0
        };
        let mut alt_seen = already_down;
        if !already_down {
            crate::state::SYNTHETIC_ALT_ACTIVE.store(true, std::sync::atomic::Ordering::SeqCst);
            unsafe {
                use windows::Win32::UI::Input::KeyboardAndMouse::{
                    GetAsyncKeyState, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS,
                    KEYBDINPUT, SendInput, VK_LMENU,
                };
                let down = [INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VK_LMENU,
                            wScan: 0,
                            dwFlags: KEYBD_EVENT_FLAGS(0),
                            time: 0,
                            dwExtraInfo: NECTAR_INJECTED_EXTRA_INFO,
                        },
                    },
                }];
                let _ = SendInput(&down, std::mem::size_of::<INPUT>() as i32);
                for _ in 0..10 {
                    if (GetAsyncKeyState(VK_LMENU.0 as i32) as u16 & 0x8000) != 0 {
                        alt_seen = true;
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
            }
        }
        Self {
            released: false,
            injected: !already_down,
            alt_seen,
            _lock: lock,
        }
    }

    fn release(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        if self.injected {
            unsafe {
                use windows::Win32::UI::Input::KeyboardAndMouse::{
                    GetAsyncKeyState, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
                    KEYEVENTF_KEYUP, SendInput, VK_LMENU,
                };
                let up = [INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VK_LMENU,
                            wScan: 0,
                            dwFlags: KEYEVENTF_KEYUP,
                            time: 0,
                            dwExtraInfo: NECTAR_INJECTED_EXTRA_INFO,
                        },
                    },
                }];
                let _ = SendInput(&up, std::mem::size_of::<INPUT>() as i32);
                for _ in 0..8 {
                    if (GetAsyncKeyState(VK_LMENU.0 as i32) as u16 & 0x8000) == 0 {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
            }
            crate::state::SYNTHETIC_ALT_RELEASED_MS
                .store(get_now_ms(), std::sync::atomic::Ordering::Release);
            crate::state::SYNTHETIC_ALT_ACTIVE.store(false, std::sync::atomic::Ordering::SeqCst);
        }
    }
}

impl Drop for AltKeyGuard {
    fn drop(&mut self) {
        self.release();
    }
}

/// Runs `activate` while an RAII guard is held and guarantees release afterward (press -> activate -> release).
#[allow(dead_code)]
fn run_with_guard<G, P: FnOnce() -> G, A: FnOnce() -> bool>(press: P, activate: A) -> bool {
    let _guard = press();
    activate()
}

struct ShellFlyoutInfo {
    is_shell: bool,
    visible: bool,
    cloaked: u32,
}

pub(crate) fn is_native_start_or_search_exe(exe_lowercase: &str) -> bool {
    matches!(
        exe_lowercase,
        "startmenuexperiencehost.exe" | "searchhost.exe" | "searchapp.exe" | "searchui.exe"
    )
}

unsafe fn hwnd_exe_lowercase(hwnd: HWND) -> Option<String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

    if hwnd.is_invalid() {
        return None;
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == 0 {
        return None;
    }
    let Ok(proc_handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
        return None;
    };
    let mut buf = [0u16; 520];
    let mut len = buf.len() as u32;
    let ok = QueryFullProcessImageNameW(
        proc_handle,
        PROCESS_NAME_WIN32,
        windows::core::PWSTR(buf.as_mut_ptr()),
        &mut len,
    );
    let _ = CloseHandle(proc_handle);
    if ok.is_err() {
        return None;
    }
    let path = String::from_utf16_lossy(&buf[..len as usize]);
    Some(path.rsplit(['\\', '/']).next().unwrap_or("").to_ascii_lowercase())
}

unsafe fn window_visibility_and_cloak(hwnd: HWND) -> (bool, u32) {
    use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
    use windows::Win32::UI::WindowsAndMessaging::IsWindowVisible;

    if hwnd.is_invalid() {
        return (false, 0);
    }
    let visible = IsWindowVisible(hwnd).as_bool();
    let mut cloaked = 0u32;
    let _ = DwmGetWindowAttribute(
        hwnd,
        DWMWA_CLOAKED,
        &mut cloaked as *mut _ as *mut _,
        std::mem::size_of::<u32>() as u32,
    );
    (visible, cloaked)
}

unsafe fn classify_shell_flyout(fg: HWND) -> ShellFlyoutInfo {
    let (visible, cloaked) = window_visibility_and_cloak(fg);
    let Some(exe) = hwnd_exe_lowercase(fg) else {
        return ShellFlyoutInfo {
            is_shell: false,
            visible,
            cloaked,
        };
    };
    let is_shell = is_native_start_or_search_exe(&exe)
        || matches!(
            exe.as_str(),
            "shellexperiencehost.exe"
                | "shellhost.exe"
                | "widgetboard.exe"
                | "screenclippinghost.exe"
        );
    ShellFlyoutInfo {
        is_shell,
        visible,
        cloaked,
    }
}

/// True if `hwnd` belongs to the native Windows Start or Search flyout host.
pub(crate) fn is_native_start_or_search_hwnd(hwnd: HWND) -> bool {
    unsafe {
        hwnd_exe_lowercase(hwnd).is_some_and(|exe| is_native_start_or_search_exe(&exe))
    }
}

/// True if `hwnd` belongs to a Windows shell Start/Search/flyout host (StartMenuExperienceHost, SearchHost, etc.).
pub(crate) fn is_shell_flyout_hwnd(hwnd: HWND) -> bool {
    unsafe { classify_shell_flyout(hwnd).is_shell }
}

unsafe fn visible_native_start_hwnds() -> Vec<HWND> {
    use windows::Win32::Foundation::LPARAM;
    use windows::Win32::UI::WindowsAndMessaging::EnumWindows;
    use windows::core::BOOL;

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let list = &mut *(lparam.0 as *mut Vec<HWND>);
        let (visible, cloaked) = window_visibility_and_cloak(hwnd);
        if visible && cloaked == 0 && is_native_start_or_search_hwnd(hwnd) {
            list.push(hwnd);
        }
        BOOL(1)
    }

    let mut out: Vec<HWND> = Vec::new();
    let _ = EnumWindows(Some(enum_proc), LPARAM(&mut out as *mut Vec<HWND> as isize));
    out
}

/// True when any native Windows Start or Search top-level flyout is visibly uncloaked.
pub fn has_visible_native_start_window() -> bool {
    unsafe { !visible_native_start_hwnds().is_empty() }
}

fn should_keep_waiting_for_flyout_dismiss(
    fg_same: bool,
    cloaked: u32,
    post_cloak_polls: u32,
) -> bool {
    if !fg_same {
        return false;
    }
    if cloaked == 0 {
        return true;
    }
    post_cloak_polls < 6
}

/// Dismiss a visible Windows native Start/Search flyout so Nectar's Start menu can claim foreground.
pub fn dismiss_visible_shell_flyout() {
    unsafe {
        use windows::Win32::Foundation::{LPARAM, WPARAM};
        use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
        use windows::Win32::UI::WindowsAndMessaging::{
            GetForegroundWindow, PostMessageW, WA_INACTIVE, WM_ACTIVATE, WM_CANCELMODE,
        };

        let fg_now = GetForegroundWindow();
        let info = classify_shell_flyout(fg_now);
        if info.is_shell && info.visible && info.cloaked == 0 {
            let _ = PostMessageW(Some(fg_now), WM_CANCELMODE, WPARAM(0), LPARAM(0));
            send_injected_escape();
            let mut post_cloak_polls = 0u32;
            for _ in 0..30 {
                let fg_after = GetForegroundWindow();
                let mut cloaked = 0u32;
                if fg_after == fg_now {
                    let _ = DwmGetWindowAttribute(
                        fg_now,
                        DWMWA_CLOAKED,
                        &mut cloaked as *mut _ as *mut _,
                        std::mem::size_of::<u32>() as u32,
                    );
                }
                if !should_keep_waiting_for_flyout_dismiss(
                    fg_after == fg_now,
                    cloaked,
                    post_cloak_polls,
                ) {
                    break;
                }
                if cloaked != 0 {
                    post_cloak_polls += 1;
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }

        for hwnd in visible_native_start_hwnds() {
            let _ = PostMessageW(Some(hwnd), WM_CANCELMODE, WPARAM(0), LPARAM(0));
            let _ = PostMessageW(Some(hwnd), WM_ACTIVATE, WPARAM(WA_INACTIVE as usize), LPARAM(0));
        }
    }
}

fn should_execute_uia_set_focus(
    still_valid: bool,
    window_visible: bool,
    fg_is_null_or_shell: bool,
) -> bool {
    still_valid && window_visible && fg_is_null_or_shell
}

/// Fallback activation via UI Automation when an AppContainer CoreWindow shell flyout blocks SetForegroundWindow.
/// Must run on a clean dedicated background thread (never on the UI/main thread) to avoid STA reentrancy deadlocks.
pub(crate) fn uia_focus_hwnd(hwnd_raw: isize, still_valid: impl Fn() -> bool) -> bool {
    use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation};
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, IsWindow, IsWindowVisible};

    let hwnd = HWND(hwnd_raw as *mut _);
    unsafe {
        if hwnd.0.is_null() {
            return false;
        }
        let is_eligible = || {
            let valid = still_valid();
            let vis = IsWindow(Some(hwnd)).as_bool() && IsWindowVisible(hwnd).as_bool();
            let fg = GetForegroundWindow();
            let fg_null_or_shell = fg.is_invalid() || classify_shell_flyout(fg).is_shell;
            should_execute_uia_set_focus(valid, vis, fg_null_or_shell)
        };
        if hwnd_owns_foreground(hwnd) {
            return still_valid();
        }
        if !is_eligible() {
            return false;
        }
        let _com = ComApartmentGuard::init_mta();
        if !_com.initialized {
            return false;
        }
        let Ok(auto) = CoCreateInstance::<_, IUIAutomation>(
            &CUIAutomation,
            None,
            CLSCTX_INPROC_SERVER,
        ) else {
            return false;
        };
        let Ok(elem) = auto.ElementFromHandle(hwnd) else {
            return false;
        };
        if hwnd_owns_foreground(hwnd) {
            return still_valid();
        }
        if !is_eligible() {
            return false;
        }
        let _ = elem.SetFocus();
        hwnd_owns_foreground(hwnd)
    }
}

unsafe fn send_injected_escape() {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP,
        SendInput, VK_ESCAPE,
    };
    let inputs = [
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_ESCAPE,
                    wScan: 0,
                    dwFlags: KEYBD_EVENT_FLAGS(0),
                    time: 0,
                    dwExtraInfo: NECTAR_INJECTED_EXTRA_INFO,
                },
            },
        },
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_ESCAPE,
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: NECTAR_INJECTED_EXTRA_INFO,
                },
            },
        },
    ];
    let _ = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
}

/// Reliably bring `hwnd` to foreground across Win32 focus lock rules without blocking the UI thread.
pub fn force_foreground(hwnd: HWND) -> bool {
    unsafe {
        use windows::Win32::Foundation::{LPARAM, WPARAM};
        use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
        use windows::Win32::UI::Input::KeyboardAndMouse::SetActiveWindow;
        use windows::Win32::UI::WindowsAndMessaging::{
            ASFW_ANY, AllowSetForegroundWindow, BringWindowToTop, GWL_EXSTYLE, GetClassNameA,
            GetForegroundWindow, GetShellWindow, GetWindowLongW, GetWindowThreadProcessId,
            HWND_TOP, HWND_TOPMOST, IsWindow, IsWindowVisible, PostMessageW,
            SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SetForegroundWindow, SetWindowPos,
            SwitchToThisWindow, WM_CANCELMODE, WS_EX_TOPMOST,
        };

        if hwnd.0.is_null() || !IsWindow(Some(hwnd)).as_bool() {
            return false;
        }
        if hwnd_owns_foreground(hwnd) {
            return true;
        }
        let _ = AllowSetForegroundWindow(ASFW_ANY);

        let mut last_attach_fg = false;
        let mut last_alt_seen = false;

        let mut try_activate = || -> bool {
            let _ = AllowSetForegroundWindow(ASFW_ANY);
            let cur = GetCurrentThreadId();
            let fg = GetForegroundWindow();
            let fg_tid = if is_hwnd_responsive_for_attach(fg) {
                GetWindowThreadProcessId(fg, None)
            } else {
                0
            };
            let raw_target_tid = GetWindowThreadProcessId(hwnd, None);
            let target_tid = if raw_target_tid != 0 && (raw_target_tid == cur || is_hwnd_responsive_for_attach(hwnd)) {
                raw_target_tid
            } else {
                0
            };

            let attach_fg =
                fg_tid != 0 && fg_tid != cur && AttachThreadInput(cur, fg_tid, true).as_bool();
            last_attach_fg = attach_fg;

            // SearchHost/CoreWindow in an AppContainer frequently denies AttachThreadInput; attach to Explorer's shell thread as fallback.
            let shell_wnd = GetShellWindow();
            let shell_tid = if !attach_fg && is_hwnd_responsive_for_attach(shell_wnd) {
                GetWindowThreadProcessId(shell_wnd, None)
            } else {
                0
            };
            let attach_shell = shell_tid != 0
                && shell_tid != cur
                && shell_tid != fg_tid
                && AttachThreadInput(cur, shell_tid, true).as_bool();

            let attach_target = target_tid != 0
                && target_tid != cur
                && target_tid != fg_tid
                && target_tid != shell_tid
                && AttachThreadInput(cur, target_tid, true).as_bool();

            let z_after = if (GetWindowLongW(hwnd, GWL_EXSTYLE) & WS_EX_TOPMOST.0 as i32) != 0 {
                HWND_TOPMOST
            } else {
                HWND_TOP
            };
            let _ = SetWindowPos(
                hwnd,
                Some(z_after),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
            );
            let _ = BringWindowToTop(hwnd);
            let _ = SetForegroundWindow(hwnd);
            let _ = SetActiveWindow(hwnd);

            if attach_target {
                let _ = AttachThreadInput(cur, target_tid, false);
            }
            if attach_shell {
                let _ = AttachThreadInput(cur, shell_tid, false);
            }
            if attach_fg {
                let _ = AttachThreadInput(cur, fg_tid, false);
            }
            hwnd_owns_foreground(hwnd)
        };

        if try_activate() {
            return true;
        }

        // Send a non-blocking cancel message if a native shell flyout is still visible (blocking dismiss runs off-thread in show_surface_async).
        let fg_now = GetForegroundWindow();
        let flyout = classify_shell_flyout(fg_now);
        if flyout.is_shell && flyout.visible && flyout.cloaked == 0 {
            let _ = PostMessageW(Some(fg_now), WM_CANCELMODE, WPARAM(0), LPARAM(0));
            if try_activate() {
                return true;
            }
        }

        // Hold Alt across SetForegroundWindow (releasing beforehand loses the unlock).
        {
            let guard = AltKeyGuard::press();
            last_alt_seen = last_alt_seen || guard.alt_seen;
            if try_activate() {
                return true;
            }
            // If an AppContainer shell host (e.g. cloaked SearchHost.exe CoreWindow) still owns foreground, cancel its mode and force activation.
            let fg_mid = GetForegroundWindow();
            if classify_shell_flyout(fg_mid).is_shell {
                let _ = PostMessageW(Some(fg_mid), WM_CANCELMODE, WPARAM(0), LPARAM(0));
                SwitchToThisWindow(hwnd, true);
                SwitchToThisWindow(hwnd, false);
                if try_activate() {
                    return true;
                }
            }
        }

        SwitchToThisWindow(hwnd, true);
        let _ = BringWindowToTop(hwnd);
        let _ = SetForegroundWindow(hwnd);

        if hwnd_owns_foreground(hwnd) {
            return true;
        }

        let fg = GetForegroundWindow();
        let mut fg_pid = 0u32;
        let fg_cls = if fg.is_invalid() {
            "none".to_string()
        } else {
            GetWindowThreadProcessId(fg, Some(&mut fg_pid));
            let mut buf = [0u8; 64];
            let len = GetClassNameA(fg, &mut buf).max(0) as usize;
            String::from_utf8_lossy(&buf[..len]).into_owned()
        };
        let fg_info = classify_shell_flyout(fg);
        let visible = IsWindowVisible(hwnd).as_bool();
        crate::diagnostics::log(&format!(
            "focus: force_foreground failed for hwnd={:?} visible={} fg={:?} fg_class={} fg_pid={} fg_vis={} fg_cloaked={} attach_fg={} alt_seen={}",
            hwnd.0,
            visible,
            fg.0,
            fg_cls,
            fg_pid,
            fg_info.visible,
            fg_info.cloaked,
            last_attach_fg,
            last_alt_seen
        ));
        false
    }
}

/// Prevent non-focusable chrome windows from activating on mouse click even when WebView2 handles input.
pub fn install_noactivate_subclass(hwnd: HWND) {
    if hwnd.0.is_null() {
        return;
    }
    unsafe {
        use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
        use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
        use windows::Win32::UI::WindowsAndMessaging::{IsWindow, MA_NOACTIVATE, WM_MOUSEACTIVATE, WM_NCDESTROY};

        const NOACTIVATE_SUBCLASS_ID: usize = 0x4E41_4354;

        unsafe extern "system" fn noactivate_proc(
            hwnd: HWND,
            msg: u32,
            wparam: WPARAM,
            lparam: LPARAM,
            id: usize,
            _data: usize,
        ) -> LRESULT {
            if msg == WM_MOUSEACTIVATE {
                let allow_focus = !hwnd.0.is_null()
                    && crate::state::KEYBOARD_FOCUS_HWND.load(std::sync::atomic::Ordering::Relaxed)
                        == hwnd.0 as isize;
                if !allow_focus {
                    return LRESULT(MA_NOACTIVATE as isize);
                }
            } else if msg == WM_NCDESTROY {
                let _ = RemoveWindowSubclass(hwnd, Some(noactivate_proc), id);
            }
            DefSubclassProc(hwnd, msg, wparam, lparam)
        }

        if IsWindow(Some(hwnd)).as_bool() {
            let _ = SetWindowSubclass(hwnd, Some(noactivate_proc), NOACTIVATE_SUBCLASS_ID, 0);
        }
    }
}

/// Re-assert HWND_TOPMOST without activating the window, checking per-HWND keyboard focus.
pub fn re_assert_topmost(hwnd: HWND) {
    let keep_focusable = !hwnd.0.is_null()
        && crate::state::KEYBOARD_FOCUS_HWND.load(std::sync::atomic::Ordering::Relaxed) == hwnd.0 as isize;
    re_assert_topmost_with_focus(hwnd, keep_focusable);
}

/// Re-assert HWND_TOPMOST with explicit focusability control.
pub fn re_assert_topmost_with_focus(hwnd: HWND, keep_focusable: bool) {
    if hwnd.0.is_null() {
        return;
    }
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, GetWindowLongPtrW, SetWindowLongPtrW,
            HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE, SWP_NOACTIVATE, SWP_NOSENDCHANGING,
            GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
        };
        // Set topmost without activating or notifying the window
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOSENDCHANGING,
        );
        // Re-stamp NOACTIVATE + TOOLWINDOW — HWND_TOPMOST can cause these to be reset
        // by the shell on some Windows builds
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as usize;
        let new_ex = if keep_focusable {
            (ex & !(WS_EX_NOACTIVATE.0 as usize)) | WS_EX_TOOLWINDOW.0 as usize
        } else {
            ex | WS_EX_NOACTIVATE.0 as usize | WS_EX_TOOLWINDOW.0 as usize
        };
        if new_ex != ex {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_ex as isize);
        }
    }
}

fn mostly_painted(pixels: &[u8]) -> bool {
    pixels.chunks_exact(4).step_by(7).filter(|c| c[0] != 0 || c[1] != 0 || c[2] != 0).count() * 50 > pixels.len() / 28
}

fn encode_thumbnail(pixels: Vec<u8>, width: u32, height: u32, max_width: u32, max_height: u32) -> Option<String> {
    if width == 0 || height == 0 || max_width == 0 || max_height == 0 {
        return None;
    }
    let expected = (width as usize).checked_mul(height as usize)?.checked_mul(4)?;
    if pixels.len() < expected {
        return None;
    }
    let mut rgb = Vec::with_capacity((width as usize) * (height as usize) * 3);
    for chunk in pixels[..expected].chunks_exact(4) {
        rgb.push(chunk[2]);
        rgb.push(chunk[1]);
        rgb.push(chunk[0]);
    }
    let mut img = image::RgbImage::from_raw(width, height, rgb)?;
    if img.width() > max_width || img.height() > max_height {
        let dyn_img = image::DynamicImage::ImageRgb8(img);
        img = dyn_img
            .resize(max_width, max_height, image::imageops::FilterType::Triangle)
            .into_rgb8();
    }
    let mut out = Vec::with_capacity(8192);
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 82);
    img.write_with_encoder(encoder).ok()?;
    use base64::Engine;
    Some(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(out)
    ))
}

/// Captures an HWND to a base64-encoded PNG thumbnail, scaling it down if it exceeds max_width x max_height.
pub fn capture_hwnd_to_base64(hwnd: HWND, max_width: u32, max_height: u32) -> Option<String> {
    unsafe {
        use windows::Win32::Foundation::RECT;
        use windows::Win32::Graphics::Gdi::{
            CreateCompatibleDC, CreateCompatibleBitmap, SelectObject, DeleteObject, DeleteDC,
            GetDC, ReleaseDC, GetDIBits, BitBlt, SRCCOPY, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HDC,
        };
        use windows::Win32::UI::WindowsAndMessaging::{GetWindowPlacement, WINDOWPLACEMENT, IsWindow};
        use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
        #[link(name = "user32")]
        extern "system" { pub fn PrintWindow(hwnd: HWND, hdcBlt: HDC, nFlags: u32) -> i32; }

        if !IsWindow(Some(hwnd)).as_bool() { return None; }

        if let Some((pixels, w, h)) = crate::capture::capture_window_bgra(hwnd) {
            if mostly_painted(&pixels) {
                if let Some(png) = encode_thumbnail(pixels, w, h, max_width, max_height) {
                    return Some(png);
                }
            }
        }

        let mut rect = RECT::default();
        let _ = DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &mut rect as *mut _ as *mut _, std::mem::size_of::<RECT>() as u32);
        if rect.right == 0 && rect.bottom == 0 && windows::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd, &mut rect).is_err() { return None; }
        let mut width = rect.right - rect.left;
        let mut height = rect.bottom - rect.top;
        if width <= 10 || height <= 10 {
            let mut wp = WINDOWPLACEMENT { length: std::mem::size_of::<WINDOWPLACEMENT>() as u32, ..Default::default() };
            if GetWindowPlacement(hwnd, &mut wp).is_ok() {
                width = wp.rcNormalPosition.right - wp.rcNormalPosition.left;
                height = wp.rcNormalPosition.bottom - wp.rcNormalPosition.top;
            }
        }
        if width <= 100 || height <= 100 || width > 7680 || height > 4320 { return None; }

        let hdc_screen = GetDC(None);
        let hdc_mem = CreateCompatibleDC(Some(hdc_screen));
        let hbm_mem = CreateCompatibleBitmap(hdc_screen, width, height);
        let h_old = SelectObject(hdc_mem, hbm_mem.into());
        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [windows::Win32::Graphics::Gdi::RGBQUAD::default(); 1],
        };
        let mut pixels = vec![0u8; (width * height * 4) as usize];
        let mut read_bits = |pixels: &mut Vec<u8>| {
            GetDIBits(hdc_mem, hbm_mem, 0, height as u32, Some(pixels.as_mut_ptr() as *mut _), &mut bmi, DIB_RGB_COLORS) != 0
                && pixels.chunks_exact(4).step_by(7).filter(|c| c[0] != 0 || c[1] != 0 || c[2] != 0).count() * 50 > pixels.len() / 28
        };

        let mut captured = PrintWindow(hwnd, hdc_mem, 2) != 0 && read_bits(&mut pixels);
        // PrintWindow fails on elevated and GPU-composited windows, so copy from the screen.
        if !captured {
            let center = windows::Win32::Foundation::POINT { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
            let top = windows::Win32::UI::WindowsAndMessaging::WindowFromPoint(center);
            let on_top = windows::Win32::UI::WindowsAndMessaging::GetAncestor(top, windows::Win32::UI::WindowsAndMessaging::GA_ROOT) == hwnd;
            if on_top && BitBlt(hdc_mem, 0, 0, width, height, Some(hdc_screen), rect.left, rect.top, SRCCOPY).is_ok() {
                captured = read_bits(&mut pixels);
            }
        }

        let mut result = None;
        if captured {
            if let Ok(encoded) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                encode_thumbnail(pixels, width as u32, height as u32, max_width, max_height)
            })) {
                result = encoded;
            }
        }
        SelectObject(hdc_mem, h_old);
        let _ = DeleteObject(hbm_mem.into());
        let _ = DeleteDC(hdc_mem);
        ReleaseDC(None, hdc_screen);

        result
    }
}

/// Icon file a shortcut declares for itself (Firefox web apps, customized shortcuts).
/// Only real image files, icon references into exes/DLLs are ignored.
pub fn get_shortcut_icon_location(path: &str) -> Option<String> {
    unsafe {
        let shell_link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_ALL).ok()?;
        let persist_file: IPersistFile = shell_link.cast().ok()?;
        let wide_path: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        persist_file.Load(windows::core::PCWSTR(wide_path.as_ptr()), windows::Win32::System::Com::STGM(0)).ok()?;

        let mut buffer = [0u16; 512];
        let mut index = 0i32;
        shell_link.GetIconLocation(&mut buffer, &mut index).ok()?;

        let raw = String::from_utf16_lossy(&buffer).trim_matches(char::from(0)).trim().to_string();
        if raw.is_empty() { return None; }

        let location = expand_env_vars(&raw);
        let lower = location.to_lowercase();
        if lower.contains("\\tinted-icons\\") || lower.contains("/tinted-icons/") {
            return None;
        }
        let ext = std::path::Path::new(&location).extension()?.to_str()?.to_lowercase();
        if !matches!(ext.as_str(), "ico" | "png" | "jpg" | "jpeg" | "bmp" | "webp" | "gif") { return None; }
        if !std::path::Path::new(&location).exists() { return None; }
        Some(location)
    }
}

/// Expands %VAR% from the process environment.
fn expand_env_vars(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find('%') {
        result.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        if let Some(end) = after.find('%') {
            let name = &after[..end];
            if !name.is_empty() && !name.contains(' ') {
                match std::env::var(name) {
                    Ok(value) => result.push_str(&value),
                    Err(_) => {
                        result.push('%');
                        result.push_str(name);
                        result.push('%');
                    }
                }
            } else {
                result.push('%');
                result.push_str(name);
                result.push('%');
            }
            rest = &after[end + 1..];
        } else {
            result.push_str(&rest[start..]);
            rest = "";
            break;
        }
    }
    result.push_str(rest);
    result
}

/// Reads an image file and returns it as a base64 PNG data URI.
pub fn image_file_to_base64(path: &str) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() > 8 * 1024 * 1024 { return None; }

    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        use base64::Engine;
        return Some(format!("data:image/png;base64,{}", general_purpose::STANDARD.encode(&bytes)));
    }

    let img = image::load_from_memory(&bytes).ok()?;
    let mut png: Vec<u8> = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).ok()?;
    use base64::Engine;
    Some(format!("data:image/png;base64,{}", general_purpose::STANDARD.encode(&png)))
}

/// True for real fullscreen: client area covers the monitor (or D3D fullscreen) and it isn't maximized.
pub fn is_window_fullscreen(hwnd: HWND) -> bool {
    unsafe {
        use windows::Win32::Foundation::{POINT, RECT};
        use windows::Win32::Graphics::Gdi::{ClientToScreen, GetMonitorInfoA, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
        use windows::Win32::UI::Shell::{QUNS_RUNNING_D3D_FULL_SCREEN, SHQueryUserNotificationState};
        use windows::Win32::UI::WindowsAndMessaging::{GetClientRect, GetForegroundWindow, GetWindowLongW, IsZoomed, GWL_STYLE, WS_MAXIMIZE};

        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        if monitor.is_invalid() { return false; }
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoA(monitor, &mut info).as_bool() { return false; }
        let screen = info.rcMonitor;

        let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;
        if IsZoomed(hwnd).as_bool() || (style & WS_MAXIMIZE.0) != 0 {
            return false;
        }

        let mut client = RECT::default();
        if GetClientRect(hwnd, &mut client).is_err() { return false; }
        let mut top_left = POINT { x: client.left, y: client.top };
        let mut bottom_right = POINT { x: client.right, y: client.bottom };
        let _ = ClientToScreen(hwnd, &mut top_left);
        let _ = ClientToScreen(hwnd, &mut bottom_right);

        let client_fullscreen = top_left.x <= screen.left && top_left.y <= screen.top
            && bottom_right.x >= screen.right && bottom_right.y >= screen.bottom;
        if client_fullscreen {
            return true;
        }

        hwnd == GetForegroundWindow()
            && SHQueryUserNotificationState().is_ok_and(|s| s == QUNS_RUNNING_D3D_FULL_SCREEN)
    }
}

pub fn resolve_executable_path(name: &str) -> Option<String> {
    let trimmed = name.trim().trim_matches('"');
    if trimmed.is_empty() || trimmed.contains('\\') || trimmed.contains('/') { return None; }

    let file = if trimmed.to_lowercase().ends_with(".exe") {
        trimmed.to_string()
    } else {
        format!("{}.exe", trimmed)
    };

    if let Some(path) = app_paths_lookup(&file) {
        if std::path::Path::new(&path).exists() { return Some(path); }
    }
    if let Some(path) = search_system_path(&file) {
        return Some(path);
    }
    known_install_location(&file)
}

/// App Paths registry lookup (HKCU, then HKLM).
fn app_paths_lookup(file: &str) -> Option<String> {
    use windows::Win32::System::Registry::{HKEY, RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};

    unsafe {
        let subkey: Vec<u16> = format!("Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{}", file)
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();

        for root in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
            let mut key = HKEY::default();
            if RegOpenKeyExW(root, windows::core::PCWSTR(subkey.as_ptr()), None, KEY_READ, &mut key).0 != 0 { continue; }

            let mut buffer = [0u16; 1024];
            let mut size = (buffer.len() * 2) as u32;
            let status = RegQueryValueExW(
                key,
                windows::core::PCWSTR::null(),
                None,
                None,
                Some(buffer.as_mut_ptr() as *mut u8),
                Some(&mut size),
            );
            let _ = RegCloseKey(key);
            if status.0 != 0 { continue; }

            let value = String::from_utf16_lossy(&buffer[..(size as usize / 2).min(buffer.len())]);
            let value = value.trim_matches(char::from(0)).trim().trim_matches('"').to_string();
            if !value.is_empty() { return Some(value); }
        }
        None
    }
}

/// PATH, System32, Windows.
fn search_system_path(file: &str) -> Option<String> {
    use windows::Win32::Storage::FileSystem::SearchPathW;

    unsafe {
        let wide: Vec<u16> = file.encode_utf16().chain(std::iter::once(0)).collect();
        let mut buffer = vec![0u16; 32768];
        let len = SearchPathW(None, windows::core::PCWSTR(wide.as_ptr()), windows::core::PCWSTR::null(), Some(&mut buffer), None);
        if len == 0 || len as usize >= buffer.len() { return None; }

        let path = String::from_utf16_lossy(&buffer[..len as usize]);
        if std::path::Path::new(&path).exists() { Some(path) } else { None }
    }
}

/// Last resort for apps not in App Paths or PATH.
fn known_install_location(file: &str) -> Option<String> {
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let home = std::env::var("USERPROFILE").unwrap_or_default();

    let candidates: Vec<String> = match file.to_lowercase().as_str() {
        "code.exe" | "code-insiders.exe" => vec![
            format!("{}\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe", home),
            format!("{}\\Programs\\Microsoft VS Code\\Code.exe", local),
            "C:\\Program Files\\Microsoft VS Code\\Code.exe".into(),
            "C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe".into(),
        ],
        "msedge.exe" => vec![
            "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe".into(),
            "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe".into(),
            format!("{}\\Microsoft\\Edge\\Application\\msedge.exe", local),
        ],
        "notepad.exe" => vec![
            "C:\\Windows\\System32\\notepad.exe".into(),
            "C:\\Windows\\notepad.exe".into(),
        ],
        "explorer.exe" => vec!["C:\\Windows\\explorer.exe".into()],
        _ => Vec::new(),
    };

    candidates.into_iter().find(|c| std::path::Path::new(c).exists())
}

/// The window's AppUserModelID, same identity the taskbar groups by
/// (package id for Store apps, web app id for browser web apps).
pub fn get_window_app_user_model_id(hwnd: HWND) -> Option<String> {
    unsafe {
        use windows::Win32::Foundation::PROPERTYKEY;
        use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PropVariantToStringAlloc};
        use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, SHGetPropertyStoreForWindow};

        const PKEY_APP_USER_MODEL_ID: PROPERTYKEY = PROPERTYKEY {
            fmtid: windows::core::GUID {
                data1: 0x9F4C2855,
                data2: 0x9F79,
                data3: 0x4B39,
                data4: [0xA8, 0xD0, 0xE1, 0xD4, 0x2D, 0xE1, 0xD5, 0xF3],
            },
            pid: 5,
        };

        let store: IPropertyStore = SHGetPropertyStoreForWindow(hwnd).ok()?;
        let mut prop = store.GetValue(&PKEY_APP_USER_MODEL_ID).ok()?;
        let result = PropVariantToStringAlloc(&prop).ok().map(|pwstr| {
            let s = String::from_utf16_lossy(pwstr.as_wide()).trim().to_string();
            windows::Win32::System::Com::CoTaskMemFree(Some(pwstr.0 as *const _));
            s
        });
        let _ = PropVariantClear(&mut prop);
        result.filter(|s| !s.is_empty())
    }
}

/// HBITMAP to straight-alpha RGBA image.
pub(crate) unsafe fn hbitmap_to_rgba(hbitmap: windows::Win32::Graphics::Gdi::HBITMAP) -> Option<image::RgbaImage> {
    let factory: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).ok()?;
    let bitmap = factory.CreateBitmapFromHBITMAP(hbitmap, windows::Win32::Graphics::Gdi::HPALETTE::default(), windows::Win32::Graphics::Imaging::WICBitmapUsePremultipliedAlpha).ok()?;
    wic_source_to_rgba(&factory, &bitmap.cast().ok()?, true)
}

/// HBITMAP to base64 PNG.
pub unsafe fn hbitmap_to_base64(hbitmap: windows::Win32::Graphics::Gdi::HBITMAP) -> Option<String> {
    let factory: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).ok()?;
    let bitmap = factory.CreateBitmapFromHBITMAP(hbitmap, windows::Win32::Graphics::Gdi::HPALETTE::default(), windows::Win32::Graphics::Imaging::WICBitmapUsePremultipliedAlpha).ok()?;
    wic_bitmap_to_base64(&factory, &bitmap)
}

unsafe fn wic_bitmap_to_base64(factory: &IWICImagingFactory, bitmap: &windows::Win32::Graphics::Imaging::IWICBitmapSource) -> Option<String> {
    let stream = CreateStreamOnHGlobal(HGLOBAL(std::ptr::null_mut()), true).ok()?;
    let encoder = factory.CreateEncoder(&GUID_ContainerFormatPng, std::ptr::null()).ok()?;
    encoder.Initialize(&stream, WICBitmapEncoderNoCache).ok()?;
    
    let mut frame = None;
    encoder.CreateNewFrame(&mut frame, std::ptr::null_mut()).ok()?;
    let frame = frame?;
    frame.Initialize(None).ok()?;
    
    let (mut width, mut height) = (0u32, 0u32);
    bitmap.GetSize(&mut width, &mut height).ok()?;
    frame.SetSize(width, height).ok()?;
    
    let mut format = GUID_WICPixelFormat32bppPBGRA;
    frame.SetPixelFormat(&mut format).ok()?;
    
    frame.WriteSource(bitmap, std::ptr::null()).ok()?;
    frame.Commit().ok()?;
    encoder.Commit().ok()?;
    
    let hglobal = GetHGlobalFromStream(&stream).ok()?;
    let ptr = windows::Win32::System::Memory::GlobalLock(hglobal);
    let size = windows::Win32::System::Memory::GlobalSize(hglobal);
    if ptr.is_null() || size == 0 {
        if !ptr.is_null() {
            let _ = windows::Win32::System::Memory::GlobalUnlock(hglobal);
        }
        return None;
    }

    let data = std::slice::from_raw_parts(ptr as *const u8, size);
    let base64_str = general_purpose::STANDARD.encode(data);

    let _ = windows::Win32::System::Memory::GlobalUnlock(hglobal);

    Some(format!("data:image/png;base64,{}", base64_str))
}

#[cfg(test)]
mod tests {
    use super::expand_env_vars;

    #[test]
    fn env_expansion() {
        let out = expand_env_vars("%SystemRoot%\\System32");
        assert!(out.to_lowercase().ends_with("\\system32"), "got {out}");
        assert!(!out.contains('%'), "got {out}");

        // Unknown variables stay verbatim
        assert_eq!(expand_env_vars("%NECTAR_NOT_A_REAL_VAR%\\x"), "%NECTAR_NOT_A_REAL_VAR%\\x");

        // Unclosed percent is left alone
        assert_eq!(expand_env_vars("50% done"), "50% done");

        // Plain paths are untouched
        assert_eq!(expand_env_vars("C:\\plain\\path"), "C:\\plain\\path");
    }

    #[test]
    fn each_secondary_taskbar_keeps_its_own_monitor() {
        use super::taskbar_monitor;
        use windows::Win32::Foundation::RECT;

        let rect = |left, right, top, bottom| RECT { left, top, right, bottom };
        let primary = rect(0, 1920, 0, 1080);
        let left = rect(-1920, 0, 0, 1080);
        let right = rect(1920, 3840, 0, 1080);
        let monitors = [(primary, true), (left, false), (right, false)];

        let on_right = rect(1920, 3840, 1032, 1080);
        assert_eq!(taskbar_monitor(&monitors, false, &on_right), Some(right));
        let on_left = rect(-1920, 0, 1032, 1080);
        assert_eq!(taskbar_monitor(&monitors, false, &on_left), Some(left));

        let stranded = rect(-10000, -8080, -10000, -9952);
        assert_eq!(taskbar_monitor(&monitors, false, &stranded), Some(left));
        assert_eq!(taskbar_monitor(&monitors, true, &on_right), Some(primary));
    }

    #[test]
    fn bare_executable_resolution() {
        use super::resolve_executable_path;

        for name in ["notepad", "notepad.exe", "msedge"] {
            let path = resolve_executable_path(name).unwrap_or_else(|| panic!("{name} did not resolve"));
            assert!(std::path::Path::new(&path).exists(), "{name} -> {path} does not exist");
            assert!(path.to_lowercase().ends_with(".exe"), "{name} -> {path}");
        }

        // Already-qualified paths and nonsense are not resolved
        assert_eq!(resolve_executable_path("C:\\Windows\\notepad.exe"), None);
        assert_eq!(resolve_executable_path("nectar-definitely-not-installed"), None);
        assert_eq!(resolve_executable_path(""), None);
    }

    #[test]
    fn json_setting_str_converts_bool_and_number() {
        use super::json_value_to_string;
        use serde_json::json;

        assert_eq!(json_value_to_string(&json!("smart")), Some("smart".to_string()));
        assert_eq!(json_value_to_string(&json!(true)), Some("true".to_string()));
        assert_eq!(json_value_to_string(&json!(false)), Some("false".to_string()));
        assert_eq!(json_value_to_string(&json!(1.25)), Some("1.25".to_string()));
        assert_eq!(json_value_to_string(&json!(6)), Some("6".to_string()));
        assert_eq!(json_value_to_string(&json!(null)), None);
    }

    #[test]
    fn alt_guard_holds_across_activation_and_releases_after() {
        use std::cell::RefCell;

        struct TraceGuard<'a>(&'a RefCell<Vec<&'static str>>);
        impl<'a> Drop for TraceGuard<'a> {
            fn drop(&mut self) {
                self.0.borrow_mut().push("release");
            }
        }

        for result in [true, false] {
            let trace = RefCell::new(Vec::new());
            let out = super::run_with_guard(
                || {
                    trace.borrow_mut().push("press");
                    TraceGuard(&trace)
                },
                || {
                    trace.borrow_mut().push("activate");
                    result
                },
            );
            assert_eq!(out, result);
            assert_eq!(*trace.borrow(), vec!["press", "activate", "release"]);
        }
    }

    #[test]
    fn flyout_dismiss_wait_allows_post_cloak_foreground_transfer() {
        use super::should_keep_waiting_for_flyout_dismiss;

        // Once foreground moved off the flyout, stop waiting immediately regardless of cloak state.
        assert!(!should_keep_waiting_for_flyout_dismiss(false, 0, 0));
        assert!(!should_keep_waiting_for_flyout_dismiss(false, 2, 0));

        // Still uncloaked and still foreground: keep waiting.
        assert!(should_keep_waiting_for_flyout_dismiss(true, 0, 0));
        assert!(should_keep_waiting_for_flyout_dismiss(true, 0, 10));

        // Cloaked (e.g. DWM_CLOAKED_SHELL=2) while still foreground: allow bounded post-cloak polls, then stop.
        assert!(should_keep_waiting_for_flyout_dismiss(true, 2, 0));
        assert!(should_keep_waiting_for_flyout_dismiss(true, 2, 5));
        assert!(!should_keep_waiting_for_flyout_dismiss(true, 2, 6));
    }

    #[test]
    fn uia_set_focus_guard_blocks_stale_hidden_or_user_foreground() {
        use super::should_execute_uia_set_focus;

        assert!(should_execute_uia_set_focus(true, true, true));
        assert!(!should_execute_uia_set_focus(false, true, true));
        assert!(!should_execute_uia_set_focus(true, false, true));
        assert!(!should_execute_uia_set_focus(true, true, false));
    }

    #[test]
    fn blocked_attach_exes_rejects_overlays_and_wer() {
        use super::is_blocked_attach_exe;

        assert!(is_blocked_attach_exe("amdow.exe"));
        assert!(is_blocked_attach_exe("AMDOW.EXE"));
        assert!(is_blocked_attach_exe("WerFault.exe"));
        assert!(is_blocked_attach_exe("  rtss.exe  "));
        assert!(is_blocked_attach_exe("GameBar.exe"));
        assert!(!is_blocked_attach_exe("explorer.exe"));
        assert!(!is_blocked_attach_exe("notepad.exe"));
        assert!(!is_blocked_attach_exe(""));
    }

    #[test]
    fn atomic_write_helper_replaces_file_cleanly() {
        use super::write_atomic_bytes;

        let dir = std::env::temp_dir().join(format!("nectar-atomic-test-{}", std::process::id()));
        let target = dir.join("settings.json");
        let _ = std::fs::remove_dir_all(&dir);

        write_atomic_bytes(&target, br#"{"v":1}"#).expect("initial atomic write");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), r#"{"v":1}"#);

        write_atomic_bytes(&target, br#"{"v":2}"#).expect("overwrite atomic write");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), r#"{"v":2}"#);

        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "expected zero leftover temp files");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn native_start_exe_classifier_matches_windows_start_hosts() {
        use super::is_native_start_or_search_exe;

        for exe in [
            "startmenuexperiencehost.exe",
            "searchhost.exe",
            "searchapp.exe",
            "searchui.exe",
        ] {
            assert!(is_native_start_or_search_exe(exe));
        }
        assert!(!is_native_start_or_search_exe("shellexperiencehost.exe"));
        assert!(!is_native_start_or_search_exe("explorer.exe"));
        assert!(!is_native_start_or_search_exe("nectar.exe"));
    }
}
