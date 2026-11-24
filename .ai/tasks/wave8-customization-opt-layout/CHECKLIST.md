# Wave 8 Checklist

- [ ] **Step 0**: Initialize task memory (`SPEC.md`, `DECISIONS.md`, `CHECKLIST.md`)
- [ ] **Wave 8A — Worker 1A**: Frontend sync, `visibleInterval`, `tauriBridge`/`tauriPreviewMock`, `theme.ts`, `surfaces.css`, `themePresets.ts`, `palette.ts`, `backdrop.ts`, `useSurfaceMetrics.ts`, `useGameMode.ts`, `NectarMotionProvider.tsx`
- [ ] **Wave 8A — Worker 1B**: Rust fork updater guard, `Cargo.toml`, `state.rs` atomics/helpers, `webview_memory.rs`, `memory_saver.rs` fix, `commands.rs` sync/metrics/dialogs, `services.rs` loops/GameMode/Audio/AppBar/Overlay hitbox, `utils.rs`/`capture.rs`/`wallpaper.rs`/`audio_devices.rs`/`tray_host/proxy.rs`/`start_menu.rs`/`launcher/app_index.rs` optimizations
- [ ] **Wave 8B — Worker 2A**: Notch (`App.tsx`/`App.css`), `SurfaceShape.tsx` zero-rerender engine, `CompactMediaPlayer.tsx`, `NotchShelf.tsx`, `NotchCalendar.tsx`, `AgentStatus.tsx`, `agentSounds.ts`, `useWeather.ts`, Standalone `Calendar.tsx`/`Calendar.css`
- [ ] **Wave 8B — Worker 2B**: `Dock.tsx`/`Dock.css` & `TrayBar.tsx`/`TrayBar.css`
- [ ] **Wave 8B — Worker 2C**: `StartMenu.tsx`/`StartMenu.css`/`PinnedGrid.tsx`/`AllAppsList.tsx` & `Launcher.tsx`/`Launcher.css`/`ResultRow.tsx` (without `framer-motion`)
- [ ] **Wave 8B — Worker 2D**: `Overlay.tsx`/`Overlay.css`
- [ ] **Wave 8C — Worker 3A**: Settings UI (`Settings.tsx`/`Settings.css`, `SettingRow.tsx`, `useSettings.ts`, `types.ts`, all tabs, `StatusWidgetConfig.tsx`, `AgentSounds.tsx`, `ProcessesTab.tsx`, `searchIndex.ts`)
- [ ] **Wave 8C — Worker 3B**: `en.json` & `ru.json` complete localization + `check_locales.ts` pass
- [ ] **Wave 8D.1**: `tsc`, `vite build`, `check_locales.ts`, `cargo check --all-targets`, `cargo test --bin nectar`, TS helper unit assertions
- [ ] **Wave 8D.2**: Headless Edge CDP visual verification & screenshot inspection (`0` console errors)
- [ ] **Wave 8D.3**: Independent `skeptic-reviewer` & `design-director` reviews + fix all P1/P2 findings + re-verify
- [ ] **Wave 8D.4**: Release binary build + rebuild NSIS, Portable ZIP, GUI Setup (`objdump -p` check + clean temp files) + update artifacts
