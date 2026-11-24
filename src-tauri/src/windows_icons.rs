use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use windows::core::{Interface, GUID, PCWSTR};
use windows::Win32::Storage::FileSystem::{
    GetFileAttributesW, SetFileAttributesW, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_READONLY,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_SYSTEM, INVALID_FILE_ATTRIBUTES,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoTaskMemFree, IPersistFile, CLSCTX_ALL, STGM_READWRITE,
};
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
    HKEY, HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE, REG_EXPAND_SZ, REG_OPTION_NON_VOLATILE,
    REG_SZ,
};
use windows::Win32::UI::Shell::{
    ExtractIconExW, IShellItemImageFactory, IShellLinkW, SHChangeNotify,
    SHCreateItemFromParsingName, SHGetFileInfoW, SHGetKnownFolderPath, ShellLink,
    FOLDERID_Desktop, FOLDERID_Documents, FOLDERID_Downloads, FOLDERID_Music, FOLDERID_Pictures,
    FOLDERID_Videos, KNOWN_FOLDER_FLAG, SHCNE_ASSOCCHANGED, SHCNE_UPDATEDIR, SHCNF_IDLIST,
    SHCNF_PATHW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON, SIIGBF, SIIGBF_BIGGERSIZEOK,
    SIIGBF_ICONONLY, SLGP_RAWPATH,
};
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, HICON};

const SHELL_ICONS_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Icons";
const BACKUP_FILE_NAME: &str = "windows-icons-backup.json";

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WindowsIconTintOptions {
    pub mode: String,
    pub color_hex: String,
    pub strength: f32,
    pub shape: String,
    pub apply_folders: bool,
    pub apply_desktop_shortcuts: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WindowsIconTintReport {
    pub folders_updated: usize,
    pub shortcuts_updated: usize,
    pub skipped: usize,
    pub errors: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WindowsIconBackupStatus {
    pub has_backup: bool,
    pub folders_count: usize,
    pub shortcuts_count: usize,
    pub applied_mode: Option<String>,
    pub applied_color: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type", content = "value")]
enum SavedRegStr {
    Str(String),
    ExpandStr(String),
    Missing,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct FolderBackup {
    path: String,
    orig_attrs: u32,
    had_desktop_ini: bool,
    orig_desktop_ini_b64: Option<String>,
    orig_desktop_ini_attrs: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct ShortcutBackup {
    lnk_path: String,
    orig_icon_location: String,
    orig_icon_index: i32,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
struct WindowsIconsBackup {
    applied_mode: Option<String>,
    applied_color: Option<String>,
    shell_icons: BTreeMap<String, SavedRegStr>,
    folders: BTreeMap<String, FolderBackup>,
    shortcuts: BTreeMap<String, ShortcutBackup>,
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn parse_hex_rgb(hex: &str) -> Result<[u8; 3], String> {
    let clean = hex.trim().trim_start_matches('#');
    let expanded = if clean.len() == 3 {
        clean
            .chars()
            .flat_map(|c| [c, c])
            .collect::<String>()
    } else {
        clean.to_string()
    };
    if expanded.len() != 6 || !expanded.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!("Invalid hex color: {hex}"));
    }
    let r = u8::from_str_radix(&expanded[0..2], 16).map_err(|e| e.to_string())?;
    let g = u8::from_str_radix(&expanded[2..4], 16).map_err(|e| e.to_string())?;
    let b = u8::from_str_radix(&expanded[4..6], 16).map_err(|e| e.to_string())?;
    Ok([r, g, b])
}

fn fnv1a_hash(bytes: &[u8]) -> u64 {
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

fn config_hash_tag(opts: &WindowsIconTintOptions) -> String {
    let sig = format!(
        "{}|{}|{:.3}|{}",
        opts.mode.trim().to_ascii_lowercase(),
        opts.color_hex.trim().to_ascii_lowercase(),
        opts.strength.clamp(0.0, 1.0),
        opts.shape.trim().to_ascii_lowercase()
    );
    format!("{:016x}", fnv1a_hash(sig.as_bytes()))
}

fn tinted_icons_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to resolve app config dir: {e}"))?;
    Ok(base.join("tinted-icons"))
}

fn backup_file_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join(BACKUP_FILE_NAME))
}

fn load_backup(path: &Path) -> WindowsIconsBackup {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_backup(path: &Path, backup: &WindowsIconsBackup) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Create config dir failed: {e}"))?;
    }
    let json = serde_json::to_string_pretty(backup).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| format!("Write backup failed: {e}"))
}

fn known_folder_path(rfid: *const GUID) -> Option<PathBuf> {
    unsafe {
        let pwstr = SHGetKnownFolderPath(rfid, KNOWN_FOLDER_FLAG(0), None).ok()?;
        let path_str = pwstr.to_string().ok();
        CoTaskMemFree(Some(pwstr.0 as *const _));
        let p = PathBuf::from(path_str?.trim());
        p.is_dir().then_some(p)
    }
}

fn scale_rgb(rgb: [u8; 3], factor: f32) -> [u8; 3] {
    [
        (rgb[0] as f32 * factor).round().clamp(0.0, 255.0) as u8,
        (rgb[1] as f32 * factor).round().clamp(0.0, 255.0) as u8,
        (rgb[2] as f32 * factor).round().clamp(0.0, 255.0) as u8,
    ]
}

fn lerp_rgb(a: [u8; 3], b: [u8; 3], t: f32) -> [u8; 3] {
    let t = t.clamp(0.0, 1.0);
    [
        (a[0] as f32 + (b[0] as f32 - a[0] as f32) * t)
            .round()
            .clamp(0.0, 255.0) as u8,
        (a[1] as f32 + (b[1] as f32 - a[1] as f32) * t)
            .round()
            .clamp(0.0, 255.0) as u8,
        (a[2] as f32 + (b[2] as f32 - a[2] as f32) * t)
            .round()
            .clamp(0.0, 255.0) as u8,
    ]
}

fn alpha_over(dst: &mut [u8; 4], src: [u8; 4]) {
    let sa = src[3] as f32 / 255.0;
    if sa <= 0.0 {
        return;
    }
    let da = dst[3] as f32 / 255.0;
    let out_a = sa + da * (1.0 - sa);
    if out_a <= 1e-6 {
        *dst = [0, 0, 0, 0];
        return;
    }
    for c in 0..3 {
        let num = src[c] as f32 * sa + dst[c] as f32 * da * (1.0 - sa);
        dst[c] = (num / out_a).round().clamp(0.0, 255.0) as u8;
    }
    dst[3] = (out_a * 255.0).round().clamp(0.0, 255.0) as u8;
}

fn rounded_rect_sdf(px: f32, py: f32, min_x: f32, min_y: f32, max_x: f32, max_y: f32, radius: f32) -> f32 {
    let cx = (min_x + max_x) * 0.5;
    let cy = (min_y + max_y) * 0.5;
    let hx = ((max_x - min_x) * 0.5 - radius).max(0.0);
    let hy = ((max_y - min_y) * 0.5 - radius).max(0.0);
    let qx = (px - cx).abs() - hx;
    let qy = (py - cy).abs() - hy;
    let out_d = (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt();
    let in_d = qx.max(qy).min(0.0);
    out_d + in_d - radius
}

fn squircle_sdf(px: f32, py: f32, cx: f32, cy: f32, half: f32) -> f32 {
    let nx = ((px - cx) / half).abs();
    let ny = ((py - cy) / half).abs();
    let p = nx.powf(4.2) + ny.powf(4.2);
    (p.powf(1.0 / 4.2) - 1.0) * half * 0.85
}

fn resolve_plate_shape<'a>(mode: &str, shape: &'a str) -> &'a str {
    let clean = shape.trim();
    if clean.eq_ignore_ascii_case("auto") {
        if mode.eq_ignore_ascii_case("dark-glass") {
            "squircle"
        } else {
            "none"
        }
    } else if matches!(clean, "squircle" | "circle" | "rounded" | "none") {
        clean
    } else {
        "none"
    }
}

