//! Unified search providers, command execution, clipboard copy, actions drawer,
//! persistent query history, and MRU frecency scoring for Nectar Launcher.

use std::collections::{HashMap, HashSet};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::{
    bring_window_forward, get_active_windows, get_bluetooth_state, get_wifi_status,
    load_pinned_apps, open_settings_window, quit_nectar, restart_nectar, save_pinned_apps,
    set_bluetooth_state, set_volume, set_wifi_state,
};
use crate::state::COMMAND_SENDER;
use crate::types::{AppInfo, SystemCommand};
use crate::utils::{get_now_ms, get_setting_str, resolve_shortcut};

use super::{app_index, calc, currency, everything, fuzzy};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CF_UNICODETEXT: u32 = 13;
const MAX_HISTORY_ENTRIES: usize = 32;
const DEFAULT_SEARCH_URL: &str = "https://www.google.com/search?q={query}";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LauncherAction {
    pub id: String,
    pub label: String,
    pub shortcut: Option<String>,
    pub destructive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalcCard {
    pub expression: String,
    pub formatted: String,
    pub raw: String,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LauncherItem {
    pub id: String,
    pub kind: String, // "app" | "file" | "folder" | "window" | "calc" | "shell" | "web" | "system" | "settings" | "tool" | "history"
    pub title: String,
    pub subtitle: String,
    pub badge: String,
    pub icon: Option<String>,
    pub target: String,
    pub args: Option<String>,
    pub hwnd: Option<isize>,
    pub score: i32,
    pub match_indices: Vec<usize>,
    pub requires_confirm: bool,
    pub actions: Vec<LauncherAction>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LauncherSearchResponse {
    pub mode: String, // "all" | "calc" | "files" | "windows" | "shell" | "web" | "history"
    pub clean_query: String,
    pub items: Vec<LauncherItem>,
    pub calc_card: Option<CalcCard>,
    pub everything_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub query: String,
    pub item_title: String,
    pub item_id: String,
    pub kind: String,
    pub target: String,
    pub timestamp_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MruEntry {
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub target: String,
    pub args: Option<String>,
    pub kind: String,
    pub count: u32,
    pub last_used_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueryMode<'a> {
    All(&'a str),
    Calc(&'a str),
    Files(&'a str),
    Windows(&'a str),
    ShellCmd(&'a str),
    ShellPs(&'a str),
    Web { engine: &'static str, query: &'a str },
}

pub fn detect_mode(raw: &str) -> QueryMode<'_> {
    let trimmed = raw.trim_start();
    if let Some(rest) = trimmed.strip_prefix('=') {
        return QueryMode::Calc(rest.trim());
    }
    if let Some(rest) = trimmed.strip_prefix("? ") {
        return QueryMode::Files(rest.trim());
    }
    if trimmed == "?" {
        return QueryMode::Files("");
    }
    if let Some(rest) = trimmed.strip_prefix(">> ") {
        return QueryMode::ShellPs(rest.trim());
    }
    if trimmed == ">>" {
        return QueryMode::ShellPs("");
    }
    if let Some(rest) = trimmed.strip_prefix("> ") {
        return QueryMode::ShellCmd(rest.trim());
    }
    if trimmed == ">" {
        return QueryMode::ShellCmd("");
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("w ") {
        return QueryMode::Windows(trimmed[2..].trim());
    }
    if lower == "w" {
        return QueryMode::Windows("");
    }
    for (prefix, engine) in [
        ("g ", "google"),
        ("yt ", "youtube"),
        ("gh ", "github"),
        ("wiki ", "wikipedia"),
    ] {
        if lower.starts_with(prefix) {
            return QueryMode::Web {
                engine,
                query: trimmed[prefix.len()..].trim(),
            };
        }
    }
    QueryMode::All(trimmed)
}

pub fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 2);
    for byte in input.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push_str("%20"),
            b => {
                out.push('%');
                out.push(char::from_digit((b >> 4) as u32, 16).unwrap_or('0').to_ascii_uppercase());
                out.push(char::from_digit((b & 0x0F) as u32, 16).unwrap_or('0').to_ascii_uppercase());
            }
        }
    }
    out
}

fn build_search_url(template: &str, query: &str) -> String {
    let encoded = percent_encode(query);
    if template.contains("{query}") {
        template.replace("{query}", &encoded)
    } else if template.ends_with('=') || template.ends_with('?') {
        format!("{template}{encoded}")
    } else {
        format!("https://www.google.com/search?q={encoded}")
    }
}

fn engine_url_template(engine: &str, custom_default: &str) -> (&'static str, String) {
    match engine {
        "youtube" => ("YouTube", "https://www.youtube.com/results?search_query={query}".to_string()),
        "github" => ("GitHub", "https://github.com/search?q={query}".to_string()),
        "wikipedia" => ("Wikipedia", "https://en.wikipedia.org/wiki/Special:Search?search={query}".to_string()),
        _ => ("Web Search", custom_default.to_string()),
    }
}

static ATOMIC_TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn atomic_write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let seq = ATOMIC_TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "temp.json".to_string());
    let tmp = path.with_file_name(format!("{file_name}.{}.{}.tmp", std::process::id(), seq));
    let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

fn history_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("launcher_history.json"))
}

fn mru_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("launcher_mru.json"))
}

fn load_history_file(app: &AppHandle) -> Vec<HistoryEntry> {
    let Ok(path) = history_path(app) else {
        return Vec::new();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn push_history_entry(mut list: Vec<HistoryEntry>, entry: HistoryEntry) -> Vec<HistoryEntry> {
    list.retain(|e| {
        !(e.item_id == entry.item_id
            && e.query.eq_ignore_ascii_case(&entry.query)
            && e.target == entry.target)
    });
    list.insert(0, entry);
    list.truncate(MAX_HISTORY_ENTRIES);
    list
}

fn load_mru_map(app: &AppHandle) -> HashMap<String, MruEntry> {
    let Ok(path) = mru_path(app) else {
        return HashMap::new();
    };
    let entries: Vec<MruEntry> = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    entries.into_iter().map(|e| (e.id.clone(), e)).collect()
}

pub fn compute_frecency_boost(entry: &MruEntry, now_ms: i64) -> i32 {
    let age_hours = ((now_ms - entry.last_used_ms).max(0) as f64) / 3_600_000.0;
    let recency = if age_hours < 1.0 {
        1_200
    } else if age_hours < 24.0 {
        800
    } else if age_hours < 168.0 {
        420
    } else {
        120
    };
    let freq = (entry.count.min(30) as i32) * 55;
    recency + freq
}

pub fn record_launch_usage(app: &AppHandle, query: &str, item: &LauncherItem) {
    let now = get_now_ms();
    if let Ok(path) = mru_path(app) {
        let mut map = load_mru_map(app);
        let entry = map
            .entry(item.id.clone())
            .and_modify(|e| {
                e.count = e.count.saturating_add(1);
                e.last_used_ms = now;
                e.title = item.title.clone();
                e.subtitle = item.subtitle.clone();
                e.target = item.target.clone();
                e.args = item.args.clone();
                e.kind = item.kind.clone();
            })
            .or_insert_with(|| MruEntry {
                id: item.id.clone(),
                title: item.title.clone(),
                subtitle: item.subtitle.clone(),
                target: item.target.clone(),
                args: item.args.clone(),
                kind: item.kind.clone(),
                count: 1,
                last_used_ms: now,
            });
        let _ = entry;
        let mut list: Vec<MruEntry> = map.into_values().collect();
        list.sort_by(|a, b| b.last_used_ms.cmp(&a.last_used_ms));
        list.truncate(128);
        let _ = atomic_write_json(&path, &list);
    }

    if !query.trim().is_empty() && !matches!(item.kind.as_str(), "calc" | "web" | "history") {
        if let Ok(path) = history_path(app) {
            let current = load_history_file(app);
            let next = push_history_entry(
                current,
                HistoryEntry {
                    query: query.trim().to_string(),
                    item_title: item.title.clone(),
                    item_id: item.id.clone(),
                    kind: item.kind.clone(),
                    target: item.target.clone(),
                    timestamp_ms: now,
                },
            );
            let _ = atomic_write_json(&path, &next);
        }
    }
}

pub(crate) fn top_mru_entries(app: &AppHandle, limit: usize) -> Vec<MruEntry> {
    let now = get_now_ms();
    let mut list: Vec<MruEntry> = load_mru_map(app).into_values().collect();
    list.sort_by(|a, b| {
        compute_frecency_boost(b, now).cmp(&compute_frecency_boost(a, now))
    });
    list.truncate(limit);
    list
}

/// Copies UTF-8 text cleanly to the Windows clipboard as `CF_UNICODETEXT`.
pub fn set_clipboard_utf16(text: &str) -> Result<(), String> {
    use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{
        GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock,
    };

    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let byte_len = wide.len() * std::mem::size_of::<u16>();

    unsafe {
        let mut opened = false;
        for _ in 0..6 {
            if OpenClipboard(None).is_ok() {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(12));
        }
        if !opened {
            return Err("Could not open Windows clipboard".to_string());
        }

        let res = (|| -> Result<(), String> {
            EmptyClipboard().map_err(|e| e.to_string())?;
            let hmem: HGLOBAL =
                GlobalAlloc(GMEM_MOVEABLE, byte_len).map_err(|e| e.to_string())?;
            let ptr = GlobalLock(hmem) as *mut u16;
            if ptr.is_null() {
                let _ = GlobalFree(Some(hmem));
                return Err("GlobalLock returned null".to_string());
            }
            std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr, wide.len());
            let _ = GlobalUnlock(hmem);

            if SetClipboardData(CF_UNICODETEXT, Some(HANDLE(hmem.0))).is_err() {
                let _ = GlobalFree(Some(hmem));
                return Err("SetClipboardData failed".to_string());
            }
            Ok(())
        })();

        let _ = CloseClipboard();
        res
    }
}

fn wide_vec(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn shell_execute_verb(verb: &str, target: &str, args: Option<&str>) -> Result<(), String> {
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    use windows::core::PCWSTR;

    let v_w = wide_vec(verb);
    let t_w = wide_vec(target);
    let a_w = args.filter(|a| !a.trim().is_empty()).map(wide_vec);
    let dir_w = Path::new(target)
        .parent()
        .filter(|d| d.is_dir())
        .map(|d| wide_vec(&d.to_string_lossy()));

    unsafe {
        let res = ShellExecuteW(
            None,
            PCWSTR(v_w.as_ptr()),
            PCWSTR(t_w.as_ptr()),
            a_w.as_ref().map_or(PCWSTR::null(), |a| PCWSTR(a.as_ptr())),
            dir_w.as_ref().map_or(PCWSTR::null(), |d| PCWSTR(d.as_ptr())),
            SW_SHOWNORMAL,
        );
        if res.0 as usize <= 32 {
            return Err(format!("ShellExecuteW({verb}, {target}) failed: code {}", res.0 as usize));
        }
    }
    Ok(())
}

fn find_windows_terminal() -> Option<PathBuf> {
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let wt = Path::new(&local).join(r"Microsoft\WindowsApps\wt.exe");
        if wt.exists() {
            return Some(wt);
        }
    }
    None
}

fn encode_ps_utf16_b64(script: &str) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut bytes = Vec::with_capacity(script.len() * 2);
    for u in script.encode_utf16() {
        bytes.extend_from_slice(&u.to_le_bytes());
    }
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 0x3F) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3F) as usize] as char);
        out.push(if chunk.len() > 1 { TABLE[((n >> 6) & 0x3F) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[(n & 0x3F) as usize] as char } else { '=' });
    }
    out
}

