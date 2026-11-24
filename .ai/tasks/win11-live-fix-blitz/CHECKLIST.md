# Мастер-чеклист исправлений Nectar v1.10.0 для Windows 11 25H2 (Build 26200.9974)

> **Целевая среда**: Windows 11 Pro `25H2` (Build `26200.9974`), локаль `ru-RU`, экран `1920×1080` (`Bounds={0,0,1920,1080}`, `WorkingArea={0,0,1920,1032}`).  
> **Статус**: `[ ]` в работе · `[x]` исправлено и проверено · **Выполнено: `66/66` (`A1–L5`)**.

---

## A. Клавиша `Win`, `WH_KEYBOARD_LL`, фокус и переключение «Пуска» (`A1–A6`)

| ID | Задача | Исполнитель | Файлы | Статус |
|---|---|---|---|---|
| `A1` | Перевести перехват `VK_LWIN`/`VK_RWIN` на паттерн «подавление DOWN + отложенный replay при аккорде» (`WinKeyState`: `Idle` / `PendingSolo` / `PromotedToChord` / `ConsumedByNectar`), убрать `0xE8` mask race на Win11 25H2, изолировать `Win+L`, `Win+E/D/R/Tab/Shift+S`, `Win+1..9`, `Win+B`, `Ctrl+Win+...` и `Win+Mouse` | Worker 1 | `src-tauri/src/start_menu.rs`, `src-tauri/src/services.rs` | [x] |
| `A2` | Перенести `WH_KEYBOARD_LL` на выделенный поток `"keyboard-hook"` с `GetMessageW` и lock-free `AtomicBool` настройками (убрать мьютексы из хука и риск тихого снятия по `LowLevelHooksTimeout` 300 мс) | Worker 1 | `src-tauri/src/services.rs`, `src-tauri/src/state.rs`, `src-tauri/src/utils.rs` | [x] |
| `A3` | Реализовать `force_foreground` (`AttachThreadInput` + `BringWindowToTop` + `SetForegroundWindow`), `install_noactivate_subclass` (`WM_MOUSEACTIVATE -> MA_NOACTIVATE`), исправить пооконный `re_assert_topmost` (`KEYBOARD_FOCUS_HWND`) и чтение JSON `Bool`/`Number` в `get_setting_str` | Worker 1 | `src-tauri/src/utils.rs`, `src-tauri/src/state.rs` | [x] |
| `A4` | Исправить `get_start_pins`: не перезасеивать 12 дефолтных пинов, когда файл `start_pins.json` существует с пустым массивом `[]` (после открепления последнего приложения) | Worker 1 | `src-tauri/src/start_menu.rs` | [x] |
| `A5` | Перевести показ/фокус `start-menu`, `launcher`, `tray-bar`, `settings`, `calendar` на `force_foreground`, увеличить `FOCUS_GRACE_MS` до `250` мс с трекингом `RECEIVED_FOCUS`, добавить `LAST_BLUR_HIDE_MS` дебаунс (300 мс) против цикла «закрылось-переоткрылось по кнопке дока» | Worker 2 | `src-tauri/src/shell_windows.rs`, `src-tauri/src/on_demand_windows.rs`, `src-tauri/src/commands.rs` | [x] |
| `A6` | Предварительный прогрев `prewarm_shell_surfaces` после запуска, ожидание `shell_surface_ready` перед `win.show()`, установка `START_MENU_VISIBLE`, подкласс `WM_MOUSEACTIVATE` на `main`/`dock` | Worker 2 | `src-tauri/src/shell_windows.rs`, `src-tauri/src/main.rs` | [x] |

---

## B. Системный трей, ZBID-ограничение Windows 11 25H2 и панель задач (`B1–B6`)

