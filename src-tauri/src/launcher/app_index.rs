//! Application, Windows power-tool, and Windows Settings index for Nectar Launcher & Start Menu.

use std::collections::HashSet;
use std::sync::atomic::Ordering;

use serde::Serialize;

use crate::state::{IS_SCANNING, INSTALLED_APPS_CACHE};
use crate::types::AppInfo;

#[derive(Debug, Clone, Serialize)]
pub struct IndexedEntry {
    pub id: String,
    pub name: String,
    pub subtitle: String,
    pub path: String,
    pub args: Option<String>,
    pub icon: Option<String>,
    pub keywords: String,
    pub is_running: bool,
    pub hwnd: Option<isize>,
    pub kind: String, // "app" | "settings" | "tool"
}

fn builtin_tools() -> &'static [(&'static str, &'static str, &'static str, &'static str, &'static str)] {
    &[
        ("tool:cmd", "Command Prompt", "cmd.exe — Classic Windows terminal", "cmd.exe", "terminal console shell cmd терминал консоль командная строка"),
        ("tool:wt", "Windows Terminal", "wt.exe — Modern multi-tab terminal", "wt.exe", "terminal shell pwsh bash терминал консоль"),
        ("tool:powershell", "Windows PowerShell", "powershell.exe — Automation shell", "powershell.exe", "powershell ps1 shell терминал консоль"),
        ("tool:taskmgr", "Task Manager", "taskmgr.exe — Processes & performance", "taskmgr.exe", "process monitor cpu ram диспетчер задач процессы"),
        ("tool:regedit", "Registry Editor", "regedit.exe — Windows Registry", "regedit.exe", "registry regedit реестр редактор реестра"),
        ("tool:control", "Control Panel", "control.exe — Classic system settings", "control.exe", "control panel system панель управления параметры настройки"),
        ("tool:services", "Services", "services.msc — Windows services manager", "services.msc", "services daemon службы сервисы"),
        ("tool:devmgmt", "Device Manager", "devmgmt.msc — Hardware & drivers", "devmgmt.msc", "devices hardware drivers диспетчер устройств драйверы"),
        ("tool:diskmgmt", "Disk Management", "diskmgmt.msc — Partitions & drives", "diskmgmt.msc", "disk partition drives управление дисками диски разделы"),
        ("tool:eventvwr", "Event Viewer", "eventvwr.msc — System & app logs", "eventvwr.msc", "logs events просмотр событий журнал"),
        ("tool:compmgmt", "Computer Management", "compmgmt.msc — System tools & storage", "compmgmt.msc", "computer management управление компьютером"),
        ("tool:resmon", "Resource Monitor", "resmon.exe — Live CPU, disk & network", "resmon.exe", "cpu ram disk network монитор ресурсов сеть"),
        ("tool:cleanmgr", "Disk Cleanup", "cleanmgr.exe — Free up drive space", "cleanmgr.exe", "cleanup temp disk очистка диска"),
        ("tool:dxdiag", "DirectX Diagnostics", "dxdiag.exe — GPU & system specs", "dxdiag.exe", "gpu directx hardware diagnostics система характеристики"),
        ("tool:appwiz", "Programs & Features", "appwiz.cpl — Classic app uninstaller", "appwiz.cpl", "uninstall programs удаление программ программы компоненты"),
        ("tool:ncpa", "Network Connections", "ncpa.cpl — Ethernet, Wi-Fi & VPN adapters", "ncpa.cpl", "network adapters ethernet vpn сетевые подключения адаптеры"),
        ("tool:sysdm", "System Properties", "sysdm.cpl — Computer name, ENV & performance", "sysdm.cpl", "environment variables system properties свойства системы переменные среды"),
        ("tool:powercfg", "Power Options", "powercfg.cpl — Classic power plans", "powercfg.cpl", "power plans sleep электропитание схема питания"),
        ("tool:mmsys", "Sound Control Panel", "mmsys.cpl — Playback & recording devices", "mmsys.cpl", "audio devices mic speakers устройства воспроизведения звук"),
        ("tool:explorer", "File Explorer", "explorer.exe — Browse files & folders", "explorer.exe", "files folders explorer проводник файлы папки"),
        ("tool:msconfig", "System Configuration", "msconfig.exe — Boot & startup options", "msconfig.exe", "boot startup msconfig конфигурация системы загрузка автозагрузка"),
        ("tool:perfmon", "Performance Monitor", "perfmon.exe — System counters", "perfmon.exe", "performance resource monitor монитор производительности"),
        ("tool:notepad", "Notepad", "notepad.exe — Plain text editor", "notepad.exe", "text notes editor блокнот заметки текст"),
        ("tool:calc", "Calculator", "calc.exe — Windows Calculator", "calc.exe", "math calculator калькулятор математика"),
        ("tool:snipping", "Snipping Tool", "ms-screenclip: — Screen capture", "ms-screenclip:", "screenshot snip screen capture ножницы скриншот снимок экрана"),
        ("tool:mspaint", "Paint", "mspaint.exe — Classic image editor", "mspaint.exe", "paint draw image рисование графика"),
        ("tool:charmap", "Character Map", "charmap.exe — Unicode glyphs & symbols", "charmap.exe", "symbols glyphs unicode таблица символов"),
    ]
}

