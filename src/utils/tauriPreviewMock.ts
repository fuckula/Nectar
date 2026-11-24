import type { UnlistenFn } from "@tauri-apps/api/event";
import type { LauncherItem, LauncherSearchResponse, HistoryEntry } from "../launcher/types";
import type { StartPinItem, RecommendedItem, StartUserProfile } from "../start/types";
import type { AppInfo } from "../types/shell";
import type { TrayIconDto } from "../traybar/types";
import { clearSettingsPreservingOnboarding } from "./settingsHydration";

const PREVIEW_SVG_APP = (bg: string, letter: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="${bg}"/><text x="24" y="30" text-anchor="middle" fill="#fff" font-family="Segoe UI,sans-serif" font-size="20" font-weight="700">${letter}</text></svg>`
  )}`;

const MOCK_APPS: AppInfo[] = [
  { name: "Visual Studio Code", path: "C:\\Program Files\\Microsoft VS Code\\Code.exe", icon: PREVIEW_SVG_APP("#007acc", "C"), is_running: true, hwnd: 101, executable: "Code.exe" },
  { name: "Windows Terminal", path: "wt.exe", icon: PREVIEW_SVG_APP("#22272e", ">_"), is_running: true, hwnd: 102, executable: "wt.exe" },
  { name: "File Explorer", path: "C:\\Windows\\explorer.exe", icon: PREVIEW_SVG_APP("#d99b26", "E"), is_running: true, hwnd: 103, executable: "explorer.exe" },
  { name: "Microsoft Edge", path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", icon: PREVIEW_SVG_APP("#0f80d8", "e"), is_running: false, hwnd: null, executable: "msedge.exe" },
  { name: "Spotify", path: "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify", icon: PREVIEW_SVG_APP("#1db954", "S"), is_running: false, hwnd: null, executable: "Spotify.exe" },
  { name: "Telegram Desktop", path: "C:\\Users\\Demo\\AppData\\Roaming\\Telegram Desktop\\Telegram.exe", icon: PREVIEW_SVG_APP("#2aabee", "T"), is_running: true, hwnd: 104, executable: "Telegram.exe" },
  { name: "Notepad", path: "notepad.exe", icon: PREVIEW_SVG_APP("#4a8fd4", "N"), is_running: false, hwnd: null, executable: "notepad.exe" },
  { name: "Task Manager", path: "taskmgr.exe", icon: PREVIEW_SVG_APP("#2d6cdf", "M"), is_running: false, hwnd: null, executable: "taskmgr.exe" },
  { name: "Blender 5.2", path: "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe", icon: PREVIEW_SVG_APP("#ea7600", "B"), is_running: false, hwnd: null, executable: "blender.exe" },
  { name: "Figma", path: "C:\\Users\\Demo\\AppData\\Local\\Figma\\Figma.exe", icon: PREVIEW_SVG_APP("#a259ff", "F"), is_running: false, hwnd: null, executable: "Figma.exe" },
  { name: "Архиватор 7-Zip", path: "C:\\Program Files\\7-Zip\\7zFM.exe", icon: PREVIEW_SVG_APP("#2d3138", "7z"), is_running: false, hwnd: null, executable: "7zFM.exe" },
  { name: "Яндекс Браузер", path: "C:\\Program Files\\Yandex\\YandexBrowser\\browser.exe", icon: PREVIEW_SVG_APP("#fc3f1d", "Я"), is_running: false, hwnd: null, executable: "browser.exe" },
];

let previewPins: StartPinItem[] = MOCK_APPS.slice(0, 8).map((a) => ({
  name: a.name,
  path: a.path,
  executable: a.executable,
  icon: a.icon,
}));

const MOCK_RECOMMENDED: RecommendedItem[] = [
  { id: "rec:1", kind: "app", title: "Visual Studio Code", subtitle: "Frequently opened", path: MOCK_APPS[0].path, icon: MOCK_APPS[0].icon, timestamp_ms: Date.now() - 120000 },
  { id: "rec:2", kind: "file", title: "SPEC.md", subtitle: "nectar-shell-suite", path: "C:\\Work\\SPEC.md", icon: null, timestamp_ms: Date.now() - 300000 },
  { id: "rec:3", kind: "file", title: "Quarterly-Budget.xlsx", subtitle: "Documents", path: "C:\\Users\\Demo\\Documents\\Quarterly-Budget.xlsx", icon: null, timestamp_ms: Date.now() - 900000 },
  { id: "rec:4", kind: "app", title: "Windows Terminal", subtitle: "Frequently opened", path: "wt.exe", icon: MOCK_APPS[1].icon, timestamp_ms: Date.now() - 1800000 },
];

const MOCK_TRAY_ICONS: TrayIconDto[] = [
  { key: "tray:steam", title: "Steam Client", exe_name: "steam.exe", exe_path: "C:\\Program Files (x86)\\Steam\\steam.exe", pid: 2101, icon: PREVIEW_SVG_APP("#1b2838", "St"), revision: 1, promoted: false, hidden_by_app: false, order: 1 },
  { key: "tray:discord", title: "Discord", exe_name: "Discord.exe", exe_path: "C:\\Users\\Demo\\AppData\\Local\\Discord\\Discord.exe", pid: 2102, icon: PREVIEW_SVG_APP("#5865f2", "D"), revision: 1, promoted: true, hidden_by_app: false, order: 2 },
  { key: "tray:nvidia", title: "NVIDIA Settings", exe_name: "nvcontainer.exe", exe_path: "C:\\Program Files\\NVIDIA\\nvcontainer.exe", pid: 2103, icon: PREVIEW_SVG_APP("#76b900", "Nv"), revision: 1, promoted: false, hidden_by_app: false, order: 3 },
  { key: "tray:obs", title: "OBS Studio — Recording Ready", exe_name: "obs64.exe", exe_path: "C:\\Program Files\\obs-studio\\obs64.exe", pid: 2104, icon: PREVIEW_SVG_APP("#302e31", "O"), revision: 1, promoted: false, hidden_by_app: false, order: 4 },
  { key: "tray:telegram", title: "Telegram Desktop (2 unread)", exe_name: "Telegram.exe", exe_path: "C:\\Users\\Demo\\Telegram.exe", pid: 2105, icon: PREVIEW_SVG_APP("#2aabee", "T"), revision: 1, promoted: false, hidden_by_app: false, order: 5 },
  { key: "tray:defender", title: "Windows Security — Actions recommended", exe_name: "SecurityHealthSystray.exe", exe_path: "C:\\Windows\\System32\\SecurityHealthSystray.exe", pid: 2106, icon: PREVIEW_SVG_APP("#1274d3", "S"), revision: 1, promoted: false, hidden_by_app: false, order: 6 },
  { key: "tray:bluetooth", title: "Bluetooth Devices", exe_name: "fsquirt.exe", exe_path: "C:\\Windows\\System32\\fsquirt.exe", pid: 2107, icon: PREVIEW_SVG_APP("#2563eb", "Bt"), revision: 1, promoted: false, hidden_by_app: false, order: 7 },
  { key: "tray:v2ray", title: "v2rayN", exe_name: "v2rayN.exe", exe_path: "C:\\Tools\\v2rayN\\v2rayN.exe", pid: 2108, icon: PREVIEW_SVG_APP("#18181b", "V2"), revision: 1, promoted: false, hidden_by_app: false, order: 8 },
  { key: "tray:amd", title: "AMD Software: Adrenalin Edition", exe_name: "RadeonSoftware.exe", exe_path: "C:\\Program Files\\AMD\\RadeonSoftware.exe", pid: 2109, icon: PREVIEW_SVG_APP("#c81e1e", "A"), revision: 1, promoted: false, hidden_by_app: false, order: 9 },
  { key: "tray:vscode", title: "Visual Studio Code", exe_name: "Code.exe", exe_path: "C:\\Program Files\\Microsoft VS Code\\Code.exe", pid: 2110, icon: PREVIEW_SVG_APP("#007acc", "C"), revision: 1, promoted: false, hidden_by_app: false, order: 10 },
  { key: "tray:sharex", title: "ShareX", exe_name: "ShareX.exe", exe_path: "C:\\Program Files\\ShareX\\ShareX.exe", pid: 2111, icon: PREVIEW_SVG_APP("#0ea5e9", "Sx"), revision: 1, promoted: false, hidden_by_app: false, order: 11 },
  { key: "tray:eartrumpet", title: "EarTrumpet", exe_name: "EarTrumpet.exe", exe_path: "C:\\Program Files\\EarTrumpet\\EarTrumpet.exe", pid: 2112, icon: PREVIEW_SVG_APP("#7c3aed", "Et"), revision: 1, promoted: false, hidden_by_app: false, order: 12 },
  { key: "tray:usb", title: "Safely Remove Hardware", exe_name: "rundll32.exe", exe_path: "C:\\Windows\\System32\\rundll32.exe", pid: 2113, icon: PREVIEW_SVG_APP("#475569", "U"), revision: 1, promoted: false, hidden_by_app: false, order: 13 },
];

const MOCK_HISTORY: HistoryEntry[] = [
  { query: "vscode", item_title: "Visual Studio Code", item_id: "app:vscode", kind: "app", target: MOCK_APPS[0].path, timestamp_ms: Date.now() - 60000 },
  { query: "= 128 * 4", item_title: "= 512", item_id: "calc:128*4", kind: "calc", target: "512", timestamp_ms: Date.now() - 240000 },
  { query: "dark mode", item_title: "Enable Dark Mode", item_id: "sys:dark_mode", kind: "system", target: "sys:dark_mode", timestamp_ms: Date.now() - 500000 },
];

const RU_TRANSLIT: Record<string, string> = {
  "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh",
  "з": "z", "и": "i", "й": "i", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o",
  "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "c",
  "ч": "ch", "ш": "sh", "щ": "sch", "ы": "y", "э": "e", "ю": "yu", "я": "ya",
};

function previewFuzzyIndices(query: string, candidate: string): number[] | null {
  if (!query) return [];
  const normQ = Array.from(query.toLowerCase())
    .map((ch) => RU_TRANSLIT[ch] ?? ch)
    .join("");
  const lc = candidate.toLowerCase();
  const directIdx = lc.indexOf(normQ);
  if (directIdx >= 0) {
    return Array.from({ length: normQ.length }, (_, i) => directIdx + i);
  }
  const matched: number[] = [];
  let qi = 0;
  const chars = Array.from(lc);
  for (let ti = 0; ti < chars.length && qi < normQ.length; ti++) {
    if (chars[ti] === normQ[qi]) {
      matched.push(ti);
      qi++;
    }
  }
  return qi === normQ.length ? matched : null;
}

function previewEvalMath(raw: string): { expr: string; formatted: string } | null {
  const expr = raw.replace(/^=/, "").trim();
  if (!expr) return null;
  if (/^[0-9+\-*/().\s]+$/.test(expr)) {
    try {
      const val = Function(`"use strict"; return (${expr});`)();
      if (typeof val === "number" && Number.isFinite(val)) {
        return { expr, formatted: Number.isInteger(val) ? String(val) : val.toFixed(4).replace(/\.?0+$/, "") };
      }
    } catch {
      return null;
    }
  }
  return null;
}

function previewLauncherSearch(query: string): LauncherSearchResponse {
  const q = query.trim();
  const qLower = q.toLowerCase();

  if (q.startsWith("=")) {
    const math = previewEvalMath(q);
    return {
      mode: "calc",
      clean_query: q.slice(1).trim(),
      everything_available: true,
      calc_card: math ? { expression: math.expr, formatted: math.formatted, raw: math.formatted, note: "Calculator — Enter copies result" } : null,
      items: math
        ? [{
            id: `calc:${math.expr}`,
            kind: "calc",
            title: `= ${math.formatted}`,
            subtitle: `${math.expr} — Calculator — Enter copies result`,
            badge: "Calculator",
            icon: null,
            target: math.formatted,
            args: null,
            hwnd: null,
            score: 10000,
            match_indices: [],
            requires_confirm: false,
            actions: [{ id: "copy_path", label: "Copy result", shortcut: "Enter", destructive: false }],
          }]
        : [],
    };
  }

  const mathAuto = previewEvalMath(q);
  const actions: LauncherItem["actions"] = [
    { id: "open", label: "Open", shortcut: "Enter", destructive: false },
    { id: "run_as_admin", label: "Run as Administrator", shortcut: "Ctrl+Shift+Enter", destructive: false },
    { id: "open_location", label: "Open file location", shortcut: "Ctrl+O", destructive: false },
    { id: "properties", label: "Properties", shortcut: "Ctrl+P", destructive: false },
    { id: "copy_path", label: "Copy path", shortcut: "Ctrl+C", destructive: false },
    { id: "toggle_pin_start", label: "Pin / Unpin to Start", shortcut: null, destructive: false },
    { id: "toggle_pin_dock", label: "Pin / Unpin to Dock", shortcut: null, destructive: false },
  ];

  const mode = qLower.startsWith("? ")
    ? "files"
    : qLower.startsWith("w ")
      ? "windows"
      : qLower.startsWith(">")
        ? "shell"
        : "all";

  const clean = q.replace(/^(?:\?|>>|>|w|g|yt|gh|wiki)\s*/i, "").trim().toLowerCase();
  const appItems: LauncherItem[] = [];
  MOCK_APPS.forEach((a, idx) => {
    const idxs = previewFuzzyIndices(clean, a.name);
    if (idxs === null) return;
    appItems.push({
      id: `app:${a.path}`,
      kind: mode === "windows" ? "window" : "app",
      title: a.name,
      subtitle: a.executable || a.path,
      badge: mode === "windows" ? "Window" : a.is_running ? "Running" : q ? "App" : "Recent",
      icon: a.icon ?? null,
      target: a.path,
      args: a.args ?? null,
      hwnd: a.hwnd ?? null,
      score: 9000 - idx * 50,
      match_indices: idxs,
      requires_confirm: false,
      actions,
    });
  });

  if (q && "restart pc shut down empty recycle bin".includes(clean)) {
    appItems.push({
      id: "sys:restart",
      kind: "system",
      title: "Restart PC",
      subtitle: "Reboot Windows immediately",
      badge: "System",
      icon: null,
      target: "sys:restart",
      args: null,
      hwnd: null,
      score: 5000,
      match_indices: [],
      requires_confirm: true,
      actions: [{ id: "open", label: "Run command", shortcut: "Enter", destructive: true }],
    });
  }

  return {
    mode: mathAuto ? "calc" : mode,
    clean_query: q,
    everything_available: true,
    calc_card: mathAuto
      ? { expression: mathAuto.expr, formatted: mathAuto.formatted, raw: mathAuto.formatted, note: "Calculator — Enter copies result" }
      : null,
    items: appItems.slice(0, 8),
  };
}

function loadPreviewSettings(): Record<string, unknown> {
  const defaults: Record<string, unknown> = {
    "nectar-launcher-enabled": "true",
    "nectar-launcher-hotkey": "Alt+Space",
    "nectar-launcher-position": "center",
    "nectar-launcher-max-results": "8",
    "nectar-launcher-show-recent": "true",
    "nectar-launcher-everything": "true",
    "nectar-launcher-search-url": "https://www.google.com/search?q={query}",
    "nectar-launcher-fullscreen-suppress": "true",
    "nectar-start-custom-enabled": "true",
    "nectar-start-winkey-hook": "true",
    "nectar-start-align": "center",
    "nectar-start-show-recommended": "true",
    "nectar-start-columns": "6",
    "nectar-dock-search-provider": "nectar",
    "nectar-tray-bar-enabled": "true",
    "nectar-tray-bar-layout": "grid",
    "nectar-traybar-hotkey": "Alt+Shift+T",
    "nectar-tray-pinned-keys": "[]",
    "nectar-tray-order": "[]",
    "nectar-tray-hidden-keys": "[]",
    "nectar-tray-labels": "{}",
  };
  if (typeof localStorage !== "undefined") {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("nectar-")) {
        defaults[k] = localStorage.getItem(k);
      }
    }
  }
  return defaults;
}

