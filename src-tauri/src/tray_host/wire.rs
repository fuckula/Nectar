//! Decodes Shell_NotifyIcon WM_COPYDATA packets from Windows shell32.
//!
//! shell32 writes handles through 32-bit wire fields so the packet layout is
//! identical across 32- and 64-bit senders on Windows 11.

use windows::core::GUID;

pub const MAGIC: u32 = 0x3475_3423;
pub const TAG_NOTIFY: usize = 1;
pub const TAG_GET_RECT: usize = 3;
pub const NOTIFY_SIZE: usize = 1484;
pub const NID_MIN: u32 = 956;
pub const RECT_SIZE: usize = 40;

pub const NIM_ADD: u32 = 0;
pub const NIM_MODIFY: u32 = 1;
pub const NIM_DELETE: u32 = 2;
pub const NIM_SETVERSION: u32 = 4;

pub const NIF_MESSAGE: u32 = 0x01;
pub const NIF_ICON: u32 = 0x02;
pub const NIF_TIP: u32 = 0x04;
pub const NIF_STATE: u32 = 0x08;
pub const NIF_GUID: u32 = 0x20;

pub const NIS_HIDDEN: u32 = 0x01;

const NID: usize = 8;
const HWND_AT: usize = NID + 4;
const UID_AT: usize = NID + 8;
const FLAGS_AT: usize = NID + 12;
const CALLBACK_AT: usize = NID + 16;
const HICON_AT: usize = NID + 20;
const TIP_AT: usize = NID + 24;
const STATE_AT: usize = NID + 280;
const STATE_MASK_AT: usize = NID + 284;
const VERSION_AT: usize = NID + 800;
const GUID_AT: usize = NID + 936;
const EXE_AT: usize = NID + 956;

