//! Window lifecycle, monitor positioning, focus isolation, and tray interaction
//! commands for Nectar's three floating shell surfaces:
//! `"launcher"`, `"start-menu"`, and `"tray-bar"`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicIsize, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, Window, WindowEvent,
};
use tokio::sync::Notify;
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MONITORINFO, MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTONULL,
    MonitorFromPoint,
};
use windows::Win32::UI::WindowsAndMessaging::{
    ASFW_ANY, AllowSetForegroundWindow, GWL_EXSTYLE, GetClassNameA, GetCursorPos,
    GetForegroundWindow, GetShellWindow, GetWindowLongPtrW, GetWindowThreadProcessId,
    HWND_TOPMOST, IsIconic, IsWindow, IsWindowVisible, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    SetForegroundWindow, SetWindowLongPtrW, SetWindowPos, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

use crate::state::{
    KEYBOARD_FOCUS_HWND, KEYBOARD_FOCUS_LABEL, SHUTTING_DOWN, START_MENU_VISIBLE,
};
use crate::tray_host::TrayIconDto;
use crate::utils::{
    force_foreground, get_nectar_scale, get_now_ms, get_setting_str, hwnd_owns_foreground,
};

pub const LAUNCHER_LABEL: &str = "launcher";
pub const START_LABEL: &str = "start-menu";
pub const TRAYBAR_LABEL: &str = "tray-bar";

const FOCUS_GRACE_MS: i64 = 250;
const BLUR_DEBOUNCE_MS: i64 = 300;
const COLD_READY_WAIT_MS: u64 = 350;

static LAUNCHER_SHOWN_MS: AtomicI64 = AtomicI64::new(0);
static START_SHOWN_MS: AtomicI64 = AtomicI64::new(0);
static TRAYBAR_SHOWN_MS: AtomicI64 = AtomicI64::new(0);
static PREVIOUS_NON_SHELL_FG: AtomicIsize = AtomicIsize::new(0);
static SURFACE_FOCUS_GEN: AtomicU64 = AtomicU64::new(0);
static LAST_TRAYBAR_ANCHOR: Mutex<Option<(i32, i32)>> = Mutex::new(None);
static PENDING_LAUNCHER_QUERY: Mutex<Option<String>> = Mutex::new(None);
static LAST_SHOWN_PAYLOADS: OnceLock<Mutex<HashMap<String, serde_json::Value>>> = OnceLock::new();
static LAST_BLUR_HIDE_MS: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();

static LAUNCHER_BUSY: AtomicBool = AtomicBool::new(false);
static START_BUSY: AtomicBool = AtomicBool::new(false);
static TRAYBAR_BUSY: AtomicBool = AtomicBool::new(false);
static TRAYBAR_BLUR_LOCKED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn set_traybar_blur_lock(locked: bool) {
    TRAYBAR_BLUR_LOCKED.store(locked, Ordering::SeqCst);
}

static LAUNCHER_REPLAY: AtomicBool = AtomicBool::new(false);
static START_REPLAY: AtomicBool = AtomicBool::new(false);
static TRAYBAR_REPLAY: AtomicBool = AtomicBool::new(false);

static LAUNCHER_READY: AtomicBool = AtomicBool::new(false);
static START_READY: AtomicBool = AtomicBool::new(false);
static TRAYBAR_READY: AtomicBool = AtomicBool::new(false);

static LAUNCHER_RECEIVED_FOCUS: AtomicBool = AtomicBool::new(false);
static START_RECEIVED_FOCUS: AtomicBool = AtomicBool::new(false);
static TRAYBAR_RECEIVED_FOCUS: AtomicBool = AtomicBool::new(false);

static LAUNCHER_READY_NOTIFY: OnceLock<Notify> = OnceLock::new();
static START_READY_NOTIFY: OnceLock<Notify> = OnceLock::new();
static TRAYBAR_READY_NOTIFY: OnceLock<Notify> = OnceLock::new();

fn replay_flag(label: &str) -> Option<&'static AtomicBool> {
    match label {
        LAUNCHER_LABEL => Some(&LAUNCHER_REPLAY),
        START_LABEL => Some(&START_REPLAY),
        TRAYBAR_LABEL => Some(&TRAYBAR_REPLAY),
        _ => None,
    }
}

fn ready_flag(label: &str) -> Option<&'static AtomicBool> {
    match label {
        LAUNCHER_LABEL => Some(&LAUNCHER_READY),
        START_LABEL => Some(&START_READY),
        TRAYBAR_LABEL => Some(&TRAYBAR_READY),
        _ => None,
    }
}

fn ready_notify(label: &str) -> Option<&'static Notify> {
    match label {
        LAUNCHER_LABEL => Some(LAUNCHER_READY_NOTIFY.get_or_init(Notify::new)),
        START_LABEL => Some(START_READY_NOTIFY.get_or_init(Notify::new)),
        TRAYBAR_LABEL => Some(TRAYBAR_READY_NOTIFY.get_or_init(Notify::new)),
        _ => None,
    }
}

fn received_focus_flag(label: &str) -> Option<&'static AtomicBool> {
    match label {
        LAUNCHER_LABEL => Some(&LAUNCHER_RECEIVED_FOCUS),
        START_LABEL => Some(&START_RECEIVED_FOCUS),
        TRAYBAR_LABEL => Some(&TRAYBAR_RECEIVED_FOCUS),
        _ => None,
    }
}

fn last_payloads() -> &'static Mutex<HashMap<String, serde_json::Value>> {
    LAST_SHOWN_PAYLOADS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn blur_hide_map() -> &'static Mutex<HashMap<String, i64>> {
    LAST_BLUR_HIDE_MS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn record_blur_hide(label: &str) {
    if let Ok(mut map) = blur_hide_map().lock() {
        map.insert(label.to_string(), get_now_ms());
    }
}

fn should_debounce_blur_reopen(last_blur_hide_ms: Option<i64>, now_ms: i64) -> bool {
    last_blur_hide_ms.is_some_and(|ts| {
        let elapsed = now_ms - ts;
        (0..BLUR_DEBOUNCE_MS).contains(&elapsed)
    })
}

pub(crate) fn was_surface_blur_hidden_recently(label: &str) -> bool {
    let last = blur_hide_map()
        .lock()
        .ok()
        .and_then(|m| m.get(label).copied());
    should_debounce_blur_reopen(last, get_now_ms())
}

