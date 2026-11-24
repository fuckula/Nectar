//! Proxy Shell_TrayWnd window on a dedicated thread that intercepts
//! Shell_NotifyIcon packets, clones icons safely, and forwards everything
//! transparently to Explorer's real Shell_TrayWnd.

use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

use windows::Win32::Foundation::*;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::DataExchange::COPYDATASTRUCT;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Registry::*;
use windows::Win32::System::Threading::*;
use windows::Win32::UI::Shell::{KNOWN_FOLDER_FLAG, SHGetKnownFolderPath};
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::core::{BOOL, GUID, HSTRING, PCWSTR, PWSTR, w};

use super::model::{self, Owner, Promotion};
use super::wire::{self, Notify};
use super::{OwnedIcon, Shared, lock};

pub const PROXY_PROP: PCWSTR = w!("Nectar.TrayProxy");
const CONTROL_CLASS: PCWSTR = w!("Nectar.TrayHost");
const TRAY_CLASS: PCWSTR = w!("Shell_TrayWnd");
pub const WM_OUTRANK: u32 = WM_APP + 17;
pub const WM_FORCE_REFRESH: u32 = WM_APP + 18;

const CHECK_TIMER: usize = 1;
const SETTINGS_TIMER: usize = 2;
const WATCH_TIMER: usize = 3;
const CHECK_MS: u32 = 1000;
const WATCH_MS: u32 = 100;
const WATCH_FOR: Duration = Duration::from_secs(3);
const OUTRANKED_REFRESH: u32 = 3;
const FORWARD_MS: u32 = 5000;
const OTHER_MS: u32 = 2000;
const SETTINGS_KEY: PCWSTR = w!(r"Control Panel\NotifyIconSettings");

thread_local! {
    static HOST: RefCell<Option<Host>> = const { RefCell::new(None) };
    static EXPLORER: Cell<usize> = const { Cell::new(0) };
    static SHARED: RefCell<Option<Arc<Shared>>> = const { RefCell::new(None) };
    static PROMOTIONS: RefCell<Vec<Promotion>> = const { RefCell::new(Vec::new()) };
    static BATCH_STATE: Cell<BatchState> = const { Cell::new(BatchState::Immediate) };
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum BatchState {
    Immediate,
    Batching,
    Dirty,
}

fn icons_changed(shared: &Shared) {
    if BATCH_STATE.get() == BatchState::Immediate {
        shared.notify_changed();
    } else {
        BATCH_STATE.set(BatchState::Dirty);
    }
}

fn publish_batch(shared: &Shared, keep_batching: bool) {
    let next = if keep_batching {
        BatchState::Batching
    } else {
        BatchState::Immediate
    };
    if BATCH_STATE.replace(next) == BatchState::Dirty {
        shared.notify_changed();
    }
}

struct Explorer {
    tray: HWND,
    pid: u32,
    process: HANDLE,
}

struct Host {
    shared: Arc<Shared>,
    instance: HINSTANCE,
    control: HWND,
    proxy: Option<HWND>,
    explorer: Option<Explorer>,
    taskbar_created: u32,
    mutex: HANDLE,
    settings: Option<HKEY>,
    settings_event: HANDLE,
    waiting: u8,
    refresh: IconRefresh,
    asked: HashSet<(u32, u32)>,
    outrank_losses: u8,
    outrank_loss_logged: bool,
}

pub fn run(shared: Arc<Shared>, ready: mpsc::Sender<Result<usize, String>>) {
    SHARED.with(|s| *s.borrow_mut() = Some(shared.clone()));
    match setup(shared) {
        Ok(host) => {
            let control = host.control.0 as usize;
            HOST.with(|h| *h.borrow_mut() = Some(host));
            if ready.send(Ok(control)).is_err() {
                teardown();
                return;
            }
            with_host(Host::refresh_if_ready);
            pump();
        }
        Err(message) => {
            let _ = ready.send(Err(message));
        }
    }
    teardown();
}

fn setup(shared: Arc<Shared>) -> Result<Host, String> {
    unsafe {
        let mutex = CreateMutexW(None, false, w!(r"Local\Nectar.TrayHost")).map_err(|e| e.message())?;
        if GetLastError() == ERROR_ALREADY_EXISTS {
            let _ = CloseHandle(mutex);
            return Err("Another Nectar tray host is already running".into());
        }
        let instance: HINSTANCE = GetModuleHandleW(None).map_err(|e| e.message())?.into();
        for (name, proc) in [
            (CONTROL_CLASS, Some(control_wndproc as unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT)),
            (TRAY_CLASS, Some(proxy_wndproc as unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT)),
        ] {
            let class = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: proc,
                hInstance: instance,
                lpszClassName: name,
                ..Default::default()
            };
            if RegisterClassExW(&class) == 0 && GetLastError() != ERROR_CLASS_ALREADY_EXISTS {
                let _ = CloseHandle(mutex);
                return Err(format!("RegisterClassExW failed: {:?}", GetLastError()));
            }
        }
        let control = CreateWindowExW(
            WS_EX_TOOLWINDOW,
            CONTROL_CLASS,
            w!("Nectar Tray Host"),
            WS_POPUP,
            0,
            0,
            0,
            0,
            None,
            None,
            Some(instance),
            None,
        )
        .map_err(|e| {
            let _ = CloseHandle(mutex);
            e.message()
        })?;
        let mut host = Host {
            shared,
            instance,
            control,
            proxy: None,
            explorer: None,
            taskbar_created: RegisterWindowMessageW(w!("TaskbarCreated")),
            mutex,
            settings: None,
            settings_event: CreateEventW(None, false, false, None).unwrap_or_default(),
            waiting: 0,
            refresh: IconRefresh::new(),
            asked: HashSet::new(),
            outrank_losses: 0,
            outrank_loss_logged: false,
        };
        let _ = ChangeWindowMessageFilterEx(control, host.taskbar_created, MSGFLT_ALLOW, None);
        host.watch_settings();
        if explorer_tray().is_none() {
            for _ in 0..5 {
                std::thread::sleep(Duration::from_millis(100));
                if explorer_tray().is_some() {
                    break;
                }
            }
        }
        if let Err(message) = host.attach() {
            // Stay alive when Explorer's Shell_TrayWnd isn't created yet (e.g. logon / explorer restart)
            // so CHECK_TIMER + TaskbarCreated can reattach lazily instead of aborting permanently.
            if explorer_tray().is_some() {
                host.close();
                return Err(message);
            }
        }
        SetTimer(Some(control), CHECK_TIMER, CHECK_MS, None);
        Ok(host)
    }
}

