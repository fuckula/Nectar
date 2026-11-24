# Wave 8 Architectural Decisions & Locked Invariants

1. **Wave 7 Win-Key Invariant**:
   - `app_device_event_filter()` (`DeviceEventFilter::Always`), `WH_KEYBOARD_LL` Win-key handling, and `shell_windows.rs` / `utils.rs` focus-restore/UIA paths MUST NOT be altered.

2. **Eco Mode Memory Safety**:
   - Shell surfaces (`start-menu`, `launcher`, `tray-bar`) and `overlay` use ONLY `ICoreWebView2_19::SetMemoryUsageTargetLevel(LOW)` + `memory_saver::trim_soon()` when hidden, restored to `NORMAL` on show.
   - `TrySuspend()` is NEVER called on shell surfaces or overlay, and prewarmed `start-menu`/`launcher` WebViews are NEVER destroyed (except skipping startup prewarm when already booted in `Eco` profile, still creating cleanly on demand).

3. **Single-Surface Compositing & Anti-Drift**:
   - Opacity (`nectar-theme-opacity`), saturation (`nectar-theme-saturation`), and brightness (`nectar-theme-brightness`) remain the sole controls for surface fill darkness.
   - `.start-surface`, `.launcher-surface`, `.dock-pill`, and `.tray-surface` stay single-composited without nested translucent overlays.
   - Radius customization drives CSS variables, `SurfaceShape`, `NotchProgressBorder`, and Framer Motion from `useSurfaceMetrics()` with minimum clamp `12px` on `SurfaceShape` to preserve concave flare geometry (`flare = 13`).

4. **Lively Wallpaper Immunity**:
   - `GAME_MODE_ACTIVE` derives strictly from the existing `current_is_fs` boolean that filters out `is_desktop_wallpaper_host_window` (`services.rs`). Exit uses 1500ms hysteresis to prevent Alt-Tab churn.

5. **Performance Profile Unification**:
   - `nectar-perf-profile` (`balanced | eco | max`) owns `RAM_SAVER_ENABLED`: migrating existing `nectar-ram-saver == "true"` to `eco` when `nectar-perf-profile` is unset; setting `balanced`/`max` clears `nectar-ram-saver`, while `nectar-ram-ultra` (`--disable-gpu`) remains an explicit advanced restart-required switch.

6. **Fork Upstream Updater Isolation**:
   - `UPSTREAM_UPDATER_DISABLED = true` in `src-tauri/src/updater.rs` and `active: false, endpoints: []` in `tauri.conf.json` block all requests to `github.com/kua8/Nectar` while keeping crate linkage cleanly reversible.

7. **Rust Release Profile & Crash Safety**:
   - Add `lto = "thin"` and `codegen-units = 1` in `Cargo.toml`. Do NOT add `panic = "abort"` because `src-tauri/src/utils.rs:1370` relies on `std::panic::catch_unwind`.

8. **Live User Process Respect**:
   - Never terminate the user's active `nectar.exe` process; release packaging copies to `release/portable/` safely in `try/catch` while producing clean installers and ZIP archives.
