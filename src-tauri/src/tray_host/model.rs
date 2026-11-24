//! Pure state model for mirrored Windows notification-area icons.

use super::wire::{self, Notify, RectQuery};
use windows::core::GUID;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Key {
    Guid(GUID),
    Exe { exe: String, uid: u32 },
    Window { hwnd: u32, uid: u32 },
}

impl Key {
    pub fn stable_id(&self) -> String {
        match self {
            Key::Guid(g) => format!(
                "guid:{:08x}-{:04x}-{:04x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
                g.data1,
                g.data2,
                g.data3,
                g.data4[0],
                g.data4[1],
                g.data4[2],
                g.data4[3],
                g.data4[4],
                g.data4[5],
                g.data4[6],
                g.data4[7],
            ),
            Key::Exe { exe, uid } => format!("exe:{exe}:{uid}"),
            Key::Window { hwnd, uid } => format!("win:{hwnd:x}:{uid}"),
        }
    }
}

pub fn exe_basename(path: &str) -> Option<String> {
    let norm = normalize_exe(path);
    let base = norm.rsplit('\\').next().unwrap_or("").trim();
    (!base.is_empty()).then(|| base.to_string())
}

fn query_hwnd_exe_basename(hwnd: u32) -> Option<String> {
    if hwnd == 0 {
        return None;
    }
    unsafe {
        use windows::Win32::Foundation::{CloseHandle, HWND};
        use windows::Win32::System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
            PROCESS_QUERY_LIMITED_INFORMATION,
        };
        use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
        use windows::core::PWSTR;

        let handle = HWND(wire::handle(hwnd) as _);
        let mut pid = 0u32;
        if GetWindowThreadProcessId(handle, Some(&mut pid)) == 0 || pid == 0 {
            return None;
        }
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = [0u16; 1024];
        let mut len = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(process);
        if !ok || len == 0 {
            return None;
        }
        let full = String::from_utf16_lossy(&buffer[..len as usize]);
        exe_basename(&full)
    }
}

#[derive(Debug, Clone)]
pub struct Icon<I> {
    pub hwnd: u32,
    pub uid: u32,
    pub guid: Option<GUID>,
    pub callback: u32,
    pub version: u32,
    pub state: u32,
    pub tip: String,
    pub image: Option<I>,
    pub revision: u64,
    pub pid: u32,
    pub exes: Vec<String>,
    pub promoted: Option<bool>,
    pub order: Option<usize>,
    pub accepted: bool,
}

impl<I> Icon<I> {
    pub fn key(&self) -> Key {
        if let Some(guid) = self.guid {
            return Key::Guid(guid);
        }
        if let Some(exe) = self
            .exes
            .iter()
            .find_map(|p| exe_basename(p))
            .or_else(|| query_hwnd_exe_basename(self.hwnd))
        {
            return Key::Exe { exe, uid: self.uid };
        }
        Key::Window {
            hwnd: self.hwnd,
            uid: self.uid,
        }
    }

    pub fn visible(&self) -> bool {
        self.image.is_some() && (self.state & wire::NIS_HIDDEN) == 0
    }
}

pub fn merge_state(old: u32, new: u32, mask: u32) -> u32 {
    (old & !mask) | (new & mask)
}

#[derive(Debug, Clone, Default)]
pub struct Owner {
    pub pid: u32,
    pub exes: Vec<String>,
}

pub struct Model<I> {
    pub icons: Vec<Icon<I>>,
    revision: u64,
}

impl<I> Default for Model<I> {
    fn default() -> Self {
        Self {
            icons: Vec::new(),
            revision: 0,
        }
    }
}

impl<I> Model<I> {
    fn position(&self, guid: Option<GUID>, hwnd: u32, uid: u32) -> Option<usize> {
        self.icons.iter().position(|icon| match guid {
            Some(guid) => icon.guid == Some(guid),
            None => icon.guid.is_none() && icon.hwnd == hwnd && icon.uid == uid,
        })
    }

    pub fn find_by_stable_id(&self, stable_id: &str) -> Option<&Icon<I>> {
        self.icons.iter().find(|icon| icon.key().stable_id() == stable_id)
    }

    pub fn find_query(&self, q: &RectQuery) -> Option<&Icon<I>> {
        self.position(q.guid, q.hwnd, q.uid).map(|i| &self.icons[i])
    }

    pub fn find_mut(&mut self, guid: Option<GUID>, hwnd: u32, uid: u32) -> Option<&mut Icon<I>> {
        self.position(guid, hwnd, uid).map(|i| &mut self.icons[i])
    }