fn pump() {
    let mut msg = MSG::default();
    loop {
        let mut handles = [HANDLE::default(); 2];
        let mut count = 0usize;
        HOST.with(|h| {
            if let Some(host) = h.borrow().as_ref() {
                if let Some(explorer) = host.explorer.as_ref() {
                    if !explorer.process.is_invalid() {
                        handles[count] = explorer.process;
                        count += 1;
                    }
                }
                if !host.settings_event.is_invalid() && count < handles.len() {
                    handles[count] = host.settings_event;
                    count += 1;
                }
            }
        });
        let active = &handles[..count];
        let wait = unsafe { MsgWaitForMultipleObjectsEx(Some(active), INFINITE, QS_ALLINPUT, MWMO_INPUTAVAILABLE) };
        let index = wait.0.wrapping_sub(WAIT_OBJECT_0.0) as usize;
        if let Some(&handle) = active.get(index) {
            with_host(|host| host.signaled(handle));
        }
        while unsafe { PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE) }.as_bool() {
            if msg.message == WM_QUIT {
                return;
            }
            unsafe {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }
}

fn with_host(f: impl FnOnce(&mut Host)) {
    HOST.with(|h| {
        if let Ok(mut host) = h.try_borrow_mut() {
            if let Some(host) = host.as_mut() {
                f(host);
            }
        }
    });
}

fn teardown() {
    if let Some(mut host) = HOST.with(|h| h.borrow_mut().take()) {
        host.close();
    }
    EXPLORER.with(|e| e.set(0));
    SHARED.with(|s| s.borrow_mut().take());
}

#[derive(Debug, PartialEq, Eq)]
enum RefreshAction {
    Wait,
    Broadcast,
    CheckCallbacks,
}

struct IconRefresh {
    watch_until: Option<Instant>,
    outranked: u32,
}

impl IconRefresh {
    fn new() -> Self {
        Self {
            watch_until: None,
            outranked: 0,
        }
    }

    fn watching(&self, now: Instant) -> bool {
        self.watch_until.is_some_and(|end| now < end)
    }

    fn observe_loss(&mut self, now: Instant) {
        if self.watching(now) {
            self.outranked = OUTRANKED_REFRESH;
        }
    }

    fn next(&mut self, now: Instant, first: bool) -> RefreshAction {
        if !first {
            self.outranked = self.outranked.saturating_add(1);
            return RefreshAction::Wait;
        }
        if self.watch_until.is_none() {
            self.outranked = 0;
            self.watch_until = Some(now + WATCH_FOR);
            return RefreshAction::Broadcast;
        }
        if self.watching(now) {
            return RefreshAction::Wait;
        }
        if std::mem::take(&mut self.outranked) >= OUTRANKED_REFRESH {
            self.watch_until = Some(now + WATCH_FOR);
            return RefreshAction::Broadcast;
        }
        RefreshAction::CheckCallbacks
    }
}

fn missing_callback_windows(icons: &[super::Icon], asked: &mut HashSet<(u32, u32)>) -> Vec<(u32, u32)> {
    icons
        .iter()
        .filter(|icon| {
            icon.callback == 0
                && icon.hwnd != 0
                && icon.pid != 0
                && !icon.exes.iter().any(|e| e.ends_with(r"\explorer.exe"))
        })
        .filter(|icon| asked.insert((icon.pid, icon.hwnd)))
        .map(|icon| (icon.hwnd, icon.pid))
        .collect()
}

impl Host {
    fn attach(&mut self) -> Result<(), String> {
        let (tray, pid) = explorer_tray().ok_or("Explorer Shell_TrayWnd not found")?;
        unsafe {
            let process = OpenProcess(PROCESS_SYNCHRONIZE, false, pid).map_err(|e| e.message())?;
            self.explorer = Some(Explorer { tray, pid, process });
            EXPLORER.with(|e| e.set(tray.0 as usize));
            let mut rect = RECT::default();
            let _ = GetWindowRect(tray, &mut rect);
            let proxy = CreateWindowExW(
                WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
                TRAY_CLASS,
                PCWSTR::null(),
                WS_POPUP,
                rect.left,
                rect.top,
                rect.right - rect.left,
                rect.bottom - rect.top,
                None,
                None,
                Some(self.instance),
                None,
            )
            .map_err(|e| e.message())?;
            self.proxy = Some(proxy);
            let _ = SetPropW(proxy, PROXY_PROP, Some(HANDLE(1 as _)));
            let _ = ChangeWindowMessageFilterEx(proxy, WM_COPYDATA, MSGFLT_ALLOW, None);
            let _ = self.outrank();
        }
        self.waiting = 0;
        Ok(())
    }

    fn force_broadcast(&mut self) {
        if !self.outrank() && super::status() == super::TrayHostStatus::BlockedByZbid {
            return;
        }
        self.asked.clear();
        self.refresh = IconRefresh::new();
        self.refresh_if_ready();
    }

    fn refresh_if_ready(&mut self) {
        let first = self.outrank();
        let now = Instant::now();
        match self.refresh.next(now, first) {
            RefreshAction::Wait => {}
            RefreshAction::Broadcast => unsafe {
                self.batch_icon_changes();
                // SendNotifyMessageW is non-blocking so hung apps never stall the tray proxy.
                if let Err(error) = SendNotifyMessageW(HWND_BROADCAST, self.taskbar_created, WPARAM(0), LPARAM(0)) {
                    crate::diagnostics::log(&format!("tray_host: TaskbarCreated broadcast failed: {error}"));
                    self.refresh.observe_loss(now);
                }
            },
            RefreshAction::CheckCallbacks => self.ask_missing_callbacks(),
        }
    }

    fn ask_missing_callbacks(&mut self) {
        let windows = missing_callback_windows(&lock(&self.shared.model).icons, &mut self.asked);
        if windows.is_empty() {
            return;
        }
        self.batch_icon_changes();
        for (hwnd, pid) in windows {
            if !owner_alive(hwnd, pid) {
                continue;
            }
            let target = HWND(wire::handle(hwnd) as _);
            unsafe {
                let _ = PostMessageW(Some(target), self.taskbar_created, WPARAM(0), LPARAM(0));
            }
        }
    }

    fn batch_icon_changes(&self) {
        if unsafe { SetTimer(Some(self.control), WATCH_TIMER, WATCH_MS, None) } != 0
            && BATCH_STATE.get() == BatchState::Immediate
        {
            BATCH_STATE.set(BatchState::Batching);
        }
    }

    fn watch_tick(&mut self) {
        let watching = self.refresh.watching(Instant::now());
        if watching {
            self.outrank();
        } else {
            unsafe {
                let _ = KillTimer(Some(self.control), WATCH_TIMER);
            }
        }
        publish_batch(&self.shared, watching);
    }

    fn outrank(&mut self) -> bool {
        if super::status() == super::TrayHostStatus::BlockedByZbid {
            return false;
        }
        let Some(proxy) = self.proxy else { return false };
        let first = || unsafe { FindWindowW(TRAY_CLASS, None).is_ok_and(|found| found == proxy) };
        if first() {
            self.outrank_losses = 0;
            self.outrank_loss_logged = false;
            super::set_status(super::TrayHostStatus::Active);
            return true;
        }
        self.refresh.observe_loss(Instant::now());
        let won = unsafe {
            let _ = SetWindowPos(
                proxy,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
            );
            first()
        };
        if won {
            self.outrank_losses = 0;
            self.outrank_loss_logged = false;
            super::set_status(super::TrayHostStatus::Active);
        } else {
            self.outrank_losses = self.outrank_losses.saturating_add(1);
            if self.outrank_losses >= 3 {
                if !self.outrank_loss_logged {
                    self.outrank_loss_logged = true;
                    crate::diagnostics::log(
                        "tray_host: proxy Shell_TrayWnd cannot outrank Explorer (Windows ZBID restriction); falling back to native tray",
                    );
                }
                super::set_status(super::TrayHostStatus::BlockedByZbid);
                self.abort_blocked_by_zbid();
            }
        }
        won
    }

    fn abort_blocked_by_zbid(&mut self) {
        unsafe {
            let _ = KillTimer(Some(self.control), CHECK_TIMER);
            let _ = KillTimer(Some(self.control), SETTINGS_TIMER);
        }
        self.detach();
        unsafe {
            PostQuitMessage(0);
        }
    }

    fn detach(&mut self) {
        unsafe {
            let _ = KillTimer(Some(self.control), WATCH_TIMER);
        }
        BATCH_STATE.set(BatchState::Immediate);
        self.refresh = IconRefresh::new();
        self.asked.clear();
        EXPLORER.with(|e| e.set(0));
        if let Some(proxy) = self.proxy.take() {
            unsafe {
                let _ = RemovePropW(proxy, PROXY_PROP);
                let _ = DestroyWindow(proxy);
            }
        }
        if let Some(explorer) = self.explorer.take() {
            unsafe {
                let _ = CloseHandle(explorer.process);
            }
        }
        if super::status() != super::TrayHostStatus::BlockedByZbid {
            super::set_status(super::TrayHostStatus::Stopped);
        }
        lock(&self.shared.model).icons.clear();
        self.shared.notify_changed();
        self.waiting = 0;
    }

    fn close(&mut self) {
        self.detach();
        unsafe {
            let _ = KillTimer(Some(self.control), CHECK_TIMER);
            let _ = KillTimer(Some(self.control), SETTINGS_TIMER);
            let _ = DestroyWindow(self.control);
            if let Some(key) = self.settings.take() {
                let _ = RegCloseKey(key);
            }
            let _ = CloseHandle(self.settings_event);
            let _ = CloseHandle(self.mutex);
        }
    }

    fn signaled(&mut self, handle: HANDLE) {
        if self.explorer.as_ref().is_some_and(|e| e.process == handle) {
            self.detach();
        } else if handle == self.settings_event {
            unsafe {
                SetTimer(Some(self.control), SETTINGS_TIMER, 500, None);
            }
            self.watch_settings();
        }
    }

    fn taskbar_created(&mut self) {
        let current = explorer_tray();
        if let (Some(explorer), Some((tray, _))) = (&self.explorer, current) {
            if explorer.tray == tray {
                return;
            }
        }
        self.detach();
        if current.is_some() {
            self.reattach();
        }
    }

    fn reattach(&mut self) {
        if self.attach().is_ok() {
            self.refresh_if_ready();
        }
    }

    fn check(&mut self) {
        if super::status() == super::TrayHostStatus::BlockedByZbid {
            return;
        }
        match &self.explorer {
            Some(explorer) => {
                let mut pid = 0;
                let alive = unsafe {
                    IsWindow(Some(explorer.tray)).as_bool()
                        && GetWindowThreadProcessId(explorer.tray, Some(&mut pid)) != 0
                        && pid == explorer.pid
                };
                if !alive {
                    self.detach();
                    return;
                }
                if lock(&self.shared.model).retain(|icon| owner_alive(icon.hwnd, icon.pid)) {
                    icons_changed(&self.shared);
                }
                self.refresh_if_ready();
            }
            None => {
                if explorer_tray().is_some() {
                    self.waiting += 1;
                    if self.waiting >= 3 {
                        self.reattach();
                    }
                } else {
                    self.waiting = 0;
                }
            }
        }
    }

    fn watch_settings(&mut self) {
        unsafe {
            if self.settings.is_none() {
                let mut key = HKEY::default();
                if RegOpenKeyExW(HKEY_CURRENT_USER, SETTINGS_KEY, None, KEY_READ | KEY_NOTIFY, &mut key).is_ok() {
                    self.settings = Some(key);
                }
            }
            if let Some(key) = self.settings {
                let _ = RegNotifyChangeKeyValue(
                    key,
                    true,
                    REG_NOTIFY_CHANGE_NAME | REG_NOTIFY_CHANGE_LAST_SET,
                    Some(self.settings_event),
                    true,
                );
            }
        }
        reload_promotions();
    }

    fn reresolve(&mut self) {
        reload_promotions();
        let mut model = lock(&self.shared.model);
        let mut changed = false;
        for icon in &mut model.icons {
            changed |= resolve(icon);
        }
        drop(model);
        if changed {
            icons_changed(&self.shared);
        }
    }
}

fn reload_promotions() {
    let promotions = read_promotions();
    PROMOTIONS.with(|p| *p.borrow_mut() = promotions);
}

fn resolve(icon: &mut super::Icon) -> bool {
    PROMOTIONS.with(|p| {
        let promotions = p.borrow();
        let entry = model::promotion(&promotions, icon.guid, &icon.exes, icon.uid);
        let (promoted, order) = entry.map_or((None, None), |e| (e.promoted, e.order));
        let changed = icon.promoted != promoted || icon.order != order;
        icon.promoted = promoted;
        icon.order = order;
        changed
    })
}

fn owner_alive(hwnd: u32, pid: u32) -> bool {
    let hwnd = HWND(wire::handle(hwnd) as _);
    let mut current = 0;
    unsafe {
        IsWindow(Some(hwnd)).as_bool()
            && GetWindowThreadProcessId(hwnd, Some(&mut current)) != 0
            && (pid == 0 || current == pid)
    }
}

pub fn is_proxy_window(hwnd: HWND) -> bool {
    let mut pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        pid == std::process::id() || !GetPropW(hwnd, PROXY_PROP).is_invalid()
    }
}