let previewSelectionColor: string | null = "#0a84ff";
let previewSelectionBackup = false;
let previewCustomIcons: Record<string, string> = {};
const previewTopmostHwnds = new Set<number>();
let previewWinIconBackup: {
  hasBackup: boolean;
  foldersCount: number;
  shortcutsCount: number;
  appliedMode: string | null;
  appliedColor: string | null;
} = {
  hasBackup: false,
  foldersCount: 0,
  shortcutsCount: 0,
  appliedMode: null,
  appliedColor: null,
};

const MOCK_WALLPAPER_PALETTE = {
  dominant: "#231023",
  accent: "#ff6b95",
  surfaceDark: "#1a0d1b",
  surfaceLight: "#f6eef3",
  secondary: "#38bdf8",
  swatches: ["#ff6b95", "#38bdf8", "#c77dff", "#ff9e64", "#231023"],
  isDark: true,
  source: "Nectar-Abstract-Wave.png",
};

const MOCK_EXPLORER_JUMP_LIST = [
  { id: "desktop", path: "C:\\Users\\Demo\\Desktop", kind: "desktop" },
  { id: "downloads", path: "C:\\Users\\Demo\\Downloads", kind: "downloads" },
  { id: "documents", path: "C:\\Users\\Demo\\Documents", kind: "documents" },
  { id: "pictures", path: "C:\\Users\\Demo\\Pictures", kind: "pictures" },
  { id: "music", path: "C:\\Users\\Demo\\Music", kind: "music" },
  { id: "videos", path: "C:\\Users\\Demo\\Videos", kind: "videos" },
  { id: "home", path: "C:\\Users\\Demo", kind: "home" },
];

