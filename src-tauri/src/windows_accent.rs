use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{
    ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_PATH_NOT_FOUND, LPARAM, WPARAM,
};
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
    HKEY, HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE, REG_BINARY, REG_DWORD, REG_EXPAND_SZ,
    REG_OPTION_NON_VOLATILE, REG_SZ,
};
use windows::Win32::UI::WindowsAndMessaging::{
    SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
};

const DWM: &str = r"Software\Microsoft\Windows\DWM";
const ACCENT: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\Accent";
const COLORS: &str = r"Control Panel\Colors";
const VALUES: &[(&str, &str, bool)] = &[
    (DWM, "AccentColor", false),
    (DWM, "ColorizationColor", false),
    (DWM, "ColorizationAfterglow", false),
    (ACCENT, "AccentColorMenu", false),
    (ACCENT, "StartColorMenu", false),
    (ACCENT, "AccentPalette", true),
];
const SELECTION_VALUES: &[&str] = &["Hilight", "HotTrackingColor"];

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(tag = "type", content = "value")]
enum Saved {
    Dword(u32),
    Binary(Vec<u8>),
    Str(String),
    Missing,
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn backup_file(app: &AppHandle, filename: &str) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(filename))
}

fn backup_path(app: &AppHandle) -> Option<PathBuf> {
    backup_file(app, "windows-accent-backup.json")
}

fn selection_backup_path(app: &AppHandle) -> Option<PathBuf> {
    backup_file(app, "windows-selection-backup.json")
}

fn read_value(key: &str, name: &str, binary: bool) -> Saved {
    unsafe {
        let key_w = wide(key);
        let name_w = wide(name);
        let mut hkey = HKEY::default();
        if RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(key_w.as_ptr()), Some(0), KEY_READ, &mut hkey).is_err() {
            return Saved::Missing;
        }
        let mut buf = [0u8; 64];
        let mut size = buf.len() as u32;
        let mut kind = if binary { REG_BINARY } else { REG_DWORD };
        let ok = RegQueryValueExW(hkey, PCWSTR(name_w.as_ptr()), None, Some(&mut kind), Some(buf.as_mut_ptr()), Some(&mut size)).is_ok();
        let _ = RegCloseKey(hkey);
        if !ok {
            return Saved::Missing;
        }
        if binary {
            Saved::Binary(buf[..size as usize].to_vec())
        } else {
            Saved::Dword(u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]))
        }
    }
}

fn read_str_value(key: &str, name: &str) -> Result<Saved, String> {
    unsafe {
        let key_w = wide(key);
        let name_w = wide(name);
        let mut hkey = HKEY::default();
        let open_res = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(key_w.as_ptr()),
            Some(0),
            KEY_READ,
            &mut hkey,
        );
        if open_res == ERROR_FILE_NOT_FOUND || open_res == ERROR_PATH_NOT_FOUND {
            return Ok(Saved::Missing);
        }
        if open_res.is_err() {
            return Err(format!("Failed to open registry key {key}: {open_res:?}"));
        }
        let mut size_bytes = 0u32;
        let mut kind = REG_SZ;
        let probe = RegQueryValueExW(
            hkey,
            PCWSTR(name_w.as_ptr()),
            None,
            Some(&mut kind),
            None,
            Some(&mut size_bytes),
        );
        if probe == ERROR_FILE_NOT_FOUND || probe == ERROR_PATH_NOT_FOUND {
            let _ = RegCloseKey(hkey);
            return Ok(Saved::Missing);
        }
        if probe.is_err() && probe != ERROR_MORE_DATA {
            let _ = RegCloseKey(hkey);
            return Err(format!("Failed to query registry value {name}: {probe:?}"));
        }
        if kind != REG_SZ && kind != REG_EXPAND_SZ {
            let _ = RegCloseKey(hkey);
            return Err(format!("Unexpected registry value type for {name}"));
        }
        let needed_u16 = (size_bytes as usize).div_ceil(std::mem::size_of::<u16>()).max(1);
        let mut buf = vec![0u16; needed_u16];
        let mut actual_bytes = (buf.len() * std::mem::size_of::<u16>()) as u32;
        let read_res = RegQueryValueExW(
            hkey,
            PCWSTR(name_w.as_ptr()),
            None,
            Some(&mut kind),
            Some(buf.as_mut_ptr() as *mut u8),
            Some(&mut actual_bytes),
        );
        let _ = RegCloseKey(hkey);
        if read_res == ERROR_FILE_NOT_FOUND || read_res == ERROR_PATH_NOT_FOUND {
            return Ok(Saved::Missing);
        }
        if read_res.is_err() {
            return Err(format!("Failed to read registry value {name}: {read_res:?}"));
        }
        let units = ((actual_bytes as usize) / std::mem::size_of::<u16>()).min(buf.len());
        let end = buf[..units].iter().position(|&c| c == 0).unwrap_or(units);
        let s = String::from_utf16_lossy(&buf[..end]).trim().to_string();
        if s.is_empty() {
            Ok(Saved::Missing)
        } else {
            Ok(Saved::Str(s))
        }
    }
}