fn launch_shell_command(cmd: &str, use_powershell: bool) -> Result<(), String> {
    let trimmed = cmd.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    if let Some(wt) = find_windows_terminal() {
        if use_powershell {
            let encoded = encode_ps_utf16_b64(trimmed);
            std::process::Command::new(wt)
                .args(["powershell.exe", "-NoExit", "-EncodedCommand", &encoded])
                .spawn()
                .map_err(|e| e.to_string())?;
        } else {
            let escaped = trimmed.replace(';', r"\;");
            std::process::Command::new(wt)
                .args(["cmd.exe", "/k", &escaped])
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    if use_powershell {
        let encoded = encode_ps_utf16_b64(trimmed);
        std::process::Command::new("powershell.exe")
            .args(["-NoExit", "-EncodedCommand", &encoded])
            .spawn()
            .map_err(|e| e.to_string())?;
    } else {
        std::process::Command::new("cmd.exe")
            .args(["/C", "start", "", "cmd.exe", "/k", trimmed])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn set_windows_dark_mode(dark: bool) -> Result<(), String> {
    use windows::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, REG_DWORD, REG_OPTION_NON_VOLATILE, RegCloseKey,
        RegCreateKeyExW, RegSetValueExW,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        HWND_BROADCAST, SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_SETTINGCHANGE,
    };
    use windows::core::PCWSTR;

    let subkey = wide_vec(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
    let val_dword: u32 = if dark { 0 } else { 1 };
    let bytes = val_dword.to_le_bytes();

    unsafe {
        let mut hkey = HKEY::default();
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            Some(0),
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            None,
            &mut hkey,
            None,
        )
        .ok()
        .map_err(|e| e.to_string())?;

        for name in ["AppsUseLightTheme", "SystemUsesLightTheme"] {
            let name_w = wide_vec(name);
            let _ = RegSetValueExW(hkey, PCWSTR(name_w.as_ptr()), Some(0), REG_DWORD, Some(&bytes));
        }
        let _ = RegCloseKey(hkey);

        let setting = wide_vec("ImmersiveColorSet");
        let mut res = 0usize;
        let _ = SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            windows::Win32::Foundation::WPARAM(0),
            windows::Win32::Foundation::LPARAM(setting.as_ptr() as isize),
            SMTO_ABORTIFHUNG,
            200,
            Some(&mut res),
        );
    }
    Ok(())
}

pub(crate) fn run_power_action(action: &str) -> Result<(), String> {
    match action {
        "lock" => unsafe {
            windows::Win32::System::Shutdown::LockWorkStation().map_err(|e| e.to_string())
        },
        "sleep" => unsafe {
            let ok = windows::Win32::System::Power::SetSuspendState(false, false, false);
            if ok { Ok(()) } else { Err("SetSuspendState(sleep) failed".to_string()) }
        },
        "hibernate" => unsafe {
            let ok = windows::Win32::System::Power::SetSuspendState(true, false, false);
            if ok { Ok(()) } else { Err("SetSuspendState(hibernate) failed".to_string()) }
        },
        "sign_out" | "signout" | "logoff" => unsafe {
            use windows::Win32::System::Shutdown::{ExitWindowsEx, EWX_LOGOFF, SHUTDOWN_REASON};
            ExitWindowsEx(EWX_LOGOFF, SHUTDOWN_REASON(0)).map_err(|e| e.to_string())
        },
        "restart" => std::process::Command::new("shutdown.exe")
            .args(["/r", "/t", "0"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string()),
        "shutdown" | "shut_down" | "shut down" => std::process::Command::new("shutdown.exe")
            .args(["/s", "/t", "0"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string()),
        other => Err(format!("Unknown power action: {other}")),
    }
}

pub(crate) fn empty_recycle_bin() -> Result<(), String> {
    use windows::Win32::UI::Shell::{
        SHERB_NOCONFIRMATION, SHERB_NOPROGRESSUI, SHERB_NOSOUND, SHEmptyRecycleBinW,
    };
    unsafe {
        SHEmptyRecycleBinW(
            None,
            None,
            SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND,
        )
        .map_err(|e| e.to_string())
    }
}

fn actions_for_launchable(target: &str, is_folder: bool) -> Vec<LauncherAction> {
    let mut actions = vec![LauncherAction {
        id: "open".to_string(),
        label: if is_folder { "Open folder" } else { "Open" }.to_string(),
        shortcut: Some("Enter".to_string()),
        destructive: false,
    }];
    let lower = target.to_ascii_lowercase();
    let is_uri = lower.starts_with("ms-") || lower.starts_with("http");
    let is_aumid = lower.starts_with("shell:") || crate::commands::is_aumid_path(target);

    if !is_folder && !is_uri && !is_aumid {
        actions.push(LauncherAction {
            id: "run_as_admin".to_string(),
            label: "Run as Administrator".to_string(),
            shortcut: Some("Ctrl+Shift+Enter".to_string()),
            destructive: false,
        });
    }
    if !is_uri && !is_aumid && (Path::new(target).is_absolute() || target.contains('.')) && target != "nectar-settings" {
        actions.push(LauncherAction {
            id: "open_location".to_string(),
            label: "Open file location".to_string(),
            shortcut: Some("Ctrl+O".to_string()),
            destructive: false,
        });
    }
    if !is_uri && !is_aumid && target != "nectar-settings" {
        actions.push(LauncherAction {
            id: "properties".to_string(),
            label: "Properties".to_string(),
            shortcut: Some("Ctrl+P".to_string()),
            destructive: false,
        });
    }
    actions.push(LauncherAction {
        id: "copy_path".to_string(),
        label: "Copy path".to_string(),
        shortcut: Some("Ctrl+C".to_string()),
        destructive: false,
    });
    if !is_uri && !is_folder {
        actions.push(LauncherAction {
            id: "toggle_pin_start".to_string(),
            label: "Pin / Unpin to Start".to_string(),
            shortcut: None,
            destructive: false,
        });
        actions.push(LauncherAction {
            id: "toggle_pin_dock".to_string(),
            label: "Pin / Unpin to Dock".to_string(),
            shortcut: None,
            destructive: false,
        });
    }
    actions
}

fn expand_env_vars(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        if let Some(end) = after.find('%') {
            let var_name = &after[..end];
            if !var_name.is_empty() {
                if let Ok(val) = std::env::var(var_name) {
                    out.push_str(&val);
                    rest = &after[end + 1..];
                    continue;
                }
            }
            out.push('%');
            out.push_str(var_name);
            out.push('%');
            rest = &after[end + 1..];
        } else {
            out.push('%');
            rest = after;
            break;
        }
    }
    out.push_str(rest);
    out
}

fn match_direct_run_target(
    trimmed: &str,
    entries: &[app_index::IndexedEntry],
) -> Option<LauncherItem> {
    let clean = trimmed.trim().trim_matches('"').trim();
    if clean.chars().count() < 2 {
        return None;
    }
    let expanded = if clean.contains('%') {
        expand_env_vars(clean)
    } else {
        clean.to_string()
    };
    let candidate = expanded.trim().trim_matches('"').trim();
    if candidate.is_empty() {
        return None;
    }
    let lower = candidate.to_ascii_lowercase();

    // 1. Explicit Windows URI / shell namespace / URL
    let is_http = lower.starts_with("http://") || lower.starts_with("https://");
    let is_ms_uri = lower.starts_with("ms-") && lower.contains(':');
    let is_shell_uri = lower.starts_with("shell:");
    if is_http || is_ms_uri || is_shell_uri {
        if entries.iter().any(|e| e.path.eq_ignore_ascii_case(candidate)) {
            return None;
        }
        let kind = if is_http {
            "web"
        } else if is_ms_uri {
            "settings"
        } else {
            "folder"
        };
        let badge = if is_http {
            "Web"
        } else if is_ms_uri {
            "Settings"
        } else {
            "Folder"
        };
        return Some(LauncherItem {
            id: format!("run:{lower}"),
            kind: kind.to_string(),
            title: candidate.to_string(),
            subtitle: "Windows Run command / URI".to_string(),
            badge: badge.to_string(),
            icon: None,
            target: candidate.to_string(),
            args: None,
            hwnd: None,
            score: 9_850,
            match_indices: Vec::new(),
            requires_confirm: false,
            actions: vec![
                LauncherAction {
                    id: "open".to_string(),
                    label: "Open".to_string(),
                    shortcut: Some("Enter".to_string()),
                    destructive: false,
                },
                LauncherAction {
                    id: "copy_path".to_string(),
                    label: "Copy path".to_string(),
                    shortcut: Some("Ctrl+C".to_string()),
                    destructive: false,
                },
            ],
        });
    }

    // 2. Drive root ("C:" -> "C:\") or absolute/UNC filesystem path
    let fs_target = if candidate.len() == 2
        && candidate.as_bytes()[0].is_ascii_alphabetic()
        && candidate.as_bytes()[1] == b':'
    {
        format!("{}\\", candidate)
    } else {
        candidate.to_string()
    };
    let looks_like_path =
        fs_target.contains('\\') || fs_target.contains('/') || clean.contains('%');
    if looks_like_path {
        let p = Path::new(&fs_target);
        if p.exists() {
            let is_dir = p.is_dir();
            let is_tool_ext = ["exe", "msc", "cpl", "bat", "cmd"]
                .iter()
                .any(|ext| lower.ends_with(&format!(".{ext}")));
            let kind = if is_dir {
                "folder"
            } else if is_tool_ext {
                "tool"
            } else {
                "file"
            };
            let title = p
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| fs_target.clone());
            return Some(LauncherItem {
                id: format!("runpath:{}", fs_target.to_ascii_lowercase()),
                kind: kind.to_string(),
                title,
                subtitle: fs_target.clone(),
                badge: if is_dir { "Folder" } else if is_tool_ext { "Tool" } else { "File" }.to_string(),
                icon: None,
                target: fs_target.clone(),
                args: None,
                hwnd: None,
                score: 9_920,
                match_indices: Vec::new(),
                requires_confirm: false,
                actions: actions_for_launchable(&fs_target, is_dir),
            });
        }
        return None;
    }

    // 3. Direct Win+R System32 / PATH command token (e.g., services.msc, ncpa.cpl, winver, gpedit.msc)
    if !candidate.contains(char::is_whitespace)
        && candidate
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        if entries.iter().any(|e| {
            e.path.eq_ignore_ascii_case(candidate)
                || e.path.eq_ignore_ascii_case(&format!("{candidate}.exe"))
        }) {
            return None;
        }
        let sys32 = std::env::var("SystemRoot")
            .unwrap_or_else(|_| "C:\\Windows".to_string())
            + "\\System32";
        let resolved = if candidate.contains('.') {
            let direct = Path::new(&sys32).join(candidate);
            if direct.exists() {
                Some(direct.to_string_lossy().to_string())
            } else {
                crate::utils::resolve_executable_path(candidate)
            }
        } else {
            ["exe", "msc", "cpl"].iter().find_map(|ext| {
                let with_ext = format!("{candidate}.{ext}");
                let p = Path::new(&sys32).join(&with_ext);
                if p.exists() {
                    Some(p.to_string_lossy().to_string())
                } else if *ext == "exe" {
                    crate::utils::resolve_executable_path(&with_ext)
                } else {
                    None
                }
            })
        };
        if let Some(actual_path) = resolved {
            return Some(LauncherItem {
                id: format!("runtool:{lower}"),
                kind: "tool".to_string(),
                title: candidate.to_string(),
                subtitle: format!("{actual_path} — Windows Run command"),
                badge: "Tool".to_string(),
                icon: None,
                target: actual_path.clone(),
                args: None,
                hwnd: None,
                score: 9_650,
                match_indices: Vec::new(),
                requires_confirm: false,
                actions: actions_for_launchable(&actual_path, false),
            });
        }
    }

    None
}

fn system_commands_catalog() -> &'static [(&'static str, &'static str, &'static str, &'static str, &'static str, bool)] {
    // (id, title, subtitle, target, keywords, requires_confirm)
    &[
        ("sys:wifi", "Toggle Wi-Fi", "Turn Wi-Fi adapter on or off", "sys:wifi_toggle", "wifi wireless internet network вайфай сеть интернет", false),
        ("sys:bluetooth", "Toggle Bluetooth", "Turn Bluetooth radio on or off", "sys:bt_toggle", "bluetooth radio wireless блютуз блутуз", false),
        ("sys:mute", "Toggle Mute", "Mute or unmute system audio", "sys:mute", "audio volume mute silent sound звук громкость без звука выключить звук", false),
        ("sys:night_light", "Night Light", "Open Windows Night Light display settings", "sys:night_light", "night light blue warm eye screen ночной свет экран", false),
        ("sys:dark_mode", "Enable Dark Mode", "Switch Windows & apps to Dark theme", "sys:dark_mode", "dark theme mode appearance темная тема ночной режим", false),
        ("sys:light_mode", "Enable Light Mode", "Switch Windows & apps to Light theme", "sys:light_mode", "light theme mode appearance светлая тема дневной режим", false),
        ("sys:lock", "Lock Screen", "Lock this Windows workstation immediately", "sys:lock", "lock screen win+l security блокировка заблокировать экран", false),
        ("sys:sign_out", "Sign Out", "Sign out of the current Windows session", "sys:sign_out", "sign out logoff log out выход из системы выйти сменить пользователя", true),
        ("sys:sleep", "Sleep", "Put PC to sleep", "sys:sleep", "sleep suspend standby сон спящий режим", false),
        ("sys:hibernate", "Hibernate", "Save session to disk and power off", "sys:hibernate", "hibernate power гибернация сон питание", true),
        ("sys:restart", "Restart PC", "Reboot Windows immediately", "sys:restart", "restart reboot pc computer перезагрузка перезагрузить компьютер", true),
        ("sys:shutdown", "Shut Down PC", "Power off Windows immediately", "sys:shutdown", "shut down shutdown power off выключить выключение завершение работы питание", true),
        ("sys:empty_bin", "Empty Recycle Bin", "Permanently delete items in Recycle Bin", "sys:empty_bin", "empty recycle bin trash clean корзина очистить корзину", true),
        ("sys:nectar_settings", "Nectar Settings", "Open Nectar preferences", "sys:nectar_settings", "nectar settings preferences config настройки параметры нектар", false),
        ("sys:nectar_restart", "Restart Nectar", "Reload Nectar shell services", "sys:nectar_restart", "restart nectar reload перезапустить перезагрузить нектар", false),
        ("sys:nectar_quit", "Quit Nectar", "Restore Windows taskbar and exit Nectar", "sys:nectar_quit", "quit exit close nectar выйти закрыть нектар", true),
    ]
}

