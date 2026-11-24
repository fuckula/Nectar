//! File search provider using Everything IPC v2 with bounded cancellable user-folder fallback.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Once;
use std::time::{SystemTime, UNIX_EPOCH};

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::DataExchange::COPYDATASTRUCT;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, FindWindowW, GetMessageW,
    GetWindowLongPtrW, KillTimer, PostMessageW, RegisterClassW, SendMessageTimeoutW, SetTimer,
    SetWindowLongPtrW, TranslateMessage, CREATESTRUCTW, GWLP_USERDATA, HWND_MESSAGE, MSG,
    SMTO_ABORTIFHUNG, WINDOW_EX_STYLE, WINDOW_STYLE, WM_COPYDATA, WM_CREATE, WM_NULL, WM_TIMER,
    WNDCLASSW,
};
use windows::core::{PCWSTR, w};

use super::fuzzy;

// Constants verified directly against voidtools Everything-SDK `everything_ipc.h`.
const EVERYTHING_IPC_COPYDATA_QUERY2W: usize = 18;
const EVERYTHING_IPC_QUERY2_REQUEST_FULL_PATH_AND_NAME: u32 = 0x0000_0004;
const EVERYTHING_IPC_SORT_NAME_ASCENDING: u32 = 1;
const EVERYTHING_IPC_FOLDER: u32 = 0x0000_0001;
const EVERYTHING_IPC_MATCHPATH: u32 = 0x0000_0004;
const REPLY_COPYDATA_ID: u32 = 0x4E45_4354; // "NECT"

const FALLBACK_MAX_DEPTH: usize = 4;
const FALLBACK_MAX_ENTRIES: usize = 2_500;