static CACHED_EXPLORER_TRAY_HWND: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);
static CACHED_EXPLORER_TRAY_PID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// Returns Explorer's real primary Shell_TrayWnd HWND and PID, skipping our proxy.
pub fn explorer_tray() -> Option<(HWND, u32)> {
    let cached_raw = CACHED_EXPLORER_TRAY_HWND.load(std::sync::atomic::Ordering::Relaxed);
    let cached_pid = CACHED_EXPLORER_TRAY_PID.load(std::sync::atomic::Ordering::Relaxed);
    if cached_raw != 0 && cached_pid != 0 {
        let hwnd = HWND(cached_raw as _);
        let mut live_pid = 0u32;
        let still_valid = unsafe {
            IsWindow(Some(hwnd)).as_bool()
                && GetWindowThreadProcessId(hwnd, Some(&mut live_pid)) != 0
                && live_pid == cached_pid
                && !is_proxy_window(hwnd)
        };
        if still_valid {
            return Some((hwnd, cached_pid));
        }
        CACHED_EXPLORER_TRAY_HWND.store(0, std::sync::atomic::Ordering::Relaxed);
        CACHED_EXPLORER_TRAY_PID.store(0, std::sync::atomic::Ordering::Relaxed);
    }

    unsafe extern "system" fn enum_proc(hwnd: HWND, lp: LPARAM) -> BOOL {
        let out = &mut *(lp.0 as *mut Option<(HWND, u32)>);
        let mut class = [0u16; 32];
        let len = GetClassNameW(hwnd, &mut class) as usize;
        if len == "Shell_TrayWnd".len() && String::from_utf16_lossy(&class[..len]) == "Shell_TrayWnd" {
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid != std::process::id()
                && GetPropW(hwnd, PROXY_PROP).is_invalid()
                && process_path(pid).is_some_and(|p| p.to_lowercase().ends_with(r"\explorer.exe"))
            {
                *out = Some((hwnd, pid));
                return BOOL(0);
            }
        }
        BOOL(1)
    }
    let mut found: Option<(HWND, u32)> = None;
    unsafe {
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut found as *mut _ as isize));
    }
    if let Some((hwnd, pid)) = found {
        CACHED_EXPLORER_TRAY_HWND.store(hwnd.0 as isize, std::sync::atomic::Ordering::Relaxed);
        CACHED_EXPLORER_TRAY_PID.store(pid, std::sync::atomic::Ordering::Relaxed);
    }
    found
}