struct BusyReset(&'static AtomicBool);
impl Drop for BusyReset {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn busy_flag(label: &str) -> Option<&'static AtomicBool> {
    match label {
        LAUNCHER_LABEL => Some(&LAUNCHER_BUSY),
        START_LABEL => Some(&START_BUSY),
        TRAYBAR_LABEL => Some(&TRAYBAR_BUSY),
        _ => None,
    }
}

pub fn any_visible_surface_hwnd(app: &AppHandle) -> Option<HWND> {
    for label in [LAUNCHER_LABEL, START_LABEL, TRAYBAR_LABEL] {
        if let Some(win) = app.get_webview_window(label) {
            if win.is_visible().unwrap_or(false) {
                if let Ok(hwnd) = win.hwnd() {
                    return Some(hwnd);
                }
            }
        }
    }
    None
}

struct SurfaceSpec {
    label: &'static str,
    url: &'static str,
    title: &'static str,
    width: f64,
    height: f64,
}

fn spec_for(label: &str) -> Option<SurfaceSpec> {
    match label {
        LAUNCHER_LABEL => Some(SurfaceSpec {
            label: LAUNCHER_LABEL,
            url: "launcher.html",
            title: "Nectar Launcher",
            width: 680.0,
            height: 500.0,
        }),
        START_LABEL => Some(SurfaceSpec {
            label: START_LABEL,
            url: "start.html",
            title: "Nectar Start",
            width: 620.0,
            height: 560.0,
        }),
        TRAYBAR_LABEL => Some(SurfaceSpec {
            label: TRAYBAR_LABEL,
            url: "traybar.html",
            title: "Nectar Tray Bar",
            width: 328.0,
            height: 264.0,
        }),
        _ => None,
    }
}

fn shown_atomic(label: &str) -> Option<&'static AtomicI64> {
    match label {
        LAUNCHER_LABEL => Some(&LAUNCHER_SHOWN_MS),
        START_LABEL => Some(&START_SHOWN_MS),
        TRAYBAR_LABEL => Some(&TRAYBAR_SHOWN_MS),
        _ => None,
    }
}

fn is_launcher_allowed(app: &AppHandle) -> bool {
    let legacy = get_setting_str(app, "nectar-legacy-mode").is_some_and(|v| v == "true");
    let enabled = get_setting_str(app, "nectar-launcher-enabled").is_none_or(|v| v != "false");
    !legacy && enabled
}

fn get_active_monitor_work_area(anchor: Option<(i32, i32)>) -> (i32, i32, i32, i32) {
    unsafe {
        let pt = match anchor {
            Some((x, y)) => POINT { x, y },
            None => {
                let mut cursor = POINT::default();
                let _ = GetCursorPos(&mut cursor);
                cursor
            }
        };
        let hmon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(hmon, &mut info).as_bool() {
            let w = info.rcWork;
            return (w.left, w.top, w.right, w.bottom);
        }
    }
    (0, 0, 1920, 1080)
}

fn clamp_vertical_limits(top: i32, _bottom: i32, top_limit: i32, bottom_limit: i32) -> (i32, i32) {
    let min_top = top + 8;
    let preserved_bottom = bottom_limit.max(min_top + 80);
    if preserved_bottom >= top_limit + 160 {
        (top_limit.max(min_top), preserved_bottom)
    } else {
        // Relax top clearance rather than discarding Dock clearance at the bottom.
        let relaxed_top = (preserved_bottom - 160).max(min_top);
        (relaxed_top, preserved_bottom)
    }
}

fn vertical_limits_on_work_area(
    app: &AppHandle,
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
) -> (i32, i32) {
    let mut top_limit = top + 8;
    let mut bottom_limit = bottom - 8;

    // Reserve top clearance below visible, unhidden Notch on this monitor.
    // Snapshot rect maps and drop Mutex guards before calling win.is_visible()/scale_factor().
    let notch_candidates: Vec<(String, tauri::PhysicalPosition<i32>, tauri::PhysicalSize<u32>, crate::types::IntRect)> = {
        let Ok(win_rects) = crate::state::main_window_rects().lock() else {
            return clamp_vertical_limits(top, bottom, top_limit, bottom_limit);
        };
        let Ok(notch_rects) = crate::state::notch_rects().lock() else {
            return clamp_vertical_limits(top, bottom, top_limit, bottom_limit);
        };
        win_rects
            .iter()
            .filter_map(|(label, &(pos, size))| {
                let cx = pos.x + (size.width as i32) / 2;
                if cx < left - 32
                    || cx > right + 32
                    || pos.y > bottom + 64
                    || (pos.y + size.height as i32) < top
                {
                    return None;
                }
                if crate::state::get_flag(crate::state::notch_hidden(), label) {
                    return None;
                }
                let nr = notch_rects.get(label).copied()?;
                if nr.height <= 0 {
                    return None;
                }
                Some((label.clone(), pos, size, nr))
            })
            .collect()
    };
    for (label, pos, _size, nr) in notch_candidates {
        let Some(win) = app.get_webview_window(&label) else {
            continue;
        };
        if !win.is_visible().unwrap_or(false) {
            continue;
        }
        let scale = win.scale_factor().unwrap_or(1.0);
        let notch_bottom = pos.y + ((nr.y + nr.height) as f64 * scale).round() as i32;
        if notch_bottom >= top && notch_bottom < bottom {
            top_limit = top_limit.max(notch_bottom + 10);
        }
    }

    // Reserve bottom clearance above visible, unhidden Dock pill on this monitor
    let dock_enabled = get_setting_str(app, "nectar-dock-enabled")
        .map(|v| v != "false")
        .unwrap_or(true);
    if dock_enabled {
        let dock_candidates: Vec<(String, tauri::PhysicalPosition<i32>, crate::types::IntRect)> = {
            if let (Ok(win_rects), Ok(pill_rects), Ok(hit_rects)) = (
                crate::state::dock_window_rects().lock(),
                crate::state::dock_pill_rects().lock(),
                crate::state::dock_rects().lock(),
            ) {
                win_rects
                    .iter()
                    .filter_map(|(label, &(pos, size))| {
                        let cx = pos.x + (size.width as i32) / 2;
                        if cx < left - 32
                            || cx > right + 32
                            || pos.y > bottom + 64
                            || (pos.y + size.height as i32) < top
                        {
                            return None;
                        }
                        if crate::state::get_flag(crate::state::dock_hidden(), label) {
                            return None;
                        }
                        let pill = pill_rects.get(label).or_else(|| hit_rects.get(label)).copied()?;
                        if pill.height <= 0 {
                            return None;
                        }
                        Some((label.clone(), pos, pill))
                    })
                    .collect()
            } else {
                Vec::new()
            }
        };
        for (label, pos, pill) in dock_candidates {
            let Some(win) = app.get_webview_window(&label) else {
                continue;
            };
            if !win.is_visible().unwrap_or(false) {
                continue;
            }
            let scale = win.scale_factor().unwrap_or(1.0);
            let pill_top = pos.y + (pill.y as f64 * scale).round() as i32;
            if pill_top > top && pill_top <= bottom + 8 {
                bottom_limit = bottom_limit.min(pill_top - 10);
            }
        }
    }

    clamp_vertical_limits(top, bottom, top_limit, bottom_limit)
}

