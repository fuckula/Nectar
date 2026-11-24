
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;
use tauri::Window;

// The copy is blurred and only ever seen behind the notch and dock, so it can be small.
const BACKDROP_SIZE: u32 = 640;
const CACHE_LIMIT: usize = 8;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperBackdrop {
    /// Downscaled, blurred JPEG as a data URL
    image: String,
    /// Original image size, to work out how Windows fits it to the screen
    image_width: u32,
    image_height: u32,
    /// "fill", "fit", "stretch", "center", "tile" or "span"
    fit: String,
    /// The monitor, and this window's offset from its top-left corner, in logical pixels
    monitor_width: f64,
    monitor_height: f64,
    monitor_scale: f64,
    window_x: f64,
    window_y: f64,
    window_width: f64,
    window_height: f64,
}

struct CachedImage {
    path: PathBuf,
    modified: Option<SystemTime>,
    blur: u32,
    image: String,
    width: u32,
    height: u32,
}

static CACHE: Mutex<Vec<CachedImage>> = Mutex::new(Vec::new());

/// What Windows draws on one monitor.
struct Wallpaper {
    path: Option<PathBuf>,
    fit: String,
    color: [u8; 3],
}

fn colorref_rgb(c: u32) -> [u8; 3] {
    [(c & 0xff) as u8, ((c >> 8) & 0xff) as u8, ((c >> 16) & 0xff) as u8]
}

fn non_empty(path: String) -> Option<PathBuf> {
    let path = path.trim();
    (!path.is_empty()).then(|| PathBuf::from(path))
}

// Windows can show a different picture on each monitor, so ask for the one at (left, top).
fn monitor_wallpaper(left: i32, top: i32) -> Option<Wallpaper> {
    use windows::core::PCWSTR;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
    };
    use windows::Win32::UI::Shell::{
        DesktopWallpaper, IDesktopWallpaper, DWPOS_CENTER, DWPOS_FIT, DWPOS_SPAN, DWPOS_STRETCH, DWPOS_TILE,
    };
    unsafe {
        let com = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
        let found = (|| {
            let desktop: IDesktopWallpaper = CoCreateInstance(&DesktopWallpaper, None, CLSCTX_ALL).ok()?;
            let mut path = None;
            for i in 0..desktop.GetMonitorDevicePathCount().ok()? {
                let Ok(id) = desktop.GetMonitorDevicePathAt(i) else { continue };
                let here = desktop.GetMonitorRECT(PCWSTR(id.0)).is_ok_and(|r| r.left == left && r.top == top);
                if here {
                    if let Ok(p) = desktop.GetWallpaper(PCWSTR(id.0)) {
                        path = Some(p.to_string().ok().and_then(non_empty));
                        CoTaskMemFree(Some(p.0 as *const _));
                    }
                }
                CoTaskMemFree(Some(id.0 as *const _));
                if path.is_some() {
                    break;
                }
            }
            let fit = match desktop.GetPosition().ok()? {
                DWPOS_CENTER => "center",
                DWPOS_TILE => "tile",
                DWPOS_STRETCH => "stretch",
                DWPOS_FIT => "fit",
                DWPOS_SPAN => "span",
                _ => "fill",
            };
            Some(Wallpaper {
                path: path?,
                fit: fit.to_string(),
                color: colorref_rgb(desktop.GetBackgroundColor().ok()?.0),
            })
        })();
        if com {
            CoUninitialize();
        }
        found
    }
}

// The wallpaper Windows reports for the whole desktop, for when the per-monitor lookup fails.
fn desktop_wallpaper() -> Wallpaper {
    use windows::Win32::Graphics::Gdi::{GetSysColor, COLOR_BACKGROUND};
    use windows::Win32::UI::WindowsAndMessaging::{
        SystemParametersInfoW, SPI_GETDESKWALLPAPER, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
    };
    let mut buf = [0u16; 1024];
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETDESKWALLPAPER,
            buf.len() as u32,
            Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
        .is_ok()
    };
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    Wallpaper {
        path: if ok { non_empty(String::from_utf16_lossy(&buf[..len])) } else { None },
        fit: wallpaper_fit(),
        color: colorref_rgb(unsafe { GetSysColor(COLOR_BACKGROUND) }),
    }
}