fn match_volume_command(query: &str) -> Option<LauncherItem> {
    let lower = query.trim().to_lowercase();
    let arg = lower
        .strip_prefix("vol ")
        .or_else(|| lower.strip_prefix("volume "))
        .or_else(|| lower.strip_prefix("громкость "))
        .or_else(|| lower.strip_prefix("звук "))?
        .trim()
        .trim_end_matches('%');
    let level: u32 = arg.parse().ok()?;
    if level > 100 {
        return None;
    }
    Some(LauncherItem {
        id: format!("sys:vol:{level}"),
        kind: "system".to_string(),
        title: format!("Set Volume to {level}%"),
        subtitle: "System audio output level".to_string(),
        badge: "System".to_string(),
        icon: None,
        target: format!("sys:vol:{level}"),
        args: None,
        hwnd: None,
        score: 9_600,
        match_indices: Vec::new(),
        requires_confirm: false,
        actions: vec![LauncherAction {
            id: "open".to_string(),
            label: "Apply volume".to_string(),
            shortcut: Some("Enter".to_string()),
            destructive: false,
        }],
    })
}

async fn search_windows_items(query: &str, max_results: usize) -> Vec<LauncherItem> {
    let apps = get_active_windows().await;
    let mut items = Vec::new();
    for app in apps {
        let windows_list: Vec<(isize, String)> = match app.all_hwnds {
            Some(ref list) if !list.is_empty() => list.clone(),
            _ => app.hwnd.map(|h| vec![(h, app.name.clone())]).unwrap_or_default(),
        };
        for (hwnd, title) in windows_list {
            let extra = format!("{} {}", app.name, app.executable.as_deref().unwrap_or(""));
            let (score, idxs) = if query.trim().is_empty() {
                (5_000, Vec::new())
            } else if let Some(hit) = fuzzy::match_candidate(query, &title, Some(&extra)) {
                hit
            } else {
                continue;
            };
            items.push(LauncherItem {
                id: format!("win:{hwnd}"),
                kind: "window".to_string(),
                title,
                subtitle: format!("Switch to {} window", app.name),
                badge: "Window".to_string(),
                icon: app.icon.clone(),
                target: app.path.clone(),
                args: None,
                hwnd: Some(hwnd),
                score,
                match_indices: idxs,
                requires_confirm: false,
                actions: vec![LauncherAction {
                    id: "open".to_string(),
                    label: "Focus window".to_string(),
                    shortcut: Some("Enter".to_string()),
                    destructive: false,
                }],
            });
        }
    }
    items.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.title.cmp(&b.title)));
    items.truncate(max_results);
    items
}