| ID | Задача | Исполнитель | Файлы | Статус |
|---|---|---|---|---|
| `B1` | Отслеживать `TrayHostStatus` (`Active` / `BlockedByZbid` / `Stopped`): при 3 потерях `outrank()` уничтожать мёртвый прокси `Shell_TrayWnd` и останавливать цикл `SetWindowPos`, перевести не-GUID ключи трея с эфемерного `win:{hwnd}` на стабильный `exe:{name}:{uid}` | Worker 2 | `src-tauri/src/tray_host/proxy.rs`, `src-tauri/src/tray_host/mod.rs`, `src-tauri/src/tray_host/model.rs` | [x] |
| `B2` | Исправить нативный фолбэк `open_native_tray` для Win11 25H2 `ru-RU`: убрать пропуск UIA при скрытой панели задач, убрать поломку XAML через `WS_EX_LAYERED`, матчить шеврон по `SystemTray.ChevronIconView` + `NotificationChevron` + `"скрытые значки"` (исключить `OverflowButton`), не вызывать `ABM_SETSTATE` при закрытии | Worker 2 | `src-tauri/src/tray_icons.rs` | [x] |
| `B3` | Автоматически переключать `use_custom_tray_bar` на нативный трей при `!tray_host::is_proxy_active()`, добавить команду `get_tray_host_status`, удалить 500мс мигание `schedule_taskbar_layout_refresh()` | Worker 2 | `src-tauri/src/commands.rs`, `src-tauri/src/main.rs`, `src-tauri/src/tray_icons.rs` | [x] |
| `B4` | Перенаправить `Win+B` на `open_tray_from_hotkey` (якорь у дока/курсора, а не под Notch), в `interact_tray_icon` использовать `GetCursorPos` и прятать `tray-bar` ДО `SetForegroundWindow` + `WM_CONTEXTMENU` | Worker 1 / Worker 2 | `src-tauri/src/services.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/shell_windows.rs` | [x] |
| `B5` | Показать в `TrayBar.tsx` честный статус при `blocked_by_zbid` (без ложного `"Обновлено!"`) и заметную кнопку открытия трея Windows; поправить `max-width: calc(100% - 16px)` в `TrayBar.css` и закрытие по клику на прозрачный фон | Worker 4 | `src/TrayBar.tsx`, `src/TrayBar.css` | [x] |
| `B6` | Соединить в Dock отображение подсказки о ZBID (`DockTab.tsx`), чтение `trayBarEnabled` из `trayBarEnabledRef`, передачу `scale`/курсора и убрать переподписку эффектов от `[isDragging]` | Worker 3 / Worker 4 | `src/Dock.tsx`, `src/settings/DockTab.tsx` | [x] |

---

## C. Перекрытия окон, AppBar, полноэкранный детектор и Hit-Test (`C1–C7`)

| ID | Задача | Исполнитель | Файлы | Статус |
|---|---|---|---|---|
| `C1` | Выделенный `AppBarSentinel` поток/HWND с `WM_APP` (`ABN_POSCHANGED` и `TaskbarCreated`) и строгим Win32-протоколом (`ABM_NEW != 0`, `ABM_QUERYPOS` -> пересчёт `top`/`bottom` -> `ABM_SETPOS`) для Dock (`ABE_BOTTOM`) и Notch (`ABE_TOP`) | Worker 1 | `src-tauri/src/services.rs` | [x] |
| `C2` | Выравнять дефолтные режимы в `re_register_appbars` и `create_monitor_window` через `resolve_mode_for_label`, перенести `taskbar_event_proc` в фоновый вызов `ShowWindow(SW_HIDE)` без спама `ABM_SETSTATE`, удалить мёртвый код `"bottom-corners"` | Worker 1 / Worker 2 | `src-tauri/src/services.rs`, `src-tauri/src/commands.rs` | [x] |
| `C3` | Исправить ложное определение fullscreen на безрамочных `IsZoomed` окнах (`SHQueryUserNotificationState` + `IsZoomed`), добавить процессы Win11 (`shellhost.exe`, `widgetboard.exe`, `screenclippinghost.exe`), в `enum_zone_overlap_proc` исключать только `SHELL_CHROME_HWNDS` (чтобы `Settings`/`Calendar` прятали Smart Dock/Notch) | Worker 1 / Worker 2 | `src-tauri/src/services.rs`, `src-tauri/src/state.rs`, `src-tauri/src/main.rs` | [x] |
| `C4` | Убрать самоосцилляцию Smart Dock/Notch: не перезаписывать resting pill rect сжатыми `34×34` / `39×29` кадрами когда `isHidden == true` | Worker 3 | `src/App.tsx`, `src/Dock.tsx` | [x] |
| `C5` | Событие `"shell-surface-opening"` для сворачивания Notch и очистки превью/меню Dock при открытии Start/Launcher/Tray; фикс `vertical_limits_on_work_area` (не терять нижний зазор Dock) и ограничение высоты `Launcher` `ResizeObserver` | Worker 2 / Worker 3 / Worker 4 | `src-tauri/src/shell_windows.rs`, `src/App.tsx`, `src/Dock.tsx`, `src/Launcher.tsx` | [x] |
| `C6` | Убрать гигантские прозрачные щиты: убрать глобальный `!MENU_IS_OPEN` с `Notch` и лишних окон, проверять `ov_win.is_visible() && !OVERLAY_IN_SPLASH` для `overlay`, сузить верхний отступ Notch и учитывать `r.y`, заменить `±500 / -320` хитбокс превью Dock реальным bounding rect `.preview-tooltip` | Worker 1 / Worker 3 | `src-tauri/src/services.rs`, `src/Dock.tsx` | [x] |
| `C7` | Сохранение Z-порядка `any_visible_surface_hwnd` в доп. окнах мониторов; убрать дублирующийся `init_dock` (+1500 мс) и лишние `sync_appbar` при старте | Worker 1 / Worker 3 | `src-tauri/src/services.rs`, `src/App.tsx` | [x] |

---

## D. Dock и Меню «Пуск» (`D1–D6`)

