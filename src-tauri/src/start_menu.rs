//! Nectar Start Menu backend: solo Win-key tap tracker, pinned apps storage,
//! Windows Recent items, all-apps snapshot, user profile & power commands.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::{is_aumid_path, launch_path, open_settings_window};
use crate::launcher::{app_index, providers};
use crate::types::AppInfo;
use crate::utils::{get_now_ms, resolve_shortcut};

const VK_LWIN_CODE: u16 = 0x5B;
const VK_RWIN_CODE: u16 = 0x5C;
const VK_B_CODE: u16 = 0x42;
const VK_L_CODE: u16 = 0x4C;

/// Top-row digits 1-9 to a zero-based dock slot.
pub fn win_number_index(vk: u16) -> Option<u8> {
    match vk {
        0x31..=0x39 => Some((vk - 0x31) as u8),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum WinKeyState {
    #[default]
    Idle,
    PendingSolo {
        vk: u16,
        scan: u16,
    },
    PromotedToChord {
        vk: u16,
    },
    ConsumedByNectar {
        vk: u16,
        swallowed_keys: HashSet<u16>,
    },
}

#[derive(Debug, Clone, Copy, Default)]
pub struct WinHookPolicy {
    pub start_hook_enabled: bool,
    pub win_b_enabled: bool,
    pub win_number_enabled: bool,
    pub fullscreen_blocks_win_chords: bool,
    pub pre_held_modifier: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WinChordAction {
    OpenTray,
    DockWinNumber(u8),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WinHookOutcome {
    Pass,
    Swallow,
    SwallowAndToggleStart,
    SwallowAndDispatch(WinChordAction),
    SwallowAndMaskDispatch(WinChordAction),
    ReplayWinDownAndPass { win_vk: u16, win_scan: u16 },
}

/// Swallow-DOWN + delayed-replay state machine distinguishing a solo physical Win tap
/// from OS chords (`Win+E/D/R/Tab/Shift+S/L`), Nectar chords (`Win+B`, `Win+1..9`),
/// pre-held modifiers (`Ctrl+Win`), and `Win+Mouse`.
#[derive(Debug, Default)]
pub struct WinKeyStateMachine {
    pub state: WinKeyState,
    other_keys_down: HashSet<u16>,
    pending_swallowed_ups: HashSet<u16>,
    passthrough_win_down: bool,
    passthrough_swallowed: HashSet<u16>,
}

impl WinKeyStateMachine {
    pub fn on_key(
        &mut self,
        vk: u16,
        scan: u16,
        is_down: bool,
        injected: bool,
        extra_info: usize,
        policy: WinHookPolicy,
        is_down_fn: impl Fn(u16) -> bool,
    ) -> WinHookOutcome {
        if injected || extra_info == crate::utils::NECTAR_INJECTED_EXTRA_INFO {
            return WinHookOutcome::Pass;
        }

        if vk == VK_LWIN_CODE || vk == VK_RWIN_CODE {
            if is_down {
                self.prune_released_keys(&is_down_fn);
                return match &self.state {
                    WinKeyState::Idle => {
                        if policy.start_hook_enabled && !policy.pre_held_modifier {
                            self.state = WinKeyState::PendingSolo { vk, scan };
                            self.passthrough_win_down = false;
                            WinHookOutcome::Swallow
                        } else {
                            self.passthrough_win_down = !policy.fullscreen_blocks_win_chords
                                && !policy.pre_held_modifier
                                && self.other_keys_down.is_empty();
                            WinHookOutcome::Pass
                        }
                    }
                    WinKeyState::PendingSolo { .. } | WinKeyState::ConsumedByNectar { .. } => {
                        WinHookOutcome::Swallow
                    }
                    WinKeyState::PromotedToChord { .. } => WinHookOutcome::Pass,
                };
            } else {
                let prev = std::mem::replace(&mut self.state, WinKeyState::Idle);
                match prev {
                    WinKeyState::PendingSolo { vk: cur_vk, scan: cur_scan } => {
                        if vk == cur_vk {
                            return WinHookOutcome::SwallowAndToggleStart;
                        }
                        self.state = WinKeyState::PendingSolo { vk: cur_vk, scan: cur_scan };
                        return WinHookOutcome::Pass;
                    }
                    WinKeyState::ConsumedByNectar { vk: cur_vk, swallowed_keys } => {
                        if vk == cur_vk {
                            self.pending_swallowed_ups.extend(swallowed_keys);
                            return WinHookOutcome::Swallow;
                        }
                        self.state = WinKeyState::ConsumedByNectar { vk: cur_vk, swallowed_keys };
                        return WinHookOutcome::Pass;
                    }
                    WinKeyState::PromotedToChord { vk: cur_vk } => {
                        if vk != cur_vk {
                            self.state = WinKeyState::PromotedToChord { vk: cur_vk };
                        }
                        return WinHookOutcome::Pass;
                    }
                    WinKeyState::Idle => {
                        self.passthrough_win_down = false;
                        return WinHookOutcome::Pass;
                    }
                }
            }
        }

        if is_down {
            self.pending_swallowed_ups.remove(&vk);
            let clean_win_chord = !policy.pre_held_modifier && self.other_keys_down.is_empty();
            let chord_action = if !clean_win_chord {
                None
            } else if vk == VK_B_CODE && policy.win_b_enabled {
                Some(WinChordAction::OpenTray)
            } else if policy.win_number_enabled {
                win_number_index(vk).map(WinChordAction::DockWinNumber)
            } else {
                None
            };

            match &mut self.state {
                WinKeyState::Idle => {
                    if self.passthrough_win_down {
                        if let Some(action) = chord_action {
                            if self.passthrough_swallowed.insert(vk) {
                                return WinHookOutcome::SwallowAndMaskDispatch(action);
                            }
                            return WinHookOutcome::Swallow;
                        }
                    }
                    self.other_keys_down.insert(vk);
                    WinHookOutcome::Pass
                }
                WinKeyState::PendingSolo { vk: win_vk, scan: win_scan } => {
                    // Key auto-repeat from a key already held before Win DOWN (e.g. WASD in games)
                    // must pass through without promoting PendingSolo into a fake Win chord.
                    if self.other_keys_down.contains(&vk) {
                        return WinHookOutcome::Pass;
                    }
                    let win_vk = *win_vk;
                    let win_scan = *win_scan;
                    if let Some(action) = chord_action {
                        let mut swallowed = HashSet::new();
                        swallowed.insert(vk);
                        self.state = WinKeyState::ConsumedByNectar {
                            vk: win_vk,
                            swallowed_keys: swallowed,
                        };
                        return WinHookOutcome::SwallowAndDispatch(action);
                    }
                    if vk == VK_L_CODE {
                        self.state = WinKeyState::Idle;
                    } else {
                        self.state = WinKeyState::PromotedToChord { vk: win_vk };
                        self.other_keys_down.insert(vk);
                    }
                    WinHookOutcome::ReplayWinDownAndPass { win_vk, win_scan }
                }
                WinKeyState::PromotedToChord { .. } => {
                    self.other_keys_down.insert(vk);
                    WinHookOutcome::Pass
                }
                WinKeyState::ConsumedByNectar { swallowed_keys, .. } => {
                    if let Some(action) = chord_action {
                        if swallowed_keys.insert(vk) {
                            return WinHookOutcome::SwallowAndDispatch(action);
                        }
                        return WinHookOutcome::Swallow;
                    }
                    self.other_keys_down.insert(vk);
                    WinHookOutcome::Pass
                }
            }
        } else {
            self.other_keys_down.remove(&vk);
            if self.passthrough_swallowed.remove(&vk) || self.pending_swallowed_ups.remove(&vk) {
                return WinHookOutcome::Swallow;
            }
            match &mut self.state {
                WinKeyState::ConsumedByNectar { swallowed_keys, .. }
                    if swallowed_keys.contains(&vk) =>
                {
                    swallowed_keys.remove(&vk);
                    WinHookOutcome::Swallow
                }
                _ => WinHookOutcome::Pass,
            }
        }
    }

    pub fn on_mouse_button(&mut self) -> Option<(u16, u16)> {
        self.passthrough_win_down = false;
        if let WinKeyState::PendingSolo { vk, scan } = self.state {
            self.state = WinKeyState::PromotedToChord { vk };
            Some((vk, scan))
        } else {
            None
        }
    }

    pub fn reset_to_idle_on_uipi(&mut self, win_vk: u16) {
        if matches!(self.state, WinKeyState::PromotedToChord { vk } if vk == win_vk) {
            self.state = WinKeyState::Idle;
        }
    }

    pub fn reset_all(&mut self) {
        self.state = WinKeyState::Idle;
        self.other_keys_down.clear();
        self.pending_swallowed_ups.clear();
        self.passthrough_win_down = false;
        self.passthrough_swallowed.clear();
    }

    pub fn prune_released_keys(&mut self, is_down_fn: impl Fn(u16) -> bool) {
        self.other_keys_down.retain(|&vk| is_down_fn(vk));
        // Swallowed chord keys (`pending_swallowed_ups`, `passthrough_swallowed`) never reached
        // win32k, so GetAsyncKeyState returns false for them even while still held physically;
        // they clear on their next keyup, keydown, or reset_all (desktop switch).
        if self.passthrough_win_down && !is_down_fn(VK_LWIN_CODE) && !is_down_fn(VK_RWIN_CODE) {
            self.passthrough_win_down = false;
        }
        if let WinKeyState::PromotedToChord { vk } = self.state {
            if !is_down_fn(vk) {
                self.state = WinKeyState::Idle;
            }
        }
    }
}

static TRACKER: OnceLock<Mutex<WinKeyStateMachine>> = OnceLock::new();

fn tracker() -> &'static Mutex<WinKeyStateMachine> {
    TRACKER.get_or_init(|| Mutex::new(WinKeyStateMachine::default()))
}

pub fn handle_hook_key(
    vk: u16,
    scan: u16,
    is_down: bool,
    injected: bool,
    extra_info: usize,
    policy: WinHookPolicy,
    is_down_fn: impl Fn(u16) -> bool,
) -> WinHookOutcome {
    let Ok(mut guard) = tracker().lock() else {
        return WinHookOutcome::Pass;
    };
    guard.on_key(vk, scan, is_down, injected, extra_info, policy, is_down_fn)
}

pub fn promote_win_on_mouse() -> Option<(u16, u16)> {
    let Ok(mut guard) = tracker().lock() else {
        return None;
    };
    guard.on_mouse_button()
}

pub fn reset_win_on_uipi(win_vk: u16) {
    if let Ok(mut guard) = tracker().lock() {
        guard.reset_to_idle_on_uipi(win_vk);
    }
}

pub fn reset_win_hook_state() {
    if let Ok(mut guard) = tracker().lock() {
        guard.reset_all();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartPinItem {
    pub name: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executable: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecommendedItem {
    pub id: String,
    pub kind: String, // "app" | "file"
    pub title: String,
    pub subtitle: String,
    pub path: String,
    pub args: Option<String>,
    pub icon: Option<String>,
    pub timestamp_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct UserFolderLink {
    pub id: String,
    pub label: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct StartUserProfile {
    pub display_name: String,
    pub avatar: Option<String>,
    pub folders: Vec<UserFolderLink>,
}

fn pins_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("start_pins.json"))
}

fn normalize_pin_key(path: &str) -> String {
    path.trim().to_ascii_lowercase()
}

pub fn sanitize_pin_name(name: &str) -> String {
    let trimmed = name.trim();
    if let Some(open) = trimmed.rfind(" (") {
        if let Some(rest) = trimmed[open + 2..].strip_suffix(')') {
            if !rest.is_empty() && rest.len() <= 2 && rest.bytes().all(|b| b.is_ascii_digit()) {
                let base = trimmed[..open].trim_end();
                if !base.is_empty() {
                    return base.to_string();
                }
            }
        }
    }
    trimmed.to_string()
}

fn is_dead_placeholder_store_pin(item: &StartPinItem) -> bool {
    item.name.trim().eq_ignore_ascii_case("App")
        && item.path.trim().to_ascii_lowercase().starts_with("shell:appsfolder\\")
}

fn sanitize_loaded_pins(pins: Vec<StartPinItem>) -> (Vec<StartPinItem>, bool) {
    let mut cleaned = Vec::with_capacity(pins.len());
    let mut changed = false;
    let mut seen = HashSet::new();
    for mut item in pins {
        if is_dead_placeholder_store_pin(&item) {
            changed = true;
            continue;
        }
        let next_name = sanitize_pin_name(&item.name);
        if next_name != item.name {
            item.name = next_name;
            changed = true;
        }
        let key = normalize_pin_key(&item.path);
        if !key.is_empty() && seen.insert(key) {
            cleaned.push(item);
        } else {
            changed = true;
        }
    }
    (cleaned, changed)
}

fn read_pins_disk(app: &AppHandle) -> Option<Vec<StartPinItem>> {
    let path = pins_file_path(app).ok()?;
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn write_pins_disk(app: &AppHandle, pins: &[StartPinItem]) -> Result<(), String> {
    let path = pins_file_path(app)?;
    providers::atomic_write_json(&path, &pins)?;
    let _ = app.emit("start-pins-updated", ());
    Ok(())
}

fn push_pin_unique(pins: &mut Vec<StartPinItem>, seen: &mut HashSet<String>, item: StartPinItem) {
    let key = normalize_pin_key(&item.path);
    if !key.is_empty() && seen.insert(key) {
        pins.push(item);
    }
}

fn seed_default_pins() -> Vec<StartPinItem> {
    let mut pins: Vec<StartPinItem> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    // Seed from existing Windows taskbar pins (inside COM init)
    let taskbar_apps: Vec<AppInfo> = unsafe {
        use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize};
        let com = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
        let res = crate::taskbar_pins::read_pins().unwrap_or_default();
        if com {
            CoUninitialize();
        }
        res
    };

    for app in taskbar_apps {
        let name = sanitize_pin_name(&app.name);
        push_pin_unique(
            &mut pins,
            &mut seen,
            StartPinItem {
                name,
                path: app.path,
                args: app.args,
                executable: app.executable,
                icon: app.icon,
            },
        );
    }

    // Supplement with essential Windows apps/tools up to a clean 12-tile 2-row grid
    let installed = app_index::collect_installed_apps_for_start();
    let preferred = [
        "explorer",
        "edge",
        "chrome",
        "firefox",
        "terminal",
        "code",
        "notepad",
        "calculator",
        "settings",
        "store",
    ];
    for kw in preferred {
        if pins.len() >= 12 {
            break;
        }
        if let Some(app) = installed
            .iter()
            .find(|a| a.name.to_ascii_lowercase().contains(kw))
        {
            push_pin_unique(
                &mut pins,
                &mut seen,
                StartPinItem {
                    name: app.name.clone(),
                    path: app.path.clone(),
                    args: app.args.clone(),
                    executable: app.executable.clone(),
                    icon: app.icon.clone(),
                },
            );
        }
    }

    let fallbacks = [
        ("File Explorer", r"C:\Windows\explorer.exe", Some("explorer.exe")),
        ("Windows Terminal", "wt.exe", Some("wt.exe")),
        ("Notepad", "notepad.exe", Some("notepad.exe")),
        ("Windows Settings", "ms-settings:", None),
        ("Task Manager", "taskmgr.exe", Some("taskmgr.exe")),
        ("Nectar Settings", "nectar-settings", None),
    ];
    for (name, path, exe) in fallbacks {
        if pins.len() >= 12 {
            break;
        }
        push_pin_unique(
            &mut pins,
            &mut seen,
            StartPinItem {
                name: name.to_string(),
                path: path.to_string(),
                args: None,
                executable: exe.map(|s| s.to_string()),
                icon: None,
            },
        );
    }

    pins
}

pub(crate) fn toggle_pin_entry(
    app: &AppHandle,
    name: &str,
    path: &str,
    args: Option<&str>,
) -> Result<bool, String> {
    let mut pins = read_pins_disk(app).unwrap_or_else(seed_default_pins);
    let target_key = normalize_pin_key(path);
    if let Some(idx) = pins
        .iter()
        .position(|p| normalize_pin_key(&p.path) == target_key)
    {
        pins.remove(idx);
        write_pins_disk(app, &pins)?;
        Ok(false)
    } else {
        let exe = Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string());
        pins.push(StartPinItem {
            name: name.to_string(),
            path: path.to_string(),
            args: args.map(|s| s.to_string()),
            executable: exe,
            icon: None,
        });
        write_pins_disk(app, &pins)?;
        Ok(true)
    }
}

fn resolve_loaded_or_seeded_pins(
    disk_pins: Option<Vec<StartPinItem>>,
    seed_fn: impl FnOnce() -> Vec<StartPinItem>,
) -> (Vec<StartPinItem>, bool) {
    if let Some(existing) = disk_pins {
        let (cleaned, changed) = sanitize_loaded_pins(existing);
        return (cleaned, changed);
    }
    let seeded = seed_fn();
    let should_write = !seeded.is_empty();
    (seeded, should_write)
}

#[tauri::command]
pub async fn get_start_pins(app: AppHandle) -> Vec<StartPinItem> {
    if let Some(existing) = read_pins_disk(&app) {
        let (pins, should_write) = resolve_loaded_or_seeded_pins(Some(existing), Vec::new);
        if should_write {
            let _ = write_pins_disk(&app, &pins);
        }
        return pins;
    }
    let seeded = tauri::async_runtime::spawn_blocking(seed_default_pins)
        .await
        .unwrap_or_default();
    if !seeded.is_empty() {
        let _ = write_pins_disk(&app, &seeded);
    }
    seeded
}

#[tauri::command]
pub async fn save_start_pins(app: AppHandle, pins: Vec<StartPinItem>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_pins_disk(&app, &pins))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn pin_to_start(app: AppHandle, item: StartPinItem) -> Result<Vec<StartPinItem>, String> {
    let mut pins = get_start_pins(app.clone()).await;
    let key = normalize_pin_key(&item.path);
    if !pins.iter().any(|p| normalize_pin_key(&p.path) == key) {
        pins.push(item);
        write_pins_disk(&app, &pins)?;
    }
    Ok(pins)
}

#[tauri::command]
pub async fn unpin_from_start(app: AppHandle, path: String) -> Result<Vec<StartPinItem>, String> {
    let mut pins = get_start_pins(app.clone()).await;
    let key = normalize_pin_key(&path);
    pins.retain(|p| normalize_pin_key(&p.path) != key);
    write_pins_disk(&app, &pins)?;
    Ok(pins)
}

#[tauri::command]
pub async fn get_start_all_apps() -> Vec<AppInfo> {
    tauri::async_runtime::spawn_blocking(app_index::collect_installed_apps_for_start)
        .await
        .unwrap_or_default()
}

fn read_recent_files(limit: usize) -> Vec<RecommendedItem> {
    let Ok(appdata) = std::env::var("APPDATA") else {
        return Vec::new();
    };
    let recent_dir = Path::new(&appdata).join(r"Microsoft\Windows\Recent");
    let Ok(entries) = std::fs::read_dir(&recent_dir) else {
        return Vec::new();
    };

    let mut raw_links: Vec<(i64, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let p = entry.path();
            if !p.extension().is_some_and(|e| e.eq_ignore_ascii_case("lnk")) {
                return None;
            }
            let ts = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            Some((ts, p))
        })
        .collect();

    raw_links.sort_by(|a, b| b.0.cmp(&a.0));

    let mut items = Vec::new();
    let mut seen = HashSet::new();
    unsafe {
        use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize};
        let com = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
        for (ts, lnk_path) in raw_links.into_iter().take(limit * 4) {
            let lnk_str = lnk_path.to_string_lossy().to_string();
            let Some((target, _)) = resolve_shortcut(&lnk_str) else {
                continue;
            };
            let target_path = Path::new(&target);
            if target.trim().is_empty() || !target_path.is_file() {
                continue;
            }
            let lower = target.to_ascii_lowercase();
            if lower.ends_with(".tmp") || lower.ends_with(".ini") || !seen.insert(lower) {
                continue;
            }
            let title = lnk_path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .or_else(|| target_path.file_name().map(|s| s.to_string_lossy().to_string()))
                .unwrap_or_else(|| target.clone());
            let subtitle = target_path
                .parent()
                .and_then(|p| p.file_name().or_else(|| Some(p.as_os_str())))
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "Recent file".to_string());

            items.push(RecommendedItem {
                id: format!("recent:{}", target.to_ascii_lowercase()),
                kind: "file".to_string(),
                title,
                subtitle,
                path: target,
                args: None,
                icon: None,
                timestamp_ms: ts,
            });
            if items.len() >= limit {
                break;
            }
        }
        if com {
            CoUninitialize();
        }
    }
    items
}

static RECENT_FILES_CACHE: OnceLock<Mutex<(i64, usize, Vec<RecommendedItem>)>> = OnceLock::new();
static USER_PROFILE_CACHE: OnceLock<StartUserProfile> = OnceLock::new();

#[tauri::command]
pub async fn get_start_recommended(app: AppHandle) -> Vec<RecommendedItem> {
    let mru = providers::top_mru_entries(&app, 4);
    let now_recent = get_now_ms();
    let cached_recent = RECENT_FILES_CACHE
        .get_or_init(|| Mutex::new((0, 0, Vec::new())))
        .lock()
        .ok()
        .and_then(|g| {
            if now_recent - g.0 < 30_000 && g.1 >= 6 {
                Some(g.2.clone())
            } else {
                None
            }
        });
    let recent_files = match cached_recent {
        Some(list) => list,
        None => {
            let fresh = tauri::async_runtime::spawn_blocking(|| read_recent_files(6))
                .await
                .unwrap_or_default();
            if let Ok(mut g) = RECENT_FILES_CACHE.get_or_init(|| Mutex::new((0, 0, Vec::new()))).lock() {
                *g = (get_now_ms(), 6, fresh.clone());
            }
            fresh
        }
    };

    let mut out = Vec::new();
    let mut seen = HashSet::new();

    for entry in mru {
        if !matches!(entry.kind.as_str(), "app" | "tool" | "settings") {
            continue;
        }
        if !seen.insert(entry.target.to_ascii_lowercase()) {
            continue;
        }
        out.push(RecommendedItem {
            id: entry.id,
            kind: "app".to_string(),
            title: entry.title,
            subtitle: "start.rec.frequent".to_string(),
            path: entry.target,
            args: entry.args,
            icon: None,
            timestamp_ms: entry.last_used_ms,
        });
    }

    for file in recent_files {
        if out.len() >= 8 {
            break;
        }
        if seen.insert(file.path.to_ascii_lowercase()) {
            out.push(file);
        }
    }

    if out.is_empty() {
        let now = get_now_ms();
        let installed = tauri::async_runtime::spawn_blocking(app_index::collect_installed_apps_for_start)
            .await
            .unwrap_or_default();
        for app_info in installed.into_iter().take(6) {
            out.push(RecommendedItem {
                id: format!("app:{}", app_info.path.to_ascii_lowercase()),
                kind: "app".to_string(),
                title: app_info.name,
                subtitle: "start.rec.installed".to_string(),
                path: app_info.path,
                args: app_info.args,
                icon: app_info.icon,
                timestamp_ms: now,
            });
        }
    }

    out.truncate(8);
    out
}

fn read_display_name() -> String {
    unsafe {
        use windows::Win32::System::Registry::{HKEY, HKEY_LOCAL_MACHINE, KEY_READ, RRF_RT_REG_SZ, RegCloseKey, RegGetValueW, RegOpenKeyExW};
        use windows::core::PCWSTR;
        let subkey: Vec<u16> = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Authentication\LogonUI"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let val_name: Vec<u16> = "LastLoggedOnDisplayName"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let mut hkey = HKEY::default();
        if RegOpenKeyExW(HKEY_LOCAL_MACHINE, PCWSTR(subkey.as_ptr()), Some(0), KEY_READ, &mut hkey).is_ok() {
            let mut buf = [0u8; 256];
            let mut size = buf.len() as u32;
            let ok = RegGetValueW(
                hkey,
                PCWSTR::null(),
                PCWSTR(val_name.as_ptr()),
                RRF_RT_REG_SZ,
                None,
                Some(buf.as_mut_ptr() as *mut _),
                Some(&mut size),
            )
            .is_ok();
            let _ = RegCloseKey(hkey);
            if ok && size >= 2 {
                let units: Vec<u16> = buf[..size as usize]
                    .chunks_exact(2)
                    .map(|c| u16::from_le_bytes([c[0], c[1]]))
                    .take_while(|&u| u != 0)
                    .collect();
                let s = String::from_utf16_lossy(&units).trim().to_string();
                if !s.is_empty() {
                    return s;
                }
            }
        }
    }
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "Windows User".to_string())
}

fn encode_image_as_png_data_url(path: &Path) -> Option<String> {
    let img = image::open(path).ok()?;
    let resized = img.resize_to_fill(96, 96, image::imageops::FilterType::Triangle);
    let mut out = Vec::new();
    resized
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .ok()?;
    use base64::Engine;
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(out)
    ))
}

