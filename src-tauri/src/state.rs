use std::sync::{atomic::{AtomicBool, AtomicI32, AtomicI64, AtomicIsize, AtomicU32, AtomicU64, AtomicU8}, Mutex, OnceLock};
use std::sync::mpsc::Sender;
use std::collections::{HashMap, HashSet};
use crate::types::{SystemCommand, IntRect, AppInfo};
use tauri::{AppHandle, PhysicalPosition, PhysicalSize};

pub static COMMAND_SENDER: OnceLock<Sender<SystemCommand>> = OnceLock::new();
pub static NATIVE_TASKBAR_HIDDEN: AtomicBool = AtomicBool::new(false);
/// Set first on every quit/restart path. Window calls while the webviews are torn down panic
/// ("already mutably borrowed"), so hooks and loops stand down once it's set.
pub static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);
/// This launch follows a restart or a crash, so calendars should sync right away.
pub static RELAUNCHED: AtomicBool = AtomicBool::new(false);
pub static KEYBOARD_FOCUS_LABEL: Mutex<Option<String>> = Mutex::new(None);
pub static KEYBOARD_FOCUS_HWND: AtomicIsize = AtomicIsize::new(0);
pub static START_MENU_VISIBLE: AtomicBool = AtomicBool::new(false);
pub static HOTKEYS_PAUSED: AtomicBool = AtomicBool::new(false);
/// True while AltKeyGuard holds synthetic VK_LMENU for focus unlock (never treated as physical Alt).
pub static SYNTHETIC_ALT_ACTIVE: AtomicBool = AtomicBool::new(false);
/// Wall-clock timestamp (ms) when AltKeyGuard finished releasing synthetic VK_LMENU.
pub static SYNTHETIC_ALT_RELEASED_MS: AtomicI64 = AtomicI64::new(0);

pub static HOOK_CUSTOM_START_ENABLED: AtomicBool = AtomicBool::new(true);
pub static HOOK_WINKEY_ENABLED: AtomicBool = AtomicBool::new(true);
pub static HOOK_LEGACY_MODE: AtomicBool = AtomicBool::new(false);
pub static HOOK_DOCK_WIN_NUMBER_ENABLED: AtomicBool = AtomicBool::new(true);
pub static HOOK_VOLUME_OVERLAY_ENABLED: AtomicBool = AtomicBool::new(true);
pub static HOOK_BRIGHTNESS_OVERLAY_ENABLED: AtomicBool = AtomicBool::new(true);
pub static HOOK_DOCK_ENABLED: AtomicBool = AtomicBool::new(true);
pub static HOOK_DOCK_SHOW_DESKTOP_CORNER: AtomicBool = AtomicBool::new(false);

/// Performance profile: 0 = balanced, 1 = eco, 2 = max visuals.
pub static PERF_PROFILE: AtomicU8 = AtomicU8::new(0);
pub static RAM_SAVER_ENABLED: AtomicBool = AtomicBool::new(false);
pub static GAME_MODE_ENABLED: AtomicBool = AtomicBool::new(true);
pub static GAME_MODE_PAUSE_POLLS: AtomicBool = AtomicBool::new(true);
pub static GAME_MODE_ACTIVE: AtomicBool = AtomicBool::new(false);
pub static HOOK_PREVIEW_PRECAPTURE: AtomicBool = AtomicBool::new(false);
pub static HOOK_DOCK_PREVIEW_ENABLED: AtomicBool = AtomicBool::new(true);
pub static DOCK_ICON_SIZE: AtomicI32 = AtomicI32::new(36);
/// Overlay vertical position: 0 = center, 1 = top, 2 = bottom.
pub static OVERLAY_VPOS: AtomicU8 = AtomicU8::new(0);
/// Overlay thickness style: 0 = default (42), 1 = slim (34), 2 = wide (52).
pub static OVERLAY_WIDTH_STYLE: AtomicU8 = AtomicU8::new(0);
pub static NECTAR_SCALE_BITS: AtomicU32 = AtomicU32::new(1.0f32.to_bits());
pub static LAST_SELF_WRITE_MS: AtomicI64 = AtomicI64::new(0);
pub static MOUSE_SETTINGS_EPOCH: AtomicU64 = AtomicU64::new(1);
pub static MEDIA_ACCENT_RUNTIME: Mutex<Option<String>> = Mutex::new(None);