fn paint_tile_plate(canvas: &mut image::RgbaImage, rgb: [u8; 3], mode: &str, shape: &str) {
    let effective = resolve_plate_shape(mode, shape);
    if effective == "none" {
        return;
    }
    let dark_glass = mode.eq_ignore_ascii_case("dark-glass");
    let base_fill = if dark_glass {
        lerp_rgb([16, 17, 24], rgb, 0.14)
    } else {
        lerp_rgb([28, 30, 40], rgb, 0.22)
    };
    let top_rim = lerp_rgb([255, 255, 255], rgb, 0.55);
    let bottom_rim = scale_rgb(rgb, 0.65);

    let size = 256.0f32;
    let cx = 128.0f32;
    let cy = 128.0f32;
    let half = 112.0f32;

    for y in 0..256u32 {
        for x in 0..256u32 {
            let fx = x as f32 + 0.5;
            let fy = y as f32 + 0.5;
            let dist = match effective {
                "circle" => ((fx - cx).powi(2) + (fy - cy).powi(2)).sqrt() - half,
                "rounded" => rounded_rect_sdf(fx, fy, 16.0, 16.0, size - 16.0, size - 16.0, 44.0),
                _ => squircle_sdf(fx, fy, cx, cy, half),
            };
            if dist > 1.2 {
                continue;
            }
            let cov = (0.75 - dist).clamp(0.0, 1.0);
            let t_y = ((fy - 16.0) / 224.0).clamp(0.0, 1.0);
            let grad_factor = 1.12 - t_y * 0.22;
            let mut col = scale_rgb(base_fill, grad_factor);

            // Subtle upper rim sheen for sculpted glass depth
            if dist > -3.2 && dist <= 0.6 {
                let rim_mix = ((1.0 - t_y) * 0.48 + 0.14).clamp(0.0, 0.6);
                let rim_col = lerp_rgb(bottom_rim, top_rim, 1.0 - t_y);
                col = lerp_rgb(col, rim_col, rim_mix);
            }
            let alpha = ((if dark_glass { 236.0 } else { 218.0 }) * cov).round().clamp(0.0, 255.0) as u8;
            canvas.put_pixel(x, y, image::Rgba([col[0], col[1], col[2], alpha]));
        }
    }
}

/// Applies the selected ColorOS 17 / macOS Sequoia icon color shader to an RGBA image.
pub fn apply_tint_rgba(
    src: &image::RgbaImage,
    mode: &str,
    rgb: [u8; 3],
    strength: f32,
    shape: &str,
) -> image::RgbaImage {
    let strength = strength.clamp(0.0, 1.0);
    let mut canvas = image::RgbaImage::new(256, 256);
    let effective_shape = resolve_plate_shape(mode, shape);
    let has_plate = effective_shape != "none";

    if has_plate {
        paint_tile_plate(&mut canvas, rgb, mode, effective_shape);
    }

    let glyph_size = if has_plate { 172u32 } else { 236u32 };
    let resized = image::imageops::resize(src, glyph_size, glyph_size, image::imageops::FilterType::Lanczos3);
    let offset = (256 - glyph_size) / 2;

    let dark_tint = scale_rgb(rgb, 0.34);
    let bright_tint = lerp_rgb(rgb, [255, 255, 255], 0.42);
    let neon_tint = lerp_rgb(rgb, [255, 255, 255], 0.26);
    let pastel_tint = lerp_rgb(rgb, [248, 246, 252], 0.38);

    for gy in 0..glyph_size {
        for gx in 0..glyph_size {
            let p = resized.get_pixel(gx, gy);
            if p[3] < 4 {
                continue;
            }
            let orig = [p[0], p[1], p[2]];
            let luma = (0.2126 * p[0] as f32 + 0.7152 * p[1] as f32 + 0.0722 * p[2] as f32) / 255.0;

            let shaded = match mode {
                "dark-glass" => {
                    // Lift dark glyphs onto dark glass plate so black monochrome icons glow clearly
                    let lifted_luma = (0.38 + luma * 0.62).powf(0.92);
                    let target = lerp_rgb(scale_rgb(neon_tint, 0.85), [255, 255, 255], (lifted_luma - 0.65).max(0.0) * 0.75);
                    let colored = lerp_rgb(scale_rgb(neon_tint, lifted_luma), target, 0.35);
                    lerp_rgb(orig, colored, strength.max(0.55))
                }
                "pastel" => {
                    let soft_orig = lerp_rgb(orig, [238, 238, 244], 0.28);
                    let target = lerp_rgb(pastel_tint, [255, 255, 255], (luma - 0.55).max(0.0) * 0.5);
                    lerp_rgb(soft_orig, target, strength * 0.62)
                }
                "duotone" => {
                    let ramp = if luma < 0.5 {
                        lerp_rgb(dark_tint, rgb, luma * 2.0)
                    } else {
                        lerp_rgb(rgb, bright_tint, (luma - 0.5) * 2.0)
                    };
                    lerp_rgb(orig, ramp, strength)
                }
                "tinted" => {
                    let target = if luma < 0.65 {
                        lerp_rgb(scale_rgb(rgb, 0.45), lerp_rgb(rgb, [255, 255, 255], 0.14), (luma / 0.65).powf(0.9))
                    } else {
                        lerp_rgb(lerp_rgb(rgb, [255, 255, 255], 0.14), [255, 255, 255], (luma - 0.65) / 0.35 * 0.65)
                    };
                    lerp_rgb(orig, target, strength)
                }
                _ => orig,
            };

            let dx = gx + offset;
            let dy = gy + offset;
            let mut dst = canvas.get_pixel(dx, dy).0;
            alpha_over(&mut dst, [shaded[0], shaded[1], shaded[2], p[3]]);
            canvas.put_pixel(dx, dy, image::Rgba(dst));
        }
    }

    canvas
}