fn find_user_avatar() -> Option<String> {
    let mut dirs = Vec::new();
    if let Ok(appdata) = std::env::var("APPDATA") {
        dirs.push(Path::new(&appdata).join(r"Microsoft\Windows\AccountPictures"));
    }
    if let Ok(progdata) = std::env::var("ProgramData") {
        dirs.push(Path::new(&progdata).join(r"Microsoft\User Account Pictures"));
    }
    let valid_ext = ["png", "jpg", "jpeg", "bmp"];
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().is_some_and(|e| {
                valid_ext
                    .iter()
                    .any(|ext| e.eq_ignore_ascii_case(ext))
            }) {
                if let Some(url) = encode_image_as_png_data_url(&p) {
                    return Some(url);
                }
            }
        }
    }
    None
}

fn resolve_quick_folders() -> Vec<UserFolderLink> {
    let mut folders = Vec::new();
    let profile = std::env::var("USERPROFILE").unwrap_or_else(|_| r"C:\Users".to_string());
    let base = PathBuf::from(&profile);

    let candidates = [
        ("explorer", "Explorer", r"C:\Windows\explorer.exe"),
    ];
    for (id, label, path) in candidates {
        folders.push(UserFolderLink {
            id: id.to_string(),
            label: label.to_string(),
            path: path.to_string(),
        });
    }
    for (id, label, sub) in [
        ("documents", "Documents", "Documents"),
        ("downloads", "Downloads", "Downloads"),
        ("pictures", "Pictures", "Pictures"),
    ] {
        let p = base.join(sub);
        if p.exists() {
            folders.push(UserFolderLink {
                id: id.to_string(),
                label: label.to_string(),
                path: p.to_string_lossy().to_string(),
            });
        }
    }
    folders.push(UserFolderLink {
        id: "settings".to_string(),
        label: "Settings".to_string(),
        path: "ms-settings:".to_string(),
    });
    folders
}