static REGISTER_CLASS_ONCE: Once = Once::new();
static ACTIVE_SEARCH_GEN: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileHit {
    pub name: String,
    pub path: String,
    pub parent_dir: String,
    pub is_folder: bool,
    pub score: i32,
    pub match_indices: Vec<usize>,
    pub from_everything: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedFileQuery {
    pub clean_query: String,
    pub extensions: Vec<String>,
    pub dm_spec: Option<String>,
    pub dm_max_age_secs: Option<u64>,
    pub only_folders: bool,
    pub only_files: bool,
}

pub fn begin_search_generation() -> u64 {
    ACTIVE_SEARCH_GEN.fetch_add(1, Ordering::SeqCst) + 1
}

pub fn is_search_current(gen: u64) -> bool {
    ACTIVE_SEARCH_GEN.load(Ordering::Relaxed) == gen
}

fn dm_spec_to_max_age_secs(spec: &str) -> Option<u64> {
    match spec.to_ascii_lowercase().as_str() {
        "today" | "1d" => Some(86_400),
        "yesterday" | "2d" => Some(2 * 86_400),
        "thisweek" | "week" | "7d" => Some(7 * 86_400),
        "thismonth" | "month" | "30d" => Some(30 * 86_400),
        s if s.ends_with('d') => s[..s.len() - 1].parse::<u64>().ok().map(|d| d.saturating_mul(86_400)),
        s if s.ends_with('h') => s[..s.len() - 1].parse::<u64>().ok().map(|h| h.saturating_mul(3_600)),
        _ => None,
    }
}

/// Parses `ext:rs,ts`, `dm:today`, `folder:`, `file:` modifiers out of a user query while preserving
/// plain search tokens for Everything or fuzzy fallback matching.
pub fn parse_file_filters(raw: &str) -> ParsedFileQuery {
    let mut parsed = ParsedFileQuery::default();
    let mut kept_tokens = Vec::new();
    for tok in raw.split_whitespace() {
        let lower = tok.to_ascii_lowercase();
        if lower == "folder:" || lower == "dir:" {
            parsed.only_folders = true;
            continue;
        }
        if lower == "file:" {
            parsed.only_files = true;
            continue;
        }
        if let Some(dm) = lower.strip_prefix("dm:") {
            if !dm.is_empty() {
                parsed.dm_spec = Some(dm.to_string());
                parsed.dm_max_age_secs = dm_spec_to_max_age_secs(dm);
            }
            continue;
        }
        if let Some(exts) = lower.strip_prefix("ext:") {
            for ext in exts.split(&[',', ';'][..]) {
                let e = ext.trim().trim_start_matches('.').to_string();
                if !e.is_empty() && !parsed.extensions.contains(&e) {
                    parsed.extensions.push(e);
                }
            }
            continue;
        }
        kept_tokens.push(tok);
    }
    parsed.clean_query = kept_tokens.join(" ");
    parsed
}

#[repr(C, packed)]
struct EverythingIpcQuery2Header {
    reply_hwnd: u32,
    reply_copydata_message: u32,
    search_flags: u32,
    offset: u32,
    max_results: u32,
    request_flags: u32,
    sort_type: u32,
}

#[repr(C, packed)]
#[derive(Clone, Copy)]
struct EverythingIpcList2Header {
    totitems: u32,
    numitems: u32,
    offset: u32,
    request_flags: u32,
    sort_type: u32,
}

#[repr(C, packed)]
#[derive(Clone, Copy)]
struct EverythingIpcItem2 {
    flags: u32,
    data_offset: u32,
}

fn read_u32_le(buf: &[u8], offset: usize) -> Option<u32> {
    let end = offset.checked_add(4)?;
    let slice = buf.get(offset..end)?;
    Some(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

/// Safely parses an `EVERYTHING_IPC_LIST2` buffer using explicit bounds checks on every
/// item offset and string length.
pub fn parse_list2_reply(buf: &[u8]) -> Option<Vec<FileHit>> {
    const HDR_SIZE: usize = std::mem::size_of::<EverythingIpcList2Header>();
    const ITEM_SIZE: usize = std::mem::size_of::<EverythingIpcItem2>();
    if buf.len() < HDR_SIZE {
        return None;
    }

    let numitems = read_u32_le(buf, 4)? as usize;
    let request_flags = read_u32_le(buf, 12)?;
    if (request_flags & EVERYTHING_IPC_QUERY2_REQUEST_FULL_PATH_AND_NAME) == 0 {
        return Some(Vec::new());
    }

    let items_bytes = numitems.checked_mul(ITEM_SIZE)?;
    if HDR_SIZE.checked_add(items_bytes)? > buf.len() {
        return None;
    }

    let mut out = Vec::with_capacity(numitems.min(128));
    for i in 0..numitems {
        let base = HDR_SIZE + i * ITEM_SIZE;
        let flags = read_u32_le(buf, base)?;
        let data_offset = read_u32_le(buf, base + 4)? as usize;
        let Some(char_len) = read_u32_le(buf, data_offset).map(|n| n as usize) else {
            continue;
        };
        let str_start = data_offset.checked_add(4)?;
        let byte_len = char_len.checked_mul(2)?;
        let str_end = str_start.checked_add(byte_len)?;
        let Some(raw_bytes) = buf.get(str_start..str_end) else {
            continue;
        };
        let mut units = Vec::with_capacity(char_len);
        for chunk in raw_bytes.chunks_exact(2) {
            units.push(u16::from_le_bytes([chunk[0], chunk[1]]));
        }
        let full_path = String::from_utf16_lossy(&units);
        if full_path.is_empty() {
            continue;
        }
        let p = Path::new(&full_path);
        let name = p
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(&full_path)
            .to_string();
        let parent_dir = p
            .parent()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let is_folder = (flags & EVERYTHING_IPC_FOLDER) != 0;
        out.push(FileHit {
            name,
            path: full_path,
            parent_dir,
            is_folder,
            score: 4_000 - (i as i32 * 10),
            match_indices: Vec::new(),
            from_everything: true,
        });
    }
    Some(out)
}

pub fn find_everything_hwnd() -> Option<HWND> {
    unsafe {
        if let Ok(hwnd) = FindWindowW(w!("EVERYTHING_TASKBAR_NOTIFICATION_(1.5a)"), PCWSTR::null()) {
            if !hwnd.0.is_null() {
                return Some(hwnd);
            }
        }
        if let Ok(hwnd) = FindWindowW(w!("EVERYTHING_TASKBAR_NOTIFICATION"), PCWSTR::null()) {
            if !hwnd.0.is_null() {
                return Some(hwnd);
            }
        }
    }
    None
}

pub fn is_everything_available() -> bool {
    find_everything_hwnd().is_some()
}

struct ReplyState {
    hits: Option<Vec<FileHit>>,
    done: bool,
}

unsafe extern "system" fn query_wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_CREATE => {
            let cs = &*(lparam.0 as *const CREATESTRUCTW);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, cs.lpCreateParams as isize);
            LRESULT(0)
        }
        WM_COPYDATA => {
            let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ReplyState;
            if !ptr.is_null() {
                let cds = &*(lparam.0 as *const COPYDATASTRUCT);
                if cds.dwData == REPLY_COPYDATA_ID as usize
                    && !cds.lpData.is_null()
                    && cds.cbData > 0
                {
                    let slice =
                        std::slice::from_raw_parts(cds.lpData as *const u8, cds.cbData as usize);
                    (*ptr).hits = parse_list2_reply(slice);
                }
                let _ = KillTimer(Some(hwnd), 1);
                (*ptr).done = true;
                // Wake GetMessageW without leaving thread-level WM_QUIT on pooled Tokio workers.
                let _ = PostMessageW(Some(hwnd), WM_NULL, WPARAM(0), LPARAM(0));
                return LRESULT(1);
            }
            LRESULT(0)
        }
        WM_TIMER => {
            let _ = KillTimer(Some(hwnd), 1);
            let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ReplyState;
            if !ptr.is_null() {
                (*ptr).done = true;
            }
            let _ = PostMessageW(Some(hwnd), WM_NULL, WPARAM(0), LPARAM(0));
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

fn format_everything_query(raw: &str) -> String {
    let parsed = parse_file_filters(raw);
    let mut parts = Vec::new();
    if parsed.only_folders {
        parts.push("folder:".to_string());
    } else if parsed.only_files {
        parts.push("file:".to_string());
    }
    if !parsed.extensions.is_empty() {
        parts.push(format!("ext:{}", parsed.extensions.join(";")));
    }
    if let Some(ref dm) = parsed.dm_spec {
        parts.push(format!("dm:{dm}"));
    }
    if !parsed.clean_query.is_empty() {
        parts.push(parsed.clean_query);
    }
    parts.join(" ")
}

/// Queries the running Everything IPC window synchronously with a hard 350ms deadline.
pub fn query_everything(raw_query: &str, max_results: usize) -> Option<Vec<FileHit>> {
    let everything_hwnd = find_everything_hwnd()?;
    let search_text = format_everything_query(raw_query);
    if search_text.trim().is_empty() {
        return Some(Vec::new());
    }

    unsafe {
        let hinstance = GetModuleHandleW(None).ok()?;
        let class_name = w!("NectarEverythingQueryWindow");
        REGISTER_CLASS_ONCE.call_once(|| {
            let wc = WNDCLASSW {
                lpfnWndProc: Some(query_wnd_proc),
                hInstance: hinstance.into(),
                lpszClassName: class_name,
                ..Default::default()
            };
            let _ = RegisterClassW(&wc);
        });

        let mut state = ReplyState {
            hits: None,
            done: false,
        };
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            class_name,
            w!(""),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(hinstance.into()),
            Some(&mut state as *mut _ as *const std::ffi::c_void),
        )
        .ok()?;

        let _ = SetTimer(Some(hwnd), 1, 350, None);

        let wide_query: Vec<u16> = search_text.encode_utf16().chain(std::iter::once(0)).collect();
        let hdr = EverythingIpcQuery2Header {
            reply_hwnd: hwnd.0 as usize as u32,
            reply_copydata_message: REPLY_COPYDATA_ID,
            search_flags: EVERYTHING_IPC_MATCHPATH,
            offset: 0,
            max_results: (max_results.max(1) as u32).min(64),
            request_flags: EVERYTHING_IPC_QUERY2_REQUEST_FULL_PATH_AND_NAME,
            sort_type: EVERYTHING_IPC_SORT_NAME_ASCENDING,
        };
        let hdr_bytes = std::slice::from_raw_parts(
            (&hdr as *const EverythingIpcQuery2Header) as *const u8,
            std::mem::size_of::<EverythingIpcQuery2Header>(),
        );
        let mut payload = Vec::with_capacity(hdr_bytes.len() + wide_query.len() * 2);
        payload.extend_from_slice(hdr_bytes);
        for unit in &wide_query {
            payload.extend_from_slice(&unit.to_le_bytes());
        }

        let cds = COPYDATASTRUCT {
            dwData: EVERYTHING_IPC_COPYDATA_QUERY2W,
            cbData: payload.len() as u32,
            lpData: payload.as_mut_ptr() as *mut std::ffi::c_void,
        };

        let mut send_result = 0usize;
        let ok = SendMessageTimeoutW(
            everything_hwnd,
            WM_COPYDATA,
            WPARAM(hwnd.0 as usize),
            LPARAM(&cds as *const COPYDATASTRUCT as isize),
            SMTO_ABORTIFHUNG,
            250,
            Some(&mut send_result),
        );

        if ok.0 != 0 && send_result != 0 && !state.done {
            let mut msg = MSG::default();
            while !state.done && GetMessageW(&mut msg, Some(hwnd), 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }

        let _ = KillTimer(Some(hwnd), 1);
        let _ = DestroyWindow(hwnd);

        // Compute UI highlight positions and clean relevance scores on returned hits.
        let parsed = parse_file_filters(raw_query);
        let mut hits = state.hits?;
        if !parsed.clean_query.is_empty() {
            for hit in &mut hits {
                if let Some((s, idxs)) =
                    fuzzy::match_candidate(&parsed.clean_query, &hit.name, Some(&hit.parent_dir))
                {
                    hit.score = s;
                    hit.match_indices = idxs;
                }
            }
            hits.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.name.len().cmp(&b.name.len())));
        }
        hits.truncate(max_results);
        Some(hits)
    }
}

fn known_user_folders() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut seen = HashSet::new();
    if let Ok(profile) = std::env::var("USERPROFILE") {
        let base = PathBuf::from(profile);
        for sub in ["Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos"] {
            let p = base.join(sub);
            if p.is_dir() && seen.insert(p.clone()) {
                dirs.push(p);
            }
        }
    }
    if let Ok(onedrive) = std::env::var("OneDrive") {
        let base = PathBuf::from(onedrive);
        for sub in ["Desktop", "Documents", "Pictures"] {
            let p = base.join(sub);
            if p.is_dir() && seen.insert(p.clone()) {
                dirs.push(p);
            }
        }
    }
    dirs
}