fn windows_settings_pages() -> &'static [(&'static str, &'static str, &'static str, &'static str, &'static str)] {
    &[
        ("set:display", "Display Settings", "Windows Settings — Resolution, scale, HDR", "ms-settings:display", "screen monitor resolution refresh rate экран дисплей монитор разрешение параметры настройки"),
        ("set:sound", "Sound Settings", "Windows Settings — Output, input, mixer", "ms-settings:sound", "audio volume speakers microphone звук аудио громкость параметры"),
        ("set:network", "Network & Internet", "Windows Settings — Ethernet, Wi-Fi, VPN", "ms-settings:network", "network internet ethernet vpn сеть интернет подключения"),
        ("set:wifi", "Wi-Fi Settings", "Windows Settings — Wireless networks", "ms-settings:network-wifi", "wifi internet wireless network сеть вайфай интернет"),
        ("set:bluetooth", "Bluetooth & Devices", "Windows Settings — Pair & manage devices", "ms-settings:bluetooth", "bluetooth headphones mouse keyboard блютуз блутуз устройства"),
        ("set:colors", "Personalization Colors", "Windows Settings — Dark mode, accent color", "ms-settings:personalization-colors", "theme colors dark light accent персонализация цвета тема темная светлая"),
        ("set:apps", "Installed Apps", "Windows Settings — Manage & uninstall apps", "ms-settings:appsfeatures", "apps programs uninstall приложения программы удаление"),
        ("set:startup", "Startup Apps", "Windows Settings — Control apps launched at sign-in", "ms-settings:startupapps", "startup boot autostart автозагрузка программы запуска"),
        ("set:update", "Windows Update", "Windows Settings — Check for updates", "ms-settings:windowsupdate", "windows update patches обновление центр обновлений"),
        ("set:power", "Power & Battery", "Windows Settings — Sleep timer & power mode", "ms-settings:powersleep", "battery sleep power energy питание батарея сон"),
        ("set:nightlight", "Night Light Settings", "Windows Settings — Warm color temperature", "ms-settings:nightlight", "night light blue filter screen ночной свет экран"),
        ("set:privacy", "Privacy & Security", "Windows Settings — Permissions & Windows Security", "ms-settings:privacy", "privacy defender security permissions конфиденциальность безопасность"),
        ("set:defender", "Windows Security", "Windows Settings — Antivirus & firewall", "ms-settings:windowsdefender", "antivirus security defender firewall антивирус безопасность защитник брандмауэр"),
        ("set:defaultapps", "Default Apps", "Windows Settings — File & browser associations", "ms-settings:defaultapps", "default browser file types приложения по умолчанию браузер"),
        ("set:devices", "Connected Devices", "Windows Settings — Printers, USB, cameras", "ms-settings:devices", "printers usb webcam устройства принтеры камера"),
        ("set:mouse", "Mouse & Touchpad", "Windows Settings — Pointer speed & scroll", "ms-settings:mousetouchpad", "mouse touchpad cursor sensitivity мышь тачпад курсор"),
        ("set:keyboard", "Typing & Keyboard", "Windows Settings — Language & input", "ms-settings:keyboard", "keyboard typing layout клавиатура ввод раскладка"),
        ("set:notifications", "Notifications", "Windows Settings — System alerts & Focus", "ms-settings:notifications", "notifications alerts focus уведомления фокус"),
        ("set:accounts", "Accounts & Sign-in", "Windows Settings — Profile, PIN & passwords", "ms-settings:yourinfo", "account profile user pin password учетная запись аккаунт профиль"),
        ("set:datetime", "Date & Time", "Windows Settings — Time zone & sync", "ms-settings:dateandtime", "clock timezone time date дата время часы"),
        ("set:storage", "Storage Sense", "Windows Settings — Disk usage & cleanup", "ms-settings:storagesense", "disk space cleanup storage диск хранилище очистка"),
        ("set:about", "About This PC", "Windows Settings — Specs, Windows edition & device info", "ms-settings:about", "system info specs cpu ram edition о системе компьютер характеристики"),
    ]
}

fn normalize_path_key(path: &str, args: Option<&str>) -> String {
    match args {
        Some(a) if !a.trim().is_empty() => format!("{}|{}", path.to_lowercase(), a.trim().to_lowercase()),
        _ => path.to_lowercase(),
    }
}