fn write_value(key: &str, name: &str, value: &Saved) -> bool {
    unsafe {
        let key_w = wide(key);
        let name_w = wide(name);
        let mut hkey = HKEY::default();
        if RegCreateKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(key_w.as_ptr()),
            Some(0),
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            None,
            &mut hkey,
            None,
        )
        .is_err()
        {
            return false;
        }
        let ok = match value {
            Saved::Dword(v) => RegSetValueExW(hkey, PCWSTR(name_w.as_ptr()), Some(0), REG_DWORD, Some(&v.to_le_bytes())).is_ok(),
            Saved::Binary(b) => RegSetValueExW(hkey, PCWSTR(name_w.as_ptr()), Some(0), REG_BINARY, Some(b)).is_ok(),
            Saved::Str(s) => {
                let wide_val = wide(s);
                let bytes = std::slice::from_raw_parts(
                    wide_val.as_ptr() as *const u8,
                    wide_val.len() * std::mem::size_of::<u16>(),
                );
                RegSetValueExW(hkey, PCWSTR(name_w.as_ptr()), Some(0), REG_SZ, Some(bytes)).is_ok()
            }
            Saved::Missing => {
                let _ = RegDeleteValueW(hkey, PCWSTR(name_w.as_ptr()));
                true
            }
        };
        let _ = RegCloseKey(hkey);
        ok
    }
}

fn broadcast() {
    let setting = wide("ImmersiveColorSet");
    unsafe {
        let mut result = 0usize;
        let _ = SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            WPARAM(0),
            LPARAM(setting.as_ptr() as isize),
            SMTO_ABORTIFHUNG,
            200,
            Some(&mut result),
        );
    }
}

fn parse_hex(hex: &str) -> Option<[u8; 3]> {
    let h = hex.trim().trim_start_matches('#');
    if h.len() != 6 {
        return None;
    }
    let n = u32::from_str_radix(h, 16).ok()?;
    Some([(n >> 16) as u8, (n >> 8) as u8, n as u8])
}

pub(crate) fn parse_rgb_triplet(s: &str) -> Option<[u8; 3]> {
    let mut parts = s.split_whitespace();
    let r = parts.next()?.parse::<u8>().ok()?;
    let g = parts.next()?.parse::<u8>().ok()?;
    let b = parts.next()?.parse::<u8>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some([r, g, b])
}

pub(crate) fn format_rgb_triplet(c: [u8; 3]) -> String {
    format!("{} {} {}", c[0], c[1], c[2])
}

pub(crate) fn rgb_to_hex(c: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])
}

pub(crate) fn selection_border_from_fill(fill: [u8; 3]) -> [u8; 3] {
    mix(fill, 0, 0.16)
}

fn mix(c: [u8; 3], to: u8, t: f32) -> [u8; 3] {
    let f = |v: u8| (v as f32 + (to as f32 - v as f32) * t).round().clamp(0.0, 255.0) as u8;
    [f(c[0]), f(c[1]), f(c[2])]
}

pub(crate) fn build_accent_palette(base: [u8; 3], existing_palette: Option<&[u8]>) -> Vec<u8> {
    let swatches = [
        mix(base, 255, 0.6),
        mix(base, 255, 0.4),
        mix(base, 255, 0.2),
        base,
        mix(base, 0, 0.2),
        mix(base, 0, 0.4),
        mix(base, 0, 0.6),
    ];
    let mut palette = Vec::with_capacity(32);
    for c in swatches {
        palette.extend_from_slice(&[c[0], c[1], c[2], 0x00]);
    }
    if let Some(prev) = existing_palette.filter(|p| p.len() >= 32) {
        palette.extend_from_slice(&[prev[28], prev[29], prev[30], 0x00]);
    } else {
        let dark4 = mix(base, 0, 0.8);
        palette.extend_from_slice(&[dark4[0], dark4[1], dark4[2], 0x00]);
    }
    palette
}

