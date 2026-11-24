use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::{LPARAM, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    HOT_KEY_MODIFIERS, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, MOD_WIN, RegisterHotKey,
    UnregisterHotKey, VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_LWIN,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetMessageW, MSG, PM_NOREMOVE, PeekMessageW, PostThreadMessageW, WM_APP, WM_HOTKEY, WM_USER,
};

use crate::state::{CURRENT_FOREGROUND_FULLSCREEN, HOTKEYS_PAUSED, SHUTTING_DOWN};
use crate::utils::get_setting_str;

const NOTCH_HOTKEY_ID: i32 = 1;
const LAUNCHER_HOTKEY_ID: i32 = 2;
const TRAYBAR_HOTKEY_ID: i32 = 3;
const RELOAD: u32 = WM_APP + 1;

static THREAD_ID: AtomicU32 = AtomicU32::new(0);
static HOTKEY_STATUS: OnceLock<Mutex<HotkeyStatus>> = OnceLock::new();
static APPLY_SYNC: OnceLock<(Mutex<(u64, u64)>, Condvar)> = OnceLock::new();

#[derive(Debug, Clone, serde::Serialize)]
pub struct HotkeyStatus {
    pub notch_ok: bool,
    pub notch_shortcut: String,
    pub launcher_ok: bool,
    pub launcher_shortcut: String,
    pub traybar_ok: bool,
    pub traybar_shortcut: String,
}

impl Default for HotkeyStatus {
    fn default() -> Self {
        Self {
            notch_ok: true,
            notch_shortcut: String::new(),
            launcher_ok: true,
            launcher_shortcut: String::new(),
            traybar_ok: true,
            traybar_shortcut: String::new(),
        }
    }
}

fn status_slot() -> &'static Mutex<HotkeyStatus> {
    HOTKEY_STATUS.get_or_init(|| Mutex::new(HotkeyStatus::default()))
}

fn apply_sync() -> &'static (Mutex<(u64, u64)>, Condvar) {
    APPLY_SYNC.get_or_init(|| (Mutex::new((0, 0)), Condvar::new()))
}

pub fn get_hotkey_status() -> HotkeyStatus {
    status_slot()
        .lock()
        .map(|s| s.clone())
        .unwrap_or_default()
}

pub fn set_hotkeys_paused(paused: bool) {
    HOTKEYS_PAUSED.store(paused, Ordering::SeqCst);
    reload();
}

#[derive(Default)]
struct RegisteredHotkeys {
    notch: bool,
    launcher: bool,
    traybar: bool,
}

fn register_spec(id: i32, spec: &str) -> bool {
    let Some((modifiers, key)) = crate::launchers::parse_shortcut(spec) else {
        crate::diagnostics::log(&format!("hotkey: could not read \"{spec}\""));
        return false;
    };
    let mut mods = MOD_NOREPEAT;
    for m in modifiers {
        mods |= match m {
            VK_LCONTROL => MOD_CONTROL,
            VK_LMENU => MOD_ALT,
            VK_LSHIFT => MOD_SHIFT,
            VK_LWIN => MOD_WIN,
            _ => HOT_KEY_MODIFIERS(0),
        };
    }
    unsafe {
        match RegisterHotKey(None, id, mods, key.0 as u32) {
            Ok(()) => true,
            Err(e) => {
                crate::diagnostics::log(&format!("hotkey: could not register \"{spec}\" (id={id}): {e}"));
                false
            }
        }
    }
}

fn build_status(
    notch_shortcut: String,
    notch_registered: bool,
    launcher_shortcut: String,
    launcher_registered: bool,
    traybar_shortcut: String,
    traybar_registered: bool,
) -> HotkeyStatus {
    HotkeyStatus {
        notch_ok: notch_shortcut.is_empty() || notch_registered,
        notch_shortcut,
        launcher_ok: launcher_shortcut.is_empty() || launcher_registered,
        launcher_shortcut,
        traybar_ok: traybar_shortcut.is_empty() || traybar_registered,
        traybar_shortcut,
    }
}

fn mark_apply_done() {
    let (lock, cvar) = apply_sync();
    if let Ok(mut state) = lock.lock() {
        state.1 = state.0;
        cvar.notify_all();
    }
}