| ID | Задача | Исполнитель | Файлы | Статус |
|---|---|---|---|---|
| `D1` | Исключить пункт «Открепить от дока» для синтетической кнопки `start` при ПКМ в Dock | Worker 3 | `src/Dock.tsx` | [x] |
| `D2` | Исправить вертикальную координату контекстного меню Dock при `scale !== 1.0` (`getBoundingClientRect().height` вместо `offsetHeight`) | Worker 3 | `src/Dock.tsx` | [x] |
| `D3` | Корректно инициализировать `trayBarEnabled` в Dock из `settings.json` и избавиться от зависимости `[isDragging]` в подписках событий | Worker 3 | `src/Dock.tsx` | [x] |
| `D4` | Вызвать `hide_start_menu` при клике по внешнему 8px полю `.start-viewport` и корректно закрывать поповеры | Worker 4 | `src/StartMenu.tsx` | [x] |
| `D5` | Уважать `nectar-launcher-enabled` и `nectar-legacy-mode` в Start Menu (скрывать кнопку «Искать везде» и блокировать переход по Enter/Tab) | Worker 4 / Worker 2 | `src/StartMenu.tsx`, `src-tauri/src/shell_windows.rs` | [x] |
| `D6` | Отображать пустое состояние `start.pinsEmpty` при откреплении всех пинов и переводить статусы контекстных действий (`start.action.*`) | Worker 4 / Worker 2 | `src/StartMenu.tsx`, `src-tauri/src/launcher/providers.rs` | [x] |

---

## E. Лаунчер и глобальные хоткеи (`E1–E5`)

| ID | Задача | Исполнитель | Файлы | Статус |
|---|---|---|---|---|
| `E1` | Перевести бейджи типов результатов (`launcher.badge.*`) и действия контекстного меню (`launcher.action.*`) на локализованный `t(...)` | Worker 4 | `src/Launcher.tsx` | [x] |
| `E2` | Трекать `HotkeyStatus` в `hotkeys.rs` + пауза глобальных хоткеев `set_hotkeys_paused(true/false)` на время записи в `ShortcutRecorder` и отображение конфликтов (`settings.hotkeyConflict`) в Settings | Worker 1 / Worker 2 / Worker 4 | `src-tauri/src/hotkeys.rs`, `src-tauri/src/commands.rs`, `src/settings/ShortcutRecorder.tsx`, `src/settings/LauncherTab.tsx`, `src/settings/DockTab.tsx`, `src/settings/NotchHotkey.tsx` | [x] |
| `E3` | Русские алиасы и ключевые слова в поиске встроенных утилит, настроек Windows и системных команд Лаунчера | Worker 2 | `src-tauri/src/launcher/app_index.rs`, `src-tauri/src/launcher/providers.rs` | [x] |
| `E4` | Ограничить высоту `ResizeObserver` Лаунчера по `screen.availHeight` и добавить закрытие по клику на внешний `.launcher-viewport` | Worker 4 | `src/Launcher.tsx` | [x] |
| `E5` | Блокировать `open_launcher` в бэкенде при отключённом Лаунчере или включённом Legacy Mode | Worker 2 | `src-tauri/src/shell_windows.rs` | [x] |

---

## F. Notch, Control Center, Shelf, Timer, Tour, Calendar и Overlay (`F1–F6`)

| ID | Задача | Исполнитель | Файлы | Статус |
|---|---|---|---|---|
| `F1` | Исправить кнопку копирования текста в `NotchShelf` (`invoke("copy_text_to_clipboard")` вместо `navigator.clipboard`, падающего из-за `WS_EX_NOACTIVATE`) | Worker 3 | `src/components/NotchShelf.tsx` | [x] |
| `F2` | Исправить дубль `@keyframes marquee-scroll` (переименовать второй в `premium-marquee-scroll`) и обрезку текста/тултипов Control Center на русском (`min-width: 0; overflow: hidden; text-overflow: ellipsis`) | Worker 3 | `src/App.css` | [x] |
| `F3` | Блокировать кнопку Старт таймера на `00:00`, масштабировать высоту Notch Tour по `scale`, не прерывать тур при клике шага 4 (`control-center`) | Worker 3 | `src/components/NotchClock.tsx`, `src/App.tsx` | [x] |
| `F4` | Исправить Bluetooth-ящик: `bluetoothEnabled` по умолчанию `false` до ответа ОС, индикация отсутствия адаптера, кнопка «Открыть настройки Bluetooth»; удержание фокуса Notch и `Escape` при вводе пароля Wi-Fi | Worker 3 | `src/components/ConnectionsView.tsx`, `src/App.tsx` | [x] |
| `F5` | Фикс двойного клика по мини-обложке, очистка обложки при закрытии плеера, cleanup подписки батареи, постоянная кнопка «Открыть календарь» в Notch, корректный `toggleNotchModeSetting`/`toggleDockModeSetting` | Worker 3 | `src/App.tsx`, `src/components/NotchCalendar.tsx` | [x] |
| `F6` | Исправить `Calendar.tsx` (открытие вкладки `"calendar-sync"` при холодном запуске, живой `hour12`, локализация `+{count} ещё`) и `Overlay.tsx` (`nectar-volume-edge-enabled` / `nectar-brightness-edge-enabled`) | Worker 3 / Worker 2 | `src/Calendar.tsx`, `src/Overlay.tsx`, `src-tauri/src/commands.rs`, `src-tauri/src/on_demand_windows.rs` | [x] |