/// Returns all known applications, Windows built-in tools, and Windows Settings pages
/// without blocking on slow disk extraction (kicks off async app scan if empty).
pub fn collect_entries() -> Vec<IndexedEntry> {
    let cache = INSTALLED_APPS_CACHE.get_or_init(|| std::sync::Mutex::new(Vec::new()));
    let cached_apps: Vec<AppInfo> = cache.lock().map(|g| g.clone()).unwrap_or_default();
    if cached_apps.is_empty() && !IS_SCANNING.load(Ordering::Relaxed) {
        crate::services::trigger_app_scan();
    }

    let mut out = Vec::with_capacity(cached_apps.len() + 32);
    let mut seen_keys = HashSet::new();

    for app in cached_apps {
        let norm = normalize_path_key(&app.path, app.args.as_deref());
        if !seen_keys.insert(norm.clone()) {
            continue;
        }
        let subtitle = app
            .executable
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| app.path.clone());
        let keywords = format!(
            "{} {}",
            app.executable.as_deref().unwrap_or(""),
            app.path
        );
        out.push(IndexedEntry {
            id: format!("app:{norm}"),
            name: app.name,
            subtitle,
            path: app.path,
            args: app.args,
            icon: app.icon,
            keywords,
            is_running: app.is_running,
            hwnd: app.hwnd,
            kind: "app".to_string(),
        });
    }

    for &(id, name, subtitle, path, keywords) in builtin_tools() {
        let norm = path.to_lowercase();
        if seen_keys.iter().any(|k| k == &norm || k.ends_with(&format!("\\{norm}"))) {
            continue;
        }
        seen_keys.insert(norm);
        out.push(IndexedEntry {
            id: id.to_string(),
            name: name.to_string(),
            subtitle: subtitle.to_string(),
            path: path.to_string(),
            args: None,
            icon: None,
            keywords: format!("{keywords} {path}"),
            is_running: false,
            hwnd: None,
            kind: "tool".to_string(),
        });
    }

    for &(id, name, subtitle, uri, keywords) in windows_settings_pages() {
        if !seen_keys.insert(uri.to_string()) {
            continue;
        }
        out.push(IndexedEntry {
            id: id.to_string(),
            name: name.to_string(),
            subtitle: subtitle.to_string(),
            path: uri.to_string(),
            args: None,
            icon: None,
            keywords: format!("{keywords} {uri}"),
            is_running: false,
            hwnd: None,
            kind: "settings".to_string(),
        });
    }

    out
}

/// Returns a raw AppInfo snapshot of installed apps + Start/Dock useful built-ins for Start Menu All Apps.
/// Waits briefly if the startup scan is currently in flight so first-open Start Menu and initial seeding are complete.
pub fn collect_installed_apps_for_start() -> Vec<AppInfo> {
    let cache = INSTALLED_APPS_CACHE.get_or_init(|| std::sync::Mutex::new(Vec::new()));
    let mut apps = cache.lock().map(|g| g.clone()).unwrap_or_default();
    if apps.is_empty() {
        if !IS_SCANNING.load(Ordering::Relaxed) {
            crate::services::trigger_app_scan();
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(3500);
        while IS_SCANNING.load(Ordering::Relaxed) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(45));
        }
        apps = cache.lock().map(|g| g.clone()).unwrap_or_default();
    }
    apps
}

#[cfg(test)]
mod tests {
    use super::{builtin_tools, windows_settings_pages};
    use crate::launcher::fuzzy;

    fn finds_id(query: &str, expected_id: &str) -> bool {
        builtin_tools()
            .iter()
            .chain(windows_settings_pages().iter())
            .any(|&(id, name, _, path, kw)| {
                id == expected_id
                    && fuzzy::match_candidate(query, name, Some(&format!("{kw} {path}"))).is_some()
            })
    }

    #[test]
    fn russian_keywords_match_tools_and_settings() {
        assert!(finds_id("диспетчер задач", "tool:taskmgr"));
        assert!(finds_id("проводник", "tool:explorer"));
        assert!(finds_id("калькулятор", "tool:calc"));
        assert!(finds_id("блокнот", "tool:notepad"));
        assert!(finds_id("терминал", "tool:wt"));
        assert!(finds_id("настройки", "tool:control"));
        assert!(finds_id("параметры", "set:display"));
        assert!(finds_id("звук", "set:sound"));
        assert!(finds_id("экран", "set:display"));
        assert!(finds_id("сеть", "set:wifi"));
        assert!(finds_id("блютуз", "set:bluetooth"));
        assert!(finds_id("обновление", "set:update"));
        assert!(finds_id("приложения", "set:apps"));
        assert!(finds_id("сон", "set:power"));
    }
}
