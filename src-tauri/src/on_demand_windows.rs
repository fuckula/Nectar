use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const SETTINGS: &str = "settings";
pub const CALENDAR: &str = "calendar";

static SETTINGS_BUILDING: AtomicBool = AtomicBool::new(false);
static CALENDAR_BUILDING: AtomicBool = AtomicBool::new(false);
static WAITING_FOR_PAINT: Mutex<Option<HashSet<&'static str>>> = Mutex::new(None);
static PENDING_SETTINGS_TAB: Mutex<Option<String>> = Mutex::new(None);

const PAINT_WAIT: Duration = Duration::from_millis(2500);

fn take_waiting(label: &str) -> bool {
    let Ok(mut guard) = WAITING_FOR_PAINT.lock() else {
        return false;
    };
    guard.as_mut().is_some_and(|set| set.remove(label))
}

fn is_waiting(label: &str) -> bool {
    let Ok(guard) = WAITING_FOR_PAINT.lock() else {
        return false;
    };
    guard.as_ref().is_some_and(|set| set.contains(label))
}

fn start_waiting(label: &'static str) {
    if let Ok(mut guard) = WAITING_FOR_PAINT.lock() {
        guard.get_or_insert_with(HashSet::new).insert(label);
    }
}

struct Spec {
    label: &'static str,
    url: &'static str,
    title: &'static str,
    width: f64,
    height: f64,
    min_width: f64,
    min_height: f64,
}

const SETTINGS_SPEC: Spec = Spec {
    label: SETTINGS,
    url: "settings.html",
    title: "Settings",
    width: 760.0,
    height: 620.0,
    min_width: 620.0,
    min_height: 480.0,
};

const CALENDAR_SPEC: Spec = Spec {
    label: CALENDAR,
    url: "calendar.html",
    title: "Calendar",
    width: 880.0,
    height: 600.0,
    min_width: 700.0,
    min_height: 480.0,
};

fn spec_for(label: &str) -> Option<&'static Spec> {
    match label {
        SETTINGS => Some(&SETTINGS_SPEC),
        CALENDAR => Some(&CALENDAR_SPEC),
        _ => None,
    }
}

fn building_flag(label: &str) -> Option<&'static AtomicBool> {
    match label {
        SETTINGS => Some(&SETTINGS_BUILDING),
        CALENDAR => Some(&CALENDAR_BUILDING),
        _ => None,
    }
}

fn hide_window(win: &WebviewWindow) {
    let _ = win.hide();
    crate::webview_memory::set_low_memory(win, true);
    crate::memory_saver::trim_soon();
}

fn build(app: &AppHandle, spec: &Spec) -> Option<WebviewWindow> {
    let window = WebviewWindowBuilder::new(app, spec.label, WebviewUrl::App(spec.url.into()))
        .title(spec.title)
        .inner_size(spec.width, spec.height)
        .min_inner_size(spec.min_width, spec.min_height)
        .decorations(false)
        .transparent(true)
        .resizable(true)
        .maximizable(false)
        .minimizable(true)
        .closable(false)
        .always_on_top(false)
        .visible_on_all_workspaces(false)
        .focused(true)
        .skip_taskbar(false)
        .shadow(true)
        .visible(false)
        .center()
        .build()
        .ok()?;

    #[cfg(target_os = "windows")]
    if spec.label != SETTINGS {
        let _ = window_vibrancy::apply_acrylic(&window, Some((10, 10, 15, 20)));
    }
    if let Ok(hwnd) = window.hwnd() {
        let hwnd_raw = hwnd.0 as isize;
        let _ = app.run_on_main_thread(move || {
            crate::active_look::keep_active_look(windows::Win32::Foundation::HWND(hwnd_raw as *mut _));
        });
    }

    let win = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            hide_window(&win);
        }
    });

    crate::services::attach_webview_crash_watcher(app, &window);
    Some(window)
}