fn position_surface(
    app: &AppHandle,
    win: &WebviewWindow,
    label: &str,
    anchor: Option<(i32, i32)>,
) {
    let (left, top, right, bottom) = get_active_monitor_work_area(anchor);
    let work_w = (right - left).max(400);
    let work_h = (bottom - top).max(320);

    let (top_limit, bottom_limit) = vertical_limits_on_work_area(app, left, top, right, bottom);
    let avail_h = (bottom_limit - top_limit).max(80);

    let Ok(mut size) = win.outer_size() else {
        return;
    };
    let mut w = size.width as i32;
    let mut h = size.height as i32;

    if h > avail_h {
        let clamped_h = avail_h as u32;
        let _ = win.set_size(PhysicalSize::new(size.width, clamped_h));
        if let Ok(updated) = win.outer_size() {
            size = updated;
            w = size.width as i32;
            h = size.height as i32;
        } else {
            h = clamped_h as i32;
        }
    }

    let (x, y) = match label {
        LAUNCHER_LABEL => {
            let pos_mode = get_setting_str(app, "nectar-launcher-position")
                .unwrap_or_else(|| "center".to_string());
            let px = left + (work_w - w) / 2;
            let py = if pos_mode == "bottom" {
                bottom_limit - h
            } else {
                top_limit + ((bottom_limit - top_limit - h).max(0) as f64 * 0.16) as i32
            };
            (px, py)
        }
        START_LABEL => {
            let align = get_setting_str(app, "nectar-start-align")
                .unwrap_or_else(|| "center".to_string());
            let px = if align == "left" {
                left + 16
            } else {
                left + (work_w - w) / 2
            };
            let py = bottom_limit - h;
            (px, py)
        }
        TRAYBAR_LABEL => {
            let px = match anchor {
                Some((ax, _)) => ax - (w / 2),
                None => left + (work_w - w) / 2,
            };
            let py = match anchor {
                Some((_, ay)) if ay < top + work_h / 2 => ay.max(top_limit) + 8,
                _ => bottom_limit - h,
            };
            (px, py)
        }
        _ => (left + (work_w - w) / 2, top + (work_h - h) / 2),
    };

    let min_x = left + 8;
    let max_x = (right - w - 8).max(min_x);
    let min_y = top_limit.min((bottom_limit - h).max(top + 8));
    let max_y = (bottom_limit - h).max(min_y);

    let clamped_x = x.clamp(min_x, max_x);
    let clamped_y = y.clamp(min_y, max_y);
    let _ = win.set_position(PhysicalPosition::new(clamped_x, clamped_y));
}

fn prepare_focusable_toolwindow_style(win: &WebviewWindow) {
    if let Ok(hwnd) = win.hwnd() {
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as usize;
            let new_ex =
                (ex & !(WS_EX_NOACTIVATE.0 as usize)) | (WS_EX_TOOLWINDOW.0 as usize);
            if new_ex != ex {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_ex as isize);
            }
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
    }
}

fn ensure_surface(app: &AppHandle, label: &str) -> Option<(WebviewWindow, bool)> {
    if let Some(existing) = app.get_webview_window(label) {
        return Some((existing, false));
    }
    let spec = spec_for(label)?;
    let scale = get_nectar_scale(app).clamp(0.75, 1.75);
    let win = WebviewWindowBuilder::new(app, spec.label, WebviewUrl::App(spec.url.into()))
        .title(spec.title)
        .inner_size(spec.width * scale, spec.height * scale)
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .focused(true)
        .visible(false)
        .build()
        .ok()?;

    crate::services::attach_webview_crash_watcher(app, &win);

    let app_handle = app.clone();
    let label_owned = label.to_string();
    let win_clone = win.clone();
    win.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            hide_surface_internal(&app_handle, &label_owned, false);
        }
        WindowEvent::Focused(true) => {
            if let Some(rf) = received_focus_flag(&label_owned) {
                rf.store(true, Ordering::SeqCst);
            }
        }
        WindowEvent::Focused(false) => {
            if win_clone.hwnd().ok().is_some_and(hwnd_owns_foreground) {
                return;
            }
            if label_owned == TRAYBAR_LABEL && TRAYBAR_BLUR_LOCKED.load(Ordering::SeqCst) {
                return;
            }
            let shown_ms = shown_atomic(&label_owned)
                .map(|a| a.load(Ordering::Relaxed))
                .unwrap_or(0);
            let now = get_now_ms();
            let grace_active = now - shown_ms < FOCUS_GRACE_MS;
            if label_owned == START_LABEL
                && grace_active
                && crate::state::HOOK_CUSTOM_START_ENABLED.load(Ordering::Relaxed)
            {
                let fg_now = unsafe { GetForegroundWindow() };
                if crate::utils::is_native_start_or_search_hwnd(fg_now) {
                    if let Ok(hwnd) = win_clone.hwnd() {
                        let hwnd_raw = hwnd.0 as isize;
                        let show_gen_now = SURFACE_FOCUS_GEN.load(Ordering::SeqCst);
                        tauri::async_runtime::spawn(async move {
                            if SHUTTING_DOWN.load(Ordering::Relaxed)
                                || SURFACE_FOCUS_GEN.load(Ordering::SeqCst) != show_gen_now
                            {
                                return;
                            }
                            let _ = tokio::task::spawn_blocking(move || {
                                crate::utils::dismiss_visible_shell_flyout();
                                crate::utils::force_foreground(HWND(hwnd_raw as *mut _));
                            })
                            .await;
                        });
                        return;
                    }
                }
            }
            let received_focus = received_focus_flag(&label_owned)
                .is_some_and(|f| f.load(Ordering::SeqCst));
            if grace_active || !received_focus {
                let ah = app_handle.clone();
                let lbl = label_owned.clone();
                let w = win_clone.clone();
                let wait_ms = (FOCUS_GRACE_MS - (now - shown_ms)).clamp(150, FOCUS_GRACE_MS) as u64;
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(wait_ms)).await;
                    let _ = on_main_thread(&ah, move |main_ah| {
                        if shown_atomic(&lbl)
                            .map(|a| a.load(Ordering::Relaxed))
                            .unwrap_or(0)
                            != shown_ms
                        {
                            return;
                        }
                        if lbl == TRAYBAR_LABEL && TRAYBAR_BLUR_LOCKED.load(Ordering::SeqCst) {
                            return;
                        }
                        let still_owns = w.is_focused().unwrap_or(false)
                            || w.hwnd().ok().is_some_and(hwnd_owns_foreground);
                        if w.is_visible().unwrap_or(false) && !still_owns {
                            record_blur_hide(&lbl);
                            hide_surface_internal(&main_ah, &lbl, false);
                        }
                    })
                    .await;
                });
            } else if win_clone.is_visible().unwrap_or(false) {
                record_blur_hide(&label_owned);
                hide_surface_internal(&app_handle, &label_owned, false);
            }
        }
        _ => {}
    });

    Some((win, true))
}