fn apply(app: &AppHandle, reg: &mut RegisteredHotkeys) {
    unsafe {
        for (id, flag) in [
            (NOTCH_HOTKEY_ID, &mut reg.notch),
            (LAUNCHER_HOTKEY_ID, &mut reg.launcher),
            (TRAYBAR_HOTKEY_ID, &mut reg.traybar),
        ] {
            if *flag {
                let _ = UnregisterHotKey(None, id);
                *flag = false;
            }
        }
    }

    if HOTKEYS_PAUSED.load(Ordering::SeqCst) {
        mark_apply_done();
        return;
    }

    let notch_shortcut = get_setting_str(app, "nectar-notch-hotkey")
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if !notch_shortcut.is_empty() {
        reg.notch = register_spec(NOTCH_HOTKEY_ID, &notch_shortcut);
    }

    let legacy = get_setting_str(app, "nectar-legacy-mode").is_some_and(|v| v == "true");

    let launcher_enabled = !legacy
        && get_setting_str(app, "nectar-launcher-enabled")
            .map(|v| v != "false")
            .unwrap_or(true);
    let launcher_shortcut = if launcher_enabled {
        get_setting_str(app, "nectar-launcher-hotkey")
            .unwrap_or_else(|| "Alt+Space".to_string())
            .trim()
            .to_string()
    } else {
        String::new()
    };
    if !launcher_shortcut.is_empty() {
        reg.launcher = register_spec(LAUNCHER_HOTKEY_ID, &launcher_shortcut);
    }

    let tray_enabled = !legacy
        && get_setting_str(app, "nectar-tray-bar-enabled")
            .map(|v| v != "false")
            .unwrap_or(true);
    let traybar_shortcut = if tray_enabled {
        get_setting_str(app, "nectar-traybar-hotkey")
            .unwrap_or_else(|| "Alt+Shift+T".to_string())
            .trim()
            .to_string()
    } else {
        String::new()
    };
    if !traybar_shortcut.is_empty() {
        reg.traybar = register_spec(TRAYBAR_HOTKEY_ID, &traybar_shortcut);
    }

    let next_status = build_status(
        notch_shortcut,
        reg.notch,
        launcher_shortcut,
        reg.launcher,
        traybar_shortcut,
        reg.traybar,
    );
    if let Ok(mut slot) = status_slot().lock() {
        *slot = next_status.clone();
    }
    let _ = app.emit("hotkey-status-changed", &next_status);
    mark_apply_done();
}

fn handle_hotkey_trigger(app: &AppHandle, id: i32) {
    if SHUTTING_DOWN.load(Ordering::Relaxed) || HOTKEYS_PAUSED.load(Ordering::Relaxed) {
        return;
    }
    let legacy = get_setting_str(app, "nectar-legacy-mode").is_some_and(|v| v == "true");

    match id {
        NOTCH_HOTKEY_ID => {
            let _ = app.emit("notch-hotkey-toggle", ());
        }
        LAUNCHER_HOTKEY_ID => {
            if legacy {
                return;
            }
            if get_setting_str(app, "nectar-launcher-enabled").is_some_and(|v| v == "false") {
                return;
            }
            let suppress_fs = get_setting_str(app, "nectar-launcher-fullscreen-suppress")
                .map(|v| v != "false")
                .unwrap_or(true);
            if suppress_fs && CURRENT_FOREGROUND_FULLSCREEN.load(Ordering::Relaxed) {
                return;
            }
            let ah = app.clone();
            tauri::async_runtime::spawn(async move {
                crate::shell_windows::toggle_launcher_async(ah, None);
            });
        }
        TRAYBAR_HOTKEY_ID => {
            if legacy {
                return;
            }
            if get_setting_str(app, "nectar-tray-bar-enabled").is_some_and(|v| v == "false") {
                return;
            }
            let ah = app.clone();
            tauri::async_runtime::spawn(async move {
                crate::shell_windows::toggle_traybar_async(ah, None);
            });
        }
        _ => {}
    }
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || unsafe {
        let mut msg = MSG::default();
        let _ = PeekMessageW(&mut msg, None, WM_USER, WM_USER, PM_NOREMOVE);
        let mut registered = RegisteredHotkeys::default();
        apply(&app, &mut registered);
        THREAD_ID.store(GetCurrentThreadId(), Ordering::SeqCst);
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            match msg.message {
                WM_HOTKEY => {
                    handle_hotkey_trigger(&app, msg.wParam.0 as i32);
                }
                RELOAD => apply(&app, &mut registered),
                _ => {}
            }
        }
    });
}

pub fn reload() {
    let id = THREAD_ID.load(Ordering::SeqCst);
    if id == 0 {
        return;
    }
    let (lock, cvar) = apply_sync();
    let target_seq = if let Ok(mut state) = lock.lock() {
        state.0 = state.0.wrapping_add(1);
        state.0
    } else {
        0
    };
    let posted = unsafe { PostThreadMessageW(id, RELOAD, WPARAM(0), LPARAM(0)).is_ok() };
    if !posted || unsafe { GetCurrentThreadId() } == id || target_seq == 0 {
        return;
    }
    if let Ok(mut guard) = lock.lock() {
        let deadline = Instant::now() + Duration::from_millis(200);
        loop {
            if guard.1 == target_seq {
                break;
            }
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                break;
            };
            match cvar.wait_timeout(guard, remaining) {
                Ok((next_guard, wait_res)) => {
                    guard = next_guard;
                    if wait_res.timed_out() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_shortcut_never_reports_conflict_while_failed_nonempty_does() {
        let ok_status = build_status(
            "".into(),
            false,
            "Alt+Space".into(),
            true,
            "Alt+Shift+T".into(),
            false,
        );
        assert!(ok_status.notch_ok);
        assert!(ok_status.launcher_ok);
        assert!(!ok_status.traybar_ok);
        assert_eq!(ok_status.traybar_shortcut, "Alt+Shift+T");
    }

    #[test]
    fn set_hotkeys_paused_toggles_global_flag() {
        set_hotkeys_paused(true);
        assert!(HOTKEYS_PAUSED.load(Ordering::SeqCst));
        set_hotkeys_paused(false);
        assert!(!HOTKEYS_PAUSED.load(Ordering::SeqCst));
    }
}
