use std::sync::atomic::{AtomicBool, AtomicI64, AtomicIsize, AtomicU64, Ordering};
use std::sync::Mutex;
use windows::core::{Interface, BOOL};
use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, MonitorFromPoint, HDC, HMONITOR, MONITORINFO,
    MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationCondition, IUIAutomationElement,
    IUIAutomationInvokePattern, TreeScope_Descendants, UIA_InvokePatternId,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, EnumWindows, FindWindowA, GetAncestor, GetClassNameA, GetCursorPos,
    GetForegroundWindow, GetShellWindow, GetSystemMetrics, GetWindowRect,
    GetWindowThreadProcessId, IsWindow, IsWindowVisible, SetForegroundWindow, SetWindowPos,
    ShowWindow, GA_ROOT, HWND_TOPMOST, SM_CYVIRTUALSCREEN, SM_YVIRTUALSCREEN, SWP_NOACTIVATE,
    SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, SW_HIDE, SW_SHOWNA,
};

const CLOSE_REOPEN_DEBOUNCE_MS: i64 = 300;
const SHORTCUT_STEP_DELAY_MS: u64 = 40;

static AUTOMATION_LOCK: Mutex<()> = Mutex::new(());
static FLYOUT_OPEN: AtomicBool = AtomicBool::new(false);
static OPEN_COUNT: AtomicU64 = AtomicU64::new(0);
static PREVIOUS_FOREGROUND: AtomicIsize = AtomicIsize::new(0);
static OPENING: AtomicBool = AtomicBool::new(false);
static LAST_CLOSE_MS: AtomicI64 = AtomicI64::new(0);
static TRAY_RESTORE_NEEDED: AtomicBool = AtomicBool::new(false);
static WAS_HIDDEN_BY_NECTAR: AtomicBool = AtomicBool::new(false);

fn automation() -> windows::core::Result<IUIAutomation> {
    unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
}

fn find_window(class: &std::ffi::CStr) -> windows::core::Result<HWND> {
    unsafe {
        FindWindowA(
            windows::core::PCSTR(class.as_ptr() as *const u8),
            windows::core::PCSTR::null(),
        )
    }
}

fn foreground_description() -> String {
    let fg = unsafe { GetForegroundWindow() };
    if fg.0.is_null() {
        return "none".into();
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(fg, Some(&mut pid)) };
    format!("{} (pid {pid})", class_name(fg))
}

fn flyout_owns_focus() -> bool {
    let fg = unsafe { GetForegroundWindow() };
    if fg.0.is_null() {
        return true;
    }
    let root = unsafe { GetAncestor(fg, GA_ROOT) };
    let root = if root.0.is_null() { fg } else { root };
    matches!(
        class_name(root).as_str(),
        "Shell_TrayWnd"
            | "Shell_SecondaryTrayWnd"
            | "TopLevelWindowForOverflowXamlIsland"
            | "NotifyIconOverflowWindow"
    )
}

fn find_overflow_window() -> Option<HWND> {
    find_window(c"TopLevelWindowForOverflowXamlIsland")
        .or_else(|_| find_window(c"NotifyIconOverflowWindow"))
        .ok()
}

fn invoke_element(el: &IUIAutomationElement) -> bool {
    unsafe {
        let Ok(pattern) = el.GetCurrentPattern(UIA_InvokePatternId) else {
            return false;
        };
        let Ok(invoke_pattern) = pattern.cast::<IUIAutomationInvokePattern>() else {
            return false;
        };
        invoke_pattern.Invoke().is_ok()
    }
}

pub(crate) fn matches_tray_chevron(class_name: &str, automation_id: &str, name: &str) -> bool {
    if automation_id == "OverflowButton" {
        return false;
    }
    if class_name.eq_ignore_ascii_case("SystemTray.ChevronIconView") {
        return true;
    }
    if automation_id == "NotificationChevron" {
        return true;
    }
    let lower = name.to_lowercase();
    lower.contains("hidden icons")
        || lower.contains("скрытые значки")
        || lower.contains("gizli simge")
}