pub(crate) fn accent_palette_has_corrupt_alpha(bytes: &[u8]) -> bool {
    bytes.len() >= 32
        && [3usize, 7, 11, 15, 19, 23, 27, 31]
            .into_iter()
            .any(|idx| bytes[idx] != 0)
}

fn abgr(c: [u8; 3]) -> u32 {
    0xFF00_0000 | (c[2] as u32) << 16 | (c[1] as u32) << 8 | c[0] as u32
}

fn argb(c: [u8; 3]) -> u32 {
    0xC400_0000 | (c[0] as u32) << 16 | (c[1] as u32) << 8 | c[2] as u32
}

fn backup_palette(app: &AppHandle) -> Option<Vec<u8>> {
    let path = backup_path(app)?;
    let text = std::fs::read_to_string(path).ok()?;
    let saved: BTreeMap<String, Saved> = serde_json::from_str(&text).ok()?;
    match saved.get(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Accent|AccentPalette") {
        Some(Saved::Binary(bytes)) if bytes.len() >= 32 => Some(bytes.clone()),
        _ => None,
    }
}

pub fn repair_corrupt_accent_palette_if_needed(app: &AppHandle) {
    if !has_backup(app) {
        return;
    }
    let Saved::Binary(mut current) = read_value(ACCENT, "AccentPalette", true) else {
        return;
    };
    if !accent_palette_has_corrupt_alpha(&current) {
        return;
    }
    for idx in [3usize, 7, 11, 15, 19, 23, 27, 31] {
        if idx < current.len() {
            current[idx] = 0x00;
        }
    }
    if let Some(orig) = backup_palette(app) {
        if current.len() >= 32 && orig.len() >= 32 {
            current[28] = orig[28];
            current[29] = orig[29];
            current[30] = orig[30];
            current[31] = 0x00;
        }
    }
    if write_value(ACCENT, "AccentPalette", &Saved::Binary(current)) {
        crate::diagnostics::log("theme: repaired corrupt AccentPalette alpha bytes");
        std::thread::spawn(broadcast);
    }
}

pub fn has_backup(app: &AppHandle) -> bool {
    backup_path(app).is_some_and(|p| p.is_file())
}

pub fn sync(app: &AppHandle, hex: &str) -> Result<(), String> {
    let base = parse_hex(hex).ok_or("Invalid color")?;
    let path = backup_path(app).ok_or("No settings folder")?;
    if !path.is_file() {
        let saved: BTreeMap<String, Saved> = VALUES
            .iter()
            .map(|(k, n, binary)| (format!("{k}|{n}"), read_value(k, n, *binary)))
            .collect();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let json = serde_json::to_string_pretty(&saved).map_err(|e| e.to_string())?;
        std::fs::write(&path, json).map_err(|e| e.to_string())?;
    }

    let existing_palette = backup_palette(app).or_else(|| match read_value(ACCENT, "AccentPalette", true) {
        Saved::Binary(b) => Some(b),
        _ => None,
    });
    let palette = build_accent_palette(base, existing_palette.as_deref());
    let dark = mix(base, 0, 0.25);
    let new_values = [
        Saved::Dword(abgr(base)),
        Saved::Dword(argb(base)),
        Saved::Dword(argb(base)),
        Saved::Dword(abgr(base)),
        Saved::Dword(abgr(dark)),
        Saved::Binary(palette),
    ];
    let already_synced = VALUES
        .iter()
        .zip(new_values.iter())
        .all(|((k, n, binary), v)| read_value(k, n, *binary) == *v);
    if already_synced {
        return Ok(());
    }
    for ((k, n, _), v) in VALUES.iter().zip(new_values.iter()) {
        if !write_value(k, n, v) {
            return Err(format!("Failed to write Windows accent registry value {n}"));
        }
    }
    std::thread::spawn(broadcast);
    Ok(())
}

pub fn restore(app: &AppHandle) -> Result<(), String> {
    let path = backup_path(app).ok_or("No settings folder")?;
    let text = std::fs::read_to_string(&path).map_err(|_| "There is no saved Windows accent to restore".to_string())?;
    let saved: BTreeMap<String, Saved> = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    for (k, n, _) in VALUES {
        if let Some(v) = saved.get(&format!("{k}|{n}")) {
            if !write_value(k, n, v) {
                return Err(format!("Failed to restore Windows accent registry value {n}"));
            }
        }
    }
    let _ = std::fs::remove_file(&path);
    std::thread::spawn(broadcast);
    Ok(())
}

