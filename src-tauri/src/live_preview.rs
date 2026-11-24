use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use serde::{Deserialize, Serialize};
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Dwm::{
    DwmIsCompositionEnabled, DwmRegisterThumbnail,
    DwmUnregisterThumbnail, DwmQueryThumbnailSourceSize, DwmUpdateThumbnailProperties, DWM_THUMBNAIL_PROPERTIES,
    DWM_TNP_OPACITY, DWM_TNP_RECTDESTINATION, DWM_TNP_SOURCECLIENTAREAONLY, DWM_TNP_VISIBLE,
};
use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, IsIconic, IsWindow, GA_ROOT};

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct LiveThumbnailTarget {
    pub hwnd: isize,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug)]
struct ThumbnailRecord {
    handle: isize,
    dest_hwnd: isize,
    rect: RECT,
    client_area_only: bool,
}

static ACTIVE_THUMBNAILS: OnceLock<Mutex<HashMap<isize, ThumbnailRecord>>> = OnceLock::new();

fn get_map() -> &'static Mutex<HashMap<isize, ThumbnailRecord>> {
    ACTIVE_THUMBNAILS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn is_composition_enabled() -> bool {
    unsafe {
        DwmIsCompositionEnabled().map(|b| b.as_bool()).unwrap_or(false)
    }
}

fn fit_rect(handle: isize, dest: RECT) -> RECT {
    let size = unsafe { DwmQueryThumbnailSourceSize(handle) }.unwrap_or_default();
    let (dw, dh) = (dest.right - dest.left, dest.bottom - dest.top);
    if size.cx <= 0 || size.cy <= 0 || dw <= 0 || dh <= 0 {
        return dest;
    }
    let scale = (dw as f64 / size.cx as f64).min(dh as f64 / size.cy as f64);
    let w = ((size.cx as f64 * scale).round() as i32).clamp(1, dw);
    let h = ((size.cy as f64 * scale).round() as i32).clamp(1, dh);
    let left = dest.left + (dw - w) / 2;
    let top = dest.top + (dh - h) / 2;
    RECT { left, top, right: left + w, bottom: top + h }
}