fn should_debounce_reopen(last_close_ms: i64, now_ms: i64) -> bool {
    let elapsed = now_ms - last_close_ms;
    last_close_ms > 0 && (0..CLOSE_REOPEN_DEBOUNCE_MS).contains(&elapsed)
}

pub(crate) fn is_xaml_content_bridge_class(cls: &str) -> bool {
    cls.to_ascii_lowercase().contains("desktopwindowcontentbridge")
}

pub(crate) fn should_keep_taskbar_hidden_with(
    dock_enabled: bool,
    _legacy_mode: bool,
    shutting_down: bool,
) -> bool {
    dock_enabled && !shutting_down
}

fn should_keep_taskbar_hidden() -> bool {
    should_keep_taskbar_hidden_with(
        crate::state::HOOK_DOCK_ENABLED.load(Ordering::Relaxed),
        crate::state::HOOK_LEGACY_MODE.load(Ordering::Relaxed),
        crate::state::SHUTTING_DOWN.load(Ordering::Relaxed),
    )
}

pub(crate) fn should_park_taskbar_while_open(
    was_hidden: bool,
    was_hidden_by_nectar: bool,
    keep_hidden: bool,
) -> bool {
    was_hidden || was_hidden_by_nectar || keep_hidden
}

pub(crate) fn should_rehide_taskbar_on_exit(
    restore_needed: bool,
    keep_hidden: bool,
    tray_visible: bool,
) -> bool {
    restore_needed || (keep_hidden && tray_visible)
}

fn find_chevron_in_element(
    root: &IUIAutomationElement,
    condition: &IUIAutomationCondition,
) -> Option<IUIAutomationElement> {
    unsafe {
        let all = root.FindAll(TreeScope_Descendants, condition).ok()?;
        for i in 0..all.Length().unwrap_or(0) {
            if let Ok(el) = all.GetElement(i) {
                let cls = el
                    .CurrentClassName()
                    .map(|s| s.to_string())
                    .unwrap_or_default();
                let automation_id = el
                    .CurrentAutomationId()
                    .map(|s| s.to_string())
                    .unwrap_or_default();
                let name = el.CurrentName().map(|s| s.to_string()).unwrap_or_default();
                if matches_tray_chevron(&cls, &automation_id, &name) {
                    return Some(el);
                }
            }
        }
        None
    }
}

fn find_show_hidden_icons_button(
    automation: &IUIAutomation,
    tray_hwnd: HWND,
    tray_root: &IUIAutomationElement,
) -> Option<IUIAutomationElement> {
    unsafe {
        let condition = automation.CreateTrueCondition().ok()?;
        if let Some(el) = find_chevron_in_element(tray_root, &condition) {
            return Some(el);
        }

        unsafe extern "system" fn collect_bridge_child(child: HWND, lparam: LPARAM) -> BOOL {
            let bridges = &mut *(lparam.0 as *mut Vec<HWND>);
            if is_xaml_content_bridge_class(&class_name(child)) {
                bridges.push(child);
            }
            BOOL(1)
        }

        let mut bridges: Vec<HWND> = Vec::new();
        let _ = EnumChildWindows(
            Some(tray_hwnd),
            Some(collect_bridge_child),
            LPARAM(&mut bridges as *mut _ as isize),
        );
        for child in bridges {
            if let Ok(bridge_root) = automation.ElementFromHandle(child) {
                if let Some(el) = find_chevron_in_element(&bridge_root, &condition) {
                    return Some(el);
                }
            }
        }
        None
    }
}

fn make_keyboard_input(
    vk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY,
    up: bool,
) -> windows::Win32::UI::Input::KeyboardAndMouse::INPUT {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY,
        KEYEVENTF_KEYUP, VK_LWIN, VK_RWIN,
    };
    let mut flags = if up {
        KEYEVENTF_KEYUP
    } else {
        KEYBD_EVENT_FLAGS(0)
    };
    if vk == VK_LWIN || vk == VK_RWIN {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: crate::utils::NECTAR_INJECTED_EXTRA_INFO,
            },
        },
    }
}

