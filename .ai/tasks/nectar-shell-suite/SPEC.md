# Specification: Nectar Shell Suite (Launcher + Start Menu + Hidden Tray Bar)

**Project**: Fork of `kua8/Nectar` (`c:\среда\sandbox\Nectar`, branch `feat/launcher-start-traybar`)  
**Visual & Behavioral Standard**: 100% authentic Nectar design system (`SurfaceShape`, `surfaces.css`, `theme.ts`, `backdrop.ts`, 4 surface styles `solid`/`frosted`/`liquid`/`material`, 9 presets, accent sync, Framer Motion springs, flat `settings.json`).

---

## 1. Nectar Launcher (Flow Launcher / PowerToys Run / Wisp / Flux Launcher inspired)

### Triggers & Window Behavior
- Global hotkey (default `Alt+Space`, configurable via `nectar-launcher-hotkey`).
- Fullscreen suppression option (`nectar-launcher-fullscreen-suppress`, default `"true"`).
- Dock Search button (`nectar-dock-search-provider = "nectar"`, new default).
- Opens on the monitor containing the mouse cursor; position `"center"` or `"bottom"` (anchored cleanly above the Dock).
- Accepts full keyboard focus immediately on show; `Esc` (from main list) or outside click hides the window cleanly; `ArrowLeft`/`Esc` from Actions Drawer returns to search results.

### Query Modes & Search Engine
- **Applications**: enumerates installed apps (`INSTALLED_APPS_CACHE` + `FOLDERID_AppsFolder` UWP/Store + Win32), built-in Windows power tools (`cmd`, `wt`, `powershell`, `taskmgr`, `regedit`, `control`, `services.msc`, `devmgmt.msc`, `explorer`, `msconfig`, `perfmon`), and Windows Settings (`ms-settings:*`).
- **Fuzzy & Unicode Scoring**: supports Latin + Cyrillic matching, exact > prefix > acronym (`vsc` -> Visual Studio Code, `тг` -> Telegram) > substring > subsequence; operators `^prefix`, `suffix$`, `'exact`, `!exclude`; keyboard-layout cross-matching fallback (`сркщьу` -> `chrome`).
- **MRU / Frecency & Query History**: recently launched items rank higher and show on empty query (`nectar-launcher-show-recent`); `Ctrl+H` opens persistent query history (up to 32 deduplicated entries, atomic write).
- **Files (`? <query>` or fallback when query >= 2 chars)**: Everything IPC (`EVERYTHING_TASKBAR_NOTIFICATION` + `1.5a`, supports `ext:`, `folder:`, `file:`, `dm:` syntax) with graceful cancellable fallback across user folders (`Desktop`, `Documents`, `Downloads`, `Pictures`, `Music`, `Videos`).
- **Open Windows (`w <query>`)**: enumerates visible non-cloaked top-level windows; `Enter` restores and focuses window.
- **Calculator & Units (`= <expr>` or automatic math detection)**: safe recursive-descent evaluator supporting arithmetic, `^`, `%`, `sqrt`/`sin`/`cos`/`tan`/`log`/`ln`/`abs`/`round`/`floor`/`ceil`, constants (`pi`, `e`), hex/bin (`0xff`, `0b1010`), and unit conversions (`km`/`m`/`mi`/`ft`, `kg`/`g`/`lb`/`oz`, `c`/`f`/`k`, `gb`/`mb`/`kb`/`tb`). `Enter` or click copies result with confirmation pill.
- **Shell Commands (`> <cmd>`, `>> <ps>`)**: executes in Windows Terminal (`wt`) or `cmd.exe` / `powershell.exe`.
- **Web Search (`g `, `yt `, `gh `, `wiki `, or bottom fallback)**: opens configurable URL (`nectar-launcher-search-url`).
- **System Commands**: `wifi`, `bluetooth`, `vol <0-100>`, `mute`, `night light`, `dark mode`, `light mode`, `lock`, `sleep`, `hibernate`, `restart`, `shut down`, `empty recycle bin`, `nectar settings`, `nectar restart`, `quit nectar`. Destructive commands require inline second-`Enter` confirmation.
- **Actions Drawer (`ArrowRight` or `Ctrl+K`)**: Open, Run as Administrator, Open file location, Copy path, Pin/Unpin to Start, Pin/Unpin to Dock.

---

## 2. Nectar Start Menu (Windows Start Replacement)