pub static SHELL_CHROME_HWNDS: OnceLock<Mutex<HashSet<isize>>> = OnceLock::new();

fn shell_chrome_hwnds() -> &'static Mutex<HashSet<isize>> {
    SHELL_CHROME_HWNDS.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn register_shell_chrome_hwnd(hwnd: isize) {
    if hwnd == 0 {
        return;
    }
    if let Ok(mut set) = shell_chrome_hwnds().lock() {
        set.insert(hwnd);
    }
}

pub fn unregister_shell_chrome_hwnd(hwnd: isize) {
    if hwnd == 0 {
        return;
    }
    if let Ok(mut set) = shell_chrome_hwnds().lock() {
        set.remove(&hwnd);
    }
}

pub fn is_shell_chrome_hwnd(hwnd: isize) -> bool {
    if hwnd == 0 {
        return false;
    }
    shell_chrome_hwnds()
        .lock()
        .map(|set| set.contains(&hwnd))
        .unwrap_or(false)
}

macro_rules! label_map {
    ($fn_name:ident, $val_ty:ty) => {
        pub fn $fn_name() -> &'static Mutex<HashMap<String, $val_ty>> {
            static CELL: OnceLock<Mutex<HashMap<String, $val_ty>>> = OnceLock::new();
            CELL.get_or_init(|| Mutex::new(HashMap::new()))
        }
    };
}

label_map!(dock_rects, IntRect);
label_map!(dock_pill_rects, IntRect);
label_map!(notch_rects, IntRect);
label_map!(dock_hovered, bool);
label_map!(dock_hidden, bool);
label_map!(notch_hovered, bool);
// Frontend says the notch is off screen (smart/peek), keep it click-through then.
label_map!(notch_hidden, bool);
label_map!(notch_min_heights, i32);
// A fullscreen window covers this notch's monitor.
label_map!(notch_fullscreen, bool);
// Top edge hover intent: when the cursor entered the band, and whether it rested long enough.
label_map!(notch_edge_enter_ms, i64);
label_map!(notch_edge_armed, bool);
// Bottom edge hover intent for hidden smart/peek docks: prevents pass-through clicks from stealing input.
label_map!(dock_edge_enter_ms, i64);
label_map!(dock_edge_armed, bool);
label_map!(dock_overlap, i32);
label_map!(notch_overlap, i32);
label_map!(dock_window_rects, (PhysicalPosition<i32>, PhysicalSize<u32>));
label_map!(main_window_rects, (PhysicalPosition<i32>, PhysicalSize<u32>));
label_map!(dock_appbar_registered, bool);
label_map!(main_appbar_registered, bool);

label_map!(dock_extra_last_ignore, i32);
label_map!(notch_extra_last_ignore, i32);
label_map!(dock_extra_last_edge_hover, i32);
label_map!(notch_extra_last_edge_hover, i32);
label_map!(dock_extra_expiry_ms, i64);
label_map!(notch_extra_expiry_ms, i64);

pub fn get_flag(map: &'static Mutex<HashMap<String, bool>>, label: &str) -> bool {
    map.lock().ok().and_then(|m| m.get(label).copied()).unwrap_or(false)
}

pub fn set_flag(map: &'static Mutex<HashMap<String, bool>>, label: &str, value: bool) {
    if let Ok(mut m) = map.lock() {
        m.insert(label.to_string(), value);
    }
}

pub fn get_overlap(map: &'static Mutex<HashMap<String, i32>>, label: &str) -> i32 {
    map.lock().ok().and_then(|m| m.get(label).copied()).unwrap_or(-1)
}