pub fn get_selection_color() -> Option<String> {
    for name in ["HotTrackingColor", "Hilight"] {
        if let Ok(Saved::Str(s)) = read_str_value(COLORS, name) {
            if let Some(rgb) = parse_rgb_triplet(&s) {
                return Some(rgb_to_hex(rgb));
            }
        }
    }
    None
}

pub fn has_selection_backup(app: &AppHandle) -> bool {
    selection_backup_path(app).is_some_and(|p| p.is_file())
}

pub fn sync_selection(app: &AppHandle, hex: &str) -> Result<(), String> {
    let base = parse_hex(hex).ok_or("Invalid color")?;
    let path = selection_backup_path(app).ok_or("No settings folder")?;
    if !path.is_file() {
        let mut saved = BTreeMap::new();
        for name in SELECTION_VALUES {
            saved.insert(format!("{COLORS}|{name}"), read_str_value(COLORS, name)?);
        }
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let json = serde_json::to_string_pretty(&saved).map_err(|e| e.to_string())?;
        std::fs::write(&path, json).map_err(|e| e.to_string())?;
    }

    let border = selection_border_from_fill(base);
    let target_hot = Saved::Str(format_rgb_triplet(base));
    let target_hilight = Saved::Str(format_rgb_triplet(border));
    if read_str_value(COLORS, "HotTrackingColor").ok().as_ref() == Some(&target_hot)
        && read_str_value(COLORS, "Hilight").ok().as_ref() == Some(&target_hilight)
    {
        return Ok(());
    }
    if !write_value(COLORS, "HotTrackingColor", &target_hot)
        || !write_value(COLORS, "Hilight", &target_hilight)
    {
        return Err("Failed to write Windows selection colors to registry".to_string());
    }
    Ok(())
}

pub fn restore_selection(app: &AppHandle) -> Result<(), String> {
    let path = selection_backup_path(app).ok_or("No settings folder")?;
    let text = std::fs::read_to_string(&path)
        .map_err(|_| "There is no saved Windows selection color to restore".to_string())?;
    let saved: BTreeMap<String, Saved> = serde_json::from_str(&text).map_err(|e| e.to_string())?;

    for &name in SELECTION_VALUES {
        let key = format!("{COLORS}|{name}");
        if let Some(v) = saved.get(&key).or_else(|| saved.get(name)) {
            if !write_value(COLORS, name, v) {
                return Err(format!("Failed to restore Windows selection registry value {name}"));
            }
        }
    }
    let _ = std::fs::remove_file(&path);
    Ok(())
}

fn explorer_tray_pid() -> Option<u32> {
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

    let hwnd = crate::tray_host::explorer_tray_hwnd()?;
    let mut pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }
    (pid != 0).then_some(pid)
}

fn explorer_process_pids() -> std::collections::HashSet<u32> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };

    let mut pids = std::collections::HashSet::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return pids;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                let end = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..end]);
                if name.eq_ignore_ascii_case("explorer.exe") {
                    pids.insert(entry.th32ProcessID);
                }
                if Process32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    pids
}