fn draw_fluent_folder_rgba(rgb: [u8; 3], mode: &str, open: bool) -> image::RgbaImage {
    let base = match mode {
        "pastel" => lerp_rgb(rgb, [248, 244, 252], 0.36),
        "dark-glass" => lerp_rgb(rgb, [255, 255, 255], 0.22),
        _ => rgb,
    };
    let back_col = scale_rgb(base, 0.72);
    let front_top = lerp_rgb(base, [255, 255, 255], if mode == "duotone" { 0.30 } else { 0.16 });
    let front_bot = scale_rgb(base, if mode == "duotone" { 0.68 } else { 0.84 });
    let rim_col = lerp_rgb(base, [255, 255, 255], 0.55);

    let mut folder = image::RgbaImage::new(256, 256);

    // Back shell + upper tab
    for y in 0..256u32 {
        for x in 0..256u32 {
            let fx = x as f32 + 0.5;
            let fy = y as f32 + 0.5;
            let d_tab = rounded_rect_sdf(fx, fy, 20.0, 38.0, 114.0, 102.0, 14.0);
            let d_body = rounded_rect_sdf(fx, fy, 20.0, 56.0, 236.0, 214.0, 18.0);
            let d = d_tab.min(d_body);
            if d <= 1.0 {
                let cov = (0.75 - d).clamp(0.0, 1.0);
                let grad = 1.04 - ((fy - 38.0) / 180.0).clamp(0.0, 1.0) * 0.14;
                let c = scale_rgb(back_col, grad);
                folder.put_pixel(x, y, image::Rgba([c[0], c[1], c[2], (cov * 255.0) as u8]));
            }
        }
    }

    // Crisp paper sheet peeking above the front pocket
    let paper_top = if open { 60.0f32 } else { 72.0f32 };
    for y in 0..256u32 {
        for x in 0..256u32 {
            let fx = x as f32 + 0.5;
            let fy = y as f32 + 0.5;
            let d_paper = rounded_rect_sdf(fx, fy, 32.0, paper_top, 224.0, 145.0, 8.0);
            if d_paper <= 1.0 {
                let cov = (0.75 - d_paper).clamp(0.0, 1.0);
                let mut dst = folder.get_pixel(x, y).0;
                alpha_over(&mut dst, [246, 247, 252, (cov * 238.0) as u8]);
                folder.put_pixel(x, y, image::Rgba(dst));
            }
        }
    }

    // Front flap
    let flap_top = if open { 96.0f32 } else { 82.0f32 };
    let flap_left_inset = if open { 4.0f32 } else { 0.0f32 };
    for y in 0..256u32 {
        for x in 0..256u32 {
            let fx = x as f32 + 0.5;
            let fy = y as f32 + 0.5;
            let t_y = ((fy - flap_top) / (218.0 - flap_top)).clamp(0.0, 1.0);
            let tilt = if open { t_y * 6.0 } else { 0.0 };
            let d_front = rounded_rect_sdf(
                fx,
                fy,
                20.0 + flap_left_inset - tilt * 0.5,
                flap_top,
                236.0 - flap_left_inset + tilt * 0.5,
                216.0,
                18.0,
            );
            if d_front <= 1.0 {
                let cov = (0.75 - d_front).clamp(0.0, 1.0);
                let mut col = lerp_rgb(front_top, front_bot, t_y);
                if fy >= flap_top && fy <= flap_top + 2.5 && d_front < -0.2 {
                    col = lerp_rgb(col, rim_col, 0.52);
                }
                let mut dst = folder.get_pixel(x, y).0;
                alpha_over(&mut dst, [col[0], col[1], col[2], (cov * 255.0) as u8]);
                folder.put_pixel(x, y, image::Rgba(dst));
            }
        }
    }

    if mode.eq_ignore_ascii_case("dark-glass") {
        let mut plate = image::RgbaImage::new(256, 256);
        paint_tile_plate(&mut plate, rgb, mode, "squircle");
        let small = image::imageops::resize(&folder, 176, 176, image::imageops::FilterType::Lanczos3);
        for sy in 0..176u32 {
            for sx in 0..176u32 {
                let sp = small.get_pixel(sx, sy).0;
                if sp[3] > 0 {
                    let mut dst = plate.get_pixel(sx + 40, sy + 40).0;
                    alpha_over(&mut dst, sp);
                    plate.put_pixel(sx + 40, sy + 40, image::Rgba(dst));
                }
            }
        }
        return plate;
    }

    folder
}