fn file_hit_to_item(hit: everything::FileHit) -> LauncherItem {
    let kind = if hit.is_folder { "folder" } else { "file" };
    LauncherItem {
        id: format!("{kind}:{}", hit.path.to_ascii_lowercase()),
        kind: kind.to_string(),
        title: hit.name,
        subtitle: hit.parent_dir,
        badge: if hit.is_folder {
            "Folder"
        } else if hit.from_everything {
            "Everything"
        } else {
            "File"
        }
        .to_string(),
        icon: None,
        target: hit.path.clone(),
        args: None,
        hwnd: None,
        score: hit.score,
        match_indices: hit.match_indices,
        requires_confirm: false,
        actions: actions_for_launchable(&hit.path, hit.is_folder),
    }
}

#[tauri::command]
pub async fn search_launcher(app: AppHandle, query: String) -> Result<LauncherSearchResponse, String> {
    let gen = everything::begin_search_generation();
    let max_results = get_setting_str(&app, "nectar-launcher-max-results")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(8)
        .clamp(4, 24);
    let show_recent = get_setting_str(&app, "nectar-launcher-show-recent")
        .map(|v| v != "false")
        .unwrap_or(true);
    let use_everything = get_setting_str(&app, "nectar-launcher-everything")
        .map(|v| v != "false")
        .unwrap_or(true);
    let custom_search_url = get_setting_str(&app, "nectar-launcher-search-url")
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_SEARCH_URL.to_string());

    let ev_available = use_everything && everything::is_everything_available();

    match detect_mode(&query) {
        QueryMode::Windows(w_query) => {
            let items = search_windows_items(w_query, max_results).await;
            Ok(LauncherSearchResponse {
                mode: "windows".to_string(),
                clean_query: w_query.to_string(),
                items,
                calc_card: None,
                everything_available: ev_available,
            })
        }
        QueryMode::Calc(expr) => {
            let calc_res = calc::evaluate(&format!("= {expr}"));
            let mut items = Vec::new();
            let calc_card = calc_res.as_ref().map(|c| {
                items.push(LauncherItem {
                    id: format!("calc:{}", c.expression),
                    kind: "calc".to_string(),
                    title: format!("= {}", c.formatted),
                    subtitle: format!("{} — {}", c.expression, c.note),
                    badge: "Calculator".to_string(),
                    icon: None,
                    target: c.raw.clone(),
                    args: None,
                    hwnd: None,
                    score: 10_000,
                    match_indices: Vec::new(),
                    requires_confirm: false,
                    actions: vec![LauncherAction {
                        id: "copy_path".to_string(),
                        label: "Copy result".to_string(),
                        shortcut: Some("Enter".to_string()),
                        destructive: false,
                    }],
                });
                CalcCard {
                    expression: c.expression.clone(),
                    formatted: c.formatted.clone(),
                    raw: c.raw.clone(),
                    note: c.note.clone(),
                }
            });
            Ok(LauncherSearchResponse {
                mode: "calc".to_string(),
                clean_query: expr.to_string(),
                items,
                calc_card,
                everything_available: ev_available,
            })
        }
        QueryMode::ShellCmd(cmd) | QueryMode::ShellPs(cmd) => {
            let is_ps = matches!(detect_mode(&query), QueryMode::ShellPs(_));
            let items = if cmd.is_empty() {
                vec![]
            } else {
                vec![LauncherItem {
                    id: format!("shell:{}:{}", if is_ps { "ps" } else { "cmd" }, cmd),
                    kind: "shell".to_string(),
                    title: cmd.to_string(),
                    subtitle: if is_ps {
                        "Run command in PowerShell".to_string()
                    } else {
                        "Run command in Terminal / cmd.exe".to_string()
                    },
                    badge: if is_ps { "PowerShell" } else { "Shell" }.to_string(),
                    icon: None,
                    target: cmd.to_string(),
                    args: Some(if is_ps { "ps" } else { "cmd" }.to_string()),
                    hwnd: None,
                    score: 9_900,
                    match_indices: Vec::new(),
                    requires_confirm: false,
                    actions: vec![LauncherAction {
                        id: "open".to_string(),
                        label: "Execute command".to_string(),
                        shortcut: Some("Enter".to_string()),
                        destructive: false,
                    }],
                }]
            };
            Ok(LauncherSearchResponse {
                mode: "shell".to_string(),
                clean_query: cmd.to_string(),
                items,
                calc_card: None,
                everything_available: ev_available,
            })
        }
        QueryMode::Web { engine, query: wq } => {
            let (label, template) = engine_url_template(engine, &custom_search_url);
            let items = if wq.is_empty() {
                vec![]
            } else {
                let url = build_search_url(&template, wq);
                vec![LauncherItem {
                    id: format!("web:{engine}:{wq}"),
                    kind: "web".to_string(),
                    title: format!("Search {label} for \"{wq}\""),
                    subtitle: url.clone(),
                    badge: label.to_string(),
                    icon: None,
                    target: url,
                    args: None,
                    hwnd: None,
                    score: 9_800,
                    match_indices: Vec::new(),
                    requires_confirm: false,
                    actions: vec![LauncherAction {
                        id: "open".to_string(),
                        label: "Open in browser".to_string(),
                        shortcut: Some("Enter".to_string()),
                        destructive: false,
                    }],
                }]
            };
            Ok(LauncherSearchResponse {
                mode: "web".to_string(),
                clean_query: wq.to_string(),
                items,
                calc_card: None,
                everything_available: ev_available,
            })
        }
        QueryMode::Files(fq) => {
            let fq_owned = fq.to_string();
            let (hits, ev) = tauri::async_runtime::spawn_blocking(move || {
                everything::search_files(&fq_owned, max_results, use_everything, gen)
            })
            .await
            .map_err(|e| e.to_string())?;
            let items = hits.into_iter().map(file_hit_to_item).collect();
            Ok(LauncherSearchResponse {
                mode: "files".to_string(),
                clean_query: fq.to_string(),
                items,
                calc_card: None,
                everything_available: ev,
            })
        }
        QueryMode::All(trimmed) => {
            let mru_map = load_mru_map(&app);
            let now = get_now_ms();
            let entries = app_index::collect_entries();

            // Empty query -> recent/frecency apps + quick default apps
            if trimmed.is_empty() {
                let mut items = Vec::new();
                if show_recent {
                    let top = top_mru_entries(&app, max_results);
                    let icon_lookup: HashMap<String, Option<String>> = entries
                        .iter()
                        .map(|e| (e.id.clone(), e.icon.clone()))
                        .collect();
                    for (idx, mru) in top.into_iter().enumerate() {
                        let is_folder = mru.kind == "folder";
                        items.push(LauncherItem {
                            id: mru.id.clone(),
                            kind: mru.kind,
                            title: mru.title,
                            subtitle: mru.subtitle,
                            badge: "Recent".to_string(),
                            icon: icon_lookup.get(&mru.id).cloned().flatten(),
                            target: mru.target.clone(),
                            args: mru.args,
                            hwnd: None,
                            score: 9_000 - (idx as i32 * 25),
                            match_indices: Vec::new(),
                            requires_confirm: false,
                            actions: actions_for_launchable(&mru.target, is_folder),
                        });
                    }
                }
                if items.len() < max_results {
                    let mut existing: HashSet<String> =
                        items.iter().map(|i| i.id.clone()).collect();
                    for entry in entries.into_iter().take(max_results * 2) {
                        if !existing.insert(entry.id.clone()) {
                            continue;
                        }
                        items.push(LauncherItem {
                            id: entry.id,
                            kind: entry.kind.clone(),
                            title: entry.name,
                            subtitle: entry.subtitle,
                            badge: if entry.kind == "settings" {
                                "Settings"
                            } else if entry.is_running {
                                "Running"
                            } else {
                                "App"
                            }
                            .to_string(),
                            icon: entry.icon,
                            target: entry.path.clone(),
                            args: entry.args,
                            hwnd: entry.hwnd,
                            score: if entry.is_running { 4_500 } else { 3_000 },
                            match_indices: Vec::new(),
                            requires_confirm: false,
                            actions: actions_for_launchable(&entry.path, false),
                        });
                        if items.len() >= max_results {
                            break;
                        }
                    }
                }
                return Ok(LauncherSearchResponse {
                    mode: "all".to_string(),
                    clean_query: String::new(),
                    items,
                    calc_card: None,
                    everything_available: ev_available,
                });
            }

            let mut results: Vec<LauncherItem> = Vec::new();

            // Inline currency conversion ("100 usd to eur"); explicit amount +
            // two currency tokens, so it never fires on plain typing.
            if let Some(conv) = currency::parse_conversion(trimmed) {
                if let Some(item) = currency::conversion_item(&conv) {
                    results.push(item);
                }
            }

            let calc_card = calc::evaluate(trimmed).map(|c| {
                results.push(LauncherItem {
                    id: format!("calc:{}", c.expression),
                    kind: "calc".to_string(),
                    title: format!("= {}", c.formatted),
                    subtitle: format!("{} — {}", c.expression, c.note),
                    badge: "Calculator".to_string(),
                    icon: None,
                    target: c.raw.clone(),
                    args: None,
                    hwnd: None,
                    score: 9_800,
                    match_indices: Vec::new(),
                    requires_confirm: false,
                    actions: vec![LauncherAction {
                        id: "copy_path".to_string(),
                        label: "Copy result".to_string(),
                        shortcut: Some("Enter".to_string()),
                        destructive: false,
                    }],
                });
                CalcCard {
                    expression: c.expression,
                    formatted: c.formatted,
                    raw: c.raw,
                    note: c.note,
                }
            });

            if let Some(vol_item) = match_volume_command(trimmed) {
                results.push(vol_item);
            }
            if let Some(run_item) = match_direct_run_target(trimmed, &entries) {
                results.push(run_item);
            }

            // Apps, built-in tools & Windows Settings
            for entry in entries {
                if let Some((base_score, idxs)) =
                    fuzzy::match_candidate(trimmed, &entry.name, Some(&entry.keywords))
                {
                    let mru_boost = mru_map
                        .get(&entry.id)
                        .map(|m| compute_frecency_boost(m, now))
                        .unwrap_or(0);
                    let kind_bias = match entry.kind.as_str() {
                        "app" => 350,
                        "tool" => 120,
                        _ => 60,
                    };
                    results.push(LauncherItem {
                        id: entry.id,
                        kind: entry.kind.clone(),
                        title: entry.name,
                        subtitle: entry.subtitle,
                        badge: match entry.kind.as_str() {
                            "settings" => "Settings",
                            "tool" => "Tool",
                            _ if entry.is_running => "Running",
                            _ => "App",
                        }
                        .to_string(),
                        icon: entry.icon,
                        target: entry.path.clone(),
                        args: entry.args,
                        hwnd: entry.hwnd,
                        score: base_score + mru_boost + kind_bias,
                        match_indices: idxs,
                        requires_confirm: false,
                        actions: actions_for_launchable(&entry.path, false),
                    });
                }
            }

            // System / Power commands
            for &(id, title, subtitle, target, keywords, requires_confirm) in
                system_commands_catalog()
            {
                if let Some((base_score, idxs)) =
                    fuzzy::match_candidate(trimmed, title, Some(keywords))
                {
                    results.push(LauncherItem {
                        id: id.to_string(),
                        kind: "system".to_string(),
                        title: title.to_string(),
                        subtitle: subtitle.to_string(),
                        badge: "System".to_string(),
                        icon: None,
                        target: target.to_string(),
                        args: None,
                        hwnd: None,
                        score: base_score,
                        match_indices: idxs,
                        requires_confirm,
                        actions: vec![LauncherAction {
                            id: "open".to_string(),
                            label: "Run command".to_string(),
                            shortcut: Some("Enter".to_string()),
                            destructive: requires_confirm,
                        }],
                    });
                }
            }

            // Plain typing stays apps/system/calc only. File search and web search
            // need their explicit prefix ("? " files, "g "/"yt "/"gh "/"wiki " web).

            results.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.title.len().cmp(&b.title.len())));
            results.truncate(max_results);

            Ok(LauncherSearchResponse {
                mode: if calc_card.is_some() { "calc" } else { "all" }.to_string(),
                clean_query: trimmed.to_string(),
                items: results,
                calc_card,
                everything_available: ev_available,
            })
        }
    }
}