---

## G. Настройки, синхронизация `settings.json` ↔ `localStorage` и локали (`G1–G5`)

| ID | Задача | Исполнитель | Файлы | Статус |
|---|---|---|---|---|
| `G1` | Пропускать `null` значения в `useSettingsSync` (чтобы живые сбросы раскладки CC / порядка панелей / города погоды обновляли UI без перезапуска), удалять ключ при `null` в `save_setting`, эмитить `settings-reset` и синхронизировать `nectar-legacy-mode` с `tray_host` | Worker 3 / Worker 2 | `src/hooks/useSettingsSync.ts`, `src-tauri/src/commands.rs` | [x] |
| `G2` | Единый хелпер `settingsHydration.ts` (`settings.json` -> `localStorage` с очисткой устаревших ключей при импорте), гидрация языка в `i18n.ts`, 10 пропущенных ключей в `App.tsx` и всех 11 подкомпонентов настроек | Worker 3 / Worker 4 | `src/utils/settingsHydration.ts`, `src/i18n.ts`, `src/App.tsx`, `src/settings/*` | [x] |
| `G3` | Размер `Settings` `760×620 * scale` вместо сжатия до `620×480`, гибридное закрытие красной кнопкой `hide_on_demand_window` (суспенд WebView2), `SW_RESTORE` только при `IsIconic` | Worker 4 / Worker 3 / Worker 2 | `src/Settings.tsx`, `src/components/WindowControls.tsx`, `src-tauri/src/on_demand_windows.rs` | [x] |
| `G4` | Исправить `StatusWidgetConfig` (`id={id}` на `DropZone` + клик для добавления чипов) и масштабирование портального `Dropdown` при `scale !== 1.0` | Worker 4 | `src/components/StatusWidgetConfig.tsx`, `src/settings/Dropdown.tsx` | [x] |
| `G5` | Охранник `if (pillBusy) return;` в `AboutTab`, полный набор новых ключей в `en.json` и `ru.json` со 100% паритетом | Worker 4 | `src/settings/AboutTab.tsx`, `src/locales/en.json`, `src/locales/ru.json` | [x] |

---

## H. Сборка, независимый аудит, переупаковка релиза и проверка на ПК (`H1–H4`)

| ID | Задача | Исполнитель | Результат / Артефакты | Статус |
|---|---|---|---|---|
| `H1` | Единая сборка фронтенда и проверка паритета локалей (`bun run build`, `en.json` vs `ru.json`) | Coordinator | `bun run build` (`tsc && vite build`) — exit `0` (`1.73s`); паритет локалей `en.json` = `880`, `ru.json` = `880`, расхождений `0`; `searchIndex.ts` `124/124` ключей валидны. | [x] |
| `H2` | Полный `cargo test` (включая регрессионные тесты хука `Win`, `AppBar`, `IsZoomed` fullscreen, UIA шеврона, `shell_windows` ready/replay, `batch_settings`, Lively wallpaper, `windows_accent`) | Coordinator | `cargo test` — exit `0`, `88 passed; 0 failed; 1 ignored` (`ics::tests::real_public_feeds`), `0` предупреждений компилятора Rust. | [x] |
| `H3` | Независимый аудит кода (`skeptic-reviewer`) + арт-директорский аудит (`design-director`) + визуальная проверка через Edge CDP и устранение всех P0/P1/P2 замечаний | Coordinator + Subagents | Закрыты все замечания Волны 4 и Волны 5 (`P0` handshake `shell_surface_ready`/show без гонки на препрогретых окнах; `P1` блокировка `SETTINGS_FILE_LOCK` в `setup_settings_watcher`, `FORCE_FG_ALT_LOCK` + `GetAsyncKeyState(VK_LMENU)` в `AltKeyGuard`, 50 мс опрос закрытия flyout, очередь `flushQueueRef` и защита `themeModeSeqRef` + сброс после импорта в `useSettings`; `P2` отказ от `ui32.exe`/`GA_PARENT` + проверка `WS_CAPTION`/`WS_THICKFRAME`, ToolHelp-проверка `AutoRestartShell`, `data-setting-key` подсветка поиска в `ControlCenterConfig`/`AboutTab`). `verify_wave5.ts` — `0` консольных/JS ошибок. | [x] |
| `H4` | Пересборка NSIS, Portable и GUI Setup в `release/`, проверка `WebView2Loader.dll`, ZIP, `objdump -p`, чистоты временных файлов и обновление чеклиста | Coordinator | Пересобраны и проверены `nectar_1.10.0_x64-setup.exe` (`10 694 627` Б), `portable/nectar.exe` (`40 064 512` Б) + `WebView2Loader.dll` (`160 320` Б) + `nectar-1.10.0-portable-windows-x64.zip` (`15 039 222` Б), `Nectar-GUI-Setup/Nectar-Setup-1.10.0.exe` (`38 364 487` Б) + `WebView2Loader.dll` (`160 320` Б) + `Nectar-GUI-Setup-1.10.0.zip` (`21 110 241` Б); `objdump -p` подтвердил только стандартные Windows DLL + `WebView2Loader.dll`; временные файлы упаковки удалены. | [x] |