/// Encodes a 256x256 RGBA image as a multi-size PNG-in-ICO byte buffer (`256, 64, 48, 32, 16`).
pub fn rgba_to_multi_size_ico_bytes(img: &image::RgbaImage) -> Result<Vec<u8>, String> {
    const SIZES: [u32; 5] = [256, 64, 48, 32, 16];
    let mut frames: Vec<(u32, Vec<u8>)> = Vec::with_capacity(SIZES.len());
    for &sz in &SIZES {
        let resized = if img.width() == sz && img.height() == sz {
            std::borrow::Cow::Borrowed(img)
        } else {
            std::borrow::Cow::Owned(image::imageops::resize(
                img,
                sz,
                sz,
                image::imageops::FilterType::Lanczos3,
            ))
        };
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(resized.into_owned())
            .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
            .map_err(|e| format!("PNG frame encode failed: {e}"))?;
        frames.push((sz, png));
    }

    let count = frames.len() as u16;
    let header_bytes = 6usize + frames.len() * 16usize;
    let total_png: usize = frames.iter().map(|(_, p)| p.len()).sum();
    let mut ico = Vec::with_capacity(header_bytes + total_png);

    // ICONDIR header
    ico.extend_from_slice(&[0, 0, 1, 0]);
    ico.extend_from_slice(&count.to_le_bytes());

    let mut offset = header_bytes as u32;
    for (sz, png) in &frames {
        let dim = if *sz >= 256 { 0u8 } else { *sz as u8 };
        ico.push(dim); // bWidth
        ico.push(dim); // bHeight
        ico.push(0); // bColorCount
        ico.push(0); // bReserved
        ico.extend_from_slice(&1u16.to_le_bytes()); // wPlanes
        ico.extend_from_slice(&32u16.to_le_bytes()); // wBitCount
        ico.extend_from_slice(&(png.len() as u32).to_le_bytes()); // dwBytesInRes
        ico.extend_from_slice(&offset.to_le_bytes()); // dwImageOffset
        offset += png.len() as u32;
    }

    for (_, png) in &frames {
        ico.extend_from_slice(png);
    }
    Ok(ico)
}

pub fn generate_fluent_folder_ico(rgb: [u8; 3], mode: &str, open: bool) -> Result<Vec<u8>, String> {
    let rgba = draw_fluent_folder_rgba(rgb, mode, open);
    rgba_to_multi_size_ico_bytes(&rgba)
}

/// Safely merges `[.ShellClassInfo]` `IconResource=<ico>,0` into an existing `desktop.ini`
/// while preserving localized folder names (`LocalizedResourceName`) and all other sections.
pub fn merge_desktop_ini_icon(existing: Option<&str>, ico_path: &str) -> String {
    let icon_line = format!("IconResource={ico_path},0");
    let Some(raw) = existing else {
        return format!("[.ShellClassInfo]\r\n{icon_line}\r\n");
    };

    let clean = raw.trim_start_matches('\u{feff}');
    let mut out_lines: Vec<String> = Vec::new();
    let mut in_shell_section = false;
    let mut saw_shell_section = false;
    let mut inserted_icon = false;

    for line in clean.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            if in_shell_section && !inserted_icon {
                out_lines.push(icon_line.clone());
                inserted_icon = true;
            }
            in_shell_section = trimmed.eq_ignore_ascii_case("[.ShellClassInfo]");
            if in_shell_section {
                saw_shell_section = true;
            }
            out_lines.push(line.to_string());
            continue;
        }
        if in_shell_section {
            let lower = trimmed.to_ascii_lowercase();
            if lower.starts_with("iconresource=")
                || lower.starts_with("iconfile=")
                || lower.starts_with("iconindex=")
            {
                if !inserted_icon {
                    out_lines.push(icon_line.clone());
                    inserted_icon = true;
                }
                continue;
            }
        }
        out_lines.push(line.to_string());
    }

    if in_shell_section && !inserted_icon {
        out_lines.push(icon_line.clone());
    }
    if !saw_shell_section {
        if out_lines.last().is_some_and(|last| !last.is_empty()) {
            out_lines.push(String::new());
        }
        out_lines.push("[.ShellClassInfo]".to_string());
        out_lines.push(icon_line);
    }

    let mut joined = out_lines.join("\r\n");
    if !joined.ends_with("\r\n") {
        joined.push_str("\r\n");
    }
    joined
}

fn decode_desktop_ini_bytes(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

fn encode_desktop_ini_utf16_bom(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(2 + text.len() * 2);
    out.push(0xFF);
    out.push(0xFE);
    for unit in text.encode_utf16() {
        out.extend_from_slice(&unit.to_le_bytes());
    }
    out
}

fn read_reg_string(key: &str, name: &str) -> SavedRegStr {
    unsafe {
        let key_w = wide(key);
        let name_w = wide(name);
        let mut hkey = HKEY::default();
        if RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(key_w.as_ptr()), Some(0), KEY_READ, &mut hkey).is_err() {
            return SavedRegStr::Missing;
        }
        let mut reg_type = REG_SZ;
        let mut size_bytes = 0u32;
        if RegQueryValueExW(
            hkey,
            PCWSTR(name_w.as_ptr()),
            None,
            Some(&mut reg_type),
            None,
            Some(&mut size_bytes),
        )
        .is_err()
            || size_bytes == 0
        {
            let _ = RegCloseKey(hkey);
            return SavedRegStr::Missing;
        }
        let mut buf = vec![0u8; size_bytes as usize];
        let ok = RegQueryValueExW(
            hkey,
            PCWSTR(name_w.as_ptr()),
            None,
            Some(&mut reg_type),
            Some(buf.as_mut_ptr()),
            Some(&mut size_bytes),
        )
        .is_ok();
        let _ = RegCloseKey(hkey);
        if !ok {
            return SavedRegStr::Missing;
        }
        let units: Vec<u16> = buf[..(size_bytes as usize).min(buf.len())]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        let text = String::from_utf16_lossy(&units)
            .trim_end_matches('\0')
            .to_string();
        if reg_type == REG_EXPAND_SZ {
            SavedRegStr::ExpandStr(text)
        } else {
            SavedRegStr::Str(text)
        }
    }
}

fn write_reg_string(key: &str, name: &str, value: &str, expand: bool) -> Result<(), String> {
    unsafe {
        let key_w = wide(key);
        let name_w = wide(name);
        let mut hkey = HKEY::default();
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(key_w.as_ptr()),
            Some(0),
            None,
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            None,
            &mut hkey,
            None,
        )
        .ok()
        .map_err(|e| format!("RegCreateKeyExW failed: {e}"))?;
        let val_w = wide(value);
        let bytes = std::slice::from_raw_parts(val_w.as_ptr() as *const u8, val_w.len() * 2);
        let reg_type = if expand { REG_EXPAND_SZ } else { REG_SZ };
        let res = RegSetValueExW(hkey, PCWSTR(name_w.as_ptr()), Some(0), reg_type, Some(bytes))
            .ok()
            .map_err(|e| format!("RegSetValueExW failed: {e}"));
        let _ = RegCloseKey(hkey);
        res
    }
}