#[derive(Debug, Clone, PartialEq)]
pub struct Notify {
    pub op: u32,
    pub hwnd: u32,
    pub uid: u32,
    pub flags: u32,
    pub callback: u32,
    pub hicon: u32,
    pub tip: Option<String>,
    pub state: u32,
    pub state_mask: u32,
    pub version: u32,
    pub guid: Option<GUID>,
    pub exe: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RectQuery {
    pub query: u32,
    pub hwnd: u32,
    pub uid: u32,
    pub guid: Option<GUID>,
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn guid_at(bytes: &[u8], at: usize) -> Option<GUID> {
    let raw = bytes.get(at..at + 16)?;
    Some(GUID::from_values(
        u32_at(raw, 0)?,
        u16::from_le_bytes([raw[4], raw[5]]),
        u16::from_le_bytes([raw[6], raw[7]]),
        raw[8..16].try_into().ok()?,
    ))
}

fn text_at(bytes: &[u8], at: usize, units: usize) -> String {
    let raw = bytes.get(at..(at + units * 2).min(bytes.len())).unwrap_or_default();
    let wide: Vec<u16> = raw
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .take_while(|&c| c != 0)
        .collect();
    String::from_utf16_lossy(&wide)
}

pub fn handle(value: u32) -> usize {
    value as usize
}

pub fn pack16(low: i32, high: i32) -> u32 {
    (low as u16 as u32) | ((high as u16 as u32) << 16)
}

pub fn parse_notify(bytes: &[u8]) -> Option<Notify> {
    if bytes.len() < NOTIFY_SIZE || u32_at(bytes, 0)? != MAGIC || u32_at(bytes, NID)? < NID_MIN {
        return None;
    }
    let flags = u32_at(bytes, FLAGS_AT)?;
    let guid = guid_at(bytes, GUID_AT)?;
    Some(Notify {
        op: u32_at(bytes, 4)?,
        hwnd: u32_at(bytes, HWND_AT)?,
        uid: u32_at(bytes, UID_AT)?,
        flags,
        callback: u32_at(bytes, CALLBACK_AT)?,
        hicon: u32_at(bytes, HICON_AT)?,
        tip: (flags & NIF_TIP != 0).then(|| text_at(bytes, TIP_AT, 128)),
        state: u32_at(bytes, STATE_AT)?,
        state_mask: u32_at(bytes, STATE_MASK_AT)?,
        version: u32_at(bytes, VERSION_AT)?,
        guid: (flags & NIF_GUID != 0 && guid != GUID::zeroed()).then_some(guid),
        exe: text_at(bytes, EXE_AT, 260),
    })
}

pub fn parse_rect(bytes: &[u8]) -> Option<RectQuery> {
    if bytes.len() < RECT_SIZE || u32_at(bytes, 0)? != MAGIC || u32_at(bytes, 8)? < 32 {
        return None;
    }
    let guid = guid_at(bytes, 24)?;
    Some(RectQuery {
        query: u32_at(bytes, 4)?,
        hwnd: u32_at(bytes, 16)?,
        uid: u32_at(bytes, 20)?,
        guid: (guid != GUID::zeroed()).then_some(guid),
    })
}

pub fn rect_reply(query: u32, left: i32, top: i32, right: i32, bottom: i32) -> Option<u32> {
    match query {
        1 => Some(pack16(left, top)),
        2 => Some(pack16(right - left, bottom - top)),
        _ => None,
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    pub fn packet(op: u32, flags: u32, hwnd: u32, uid: u32, tip: &str) -> Vec<u8> {
        let mut bytes = vec![0u8; NOTIFY_SIZE];
        for (at, value) in [
            (0, MAGIC),
            (4, op),
            (NID, NID_MIN),
            (HWND_AT, hwnd),
            (UID_AT, uid),
            (FLAGS_AT, flags),
            (CALLBACK_AT, 0x8001),
            (HICON_AT, 0x4_1234),
            (STATE_AT, NIS_HIDDEN),
            (STATE_MASK_AT, NIS_HIDDEN),
            (VERSION_AT, 4),
        ] {
            bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
        }
        for (i, unit) in tip.encode_utf16().take(127).enumerate() {
            bytes[TIP_AT + i * 2..TIP_AT + i * 2 + 2].copy_from_slice(&unit.to_le_bytes());
        }
        let exe = r"{F38BF404-1D43-42F2-9305-67DE0B28FC23}\a.exe";
        for (i, unit) in exe.encode_utf16().take(259).enumerate() {
            bytes[EXE_AT + i * 2..EXE_AT + i * 2 + 2].copy_from_slice(&unit.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn parses_notify_fields() {
        let bytes = packet(NIM_ADD, NIF_MESSAGE | NIF_ICON | NIF_TIP, 0x1_0234, 7, "Probe\nline");
        let n = parse_notify(&bytes).unwrap();
        assert_eq!(
            (n.op, n.hwnd, n.uid, n.callback, n.hicon),
            (NIM_ADD, 0x1_0234, 7, 0x8001, 0x4_1234)
        );
        assert_eq!(n.tip.as_deref(), Some("Probe\nline"));
        assert_eq!((n.state, n.state_mask, n.version), (NIS_HIDDEN, NIS_HIDDEN, 4));
        assert_eq!(n.exe, r"{F38BF404-1D43-42F2-9305-67DE0B28FC23}\a.exe");

        let n = parse_notify(&packet(NIM_MODIFY, NIF_ICON, 1, 1, "stale")).unwrap();
        assert_eq!((n.tip, n.guid), (None, None));
    }

    #[test]
    fn rejects_short_or_foreign_packets() {
        let bytes = packet(NIM_ADD, NIF_TIP, 1, 1, "x");
        assert!(parse_notify(&bytes[..NOTIFY_SIZE - 1]).is_none());
        let mut bad = bytes.clone();
        bad[0] ^= 1;
        assert!(parse_notify(&bad).is_none());
        let mut small = bytes.clone();
        small[NID..NID + 4].copy_from_slice(&955u32.to_le_bytes());
        assert!(parse_notify(&small).is_none());

        let mut long = bytes;
        long.extend([0xAA; 64]);
        assert!(parse_notify(&long).is_some());
    }

    #[test]
    fn parses_guids_only_with_flag() {
        let guid = GUID::from_u128(0x16D5471A_2359_44B0_9585_E95E189DBB3F);
        let mut bytes = packet(NIM_ADD, NIF_GUID, 1, 1, "");
        bytes[GUID_AT..GUID_AT + 4].copy_from_slice(&guid.data1.to_le_bytes());
        bytes[GUID_AT + 4..GUID_AT + 6].copy_from_slice(&guid.data2.to_le_bytes());
        bytes[GUID_AT + 6..GUID_AT + 8].copy_from_slice(&guid.data3.to_le_bytes());
        bytes[GUID_AT + 8..GUID_AT + 16].copy_from_slice(&guid.data4);
        assert_eq!(parse_notify(&bytes).unwrap().guid, Some(guid));
        bytes[FLAGS_AT..FLAGS_AT + 4].copy_from_slice(&0u32.to_le_bytes());
        assert_eq!(parse_notify(&bytes).unwrap().guid, None);
    }

    #[test]
    fn parses_rect_queries_and_negative_monitors() {
        let mut bytes = vec![0u8; RECT_SIZE];
        for (at, value) in [(0, MAGIC), (4, 2), (8, 32), (16, 0x8_0010), (20, 3)] {
            bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
        }
        let q = parse_rect(&bytes).unwrap();
        assert_eq!((q.query, q.hwnd, q.uid, q.guid), (2, 0x8_0010, 3, None));
        assert_eq!(rect_reply(1, 100, 1150, 120, 1170), Some(100 | (1150 << 16)));
        assert_eq!(rect_reply(2, 100, 1150, 120, 1170), Some(20 | (20 << 16)));
        assert_eq!(
            rect_reply(1, -1900, -20, 0, 0).map(|v| v as u16 as i16),
            Some(-1900)
        );
        assert_eq!(rect_reply(0, 0, 0, 1, 1), None);
    }
}