// Settings › Personalization › Background: 0 picture, 1 solid color, 2 slideshow, 3 Spotlight.
fn background_type() -> Option<u32> {
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    let mut value = 0u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            windows::core::w!("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Wallpapers"),
            windows::core::w!("BackgroundType"),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut value as *mut u32 as *mut core::ffi::c_void),
            Some(&mut size),
        )
        .is_ok()
        .then_some(value)
    }
}

fn transcoded_wallpaper() -> Option<PathBuf> {
    let path = PathBuf::from(std::env::var_os("APPDATA")?).join("Microsoft\\Windows\\Themes\\TranscodedWallpaper");
    path.is_file().then_some(path)
}

// Files to try, in order. None of them means the desktop is a solid color.
fn candidates(wallpaper: &Wallpaper) -> Vec<PathBuf> {
    let kind = background_type();
    if kind == Some(1) {
        return Vec::new();
    }
    let mut files: Vec<PathBuf> = wallpaper.path.iter().cloned().collect();
    // With no file and no background type, it's the classic solid color.
    if !files.is_empty() || kind.is_some() {
        if let Some(copy) = transcoded_wallpaper() {
            if !files.contains(&copy) {
                files.push(copy);
            }
        }
    }
    files
}

fn read_desktop_string(name: windows::core::PCWSTR) -> Option<String> {
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ, REG_VALUE_TYPE,
    };
    unsafe {
        let mut hkey = HKEY::default();
        if RegOpenKeyExW(HKEY_CURRENT_USER, windows::core::w!("Control Panel\\Desktop"), Some(0), KEY_READ, &mut hkey).is_err() {
            return None;
        }
        let mut buf = [0u16; 64];
        let mut size = std::mem::size_of_val(&buf) as u32;
        let mut kind = REG_VALUE_TYPE::default();
        let result = RegQueryValueExW(hkey, name, None, Some(&mut kind), Some(buf.as_mut_ptr() as *mut u8), Some(&mut size));
        let _ = RegCloseKey(hkey);
        if result.is_err() {
            return None;
        }
        let len = (size as usize / 2).min(buf.len());
        Some(String::from_utf16_lossy(&buf[..len]).trim_end_matches('\0').trim().to_string())
    }
}

// How Windows draws the wallpaper (Settings › Personalization › Background › "Choose a fit")
fn wallpaper_fit() -> String {
    let style = read_desktop_string(windows::core::w!("WallpaperStyle")).unwrap_or_default();
    let tile = read_desktop_string(windows::core::w!("TileWallpaper")).unwrap_or_default();
    match (style.as_str(), tile.as_str()) {
        ("0", "1") => "tile",
        ("0", _) => "center",
        ("2", _) => "stretch",
        ("6", _) => "fit",
        ("22", _) => "span",
        _ => "fill",
    }
    .to_string()
}

// By content rather than extension: TranscodedWallpaper has none, and image::open gives up on it.
fn decode(path: &Path) -> Option<image::DynamicImage> {
    image::ImageReader::open(path).ok()?.with_guessed_format().ok()?.decode().ok()
}

fn load_blurred(path: &Path, blur: u32) -> Option<(String, u32, u32)> {
    let modified = std::fs::metadata(path).and_then(|m| m.modified()).ok();
    if let Ok(cache) = CACHE.lock() {
        if let Some(hit) = cache.iter().find(|c| c.path == path && c.modified == modified && c.blur == blur) {
            return Some((hit.image.clone(), hit.width, hit.height));
        }
    }

    let img = decode(path)?;
    let (width, height) = (img.width(), img.height());
    let small = img.thumbnail(BACKDROP_SIZE, BACKDROP_SIZE);
    let small = if blur > 0 { small.blur(blur as f32) } else { small };

    let mut out = Vec::new();
    image::DynamicImage::ImageRgb8(small.to_rgb8())
        .write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85))
        .ok()?;
    let data = data_url("image/jpeg", &out);

    if let Ok(mut cache) = CACHE.lock() {
        cache.retain(|c| !(c.path == path && c.blur == blur));
        if cache.len() >= CACHE_LIMIT {
            cache.remove(0);
        }
        cache.push(CachedImage { path: path.to_path_buf(), modified, blur, image: data.clone(), width, height });
    }
    Some((data, width, height))
}

fn data_url(mime: &str, bytes: &[u8]) -> String {
    use base64::Engine;
    format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

// A few pixels of the desktop color, stretched over the monitor.
fn solid_color(color: [u8; 3]) -> Option<String> {
    let mut out = Vec::new();
    image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(4, 4, image::Rgb(color)))
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .ok()?;
    Some(data_url("image/png", &out))
}