fn delete_reg_value(key: &str, name: &str) {
    unsafe {
        let key_w = wide(key);
        let name_w = wide(name);
        let mut hkey = HKEY::default();
        if RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(key_w.as_ptr()), Some(0), KEY_SET_VALUE, &mut hkey).is_ok() {
            let _ = RegDeleteValueW(hkey, PCWSTR(name_w.as_ptr()));
            let _ = RegCloseKey(hkey);
        }
    }
}

fn get_attrs(path: &Path) -> Option<u32> {
    let w = wide(&path.to_string_lossy());
    let attrs = unsafe { GetFileAttributesW(PCWSTR(w.as_ptr())) };
    if attrs == INVALID_FILE_ATTRIBUTES {
        None
    } else {
        Some(attrs)
    }
}

fn set_attrs(path: &Path, attrs: u32) -> Result<(), String> {
    let w = wide(&path.to_string_lossy());
    unsafe {
        SetFileAttributesW(PCWSTR(w.as_ptr()), windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES(attrs))
            .map_err(|e| format!("SetFileAttributesW({}): {e}", path.display()))
    }
}

fn collect_target_folders() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut seen = HashSet::new();

    let mut push_dir = |p: PathBuf| {
        let key = p.to_string_lossy().to_ascii_lowercase();
        if seen.insert(key) {
            dirs.push(p);
        }
    };

    for rfid in [
        &FOLDERID_Downloads as *const GUID,
        &FOLDERID_Documents as *const GUID,
        &FOLDERID_Pictures as *const GUID,
        &FOLDERID_Music as *const GUID,
        &FOLDERID_Videos as *const GUID,
    ] {
        if let Some(p) = known_folder_path(rfid) {
            push_dir(p);
        }
    }

    if let Some(desktop) = known_folder_path(&FOLDERID_Desktop) {
        if let Ok(entries) = std::fs::read_dir(&desktop) {
            for entry in entries.flatten() {
                let p = entry.path();
                if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                    if name.starts_with('.') {
                        continue;
                    }
                }
                if let Some(attrs) = get_attrs(&p) {
                    let is_dir = p.is_dir();
                    let is_reparse = (attrs & FILE_ATTRIBUTE_REPARSE_POINT.0) != 0;
                    if is_dir && !is_reparse {
                        push_dir(p);
                    }
                }
            }
        }
    }

    dirs
}

fn read_shortcut_metadata(lnk_path: &Path) -> Result<(String, i32, String), String> {
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_ALL)
            .map_err(|e| format!("CoCreateInstance(ShellLink): {e}"))?;
        let pf: IPersistFile = link.cast().map_err(|e| e.to_string())?;
        let w_lnk = wide(&lnk_path.to_string_lossy());
        pf.Load(PCWSTR(w_lnk.as_ptr()), windows::Win32::System::Com::STGM(0))
            .map_err(|e| format!("IPersistFile::Load: {e}"))?;

        let mut icon_buf = [0u16; 520];
        let mut idx = 0i32;
        let _ = link.GetIconLocation(&mut icon_buf, &mut idx);
        let icon_loc = String::from_utf16_lossy(&icon_buf)
            .trim_end_matches('\0')
            .trim()
            .to_string();

        let mut target_buf = [0u16; 520];
        let _ = link.GetPath(&mut target_buf, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32);
        let target_path = String::from_utf16_lossy(&target_buf)
            .trim_end_matches('\0')
            .trim()
            .to_string();

        Ok((icon_loc, idx, target_path))
    }
}

fn write_shortcut_icon(lnk_path: &Path, icon_loc: &str, icon_index: i32) -> Result<(), String> {
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_ALL)
            .map_err(|e| format!("CoCreateInstance(ShellLink): {e}"))?;
        let pf: IPersistFile = link.cast().map_err(|e| e.to_string())?;
        let w_lnk = wide(&lnk_path.to_string_lossy());
        pf.Load(PCWSTR(w_lnk.as_ptr()), STGM_READWRITE)
            .map_err(|e| format!("IPersistFile::Load(RW): {e}"))?;

        let w_loc = wide(icon_loc);
        link.SetIconLocation(PCWSTR(w_loc.as_ptr()), icon_index)
            .map_err(|e| format!("SetIconLocation: {e}"))?;
        pf.Save(PCWSTR(w_lnk.as_ptr()), true)
            .map_err(|e| format!("IPersistFile::Save: {e}"))?;
        Ok(())
    }
}

fn expand_env_vars(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        if let Some(end) = after.find('%') {
            let name = &after[..end];
            if !name.is_empty() && !name.contains(' ') {
                if let Ok(v) = std::env::var(name) {
                    out.push_str(&v);
                } else {
                    out.push('%');
                    out.push_str(name);
                    out.push('%');
                }
            } else {
                out.push('%');
                out.push_str(name);
                out.push('%');
            }
            rest = &after[end + 1..];
        } else {
            out.push_str(&rest[start..]);
            return out;
        }
    }
    out.push_str(rest);
    out
}

unsafe fn extract_rgba_from_shell_item(path: &str) -> Option<image::RgbaImage> {
    let w = wide(path);
    let factory: IShellItemImageFactory = SHCreateItemFromParsingName(PCWSTR(w.as_ptr()), None).ok()?;
    let size = windows::Win32::Foundation::SIZE { cx: 256, cy: 256 };
    let hbitmap = factory
        .GetImage(size, SIIGBF(SIIGBF_ICONONLY.0 | SIIGBF_BIGGERSIZEOK.0))
        .or_else(|_| factory.GetImage(size, SIIGBF_BIGGERSIZEOK))
        .ok()?;
    if hbitmap.0.is_null() {
        return None;
    }
    let rgba = crate::utils::hbitmap_to_rgba(hbitmap);
    let _ = windows::Win32::Graphics::Gdi::DeleteObject(hbitmap.into());
    rgba
}