pub fn process_path(pid: u32) -> Option<String> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = [0u16; 1024];
        let mut len = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut len);
        let _ = CloseHandle(process);
        result.ok()?;
        Some(String::from_utf16_lossy(&buffer[..len as usize]))
    }
}

fn expand_known_folder(path: &str) -> Option<String> {
    let rest = path.strip_prefix('{')?;
    let (guid, rest) = rest.split_once('}')?;
    let guid = GUID::try_from(guid).ok()?;
    unsafe {
        let folder = SHGetKnownFolderPath(&guid, KNOWN_FOLDER_FLAG(0), None).ok()?;
        let base = folder.to_string().ok();
        CoTaskMemFree(Some(folder.0.cast()));
        Some(format!("{}{rest}", base?))
    }
}

fn exe_names(raw: &str) -> Vec<String> {
    let mut names = vec![model::normalize_exe(raw)];
    names.extend(expand_known_folder(raw).map(|path| model::normalize_exe(&path)));
    names
}

fn owner(n: &Notify) -> Owner {
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(HWND(wire::handle(n.hwnd) as _), Some(&mut pid)) };
    let mut exes: Vec<String> = process_path(pid)
        .map(|path| model::normalize_exe(&path))
        .into_iter()
        .collect();
    if !n.exe.is_empty() {
        exes.extend(exe_names(&n.exe));
    }
    exes.dedup();
    Owner { pid, exes }
}