fn load_backdrop(left: i32, top: i32, blur: u32) -> Option<(String, u32, u32, String)> {
    let wallpaper = monitor_wallpaper(left, top).unwrap_or_else(desktop_wallpaper);
    for path in candidates(&wallpaper) {
        if let Some((image, width, height)) = load_blurred(&path, blur) {
            return Some((image, width, height, wallpaper.fit));
        }
    }
    Some((solid_color(wallpaper.color)?, 4, 4, "stretch".to_string()))
}

/// The wallpaper behind the calling window, blurred by `blur` pixels of the small copy.
/// A solid color desktop comes back as a small image of that color.
#[tauri::command]
pub async fn get_wallpaper_backdrop(window: Window, blur: u32) -> Result<Option<WallpaperBackdrop>, String> {
    let Some(monitor) = window.current_monitor().map_err(|e| e.to_string())? else { return Ok(None) };
    let scale = monitor.scale_factor();
    let m_pos = *monitor.position();
    let m_size = *monitor.size();
    let w_pos = window.outer_position().map_err(|e| e.to_string())?;
    let w_size = window.outer_size().map_err(|e| e.to_string())?;

    let blur = blur.min(40);
    let loaded = tauri::async_runtime::spawn_blocking(move || load_backdrop(m_pos.x, m_pos.y, blur))
        .await
        .map_err(|e| e.to_string())?;
    let Some((image, image_width, image_height, fit)) = loaded else { return Ok(None) };

    Ok(Some(WallpaperBackdrop {
        image,
        image_width,
        image_height,
        fit,
        monitor_width: m_size.width as f64 / scale,
        monitor_height: m_size.height as f64 / scale,
        monitor_scale: scale,
        window_x: (w_pos.x - m_pos.x) as f64 / scale,
        window_y: (w_pos.y - m_pos.y) as f64 / scale,
        window_width: w_size.width as f64 / scale,
        window_height: w_size.height as f64 / scale,
    }))
}

#[derive(Deserialize)]
pub struct SurfaceRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// Whether an app window is behind `rect` (CSS pixels of the calling window). Only then is the
/// wallpaper not what's actually behind the glass.
#[tauri::command]
pub async fn is_backdrop_covered(window: Window, rect: SurfaceRect) -> bool {
    use windows::Win32::Foundation::RECT;
    let (Ok(hwnd), Ok(origin)) = (window.hwnd(), window.inner_position()) else { return false };
    let scale = window.scale_factor().unwrap_or(1.0);
    let px = |v: f64| (v * scale).round() as i32;
    // A couple of pixels in, so a window that only touches the edge doesn't count.
    let area = RECT {
        left: origin.x + px(rect.x) + 2,
        top: origin.y + px(rect.y) + 2,
        right: origin.x + px(rect.x + rect.width) - 2,
        bottom: origin.y + px(rect.y + rect.height) - 2,
    };
    let allow_area = area.right > area.left && area.bottom > area.top;
    if !allow_area {
        return false;
    }
    let hwnd_raw = hwnd.0 as isize;
    tauri::async_runtime::spawn_blocking(move || window_behind(hwnd_raw, area))
        .await
        .unwrap_or(false)
}