async fn execute_system_target(app: &AppHandle, target: &str) -> Result<(), String> {
    match target {
        "sys:wifi_toggle" => {
            let status = get_wifi_status().await?;
            set_wifi_state(!status.enabled).await?;
        }
        "sys:bt_toggle" => {
            let enabled = get_bluetooth_state().await?;
            set_bluetooth_state(!enabled).await?;
        }
        "sys:mute" => {
            if let Some(sender) = COMMAND_SENDER.get() {
                let _ = sender.send(SystemCommand::VolumeMute);
            }
        }
        "sys:night_light" => tauri::async_runtime::spawn_blocking(|| {
            shell_execute_verb("open", "ms-settings:nightlight", None)
        })
        .await
        .map_err(|e| e.to_string())??,
        "sys:dark_mode" => tauri::async_runtime::spawn_blocking(|| set_windows_dark_mode(true))
            .await
            .map_err(|e| e.to_string())??,
        "sys:light_mode" => tauri::async_runtime::spawn_blocking(|| set_windows_dark_mode(false))
            .await
            .map_err(|e| e.to_string())??,
        "sys:lock" => tauri::async_runtime::spawn_blocking(|| run_power_action("lock"))
            .await
            .map_err(|e| e.to_string())??,
        "sys:sign_out" => tauri::async_runtime::spawn_blocking(|| run_power_action("sign_out"))
            .await
            .map_err(|e| e.to_string())??,
        "sys:sleep" => tauri::async_runtime::spawn_blocking(|| run_power_action("sleep"))
            .await
            .map_err(|e| e.to_string())??,
        "sys:hibernate" => tauri::async_runtime::spawn_blocking(|| run_power_action("hibernate"))
            .await
            .map_err(|e| e.to_string())??,
        "sys:restart" => tauri::async_runtime::spawn_blocking(|| run_power_action("restart"))
            .await
            .map_err(|e| e.to_string())??,
        "sys:shutdown" => tauri::async_runtime::spawn_blocking(|| run_power_action("shutdown"))
            .await
            .map_err(|e| e.to_string())??,
        "sys:empty_bin" => tauri::async_runtime::spawn_blocking(empty_recycle_bin)
            .await
            .map_err(|e| e.to_string())??,
        "sys:nectar_settings" => open_settings_window(app.clone()),
        "sys:nectar_restart" => restart_nectar(app.clone()).await,
        "sys:nectar_quit" => quit_nectar(app.clone()).await,
        v if v.starts_with("sys:vol:") => {
            let pct: f32 = v
                .trim_start_matches("sys:vol:")
                .parse()
                .map_err(|_| "Invalid volume value".to_string())?;
            set_volume((pct / 100.0).clamp(0.0, 1.0));
        }
        other => return Err(format!("Unknown system command: {other}")),
    }
    Ok(())
}