fn should_skip_dir(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "node_modules" | ".git" | "target" | "$recycle.bin" | "appdata" | "__pycache__" | ".venv"
    ) || lower.starts_with('.')
}

/// Searches standard Windows user folders as a graceful, bounded fallback when Everything is not running.
pub fn fallback_search(raw_query: &str, max_results: usize, gen: u64) -> Vec<FileHit> {
    let parsed = parse_file_filters(raw_query);
    if parsed.clean_query.is_empty() && parsed.extensions.is_empty() && !parsed.only_folders {
        return Vec::new();
    }

    let mut hits = Vec::new();
    let mut visited = 0usize;
    let mut queue: Vec<(PathBuf, usize)> = known_user_folders().into_iter().map(|d| (d, 0)).collect();

    while let Some((dir, depth)) = queue.pop() {
        if !is_search_current(gen) || visited >= FALLBACK_MAX_ENTRIES {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if !is_search_current(gen) || visited >= FALLBACK_MAX_ENTRIES {
                break;
            }
            visited += 1;
            let path = entry.path();
            let Some(name_os) = path.file_name() else {
                continue;
            };
            let name = name_os.to_string_lossy().to_string();
            if name.starts_with("desktop.ini") || name.starts_with("~$") {
                continue;
            }
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir && depth < FALLBACK_MAX_DEPTH && !should_skip_dir(&name) {
                queue.push((path.clone(), depth + 1));
            }

            if parsed.only_folders && !is_dir {
                continue;
            }
            if parsed.only_files && is_dir {
                continue;
            }
            if !parsed.extensions.is_empty() {
                let ext = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.to_ascii_lowercase())
                    .unwrap_or_default();
                if !parsed.extensions.contains(&ext) {
                    continue;
                }
            }
            if let Some(max_age) = parsed.dm_max_age_secs {
                let age_secs = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| SystemTime::now().duration_since(t).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(u64::MAX);
                if age_secs > max_age {
                    continue;
                }
            }

            let parent_dir = dir.to_string_lossy().to_string();
            let (score, idxs) = if parsed.clean_query.is_empty() {
                let mtime_bonus = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| (d.as_secs() / 86_400) as i32)
                    .unwrap_or(0);
                (2_000 + mtime_bonus.min(1_000), Vec::new())
            } else if let Some((s, idxs)) =
                fuzzy::match_candidate(&parsed.clean_query, &name, Some(&parent_dir))
            {
                (s, idxs)
            } else {
                continue;
            };

            let recency_bonus = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| SystemTime::now().duration_since(t).ok())
                .map(|age| if age.as_secs() < 7 * 86_400 { 220 } else { 0 })
                .unwrap_or(0);

            hits.push(FileHit {
                name,
                path: path.to_string_lossy().to_string(),
                parent_dir,
                is_folder: is_dir,
                score: score + recency_bonus,
                match_indices: idxs,
                from_everything: false,
            });
        }
    }

    hits.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.name.len().cmp(&b.name.len())));
    hits.truncate(max_results);
    hits
}