    pub fn retain(&mut self, mut keep: impl FnMut(&Icon<I>) -> bool) -> bool {
        let before = self.icons.len();
        self.icons.retain(|i| keep(i));
        self.icons.len() != before
    }

    pub fn apply(&mut self, n: &Notify, accepted: bool, image: Option<Option<I>>, owner: Owner) -> bool {
        let at = self.position(n.guid, n.hwnd, n.uid);
        self.revision += 1;
        let revision = self.revision;
        match (n.op, at) {
            (wire::NIM_DELETE, Some(at)) => {
                self.icons.remove(at);
                true
            }
            (wire::NIM_SETVERSION, Some(at)) if matches!(n.version, 0 | 3 | 4) => {
                let icon = &mut self.icons[at];
                icon.version = n.version;
                icon.revision = revision;
                true
            }
            (wire::NIM_ADD | wire::NIM_MODIFY, Some(at)) => {
                let icon = &mut self.icons[at];
                if n.op == wire::NIM_ADD && accepted {
                    icon.version = 0;
                    icon.accepted = true;
                }
                merge(icon, n, image, revision);
                if !owner.exes.is_empty() {
                    icon.pid = owner.pid;
                    icon.exes = owner.exes;
                }
                true
            }
            (wire::NIM_ADD, None) | (wire::NIM_MODIFY, None) if n.op == wire::NIM_ADD || accepted => {
                let mut icon = Icon {
                    hwnd: n.hwnd,
                    uid: n.uid,
                    guid: n.guid,
                    callback: 0,
                    version: 0,
                    state: 0,
                    tip: String::new(),
                    image: None,
                    revision,
                    pid: owner.pid,
                    exes: owner.exes,
                    promoted: None,
                    order: None,
                    accepted,
                };
                merge(&mut icon, n, image, revision);
                self.icons.push(icon);
                true
            }
            _ => false,
        }
    }
}

fn merge<I>(icon: &mut Icon<I>, n: &Notify, image: Option<Option<I>>, revision: u64) {
    if n.guid.is_some() {
        icon.hwnd = n.hwnd;
        icon.uid = n.uid;
    }
    if n.flags & wire::NIF_MESSAGE != 0 {
        icon.callback = n.callback;
    }
    if let Some(image) = image {
        icon.image = image;
    }
    if let Some(tip) = &n.tip {
        icon.tip = tip.clone();
    }
    if n.flags & wire::NIF_STATE != 0 {
        icon.state = merge_state(icon.state, n.state, n.state_mask);
    }
    icon.revision = revision;
}

pub const WM_CONTEXTMENU: u32 = 0x007B;
pub const WM_MOUSEMOVE: u32 = 0x0200;
pub const WM_LBUTTONDOWN: u32 = 0x0201;
pub const WM_LBUTTONUP: u32 = 0x0202;
pub const WM_LBUTTONDBLCLK: u32 = 0x0203;
pub const WM_RBUTTONDOWN: u32 = 0x0204;
pub const WM_RBUTTONUP: u32 = 0x0205;
pub const WM_MBUTTONDOWN: u32 = 0x0207;
pub const WM_MBUTTONUP: u32 = 0x0208;
pub const NIN_SELECT: u32 = 0x0400;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Click,
    DoubleClick,
    Menu,
    MiddleClick,
}

pub fn events(action: Action, version: u32) -> Vec<u32> {
    let mut events = match action {
        Action::Click => vec![WM_MOUSEMOVE, WM_LBUTTONDOWN, WM_LBUTTONUP],
        Action::DoubleClick => vec![WM_LBUTTONDBLCLK, WM_LBUTTONUP],
        Action::Menu => vec![WM_MOUSEMOVE, WM_RBUTTONDOWN, WM_RBUTTONUP],
        Action::MiddleClick => vec![WM_MOUSEMOVE, WM_MBUTTONDOWN, WM_MBUTTONUP],
    };
    if version >= 3 {
        match action {
            Action::Click => events.push(NIN_SELECT),
            Action::Menu => events.push(WM_CONTEXTMENU),
            Action::DoubleClick | Action::MiddleClick => {}
        }
    }
    events
}

pub fn callback_words(version: u32, uid: u32, event: u32, x: i32, y: i32) -> (usize, isize) {
    if version == 4 {
        (
            wire::pack16(x, y) as usize,
            wire::pack16(event as i32, uid as i32) as isize,
        )
    } else {
        (uid as usize, event as isize)
    }
}

#[derive(Debug, Clone, Default)]
pub struct Promotion {
    pub exes: Vec<String>,
    pub uid: Option<u32>,
    pub guid: Option<GUID>,
    pub promoted: Option<bool>,
    pub order: Option<usize>,
}