#[tauri::command]
pub async fn execute_launcher_item(
    app: AppHandle,
    item: LauncherItem,
    query: Option<String>,
    confirmed: Option<bool>,
) -> Result<(), String> {
    if item.requires_confirm && !confirmed.unwrap_or(false) {
        return Err("Confirmation required before running this command".to_string());
    }

    match item.kind.as_str() {
        "calc" => {
            set_clipboard_utf16(&item.target)?;
        }
        "window" => {
            if let Some(hwnd) = item.hwnd {
                bring_window_forward(hwnd).await;
            }
        }
        "shell" => {
            let is_ps = item.args.as_deref() == Some("ps");
            let cmd = item.target.clone();
            tauri::async_runtime::spawn_blocking(move || launch_shell_command(&cmd, is_ps))
                .await
                .map_err(|e| e.to_string())??;
        }
        "web" | "settings" => {
            let target = item.target.clone();
            tauri::async_runtime::spawn_blocking(move || shell_execute_verb("open", &target, None))
                .await
                .map_err(|e| e.to_string())??;
        }
        "system" => {
            execute_system_target(&app, &item.target).await?;
        }
        _ => {
            if item.target == "nectar-settings" {
                open_settings_window(app.clone());
            } else {
                let target = item.target.clone();
                let args = item.args.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    crate::commands::launch_path(&target, args.as_deref())
                })
                .await
                .map_err(|e| e.to_string())?;
            }
        }
    }

    let q = query.unwrap_or_default();
    record_launch_usage(&app, &q, &item);
    Ok(())
}