---

## I. Волна 4: живые UX/UI баги Win11 25H2, визуальный дизайн-ревью, 2D-палитра и цвет выделения (`I1–I6`)

| ID | Задача | Исполнитель | Файлы | Статус |
|---|---|---|---|---|
| `I1` | Исправить дефолт Dock на `"smart"` и Notch на `"fixed"`, убрать `ABE_TOP` AppBar-резерв с Notch (верхний `WorkingArea` больше не сжимается на 40 px) и синхронно снимать старый Dock AppBar | Worker A | `src-tauri/src/monitors.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/services.rs`, `src/Dock.tsx`, `src/App.tsx`, `src/settings/useSettings.ts` | [x] |
| `I2` | Исправить Win11 25H2 XAML трей в `open_native_tray` (`EnumChildWindows` UIA внутри `DesktopWindowContentBridge`, парковка `Shell_TrayWnd` под монитор на всё время открытого flyout без показа панели задач поверх Dock) + защиту от гонки закрытия | Worker A + Coordinator | `src-tauri/src/tray_icons.rs` | [x] |
| `I3` | Улучшить `force_foreground` (`hwnd_owns_foreground`, RAII `AltKeyGuard` с `VK_LMENU`, `IsHungAppWindow` вместо UIPI-блокируемого `SendMessageTimeoutW`, фолбэк `SwitchToThisWindow`) и `prepare_focusable_toolwindow_style` до `win.show()` | Worker A + Coordinator | `src-tauri/src/utils.rs`, `src-tauri/src/shell_windows.rs` | [x] |
| `I4` | Починить hover-подсветку контекстного меню «Пуска», опечатку `"Открепить от Пуск"` → `"Открепить от «Пуска»"`, убрать цветовые швы и просвечивание на `.nectar-shell-surface`, вынести `--shell-*`/`--shell-popover-*` в `:root` и добавить анимацию появления (`openSeq`) при повторных показах препрогретых окон | Worker B + Worker C + Coordinator | `src/surfaces.css`, `src/StartMenu.{tsx,css}`, `src/Launcher.{tsx,css}`, `src/TrayBar.{tsx,css}`, `src/Dock.css`, `src/locales/{en,ru}.json` | [x] |
| `I5` | Починить «плывущие цвета» и контраст светлой/кастомной темы (`themeGeneration`, WCAG-порог, чистый моно-акцент, фикс `hslToHex` 360°wrap, атомарное сохранение темы), заменить `<input type="color">` на портальную 2D HSV-палитру (`ColorPalettePicker`) для фона, акцента и выделения | Worker B + Worker C + Coordinator | `src/theme.ts`, `src/settings/ColorPalettePicker.tsx`, `src/settings/AppearanceTab.tsx`, `src/settings/useSettings.ts`, `src/Settings.css` | [x] |
| `I6` | Добавить настройку цвета выделения (`Цвет выделения`, интерактивное превью рамки выделения на рабочем столе, синхронизацию с реестром Windows `Control Panel\Colors` `"Hilight"`/`"HotTrackingColor"` + `SetSysColors` и кнопку перезапуска Проводника), плюс ключи поиска в `searchIndex.ts` | Worker A + Worker C + Coordinator | `src-tauri/src/windows_accent.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/main.rs`, `src/settings/AppearanceTab.tsx`, `src/settings/useSettings.ts`, `src/settings/searchIndex.ts`, `src/utils/tauriBridge.ts` | [x] |

---

## J. Волна 5: плавная анимация Win, Lively Wallpaper / SearchHost, нижний Dock без зазора, стабильная палитра настроек и синхронизация выделения Проводника (`J1–J5`)

