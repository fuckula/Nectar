# Architectural Decisions: Nectar Shell Suite

1. **Architecture**: Integrated fork of `kua8/Nectar` (`Tauri v2` + `Rust` + `React 19` + `TypeScript` + `Framer Motion`), keeping 100% shared CSS custom properties, `theme.ts`, `backdrop.ts`, `SurfaceShape`, `surfaces.css`, and flat `settings.json`.
2. **Capabilities & IPC**: `src-tauri/capabilities/default.json` grants permissions to `"windows": ["*"]`. New window labels `"launcher"`, `"start-menu"`, and `"tray-bar"` inherit these automatically (verify explicitly during smoke test).
3. **Tray Proxy vs Taskbar Hider Invariant**:
   - Our proxy window carries property `NECTAR_TRAY_PROXY_PROP = "NectarTrayProxy"` and is owned by Nectar's PID.
   - `tray_host::explorer_tray()` finds the `Shell_TrayWnd` whose PID != current PID and without `NECTAR_TRAY_PROXY_PROP`.
   - `services.rs` (`taskbar_event_proc`, periodic re-hide, `register_dock_appbar`, `set_taskbar_visibility`) and `utils.rs` MUST target `explorer_tray()` instead of raw `FindWindowA("Shell_TrayWnd", ...)` so Nectar never hides or breaks its own proxy.
4. **Win-Key Interception Invariant**:
   - Never block or swallow `VK_LWIN`/`VK_RWIN` keydown.
   - `WinTapTracker` sets candidate only if Win goes down with zero other keys held, cancels on any other keydown or mouse down, and triggers ONLY on solo Win release.
   - On solo Win trigger, emit a harmless masked key (`VK__none_` / `0xFF` or `VK_LCONTROL` down+up with `NECTAR_INJECTED_EXTRA_INFO`) BEFORE letting Win keyup pass (or suppress Start cleanly) so Windows Start does not flash and zero modifier keys get stuck.
5. **Focus & Auto-Hide Rules**:
   - `"launcher"` and `"start-menu"` are created with `focused(true)` and `WS_EX_TOOLWINDOW` (no taskbar button). On `Focused(false)`, auto-hide after a 120ms focus-grace guard (preventing premature hide during show transition or internal menu state).
   - `"tray-bar"` auto-hides on `Focused(false)` AND immediately hides on `"right"` icon click before posting `WM_CONTEXTMENU`/`WM_RBUTTONUP` to `icon.hwnd` so the target app's native Win32 popup menu owns focus cleanly.
6. **Setting Keys (`settings.json`)**:
   - Launcher: `nectar-launcher-enabled` (`"true"`), `nectar-launcher-hotkey` (`"Alt+Space"`), `nectar-launcher-position` (`"center"` | `"bottom"`), `nectar-launcher-max-results` (`"8"`), `nectar-launcher-show-recent` (`"true"`), `nectar-launcher-file-search` (`"true"`), `nectar-launcher-everything` (`"true"`), `nectar-launcher-search-url` (`"https://www.google.com/search?q={query}"`), `nectar-launcher-fullscreen-suppress` (`"true"`), `nectar-dock-search-provider` (default `"nectar"`).
   - Start Menu: `nectar-start-custom-enabled` (`"true"`), `nectar-start-winkey-hook` (`"true"`), `nectar-start-align` (`"center"` | `"left"`), `nectar-start-show-recommended` (`"true"`), `nectar-start-columns` (`"6"`).
   - Tray Bar: `nectar-tray-bar-enabled` (`"true"`), `nectar-tray-bar-layout` (`"grid"` | `"bar"`), `nectar-traybar-hotkey` (`"Alt+Shift+T"`), `nectar-tray-pinned-keys` (JSON array of strings `[]`).
7. **Dual-Mode Browser Preview**:
   - `src/utils/tauriBridge.ts` delegates directly to `@tauri-apps/api/core` (`invoke`) and `@tauri-apps/api/event` (`listen`/`emit`) whenever `window.__TAURI_INTERNALS__` exists. Only in non-Tauri browser preview (Vite dev server visual inspection) does it return realistic mock data so `browser` subagent and `ui-critic` can render and test every screen visually.
8. **Build Toolchain (`x86_64-pc-windows-gnu` User-Space)**:
   - VS 2022 Build Tools UAC prompt cannot be elevated in non-admin sessions, and Cargo 1.100's new build-dir layout breaks `tauri-build 2.6.3` under GNU.
   - Standardized on **Rust `1.99.0-x86_64-pc-windows-gnu`** + **`BrechtSanders.WinLibs.POSIX.MSVCRT`** + `CARGO_TARGET_DIR=C:\Users\gog23\.nectar-target-199` + UTF-8→8.3 `windres.exe` shim in `C:\Users\gog23\.nectar-target\tools` (keeps workspace `Cargo.toml`/`Cargo.lock` untouched).