fn hide_other_surfaces(app: &AppHandle, keep_label: &str) {
    for other in [LAUNCHER_LABEL, START_LABEL, TRAYBAR_LABEL] {
        if other != keep_label {
            hide_surface_internal(app, other, false);
        }
    }
}

fn is_valid_non_shell_restore_target(hwnd: HWND) -> bool {
    unsafe {
        if hwnd.is_invalid()
            || !IsWindow(Some(hwnd)).as_bool()
            || !IsWindowVisible(hwnd).as_bool()
            || IsIconic(hwnd).as_bool()
        {
            return false;
        }
        let mut cloaked = 0u32;
        if DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut _ as *mut _,
            std::mem::size_of::<u32>() as u32,
        )
        .is_ok()
            && cloaked != 0
        {
            return false;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 || pid == std::process::id() {
            return false;
        }
        if crate::utils::is_shell_flyout_hwnd(hwnd) {
            return false;
        }
        let mut cls_buf = [0u8; 64];
        let len = GetClassNameA(hwnd, &mut cls_buf).max(0) as usize;
        let cls = std::str::from_utf8(&cls_buf[..len]).unwrap_or("");
        !matches!(cls, "Shell_TrayWnd" | "Shell_SecondaryTrayWnd")
    }
}

fn fg_belongs_to_shell_surface(app: &AppHandle, fg: HWND) -> bool {
    if fg.is_invalid() {
        return false;
    }
    [LAUNCHER_LABEL, START_LABEL, TRAYBAR_LABEL]
        .into_iter()
        .any(|lbl| {
            app.get_webview_window(lbl)
                .and_then(|w| w.hwnd().ok())
                .is_some_and(|h| h == fg || hwnd_owns_foreground(h))
        })
}

fn capture_previous_non_shell_fg(app: &AppHandle) {
    let fg = unsafe { GetForegroundWindow() };
    if fg_belongs_to_shell_surface(app, fg) {
        return;
    }
    if is_valid_non_shell_restore_target(fg) {
        PREVIOUS_NON_SHELL_FG.store(fg.0 as isize, Ordering::SeqCst);
    } else {
        PREVIOUS_NON_SHELL_FG.store(0, Ordering::SeqCst);
    }
}

fn should_restore_previous_foreground(
    allow_restore: bool,
    was_fg: bool,
    fg_after_is_null: bool,
    fg_after_is_shell: bool,
) -> bool {
    allow_restore && was_fg && (fg_after_is_null || fg_after_is_shell)
}

fn should_retry_uia_focus(fg_ok: bool, fg_is_shell: bool) -> bool {
    !fg_ok && fg_is_shell
}

fn restore_foreground_if_landed_on_shell(allow_restore: bool, was_fg: bool) {
    if !allow_restore || !was_fg {
        return;
    }
    unsafe {
        let fg_after = GetForegroundWindow();
        let fg_after_is_null = fg_after.is_invalid();
        let fg_after_is_shell =
            !fg_after_is_null && crate::utils::is_shell_flyout_hwnd(fg_after);
        if !should_restore_previous_foreground(
            allow_restore,
            was_fg,
            fg_after_is_null,
            fg_after_is_shell,
        ) {
            return;
        }
        let prev_raw = PREVIOUS_NON_SHELL_FG.load(Ordering::SeqCst);
        let prev = HWND(prev_raw as *mut _);
        let target = if prev_raw != 0 && is_valid_non_shell_restore_target(prev) {
            prev
        } else {
            GetShellWindow()
        };
        if !target.is_invalid() {
            let _ = SetForegroundWindow(target);
        }
    }
}

fn hide_surface_internal(app: &AppHandle, label: &str, allow_restore: bool) {
    SURFACE_FOCUS_GEN.fetch_add(1, Ordering::SeqCst);
    if label == START_LABEL {
        START_MENU_VISIBLE.store(false, Ordering::SeqCst);
    } else if label == TRAYBAR_LABEL {
        TRAYBAR_BLUR_LOCKED.store(false, Ordering::SeqCst);
    }
    if let Some(win) = app.get_webview_window(label) {
        let was_fg = win.hwnd().ok().is_some_and(hwnd_owns_foreground);
        if let Ok(hwnd) = win.hwnd() {
            let raw = hwnd.0 as isize;
            let _ = KEYBOARD_FOCUS_HWND.compare_exchange(
                raw,
                0,
                Ordering::SeqCst,
                Ordering::SeqCst,
            );
        }
        if win.is_visible().unwrap_or(false) {
            let _ = app.emit_to(label, "shell-window-hidden", ());
            if was_fg {
                unsafe {
                    let _ = AllowSetForegroundWindow(ASFW_ANY);
                }
            }
            let _ = win.hide();
            restore_foreground_if_landed_on_shell(allow_restore, was_fg);
            if crate::state::PERF_PROFILE.load(Ordering::Relaxed) == 1
                || crate::state::RAM_SAVER_ENABLED.load(Ordering::Relaxed)
            {
                crate::webview_memory::set_low_memory(&win, true);
                crate::memory_saver::trim_soon();
            }
        }
    }
    if let Ok(mut lock) = KEYBOARD_FOCUS_LABEL.lock() {
        if lock.as_deref() == Some(label) {
            *lock = None;
        }
    }
}

pub fn hide_surface(app: &AppHandle, label: &str) {
    hide_surface_internal(app, label, false);
}

fn emit_shell_surface_opening(app: &AppHandle, opening_label: &str) {
    let _ = app.emit_to("main", "shell-surface-opening", opening_label);
    let _ = app.emit_to("dock", "shell-surface-opening", opening_label);
    for label in app.webview_windows().keys() {
        if label != "main"
            && label != "dock"
            && (crate::state::is_notch_label(label) || crate::state::is_dock_label(label))
        {
            let _ = app.emit_to(label, "shell-surface-opening", opening_label);
        }
    }
}