| ID | Задача | Исполнитель | Файлы | Статус |
|---|---|---|---|---|
| `J1` | Убрать рывки/мигание при открытии по `Win`: отказ от DOM remount (`key={openSeq}`), персистентный GPU `.shell-anim-surface` (`is-open`/`is-hidden` + `rAF`), эмиссия `shell-window-shown` до `win.show()`, атомарный `ready`/`replay` handshake без гонок, удаление синхронных задержек из `force_foreground` | Coordinator + Subagents | `src/surfaces.css`, `src/StartMenu.tsx`, `src/Launcher.tsx`, `src/TrayBar.tsx`, `src-tauri/src/shell_windows.rs`, `src-tauri/src/utils.rs` | [x] |
| `J2` | Починить перехват фокуса у `SearchHost.exe`/shell flyout и конфликт с Lively Wallpaper / Wallpaper Engine: сериализованный `AltKeyGuard` (`FORCE_FG_ALT_LOCK` + `GetAsyncKeyState(VK_LMENU)` + исключение `SYNTHETIC_ALT_ACTIVE` в хуке), закрытие `shellexperiencehost.exe`/`widgetboard.exe`/`searchhost.exe` с 50 мс опросом, игнор прокрутки `WM_MOUSEWHEEL` при `Win`, фильтр обоев (`Progman`/`WorkerW`/`GA_PARENT` + отсутствие `WS_CAPTION`/`WS_THICKFRAME`) | Coordinator + Subagents | `src-tauri/src/state.rs`, `src-tauri/src/utils.rs`, `src-tauri/src/services.rs` | [x] |
| `J3` | Убрать 64 px нижний зазор обоев при `"nectar-dock-mode": "fixed"`: перевести `ABE_BOTTOM` AppBar-резервирование в Dock в opt-in (`"nectar-dock-reserve-space"`, по умолчанию `false`), синхронизировать `sync_appbar` и добавить тумблер в `DockTab` с RU/EN/поисковыми ключами | Coordinator + Subagents | `src-tauri/src/services.rs`, `src-tauri/src/commands.rs`, `src/settings/DockTab.tsx`, `src/settings/useSettings.ts`, `src/settings/searchIndex.ts`, `src/locales/{en,ru}.json` | [x] |
| `J4` | Устранить «плывущие цвета» и полосы в окне Настроек: отключить двойной композитинг (`Effect.Acrylic` на `SETTINGS` + CSS `backdrop-filter` + фоновый transition), почти непрозрачный `--nectar-setting-window-bg` (`0.98–0.99`), гистерезис `.light-mode`, дробная точность `hexToHsl`, атомарный `save_settings_batch` с очередью `flushQueueRef`, блокировка `SETTINGS_FILE_LOCK` в `setup_settings_watcher`, подавление self-echo, защита `themeModeSeqRef`, точная подсветка поиска по `[data-setting-key]` | Coordinator + Subagents | `src-tauri/src/on_demand_windows.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/main.rs`, `src/Settings.{tsx,css}`, `src/theme.ts`, `src/hooks/useSettingsSync.ts`, `src/utils/tauriBridge.ts`, `src/settings/{useSettings.ts,ControlCenterConfig.tsx,AboutTab.tsx}` | [x] |
| `J5` | Сделать синхронизацию цвета выделения рабочего стола с Проводником видимой и надёжной: авто-включение `nectar-sync-windows-selection` при выборе цвета (с бэкапом реестра), компактная панель `Перезапустить Проводник` прямо под превью выделения (`.selection-desktop-bar`), контроль респауна Explorer через ToolHelp (`explorer_process_pids`) против дубля окна Проводника на `AutoRestartShell` | Coordinator + Subagents | `src-tauri/src/windows_accent.rs`, `src/settings/AppearanceTab.tsx`, `src/settings/useSettings.ts`, `src/Settings.css` | [x] |

---

## K. Волна 6: устранение `RGBA_4444` цветового бандинга WebView2, Notch `.panel-open`, нулевое перекрытие Dock, `Win`+`SearchHost` и диагностика Проводника (`K1–K5`)