pub fn search_files(
    raw_query: &str,
    max_results: usize,
    use_everything: bool,
    gen: u64,
) -> (Vec<FileHit>, bool) {
    let ev_avail = use_everything && is_everything_available();
    if ev_avail {
        if let Some(hits) = query_everything(raw_query, max_results) {
            return (hits, true);
        }
    }
    (fallback_search(raw_query, max_results, gen), ev_avail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_file_filters_cleanly() {
        let p = parse_file_filters("folder: dm:today ext:rs,md;toml nectar");
        assert!(p.only_folders);
        assert!(!p.only_files);
        assert_eq!(p.dm_spec.as_deref(), Some("today"));
        assert_eq!(p.dm_max_age_secs, Some(86_400));
        assert_eq!(p.extensions, vec!["rs", "md", "toml"]);
        assert_eq!(p.clean_query, "nectar");
    }

    #[test]
    fn parses_valid_everything_list2_buffer() {
        let path_str = r"C:\Users\Demo\Documents\notes.txt";
        let utf16: Vec<u16> = path_str.encode_utf16().collect();
        let data_offset: u32 = 20 + 8; // header (20) + 1 item (8)

        let mut buf = Vec::new();
        // List2Header: totitems=1, numitems=1, offset=0, request_flags=4, sort_type=1
        buf.extend_from_slice(&1u32.to_le_bytes());
        buf.extend_from_slice(&1u32.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.extend_from_slice(&EVERYTHING_IPC_QUERY2_REQUEST_FULL_PATH_AND_NAME.to_le_bytes());
        buf.extend_from_slice(&EVERYTHING_IPC_SORT_NAME_ASCENDING.to_le_bytes());
        // Item2: flags=0 (file), data_offset=28
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.extend_from_slice(&data_offset.to_le_bytes());
        // Full path length in chars + UTF-16LE bytes + null
        buf.extend_from_slice(&(utf16.len() as u32).to_le_bytes());
        for u in &utf16 {
            buf.extend_from_slice(&u.to_le_bytes());
        }
        buf.extend_from_slice(&0u16.to_le_bytes());

        let parsed = parse_list2_reply(&buf).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].name, "notes.txt");
        assert_eq!(parsed[0].parent_dir, r"C:\Users\Demo\Documents");
        assert!(!parsed[0].is_folder);
    }

    #[test]
    fn rejects_truncated_or_oob_everything_buffer() {
        assert!(parse_list2_reply(&[0u8; 8]).is_none());
        let mut corrupt = vec![0u8; 20];
        corrupt[4..8].copy_from_slice(&999_999u32.to_le_bytes()); // huge numitems
        corrupt[12..16].copy_from_slice(&EVERYTHING_IPC_QUERY2_REQUEST_FULL_PATH_AND_NAME.to_le_bytes());
        assert!(parse_list2_reply(&corrupt).is_none());
    }
}