fn read_promotions() -> Vec<Promotion> {
    let mut entries = Vec::new();
    unsafe {
        let mut key = HKEY::default();
        if RegOpenKeyExW(HKEY_CURRENT_USER, SETTINGS_KEY, None, KEY_READ, &mut key).is_err() {
            return entries;
        }
        let order = model::order_list(&reg_binary(key, PCWSTR::null(), w!("UIOrderList")));
        let mut index = 0;
        loop {
            let mut name = [0u16; 64];
            let mut len = name.len() as u32;
            if RegEnumKeyExW(
                key,
                index,
                Some(PWSTR(name.as_mut_ptr())),
                &mut len,
                None,
                None,
                None,
                None,
            )
            .is_err()
            {
                break;
            }
            index += 1;
            let name = String::from_utf16_lossy(&name[..len as usize]);
            let sub = HSTRING::from(&name);
            let exe = reg_string(key, &sub, w!("ExecutablePath")).unwrap_or_default();
            entries.push(Promotion {
                exes: exe_names(&exe),
                uid: reg_dword(key, &sub, w!("UID")),
                guid: reg_string(key, &sub, w!("IconGuid"))
                    .and_then(|guid| GUID::try_from(guid.trim_matches(['{', '}'])).ok()),
                promoted: reg_dword(key, &sub, w!("IsPromoted")).map(|value| value != 0),
                order: name
                    .parse::<u64>()
                    .ok()
                    .and_then(|id| order.iter().position(|&o| o == id)),
            });
        }
        let _ = RegCloseKey(key);
    }
    entries
}