#[tauri::command]
pub async fn execute_launcher_action(
    app: AppHandle,
    item: LauncherItem,
    action_id: String,
    query: Option<String>,
    confirmed: Option<bool>,
) -> Result<String, String> {
    match action_id.as_str() {
        "open" => {
            execute_launcher_item(app, item, query, confirmed).await?;
            Ok("Opened".to_string())
        }
        "copy_path" => {
            set_clipboard_utf16(&item.target)?;
            Ok(if item.kind == "calc" {
                "start.action.copied"
            } else {
                "start.action.copiedPath"
            }
            .to_string())
        }
        "open_location" => {
            let target = item.target.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let mut actual = if target.to_ascii_lowercase().ends_with(".lnk") {
                    resolve_shortcut(&target).map(|(p, _)| p).unwrap_or(target)
                } else {
                    target
                };
                if !actual.contains('\\') && !actual.contains('/') {
                    if let Some(resolved) = crate::utils::resolve_executable_path(&actual) {
                        actual = resolved;
                    }
                }
                if !Path::new(&actual).exists() {
                    return Err("File location is not available for this entry".to_string());
                }
                std::process::Command::new("explorer.exe")
                    .raw_arg(format!("/select,\"{}\"", actual.replace('"', "")))
                    .spawn()
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| e.to_string())??;
            Ok("Opened in Explorer".to_string())
        }
        "run_as_admin" => {
            let target = item.target.clone();
            let args = item.args.clone();
            let launched = tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
                let lower = target.to_ascii_lowercase();
                if lower.starts_with("ms-")
                    || lower.starts_with("http")
                    || lower.starts_with("shell:")
                    || target == "nectar-settings"
                    || crate::commands::is_aumid_path(&target)
                {
                    return Ok(false);
                }
                let (actual, resolved_args) = if target.to_ascii_lowercase().ends_with(".lnk") {
                    resolve_shortcut(&target).unwrap_or((target, args.unwrap_or_default()))
                } else {
                    (target, args.unwrap_or_default())
                };
                shell_execute_verb("runas", &actual, (!resolved_args.is_empty()).then_some(&resolved_args))?;
                Ok(true)
            })
            .await
            .map_err(|e| e.to_string())??;
            Ok(if launched {
                "Launched as Administrator".to_string()
            } else {
                "start.action.adminUnavailable".to_string()
            })
        }
        "properties" => {
            let target = item.target.clone();
            let hwnd = item.hwnd;
            let resolved = tauri::async_runtime::spawn_blocking(move || {
                let trimmed = target.trim().to_string();
                let lower = trimmed.to_ascii_lowercase();
                if lower.starts_with("shell:") && !crate::commands::is_aumid_path(&trimmed) {
                    return Ok::<(String, bool), String>((trimmed, true));
                }
                if let Some((actual, _)) =
                    crate::commands::resolve_app_file_target(&trimmed, None, None, hwnd, true)
                {
                    return Ok((actual, false));
                }
                if Path::new(&trimmed).exists() {
                    return Ok((trimmed, false));
                }
                Err("properties_unavailable".to_string())
            })
            .await
            .map_err(|e| e.to_string())??;
            tauri::async_runtime::spawn_blocking(move || {
                crate::commands::show_properties_blocking(resolved.0, resolved.1)
            })
            .await
            .map_err(|e| e.to_string())??;
            Ok("Opened Properties".to_string())
        }
        "toggle_pin_start" => {
            let pinned = crate::start_menu::toggle_pin_entry(
                &app,
                &item.title,
                &item.target,
                item.args.as_deref(),
            )?;
            Ok(if pinned {
                "start.action.pinnedStart"
            } else {
                "start.action.unpinnedStart"
            }
            .to_string())
        }
        "toggle_pin_dock" => {
            let mut apps = load_pinned_apps(app.clone()).await;
            let exists_idx = apps.iter().position(|a| a.path.eq_ignore_ascii_case(&item.target));
            let msg = if let Some(idx) = exists_idx {
                apps.remove(idx);
                "start.action.unpinnedDock"
            } else {
                let exe = Path::new(&item.target)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string());
                apps.push(AppInfo {
                    name: item.title.clone(),
                    path: item.target.clone(),
                    icon: item.icon.clone(),
                    is_running: false,
                    hwnd: None,
                    executable: exe,
                    all_hwnds: None,
                    args: item.args.clone(),
                });
                "start.action.pinnedDock"
            };
            save_pinned_apps(app.clone(), apps).await?;
            let _ = app.emit("pinned-apps-updated", ());
            Ok(msg.to_string())
        }
        other => Err(format!("Unknown action: {other}")),
    }
}