fn extract_shortcut_source_rgba(
    lnk_path: &Path,
    orig_icon_location: &str,
    orig_icon_index: i32,
    target_path: &str,
) -> Option<image::RgbaImage> {
    let expanded_loc = expand_env_vars(orig_icon_location.trim());
    if !expanded_loc.is_empty() {
        let p = Path::new(&expanded_loc);
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        if matches!(ext.as_str(), "png" | "ico" | "jpg" | "jpeg" | "bmp" | "webp") && p.is_file() {
            if let Ok(dyn_img) = image::open(p) {
                return Some(dyn_img.to_rgba8());
            }
        }
        if matches!(ext.as_str(), "exe" | "dll" | "cpl") && p.is_file() {
            let w_loc = wide(&expanded_loc);
            let mut large = HICON::default();
            let count = unsafe { ExtractIconExW(PCWSTR(w_loc.as_ptr()), orig_icon_index, Some(&mut large), None, 1) };
            if count > 0 && !large.is_invalid() {
                let rgba = unsafe { crate::utils::hicon_to_rgba(large) };
                let _ = unsafe { DestroyIcon(large) };
                if rgba.is_some() {
                    return rgba;
                }
            }
        }
    }

    let expanded_target = expand_env_vars(target_path.trim());
    if !expanded_target.is_empty() && Path::new(&expanded_target).exists() {
        if let Some(rgba) = unsafe { extract_rgba_from_shell_item(&expanded_target) } {
            return Some(rgba);
        }
    }

    let lnk_str = lnk_path.to_string_lossy();
    if let Some(rgba) = unsafe { extract_rgba_from_shell_item(&lnk_str) } {
        return Some(rgba);
    }

    unsafe {
        let w_lnk = wide(&lnk_str);
        let mut shfi = SHFILEINFOW::default();
        let res = SHGetFileInfoW(
            PCWSTR(w_lnk.as_ptr()),
            Default::default(),
            Some(&mut shfi),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        );
        if res != 0 && !shfi.hIcon.is_invalid() {
            let rgba = crate::utils::hicon_to_rgba(shfi.hIcon);
            let _ = DestroyIcon(shfi.hIcon);
            return rgba;
        }
    }
    None
}

fn notify_shell_refresh(folders: &[PathBuf]) {
    unsafe {
        SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
        if let Some(desktop) = known_folder_path(&FOLDERID_Desktop) {
            let w = wide(&desktop.to_string_lossy());
            SHChangeNotify(SHCNE_UPDATEDIR, SHCNF_PATHW, Some(w.as_ptr() as *const _), None);
        }
        for folder in folders {
            let w = wide(&folder.to_string_lossy());
            SHChangeNotify(SHCNE_UPDATEDIR, SHCNF_PATHW, Some(w.as_ptr() as *const _), None);
        }
    }
}

fn prune_stale_icons(
    dir: &Path,
    shortcuts_dir: &Path,
    prune_folders: bool,
    prune_shortcuts: bool,
    keep: &HashSet<PathBuf>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_file() {
            let in_shortcuts = p.starts_with(shortcuts_dir);
            let should_prune = if in_shortcuts { prune_shortcuts } else { prune_folders };
            if should_prune && !keep.contains(&p) {
                let _ = std::fs::remove_file(&p);
            }
        } else if p.is_dir() {
            prune_stale_icons(&p, shortcuts_dir, prune_folders, prune_shortcuts, keep);
        }
    }
}