async fn on_main_thread<T: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce(AppHandle) -> T + Send + 'static,
) -> Option<T> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let app_clone = app.clone();
    if app
        .run_on_main_thread(move || {
            let _ = tx.send(f(app_clone));
        })
        .is_err()
    {
        return None;
    }
    match tokio::time::timeout(std::time::Duration::from_secs(3), rx).await {
        Ok(Ok(val)) => Some(val),
        Ok(Err(_)) => None,
        Err(_) => {
            crate::diagnostics::log("shell_windows: on_main_thread timed out after 3000ms");
            None
        }
    }
}

async fn wait_for_surface_ready(label: &str) {
    let Some(ready) = ready_flag(label) else {
        return;
    };
    if ready.load(Ordering::SeqCst) {
        return;
    }
    let Some(notify) = ready_notify(label) else {
        return;
    };
    let _ = tokio::time::timeout(std::time::Duration::from_millis(COLD_READY_WAIT_MS), async {
        while !ready.load(Ordering::SeqCst) {
            let _ = tokio::time::timeout(
                std::time::Duration::from_millis(20),
                notify.notified(),
            )
            .await;
        }
    })
    .await;
}

async fn show_surface_async(
    app: AppHandle,
    label: &'static str,
    anchor: Option<(i32, i32)>,
    payload: serde_json::Value,
) {
    if SHUTTING_DOWN.load(Ordering::Relaxed) {
        return;
    }

    emit_shell_surface_opening(&app, label);

    if label == TRAYBAR_LABEL {
        if let Ok(mut guard) = LAST_TRAYBAR_ANCHOR.lock() {
            if anchor.is_some() {
                *guard = anchor;
            }
        }
    }
    if let Ok(mut map) = last_payloads().lock() {
        map.insert(label.to_string(), payload.clone());
    }

    let resolved_anchor = if label == TRAYBAR_LABEL && anchor.is_none() {
        let (l, t, r, b) = get_active_monitor_work_area(None);
        LAST_TRAYBAR_ANCHOR
            .lock()
            .ok()
            .and_then(|g| *g)
            .filter(|&(ax, ay)| ax >= l && ax <= r && ay >= t && ay <= b)
    } else {
        anchor
    };

    let created = on_main_thread(&app, move |ah| {
        if SHUTTING_DOWN.load(Ordering::Relaxed) {
            return None;
        }
        capture_previous_non_shell_fg(&ah);
        hide_other_surfaces(&ah, label);
        let (win, newly_created) = ensure_surface(&ah, label)?;
        if newly_created {
            position_surface(&ah, &win, label, resolved_anchor);
        }
        Some(newly_created)
    })
    .await
    .flatten();

    let Some(newly_created) = created else {
        return;
    };

    if !ready_flag(label).is_some_and(|r| r.load(Ordering::SeqCst)) {
        wait_for_surface_ready(label).await;
    }

    let _ = tokio::task::spawn_blocking(crate::utils::dismiss_visible_shell_flyout).await;

    let show_result = on_main_thread(&app, move |ah| {
        if SHUTTING_DOWN.load(Ordering::Relaxed) {
            return None;
        }
        let Some(win) = ah.get_webview_window(label) else {
            return None;
        };
        let show_gen = SURFACE_FOCUS_GEN.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(rf) = received_focus_flag(label) {
            rf.store(false, Ordering::SeqCst);
        }
        if let Some(ts) = shown_atomic(label) {
            ts.store(get_now_ms(), Ordering::Relaxed);
        }
        if let Ok(mut lock) = KEYBOARD_FOCUS_LABEL.lock() {
            *lock = Some(label.to_string());
        }
        if label == START_LABEL {
            START_MENU_VISIBLE.store(true, Ordering::SeqCst);
        }
        let hwnd_raw_opt = win.hwnd().ok().map(|h| h.0 as isize);
        if let Some(hwnd_raw) = hwnd_raw_opt {
            KEYBOARD_FOCUS_HWND.store(hwnd_raw, Ordering::SeqCst);
        }

        let payload_on_show = payload.clone();
        crate::webview_memory::set_low_memory(&win, false);
        position_surface(&ah, &win, label, resolved_anchor);
        prepare_focusable_toolwindow_style(&win);
        let _ = win.show();
        if mark_show_and_claim_emit(ready_flag(label), replay_flag(label)) {
            let _ = ah.emit_to(label, "shell-window-shown", payload_on_show);
        }
        if newly_created {
            position_surface(&ah, &win, label, resolved_anchor);
        }
        if let Some(ts) = shown_atomic(label) {
            ts.store(get_now_ms(), Ordering::Relaxed);
        }
        let mut retry_target = None;
        if let Some(hwnd_raw) = hwnd_raw_opt {
            let hwnd = HWND(hwnd_raw as *mut _);
            let _ = win.set_focus();
            let owned = win.is_focused().unwrap_or(false) || hwnd_owns_foreground(hwnd);
            if owned {
                if let Some(rf) = received_focus_flag(label) {
                    rf.store(true, Ordering::SeqCst);
                }
            } else {
                retry_target = Some((hwnd_raw, show_gen));
            }
        } else {
            let _ = win.set_focus();
            if win.is_focused().unwrap_or(false) {
                if let Some(rf) = received_focus_flag(label) {
                    rf.store(true, Ordering::SeqCst);
                }
            }
        }
        Some((show_gen, hwnd_raw_opt, retry_target))
    })
    .await
    .flatten();

    let Some((show_gen, shown_hwnd_raw, retry_uia)) = show_result else {
        return;
    };

    if (label == START_LABEL || label == LAUNCHER_LABEL)
        && crate::state::HOOK_CUSTOM_START_ENABLED.load(Ordering::Relaxed)
    {
        if let Some(hwnd_raw) = shown_hwnd_raw {
            let app_guard = app.clone();
            tauri::async_runtime::spawn(async move {
                for wait_ms in [70u64, 110u64] {
                    tokio::time::sleep(std::time::Duration::from_millis(wait_ms)).await;
                    if SHUTTING_DOWN.load(Ordering::Relaxed)
                        || SURFACE_FOCUS_GEN.load(Ordering::SeqCst) != show_gen
                        || !app_guard
                            .get_webview_window(label)
                            .is_some_and(|w| w.is_visible().unwrap_or(false))
                    {
                        break;
                    }
                    let native_visible =
                        tokio::task::spawn_blocking(crate::utils::has_visible_native_start_window)
                            .await
                            .ok()
                            .unwrap_or(false);
                    if native_visible {
                        let _ = tokio::task::spawn_blocking(move || {
                            crate::utils::dismiss_visible_shell_flyout();
                            crate::utils::force_foreground(HWND(hwnd_raw as *mut _));
                        })
                        .await;
                    }
                }
            });
        }
    }

    if let Some((hwnd_raw, show_gen)) = retry_uia {
        if SHUTTING_DOWN.load(Ordering::Relaxed)
            || SURFACE_FOCUS_GEN.load(Ordering::SeqCst) != show_gen
        {
            return;
        }
        let fg_ok = tokio::time::timeout(
            std::time::Duration::from_millis(250),
            tokio::task::spawn_blocking(move || force_foreground(HWND(hwnd_raw as *mut _))),
        )
        .await
        .ok()
        .and_then(|r| r.ok())
        .unwrap_or(false);
        let hwnd = HWND(hwnd_raw as *mut _);
        if fg_ok || hwnd_owns_foreground(hwnd) {
            if let Some(rf) = received_focus_flag(label) {
                rf.store(true, Ordering::SeqCst);
            }
            return;
        }
        let fg_now = unsafe { GetForegroundWindow() };
        let fg_is_shell = !fg_now.is_invalid() && crate::utils::is_shell_flyout_hwnd(fg_now);
        if should_retry_uia_focus(false, fg_is_shell) {
            let app_for_log = app;
            tauri::async_runtime::spawn(async move {
                let cancelled = Arc::new(AtomicBool::new(false));
                let cancelled_thread = Arc::clone(&cancelled);
                let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
                let spawned = std::thread::Builder::new()
                    .name("uia-focus".into())
                    .spawn(move || {
                        let ok = crate::utils::uia_focus_hwnd(hwnd_raw, || {
                            !cancelled_thread.load(Ordering::SeqCst)
                                && !SHUTTING_DOWN.load(Ordering::Relaxed)
                                && SURFACE_FOCUS_GEN.load(Ordering::SeqCst) == show_gen
                        });
                        let _ = tx.send(ok);
                    });
                if spawned.is_err() {
                    return;
                }
                let uia_ok = match tokio::time::timeout(
                    std::time::Duration::from_millis(180),
                    rx,
                )
                .await
                {
                    Ok(Ok(ok)) => ok,
                    _ => {
                        cancelled.store(true, Ordering::SeqCst);
                        false
                    }
                };
                crate::diagnostics::log(&format!(
                    "focus: uia fallback for {label} hwnd=0x{:x} worked={uia_ok}",
                    hwnd_raw as usize
                ));
                if uia_ok
                    && !SHUTTING_DOWN.load(Ordering::Relaxed)
                    && SURFACE_FOCUS_GEN.load(Ordering::SeqCst) == show_gen
                    && app_for_log
                        .get_webview_window(label)
                        .is_some_and(|w| w.is_visible().unwrap_or(false))
                {
                    if let Some(ts) = shown_atomic(label) {
                        ts.store(get_now_ms(), Ordering::Relaxed);
                    }
                    if let Some(rf) = received_focus_flag(label) {
                        rf.store(true, Ordering::SeqCst);
                    }
                }
            });
        }
    }
}

