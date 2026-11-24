# Wave 8 Specification — Deep Customization, Optimization & UI/Layout Polish

**Project**: Nectar Windows 11 Fork (`c:\среда\sandbox\Nectar`)
**Version**: `v1.10.0` (Custom Fork)
**Scope**: Complete Wave 8A–8D execution covering fork hardening, multi-window sync fixes, performance optimization (Rust backend + WebView2/React), deep customization controls, full Light Mode/Russian/layout polish across all 8 surfaces, automated + visual verification, independent reviews, and release packaging.

## Goals & Features

### 1. Foundation & Fork Hardening
- Disable upstream `kua8/Nectar` updater (`tauri.conf.json` + `updater.rs` fork guard + `AboutTab` fork badge) so upstream releases cannot overwrite this custom fork.
- Fix multi-window settings sync bugs (`useSettingsSync.ts`, `theme.ts` object serialization; `useSyncedSetting.ts` local echo suppression & debounce; `commands.rs::import_settings` single batch event with `null` tombstones; `settingsHydration.ts` deduplicated load promise).
- Split browser preview mock out of production WebView bundles (`tauriBridge.ts` -> dynamic `tauriPreviewMock.ts`).
- Add `settingKey?: string` (`data-setting-key`) to `SettingRow.tsx`.

### 2. Deep Customization
- **Theme Presets & Share (`themePresets.ts`, `AppearanceTab.tsx`, `commands.rs`)**:
  - Save / Apply / Delete up to 16 custom presets (`nectar-custom-presets`).
  - Export / Import standalone `.nectar-theme.json` files (`schema: "nectar-theme-v1"`) strictly enforcing the 17-key appearance whitelist so hotkeys, pins, weather, and CalDAV are never overwritten.
- **Visual, Surface, Motion & Typography (`theme.ts`, `surfaces.css`, `backdrop.ts`)**:
  - Glass Blur Intensity (`nectar-glass-blur`: `0..2`, quantized + 200ms debounced).
  - Border & Edge Glow Intensity (`nectar-edge-intensity`: `0..2`).
  - Corner Radius Scale (`nectar-radius-scale`: `0.6..1.35`, synced across CSS, Framer Motion, `SurfaceShape`, `NotchProgressBorder`).
  - UI Density (`nectar-ui-density`: `compact | comfortable | spacious`).
  - Animation Speed / Reduced Motion (`nectar-motion-speed`: `0 | 0.5 | 1 | 1.35`, `<NectarMotionProvider>` + `:root.reduced-motion`).
  - Interface Font (`nectar-font-family`: `system | clean | rounded | mono`).
  - Global Now Playing Album Art Accent (`nectar-theme-accent = "artwork"` via runtime `"media-accent-changed"` IPC event).
- **Surface-Specific Customization**:
  - **Notch**: Clock Font Style (`nectar-notch-clock-font`: `default|mono|rounded|bold`), Collapsed Idle Opacity (`nectar-notch-idle-opacity`: `0.45..1.0`).
  - **Dock & TrayBar**: Icon Size (`nectar-dock-icon-size`: `28..48` synced with Rust AppBar), Icon Spacing (`nectar-dock-icon-gap`: `6..18`), Hover Magnification (`nectar-dock-hover-scale`: `1.0..1.35`), Running Indicator extended with `pill` & `glow`, TrayBar Auto-Close (`nectar-traybar-autoclose`).
  - **Start Menu**: Pinned Tile Size (`nectar-start-tile-size`: `compact|normal|large`), Recommended Count (`nectar-start-rec-count`: `2|4|6`, default `4`).
  - **Launcher**: Width (`nectar-launcher-width`: `580|660|740`), Show Prefix Quick-Chips (`nectar-launcher-show-chips`).
  - **Overlays**: Vertical Position (`nectar-overlay-vpos`: `top|center|bottom`), Bar Thickness (`nectar-overlay-style`: `slim|default|wide`), Auto-Hide Delay (`nectar-overlay-timeout-ms`: `1000..5000`), Accent Fill (`nectar-overlay-accent-fill`), all synced with Rust overlay hit-box.

### 3. Optimization & Smart Game Mode
- **Performance Profile** (`nectar-perf-profile`: `balanced | eco | max`, unified migration from `nectar-ram-saver`) + WebView2 `SetMemoryUsageTargetLevel(LOW)` on hide (`webview_memory.rs`, `shell_windows.rs`, `Overlay.tsx`).
- **Smart Game / Fullscreen Mode** (`nectar-game-mode`, `nectar-game-mode-mute-agents`, `nectar-game-mode-pause-polls`): `GameModeHysteresis` (instant enter, 1500ms exit) driven strictly from Lively-filtered `current_is_fs`, pausing WASAPI FFT visualizer, WMI brightness polling, metrics polling, backdrop polling, marquees, and muting agent sounds.
- **Telemetry Refresh Rate** (`nectar-metrics-interval-ms`: `1000|3000|5000|10000`) + shared 800ms Rust `SystemMetrics` cache.
- **Background Preview Pre-Capture** (`nectar-preview-precapture`: default `false` = On Demand) + `Dock.tsx` preview-enabled guard.
- **Reclaim Memory Now** (`reclaim_memory_now` command) + fixed `memory_saver.rs` single-trim-per-idle-episode.
- Rust hotspots fixed: single-pass `EnumWindows`, cached Explorer `Shell_TrayWnd`, `MOUSE_DIRTY.swap(true)` hook guard, `Arc<MouseSettingsSnapshot>`, `id_object == 0 && id_child == 0` event guard, Hann LUT + throttled FFT, cached WinRT session properties, targeted `emit_to`, WIC `CopyPixels` direct PNG icon extraction + lazy `app_scan`, Lanczos3->Triangle + JPEG thumbnail, `launcher/app_index` metadata split, Cargo `lto = "thin"` + `codegen-units = 1`.
- Frontend hotspots fixed: `SurfaceShape.tsx` zero-re-render ref engine, `visibleInterval.ts` clear-while-hidden, throttled rect/opacity IPCs, Google Fonts `@import` removal, `framer-motion` removal from StartMenu/Launcher, minute-aligned clocks.

### 4. UI & Layout Polish
- Fix 5 clipping/geometry bugs (TrayBar 5th column & grid scroll, Dock `.rename-popup` 440px bug & right-edge submenu flip, StartMenu `.start-power-popover` hoisted out of `overflow: hidden` + jump grid, Launcher `.launcher-row-title` truncation & non-jumping toast footer, CompactMediaPlayer `.cmp-btn` tooltip clip).
- Complete Light Mode parity sweep across Notch Shelf, `BatteryIcon`, Dock (dots/preview/toast/desktop bar/frosted tile specificity), Overlay mixer bar, `DockTab` Start Icon Picker, Settings chips/pills/search badges, and Standalone Calendar.
- Russian localization & narrow-window hardening across all 8 windows + global `SettingRow` focus/divider/scrollbar hygiene.

## Verification Criteria
- `bunx tsc --noEmit` & `bun run build`: exit 0.
- `check_locales.ts`: 0 missing EN/RU/SearchIndex keys.
- `cargo check --all-targets` & `cargo test --bin nectar`: 0 warnings, all tests pass.
- Visual verification via headless Edge CDP on production build across Light & Dark modes, Russian localization, and edge cases.
- Independent `skeptic-reviewer` & `design-director` sign-off (`APPROVE`).
- NSIS installer, Portable ZIP, and GUI Setup rebuilt cleanly with `WebView2Loader.dll` and zero MinGW DLL dependencies.