pub fn open(app: &AppHandle, label: &str) {
    crate::memory_saver::mark_interaction();

    if let Some(win) = app.get_webview_window(label) {
        present_on_main(app, win);
        return;
    }

    let Some(spec) = spec_for(label) else {
        return;
    };
    let Some(flag) = building_flag(label) else {
        return;
    };

    if flag.swap(true, Ordering::SeqCst) {
        return;
    }

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        start_waiting(spec.label);
        let (tx, rx) = tokio::sync::oneshot::channel();
        let app_for_build = app.clone();
        let built = if app
            .run_on_main_thread(move || {
                let _ = tx.send(build(&app_for_build, spec));
            })
            .is_ok()
        {
            match tokio::time::timeout(std::time::Duration::from_secs(5), rx).await {
                Ok(Ok(win)) => win,
                Ok(Err(_)) => None,
                Err(_) => {
                    crate::diagnostics::log(&format!(
                        "on_demand_windows: build timed out for {}",
                        spec.label
                    ));
                    None
                }
            }
        } else {
            None
        };
        if let Some(win) = built {
            tokio::time::sleep(PAINT_WAIT).await;
            if take_waiting(spec.label) {
                present_on_main(&app, win);
            }
        } else {
            let _ = take_waiting(spec.label);
        }
        flag.store(false, Ordering::SeqCst);
    });
}

pub fn open_settings_with_tab(app: &AppHandle, tab: Option<String>) {
    let clean_tab = tab
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());

    if let Some(win) = app.get_webview_window(SETTINGS) {
        if is_waiting(SETTINGS) {
            if let Ok(mut pending) = PENDING_SETTINGS_TAB.lock() {
                *pending = clean_tab;
            }
            present_on_main(app, win);
            return;
        }
        if let Ok(mut pending) = PENDING_SETTINGS_TAB.lock() {
            *pending = None;
        }
        present_on_main(app, win);
        if let Some(target_tab) = clean_tab {
            let _ = app.emit_to(SETTINGS, "settings-navigate", target_tab);
        }
        return;
    }

    if let Ok(mut pending) = PENDING_SETTINGS_TAB.lock() {
        *pending = clean_tab;
    }
    open(app, SETTINGS);
}

fn present_on_main(app: &AppHandle, win: WebviewWindow) {
    let _ = app.run_on_main_thread(move || {
        present(&win);
    });
}

fn present(win: &WebviewWindow) {
    crate::webview_memory::set_low_memory(win, false);
    let _ = win.show();
    if let Ok(hwnd) = win.hwnd() {
        unsafe {
            use windows::Win32::UI::WindowsAndMessaging::{
                IsIconic, ShowWindow, SW_RESTORE, SW_SHOW,
            };
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            } else {
                let _ = ShowWindow(hwnd, SW_SHOW);
            }
        }
        let raw_hwnd = hwnd.0 as isize;
        let _ = std::thread::Builder::new()
            .name("nectar-ondemand-fg".into())
            .spawn(move || {
                let _ = crate::utils::force_foreground(windows::Win32::Foundation::HWND(
                    raw_hwnd as *mut _,
                ));
            });
    }
    let _ = win.set_focus();
}

#[tauri::command]
pub fn on_demand_window_ready(app: AppHandle, window: tauri::Window) {
    let label = window.label();
    if take_waiting(label) {
        if let Some(win) = app.get_webview_window(label) {
            present(&win);
        }
    }
    if label == SETTINGS {
        if let Some(tab) = PENDING_SETTINGS_TAB.lock().ok().and_then(|mut g| g.take()) {
            let _ = app.emit_to(SETTINGS, "settings-navigate", tab);
        }
    }
}

#[tauri::command]
pub fn hide_on_demand_window(app: AppHandle, label: String) {
    if spec_for(&label).is_none() {
        return;
    }
    if let Some(win) = app.get_webview_window(&label) {
        hide_window(&win);
    }
}
