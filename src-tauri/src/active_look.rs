use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{IsWindow, SC_MINIMIZE, WM_NCACTIVATE, WM_NCDESTROY, WM_SYSCOMMAND};

unsafe extern "system" fn active_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, id: usize, _data: usize) -> LRESULT {
    if msg == WM_NCACTIVATE {
        return DefSubclassProc(hwnd, msg, WPARAM(1), lparam);
    }
    if msg == WM_NCDESTROY {
        let _ = RemoveWindowSubclass(hwnd, Some(active_proc), id);
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}

pub fn keep_active_look(hwnd: HWND) {
    unsafe {
        if IsWindow(Some(hwnd)).as_bool() {
            let _ = SetWindowSubclass(hwnd, Some(active_proc), 1, 0);
        }
    }
}

unsafe extern "system" fn no_minimize_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, id: usize, _data: usize) -> LRESULT {
    if msg == WM_SYSCOMMAND && (wparam.0 as u32 & 0xFFF0) == SC_MINIMIZE {
        return LRESULT(0);
    }
    if msg == WM_NCDESTROY {
        let _ = RemoveWindowSubclass(hwnd, Some(no_minimize_proc), id);
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}

pub fn prevent_minimize(hwnd: HWND) {
    unsafe {
        if IsWindow(Some(hwnd)).as_bool() {
            let _ = SetWindowSubclass(hwnd, Some(no_minimize_proc), 2, 0);
        }
    }
}