pub fn set_live_thumbnails(
    dest_hwnd_val: isize,
    targets: Vec<LiveThumbnailTarget>,
    client_area_only: bool,
) -> Result<Vec<isize>, String> {
    if !is_composition_enabled() {
        return Err("DWM composition is not enabled".to_string());
    }

    let dest_hwnd = HWND(dest_hwnd_val as *mut _);
    unsafe {
        if !IsWindow(Some(dest_hwnd)).as_bool() {
            return Err("Destination window is invalid".to_string());
        }
    }

    let mut map = get_map().lock().map_err(|e| e.to_string())?;
    let target_hwnds: std::collections::HashSet<isize> = targets.iter().map(|t| t.hwnd).collect();

    let to_remove: Vec<isize> = map
        .iter()
        .filter_map(|(&k, rec)| (rec.dest_hwnd == dest_hwnd_val && !target_hwnds.contains(&k)).then_some(k))
        .collect();

    for src_hwnd_val in to_remove {
        if let Some(record) = map.remove(&src_hwnd_val) {
            unsafe {
                let _ = DwmUnregisterThumbnail(record.handle);
            }
        }
    }

    let mut successfully_active = Vec::new();

    for target in targets {
        let raw_hwnd = HWND(target.hwnd as *mut _);
        let src_hwnd = unsafe {
            if !IsWindow(Some(raw_hwnd)).as_bool() {
                if let Some(record) = map.remove(&target.hwnd) {
                    let _ = DwmUnregisterThumbnail(record.handle);
                }
                continue;
            }
            let root = GetAncestor(raw_hwnd, GA_ROOT);
            if root.0 != std::ptr::null_mut() && IsWindow(Some(root)).as_bool() {
                root
            } else {
                raw_hwnd
            }
        };

        let rc_dest = RECT {
            left: target.x,
            top: target.y,
            right: target.x + target.width.max(1),
            bottom: target.y + target.height.max(1),
        };

        // DWM binds destination HWND immutably on registration: if moving across monitors/docks,
        // unregister and re-register cleanly instead of trying to retarget via UpdateProperties.
        let need_reregister = map
            .get(&target.hwnd)
            .is_some_and(|rec| rec.dest_hwnd != dest_hwnd_val);
        if need_reregister {
            if let Some(old) = map.remove(&target.hwnd) {
                unsafe {
                    let _ = DwmUnregisterThumbnail(old.handle);
                }
            }
        }

        if let Some(existing) = map.get_mut(&target.hwnd) {
            let fitted = fit_rect(existing.handle, rc_dest);
            if existing.rect != fitted || existing.client_area_only != client_area_only {
                let props = DWM_THUMBNAIL_PROPERTIES {
                    dwFlags: DWM_TNP_RECTDESTINATION | DWM_TNP_VISIBLE | DWM_TNP_OPACITY | DWM_TNP_SOURCECLIENTAREAONLY,
                    rcDestination: fitted,
                    rcSource: RECT::default(),
                    opacity: OPACITY.load(std::sync::atomic::Ordering::Relaxed),
                    fVisible: BOOL(1),
                    fSourceClientAreaOnly: if client_area_only { BOOL(1) } else { BOOL(0) },
                };
                if unsafe { DwmUpdateThumbnailProperties(existing.handle, &props) }.is_ok() {
                    existing.rect = fitted;
                    existing.client_area_only = client_area_only;
                    successfully_active.push(target.hwnd);
                } else if let Some(broken) = map.remove(&target.hwnd) {
                    unsafe {
                        let _ = DwmUnregisterThumbnail(broken.handle);
                    }
                }
            } else {
                successfully_active.push(target.hwnd);
            }
        } else {
            unsafe {
                if let Ok(handle) = DwmRegisterThumbnail(dest_hwnd, src_hwnd) {
                    if IsIconic(raw_hwnd).as_bool() {
                        let size = DwmQueryThumbnailSourceSize(handle).unwrap_or_default();
                        if size.cx < 64 || size.cy < 64 {
                            let _ = DwmUnregisterThumbnail(handle);
                            continue;
                        }
                    }
                    let fitted = fit_rect(handle, rc_dest);
                    let props = DWM_THUMBNAIL_PROPERTIES {
                        dwFlags: DWM_TNP_RECTDESTINATION | DWM_TNP_VISIBLE | DWM_TNP_OPACITY | DWM_TNP_SOURCECLIENTAREAONLY,
                        rcDestination: fitted,
                        rcSource: RECT::default(),
                        opacity: OPACITY.load(std::sync::atomic::Ordering::Relaxed),
                        fVisible: BOOL(1),
                        fSourceClientAreaOnly: if client_area_only { BOOL(1) } else { BOOL(0) },
                    };
                    if DwmUpdateThumbnailProperties(handle, &props).is_ok() {
                        map.insert(
                            target.hwnd,
                            ThumbnailRecord {
                                handle,
                                dest_hwnd: dest_hwnd_val,
                                rect: fitted,
                                client_area_only,
                            },
                        );
                        successfully_active.push(target.hwnd);
                    } else {
                        let _ = DwmUnregisterThumbnail(handle);
                    }
                }
            }
        }
    }

    Ok(successfully_active)
}

static OPACITY: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(255);

pub fn set_opacity(opacity: u8) -> Result<(), String> {
    OPACITY.store(opacity, std::sync::atomic::Ordering::Relaxed);
    let map = get_map().lock().map_err(|e| e.to_string())?;
    for record in map.values() {
        let props = DWM_THUMBNAIL_PROPERTIES {
            dwFlags: DWM_TNP_OPACITY,
            opacity,
            ..Default::default()
        };
        unsafe {
            let _ = DwmUpdateThumbnailProperties(record.handle, &props);
        }
    }
    Ok(())
}

pub fn clear_thumbnails_for_dest(dest_hwnd_val: isize) -> Result<(), String> {
    let mut map = get_map().lock().map_err(|e| e.to_string())?;
    let keys: Vec<isize> = map
        .iter()
        .filter_map(|(&k, rec)| (rec.dest_hwnd == dest_hwnd_val).then_some(k))
        .collect();
    for k in keys {
        if let Some(record) = map.remove(&k) {
            unsafe {
                let _ = DwmUnregisterThumbnail(record.handle);
            }
        }
    }
    Ok(())
}

#[allow(dead_code)]
pub fn clear_all_thumbnails() -> Result<(), String> {
    let mut map = get_map().lock().map_err(|e| e.to_string())?;
    for (_, record) in map.drain() {
        unsafe {
            let _ = DwmUnregisterThumbnail(record.handle);
        }
    }
    Ok(())
}