fn reg_string(key: HKEY, sub: &HSTRING, value: PCWSTR) -> Option<String> {
    let mut buffer = [0u16; 1024];
    let mut size = (buffer.len() * 2) as u32;
    unsafe {
        RegGetValueW(
            key,
            sub,
            value,
            RRF_RT_REG_SZ,
            None,
            Some(buffer.as_mut_ptr().cast()),
            Some(&mut size),
        )
        .ok()
        .ok()?;
    }
    let units = (size as usize / 2).saturating_sub(1);
    Some(String::from_utf16_lossy(&buffer[..units.min(buffer.len())]))
}

fn reg_dword(key: HKEY, sub: &HSTRING, value: PCWSTR) -> Option<u32> {
    let mut data = 0u32;
    let mut size = 4u32;
    unsafe {
        RegGetValueW(
            key,
            sub,
            value,
            RRF_RT_REG_DWORD,
            None,
            Some((&mut data as *mut u32).cast()),
            Some(&mut size),
        )
        .ok()
        .ok()?;
    }
    Some(data)
}

fn reg_binary(key: HKEY, sub: PCWSTR, value: PCWSTR) -> Vec<u8> {
    let mut size = 0u32;
    unsafe {
        if RegGetValueW(key, sub, value, RRF_RT_REG_BINARY, None, None, Some(&mut size)).is_err() {
            return Vec::new();
        }
        let mut data = vec![0u8; size as usize];
        if RegGetValueW(
            key,
            sub,
            value,
            RRF_RT_REG_BINARY,
            None,
            Some(data.as_mut_ptr().cast()),
            Some(&mut size),
        )
        .is_err()
        {
            return Vec::new();
        }
        data.truncate(size as usize);
        data
    }
}