#[tauri::command]
pub async fn get_start_user_profile() -> StartUserProfile {
    if let Some(cached) = USER_PROFILE_CACHE.get() {
        return cached.clone();
    }
    let profile = tauri::async_runtime::spawn_blocking(|| StartUserProfile {
        display_name: read_display_name(),
        avatar: find_user_avatar(),
        folders: resolve_quick_folders(),
    })
    .await
    .unwrap_or_else(|_| StartUserProfile {
        display_name: "User".to_string(),
        avatar: None,
        folders: Vec::new(),
    });
    USER_PROFILE_CACHE.get_or_init(|| profile.clone()).clone()
}

#[tauri::command]
pub async fn execute_power_action(action: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || providers::run_power_action(&action))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn open_start_folder(app: AppHandle, path: String) -> Result<(), String> {
    if path == "nectar-settings" {
        open_settings_window(app);
        return Ok(());
    }
    if path == "ms-settings:" || is_aumid_path(&path) {
        tauri::async_runtime::spawn_blocking(move || launch_path(&path, None));
        return Ok(());
    }
    if path == "explorer" || path.to_ascii_lowercase().ends_with(r"\explorer.exe") {
        return tauri::async_runtime::spawn_blocking(move || {
            std::process::Command::new("explorer.exe")
                .spawn()
                .map(|_| ())
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new("explorer.exe")
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn warm_up(app: AppHandle) {
    crate::services::trigger_app_scan();
    tauri::async_runtime::spawn(async move {
        let _ = get_start_pins(app).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const VK_LCONTROL: u16 = 0xA2;
    const VK_LSHIFT: u16 = 0xA0;
    const VK_D: u16 = 0x44;
    const VK_E: u16 = 0x45;
    const VK_S: u16 = 0x53;
    const VK_1: u16 = 0x31;
    const VK_2: u16 = 0x32;
    const SCAN_LWIN: u16 = 0x5B;
    const SCAN_RWIN: u16 = 0x5C;

    fn default_policy() -> WinHookPolicy {
        WinHookPolicy {
            start_hook_enabled: true,
            win_b_enabled: true,
            win_number_enabled: true,
            fullscreen_blocks_win_chords: false,
            pre_held_modifier: false,
        }
    }

    #[test]
    fn solo_lwin_and_rwin_swallow_down_and_toggle_start_on_up() {
        let mut sm = WinKeyStateMachine::default();
        let p = default_policy();

        assert_eq!(
            sm.on_key(VK_LWIN_CODE, SCAN_LWIN, true, false, 0, p, |_| false),
            WinHookOutcome::Swallow
        );
        assert_eq!(
            sm.state,
            WinKeyState::PendingSolo {
                vk: VK_LWIN_CODE,
                scan: SCAN_LWIN,
            }
        );
        assert_eq!(
            sm.on_key(VK_LWIN_CODE, SCAN_LWIN, false, false, 0, p, |_| false),
            WinHookOutcome::SwallowAndToggleStart
        );
        assert_eq!(sm.state, WinKeyState::Idle);

        assert_eq!(
            sm.on_key(VK_RWIN_CODE, SCAN_RWIN, true, false, 0, p, |_| false),
            WinHookOutcome::Swallow
        );
        assert_eq!(
            sm.on_key(VK_RWIN_CODE, SCAN_RWIN, false, false, 0, p, |_| false),
            WinHookOutcome::SwallowAndToggleStart
        );
        assert_eq!(sm.state, WinKeyState::Idle);
    }

    #[test]
    fn auto_repeat_while_pending_solo_and_consumed_stays_swallowed() {
        let mut sm = WinKeyStateMachine::default();
        let p = default_policy();

        assert_eq!(
            sm.on_key(VK_LWIN_CODE, SCAN_LWIN, true, false, 0, p, |_| false),
            WinHookOutcome::Swallow
        );
        assert_eq!(
            sm.on_key(VK_LWIN_CODE, SCAN_LWIN, true, false, 0, p, |_| false),
            WinHookOutcome::Swallow
        );
        assert_eq!(
            sm.on_key(VK_LWIN_CODE, SCAN_LWIN, false, false, 0, p, |_| false),
            WinHookOutcome::SwallowAndToggleStart
        );

        // Auto-repeat on Win+B inside ConsumedByNectar must neither replay nor double-dispatch
        sm.on_key(VK_LWIN_CODE, SCAN_LWIN, true, false, 0, p, |_| false);
        assert_eq!(
            sm.on_key(VK_B_CODE, 0x30, true, false, 0, p, |_| false),
            WinHookOutcome::SwallowAndDispatch(WinChordAction::OpenTray)
        );
        assert_eq!(
            sm.on_key(VK_B_CODE, 0x30, true, false, 0, p, |_| false),
            WinHookOutcome::Swallow
        );
        assert_eq!(
            sm.on_key(VK_LWIN_CODE, SCAN_LWIN, true, false, 0, p, |_| false),
            WinHookOutcome::Swallow
        );
        assert_eq!(
            sm.on_key(VK_B_CODE, 0x30, false, false, 0, p, |_| false),
            WinHookOutcome::Swallow
        );
        assert_eq!(
            sm.on_key(VK_LWIN_CODE, SCAN_LWIN, false, false, 0, p, |_| false),
            WinHookOutcome::Swallow
        );
        assert_eq!(sm.state, WinKeyState::Idle);
    }

    #[test]
    fn os_chords_replay_win_down_and_promote_to_chord() {
        let mut sm = WinKeyStateMachine::default();
        let p = default_policy();

        // Win+E
        assert_eq!(
            sm.on_key(VK_LWIN_CODE, SCAN_LWIN, true, false, 0, p, |_| false),
            WinHookOutcome::Swallow
        );
        assert_eq!(
            sm.on_key(VK_E, 0x12, true, false, 0, p, |_| true),
            WinHookOutcome::ReplayWinDownAndPass {
                win_vk: VK_LWIN_CODE,
                win_scan: SCAN_LWIN,
            }
        );
        assert_eq!(sm.state, WinKeyState::PromotedToChord { vk: VK_LWIN_CODE });
        assert_eq!(sm.on_key(VK_E, 0x12, false, false, 0, p, |_| true), WinHookOutcome::Pass);
        assert_eq!(
            sm.on_key(VK_LWIN_CODE, SCAN_LWIN, false, false, 0, p, |_| false),
            WinHookOutcome::Pass
        );
        assert_eq!(sm.state, WinKeyState::Idle);

        // Win+D
        sm.on_key(VK_LWIN_CODE, SCAN_LWIN, true, false, 0, p, |_| false);
        assert_eq!(
            sm.on_key(VK_D, 0x20, true, false, 0, p, |_| true),
            WinHookOutcome::ReplayWinDownAndPass {
                win_vk: VK_LWIN_CODE,
                win_scan: SCAN_LWIN,
            }
        );
        sm.on_key(VK_D, 0x20, false, false, 0, p, |_| true);
        sm.on_key(VK_LWIN_CODE, SCAN_LWIN, false, false, 0, p, |_| false);
        assert_eq!(sm.state, WinKeyState::Idle);

        // Win+Shift+S
        sm.on_key(VK_LWIN_CODE, SCAN_LWIN, true, false, 0, p, |_| false);
        assert_eq!(
            sm.on_key(VK_LSHIFT, 0x2A, true, false, 0, p, |_| true),
            WinHookOutcome::ReplayWinDownAndPass {
                win_vk: VK_LWIN_CODE,
                win_scan: SCAN_LWIN,
            }
        );
        assert_eq!(sm.on_key(VK_S, 0x1F, true, false, 0, p, |_| true), WinHookOutcome::Pass);
        assert_eq!(sm.on_key(VK_S, 0x1F, false, false, 0, p, |_| true), WinHookOutcome::Pass);
        assert_eq!(sm.on_key(VK_LSHIFT, 0x2A, false, false, 0, p, |_| true), WinHookOutcome::Pass);
        assert_eq!(
            sm.on_key(VK_LWIN_CODE, SCAN_LWIN, false, false, 0, p, |_| false),
            WinHookOutcome::Pass
        );
        assert_eq!(sm.state, WinKeyState::Idle);
    }

    #[test]
    fn win_l_resets_immediately_and_uipi_failure_resets_promoted_state() {
        let mut sm = WinKeyStateMachine::default();
        let p = default_policy();

        // Win+L locks immediately -> Idle without needing missed keyups
        sm.on_key(VK_LWIN_CODE, SCAN_LWIN, true, false, 0, p, |_| false);
        assert_eq!(
            sm.on_key(VK_L_CODE, 0x26, true, false, 0, p, |_| true),
            WinHookOutcome::ReplayWinDownAndPass {
                win_vk: VK_LWIN_CODE,
                win_scan: SCAN_LWIN,
            }
        );
        assert_eq!(sm.state, WinKeyState::Idle);

        // Subsequent solo tap after unlock works immediately
        assert_eq!(
            sm.on_key(VK_LWIN_CODE, SCAN_LWIN, true, false, 0, p, |_| false),
            WinHookOutcome::Swallow
        );
        assert_eq!(
            sm.on_key(VK_LWIN_CODE, SCAN_LWIN, false, false, 0, p, |_| false),
            WinHookOutcome::SwallowAndToggleStart
        );

        // UIPI blocks SendInput (sent == 0)
        sm.on_key(VK_LWIN_CODE, SCAN_LWIN, true, false, 0, p, |_| false);
        let _ = sm.on_key(VK_E, 0x12, true, false, 0, p, |_| true);
        assert_eq!(sm.state, WinKeyState::PromotedToChord { vk: VK_LWIN_CODE });
        sm.reset_to_idle_on_uipi(VK_LWIN_CODE);
        assert_eq!(sm.state, WinKeyState::Idle);
    }

    #[test]
    fn win_1_to_9_and_win_b_consume_without_replay_and_handle_out_of_order_up() {
        let mut sm = WinKeyStateMachine::default();
        let p = default_policy();

        // Win+1 then Win+2 while holding Win
        sm.on_key(VK_LWIN_CODE, SCAN_LWIN, true, false, 0, p, |_| false);
        assert_eq!(
            sm.on_key(VK_1, 0x02, true, false, 0, p, |_| false),
            WinHookOutcome::SwallowAndDispatch(WinChordAction::DockWinNumber(0))
        );
        assert_eq!(
            sm.on_key(VK_1, 0x02, false, false, 0, p, |_| false),
            WinHookOutcome::Swallow
        );
        assert_eq!(
            sm.on_key(VK_2, 0x03, true, false, 0, p, |_| false),
            WinHookOutcome::SwallowAndDispatch(WinChordAction::DockWinNumber(1))
        );
        // Release Win BEFORE releasing 2
        assert_eq!(
            sm.on_key(VK_LWIN_CODE, SCAN_LWIN, false, false, 0, p, |_| false),
            WinHookOutcome::Swallow
        );
        assert_eq!(sm.state, WinKeyState::Idle);
        assert_eq!(
            sm.on_key(VK_2, 0x03, false, false, 0, p, |_| false),
            WinHookOutcome::Swallow
        );

        // With Win+Number disabled, Win+1 promotes as an OS chord instead
        let no_num = WinHookPolicy {
            win_number_enabled: false,
            ..p
        };
        sm.on_key(VK_LWIN_CODE, SCAN_LWIN, true, false, 0, no_num, |_| false);
        assert_eq!(
            sm.on_key(VK_1, 0x02, true, false, 0, no_num, |_| true),
            WinHookOutcome::ReplayWinDownAndPass {
                win_vk: VK_LWIN_CODE,
                win_scan: SCAN_LWIN,
            }
        );
    }

    #[test]
    fn preheld_modifiers_mouse_fullscreen_and_injected_events_behave_correctly() {
        let mut sm = WinKeyStateMachine::default();
        let p = default_policy();

        // Ctrl+Win passes without entering PendingSolo
        sm.on_key(VK_LCONTROL, 0x1D, true, false, 0, p, |_| true);
        let ctrl_win = WinHookPolicy {
            pre_held_modifier: true,
            ..p
        };
        assert_eq!(
            sm.on_key(VK_LWIN_CODE, SCAN_LWIN, true, false, 0, ctrl_win, |k| k == VK_LCONTROL),
            WinHookOutcome::Pass
        );
        assert_eq!(sm.state, WinKeyState::Idle);
        assert_eq!(
            sm.on_key(VK_LWIN_CODE, SCAN_LWIN, false, false, 0, ctrl_win, |k| k == VK_LCONTROL),
            WinHookOutcome::Pass
        );
        sm.on_key(VK_LCONTROL, 0x1D, false, false, 0, p, |_| false);

        // Win+Mouse promotes PendingSolo -> PromotedToChord and returns (vk, scan)
        sm.on_key(VK_LWIN_CODE, SCAN_LWIN, true, false, 0, p, |_| false);
        assert_eq!(sm.on_mouse_button(), Some((VK_LWIN_CODE, SCAN_LWIN)));
        assert_eq!(sm.state, WinKeyState::PromotedToChord { vk: VK_LWIN_CODE });
        assert_eq!(sm.on_mouse_button(), None);
        assert_eq!(
            sm.on_key(VK_LWIN_CODE, SCAN_LWIN, false, false, 0, p, |_| false),
            WinHookOutcome::Pass
        );

        // Fullscreen blocks solo Win unless START_MENU_VISIBLE is true
        let fs_hidden = WinHookPolicy {
            start_hook_enabled: false,
            fullscreen_blocks_win_chords: true,
            ..p
        };
        assert_eq!(
            sm.on_key(VK_LWIN_CODE, SCAN_LWIN, true, false, 0, fs_hidden, |_| false),
            WinHookOutcome::Pass
        );
        assert_eq!(sm.state, WinKeyState::Idle);

        // START_MENU_VISIBLE when fullscreen enables solo Win toggle
        let fs_start_open = WinHookPolicy {
            start_hook_enabled: true,
            fullscreen_blocks_win_chords: false,
            ..p
        };
        assert_eq!(
            sm.on_key(VK_LWIN_CODE, SCAN_LWIN, true, false, 0, fs_start_open, |_| false),
            WinHookOutcome::Swallow
        );
        assert_eq!(
            sm.on_key(VK_LWIN_CODE, SCAN_LWIN, false, false, 0, fs_start_open, |_| false),
            WinHookOutcome::SwallowAndToggleStart
        );

        // Injected and NECTAR_INJECTED_EXTRA_INFO events are ignored
        sm.on_key(VK_LWIN_CODE, SCAN_LWIN, true, false, 0, p, |_| false);
        assert_eq!(
            sm.on_key(VK_E, 0x12, true, true, 0, p, |_| false),
            WinHookOutcome::Pass
        );
        assert_eq!(
            sm.on_key(
                VK_E,
                0x12,
                true,
                false,
                crate::utils::NECTAR_INJECTED_EXTRA_INFO,
                p,
                |_| false
            ),
            WinHookOutcome::Pass
        );
        assert_eq!(
            sm.state,
            WinKeyState::PendingSolo {
                vk: VK_LWIN_CODE,
                scan: SCAN_LWIN,
            }
        );
    }

    #[test]
    fn win_tap_while_holding_game_keys_and_autorepeat_toggles_start() {
        let mut sm = WinKeyStateMachine::default();
        let p = default_policy();
        const VK_W: u16 = 0x57;

        // Player holds W to walk forward in a game, with typematic repeats
        assert_eq!(sm.on_key(VK_W, 0x11, true, false, 0, p, |_| true), WinHookOutcome::Pass);
        assert_eq!(sm.on_key(VK_W, 0x11, true, false, 0, p, |_| true), WinHookOutcome::Pass);

        // Player taps Win while W is still held & repeating
        assert_eq!(
            sm.on_key(VK_LWIN_CODE, SCAN_LWIN, true, false, 0, p, |k| k == VK_W),
            WinHookOutcome::Swallow
        );
        assert_eq!(
            sm.state,
            WinKeyState::PendingSolo {
                vk: VK_LWIN_CODE,
                scan: SCAN_LWIN,
            }
        );
        assert_eq!(
            sm.on_key(VK_W, 0x11, true, false, 0, p, |k| k == VK_W),
            WinHookOutcome::Pass
        );
        assert_eq!(
            sm.state,
            WinKeyState::PendingSolo {
                vk: VK_LWIN_CODE,
                scan: SCAN_LWIN,
            }
        );

        // Releasing Win still toggles Nectar Start instead of leaking to Windows Start
        assert_eq!(
            sm.on_key(VK_LWIN_CODE, SCAN_LWIN, false, false, 0, p, |k| k == VK_W),
            WinHookOutcome::SwallowAndToggleStart
        );
        assert_eq!(sm.state, WinKeyState::Idle);
        assert_eq!(sm.on_key(VK_W, 0x11, false, false, 0, p, |_| false), WinHookOutcome::Pass);
    }

    #[test]
    fn win_plus_new_key_while_holding_game_key_promotes_to_chord() {
        let mut sm = WinKeyStateMachine::default();
        let p = default_policy();
        const VK_W: u16 = 0x57;
        const VK_G: u16 = 0x47;

        sm.on_key(VK_W, 0x11, true, false, 0, p, |_| true);
        assert_eq!(
            sm.on_key(VK_LWIN_CODE, SCAN_LWIN, true, false, 0, p, |k| k == VK_W),
            WinHookOutcome::Swallow
        );
        assert_eq!(
            sm.on_key(VK_G, 0x22, true, false, 0, p, |k| k == VK_W || k == VK_G),
            WinHookOutcome::ReplayWinDownAndPass {
                win_vk: VK_LWIN_CODE,
                win_scan: SCAN_LWIN,
            }
        );
        assert_eq!(sm.state, WinKeyState::PromotedToChord { vk: VK_LWIN_CODE });
    }

    #[test]
    fn empty_pins_on_disk_never_reseeds_defaults() {
        let (pins, should_write) = resolve_loaded_or_seeded_pins(Some(Vec::new()), || {
            panic!("seed_default_pins must not run when start_pins.json exists as []")
        });
        assert!(pins.is_empty());
        assert!(!should_write);

        // Missing file (None) triggers seeding
        let (seeded, write_seeded) = resolve_loaded_or_seeded_pins(None, || vec![StartPinItem {
            name: "Notepad".to_string(),
            path: "notepad.exe".to_string(),
            args: None,
            executable: Some("notepad.exe".to_string()),
            icon: None,
        }]);
        assert_eq!(seeded.len(), 1);
        assert!(write_seeded);
    }

    #[test]
    fn sanitizes_duplicate_pin_names_and_dead_store_pins() {
        assert_eq!(sanitize_pin_name("File Explorer (2)"), "File Explorer");
        assert_eq!(sanitize_pin_name("Telegram (3)"), "Telegram");
        assert_eq!(sanitize_pin_name("Foo (x64)"), "Foo (x64)");

        let input = vec![
            StartPinItem {
                name: "File Explorer (2)".to_string(),
                path: r"C:\Windows\explorer.exe".to_string(),
                args: None,
                executable: Some("explorer.exe".to_string()),
                icon: None,
            },
            StartPinItem {
                name: "App".to_string(),
                path: r"shell:AppsFolder\Dead.Package_1234567890abc!App".to_string(),
                args: None,
                executable: None,
                icon: None,
            },
        ];
        let (cleaned, changed) = sanitize_loaded_pins(input);
        assert!(changed);
        assert_eq!(cleaned.len(), 1);
        assert_eq!(cleaned[0].name, "File Explorer");
    }

    #[test]
    fn ctrl_win_1_and_deferred_b_up_under_reheld_win() {
        let mut sm = WinKeyStateMachine::default();
        let p = default_policy();

        // Win DOWN -> Ctrl DOWN -> '1' must NOT trigger DockWinNumber
        sm.on_key(VK_LWIN_CODE, SCAN_LWIN, true, false, 0, p, |_| false);
        let promote = sm.on_key(VK_LCONTROL, 0x1D, true, false, 0, p, |k| k == VK_LWIN_CODE);
        assert!(matches!(promote, WinHookOutcome::ReplayWinDownAndPass { .. }));
        assert_eq!(
            sm.on_key(
                0x31,
                0x02,
                true,
                false,
                0,
                WinHookPolicy { pre_held_modifier: true, ..p },
                |k| k == VK_LWIN_CODE || k == VK_LCONTROL
            ),
            WinHookOutcome::Pass
        );
        sm.on_key(0x31, 0x02, false, false, 0, p, |_| false);
        sm.on_key(VK_LCONTROL, 0x1D, false, false, 0, p, |_| false);
        sm.on_key(VK_LWIN_CODE, SCAN_LWIN, false, false, 0, p, |_| false);
        assert_eq!(sm.state, WinKeyState::Idle);

        // Win+B -> Win UP -> immediate Win DOWN -> B UP must still swallow B UP
        sm.on_key(VK_LWIN_CODE, SCAN_LWIN, true, false, 0, p, |_| false);
        assert_eq!(
            sm.on_key(VK_B_CODE, 0x30, true, false, 0, p, |_| false),
            WinHookOutcome::SwallowAndDispatch(WinChordAction::OpenTray)
        );
        assert_eq!(
            sm.on_key(VK_LWIN_CODE, SCAN_LWIN, false, false, 0, p, |_| false),
            WinHookOutcome::Swallow
        );
        assert_eq!(
            sm.on_key(VK_LWIN_CODE, SCAN_LWIN, true, false, 0, p, |_| false),
            WinHookOutcome::Swallow
        );
        assert_eq!(
            sm.on_key(VK_B_CODE, 0x30, false, false, 0, p, |_| false),
            WinHookOutcome::Swallow
        );
        sm.on_key(VK_LWIN_CODE, SCAN_LWIN, false, false, 0, p, |_| false);
        assert_eq!(sm.state, WinKeyState::Idle);
    }
}