async fn toggle_surface_async(
    app: AppHandle,
    label: &'static str,
    anchor: Option<(i32, i32)>,
    payload: serde_json::Value,
    respect_blur_debounce: bool,
) {
    let visible = app
        .get_webview_window(label)
        .is_some_and(|w| w.is_visible().unwrap_or(false));
    if visible {
        on_main_thread(&app, move |ah| {
            hide_surface_internal(&ah, label, true);
        })
        .await;
        return;
    }
    if respect_blur_debounce && was_surface_blur_hidden_recently(label) {
        return;
    }
    show_surface_async(app, label, anchor, payload).await;
}

pub fn prewarm_shell_surfaces(app: AppHandle) {
    if SHUTTING_DOWN.load(Ordering::Relaxed) {
        return;
    }
    if crate::state::PERF_PROFILE.load(Ordering::Relaxed) == 1 {
        return;
    }
    if get_setting_str(&app, "nectar-legacy-mode").is_some_and(|v| v == "true") {
        return;
    }
    let prewarm_start =
        get_setting_str(&app, "nectar-start-custom-enabled").is_none_or(|v| v != "false");
    let prewarm_launcher =
        get_setting_str(&app, "nectar-launcher-enabled").is_none_or(|v| v != "false");
    if !prewarm_start && !prewarm_launcher {
        return;
    }
    let ah = app.clone();
    let _ = app.run_on_main_thread(move || {
        if SHUTTING_DOWN.load(Ordering::Relaxed) {
            return;
        }
        if prewarm_start && ah.get_webview_window(START_LABEL).is_none() {
            let _ = ensure_surface(&ah, START_LABEL);
        }
        if prewarm_launcher && ah.get_webview_window(LAUNCHER_LABEL).is_none() {
            let _ = ensure_surface(&ah, LAUNCHER_LABEL);
        }
    });
}

fn spawn_surface_action(
    app: AppHandle,
    label: &'static str,
    toggle: bool,
    respect_blur_debounce: bool,
    anchor: Option<(i32, i32)>,
    payload: serde_json::Value,
) {
    let Some(flag) = busy_flag(label) else {
        return;
    };
    if flag.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let _reset = BusyReset(flag);
        if toggle {
            toggle_surface_async(app, label, anchor, payload, respect_blur_debounce).await;
        } else {
            show_surface_async(app, label, anchor, payload).await;
        }
    });
}

pub fn toggle_launcher_async(app: AppHandle, initial_query: Option<String>) {
    if !is_launcher_allowed(&app) {
        hide_surface(&app, LAUNCHER_LABEL);
        return;
    }
    let q = initial_query.unwrap_or_default();
    if let Ok(mut pending) = PENDING_LAUNCHER_QUERY.lock() {
        *pending = (!q.is_empty()).then_some(q.clone());
    }
    let payload = serde_json::json!({
        "query": q,
        "scale": get_nectar_scale(&app),
    });
    spawn_surface_action(app, LAUNCHER_LABEL, true, true, None, payload);
}

pub fn show_launcher_async(app: AppHandle, initial_query: Option<String>) {
    if !is_launcher_allowed(&app) {
        return;
    }
    let q = initial_query.unwrap_or_default();
    if let Ok(mut pending) = PENDING_LAUNCHER_QUERY.lock() {
        *pending = (!q.is_empty()).then_some(q.clone());
    }
    let payload = serde_json::json!({
        "query": q,
        "scale": get_nectar_scale(&app),
    });
    spawn_surface_action(app, LAUNCHER_LABEL, false, true, None, payload);
}

