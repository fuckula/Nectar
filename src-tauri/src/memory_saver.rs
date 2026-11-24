use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::Duration;

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::ProcessStatus::EmptyWorkingSet;
use windows::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

const SETTLE_MS: i64 = 4_000;
const LONG_IDLE_RETRIM_MS: i64 = 180_000;
const STARTUP_GRACE_MS: i64 = 8_000;

static BUSY: AtomicBool = AtomicBool::new(false);
static LAST_INTERACTION_MS: AtomicI64 = AtomicI64::new(0);
static INTERACTION_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
static TRIM_SOON: AtomicBool = AtomicBool::new(false);
static STARTED_AT_MS: AtomicI64 = AtomicI64::new(0);

#[derive(Debug, Default)]
pub struct IdleTrimState {
    last_trimmed_seq: u64,
    last_trim_ms: i64,
}

impl IdleTrimState {
    pub fn should_trim(&mut self, interaction_seq: u64, now_ms: i64, forced: bool) -> bool {
        if forced {
            self.last_trimmed_seq = interaction_seq;
            self.last_trim_ms = now_ms;
            return true;
        }
        if self.last_trimmed_seq != interaction_seq {
            self.last_trimmed_seq = interaction_seq;
            self.last_trim_ms = now_ms;
            return true;
        }
        if now_ms.saturating_sub(self.last_trim_ms) >= LONG_IDLE_RETRIM_MS {
            self.last_trim_ms = now_ms;
            return true;
        }
        false
    }
}

pub fn init() {
    let now = crate::utils::get_now_ms();
    STARTED_AT_MS.store(now, Ordering::Relaxed);
    LAST_INTERACTION_MS.store(now, Ordering::Relaxed);
}

pub fn mark_interaction() {
    LAST_INTERACTION_MS.store(crate::utils::get_now_ms(), Ordering::Relaxed);
    INTERACTION_SEQ.fetch_add(1, Ordering::Relaxed);
    TRIM_SOON.store(false, Ordering::Relaxed);
}

pub fn set_busy(busy: bool) {
    BUSY.store(busy, Ordering::Relaxed);
}

pub fn trim_soon() {
    TRIM_SOON.store(true, Ordering::Relaxed);
}

pub fn trim_now() -> u32 {
    mark_interaction();
    trim_tree() as u32
}

fn system_idle_ms() -> i64 {
    unsafe {
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if !GetLastInputInfo(&mut info).as_bool() {
            return i64::MAX;
        }
        let now = windows::Win32::System::SystemInformation::GetTickCount();
        let elapsed = now.wrapping_sub(info.dwTime);
        elapsed as i64
    }
}

fn foreground_is_ours() -> bool {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return false;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        pid == std::process::id()
    }
}

fn tree_pids() -> Vec<u32> {
    let mut pids = Vec::with_capacity(8);
    let me = std::process::id();

    unsafe {
        let snapshot = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(h) => h,
            Err(_) => return vec![me],
        };
        if snapshot.is_invalid() {
            return vec![me];
        }

        let mut children: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };

        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                children
                    .entry(entry.th32ParentProcessID)
                    .or_default()
                    .push(entry.th32ProcessID);
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);

        let mut queue = std::collections::VecDeque::from([me]);
        while let Some(pid) = queue.pop_front() {
            pids.push(pid);
            if let Some(kids) = children.get(&pid) {
                for &kid in kids {
                    if kid != pid && !pids.contains(&kid) && queue.len() < 64 {
                        queue.push_back(kid);
                    }
                }
            }
        }
    }

    pids
}

fn trim_pid(pid: u32) -> bool {
    unsafe {
        if pid == std::process::id() {
            return EmptyWorkingSet(GetCurrentProcess()).is_ok();
        }

        let handle: HANDLE = match OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_QUOTA,
            false,
            pid,
        ) {
            Ok(h) => h,
            Err(_) => return false,
        };
        let ok = EmptyWorkingSet(handle).is_ok();
        let _ = CloseHandle(handle);
        ok
    }
}

pub fn trim_tree() -> usize {
    let mut trimmed = 0;
    for pid in tree_pids() {
        if trim_pid(pid) {
            trimmed += 1;
        }
    }
    trimmed
}

pub fn start_reclaim_worker(_app: tauri::AppHandle) {
    std::thread::Builder::new()
        .name("nectar-mem".into())
        .spawn(move || {
            let mut trim_state = IdleTrimState::default();

            loop {
                let ram_saver = crate::state::RAM_SAVER_ENABLED.load(Ordering::Relaxed);
                let sleep_ms = if ram_saver { 2_000 } else { 5_000 };
                std::thread::sleep(Duration::from_millis(sleep_ms));

                if crate::state::SHUTTING_DOWN.load(Ordering::Relaxed) {
                    continue;
                }

                let now = crate::utils::get_now_ms();
                if now.saturating_sub(STARTED_AT_MS.load(Ordering::Relaxed)) < STARTUP_GRACE_MS {
                    continue;
                }

                if !ram_saver {
                    continue;
                }

                let busy = BUSY.load(Ordering::Relaxed)
                    || crate::state::MENU_IS_OPEN.load(Ordering::Relaxed)
                    || crate::state::DOCK_IS_DRAGGING.load(Ordering::Relaxed)
                    || crate::state::OVERLAY_IN_SPLASH.load(Ordering::Relaxed);

                if busy {
                    mark_interaction();
                    continue;
                }

                let forced = TRIM_SOON.swap(false, Ordering::Relaxed);
                if !forced && foreground_is_ours() {
                    mark_interaction();
                    continue;
                }

                let since_interaction = now.saturating_sub(LAST_INTERACTION_MS.load(Ordering::Relaxed));
                let idle = since_interaction.min(system_idle_ms());

                if !forced && idle < SETTLE_MS {
                    continue;
                }

                let seq = INTERACTION_SEQ.load(Ordering::Relaxed);
                if trim_state.should_trim(seq, now, forced) {
                    let _ = trim_tree();
                }
            }
        })
        .ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_saver_idle_state() {
        let mut state = IdleTrimState::default();
        assert!(state.should_trim(1, 10_000, false));
        // Repeated polls in the same idle episode must NOT thrash EmptyWorkingSet every 2s.
        assert!(!state.should_trim(1, 12_000, false));
        assert!(!state.should_trim(1, 100_000, false));
        // Long idle gentle retrim triggers after 180s.
        assert!(state.should_trim(1, 190_000, false));
        assert!(!state.should_trim(1, 195_000, false));
        // New user interaction sequence resets so next idle trims cleanly once.
        assert!(state.should_trim(2, 200_000, false));
        assert!(!state.should_trim(2, 202_000, false));
        // Forced trim-on-hide always succeeds once.
        assert!(state.should_trim(2, 203_000, true));
        assert!(!state.should_trim(2, 205_000, false));
    }
}