pub fn restart_explorer_for_theme(app: &AppHandle) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let old_pid = explorer_tray_pid();
    let old_pids = explorer_process_pids();

    let kill_output = std::process::Command::new("taskkill")
        .args(["/F", "/IM", "explorer.exe"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Failed to stop Explorer: {e}"))?;
    if !kill_output.status.success() {
        let stderr = String::from_utf8_lossy(&kill_output.stderr);
        crate::diagnostics::log(&format!(
            "theme: taskkill explorer.exe exited with {:?}: {}",
            kill_output.status.code(),
            stderr.trim()
        ));
    }

    // Give Windows Winlogon AutoRestartShell up to 1.5s to spawn a new explorer.exe process
    // before launching manually (prevents double-spawning Explorer and opening an unwanted folder window).
    let auto_deadline = std::time::Instant::now() + std::time::Duration::from_millis(1500);
    let mut respawned = false;
    while std::time::Instant::now() < auto_deadline {
        let new_tray = explorer_tray_pid().is_some_and(|p| old_pid.is_none_or(|old| p != old));
        let new_proc = explorer_process_pids().iter().any(|p| !old_pids.contains(p));
        if new_tray || new_proc {
            respawned = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    if !respawned {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
        let explorer = format!(r"{root}\explorer.exe");
        std::process::Command::new(&explorer)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Failed to start Explorer: {e}"))?;
    }

    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(5000);
    let mut tray_ready = false;
    while std::time::Instant::now() < deadline {
        if explorer_tray_pid().is_some_and(|new_pid| old_pid.is_none_or(|old| new_pid != old)) {
            tray_ready = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    let keep_hidden = crate::state::HOOK_DOCK_ENABLED.load(Ordering::Relaxed)
        && !crate::state::SHUTTING_DOWN.load(Ordering::Relaxed);
    if keep_hidden {
        if !tray_ready {
            crate::diagnostics::log("theme: timed out waiting for Shell_TrayWnd after Explorer restart");
        } else {
            std::thread::sleep(std::time::Duration::from_millis(150));
            crate::utils::set_taskbar_visibility(false, false);
            crate::state::NATIVE_TASKBAR_HIDDEN.store(true, Ordering::SeqCst);
            crate::tray_host::outrank();

            let ah = app.clone();
            let _ = app.run_on_main_thread(move || {
                for (label, win) in ah.webview_windows() {
                    if crate::state::is_dock_label(&label)
                        || crate::state::is_notch_label(&label)
                        || label == "overlay"
                    {
                        if win.is_visible().unwrap_or(false) {
                            if let Ok(hwnd) = win.hwnd() {
                                crate::utils::re_assert_topmost(hwnd);
                            }
                        }
                    }
                }
            });
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        accent_palette_has_corrupt_alpha, build_accent_palette, format_rgb_triplet, parse_hex,
        parse_rgb_triplet, rgb_to_hex, selection_border_from_fill,
    };

    #[test]
    fn parses_and_formats_hex_and_rgb_triplets() {
        assert_eq!(parse_hex("#0078d7"), Some([0, 120, 215]));
        assert_eq!(parse_hex("38BDF8"), Some([56, 189, 248]));
        assert_eq!(parse_hex("#12345"), None);
        assert_eq!(parse_hex("zzzzzz"), None);

        assert_eq!(parse_rgb_triplet("0 120 215"), Some([0, 120, 215]));
        assert_eq!(parse_rgb_triplet("  255   0  128 "), Some([255, 0, 128]));
        assert_eq!(parse_rgb_triplet("0 120"), None);
        assert_eq!(parse_rgb_triplet("0 120 215 1"), None);
        assert_eq!(parse_rgb_triplet("0 256 215"), None);

        assert_eq!(format_rgb_triplet([0, 120, 215]), "0 120 215");
        assert_eq!(rgb_to_hex([0, 120, 215]), "#0078d7");
        assert_eq!(rgb_to_hex([56, 189, 248]), "#38bdf8");
    }

    #[test]
    fn selection_border_darkens_fill_for_crisp_contrast() {
        let fill = [56, 189, 248];
        let border = selection_border_from_fill(fill);
        assert_eq!(border, [47, 159, 208]);
        assert!(border[0] < fill[0] && border[1] < fill[1] && border[2] < fill[2]);

        assert_eq!(selection_border_from_fill([0, 0, 0]), [0, 0, 0]);
    }

    #[test]
    fn accent_palette_uses_zero_reserved_bytes_and_preserves_slot7() {
        let existing = vec![
            1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0, 10, 11, 12, 0,
            13, 14, 15, 0, 16, 17, 18, 0, 19, 20, 21, 0, 45, 125, 154, 0xff,
        ];
        let built = build_accent_palette([0xc5, 0x8b, 0xff], Some(&existing));
        assert_eq!(built.len(), 32);
        assert!(!accent_palette_has_corrupt_alpha(&built));
        for slot in 0..8 {
            assert_eq!(built[slot * 4 + 3], 0x00, "slot {slot} reserved byte must be 0");
        }
        assert_eq!(&built[12..16], &[0xc5, 0x8b, 0xff, 0x00]);
        assert_eq!(&built[28..32], &[45, 125, 154, 0x00]);

        assert!(accent_palette_has_corrupt_alpha(&existing));
        let fallback = build_accent_palette([0xc5, 0x8b, 0xff], None);
        assert_eq!(fallback.len(), 32);
        assert!(!accent_palette_has_corrupt_alpha(&fallback));
    }
}