unsafe extern "system" fn control_wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_OUTRANK => with_host(|host| {
            host.outrank();
        }),
        WM_FORCE_REFRESH => with_host(Host::force_broadcast),
        WM_TIMER if wp.0 == CHECK_TIMER => with_host(Host::check),
        WM_TIMER if wp.0 == WATCH_TIMER => with_host(Host::watch_tick),
        WM_TIMER if wp.0 == SETTINGS_TIMER => {
            let _ = KillTimer(Some(hwnd), SETTINGS_TIMER);
            with_host(Host::reresolve);
        }
        WM_CLOSE => {
            PostQuitMessage(0);
        }
        _ => {
            let created = HOST.with(|h| h.try_borrow().ok().and_then(|h| h.as_ref().map(|h| h.taskbar_created)));
            if created.is_some_and(|created| created != 0 && created == msg) {
                with_host(Host::taskbar_created);
                return LRESULT(0);
            }
            return DefWindowProcW(hwnd, msg, wp, lp);
        }
    }
    LRESULT(0)
}

fn forward_copy(wp: WPARAM, tag: usize, bytes: &[u8]) -> LRESULT {
    let tray = HWND(EXPLORER.with(Cell::get) as _);
    if tray.is_invalid() {
        return LRESULT(0);
    }
    let data = COPYDATASTRUCT {
        dwData: tag,
        cbData: bytes.len() as u32,
        lpData: bytes.as_ptr() as *mut _,
    };
    let mut result = 0usize;
    let sent = unsafe {
        SendMessageTimeoutW(
            tray,
            WM_COPYDATA,
            wp,
            LPARAM(&data as *const _ as isize),
            SMTO_NORMAL | SMTO_ABORTIFHUNG,
            FORWARD_MS,
            Some(&mut result),
        )
    };
    if sent.0 == 0 {
        LRESULT(0)
    } else {
        LRESULT(result as isize)
    }
}