pub fn apply_tint(app: &AppHandle, opts: WindowsIconTintOptions) -> Result<WindowsIconTintReport, String> {
    let mode = opts.mode.trim().to_ascii_lowercase();
    if mode == "original" || mode == "none" {
        restore(app)?;
        return Ok(WindowsIconTintReport {
            folders_updated: 0,
            shortcuts_updated: 0,
            skipped: 0,
            errors: Vec::new(),
        });
    }

    let _com = crate::utils::ComApartmentGuard::init_mta();
    let rgb = parse_hex_rgb(&opts.color_hex)?;
    let backup_path = backup_file_path(app).ok_or("No app config directory available")?;
    let mut backup = load_backup(&backup_path);
    let icons_dir = tinted_icons_dir(app)?;
    let shortcuts_dir = icons_dir.join("shortcuts");
    std::fs::create_dir_all(&shortcuts_dir).map_err(|e| format!("Failed to create icon dir: {e}"))?;

    let tag = config_hash_tag(&opts);
    let mut keep_files: HashSet<PathBuf> = HashSet::new();
    let mut report = WindowsIconTintReport {
        folders_updated: 0,
        shortcuts_updated: 0,
        skipped: 0,
        errors: Vec::new(),
    };
    let mut touched_folders: Vec<PathBuf> = Vec::new();

    if opts.apply_folders {
        let closed_ico = icons_dir.join(format!("folder_closed_{tag}.ico"));
        let open_ico = icons_dir.join(format!("folder_open_{tag}.ico"));
        let closed_bytes = generate_fluent_folder_ico(rgb, &mode, false)?;
        let open_bytes = generate_fluent_folder_ico(rgb, &mode, true)?;
        std::fs::write(&closed_ico, &closed_bytes)
            .map_err(|e| format!("Failed writing closed folder icon: {e}"))?;
        std::fs::write(&open_ico, &open_bytes)
            .map_err(|e| format!("Failed writing open folder icon: {e}"))?;
        keep_files.insert(closed_ico.clone());
        keep_files.insert(open_ico.clone());

        for (slot, ico_path) in [("3", &closed_ico), ("4", &open_ico)] {
            if !backup.shell_icons.contains_key(slot) {
                backup
                    .shell_icons
                    .insert(slot.to_string(), read_reg_string(SHELL_ICONS_KEY, slot));
            }
            if let Err(e) = write_reg_string(SHELL_ICONS_KEY, slot, &format!("{},0", ico_path.display()), false) {
                report.errors.push(format!("Shell Icons [{slot}]: {e}"));
            }
        }

        let closed_str = closed_ico.to_string_lossy().into_owned();
        for folder in collect_target_folders() {
            let folder_key = folder.to_string_lossy().to_ascii_lowercase();
            let Some(orig_folder_attrs) = get_attrs(&folder) else {
                report.skipped += 1;
                continue;
            };
            let ini_path = folder.join("desktop.ini");
            let existing_ini_bytes = std::fs::read(&ini_path).ok();
            let existing_ini_text = existing_ini_bytes.as_deref().map(decode_desktop_ini_bytes);

            if !backup.folders.contains_key(&folder_key) {
                use base64::Engine;
                backup.folders.insert(
                    folder_key.clone(),
                    FolderBackup {
                        path: folder.to_string_lossy().into_owned(),
                        orig_attrs: orig_folder_attrs,
                        had_desktop_ini: existing_ini_bytes.is_some(),
                        orig_desktop_ini_b64: existing_ini_bytes
                            .as_ref()
                            .map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
                        orig_desktop_ini_attrs: get_attrs(&ini_path),
                    },
                );
            }

            // Clear hidden/system/readonly temporarily if an existing desktop.ini is protected
            if let Some(cur_attrs) = get_attrs(&ini_path) {
                let clear_mask = !(FILE_ATTRIBUTE_HIDDEN.0 | FILE_ATTRIBUTE_SYSTEM.0 | FILE_ATTRIBUTE_READONLY.0);
                let _ = set_attrs(&ini_path, (cur_attrs & clear_mask).max(windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL.0));
            }

            let merged = merge_desktop_ini_icon(existing_ini_text.as_deref(), &closed_str);
            let ini_bytes = encode_desktop_ini_utf16_bom(&merged);
            match std::fs::write(&ini_path, ini_bytes) {
                Ok(_) => {
                    let _ = set_attrs(
                        &ini_path,
                        FILE_ATTRIBUTE_HIDDEN.0 | FILE_ATTRIBUTE_SYSTEM.0,
                    );
                    if let Err(e) = set_attrs(&folder, orig_folder_attrs | FILE_ATTRIBUTE_READONLY.0) {
                        report.errors.push(e);
                    } else {
                        report.folders_updated += 1;
                        touched_folders.push(folder);
                    }
                }
                Err(e) => {
                    report.errors.push(format!("{}: {e}", ini_path.display()));
                }
            }
        }
    }

    if opts.apply_desktop_shortcuts {
        if let Some(desktop) = known_folder_path(&FOLDERID_Desktop) {
            if let Ok(entries) = std::fs::read_dir(&desktop) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if !p.is_file() {
                        continue;
                    }
                    let is_lnk = p
                        .extension()
                        .and_then(|e| e.to_str())
                        .is_some_and(|e| e.eq_ignore_ascii_case("lnk"));
                    if !is_lnk {
                        continue;
                    }

                    let key = p.to_string_lossy().to_ascii_lowercase();
                    let Ok((cur_loc, cur_idx, target_path)) = read_shortcut_metadata(&p) else {
                        report.skipped += 1;
                        continue;
                    };

                    // Never overwrite original pre-tint backup if user applies multiple tint styles in sequence
                    let entry_backup = backup.shortcuts.entry(key.clone()).or_insert_with(|| ShortcutBackup {
                        lnk_path: p.to_string_lossy().into_owned(),
                        orig_icon_location: cur_loc.clone(),
                        orig_icon_index: cur_idx,
                    });

                    let orig_loc = entry_backup.orig_icon_location.clone();
                    let orig_idx = entry_backup.orig_icon_index;

                    let Some(src_rgba) = extract_shortcut_source_rgba(&p, &orig_loc, orig_idx, &target_path) else {
                        report.skipped += 1;
                        continue;
                    };

                    let tinted = apply_tint_rgba(&src_rgba, &mode, rgb, opts.strength, &opts.shape);
                    let Ok(ico_bytes) = rgba_to_multi_size_ico_bytes(&tinted) else {
                        report.skipped += 1;
                        continue;
                    };

                    let name_hash = fnv1a_hash(key.as_bytes());
                    let out_ico = shortcuts_dir.join(format!("{name_hash:016x}_{tag}.ico"));
                    match std::fs::write(&out_ico, &ico_bytes) {
                        Ok(_) => {
                            let out_str = out_ico.to_string_lossy().into_owned();
                            if let Err(e) = write_shortcut_icon(&p, &out_str, 0) {
                                report.errors.push(format!("{}: {e}", p.display()));
                            } else {
                                keep_files.insert(out_ico);
                                report.shortcuts_updated += 1;
                            }
                        }
                        Err(e) => {
                            report.errors.push(format!("{}: {e}", out_ico.display(), ));
                        }
                    }
                }
            }
        }
    }

    backup.applied_mode = Some(opts.mode);
    backup.applied_color = Some(opts.color_hex);
    save_backup(&backup_path, &backup)?;
    prune_stale_icons(
        &icons_dir,
        &shortcuts_dir,
        opts.apply_folders,
        opts.apply_desktop_shortcuts,
        &keep_files,
    );
    notify_shell_refresh(&touched_folders);

    Ok(report)
}

pub fn restore(app: &AppHandle) -> Result<WindowsIconTintReport, String> {
    let _com = crate::utils::ComApartmentGuard::init_mta();
    let Some(backup_path) = backup_file_path(app) else {
        return Ok(WindowsIconTintReport {
            folders_updated: 0,
            shortcuts_updated: 0,
            skipped: 0,
            errors: Vec::new(),
        });
    };

    let mut report = WindowsIconTintReport {
        folders_updated: 0,
        shortcuts_updated: 0,
        skipped: 0,
        errors: Vec::new(),
    };
    let mut touched_folders: Vec<PathBuf> = Vec::new();

    if backup_path.is_file() {
        let backup = load_backup(&backup_path);

        for (slot, saved) in &backup.shell_icons {
            match saved {
                SavedRegStr::Missing => delete_reg_value(SHELL_ICONS_KEY, slot),
                SavedRegStr::Str(v) => {
                    if let Err(e) = write_reg_string(SHELL_ICONS_KEY, slot, v, false) {
                        report.errors.push(e);
                    }
                }
                SavedRegStr::ExpandStr(v) => {
                    if let Err(e) = write_reg_string(SHELL_ICONS_KEY, slot, v, true) {
                        report.errors.push(e);
                    }
                }
            }
        }

        for fb in backup.folders.values() {
            let folder = PathBuf::from(&fb.path);
            let ini_path = folder.join("desktop.ini");
            if let Some(cur_attrs) = get_attrs(&ini_path) {
                let clear_mask = !(FILE_ATTRIBUTE_HIDDEN.0 | FILE_ATTRIBUTE_SYSTEM.0 | FILE_ATTRIBUTE_READONLY.0);
                let _ = set_attrs(&ini_path, (cur_attrs & clear_mask).max(windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL.0));
            }
            if fb.had_desktop_ini {
                if let Some(ref b64) = fb.orig_desktop_ini_b64 {
                    use base64::Engine;
                    if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64) {
                        let _ = std::fs::write(&ini_path, bytes);
                    }
                }
                if let Some(orig_ini_attrs) = fb.orig_desktop_ini_attrs {
                    let _ = set_attrs(&ini_path, orig_ini_attrs);
                }
            } else if ini_path.exists() {
                let _ = std::fs::remove_file(&ini_path);
            }
            if folder.is_dir() {
                let _ = set_attrs(&folder, fb.orig_attrs);
                report.folders_updated += 1;
                touched_folders.push(folder);
            }
        }

        for sb in backup.shortcuts.values() {
            let lnk = PathBuf::from(&sb.lnk_path);
            if !lnk.is_file() {
                report.skipped += 1;
                continue;
            }
            match write_shortcut_icon(&lnk, &sb.orig_icon_location, sb.orig_icon_index) {
                Ok(_) => report.shortcuts_updated += 1,
                Err(e) => report.errors.push(format!("{}: {e}", lnk.display())),
            }
        }

        if report.errors.is_empty() {
            let _ = std::fs::remove_file(&backup_path);
        }
    }

    if report.errors.is_empty() {
        if let Ok(dir) = tinted_icons_dir(app) {
            if dir.exists() {
                let _ = std::fs::remove_dir_all(&dir);
            }
        }
    }

    notify_shell_refresh(&touched_folders);
    Ok(report)
}