export async function previewInvoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  switch (cmd) {
    case "search_launcher":
      return previewLauncherSearch(String(args?.query ?? "")) as T;
    case "take_pending_launcher_query":
      return null as T;
    case "get_launcher_history":
      return MOCK_HISTORY as T;
    case "clear_launcher_history":
    case "open_launcher":
    case "hide_launcher":
    case "hide_start_menu":
    case "hide_traybar":
    case "set_traybar_blur_lock":
    case "resize_shell_window":
    case "resize_settings_window":
    case "on_demand_window_ready":
    case "refresh_tray_icons":
    case "open_native_tray":
    case "open_tray_from_button":
    case "open_start_folder":
    case "execute_power_action":
    case "interact_tray_icon":
    case "launch_app_as_admin":
    case "open_app_location":
    case "open_app_properties":
    case "window_action":
    case "open_windows_tool":
    case "empty_recycle_bin":
    case "set_autostart":
    case "copy_text_to_clipboard":
      if (cmd === "copy_text_to_clipboard" && typeof navigator !== "undefined" && navigator.clipboard) {
        navigator.clipboard.writeText(String(args?.text ?? "")).catch(() => {});
      }
      return undefined as T;
    case "execute_launcher_item": {
      const item = args?.item as { requires_confirm?: boolean } | undefined;
      if (item?.requires_confirm && !args?.confirmed) {
        throw new Error("Confirmation required before running this command");
      }
      return undefined as T;
    }
    case "execute_launcher_action": {
      const item = args?.item as { requires_confirm?: boolean } | undefined;
      if (args?.actionId === "open" && item?.requires_confirm && !args?.confirmed) {
        throw new Error("Confirmation required before running this command");
      }
      return "Done (Preview)" as T;
    }
    case "get_app_icon":
      return (MOCK_APPS.find((a) => a.path === args?.path)?.icon ?? null) as T;
    case "get_start_pins":
      return previewPins as T;
    case "save_start_pins":
      previewPins = (args?.pins as StartPinItem[]) || previewPins;
      return undefined as T;
    case "unpin_from_start":
      previewPins = previewPins.filter((p) => p.path !== args?.path);
      return previewPins as T;
    case "pin_to_start": {
      const item = args?.item as StartPinItem;
      if (item && !previewPins.some((p) => p.path === item.path)) {
        previewPins = [...previewPins, item];
      }
      return previewPins as T;
    }
    case "get_start_all_apps":
      return MOCK_APPS as T;
    case "get_start_recommended":
      return MOCK_RECOMMENDED as T;
    case "get_start_user_profile":
      return {
        display_name: "Nectar Preview",
        avatar: null,
        folders: [
          { id: "explorer", label: "Explorer", path: "C:\\Windows\\explorer.exe" },
          { id: "documents", label: "Documents", path: "C:\\Users\\Demo\\Documents" },
          { id: "downloads", label: "Downloads", path: "C:\\Users\\Demo\\Downloads" },
          { id: "pictures", label: "Pictures", path: "C:\\Users\\Demo\\Pictures" },
          { id: "settings", label: "Settings", path: "ms-settings:" },
        ],
      } satisfies StartUserProfile as T;
    case "get_tray_icons":
      return MOCK_TRAY_ICONS as T;
    case "get_custom_icons":
      return { ...previewCustomIcons } as T;
    case "set_custom_icon": {
      const ck = String(args?.cacheKey ?? "");
      const data = String(args?.iconData ?? "");
      if (ck && data) {
        previewCustomIcons = { ...previewCustomIcons, [ck]: data };
        void previewEmit("custom-icons-updated");
      }
      return data as T;
    }
    case "remove_custom_icon": {
      const p = String(args?.path ?? "");
      if (p) {
        const next = { ...previewCustomIcons };
        delete next[p];
        previewCustomIcons = next;
        void previewEmit("custom-icons-updated");
      }
      return undefined as T;
    }
    case "load_settings":
      return loadPreviewSettings() as T;
    case "save_setting": {
      const k = String(args?.key ?? "");
      const v = args?.value;
      if (k && typeof localStorage !== "undefined") {
        if (v === null || v === undefined) {
          localStorage.removeItem(k);
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("nectar-preview-setting", { detail: { key: k, value: null } }));
          }
        } else {
          const str = typeof v === "string" ? v : JSON.stringify(v);
          localStorage.setItem(k, str);
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("nectar-preview-setting", { detail: { key: k, value: str } }));
          }
        }
      }
      return undefined as T;
    }
    case "save_settings_batch": {
      const entries = (args?.entries ?? {}) as Record<string, unknown>;
      const normalized: Record<string, string | null> = {};
      if (typeof localStorage !== "undefined") {
        for (const [k, v] of Object.entries(entries)) {
          if (!k) continue;
          if (v === null || v === undefined) {
            localStorage.removeItem(k);
            normalized[k] = null;
          } else {
            const str = typeof v === "string" ? v : JSON.stringify(v);
            localStorage.setItem(k, str);
            normalized[k] = str;
          }
        }
      }
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("nectar-preview-settings-batch", { detail: { entries: normalized } })
        );
      }
      return undefined as T;
    }
    case "load_pinned_apps":
      return MOCK_APPS.slice(0, 4) as T;
    case "save_pinned_apps":
      return undefined as T;
    case "has_battery":
      return true as T;
    case "get_monitors":
      return [{ id: "primary", name: "Primary Display", label: "Primary Display", x: 0, y: 0, width: 1920, height: 1080, is_primary: true }] as T;
    case "get_drives":
      return [{ letter: "C:", label: "Windows" }] as T;
    case "get_autostart":
    case "windows_accent_backup_exists":
      return false as T;
    case "get_system_accent_color":
      return "#0078d4" as T;
    case "get_windows_selection_color":
      return previewSelectionColor as T;
    case "sync_windows_selection_color":
      previewSelectionColor = typeof args?.hex === "string" ? args.hex : previewSelectionColor;
      previewSelectionBackup = true;
      return undefined as T;
    case "restore_windows_selection_color":
      previewSelectionBackup = false;
      previewSelectionColor = "#0a84ff";
      return undefined as T;
    case "windows_selection_backup_exists":
      return previewSelectionBackup as T;
    case "get_runtime_state":
      return {
        game_mode_active: false,
        media_accent: null,
        updater_disabled: true,
        perf_profile: localStorage.getItem("nectar-perf-profile") || "balanced",
      } as T;
    case "broadcast_media_accent":
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("nectar-preview:media-accent-changed", {
            detail: typeof args?.hex === "string" ? args.hex : null,
          })
        );
      }
      return undefined as T;
    case "set_window_low_memory":
      return undefined as T;
    case "reclaim_memory_now":
      return 3 as T;
    case "export_theme_dialog":
    case "export_settings_dialog":
      return true as T;
    case "import_theme_dialog":
    case "ics_detect":
      return null as T;
    case "import_settings_dialog":
      return false as T;
    case "restart_explorer_for_theme":
    case "sync_windows_accent":
    case "restore_windows_accent":
    case "open_calendar_window":
    case "set_hotkeys_paused":
    case "restart_nectar":
    case "quit_nectar":
      return undefined as T;
    case "reset_settings":
      try {
        clearSettingsPreservingOnboarding();
      } catch {
        // Ignore restricted storage errors
      }
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("nectar-preview:settings-reset", { detail: undefined }));
      }
      return undefined as T;
    case "get_tray_host_status":
      return "active" as T;
    case "get_hotkey_status":
      return {} as T;
    case "extract_wallpaper_palette":
      return {
        ...MOCK_WALLPAPER_PALETTE,
        swatches: [...MOCK_WALLPAPER_PALETTE.swatches],
      } as T;
    case "apply_windows_icon_tint": {
      const opts = (args?.options ?? {}) as {
        mode?: string;
        colorHex?: string;
        applyFolders?: boolean;
        applyDesktopShortcuts?: boolean;
      };
      const mode = String(opts.mode ?? "original").toLowerCase();
      if (mode === "original" || mode === "none") {
        previewWinIconBackup = {
          hasBackup: false,
          foldersCount: 0,
          shortcutsCount: 0,
          appliedMode: null,
          appliedColor: null,
        };
        return { foldersUpdated: 0, shortcutsUpdated: 0, skipped: 0, errors: [] } as T;
      }
      const foldersUpdated = opts.applyFolders === false ? 0 : 6;
      const shortcutsUpdated = opts.applyDesktopShortcuts === false ? 0 : 4;
      previewWinIconBackup = {
        hasBackup: foldersUpdated > 0 || shortcutsUpdated > 0,
        foldersCount: foldersUpdated,
        shortcutsCount: shortcutsUpdated,
        appliedMode: mode,
        appliedColor: opts.colorHex ?? "#ff6b95",
      };
      return { foldersUpdated, shortcutsUpdated, skipped: 0, errors: [] } as T;
    }
    case "restore_windows_icons": {
      const prevFolders = previewWinIconBackup.foldersCount;
      const prevShortcuts = previewWinIconBackup.shortcutsCount;
      previewWinIconBackup = {
        hasBackup: false,
        foldersCount: 0,
        shortcutsCount: 0,
        appliedMode: null,
        appliedColor: null,
      };
      return {
        foldersUpdated: prevFolders,
        shortcutsUpdated: prevShortcuts,
        skipped: 0,
        errors: [],
      } as T;
    }
    case "windows_icons_backup_status":
      return { ...previewWinIconBackup } as T;
    case "get_window_topmost": {
      const hwnd = Number(args?.hwnd);
      return (Number.isFinite(hwnd) && previewTopmostHwnds.has(hwnd)) as T;
    }
    case "get_window_state": {
      const hwnd = Number(args?.hwnd);
      return {
        minimized: false,
        maximized: false,
        topmost: Number.isFinite(hwnd) && previewTopmostHwnds.has(hwnd),
      } as T;
    }
    case "toggle_window_topmost": {
      const hwnd = Number(args?.hwnd);
      if (!Number.isFinite(hwnd) || hwnd === 0) {
        throw new Error("invalid_window");
      }
      if (previewTopmostHwnds.has(hwnd)) {
        previewTopmostHwnds.delete(hwnd);
        return false as T;
      }
      previewTopmostHwnds.add(hwnd);
      return true as T;
    }
    case "get_explorer_jump_list":
      return MOCK_EXPLORER_JUMP_LIST.map((item) => ({ ...item })) as T;
    case "caldav_get_cache":
      return {
        connected: false,
        syncedAt: null,
        account: null,
        links: [],
        calendars: [],
        events: [],
      } as T;
    case "check_for_updates":
      return { available: false } as T;
    case "get_diagnostics":
      return "Nectar Preview Diagnostics OK" as T;
    default:
      return null as T;
  }
}

export function previewListen<T = unknown>(
  event: string,
  handler: (payload: T) => void
): Promise<UnlistenFn> {
  if (typeof window === "undefined") {
    return Promise.resolve(() => {});
  }
  if (event === "settings-changed") {
    const fn = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      handler(detail as T);
    };
    window.addEventListener("nectar-preview-setting", fn);
    return Promise.resolve(() => window.removeEventListener("nectar-preview-setting", fn));
  }
  if (event === "settings-batch-changed") {
    const fn = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      handler(detail as T);
    };
    window.addEventListener("nectar-preview-settings-batch", fn);
    return Promise.resolve(() => window.removeEventListener("nectar-preview-settings-batch", fn));
  }
  const customEvent = `nectar-preview:${event}`;
  const fn = (e: Event) => {
    handler((e as CustomEvent).detail as T);
  };
  window.addEventListener(customEvent, fn);
  return Promise.resolve(() => window.removeEventListener(customEvent, fn));
}

export function previewEmit(event: string, payload?: unknown): Promise<void> {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(`nectar-preview:${event}`, { detail: payload }));
  }
  return Promise.resolve();
}