// Walks down the z-order from `hwnd` until it reaches the desktop.
fn window_behind(hwnd: isize, area: windows::Win32::Foundation::RECT) -> bool {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetLayeredWindowAttributes, GetWindow, GetWindowLongW, GetWindowRect, GetWindowThreadProcessId,
        IsIconic, IsWindowVisible, GWL_EXSTYLE, GW_HWNDNEXT, LAYERED_WINDOW_ATTRIBUTES_FLAGS, LWA_ALPHA, WS_EX_LAYERED,
        WS_EX_TRANSPARENT,
    };
    let own = std::process::id();
    let mut next = unsafe { GetWindow(HWND(hwnd as *mut _), GW_HWNDNEXT) }.unwrap_or_default();
    for _ in 0..1000 {
        if next.is_invalid() {
            break;
        }
        let h = next;
        next = unsafe { GetWindow(h, GW_HWNDNEXT) }.unwrap_or_default();
        unsafe {
            if !IsWindowVisible(h).as_bool() || IsIconic(h).as_bool() {
                continue;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(h, Some(&mut pid));
            if pid == own {
                continue;
            }
            let mut class = [0u16; 64];
            let len = GetClassNameW(h, &mut class).max(0) as usize;
            match String::from_utf16_lossy(&class[..len]).as_str() {
                "Progman" | "WorkerW" => return false,
                "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" => continue,
                _ => {}
            }
            // Click-through overlays (game and recording overlays and the like) aren't seen.
            let ex = GetWindowLongW(h, GWL_EXSTYLE) as u32;
            if ex & WS_EX_TRANSPARENT.0 != 0 {
                continue;
            }
            if ex & WS_EX_LAYERED.0 != 0 {
                let mut alpha = 255u8;
                let mut flags = LAYERED_WINDOW_ATTRIBUTES_FLAGS(0);
                if GetLayeredWindowAttributes(h, None, Some(&mut alpha), Some(&mut flags)).is_ok()
                    && flags.contains(LWA_ALPHA)
                    && alpha == 0
                {
                    continue;
                }
            }
            let mut cloaked = 0u32;
            if DwmGetWindowAttribute(h, DWMWA_CLOAKED, &mut cloaked as *mut _ as *mut _, 4).is_ok() && cloaked != 0 {
                continue;
            }
            let mut r = RECT::default();
            let has_rect = DwmGetWindowAttribute(
                h,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                &mut r as *mut _ as *mut _,
                std::mem::size_of::<RECT>() as u32,
            )
            .is_ok()
                || GetWindowRect(h, &mut r).is_ok();
            if has_rect && r.left < area.right && r.right > area.left && r.top < area.bottom && r.bottom > area.top {
                return true;
            }
        }
    }
    false
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperPalette {
    pub dominant: String,
    pub accent: String,
    pub surface_dark: String,
    pub surface_light: String,
    pub secondary: String,
    pub swatches: Vec<String>,
    pub is_dark: bool,
    pub source: String,
}

fn rgb_to_hsl(rgb: [u8; 3]) -> (f32, f32, f32) {
    let r = rgb[0] as f32 / 255.0;
    let g = rgb[1] as f32 / 255.0;
    let b = rgb[2] as f32 / 255.0;
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) * 0.5;
    if (max - min).abs() < 1e-6 {
        return (0.0, 0.0, l * 100.0);
    }
    let d = max - min;
    let s = if l > 0.5 { d / (2.0 - max - min) } else { d / (max + min) };
    let mut h = if (max - r).abs() < 1e-6 {
        (g - b) / d + if g < b { 6.0 } else { 0.0 }
    } else if (max - g).abs() < 1e-6 {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    };
    h /= 6.0;
    (h * 360.0, s * 100.0, l * 100.0)
}

fn hsl_to_rgb(h: f32, s: f32, l: f32) -> [u8; 3] {
    let h = ((h % 360.0) + 360.0) % 360.0;
    let s = s.clamp(0.0, 100.0) / 100.0;
    let l = l.clamp(0.0, 100.0) / 100.0;
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let x = c * (1.0 - ((h / 60.0) % 2.0 - 1.0).abs());
    let m = l - c * 0.5;
    let (r, g, b) = if h < 60.0 {
        (c, x, 0.0)
    } else if h < 120.0 {
        (x, c, 0.0)
    } else if h < 180.0 {
        (0.0, c, x)
    } else if h < 240.0 {
        (0.0, x, c)
    } else if h < 300.0 {
        (x, 0.0, c)
    } else {
        (c, 0.0, x)
    };
    [
        ((r + m) * 255.0).round().clamp(0.0, 255.0) as u8,
        ((g + m) * 255.0).round().clamp(0.0, 255.0) as u8,
        ((b + m) * 255.0).round().clamp(0.0, 255.0) as u8,
    ]
}

fn rgb_hex(rgb: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2])
}

fn rgb_dist_sq(a: [u8; 3], b: [u8; 3]) -> i32 {
    let dr = a[0] as i32 - b[0] as i32;
    let dg = a[1] as i32 - b[1] as i32;
    let db = a[2] as i32 - b[2] as i32;
    dr * dr + dg * dg + db * db
}