pub fn set_overlap(map: &'static Mutex<HashMap<String, i32>>, label: &str, value: i32) {
    if let Ok(mut m) = map.lock() {
        m.insert(label.to_string(), value);
    }
}

pub fn get_i32(map: &'static Mutex<HashMap<String, i32>>, label: &str, default: i32) -> i32 {
    map.lock().ok().and_then(|m| m.get(label).copied()).unwrap_or(default)
}

pub fn set_i32(map: &'static Mutex<HashMap<String, i32>>, label: &str, value: i32) {
    if let Ok(mut m) = map.lock() {
        m.insert(label.to_string(), value);
    }
}

pub fn get_i64(map: &'static Mutex<HashMap<String, i64>>, label: &str, default: i64) -> i64 {
    map.lock().ok().and_then(|m| m.get(label).copied()).unwrap_or(default)
}

pub fn set_i64(map: &'static Mutex<HashMap<String, i64>>, label: &str, value: i64) {
    if let Ok(mut m) = map.lock() {
        m.insert(label.to_string(), value);
    }
}

pub fn clear_window_state(label: &str) {
    if let Ok(mut m) = dock_rects().lock() { m.remove(label); }
    if let Ok(mut m) = dock_pill_rects().lock() { m.remove(label); }
    if let Ok(mut m) = notch_rects().lock() { m.remove(label); }
    if let Ok(mut m) = dock_hovered().lock() { m.remove(label); }
    if let Ok(mut m) = dock_hidden().lock() { m.remove(label); }
    if let Ok(mut m) = notch_hovered().lock() { m.remove(label); }
    if let Ok(mut m) = notch_hidden().lock() { m.remove(label); }
    if let Ok(mut m) = notch_min_heights().lock() { m.remove(label); }
    if let Ok(mut m) = notch_fullscreen().lock() { m.remove(label); }
    if let Ok(mut m) = notch_edge_enter_ms().lock() { m.remove(label); }
    if let Ok(mut m) = notch_edge_armed().lock() { m.remove(label); }
    if let Ok(mut m) = dock_edge_enter_ms().lock() { m.remove(label); }
    if let Ok(mut m) = dock_edge_armed().lock() { m.remove(label); }
    if let Ok(mut m) = dock_overlap().lock() { m.remove(label); }
    if let Ok(mut m) = notch_overlap().lock() { m.remove(label); }
    if let Ok(mut m) = dock_window_rects().lock() { m.remove(label); }
    if let Ok(mut m) = main_window_rects().lock() { m.remove(label); }
    if let Ok(mut m) = dock_appbar_registered().lock() { m.remove(label); }
    if let Ok(mut m) = main_appbar_registered().lock() { m.remove(label); }
    if let Ok(mut m) = dock_extra_last_ignore().lock() { m.remove(label); }
    if let Ok(mut m) = notch_extra_last_ignore().lock() { m.remove(label); }
    if let Ok(mut m) = dock_extra_last_edge_hover().lock() { m.remove(label); }
    if let Ok(mut m) = notch_extra_last_edge_hover().lock() { m.remove(label); }
    if let Ok(mut m) = dock_extra_expiry_ms().lock() { m.remove(label); }
    if let Ok(mut m) = notch_extra_expiry_ms().lock() { m.remove(label); }
}

pub fn dock_label_for_monitor(monitor_id: &str) -> String {
    format!("dock-{monitor_id}")
}

pub fn notch_label_for_monitor(monitor_id: &str) -> String {
    format!("main-{monitor_id}")
}

pub fn is_dock_label(label: &str) -> bool {
    label == "dock" || label.starts_with("dock-")
}

pub fn is_notch_label(label: &str) -> bool {
    label == "main" || label.starts_with("main-")
}

pub fn monitor_suffix(label: &str) -> Option<&str> {
    label.split_once('-').map(|(_, id)| id)
}

pub static MONITOR_SYNC_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

pub static MENU_IS_OPEN: AtomicBool = AtomicBool::new(false);
pub static MENU_RECT: Mutex<Option<IntRect>> = Mutex::new(None);
pub static DOCK_IS_DRAGGING: AtomicBool = AtomicBool::new(false);
pub static ICON_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