fn send_keys(keys: &[(windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY, bool)]) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT};
    let inputs: Vec<INPUT> = keys
        .iter()
        .map(|&(vk, up)| make_keyboard_input(vk, up))
        .collect();
    unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
}

fn send_keys_stepped(keys: &[(windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY, bool)]) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT};
    for (idx, &(vk, up)) in keys.iter().enumerate() {
        let input = [make_keyboard_input(vk, up)];
        unsafe { SendInput(&input, std::mem::size_of::<INPUT>() as i32) };
        if idx + 1 < keys.len() {
            std::thread::sleep(std::time::Duration::from_millis(SHORTCUT_STEP_DELAY_MS));
        }
    }
}

fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u8; 64];
    let len = unsafe { GetClassNameA(hwnd, &mut buf) }.max(0) as usize;
    String::from_utf8_lossy(&buf[..len]).into_owned()
}

fn taskbar_has_focus() -> bool {
    let fg = unsafe { GetForegroundWindow() };
    !fg.0.is_null()
        && matches!(
            class_name(fg).as_str(),
            "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
        )
}

fn any_context_menu_visible() -> bool {
    unsafe extern "system" fn enum_proc(hwnd: HWND, lp: LPARAM) -> BOOL {
        if !IsWindowVisible(hwnd).as_bool() {
            return BOOL(1);
        }
        let cls = class_name(hwnd);
        if cls == "#32768" || cls == "Xaml_WindowedPopupClass" {
            *(lp.0 as *mut bool) = true;
            return BOOL(0);
        }
        BOOL(1)
    }
    let mut visible = false;
    unsafe {
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut visible as *mut _ as isize));
    }
    visible
}

unsafe fn park_below_monitor(hwnd: HWND) {
    unsafe extern "system" fn collect_primary(
        hmon: HMONITOR,
        _: HDC,
        _: *mut RECT,
        lparam: LPARAM,
    ) -> BOOL {
        let out = &mut *(lparam.0 as *mut Option<RECT>);
        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(hmon, &mut mi).as_bool() && (mi.dwFlags & 1 != 0) {
            *out = Some(mi.rcMonitor);
            return BOOL(0);
        }
        BOOL(1)
    }
    let mut primary_rect: Option<RECT> = None;
    let _ = EnumDisplayMonitors(
        None,
        None,
        Some(collect_primary),
        LPARAM(&mut primary_rect as *mut _ as isize),
    );
    let vbottom = GetSystemMetrics(SM_YVIRTUALSCREEN) + GetSystemMetrics(SM_CYVIRTUALSCREEN) + 160;
    let (x, y) = match primary_rect {
        Some(m) => (m.left, vbottom.max(m.bottom + 40)),
        None => (-10000, vbottom.max(10000)),
    };
    let _ = SetWindowPos(
        hwnd,
        None,
        x,
        y,
        0,
        0,
        SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
    );
}

fn restore_foreground(target: HWND) -> bool {
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    unsafe {
        if !IsWindow(Some(target)).as_bool() {
            return false;
        }
        if SetForegroundWindow(target).as_bool() {
            return true;
        }
        let ours = GetCurrentThreadId();
        let fg = GetForegroundWindow();
        let theirs = if crate::utils::is_hwnd_responsive_for_attach(fg) {
            GetWindowThreadProcessId(fg, None)
        } else {
            0
        };
        let attached = theirs != 0 && theirs != ours && AttachThreadInput(ours, theirs, true).as_bool();
        let restored = SetForegroundWindow(target).as_bool();
        if attached {
            let _ = AttachThreadInput(ours, theirs, false);
        }
        restored
    }
}