| ID | Задача | Исполнитель | Файлы / Результат | Статус |
|---|---|---|---|---|
| `K1` | Убрать 16-битное `RGBA_4444` квантование плиток Chromium (шаг `17`, 3–4 смешанных цвета в «Пуске», переход фиолетового Notch в серый при наведении, пунктирные швы, дизеринг в превью): заменить `--enable-low-end-device-mode` на `--disable-rgba-4444-textures` + регрессионный unit-тест | Executor + Planner | `src-tauri/src/webview_args.rs` | [x] |
| `K2` | Единый тон/плотность поверхностей и фикс слайдеров кастомизации: убрать 42% подмес нейтрально-серого `#101118` и линейные градиенты на `.nectar-shell-surface`, ослабить молочную вуаль `style-frosted`, добавить `.nectar.panel-open` (`--nectar-bg-panel`, α ≥ 0.94), поднять пороги `opExpanded ≥ 0.86`/`opPanel ≥ 0.94`, исправить обрезку `"Windows Settings"` в `.start-pinned-grid`, сохранить hue (`fallbackHue`) при `Sat=0`/`Lit=0` и пользовательскую прозрачность при смене стиля (`min="0.35"`) | Executor + Planner | `src/theme.ts`, `src/App.css`, `src/App.tsx`, `src/surfaces.css`, `src/StartMenu.css`, `src/settings/{ColorPalettePicker.tsx,AppearanceTab.tsx,useSettings.ts}` | [x] |
| `K3` | Устранить перекрытие нижней области максимизированных окон и залипание Smart Dock: пробуждение `mouse-worker` по активным `MH_*_EXPIRY_MS` (фикс сна `park()` при остановке мыши), учет `state::dock_hidden()` в primary/`dock-*` хит-тестах + dwell `120ms` на полосе `4px`, защита от залипания `dock_hovered` при `WS_EX_TRANSPARENT`, перенос сброса `last_emit` после `dock-maximized`, уменьшение `ABE_BOTTOM` до точных `52px`, сброс превью/меню при скрытии в `Dock.tsx`, однократная миграция `nectar-dock-mode-migrated-v2` (`fixed` без резерва -> `smart`) | Executor + Planner | `src-tauri/src/state.rs`, `src-tauri/src/services.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/main.rs`, `src/Dock.tsx` | [x] |
| `K4` | Стабильное 2-е/повторное перехватывание клавиши `Win` и победа над `SearchHost.exe` (`0x101bc`): 20×1мс/15×1мс подтверждение `GetAsyncKeyState(VK_LMENU)` в `AltKeyGuard` + cooldown `SYNTHETIC_ALT_RELEASED_MS` (60мс), `dismiss_visible_shell_flyout()` до показа StartMenu, фолбэк `AttachThreadInput(GetShellWindow())` + `SetWindowPos(HWND_TOPMOST/TOP)` в `force_foreground`, асинхронный лог `log_async` без дискового I/O в `WH_KEYBOARD_LL`, фильтр `LLMHF_INJECTED` для мыши, `GetModuleHandleW(None)` для хука, `toggle_start_from_winkey` без 300мс blur-дебаунса и счётчик `Keyboard hook` в `diagnostics.txt` | Executor + Planner | `src-tauri/src/state.rs`, `src-tauri/src/diagnostics.rs`, `src-tauri/src/utils.rs`, `src-tauri/src/shell_windows.rs`, `src-tauri/src/services.rs` | [x] |
| `K5` | Верификация Волны 6, фикс NSIS `WebView2Loader.dll`, аудит Проводника (`ExplorerBlurMica.dll`) и полная переупаковка релиза: `bun run build` (`1.76s`), паритет локалей (`880/880`, `124/124`), `cargo test --bin nectar` (`91 passed; 0 failed; 1 ignored`), Edge CDP `verify_wave6.ts` + инспекция PNG (`wave6_start`, `wave6_notch_{collapsed,expanded,panel}`, `wave6_settings_appearance`), упаковка `WebView2Loader.dll` прямо в `$INSTDIR` в `installer.nsi` (строки 643 и 762) + очистка в `native_uninstall.rs` и `uninstall.rs`, `objdump -p` (без MinGW DLL), очистка временных файлов; доказано, что размытие левой панели Проводника создаёт стороннее расширение `ExplorerBlurMica.dll` (`clearWinUIBg=true`, `effect=1`) | Coordinator + Executor | `installer.nsi`, `src-tauri/src/native_uninstall.rs`, `installer-app/src-tauri/src/uninstall.rs`, `verify_wave6.ts`, `release/`, `diagnostics.txt` | [x] |

---

## L. Волна 7: корневое устранение открытия системного «Пуска» при повторном `Win` и ловушки фокуса `StartMenuExperienceHost` (`L1–L5`)

| ID | Задача | Исполнитель | Файлы / Результат | Статус |
|---|---|---|---|---|
| `L1` | Устранить выпадание глобального хука `WH_KEYBOARD_LL` под фокусом собственных WebView2-окон на Win11 Build `26200` (`tauri-apps/wry#1761`): включить `.device_event_filter(app_device_event_filter())` -> `tauri::DeviceEventFilter::Always` (передаёт `RIDEV_REMOVE` в `tao 0.35.3` / `raw_input.rs`) + unit-тест | Executor + Planner | `src-tauri/src/main.rs` | [x] |
| `L2` | Усилить `dismiss_visible_shell_flyout` (давать `post_cloak_polls < 6` ≈ `30ms` на передачу `GetForegroundWindow` после cloak), расширить `classify_shell_flyout` (520-char буфер + `screenclippinghost.exe`), убрать 220мс синхронный блок UI-потока из `force_foreground` (вынос `dismiss_visible_shell_flyout` в `spawn_blocking` для всех shell-поверхностей, один `AltKeyGuard::press()` с `10`/`8` опросами, `SwitchToThisWindow(hwnd, false)` для `WS_EX_TOOLWINDOW`) | Executor + Planner | `src-tauri/src/utils.rs`, `src-tauri/src/shell_windows.rs` | [x] |
| `L3` | Изолированное восстановление фокуса `hide_surface_internal(..., allow_restore)` и защита от TOCTOU UIA: сохранять `PREVIOUS_NON_SHELL_FG` до `hide_other_surfaces` и сбрасывать в `0` при открытии с Desktop/`SearchHost`/`Settings`; восстанавливать фокус при падении на `NULL`/shell flyout ТОЛЬКО при явном закрытии пользователем (`toggle_surface_async`, Escape/фон `StartMenu.tsx` — никогда при запуске приложений/папок/лаунчера/трея); отложенный поток `uia-focus` с отменой по `SURFACE_FOCUS_GEN` + проверкой `should_execute_uia_set_focus` до и перед `SetFocus()` + `win.show()` до `mark_show_and_claim_emit` + главный поток в таймере `Focused(false)` | Executor + Planner | `src-tauri/src/shell_windows.rs`, `src-tauri/src/utils.rs`, `src/StartMenu.tsx` | [x] |
| `L4` | Независимый аудит `skeptic-reviewer` (итерация 1 `BLOCK` -> устранение всех P1/P2 -> итерация 2 **`APPROVE`**) + полная проверка сборки (`bun run build` exit `0`, `tsc --noEmit` exit `0`, `check_locales.ts` `880/880`, `cargo check --all-targets` exit `0`, `cargo test --bin nectar` `96 passed; 0 failed; 1 ignored`) | Coordinator + Skeptic Reviewer | `src-tauri/src/{main,utils,shell_windows}.rs`, `src/StartMenu.tsx` | [x] |
| `L5` | Пересборка всех 3 релизных пакетов (`nectar_1.10.0_x64-setup.exe` с `WebView2Loader.dll` в `$INSTDIR`, `nectar-1.10.0-portable-windows-x64.zip` с `nectar.exe` + `WebView2Loader.dll`, `Nectar-Setup-1.10.0.exe` + `WebView2Loader.dll` в `payload.zip` и `Nectar-GUI-Setup-1.10.0.zip`), проверка `installer.nsi` и `objdump -p` (без MinGW DLL), безопасный пропуск заблокированной активным процессом `release/portable/`, удаление временных файлов | Coordinator + Executor | `release/` | [x] |