pub fn promotion<'a>(entries: &'a [Promotion], guid: Option<GUID>, exes: &[String], uid: u32) -> Option<&'a Promotion> {
    let matches = |entry: &&Promotion| match guid {
        Some(guid) => entry.guid == Some(guid),
        None => entry.guid.is_none() && entry.uid == Some(uid) && entry.exes.iter().any(|exe| exes.contains(exe)),
    };
    let mut found = entries.iter().filter(matches);
    found
        .clone()
        .find(|entry| entry.promoted.is_some())
        .or_else(|| found.next())
}

pub fn order_list(bytes: &[u8]) -> Vec<u64> {
    bytes
        .chunks_exact(8)
        .map(|c| u64::from_le_bytes(c.try_into().unwrap()))
        .collect()
}

pub fn normalize_exe(path: &str) -> String {
    path.trim()
        .trim_matches('"')
        .trim_start_matches(r"\\?\")
        .replace('/', "\\")
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tray_host::wire::tests::packet;
    use crate::tray_host::wire::*;

    fn parse(op: u32, flags: u32, uid: u32, tip: &str) -> Notify {
        parse_notify(&packet(op, flags, 0x100, uid, tip)).unwrap()
    }

    fn owner() -> Owner {
        Owner {
            pid: 42,
            exes: vec![r"c:\a.exe".into()],
        }
    }

    #[test]
    fn state_mask_changes_only_masked_bits() {
        assert_eq!(merge_state(0b1010, 0b0101, 0b0011), 0b1001);
        assert_eq!(merge_state(NIS_HIDDEN, 0, 0), NIS_HIDDEN);
        assert_eq!(merge_state(NIS_HIDDEN, 0, NIS_HIDDEN), 0);
        assert_eq!(merge_state(0, NIS_HIDDEN, NIS_HIDDEN), NIS_HIDDEN);
    }

    #[test]
    fn add_modify_version_delete() {
        let mut model = Model::<u8>::default();
        let mut add = parse(NIM_ADD, NIF_MESSAGE | NIF_ICON | NIF_TIP, 1, "One");
        add.state_mask = 0;
        assert!(model.apply(&add, true, Some(Some(1)), owner()));
        assert_eq!(model.icons.len(), 1);
        assert!(model.icons[0].visible());
        assert_eq!(model.icons[0].tip, "One");

        let mut hide = parse(NIM_MODIFY, NIF_STATE, 1, "");
        hide.state = NIS_HIDDEN;
        hide.state_mask = NIS_HIDDEN;
        assert!(model.apply(&hide, true, None, Owner::default()));
        assert!(!model.icons[0].visible());

        let ver = parse(NIM_SETVERSION, 0, 1, "");
        assert!(model.apply(&ver, true, None, Owner::default()));
        assert_eq!(model.icons[0].version, 4);

        let del = parse(NIM_DELETE, 0, 1, "");
        assert!(model.apply(&del, true, None, Owner::default()));
        assert!(model.icons.is_empty());
    }

    #[test]
    fn callback_words_follow_the_version() {
        let (wp, lp) = callback_words(4, 7, NIN_SELECT, 1500, 1170);
        assert_eq!(wp, (1500u32 | (1170u32 << 16)) as usize);
        assert_eq!(lp, (NIN_SELECT | (7 << 16)) as isize);

        let (wp, lp) = callback_words(3, 7, WM_CONTEXTMENU, 10, 20);
        assert_eq!(wp, 7);
        assert_eq!(lp, WM_CONTEXTMENU as isize);

        assert_eq!(events(Action::Click, 4).last(), Some(&NIN_SELECT));
        assert_eq!(events(Action::Menu, 3).last(), Some(&WM_CONTEXTMENU));
        assert_eq!(events(Action::MiddleClick, 4).last(), Some(&WM_MBUTTONUP));
    }

    #[test]
    fn stable_id_uses_exe_basename_when_guid_missing() {
        let mut model = Model::<u8>::default();
        let add = parse(NIM_ADD, NIF_MESSAGE | NIF_ICON | NIF_TIP, 7, "App");
        assert!(model.apply(
            &add,
            true,
            Some(Some(1)),
            Owner {
                pid: 42,
                exes: vec![r"C:\Program Files\Demo App\DemoApp.EXE".into()],
            }
        ));
        assert_eq!(model.icons[0].key().stable_id(), "exe:demoapp.exe:7");

        // Without exe or valid window, falls back to win:{hwnd:x}:{uid}
        let mut no_exe = Model::<u8>::default();
        assert!(no_exe.apply(&add, true, Some(Some(1)), Owner::default()));
        assert_eq!(no_exe.icons[0].key().stable_id(), "win:100:7");
    }
}