### Triggers & Win-Key Hook
- Clicking the Dock Start icon when `nectar-start-custom-enabled != "false"`.
- Solo physical tap of `VK_LWIN` or `VK_RWIN` when `nectar-start-winkey-hook != "false"` (pure `WinTapTracker` tracks all held keys + mouse clicks; `Win+E`, `Win+R`, `Win+D`, `Win+Shift+S`, `Win+1..9` and all chords pass through unmodified without stuck modifiers).
- Positioned cleanly above the Dock on active monitor (`center` or `left` alignment via `nectar-start-align`).

### Features
- **Integrated Search Pill**: filters Start apps immediately; pressing `Tab` or shortcut hands the current query directly to Nectar Launcher.
- **Pinned Apps Grid**: 6-column rounded Nectar tiles, drag-and-drop reorderable (`@dnd-kit/sortable`), persisted in `start_pins.json`, seeded cleanly on first run; right-click menu (Open, Run as Admin, Open Location, Pin to Dock, Unpin from Start).
- **Recommended / Recent Section**: recent apps + real Windows Recent files (`%APPDATA%\Microsoft\Windows\Recent\*.lnk`), toggleable (`nectar-start-show-recommended`).
- **All Apps A–Z View**: alphabetically grouped (`#`, `A`–`Z`, `А`–`Я`) with clickable letter headers opening a frosted A–Z Jump Grid overlay; right-click context menu on every app.
- **Footer**: real Windows user display name + avatar, quick folders (`Explorer`, `Documents`, `Downloads`, `Pictures`, `Settings`), and confirmed **Power Popover** (`Lock`, `Sleep`, `Hibernate`, `Restart`, `Shut down`).

---

## 3. Nectar Hidden Tray Bar (Windows Tray Overflow Replacement)

### Win32 `Shell_TrayWnd` Proxy (`tray_host`)
- Runs an invisible top-level `Shell_TrayWnd` proxy window tagged with `NECTAR_TRAY_PROXY_PROP` ahead of Explorer's `Shell_TrayWnd` in Z-order.
- Intercepts `WM_COPYDATA` (`NIM_ADD`, `NIM_MODIFY`, `NIM_DELETE`, `NIM_SETVERSION`, `NIM_SETFOCUS`, `Shell_NotifyIconGetRect`), clones `HICON` into RAII `OwnedIcon` (`DestroyIcon` on drop), forwards every packet to `explorer_tray()` via `SendMessageTimeoutW`, and cleans up automatically on drop/exit/crash.
- Existing Nectar taskbar-hiding code (`services.rs`, `utils.rs`, `tray_icons.rs`) MUST use `explorer_tray()` and skip our proxy/PID so Nectar never hides its own tray host.
- Broadcasts `TaskbarCreated` on startup/manual refresh so already-running apps register their icons.
- Forwards real left/right/double/middle clicks + `AllowSetForegroundWindow(pid)` + `SetForegroundWindow(icon.hwnd)` honoring `NOTIFYICON_VERSION_4` and v0/v3 callbacks; hides TrayBar cleanly on right-click so apps' native context menus take focus naturally.

### UI & Dock Integration
- **TrayBar Window (`tray-bar`)**: expands smoothly above the Dock `^` chevron (or hotkey `nectar-traybar-hotkey`, default `Alt+Shift+T`), supports `bar` (horizontal pill) and `grid` (5-column matrix) layouts, shows real `HICON` + rich tooltip (`szTip`), has **Edit Pins** mode, **Refresh**, and a discreet **Windows native tray** escape button.
- **Dock Pinned Tray Pill**: selected icons (`nectar-tray-pinned-keys`) render right inside the Dock beside the `^` chevron with real icons, tooltips, and click forwarding.

---

## 4. Settings, Localization & Verification Gates
- Dedicated **Launcher** and **Start** tabs + updated **Dock** tab in Nectar Settings (`Settings.tsx`), registered in `searchIndex.ts`.
- Complete English (`en.json`) and Russian (`ru.json`) translations wired in `src/i18n.ts`.
- Verification after final edit:
  - `bun run build` passes with 0 errors.
  - `cargo test` passes all unit tests.
  - `cargo build --release` builds `nectar.exe` cleanly.
  - Live `browser` visual inspection across dark/light & surface styles with 0 console errors.
  - Native Windows smoke check verifying startup & clean Explorer taskbar restoration.
  - Independent `skeptic-reviewer`, `ui-critic`, and `spec-auditor` sign-off.
