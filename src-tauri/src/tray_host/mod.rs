//! Crash-safe notification-area icon host for Nectar's Hidden Tray Bar & Dock.

#[path = "model.rs"]
pub mod model;
#[path = "proxy.rs"]
pub(crate) mod proxy;
#[path = "wire.rs"]
pub mod wire;

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicI64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, mpsc};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::{MONITOR_DEFAULTTONULL, MonitorFromPoint};
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize};
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::core::{Error, Result, w};

pub use model::{Action, Key};
pub use proxy::is_proxy_window;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TrayHostStatus {
    Active,
    BlockedByZbid,
    Stopped,
}

const STATUS_STOPPED: u8 = 0;
const STATUS_ACTIVE: u8 = 1;
const STATUS_BLOCKED_BY_ZBID: u8 = 2;

static HOST_STATUS: AtomicU8 = AtomicU8::new(STATUS_STOPPED);

pub(crate) fn set_status(status: TrayHostStatus) {
    let raw = match status {
        TrayHostStatus::Stopped => STATUS_STOPPED,
        TrayHostStatus::Active => STATUS_ACTIVE,
        TrayHostStatus::BlockedByZbid => STATUS_BLOCKED_BY_ZBID,
    };
    HOST_STATUS.store(raw, Ordering::SeqCst);
}

pub fn status() -> TrayHostStatus {
    match HOST_STATUS.load(Ordering::SeqCst) {
        STATUS_ACTIVE => TrayHostStatus::Active,
        STATUS_BLOCKED_BY_ZBID => TrayHostStatus::BlockedByZbid,
        _ => TrayHostStatus::Stopped,
    }
}

pub fn is_proxy_active() -> bool {
    status() == TrayHostStatus::Active
}

/// Returns Explorer's real primary Shell_TrayWnd HWND (never Nectar's proxy).
pub fn explorer_tray_hwnd() -> Option<HWND> {
    proxy::explorer_tray().map(|(hwnd, _)| hwnd)
}

/// Owned copy of a tray icon handle; automatically destroyed when dropped.
#[derive(Debug)]
pub struct OwnedIcon(pub HICON);
unsafe impl Send for OwnedIcon {}
unsafe impl Sync for OwnedIcon {}
impl Drop for OwnedIcon {
    fn drop(&mut self) {
        unsafe {
            let _ = DestroyIcon(self.0);
        }
    }
}

pub type Icon = model::Icon<Arc<OwnedIcon>>;

#[derive(Debug, Clone, Default)]
pub struct Rects {
    pub icons: HashMap<Key, RECT>,
    pub fallback: Option<RECT>,
}

pub struct Shared {
    pub model: Mutex<model::Model<Arc<OwnedIcon>>>,
    pub rects: Mutex<Rects>,
    app: Mutex<Option<AppHandle>>,
    png_cache: Mutex<HashMap<String, (u64, Option<String>)>>,
}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl Shared {
    pub fn notify_changed(&self) {
        if let Some(app) = lock(&self.app).clone() {
            let _ = app.emit("tray-icons-updated", ());
        }
    }
}

pub struct TrayHost {
    shared: Arc<Shared>,
    control: HWND,
    thread: Option<JoinHandle<()>>,
}

unsafe impl Send for TrayHost {}
unsafe impl Sync for TrayHost {}

impl TrayHost {
    pub fn start(app: AppHandle) -> Result<Self> {
        let shared = Arc::new(Shared {
            model: Mutex::default(),
            rects: Mutex::default(),
            app: Mutex::new(Some(app)),
            png_cache: Mutex::new(HashMap::new()),
        });
        let (ready_tx, ready_rx) = mpsc::channel();
        let thread_shared = shared.clone();
        let thread = std::thread::Builder::new()
            .name("nectar-tray-host".into())
            .spawn(move || proxy::run(thread_shared, ready_tx))
            .map_err(|e| Error::new(E_FAIL, e.to_string()))?;
        match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(control)) => Ok(Self {
                shared,
                control: HWND(control as _),
                thread: Some(thread),
            }),
            Ok(Err(message)) => {
                let _ = thread.join();
                Err(Error::new(E_FAIL, message))
            }
            Err(_) => Err(Error::new(E_FAIL, "Nectar tray host startup timed out")),
        }
    }

    pub fn is_finished(&self) -> bool {
        self.thread.as_ref().is_none_or(|t| t.is_finished())
    }

    pub fn outrank(&self) {
        if self.is_finished() {
            return;
        }
        unsafe {
            if IsWindow(Some(self.control)).as_bool() {
                let _ = PostMessageW(Some(self.control), proxy::WM_OUTRANK, WPARAM(0), LPARAM(0));
            }
        }
    }

    pub fn force_refresh(&self) {
        if self.is_finished() {
            return;
        }
        unsafe {
            if IsWindow(Some(self.control)).as_bool() {
                let _ = PostMessageW(Some(self.control), proxy::WM_FORCE_REFRESH, WPARAM(0), LPARAM(0));
            }
        }
    }
}