---

## Пересобранные артефакты релиза и финальный smoke-тест на рабочем столе

### Пересобранные сборки (`c:\среда\sandbox\Nectar\release\`)
- [nectar_1.10.0_x64-setup.exe](file:///c:/среда/sandbox/Nectar/release/nectar_1.10.0_x64-setup.exe) — `10 787 381` байт (однофайловый NSIS-установщик с `WebView2Loader.dll` в `$INSTDIR`)
- [nectar-1.10.0-portable-windows-x64.zip](file:///c:/среда/sandbox/Nectar/release/nectar-1.10.0-portable-windows-x64.zip) (`15 064 269` байт: внутри свежие `nectar.exe` `40 205 312` байт + `WebView2Loader.dll` `160 320` байт; папка [release/portable/](file:///c:/среда/sandbox/Nectar/release/portable/nectar.exe) пропущена без убийства запущенного процесса пользователя `PID 13604`)
- [Nectar-Setup-1.10.0.exe](file:///c:/среда/sandbox/Nectar/release/Nectar-Setup-1.10.0.exe) (`38 389 505` байт, копия в [release/Nectar-GUI-Setup/](file:///c:/среда/sandbox/Nectar/release/Nectar-GUI-Setup/Nectar-Setup-1.10.0.exe)) + [WebView2Loader.dll](file:///c:/среда/sandbox/Nectar/release/WebView2Loader.dll) (`160 320` байт) и архив [Nectar-GUI-Setup-1.10.0.zip](file:///c:/среда/sandbox/Nectar/release/Nectar-GUI-Setup-1.10.0.zip) (`21 134 607` байт)

### Граница изолированного рабочего стола и 5-шаговая проверка на ПК
> [!NOTE]
> Команды агента выполнялись в изолированной сессии Win32 (`WinSta0\exebox-...`), поэтому все автотесты, аудит логов/настроек/реестра и рендер UI через Edge CDP подтверждены напрямую, а поведение физического ввода клавиатуры на интерактивном рабочем столе (`WinSta0\Default`) проверяется на самом ПК после запуска новой сборки:
1. Одиночное нажатие левой/правой клавиши `Win`: меню «Пуск» Nectar плавно открывается и повторным нажатием `Win` или кликом по кнопке Dock закрывается без мерцания и открытия системного «Пуска» Windows.
2. Аккорды `Win+L`, `Win+E`, `Win+D`, `Win+1..9`, `Ctrl+Win+Left/Right` и клик по иконке с зажатым `Win`: срабатывают штатно, после отпускания клавиши `Win` меню «Пуск» не выскакивает самопроизвольно.
3. Трей Windows 11 25H2 и `Win+B`: в `TrayBar` отображается статус ZBID-ограничения или кнопка открытия системного трея, нажатие которой (или `Win+B`) корректно раскрывает нативные скрытые значки Windows 11 `ru-RU`.
4. Максимизация и переключение безрамочных окон (браузер/редактор/Терминал): панель задач AppBar, Smart Dock и Notch больше не залипают, не мигают и не блокируют клики у краёв экрана.
5. Настройки, Лаунчер и Notch на русском языке (при `100%` и `125%`): выпадающие списки, горячие клавиши и карточки отображаются без обрезки, а изменения в `Settings` сразу синхронизируются с Notch и Dock.