#[tauri::command]
pub fn get_launcher_history(app: AppHandle) -> Vec<HistoryEntry> {
    load_history_file(&app)
}

#[tauri::command]
pub fn clear_launcher_history(app: AppHandle) -> Result<(), String> {
    let path = history_path(&app)?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn copy_text_to_clipboard(text: String) -> Result<(), String> {
    set_clipboard_utf16(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_all_launcher_query_modes() {
        assert_eq!(detect_mode("= 2+2"), QueryMode::Calc("2+2"));
        assert_eq!(detect_mode("? report ext:pdf"), QueryMode::Files("report ext:pdf"));
        assert_eq!(detect_mode("w chrome"), QueryMode::Windows("chrome"));
        assert_eq!(detect_mode("> ipconfig"), QueryMode::ShellCmd("ipconfig"));
        assert_eq!(detect_mode(">> Get-Date"), QueryMode::ShellPs("Get-Date"));
        assert_eq!(
            detect_mode("gh tauri-apps/tauri"),
            QueryMode::Web {
                engine: "github",
                query: "tauri-apps/tauri"
            }
        );
        assert_eq!(detect_mode("vscode"), QueryMode::All("vscode"));
    }

    #[test]
    fn encodes_urls_cleanly() {
        assert_eq!(percent_encode("rust tauri v2!"), "rust%20tauri%20v2%21");
        assert_eq!(
            build_search_url("https://www.google.com/search?q={query}", "привет мир"),
            "https://www.google.com/search?q=%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82%20%D0%BC%D0%B8%D1%80"
        );
    }

    #[test]
    fn history_deduplicates_and_caps_at_32() {
        let mut hist = Vec::new();
        for i in 0..40 {
            hist = push_history_entry(
                hist,
                HistoryEntry {
                    query: format!("q{i}"),
                    item_title: format!("App {i}"),
                    item_id: format!("id:{i}"),
                    kind: "app".to_string(),
                    target: format!("C:\\app{i}.exe"),
                    timestamp_ms: i as i64,
                },
            );
        }
        assert_eq!(hist.len(), MAX_HISTORY_ENTRIES);
        // Re-inserting an older query promotes it without duplicating
        hist = push_history_entry(
            hist,
            HistoryEntry {
                query: "Q15".to_string(),
                item_title: "App 15".to_string(),
                item_id: "id:15".to_string(),
                kind: "app".to_string(),
                target: "C:\\app15.exe".to_string(),
                timestamp_ms: 999,
            },
        );
        assert_eq!(hist.len(), MAX_HISTORY_ENTRIES);
        assert_eq!(hist[0].item_id, "id:15");
    }

    #[test]
    fn frecency_favors_recent_and_frequent_entries() {
        let now = 1_000_000_000i64;
        let fresh = MruEntry {
            id: "a".into(),
            title: "A".into(),
            subtitle: "".into(),
            target: "".into(),
            args: None,
            kind: "app".into(),
            count: 3,
            last_used_ms: now - 60_000,
        };
        let stale = MruEntry {
            id: "b".into(),
            title: "B".into(),
            subtitle: "".into(),
            target: "".into(),
            args: None,
            kind: "app".into(),
            count: 3,
            last_used_ms: now - 20 * 86_400_000,
        };
        assert!(compute_frecency_boost(&fresh, now) > compute_frecency_boost(&stale, now));
    }

    #[test]
    fn russian_system_commands_and_volume_match() {
        let matches_id = |q: &str, expected: &str| {
            system_commands_catalog().iter().any(|&(id, title, _, _, kw, _)| {
                id == expected && fuzzy::match_candidate(q, title, Some(kw)).is_some()
            })
        };
        assert!(matches_id("выключить", "sys:shutdown"));
        assert!(matches_id("перезагрузка", "sys:restart"));
        assert!(matches_id("сон", "sys:sleep"));
        assert!(matches_id("блокировка", "sys:lock"));
        assert!(matches_id("корзина", "sys:empty_bin"));
        assert!(matches_id("настройки", "sys:nectar_settings"));
        assert!(matches_id("параметры", "sys:nectar_settings"));
        assert!(matches_id("звук", "sys:mute"));
        assert!(matches_id("сеть", "sys:wifi"));
        assert!(matches_id("блютуз", "sys:bluetooth"));

        assert_eq!(match_volume_command("громкость 45").map(|i| i.id), Some("sys:vol:45".into()));
        assert_eq!(match_volume_command("звук 80%").map(|i| i.id), Some("sys:vol:80".into()));
    }

    #[test]
    fn direct_run_and_properties_action_supported() {
        let acts = actions_for_launchable("C:\\Windows\\notepad.exe", false);
        assert!(acts.iter().any(|a| a.id == "properties" && a.shortcut.as_deref() == Some("Ctrl+P")));
        assert!(acts.iter().any(|a| a.id == "run_as_admin"));

        let folder_acts = actions_for_launchable("C:\\Windows", true);
        assert!(folder_acts.iter().any(|a| a.id == "properties"));
        assert!(!folder_acts.iter().any(|a| a.id == "run_as_admin"));

        let uri_item = match_direct_run_target("ms-settings:appsfeatures", &[]).expect("uri hit");
        assert_eq!(uri_item.kind, "settings");
        assert_eq!(uri_item.target, "ms-settings:appsfeatures");

        let expanded_dir = match_direct_run_target("%SystemRoot%", &[]).expect("env dir hit");
        assert_eq!(expanded_dir.kind, "folder");
        assert!(Path::new(&expanded_dir.target).exists());
    }
}