impl Drop for TrayHost {
    fn drop(&mut self) {
        if !self.is_finished() {
            unsafe {
                if IsWindow(Some(self.control)).as_bool() {
                    let _ = PostMessageW(Some(self.control), WM_CLOSE, WPARAM(0), LPARAM(0));
                }
            }
        }
        if let Some(thread) = self.thread.take() {
            // Reap the worker thread off-thread so stop/exit never blocks waiting on COM STA teardown.
            let _ = std::thread::Builder::new()
                .name("nectar-tray-reaper".into())
                .spawn(move || {
                    let _ = thread.join();
                });
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct TrayIconDto {
    pub key: String,
    pub title: String,
    pub exe_name: String,
    pub exe_path: String,
    pub pid: u32,
    pub icon: Option<String>,
    pub revision: u64,
    pub promoted: bool,
    pub hidden_by_app: bool,
    pub order: usize,
}

static HOST_INSTANCE: OnceLock<Mutex<Option<TrayHost>>> = OnceLock::new();
static LAST_REFRESH_MS: AtomicI64 = AtomicI64::new(0);

fn host_slot() -> &'static Mutex<Option<TrayHost>> {
    HOST_INSTANCE.get_or_init(|| Mutex::new(None))
}

pub fn start(app: AppHandle) {
    let legacy = crate::utils::get_setting_str(&app, "nectar-legacy-mode")
        .is_some_and(|v| v == "true");
    let enabled = !legacy
        && crate::utils::get_setting_str(&app, "nectar-tray-bar-enabled")
            .map(|v| v != "false")
            .unwrap_or(true);
    if !enabled || status() == TrayHostStatus::BlockedByZbid {
        return;
    }
    let mut guard = lock(host_slot());
    if let Some(existing) = guard.as_ref() {
        if !existing.is_finished() {
            return;
        }
        *guard = None;
    }
    match TrayHost::start(app) {
        Ok(host) => *guard = Some(host),
        Err(e) => {
            set_status(TrayHostStatus::Stopped);
            crate::diagnostics::log(&format!("tray_host: failed to start: {e}"));
        }
    }
}

pub fn stop() {
    if let Some(mutex) = HOST_INSTANCE.get() {
        let mut guard = lock(mutex);
        *guard = None;
    }
    set_status(TrayHostStatus::Stopped);
}

pub fn outrank() {
    if status() == TrayHostStatus::BlockedByZbid {
        return;
    }
    if let Some(mutex) = HOST_INSTANCE.get() {
        if let Some(host) = lock(mutex).as_ref() {
            host.outrank();
        }
    }
}

pub fn trigger_refresh() {
    if status() == TrayHostStatus::BlockedByZbid {
        return;
    }
    let now = crate::utils::get_now_ms();
    let prev = LAST_REFRESH_MS.load(Ordering::Relaxed);
    if now - prev < 1500 {
        return;
    }
    LAST_REFRESH_MS.store(now, Ordering::Relaxed);
    if let Some(mutex) = HOST_INSTANCE.get() {
        if let Some(host) = lock(mutex).as_ref() {
            host.force_refresh();
        }
    }
}

fn render_hicon_png(hicon: HICON) -> Option<String> {
    unsafe {
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        let need_uninit = hr.is_ok();
        let res = crate::utils::icon_to_base64(hicon);
        if need_uninit {
            CoUninitialize();
        }
        res
    }
}

pub fn list_icons() -> Vec<TrayIconDto> {
    if status() == TrayHostStatus::BlockedByZbid {
        return Vec::new();
    }
    let Some(mutex) = HOST_INSTANCE.get() else {
        return Vec::new();
    };
    let (shared, snapshot) = {
        let guard = lock(mutex);
        let Some(host) = guard.as_ref() else {
            return Vec::new();
        };
        let icons = lock(&host.shared.model).icons.clone();
        (host.shared.clone(), icons)
    };

    let own_pid = std::process::id();
    let mut items: Vec<(usize, TrayIconDto)> = Vec::new();
    let mut active_keys = Vec::with_capacity(snapshot.len());

    for (idx, icon) in snapshot.into_iter().enumerate() {
        if icon.pid == own_pid {
            continue;
        }
        let hwnd = HWND(wire::handle(icon.hwnd) as _);
        if !unsafe { IsWindow(Some(hwnd)).as_bool() } {
            continue;
        }
        if !icon.visible() {
            continue;
        }
        if icon.callback == 0 && icon.exes.iter().any(|e| e.ends_with(r"\explorer.exe")) {
            continue;
        }
        let key = icon.key().stable_id();
        active_keys.push(key.clone());

        let cached_png = {
            let cache = lock(&shared.png_cache);
            cache.get(&key).filter(|(rev, _)| *rev == icon.revision).map(|(_, png)| png.clone())
        };
        let png = match cached_png {
            Some(hit) => hit,
            None => {
                let rendered = icon.image.as_ref().and_then(|owned| render_hicon_png(owned.0));
                lock(&shared.png_cache).insert(key.clone(), (icon.revision, rendered.clone()));
                rendered
            }
        };

        let exe_path = icon.exes.first().cloned().unwrap_or_default();
        let exe_name = Path::new(&exe_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let title = if icon.tip.trim().is_empty() {
            exe_name.trim_end_matches(".exe").to_string()
        } else {
            icon.tip.trim().to_string()
        };

        let sort_order = icon.order.unwrap_or(10_000 + idx);
        items.push((
            sort_order,
            TrayIconDto {
                key,
                title,
                exe_name,
                exe_path,
                pid: icon.pid,
                icon: png,
                revision: icon.revision,
                promoted: icon.promoted.unwrap_or(false),
                hidden_by_app: (icon.state & wire::NIS_HIDDEN) != 0,
                order: sort_order,
            },
        ));
    }

    {
        let mut cache = lock(&shared.png_cache);
        cache.retain(|k, _| active_keys.contains(k));
    }

    items.sort_by_key(|(ord, dto)| (*ord, dto.title.to_lowercase()));
    items.into_iter().map(|(_, dto)| dto).collect()
}

pub fn interact_icon(
    key: &str,
    action: &str,
    screen_x: i32,
    screen_y: i32,
    rect: Option<(i32, i32, i32, i32)>,
) -> std::result::Result<(), String> {
    let parsed_action = match action {
        "left" => Action::Click,
        "double" => Action::DoubleClick,
        "right" => Action::Menu,
        "middle" => Action::MiddleClick,
        other => return Err(format!("Unknown tray action: {other}")),
    };

    let (shared, icon) = {
        let mutex = HOST_INSTANCE.get().ok_or("Tray host not started")?;
        let guard = lock(mutex);
        let host = guard.as_ref().ok_or("Tray host not active")?;
        let icon = lock(&host.shared.model)
            .find_by_stable_id(key)
            .cloned()
            .ok_or_else(|| "Tray icon no longer present".to_string())?;
        (host.shared.clone(), icon)
    };

    let (screen_x, screen_y) = unsafe {
        let invalid = (screen_x == 0 && screen_y == 0)
            || MonitorFromPoint(POINT { x: screen_x, y: screen_y }, MONITOR_DEFAULTTONULL).is_invalid();
        if invalid {
            let mut cursor = POINT::default();
            if GetCursorPos(&mut cursor).is_ok() {
                (cursor.x, cursor.y)
            } else {
                (screen_x, screen_y)
            }
        } else {
            (screen_x, screen_y)
        }
    };

    let r = rect.unwrap_or((screen_x - 12, screen_y - 12, screen_x + 12, screen_y + 12));
    {
        let mut rects = lock(&shared.rects);
        rects.icons.insert(
            icon.key(),
            RECT {
                left: r.0,
                top: r.1,
                right: r.2,
                bottom: r.3,
            },
        );
    }

    let hwnd = HWND(wire::handle(icon.hwnd) as _);
    unsafe {
        let mut pid = 0u32;
        if !IsWindow(Some(hwnd)).as_bool() || GetWindowThreadProcessId(hwnd, Some(&mut pid)) == 0 {
            return Err("The icon's window has closed".into());
        }
        if icon.pid != 0 && pid != icon.pid {
            return Err("The icon's window handle was reassigned".into());
        }
        if icon.callback == 0 {
            if icon.pid != 0 {
                let message = RegisterWindowMessageW(w!("TaskbarCreated"));
                let _ = PostMessageW(Some(hwnd), message, WPARAM(0), LPARAM(0));
            }
            return Err("Icon callback not ready yet; requested refresh".into());
        }
        let _ = AllowSetForegroundWindow(pid);
        if parsed_action == Action::Menu || parsed_action == Action::Click {
            if !SetForegroundWindow(hwnd).as_bool() {
                use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
                let fg = GetForegroundWindow();
                if crate::utils::is_hwnd_responsive_for_attach(fg) {
                    let ours = GetCurrentThreadId();
                    let theirs = GetWindowThreadProcessId(fg, None);
                    let attached = theirs != 0 && theirs != ours && AttachThreadInput(ours, theirs, true).as_bool();
                    let _ = SetForegroundWindow(hwnd);
                    if attached {
                        let _ = AttachThreadInput(ours, theirs, false);
                    }
                }
            }
        }
        for event in model::events(parsed_action, icon.version) {
            let (wp, lp) = model::callback_words(icon.version, icon.uid, event, screen_x, screen_y);
            PostMessageW(Some(hwnd), icon.callback, WPARAM(wp), LPARAM(lp)).map_err(|e| e.message())?;
        }
    }
    Ok(())
}