fn leave_taskbar_focus(flyout: HWND, open_count: u64) {
    for _ in 0..30 {
        std::thread::sleep(std::time::Duration::from_millis(10));
        if !unsafe { IsWindowVisible(flyout) }.as_bool() {
            break;
        }
    }
    for _ in 0..20 {
        if OPEN_COUNT.load(Ordering::SeqCst) != open_count {
            return;
        }
        if taskbar_has_focus() {
            let mut previous = HWND(PREVIOUS_FOREGROUND.load(Ordering::SeqCst) as *mut _);
            if previous.0.is_null() || !unsafe { IsWindow(Some(previous)) }.as_bool() {
                previous = unsafe { GetShellWindow() };
            }
            let restored = restore_foreground(previous);
            crate::diagnostics::log(&format!(
                "tray: taskbar kept focus after closing, gave focus back to {}: {restored}",
                class_name(previous)
            ));
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

fn park_tray_if_on_screen(tray: HWND) {
    unsafe {
        let mut tray_rc = RECT::default();
        if IsWindow(Some(tray)).as_bool() && GetWindowRect(tray, &mut tray_rc).is_ok() {
            let vbottom = GetSystemMetrics(SM_YVIRTUALSCREEN) + GetSystemMetrics(SM_CYVIRTUALSCREEN);
            if tray_rc.top < vbottom {
                park_below_monitor(tray);
            }
        }
    }
}

fn open_with_shortcut(tray: HWND, park_while_open: bool, anchor: Option<(i32, i32)>) -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{VK_B, VK_LWIN, VK_RETURN};
    send_keys_stepped(&[(VK_LWIN, false), (VK_B, false), (VK_B, true), (VK_LWIN, true)]);

    let mut focused = false;
    for _ in 0..60 {
        std::thread::sleep(std::time::Duration::from_millis(10));
        if taskbar_has_focus() {
            focused = true;
            break;
        }
    }
    if !focused {
        crate::diagnostics::log("tray: taskbar never took focus, not sending Return");
        if park_while_open {
            unsafe { park_below_monitor(tray); }
        }
        return false;
    }
    send_keys_stepped(&[(VK_RETURN, false), (VK_RETURN, true)]);

    for _ in 0..60 {
        std::thread::sleep(std::time::Duration::from_millis(10));
        if let Some(flyout) = find_overflow_window() {
            if unsafe { IsWindowVisible(flyout) }.as_bool() {
                place_flyout(flyout, anchor);
                if park_while_open {
                    unsafe { park_below_monitor(tray); }
                }
                return true;
            }
        }
    }
    if park_while_open {
        unsafe { park_below_monitor(tray); }
    }
    false
}

fn describe_elements(automation: &IUIAutomation, root: &IUIAutomationElement) -> String {
    unsafe {
        let Ok(condition) = automation.CreateTrueCondition() else {
            return "no condition".into();
        };
        let Ok(all) = root.FindAll(TreeScope_Descendants, &condition) else {
            return "FindAll failed".into();
        };
        let count = all.Length().unwrap_or(0);
        let mut parts = Vec::new();
        for i in 0..count.min(40) {
            if let Ok(el) = all.GetElement(i) {
                let cls = el
                    .CurrentClassName()
                    .map(|s| s.to_string())
                    .unwrap_or_default();
                let id = el
                    .CurrentAutomationId()
                    .map(|s| s.to_string())
                    .unwrap_or_default();
                let name = el.CurrentName().map(|s| s.to_string()).unwrap_or_default();
                parts.push(format!("{cls}|{id}|{name}"));
            }
        }
        format!("count={count} [{}]", parts.join("; "))
    }
}

fn place_flyout(flyout: HWND, anchor: Option<(i32, i32)>) {
    unsafe {
        let mut cursor = POINT::default();
        let _ = GetCursorPos(&mut cursor);
        let (ax, ay) = anchor.unwrap_or((cursor.x, cursor.y - 4));
        let point = POINT { x: ax, y: ay };
        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        let _ = GetMonitorInfoW(MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST), &mut mi);
        let work = mi.rcWork;

        let mut rect = RECT::default();
        let _ = GetWindowRect(flyout, &mut rect);
        if rect.right - rect.left <= 50 {
            for _ in 0..10 {
                std::thread::sleep(std::time::Duration::from_millis(5));
                let _ = GetWindowRect(flyout, &mut rect);
                if rect.right - rect.left > 50 {
                    break;
                }
            }
        }
        let (w, h) = if rect.right - rect.left > 50 {
            (rect.right - rect.left, rect.bottom - rect.top)
        } else {
            (280, 220)
        };

        let x = (ax - w / 2).clamp(work.left + 8, (work.right - w - 8).max(work.left + 8));
        let below = ay + 10;
        let y = if below + h <= work.bottom - 8 {
            below
        } else {
            (ay - h - 10).max(work.top + 8)
        };
        let _ = SetWindowPos(
            flyout,
            Some(HWND_TOPMOST),
            x,
            y,
            0,
            0,
            SWP_NOSIZE | SWP_SHOWWINDOW,
        );
        let _ = SetForegroundWindow(flyout);
    }
}

pub fn warm_up() {
    let _com = crate::utils::ComApartmentGuard::init_mta();
    let Ok(_guard) = AUTOMATION_LOCK.try_lock() else {
        return;
    };
    let (Some(tray), Ok(auto)) = (crate::tray_host::explorer_tray_hwnd(), automation()) else {
        return;
    };
    if let Ok(root) = unsafe { auto.ElementFromHandle(tray) } {
        let _ = find_show_hidden_icons_button(&auto, tray, &root);
    }
}

struct OpeningFlag;

impl Drop for OpeningFlag {
    fn drop(&mut self) {
        OPENING.store(false, Ordering::SeqCst);
    }
}

pub fn open_native_tray(anchor: Option<(i32, i32)>) {
    let _com = crate::utils::ComApartmentGuard::init_mta();

    crate::diagnostics::log(&format!(
        "tray: open requested, anchor={anchor:?}, flyout_open={}",
        FLYOUT_OPEN.load(Ordering::SeqCst)
    ));
    if let Some(flyout) = find_overflow_window().filter(|&w| unsafe { IsWindowVisible(w) }.as_bool())
    {
        LAST_CLOSE_MS.store(crate::utils::get_now_ms(), Ordering::SeqCst);
        if unsafe { GetForegroundWindow() } == flyout {
            use windows::Win32::UI::Input::KeyboardAndMouse::VK_ESCAPE;
            send_keys(&[(VK_ESCAPE, false), (VK_ESCAPE, true)]);
            leave_taskbar_focus(flyout, OPEN_COUNT.load(Ordering::SeqCst));
        } else {
            unsafe {
                let _ = ShowWindow(flyout, SW_HIDE);
            }
        }
        FLYOUT_OPEN.store(false, Ordering::SeqCst);
        LAST_CLOSE_MS.store(crate::utils::get_now_ms(), Ordering::SeqCst);
        return;
    }

    if should_debounce_reopen(LAST_CLOSE_MS.load(Ordering::SeqCst), crate::utils::get_now_ms()) {
        crate::diagnostics::log("tray: ignoring reopen within close debounce");
        return;
    }

    if OPENING.swap(true, Ordering::SeqCst) {
        crate::diagnostics::log("tray: another open is still running");
        return;
    }
    let mut opening_guard = Some(OpeningFlag);
    let previous = unsafe { GetForegroundWindow() };
    let usable =
        !previous.0.is_null() && !taskbar_has_focus() && find_overflow_window() != Some(previous);
    PREVIOUS_FOREGROUND.store(if usable { previous.0 as isize } else { 0 }, Ordering::SeqCst);

    let waiting = std::time::Instant::now();
    let mut auto_guard = Some(loop {
        if let Ok(guard) = AUTOMATION_LOCK.try_lock() {
            break guard;
        }
        if waiting.elapsed().as_millis() > 2000 {
            crate::diagnostics::log("tray: another tray action is still running");
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    });
    if waiting.elapsed().as_millis() >= 20 {
        crate::diagnostics::log(&format!(
            "tray: waited {}ms for another tray action to finish",
            waiting.elapsed().as_millis()
        ));
    }

    let Some(tray) = crate::tray_host::explorer_tray_hwnd() else {
        crate::diagnostics::log("tray: Explorer Shell_TrayWnd not found");
        return;
    };
    let my_open_count = OPEN_COUNT.fetch_add(1, Ordering::SeqCst) + 1;

    let keep_hidden = should_keep_taskbar_hidden();
    let was_hidden = !unsafe { IsWindowVisible(tray) }.as_bool();
    if was_hidden {
        TRAY_RESTORE_NEEDED.store(true, Ordering::SeqCst);
        if crate::state::NATIVE_TASKBAR_HIDDEN.swap(false, Ordering::SeqCst) {
            WAS_HIDDEN_BY_NECTAR.store(true, Ordering::SeqCst);
        }
        unsafe {
            // Keep Shell_TrayWnd parked off-screen without WS_EX_LAYERED/LWA_ALPHA so
            // DirectComposition / XAML Island stays intact while UIA wakes up.
            park_below_monitor(tray);
            let _ = ShowWindow(tray, SW_SHOWNA);
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    let park_while_open = should_park_taskbar_while_open(
        was_hidden,
        WAS_HIDDEN_BY_NECTAR.load(Ordering::SeqCst),
        keep_hidden,
    );

    let mut opened = false;
    if let Ok(auto) = automation() {
        if let Ok(root) = unsafe { auto.ElementFromHandle(tray) } {
            let button = find_show_hidden_icons_button(&auto, tray, &root);
            if button.is_none() {
                crate::diagnostics::log(&format!(
                    "tray: hidden icons button not found: {}",
                    describe_elements(&auto, &root)
                ));
            }
            if let Some(button) = button {
                if invoke_element(&button) {
                    opened = true;
                    for _ in 0..40 {
                        if let Some(flyout) = find_overflow_window() {
                            if unsafe { IsWindowVisible(flyout) }.as_bool() {
                                place_flyout(flyout, anchor);
                                if park_while_open {
                                    unsafe { park_below_monitor(tray); }
                                }
                                break;
                            }
                        }
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    }
                }
            }
        }
    }

    if !opened {
        opened = open_with_shortcut(tray, park_while_open, anchor);
        crate::diagnostics::log(&format!("tray: open_with_shortcut opened={opened}"));
    }

    if opened {
        if park_while_open {
            park_tray_if_on_screen(tray);
        }
        FLYOUT_OPEN.store(true, Ordering::SeqCst);
        // Release OPENING & automation lock only after FLYOUT_OPEN is published so toggle-close
        // or a second open cannot preempt cleanup mid-transition.
        drop(auto_guard.take());
        drop(opening_guard.take());
        crate::diagnostics::log("tray: flyout opened and placed");
        std::thread::sleep(std::time::Duration::from_millis(200));
        let mut last_fg = String::new();
        for _ in 0..2400 {
            if OPEN_COUNT.load(Ordering::SeqCst) != my_open_count {
                return;
            }
            if should_park_taskbar_while_open(
                was_hidden,
                WAS_HIDDEN_BY_NECTAR.load(Ordering::SeqCst),
                keep_hidden,
            ) {
                park_tray_if_on_screen(tray);
            }
            let fg = foreground_description();
            if fg != last_fg {
                crate::diagnostics::log(&format!("tray: flyout open, foreground is now {fg}"));
                last_fg = fg;
            }
            match find_overflow_window().filter(|&w| unsafe { IsWindowVisible(w) }.as_bool()) {
                Some(flyout) => unsafe {
                    if flyout_owns_focus() {
                        let _ = SetWindowPos(
                            flyout,
                            Some(HWND_TOPMOST),
                            0,
                            0,
                            0,
                            0,
                            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                        );
                    }
                },
                None => {
                    if any_context_menu_visible() {
                        std::thread::sleep(std::time::Duration::from_millis(150));
                        continue;
                    }
                    crate::diagnostics::log("tray: flyout closed");
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
        LAST_CLOSE_MS.store(crate::utils::get_now_ms(), Ordering::SeqCst);
        FLYOUT_OPEN.store(false, Ordering::SeqCst);
    } else {
        drop(auto_guard.take());
        drop(opening_guard.take());
    }

    if OPEN_COUNT.load(Ordering::SeqCst) == my_open_count {
        let restore_needed = TRAY_RESTORE_NEEDED.swap(false, Ordering::SeqCst);
        let keep_hidden_now = should_keep_taskbar_hidden();
        let tray_visible = unsafe { IsWindowVisible(tray) }.as_bool();
        if should_rehide_taskbar_on_exit(restore_needed, keep_hidden_now, tray_visible) {
            if keep_hidden_now {
                unsafe {
                    let _ = ShowWindow(tray, SW_HIDE);
                    park_below_monitor(tray);
                }
                WAS_HIDDEN_BY_NECTAR.store(false, Ordering::SeqCst);
                crate::state::NATIVE_TASKBAR_HIDDEN.store(true, Ordering::SeqCst);
            } else {
                WAS_HIDDEN_BY_NECTAR.store(false, Ordering::SeqCst);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        is_xaml_content_bridge_class, matches_tray_chevron, should_debounce_reopen,
        should_keep_taskbar_hidden_with, should_park_taskbar_while_open,
        should_rehide_taskbar_on_exit, CLOSE_REOPEN_DEBOUNCE_MS,
    };

    #[test]
    fn matches_win11_chevron_and_rejects_overflow_button() {
        assert!(matches_tray_chevron("SystemTray.ChevronIconView", "", ""));
        assert!(matches_tray_chevron("systemtray.chevroniconview", "Anything", ""));
        assert!(matches_tray_chevron("", "NotificationChevron", ""));
        assert!(matches_tray_chevron("", "", "Show hidden icons"));
        assert!(matches_tray_chevron("", "", "Показать скрытые значки"));
        assert!(matches_tray_chevron("", "", "Gizli simgeleri göster"));

        assert!(!matches_tray_chevron("SystemTray.OverflowButton", "OverflowButton", "Overflow"));
        assert!(!matches_tray_chevron("", "OverflowButton", "Show hidden icons"));
        assert!(!matches_tray_chevron("Button", "StartButton", "Start"));
    }

    #[test]
    fn tray_close_debounce_blocks_immediate_reopen() {
        assert!(!should_debounce_reopen(0, 1_000));
        assert!(should_debounce_reopen(1_000, 1_000));
        assert!(should_debounce_reopen(1_000, 1_000 + CLOSE_REOPEN_DEBOUNCE_MS - 1));
        assert!(!should_debounce_reopen(1_000, 1_000 + CLOSE_REOPEN_DEBOUNCE_MS));
        assert!(!should_debounce_reopen(1_000, 900));
    }

    #[test]
    fn recognizes_win11_xaml_content_bridge_class() {
        assert!(is_xaml_content_bridge_class(
            "Windows.UI.Composition.DesktopWindowContentBridge"
        ));
        assert!(is_xaml_content_bridge_class("desktopwindowcontentbridge"));
        assert!(!is_xaml_content_bridge_class("TrayNotifyWnd"));
        assert!(!is_xaml_content_bridge_class("MSTaskSwWClass"));
    }

    #[test]
    fn taskbar_hidden_policies_handle_retries_and_legacy_mode() {
        assert!(should_keep_taskbar_hidden_with(true, false, false));
        assert!(!should_keep_taskbar_hidden_with(false, false, false));
        assert!(should_keep_taskbar_hidden_with(true, true, false));
        assert!(!should_keep_taskbar_hidden_with(true, false, true));

        assert!(should_park_taskbar_while_open(true, false, false));
        assert!(should_park_taskbar_while_open(false, true, false));
        assert!(should_park_taskbar_while_open(false, false, true));
        assert!(!should_park_taskbar_while_open(false, false, false));

        // Normal restore needed, or retry while tray remained visible under active Dock
        assert!(should_rehide_taskbar_on_exit(true, true, true));
        assert!(should_rehide_taskbar_on_exit(false, true, true));
        assert!(!should_rehide_taskbar_on_exit(false, true, false));
        assert!(!should_rehide_taskbar_on_exit(false, false, true));
    }
}