pub fn toggle_start_async(app: AppHandle) {
    let payload = serde_json::json!({
        "scale": get_nectar_scale(&app),
    });
    spawn_surface_action(app, START_LABEL, true, true, None, payload);
}

/// Toggle Start Menu directly from a physical Win key tap without blur-debounce suppression.
pub fn toggle_start_from_winkey(app: AppHandle) {
    let payload = serde_json::json!({
        "scale": get_nectar_scale(&app),
    });
    spawn_surface_action(app, START_LABEL, true, false, None, payload);
}

pub fn toggle_traybar_async(app: AppHandle, anchor: Option<(i32, i32)>) {
    let payload = serde_json::json!({
        "scale": get_nectar_scale(&app),
    });
    crate::tray_host::outrank();
    spawn_surface_action(app, TRAYBAR_LABEL, true, true, anchor, payload);
}

fn mark_show_and_claim_emit(
    ready: Option<&std::sync::atomic::AtomicBool>,
    replay: Option<&std::sync::atomic::AtomicBool>,
) -> bool {
    if let Some(rf) = replay {
        rf.store(true, Ordering::SeqCst);
    }
    ready.is_some_and(|r| r.load(Ordering::SeqCst))
        && replay.is_none_or(|rf| rf.swap(false, Ordering::SeqCst))
}

fn mark_ready_and_claim_replay(
    ready: Option<&std::sync::atomic::AtomicBool>,
    replay: Option<&std::sync::atomic::AtomicBool>,
    notify: impl FnOnce(),
) -> bool {
    if let Some(r) = ready {
        r.store(true, Ordering::SeqCst);
    }
    notify();
    replay.is_some_and(|rf| rf.swap(false, Ordering::SeqCst))
}

#[tauri::command]
pub fn shell_surface_ready(app: AppHandle, window: Window) {
    let label = window.label().to_string();
    let should_replay = mark_ready_and_claim_replay(ready_flag(&label), replay_flag(&label), || {
        if let Some(notify) = ready_notify(&label) {
            notify.notify_waiters();
        }
    });
    if !should_replay {
        return;
    }
    let is_vis = app
        .get_webview_window(&label)
        .is_some_and(|w| w.is_visible().unwrap_or(false));
    if !is_vis {
        return;
    }
    let payload = last_payloads()
        .lock()
        .ok()
        .and_then(|m| m.get(&label).cloned())
        .unwrap_or_else(|| serde_json::json!({ "scale": get_nectar_scale(&app) }));
    let _ = app.emit_to(&label, "shell-window-shown", payload);
}

#[tauri::command]
pub fn open_launcher(app: AppHandle, initial_query: Option<String>) {
    if !is_launcher_allowed(&app) {
        return;
    }
    show_launcher_async(app, initial_query);
}

#[tauri::command]
pub fn take_pending_launcher_query() -> Option<String> {
    PENDING_LAUNCHER_QUERY.lock().ok().and_then(|mut g| g.take())
}

#[tauri::command]
pub fn hide_launcher(app: AppHandle, restore_focus: Option<bool>) {
    hide_surface_internal(&app, LAUNCHER_LABEL, restore_focus.unwrap_or(false));
}

#[tauri::command]
pub fn toggle_start_menu_window(app: AppHandle) {
    toggle_start_async(app);
}

#[tauri::command]
pub fn hide_start_menu(app: AppHandle, restore_focus: Option<bool>) {
    hide_surface_internal(&app, START_LABEL, restore_focus.unwrap_or(false));
}

#[tauri::command]
pub fn open_traybar_window(app: AppHandle, anchor_x: Option<f64>, anchor_y: Option<f64>) {
    let anchor = anchor_x
        .zip(anchor_y)
        .map(|(x, y)| (x.round() as i32, y.round() as i32));
    toggle_traybar_async(app, anchor);
}

#[tauri::command]
pub fn hide_traybar(app: AppHandle, restore_focus: Option<bool>) {
    hide_surface_internal(&app, TRAYBAR_LABEL, restore_focus.unwrap_or(false));
}

#[tauri::command]
pub fn resize_shell_window(app: AppHandle, window: Window, width: f64, height: f64) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let nectar_scale = get_nectar_scale(&app).clamp(0.75, 1.75);
    let phys_w = (width * scale * nectar_scale).round().max(180.0) as u32;
    let phys_h = (height * scale * nectar_scale).round().max(64.0) as u32;
    let label = window.label().to_string();
    if let Some(w) = app.get_webview_window(&label) {
        let anchor = if label == TRAYBAR_LABEL {
            LAST_TRAYBAR_ANCHOR.lock().ok().and_then(|g| *g)
        } else if w.is_visible().unwrap_or(false) {
            w.outer_position()
                .ok()
                .zip(w.outer_size().ok())
                .map(|(p, s)| (p.x + (s.width as i32) / 2, p.y + (s.height as i32) / 2))
        } else {
            None
        };
        let (left, top, right, bottom) = get_active_monitor_work_area(anchor);
        let (top_limit, bottom_limit) =
            vertical_limits_on_work_area(&app, left, top, right, bottom);
        let avail_w = (right - left - 16).max(180) as u32;
        let avail_h = (bottom_limit - top_limit).max(80) as u32;
        let clamped_w = phys_w.min(avail_w);
        let clamped_h = phys_h.min(avail_h);

        let _ = w.set_size(PhysicalSize::new(clamped_w, clamped_h));
        if w.is_visible().unwrap_or(false) {
            position_surface(&app, &w, &label, anchor);
        }
    }
}

#[tauri::command]
pub async fn get_tray_icons() -> Vec<TrayIconDto> {
    tauri::async_runtime::spawn_blocking(crate::tray_host::list_icons)
        .await
        .unwrap_or_default()
}

fn resolve_tray_cursor_pos(screen_x: i32, screen_y: i32) -> (i32, i32) {
    unsafe {
        let invalid = (screen_x == 0 && screen_y == 0)
            || MonitorFromPoint(
                POINT {
                    x: screen_x,
                    y: screen_y,
                },
                MONITOR_DEFAULTTONULL,
            )
            .is_invalid();
        if invalid {
            let mut cursor = POINT::default();
            if GetCursorPos(&mut cursor).is_ok() {
                return (cursor.x, cursor.y);
            }
        }
    }
    (screen_x, screen_y)
}