pub fn palette_from_solid_rgb(rgb: [u8; 3], source: &str) -> WallpaperPalette {
    let (h, s, l) = rgb_to_hsl(rgb);
    let accent_rgb = if s < 10.0 {
        [10, 132, 255]
    } else {
        hsl_to_rgb(h, s.clamp(55.0, 88.0), l.clamp(52.0, 64.0))
    };
    let surface_dark = rgb_hex(hsl_to_rgb(h, s.min(40.0), 10.0));
    let surface_light = rgb_hex(hsl_to_rgb(h, s.min(24.0), 94.0));
    let sec_rgb = hsl_to_rgb((h + 34.0) % 360.0, s.clamp(45.0, 80.0), l.clamp(48.0, 66.0));
    let dom = rgb_hex(rgb);
    let acc = rgb_hex(accent_rgb);
    let sec = rgb_hex(sec_rgb);
    let mut swatches = vec![acc.clone(), sec.clone(), dom.clone()];
    swatches.push(surface_dark.clone());
    swatches.push(surface_light.clone());
    WallpaperPalette {
        dominant: dom,
        accent: acc,
        surface_dark,
        surface_light,
        secondary: sec,
        swatches,
        is_dark: l < 46.0,
        source: source.to_string(),
    }
}

pub fn extract_palette_from_rgba(rgba: &[u8], width: u32, height: u32, source: &str) -> WallpaperPalette {
    if width == 0 || height == 0 || rgba.len() < (width as usize * height as usize * 4) {
        return palette_from_solid_rgb([10, 132, 255], source);
    }

    #[derive(Default, Clone, Copy)]
    struct Bucket {
        r_sum: u64,
        g_sum: u64,
        b_sum: u64,
        count: u64,
    }

    let mut buckets = vec![Bucket::default(); 4096];
    let step_x = (width / 64).max(1) as usize;
    let step_y = (height / 64).max(1) as usize;
    let mut luma_sum = 0.0f64;
    let mut sample_count = 0u64;

    for y in (0..height as usize).step_by(step_y) {
        let row_off = y * width as usize * 4;
        for x in (0..width as usize).step_by(step_x) {
            let idx = row_off + x * 4;
            let a = rgba[idx + 3];
            if a < 32 {
                continue;
            }
            let r = rgba[idx];
            let g = rgba[idx + 1];
            let b = rgba[idx + 2];
            let luma = (0.2126 * r as f64 + 0.7152 * g as f64 + 0.0722 * b as f64) / 255.0;
            luma_sum += luma;
            sample_count += 1;

            let key = (((r as usize) >> 4) << 8) | (((g as usize) >> 4) << 4) | ((b as usize) >> 4);
            buckets[key].r_sum += r as u64;
            buckets[key].g_sum += g as u64;
            buckets[key].b_sum += b as u64;
            buckets[key].count += 1;
        }
    }

    if sample_count == 0 {
        return palette_from_solid_rgb([10, 132, 255], source);
    }

    let is_dark = (luma_sum / sample_count as f64) < 0.46;

    struct Centroid {
        rgb: [u8; 3],
        sat: f32,
        luma: f32,
        vivid_score: f64,
        dom_score: f64,
    }

    let mut centroids: Vec<Centroid> = buckets
        .into_iter()
        .filter(|b| b.count > 0)
        .map(|b| {
            let rgb = [
                (b.r_sum / b.count) as u8,
                (b.g_sum / b.count) as u8,
                (b.b_sum / b.count) as u8,
            ];
            let (_h, s, l) = rgb_to_hsl(rgb);
            let sat_norm = (s / 100.0) as f64;
            let mid_bonus = 1.0 - ((l - 52.0).abs() / 55.0).clamp(0.0, 0.85) as f64;
            let vivid_score = (b.count as f64).powf(0.55) * (0.15 + sat_norm * 3.0) * mid_bonus;
            let dom_score = (b.count as f64) * (0.65 + sat_norm * 0.9);
            Centroid {
                rgb,
                sat: s,
                luma: l,
                vivid_score,
                dom_score,
            }
        })
        .collect();

    if centroids.is_empty() {
        return palette_from_solid_rgb([10, 132, 255], source);
    }

    centroids.sort_by(|a, b| b.dom_score.partial_cmp(&a.dom_score).unwrap_or(std::cmp::Ordering::Equal));
    let dominant_raw = centroids[0].rgb;
    let (dom_h, dom_s, _dom_l) = rgb_to_hsl(dominant_raw);

    let mut by_vivid: Vec<&Centroid> = centroids.iter().collect();
    by_vivid.sort_by(|a, b| b.vivid_score.partial_cmp(&a.vivid_score).unwrap_or(std::cmp::Ordering::Equal));

    let best_vivid = by_vivid
        .iter()
        .find(|c| c.sat >= 16.0 && c.luma >= 14.0 && c.luma <= 86.0)
        .copied()
        .unwrap_or(by_vivid[0]);

    let (acc_h, acc_s, acc_l) = rgb_to_hsl(best_vivid.rgb);
    let accent_rgb = if best_vivid.sat < 10.0 {
        [138, 180, 248]
    } else {
        hsl_to_rgb(acc_h, acc_s.clamp(58.0, 88.0), acc_l.clamp(52.0, 66.0))
    };

    let mut picked: Vec<[u8; 3]> = vec![accent_rgb];
    for threshold in [42 * 42, 24 * 24, 10 * 10] {
        for c in &by_vivid {
            if picked.len() >= 5 {
                break;
            }
            let refined = if c.sat >= 18.0 {
                let (h, s, l) = rgb_to_hsl(c.rgb);
                hsl_to_rgb(h, s.clamp(45.0, 88.0), l.clamp(38.0, 74.0))
            } else {
                c.rgb
            };
            if picked.iter().all(|&p| rgb_dist_sq(p, refined) >= threshold) {
                picked.push(refined);
            }
        }
        if picked.len() >= 5 {
            break;
        }
    }
    if picked.iter().all(|&p| rgb_dist_sq(p, dominant_raw) >= 24 * 24) && picked.len() < 5 {
        picked.push(dominant_raw);
    }
    while picked.len() < 5 {
        let shift = (picked.len() as f32) * 35.0;
        picked.push(hsl_to_rgb((acc_h + shift) % 360.0, acc_s.max(35.0).min(78.0), 54.0));
    }

    let secondary_rgb = picked
        .iter()
        .skip(1)
        .max_by_key(|&&rgb| rgb_dist_sq(rgb, accent_rgb))
        .copied()
        .unwrap_or(picked[1]);

    let surface_dark = rgb_hex(hsl_to_rgb(dom_h, dom_s.min(40.0), 10.0));
    let surface_light = rgb_hex(hsl_to_rgb(dom_h, dom_s.min(24.0), 94.0));

    WallpaperPalette {
        dominant: rgb_hex(dominant_raw),
        accent: rgb_hex(accent_rgb),
        surface_dark,
        surface_light,
        secondary: rgb_hex(secondary_rgb),
        swatches: picked.into_iter().take(5).map(rgb_hex).collect(),
        is_dark,
        source: source.to_string(),
    }
}