pub static INSTALLED_APPS_CACHE: OnceLock<Mutex<Vec<AppInfo>>> = OnceLock::new();
pub static IS_SCANNING: AtomicBool = AtomicBool::new(false);

pub static BRIGHTNESS_SENDER: OnceLock<Sender<u32>> = OnceLock::new();
pub static CURRENT_BRIGHTNESS: AtomicU32 = AtomicU32::new(50);
pub static CURRENT_VOLUME: AtomicU32 = AtomicU32::new(50);
pub static LAST_BRIGHTNESS_CHANGE: AtomicI64 = AtomicI64::new(0);
pub static ANY_MEDIA_PLAYING: AtomicBool = AtomicBool::new(false);
pub static LAST_START_TOGGLE_MS: AtomicI64 = AtomicI64::new(0);
pub static OVERLAY_IN_SPLASH: AtomicBool = AtomicBool::new(false);
pub static SPLASH_FINISHED: AtomicBool = AtomicBool::new(false);
pub static CURRENT_FOREGROUND_FULLSCREEN: AtomicBool = AtomicBool::new(false);
pub static CURRENT_FOREGROUND_FULLSCREEN_ON_DOCK: AtomicBool = AtomicBool::new(false);
pub static CURRENT_FOREGROUND_SHELL_ON_DOCK: AtomicBool = AtomicBool::new(false);
pub static CURRENT_FOREGROUND_MAXIMIZED: AtomicBool = AtomicBool::new(false);

pub static SINGLE_INSTANCE_MUTEX_HANDLE: OnceLock<isize> = OnceLock::new();
pub static SINGLE_INSTANCE_EVENT_HANDLE: OnceLock<isize> = OnceLock::new();
pub static SINGLE_INSTANCE_WAITER: OnceLock<Mutex<Option<std::thread::JoinHandle<()>>>> = OnceLock::new();

pub fn close_single_instance_handles() {
    use std::sync::atomic::Ordering;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Threading::SetEvent;
    SHUTTING_DOWN.store(true, Ordering::SeqCst);
    if let Some(&h) = SINGLE_INSTANCE_EVENT_HANDLE.get() {
        if h != 0 {
            unsafe {
                let _ = SetEvent(HANDLE(h as *mut _));
            }
        }
    }
    if let Some(mtx) = SINGLE_INSTANCE_WAITER.get() {
        if let Some(handle) = mtx.lock().ok().and_then(|mut g| g.take()) {
            let _ = handle.join();
        }
    }
    if let Some(&h) = SINGLE_INSTANCE_MUTEX_HANDLE.get() {
        if h != 0 {
            unsafe { let _ = CloseHandle(HANDLE(h as *mut _)); }
        }
    }
    if let Some(&h) = SINGLE_INSTANCE_EVENT_HANDLE.get() {
        if h != 0 {
            unsafe { let _ = CloseHandle(HANDLE(h as *mut _)); }
        }
    }
}

pub static DISPLAY_MONITOR_HANDLE: OnceLock<AppHandle> = OnceLock::new();
pub static LAST_DISPLAY_CHANGE_MS: AtomicI64 = AtomicI64::new(0);

/// Mixer panel bounds (x, y, w, h) in overlay CSS px, None when collapsed.
pub static VOLUME_MIXER_RECT: Mutex<Option<(f64, f64, f64, f64)>> = Mutex::new(None);

/// Exe path to friendly name (FileDescription). Cached since the mixer polls every 2s.
pub static PROCESS_NAME_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

pub static THUMBNAIL_CACHE: OnceLock<Mutex<HashMap<isize, (String, i64)>>> = OnceLock::new();
pub static FOCUS_TIMESTAMPS: OnceLock<Mutex<HashMap<isize, i64>>> = OnceLock::new();
pub static SETTINGS_CACHE: OnceLock<Mutex<HashMap<String, serde_json::Value>>> = OnceLock::new();