fn on_copy_data(wp: WPARAM, lp: LPARAM) -> LRESULT {
    let data = unsafe { (lp.0 as *const COPYDATASTRUCT).as_ref() };
    let Some(data) = data else { return LRESULT(0) };
    let bytes = if data.lpData.is_null() || data.cbData == 0 || data.cbData > (1 << 20) {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(data.lpData as *const u8, data.cbData as usize).to_vec() }
    };
    let Some(shared) = SHARED.with(|s| s.borrow().clone()) else {
        return forward_copy(wp, data.dwData, &bytes);
    };
    match data.dwData {
        wire::TAG_NOTIFY => {
            let Some(n) = wire::parse_notify(&bytes) else {
                return forward_copy(wp, data.dwData, &bytes);
            };
            let image = notify_image(&n);
            let known = {
                let model = lock(&shared.model);
                model.icons.iter().any(|icon| match n.guid {
                    Some(guid) => icon.guid == Some(guid),
                    None => icon.guid.is_none() && icon.hwnd == n.hwnd && icon.uid == n.uid,
                })
            };
            let owner = if n.op == wire::NIM_ADD || !known {
                owner(&n)
            } else {
                Owner::default()
            };
            let tray = HWND(EXPLORER.with(Cell::get) as _);
            let same_thread = unsafe {
                let sender = GetWindowThreadProcessId(HWND(wire::handle(n.hwnd) as _), None);
                sender != 0 && sender == GetWindowThreadProcessId(tray, None)
            };
            if same_thread {
                unsafe {
                    let _ = ReplyMessage(LRESULT(1));
                }
            }
            let result = forward_copy(wp, data.dwData, &bytes);
            let mut model = lock(&shared.model);
            if model.apply(&n, result.0 == 1, image, owner) {
                if let Some(icon) = model.find_mut(n.guid, n.hwnd, n.uid) {
                    resolve(icon);
                }
                drop(model);
                icons_changed(&shared);
            }
            result
        }
        wire::TAG_GET_RECT => {
            if let Some(query) = wire::parse_rect(&bytes) {
                let key = lock(&shared.model).find_query(&query).map(|icon| icon.key());
                if let Some(key) = key {
                    let rects = lock(&shared.rects);
                    if let Some(rect) = rects.icons.get(&key).or(rects.fallback.as_ref()) {
                        if let Some(reply) = wire::rect_reply(query.query, rect.left, rect.top, rect.right, rect.bottom) {
                            return LRESULT(reply as isize);
                        }
                    }
                }
            }
            reply_if_explorer_sender(wp);
            forward_copy(wp, data.dwData, &bytes)
        }
        _ => {
            reply_if_explorer_sender(wp);
            forward_copy(wp, data.dwData, &bytes)
        }
    }
}

fn reply_if_explorer_sender(wp: WPARAM) {
    let tray = HWND(EXPLORER.with(Cell::get) as _);
    if tray.is_invalid() || wp.0 == 0 {
        return;
    }
    unsafe {
        let sender = GetWindowThreadProcessId(HWND(wp.0 as _), None);
        if sender != 0 && sender == GetWindowThreadProcessId(tray, None) {
            let _ = ReplyMessage(LRESULT(0));
        }
    }
}

fn notify_image(n: &Notify) -> Option<Option<Arc<OwnedIcon>>> {
    if !matches!(n.op, wire::NIM_ADD | wire::NIM_MODIFY) || (n.flags & wire::NIF_ICON) == 0 {
        return None;
    }
    if n.hicon == 0 {
        return Some(None);
    }
    match unsafe { CopyIcon(HICON(wire::handle(n.hicon) as _)) } {
        Ok(copy) => Some(Some(Arc::new(OwnedIcon(copy)))),
        Err(_) => None,
    }
}

fn forward_other(msg: u32, wp: WPARAM, lp: LPARAM) -> Option<LRESULT> {
    let shell = msg == WM_COMMAND
        || (msg == WM_SYSCOMMAND && (wp.0 & 0xFFF0) == SC_TASKLIST as usize)
        || (WM_USER..0xC000).contains(&msg);
    let tray = HWND(EXPLORER.with(Cell::get) as _);
    if !shell || tray.is_invalid() {
        return None;
    }
    unsafe {
        if (InSendMessageEx(None) & (ISMEX_SEND | ISMEX_NOTIFY)) == ISMEX_SEND {
            let mut result = 0usize;
            let _ = SendMessageTimeoutW(
                tray,
                msg,
                wp,
                lp,
                SMTO_NORMAL | SMTO_ABORTIFHUNG,
                OTHER_MS,
                Some(&mut result),
            );
            Some(LRESULT(result as isize))
        } else {
            let _ = PostMessageW(Some(tray), msg, wp, lp);
            Some(LRESULT(0))
        }
    }
}

unsafe extern "system" fn proxy_wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if msg == WM_COPYDATA {
        return on_copy_data(wp, lp);
    }
    forward_other(msg, wp, lp).unwrap_or_else(|| DefWindowProcW(hwnd, msg, wp, lp))
}