pub fn backup_status(app: &AppHandle) -> WindowsIconBackupStatus {
    let Some(path) = backup_file_path(app) else {
        return WindowsIconBackupStatus {
            has_backup: false,
            folders_count: 0,
            shortcuts_count: 0,
            applied_mode: None,
            applied_color: None,
        };
    };
    if !path.is_file() {
        return WindowsIconBackupStatus {
            has_backup: false,
            folders_count: 0,
            shortcuts_count: 0,
            applied_mode: None,
            applied_color: None,
        };
    }
    let backup = load_backup(&path);
    WindowsIconBackupStatus {
        has_backup: !backup.shell_icons.is_empty()
            || !backup.folders.is_empty()
            || !backup.shortcuts.is_empty(),
        folders_count: backup.folders.len(),
        shortcuts_count: backup.shortcuts.len(),
        applied_mode: backup.applied_mode,
        applied_color: backup.applied_color,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_tint_rgba, generate_fluent_folder_ico, merge_desktop_ini_icon, parse_hex_rgb,
    };

    #[test]
    fn parses_3_and_6_digit_hex_colors() {
        assert_eq!(parse_hex_rgb("#ff6b95").unwrap(), [255, 107, 149]);
        assert_eq!(parse_hex_rgb("#f69").unwrap(), [255, 102, 153]);
        assert!(parse_hex_rgb("not-hex").is_err());
    }

    #[test]
    fn generates_valid_multi_size_ico_for_closed_and_open_folders() {
        for open in [false, true] {
            let bytes = generate_fluent_folder_ico([255, 107, 149], "dark-glass", open)
                .expect("folder ico should encode");
            assert!(bytes.len() > 512);
            // ICONDIR: reserved=0, type=1, count=5
            assert_eq!(&bytes[0..6], &[0, 0, 1, 0, 5, 0]);
        }
    }

    #[test]
    fn apply_tint_rgba_handles_all_modes_and_shapes() {
        let mut src = image::RgbaImage::new(64, 64);
        for y in 16..48 {
            for x in 16..48 {
                src.put_pixel(x, y, image::Rgba([220, 60, 40, 255]));
            }
        }
        for mode in ["dark-glass", "tinted", "pastel", "duotone"] {
            for shape in ["auto", "squircle", "circle", "rounded", "none"] {
                let out = apply_tint_rgba(&src, mode, [255, 107, 149], 0.85, shape);
                assert_eq!(out.dimensions(), (256, 256));
                assert!(out.get_pixel(128, 128)[3] > 200);
            }
        }
    }

    #[test]
    fn merge_desktop_ini_preserves_localized_name_and_other_sections() {
        let existing = "[.ShellClassInfo]\r\nLocalizedResourceName=@%SystemRoot%\\system32\\shell32.dll,-21798\r\nIconResource=C:\\old\\icon.ico,0\r\nIconFile=legacy.ico\r\nIconIndex=0\r\n[ViewState]\r\nMode=\r\n";
        let merged = merge_desktop_ini_icon(Some(existing), r"C:\Nectar\folder.ico");
        assert!(merged.contains("LocalizedResourceName=@%SystemRoot%\\system32\\shell32.dll,-21798"));
        assert!(merged.contains(r"IconResource=C:\Nectar\folder.ico,0"));
        assert!(!merged.contains("IconFile=legacy.ico"));
        assert!(merged.contains("[ViewState]"));

        let created = merge_desktop_ini_icon(None, r"C:\Nectar\folder.ico");
        assert!(created.contains("[.ShellClassInfo]"));
        assert!(created.contains(r"IconResource=C:\Nectar\folder.ico,0"));

        let remerged = merge_desktop_ini_icon(Some(&merged), r"C:\Nectar\folder2.ico");
        assert!(remerged.contains("LocalizedResourceName=@%SystemRoot%\\system32\\shell32.dll,-21798"));
        assert!(remerged.contains(r"IconResource=C:\Nectar\folder2.ico,0"));
        assert!(!remerged.contains(r"C:\Nectar\folder.ico"));
    }

    #[test]
    fn backup_entry_preserves_first_original_value_on_repeated_tint() {
        use super::{ShortcutBackup, WindowsIconsBackup};
        let mut backup = WindowsIconsBackup::default();
        let key = r"c:\users\demo\desktop\app.lnk".to_string();
        backup.shortcuts.entry(key.clone()).or_insert_with(|| ShortcutBackup {
            lnk_path: key.clone(),
            orig_icon_location: r"C:\Apps\demo.exe".to_string(),
            orig_icon_index: 0,
        });
        // Second re-tint sees a tinted path in the live .lnk but must NEVER overwrite backup entry
        backup.shortcuts.entry(key.clone()).or_insert_with(|| ShortcutBackup {
            lnk_path: key.clone(),
            orig_icon_location: r"C:\AppData\tinted-icons\shortcuts\abc.ico".to_string(),
            orig_icon_index: 0,
        });
        assert_eq!(backup.shortcuts[&key].orig_icon_location, r"C:\Apps\demo.exe");
    }
}