#[tauri::command]
pub async fn interact_tray_icon(
    app: AppHandle,
    key: String,
    action: String,
    screen_x: i32,
    screen_y: i32,
    rect: Option<(i32, i32, i32, i32)>,
) -> Result<(), String> {
    let is_right = action == "right" || action == "menu";
    let is_activate = action == "left" || action == "double";

    let (resolved_x, resolved_y) = resolve_tray_cursor_pos(screen_x, screen_y);
    let resolved_rect = rect.filter(|&(l, t, r, b)| r > l && b > t);

    // Grant foreground rights and hide TrayBar BEFORE forwarding right-click WM_CONTEXTMENU
    // so Nectar never steals focus back or dismisses the target app's popup menu.
    if is_right {
        unsafe {
            let _ = AllowSetForegroundWindow(ASFW_ANY);
        }
        hide_surface(&app, TRAYBAR_LABEL);
    }

    let host_action = if action == "menu" {
        "right".to_string()
    } else {
        action
    };
    let res = tauri::async_runtime::spawn_blocking(move || {
        crate::tray_host::interact_icon(&key, &host_action, resolved_x, resolved_y, resolved_rect)
    })
    .await
    .map_err(|e| e.to_string())?;

    if res.is_ok() && is_activate {
        let ah = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            if let Some(w) = ah.get_webview_window(TRAYBAR_LABEL) {
                if w.is_visible().unwrap_or(false) && !w.is_focused().unwrap_or(false) {
                    hide_surface(&ah, TRAYBAR_LABEL);
                }
            }
        });
    }
    res
}

#[tauri::command]
pub fn refresh_tray_icons() {
    crate::tray_host::trigger_refresh();
}

#[tauri::command]
pub fn open_native_tray(app: AppHandle) {
    hide_surface(&app, TRAYBAR_LABEL);
    crate::commands::open_native_tray_at_cursor();
}

#[cfg(test)]
mod tests {
    use super::{clamp_vertical_limits, should_debounce_blur_reopen, BLUR_DEBOUNCE_MS};

    #[test]
    fn blur_debounce_blocks_immediate_reopen_under_300ms() {
        assert!(!should_debounce_blur_reopen(None, 1_000));
        assert!(should_debounce_blur_reopen(Some(1_000), 1_000));
        assert!(should_debounce_blur_reopen(
            Some(1_000),
            1_000 + BLUR_DEBOUNCE_MS - 1
        ));
        assert!(!should_debounce_blur_reopen(
            Some(1_000),
            1_000 + BLUR_DEBOUNCE_MS
        ));
        assert!(!should_debounce_blur_reopen(Some(1_000), 950));
    }

    #[test]
    fn vertical_limits_preserves_dock_clearance_even_in_fallback() {
        // Normal 1080p desktop: Notch clears top=48, Dock clears bottom=990
        assert_eq!(clamp_vertical_limits(0, 1080, 48, 990), (48, 990));

        // Crowded viewport where Notch expansion pushes top_limit close to Dock:
        // Dock clearance (990) MUST NEVER be discarded!
        let (top, bottom) = clamp_vertical_limits(0, 1080, 860, 990);
        assert_eq!(bottom, 990);
        assert_eq!(top, 830);
        assert!(top < bottom);

        // Small viewport with both Notch and Dock active
        let (small_top, small_bottom) = clamp_vertical_limits(0, 300, 60, 210);
        assert_eq!(small_bottom, 210);
        assert_eq!(small_top, 50);
        assert!(small_top < small_bottom);

        // Degenerate ultra-tiny viewport stays ordered without inverting
        let (tiny_top, tiny_bottom) = clamp_vertical_limits(0, 120, 40, 112);
        assert!(tiny_top < tiny_bottom);
        assert_eq!(tiny_bottom, 112);
    }

    #[test]
    fn ready_replay_handshake_emits_once_in_either_order() {
        use std::sync::atomic::AtomicBool;

        // 1. Prewarmed ready surface: ready=true before show -> show claims emit once, replay stays false.
        let ready = AtomicBool::new(true);
        let replay = AtomicBool::new(false);
        assert!(super::mark_show_and_claim_emit(Some(&ready), Some(&replay)));
        assert!(!super::mark_ready_and_claim_replay(
            Some(&ready),
            Some(&replay),
            || {}
        ));

        // 2. Show runs while surface is not yet ready (both new or prewarmed): ready=false -> ready replays once.
        let ready = AtomicBool::new(false);
        let replay = AtomicBool::new(false);
        assert!(!super::mark_show_and_claim_emit(Some(&ready), Some(&replay)));
        assert!(super::mark_ready_and_claim_replay(
            Some(&ready),
            Some(&replay),
            || {}
        ));
        assert!(!super::mark_ready_and_claim_replay(
            Some(&ready),
            Some(&replay),
            || {}
        ));
    }

    #[test]
    fn restore_previous_fg_only_when_closing_focused_surface_lands_on_shell_or_null() {
        use super::should_restore_previous_foreground;

        // Launch, tray interaction, hide_other_surfaces, and blur hides suppress restore.
        assert!(!should_restore_previous_foreground(false, true, true, false));
        assert!(!should_restore_previous_foreground(false, true, false, true));

        // Surface did not own foreground when hidden: never hijack.
        assert!(!should_restore_previous_foreground(true, false, true, false));
        assert!(!should_restore_previous_foreground(true, false, false, true));

        // Surface owned foreground, and closing landed on normal user window: keep Windows' natural handoff.
        assert!(!should_restore_previous_foreground(true, true, false, false));

        // User-initiated dismiss owned foreground, and closing dropped to NULL or a Windows shell flyout: restore previous window.
        assert!(should_restore_previous_foreground(true, true, true, false));
        assert!(should_restore_previous_foreground(true, true, false, true));
    }

    #[test]
    fn uia_focus_retry_only_when_foreground_failed_against_shell_flyout() {
        use super::should_retry_uia_focus;

        assert!(!should_retry_uia_focus(true, true));
        assert!(!should_retry_uia_focus(true, false));
        assert!(!should_retry_uia_focus(false, false));
        assert!(should_retry_uia_focus(false, true));
    }

    #[test]
    fn traybar_spec_matches_symmetric_grid_window() {
        let spec = super::spec_for(super::TRAYBAR_LABEL).expect("traybar spec should exist");
        assert!(spec.width >= 328.0);
        assert_eq!(spec.width, 328.0);
        assert_eq!(spec.height, 264.0);
    }

    #[test]
    fn traybar_blur_lock_toggles_cleanly() {
        super::set_traybar_blur_lock(true);
        assert!(super::TRAYBAR_BLUR_LOCKED.load(std::sync::atomic::Ordering::SeqCst));
        super::set_traybar_blur_lock(false);
        assert!(!super::TRAYBAR_BLUR_LOCKED.load(std::sync::atomic::Ordering::SeqCst));
    }
}