#[tauri::command]
pub async fn extract_wallpaper_palette() -> Result<WallpaperPalette, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let wallpaper = monitor_wallpaper(0, 0).unwrap_or_else(desktop_wallpaper);
        for path in candidates(&wallpaper) {
            if let Some(img) = decode(&path) {
                let thumb = img.thumbnail(128, 128).to_rgba8();
                let (w, h) = thumb.dimensions();
                let source = path.file_name().and_then(|s| s.to_str()).unwrap_or("wallpaper");
                return Ok(extract_palette_from_rgba(thumb.as_raw(), w, h, source));
            }
        }
        Ok(palette_from_solid_rgb(wallpaper.color, "solid"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{extract_palette_from_rgba, palette_from_solid_rgb};

    #[test]
    fn extract_palette_finds_vivid_accent_and_distinct_swatches() {
        let w = 128u32;
        let h = 128u32;
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let i = ((y * w + x) * 4) as usize;
                if y < 90 {
                    // Deep plum background band
                    rgba[i] = 35;
                    rgba[i + 1] = 16;
                    rgba[i + 2] = 42;
                } else if x < 64 {
                    // Vivid rose accent region
                    rgba[i] = 245;
                    rgba[i + 1] = 92;
                    rgba[i + 2] = 148;
                } else {
                    // Cool cyan secondary region
                    rgba[i] = 68;
                    rgba[i + 1] = 198;
                    rgba[i + 2] = 230;
                }
                rgba[i + 3] = 255;
            }
        }
        let palette = extract_palette_from_rgba(&rgba, w, h, "test.png");
        assert!(palette.is_dark);
        assert_eq!(palette.swatches.len(), 5);
        assert_ne!(palette.accent, palette.surface_dark);
        assert_ne!(palette.accent, palette.secondary);
        assert!(palette.accent.starts_with('#') && palette.accent.len() == 7);
    }

    #[test]
    fn extract_palette_handles_empty_input_and_solid_color() {
        let fallback = extract_palette_from_rgba(&[], 0, 0, "none");
        assert_eq!(fallback.swatches.len(), 5);
        let solid = palette_from_solid_rgb([230, 224, 210], "solid");
        assert!(!solid.is_dark);
        assert_eq!(solid.swatches.len(), 5);
    }
}
