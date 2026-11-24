import { useEffect, useState } from "react";
import type { ChangeEvent } from "react";
import { Monitor, Eye, EyeOff, BellDot, Square, Search, Shuffle, MonitorCheck, CalendarDays, Maximize2, Keyboard, Sparkles, RotateCcw, History, LayoutGrid, Trash2, HardDrive, ChevronUp, TextSearch, SquareTerminal, PanelBottom, Settings as SettingsIcon, Activity, Eraser, Power, Columns3, AlertTriangle, Info, Scaling, MoveHorizontal, MousePointerClick, Zap, LogOut, Waves, ArrowUpFromLine } from "lucide-react";
import { SettingRow } from "./SettingRow";
import { SettingSection } from "./SettingSection";
import { Dropdown } from "./Dropdown";
import type { MonitorInfo, MonitorMode, TrayHostStatus } from "./types";
import { usePerMonitor } from "./usePerMonitor";
import { useSyncedSetting } from "./useSyncedSetting";
import { useT } from "../i18n";
import { useSettingsSync } from "../hooks/useSettingsSync";
import { HideDelay } from "./HideDelay";
import { PreviewDelay } from "./PreviewDelay";
import { EdgeArea } from "./EdgeArea";
import { ShortcutField } from "./ShortcutField";
import { ShortcutRecorder } from "./ShortcutRecorder";
import { bridgeInvoke } from "../utils/tauriBridge";
import { isHotkeyConflicted, useHotkeyStatus } from "./useHotkeyStatus";

const SEARCH_PROVIDERS = ["nectar", "windows", "cmdpal", "ptrun", "raycast", "shortcut"];

const START_ICON_PRESETS = [
  { key: "default", src: "/nectar.png", label: "Nectar" },
  { key: "windows", src: "/windows.svg", label: "Windows" },
];

const parseClampedNumber = (min: number, max: number, fallback: number, decimals = 0) => (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? fallback));
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.min(max, Math.max(min, n));
  if (decimals <= 0) return Math.round(clamped);
  const factor = Math.pow(10, decimals);
  return Math.round(clamped * factor) / factor;
};
const parseBoolFalse = (v: unknown): boolean => v === true || v === "true";
const parseBoolTrue = (v: unknown): boolean => v !== false && v !== "false";

interface DriveInfo {
  letter: string;
  label: string;
  removable: boolean;
}

interface DockTabProps {
  dockEnabled: boolean;
  toggleDock: () => void;
  dockMode: string;
  setDockModeValue: (mode: string) => void;
  dockReserveSpace: boolean;
  toggleDockReserveSpace: () => void;
  dockPreviewEnabled: boolean;
  toggleDockPreview: () => void;
  dockAttentionEnabled: boolean;
  toggleDockAttention: () => void;
  dockConsoleWindows: boolean;
  toggleDockConsoleWindows: () => void;
  dockSearchEnabled: boolean;
  toggleDockSearch: () => void;
  dockSearchProvider: string;
  handleDockSearchProviderChange: (provider: string) => void;
  dockSearchShortcut: string;
  handleDockSearchShortcutChange: (shortcut: string) => void;
  dockCalendarEnabled: boolean;
  toggleDockCalendar: () => void;
  legacyMode: boolean;
  dockTray: boolean;
  toggleDockTray: () => void;
  dockTaskView: boolean;
  toggleDockTaskView: () => void;
  dockShowDesktop: boolean;
  toggleDockShowDesktop: () => void;
  dockRecycle: boolean;
  toggleDockRecycle: () => void;
  dockDrives: string[];
  toggleDockDrive: (letter: string) => void;
  hiddenDockApps: { id: string; name: string }[];
  restoreHiddenDockApp: (id: string) => void;
  dockIndicator: string;
  changeDockIndicator: (value: string) => void;
  dockMenuItems: string[];
  toggleDockMenuItem: (id: string) => void;
  dockIconOnly: boolean;
  toggleDockIconOnly: () => void;
  dockAdaptive: boolean;
  toggleDockAdaptive: () => void;
  startIcon: string;
  handleStartIconChange: (icon: string) => void;
  dockWinNumberEnabled: boolean;
  toggleDockWinNumber: () => void;
  dockMixedReorder: boolean;
  toggleDockMixedReorder: () => void;
  monitors: MonitorInfo[];
  dockMonitorMode: MonitorMode;
  setDockMonitorModeValue: (mode: MonitorMode) => void;
  dockMonitorId: string;
  setDockMonitorIdValue: (id: string) => void;
  dockModeByMonitor: Record<string, string>;
  setDockModeForMonitor: (monitorId: string, mode: string | null) => void;
  replaceDockModes: (next: Record<string, string>) => void;
}

export function DockTab({
  dockEnabled,
  toggleDock,
  dockMode,
  setDockModeValue,
  dockReserveSpace,
  toggleDockReserveSpace,
  dockPreviewEnabled,
  toggleDockPreview,
  dockAttentionEnabled,
  toggleDockAttention,
  dockConsoleWindows,
  toggleDockConsoleWindows,
  dockSearchEnabled,
  toggleDockSearch,
  dockSearchProvider,
  handleDockSearchProviderChange,
  dockSearchShortcut,
  handleDockSearchShortcutChange,
  dockCalendarEnabled,
  toggleDockCalendar,
  legacyMode,
  dockTray,
  toggleDockTray,
  dockTaskView,
  toggleDockTaskView,
  dockShowDesktop,
  toggleDockShowDesktop,
  dockRecycle,
  toggleDockRecycle,
  dockDrives,
  toggleDockDrive,
  hiddenDockApps,
  restoreHiddenDockApp,
  dockIndicator,
  changeDockIndicator,
  dockMenuItems,
  toggleDockMenuItem,
  dockIconOnly,
  toggleDockIconOnly,
  dockAdaptive,
  toggleDockAdaptive,
  startIcon,
  handleStartIconChange,
  dockWinNumberEnabled,
  toggleDockWinNumber,
  dockMixedReorder,
  toggleDockMixedReorder,
  monitors,
  dockMonitorMode,
  setDockMonitorModeValue,
  dockMonitorId,
  setDockMonitorIdValue,
  dockModeByMonitor,
  setDockModeForMonitor,
  replaceDockModes,
}: DockTabProps) {
  const t = useT();
  const [dockIconSize, setDockIconSize] = useSyncedSetting("nectar-dock-icon-size", parseClampedNumber(28, 48, 36), (v) => String(v), { debounceMs: 120 });
  const [dockIconGap, setDockIconGap] = useSyncedSetting("nectar-dock-icon-gap", parseClampedNumber(6, 18, 12), (v) => String(v), { debounceMs: 120 });
  const [dockHoverScale, setDockHoverScale] = useSyncedSetting("nectar-dock-hover-scale", parseClampedNumber(1.0, 1.35, 1.1, 2), (v) => String(v), { debounceMs: 120 });
  const [dockClassicAnimations, setDockClassicAnimations] = useSyncedSetting("nectar-dock-classic-animations", parseBoolFalse, (v) => String(v));
  const [dockWaveEnabled, setDockWaveEnabled] = useSyncedSetting("nectar-dock-wave-enabled", parseBoolTrue, (v) => String(v));
  const [dockLaunchBounce, setDockLaunchBounce] = useSyncedSetting("nectar-dock-launch-bounce", parseBoolTrue, (v) => String(v));
  const [previewPrecapture, setPreviewPrecapture] = useSyncedSetting("nectar-preview-precapture", parseBoolFalse, (v) => String(v));
  const [trayBarAutoClose, setTrayBarAutoClose] = useSyncedSetting("nectar-traybar-autoclose", parseBoolTrue, (v) => String(v));
  const perMonitor = usePerMonitor(dockMode, dockModeByMonitor, replaceDockModes, monitors);
  const multiMonitor = dockMonitorMode === "all" && monitors.length > 1;
  const showPerMonitor = multiMonitor && perMonitor.enabled;
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [trayBarEnabled, setTrayBarEnabled] = useState(
    () => localStorage.getItem("nectar-tray-bar-enabled") !== "false"
  );
  const [trayBarLayout, setTrayBarLayout] = useState(
    () => localStorage.getItem("nectar-tray-bar-layout") || "grid"
  );
  const [trayBarHotkey, setTrayBarHotkey] = useState(
    () => localStorage.getItem("nectar-traybar-hotkey") ?? "Alt+Shift+T"
  );
  const [trayHostStatus, setTrayHostStatus] = useState<TrayHostStatus>("active");
  const [hotkeyStatus, refreshHotkeyStatus] = useHotkeyStatus(
    `${trayBarHotkey}|${dockEnabled}|${dockTray}|${trayBarEnabled}|${legacyMode}`
  );
  const trayHotkeyConflict =
    !legacyMode &&
    dockEnabled &&
    dockTray &&
    trayBarEnabled &&
    isHotkeyConflicted(
      trayBarHotkey,
      hotkeyStatus?.traybar_ok,
      hotkeyStatus?.traybar_shortcut
    );

  const saveTraySetting = (key: string, value: string) => {
    localStorage.setItem(key, value);
    return bridgeInvoke("save_setting", { key, value }).catch(() => {});
  };

  useEffect(() => {
    let cancelled = false;
    bridgeInvoke<DriveInfo[]>("get_drives").then((d) => !cancelled && setDrives(d)).catch(() => {});
    bridgeInvoke<Record<string, unknown>>("load_settings")
      .then((s) => {
        if (cancelled || !s) return;
        if (s["nectar-tray-bar-enabled"] !== undefined) {
          setTrayBarEnabled(String(s["nectar-tray-bar-enabled"]) !== "false");
        }
        if (s["nectar-tray-bar-layout"] != null) {
          setTrayBarLayout(String(s["nectar-tray-bar-layout"]) || "grid");
        }
        if (s["nectar-traybar-hotkey"] !== undefined && s["nectar-traybar-hotkey"] !== null) {
          setTrayBarHotkey(String(s["nectar-traybar-hotkey"]));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (legacyMode || !dockEnabled || !dockTray) return;
    let cancelled = false;
    const queryStatus = () => {
      bridgeInvoke<TrayHostStatus | null>("get_tray_host_status")
        .then((res) => {
          if (!cancelled && (res === "active" || res === "blocked_by_zbid" || res === "stopped")) {
            setTrayHostStatus(res);
          }
        })
        .catch(() => {});
    };
    queryStatus();
    const timer = window.setTimeout(queryStatus, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [legacyMode, dockEnabled, dockTray, trayBarEnabled]);

  useSettingsSync({
    "nectar-tray-bar-enabled": (v) => setTrayBarEnabled(v !== false && v !== "false"),
    "nectar-tray-bar-layout": (v) => setTrayBarLayout(v === "bar" ? "bar" : "grid"),
    "nectar-traybar-hotkey": (v) =>
      setTrayBarHotkey(v === null || v === undefined ? "Alt+Shift+T" : String(v)),
  });

  const handleStartIconUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      handleStartIconChange(`custom:${reader.result as string}`);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  return (
    <>
      <SettingSection id="dock-main" title={t("dock.group")} defaultOpen>
        <SettingRow icon={Monitor} label={t("dock.enable")} desc={t("dock.enable.desc")}>
          <label className="toggle-switch">
            <input type="checkbox" checked={dockEnabled} onChange={toggleDock} />
            <span className="slider"></span>
          </label>
        </SettingRow>

        {dockEnabled && (
          <>
            {!showPerMonitor && (
              <SettingRow
                icon={dockMode === "fixed" ? EyeOff : Eye}
                label={t("dock.behavior")}
                desc={t(`dock.behavior.${dockMode}.desc`)}
              >
                <Dropdown
                  value={dockMode}
                  onChange={setDockModeValue}
                  options={[
                    { value: "fixed", label: t("common.fixed") },
                    { value: "smart", label: t("common.smart") },
                    { value: "peek", label: t("common.peek") },
                  ]}
                />
              </SettingRow>
            )}

            {dockMode === "fixed" && (
              <SettingRow
                icon={PanelBottom}
                label={t("dock.reserveSpace")}
                desc={t("dock.reserveSpace.desc")}
              >
                <label className="toggle-switch">
                  <input type="checkbox" checked={dockReserveSpace} onChange={toggleDockReserveSpace} />
                  <span className="slider"></span>
                </label>
              </SettingRow>
            )}

            {dockMode !== "fixed" && <HideDelay />}
            {dockMode !== "fixed" && <EdgeArea settingKey="nectar-dock-edge-area" />}

            <SettingRow icon={MonitorCheck} label={t("common.showOn")} desc={t("dock.showOn.desc")}>
              <Dropdown
                value={dockMonitorMode}
                onChange={(v) => setDockMonitorModeValue(v as MonitorMode)}
                options={[
                  { value: "primary", label: t("common.monitors.primary") },
                  { value: "all", label: t("common.monitors.all") },
                  { value: "specific", label: t("common.monitors.specific") },
                ]}
              />
            </SettingRow>

            {dockMonitorMode === "specific" && (
              <SettingRow icon={Monitor} label={t("common.monitor")} desc={t("dock.monitor.desc")}>
                <Dropdown
                  value={dockMonitorId}
                  onChange={setDockMonitorIdValue}
                  placeholder={monitors.length === 0 ? t("common.loading") : undefined}
                  options={monitors.map((m) => ({
                    value: m.id,
                    label: `${m.label}${m.is_primary ? ` (${t("common.primary")})` : ""}`,
                  }))}
                />
              </SettingRow>
            )}

            {multiMonitor && (
              <SettingRow icon={Monitor} label={t("common.perMonitor")} desc={t("common.perMonitor.desc")}>
                <label className="toggle-switch">
                  <input type="checkbox" checked={perMonitor.enabled} onChange={perMonitor.toggle} />
                  <span className="slider"></span>
                </label>
              </SettingRow>
            )}

            {showPerMonitor && monitors.map((m) => (
              <SettingRow key={m.id} icon={Monitor} label={t("common.monitorBehavior", { name: m.label })} desc={m.is_primary ? t("common.primaryMonitor") : undefined}>
                <Dropdown
                  value={dockModeByMonitor[m.id] || dockMode}
                  onChange={(v) => setDockModeForMonitor(m.id, v)}
                  options={[
                    { value: "fixed", label: t("common.fixed") },
                    { value: "smart", label: t("common.smart") },
                    { value: "peek", label: t("common.peek") },
                  ]}
                />
              </SettingRow>
            ))}

          </>
        )}
      </SettingSection>

      {dockEnabled && (
        <>
          <SettingSection id="dock-shortcuts" title={t("dock.section.shortcuts")}>
            <SettingRow icon={Eye} label={t("dock.previews")} desc={t("dock.previews.desc")} settingKey="dock.previews">
              <label className="toggle-switch">
                <input type="checkbox" checked={dockPreviewEnabled} onChange={toggleDockPreview} />
                <span className="slider"></span>
              </label>
            </SettingRow>

            {dockPreviewEnabled && <PreviewDelay />}

            {dockPreviewEnabled && (
              <SettingRow icon={Zap} label={t("dock.previewPrecapture")} desc={t("dock.previewPrecapture.desc")} settingKey="dock.previewPrecapture">
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={previewPrecapture}
                    onChange={() => void setPreviewPrecapture(!previewPrecapture)}
                  />
                  <span className="slider"></span>
                </label>
              </SettingRow>
            )}

            {!legacyMode && (
              <SettingRow icon={BellDot} label={t("dock.attention")} desc={t("dock.attention.desc")}>
                <label className="toggle-switch">
                  <input type="checkbox" checked={dockAttentionEnabled} onChange={toggleDockAttention} />
                  <span className="slider"></span>
                </label>
              </SettingRow>
            )}

            <SettingRow icon={SquareTerminal} label={t("dock.console")} desc={t("dock.console.desc")}>
              <label className="toggle-switch">
                <input type="checkbox" checked={dockConsoleWindows} onChange={toggleDockConsoleWindows} />
                <span className="slider"></span>
              </label>
            </SettingRow>

            <SettingRow icon={Search} label={t("dock.search")} desc={t("dock.search.desc")}>
              <label className="toggle-switch">
                <input type="checkbox" checked={dockSearchEnabled} onChange={toggleDockSearch} />
                <span className="slider"></span>
              </label>
            </SettingRow>

            {!legacyMode && dockSearchEnabled && (
              <SettingRow
                icon={TextSearch}
                label={t("dock.searchWith")}
                desc={t(`dock.searchWith.${SEARCH_PROVIDERS.includes(dockSearchProvider) ? dockSearchProvider : "windows"}.desc`)}
              >
                <Dropdown
                  value={dockSearchProvider}
                  onChange={handleDockSearchProviderChange}
                  options={SEARCH_PROVIDERS.map((value) => ({ value, label: t(`dock.searchWith.${value}`) }))}
                />
              </SettingRow>
            )}

            {!legacyMode && dockSearchEnabled && (dockSearchProvider === "raycast" || dockSearchProvider === "shortcut") && (
              <SettingRow
                icon={Keyboard}
                label={t("dock.searchShortcut")}
                desc={t(dockSearchProvider === "raycast" ? "dock.searchShortcut.descRaycast" : "dock.searchShortcut.desc")}
              >
                <ShortcutField
                  value={dockSearchShortcut}
                  placeholder={dockSearchProvider === "raycast" ? "Alt+Space" : t("dock.searchShortcut.placeholder")}
                  onCommit={handleDockSearchShortcutChange}
                />
              </SettingRow>
            )}

            <SettingRow icon={CalendarDays} label={t("dock.calendar")} desc={t("dock.calendar.desc")}>
              <label className="toggle-switch">
                <input type="checkbox" checked={dockCalendarEnabled} onChange={toggleDockCalendar} />
                <span className="slider"></span>
              </label>
            </SettingRow>

            {!legacyMode && (
              <>
                <SettingRow icon={ChevronUp} label={t("dock.tray")} desc={t("dock.tray.desc")}>
                  <label className="toggle-switch">
                    <input type="checkbox" checked={dockTray} onChange={toggleDockTray} />
                    <span className="slider"></span>
                  </label>
                </SettingRow>

                {dockTray && (
                  <>
                    <SettingRow
                      icon={PanelBottom}
                      label={t("dock.trayBar")}
                      desc={t("dock.trayBar.desc")}
                      divider={trayHostStatus !== "blocked_by_zbid"}
                    >
                      <label className="toggle-switch">
                        <input
                          type="checkbox"
                          checked={trayBarEnabled}
                          onChange={() => {
                            const next = !trayBarEnabled;
                            setTrayBarEnabled(next);
                            saveTraySetting("nectar-tray-bar-enabled", String(next));
                          }}
                        />
                        <span className="slider"></span>
                      </label>
                    </SettingRow>
                    {trayHostStatus === "blocked_by_zbid" && (
                      <>
                        <div className="settings-inline-hint" role="note">
                          <Info size={13} />
                          <span>{t("dock.trayZbidHint")}</span>
                        </div>
                        <div className="setting-divider" />
                      </>
                    )}

                    {trayBarEnabled && (
                      <>
                        <SettingRow icon={Columns3} label={t("dock.trayBarLayout")} desc={t("dock.trayBarLayout.desc")}>
                          <Dropdown
                            value={trayBarLayout}
                            onChange={(val) => {
                              setTrayBarLayout(val);
                              saveTraySetting("nectar-tray-bar-layout", val);
                            }}
                            options={[
                              { value: "grid", label: t("dock.trayBarLayout.grid") },
                              { value: "bar", label: t("dock.trayBarLayout.bar") },
                            ]}
                          />
                        </SettingRow>

                        <SettingRow
                          icon={Keyboard}
                          label={t("dock.trayBarHotkey")}
                          desc={t("dock.trayBarHotkey.desc")}
                          divider={!trayHotkeyConflict}
                        >
                          <ShortcutRecorder
                            value={trayBarHotkey}
                            onCommit={(next) => {
                              setTrayBarHotkey(next);
                              saveTraySetting("nectar-traybar-hotkey", next).then(
                                refreshHotkeyStatus
                              );
                            }}
                          />
                        </SettingRow>
                        {trayHotkeyConflict && (
                          <>
                            <div className="settings-inline-warning" role="alert">
                              <AlertTriangle size={13} />
                              <span>{t("settings.hotkeyConflict")}</span>
                            </div>
                            <div className="setting-divider" />
                          </>
                        )}

                        <SettingRow icon={LogOut} label={t("dock.trayBarAutoClose")} desc={t("dock.trayBarAutoClose.desc")} settingKey="dock.trayBarAutoClose">
                          <label className="toggle-switch">
                            <input
                              type="checkbox"
                              checked={trayBarAutoClose}
                              onChange={() => void setTrayBarAutoClose(!trayBarAutoClose)}
                            />
                            <span className="slider"></span>
                          </label>
                        </SettingRow>
                      </>
                    )}
                  </>
                )}

                <SettingRow icon={LayoutGrid} label={t("dock.taskView")} desc={t("dock.taskView.desc")}>
                  <label className="toggle-switch">
                    <input type="checkbox" checked={dockTaskView} onChange={toggleDockTaskView} />
                    <span className="slider"></span>
                  </label>
                </SettingRow>

                <SettingRow icon={Monitor} label={t("dock.showDesktop")} desc={t("dock.showDesktop.desc")}>
                  <label className="toggle-switch">
                    <input type="checkbox" checked={dockShowDesktop} onChange={toggleDockShowDesktop} />
                    <span className="slider"></span>
                  </label>
                </SettingRow>

                <SettingRow icon={Trash2} label={t("dock.recycleBin")} desc={t("dock.recycleBin.desc")}>
                  <label className="toggle-switch">
                    <input type="checkbox" checked={dockRecycle} onChange={toggleDockRecycle} />
                    <span className="slider"></span>
                  </label>
                </SettingRow>

                {drives.map((d) => (
                  <SettingRow
                    key={d.letter}
                    icon={HardDrive}
                    label={t("dock.drive", { letter: d.letter })}
                    desc={d.label ? `${d.label}${d.removable ? ` (${t("dock.drive.removableSuffix")})` : ""}` : d.removable ? t("dock.drive.removable") : t("dock.drive.local")}
                  >
                    <label className="toggle-switch">
                      <input type="checkbox" checked={dockDrives.includes(d.letter)} onChange={() => toggleDockDrive(d.letter)} />
                      <span className="slider"></span>
                    </label>
                  </SettingRow>
                ))}
              </>
            )}

          </SettingSection>

          {hiddenDockApps.length > 0 && (
            <SettingSection id="dock-hidden" title={t("dock.hidden.title")}>
              {hiddenDockApps.map((h) => (
                <SettingRow key={h.id} icon={EyeOff} label={h.name} desc={t("dock.hidden.desc")}>
                  <button className="agent-sound-btn" onClick={() => restoreHiddenDockApp(h.id)}>{t("dock.hidden.restore")}</button>
                </SettingRow>
              ))}
            </SettingSection>
          )}

          <SettingSection id="dock-menu" title={t("dock.menu.title")}>
            {([
              ["calendar", CalendarDays, "dockmenu.openCalendar"],
              ["settings", SettingsIcon, "dockmenu.openSettings"],
              ["taskmgr", Activity, "dockmenu.taskManager"],
              ["restart", RotateCcw, "general.restart"],
              ["clearicons", Eraser, "dockmenu.clearIconCache"],
              ["quit", Power, "general.quit"],
            ] as const).map(([id, Icon, labelKey]) => (
              <SettingRow key={id} icon={Icon} label={t(labelKey)}>
                <label className="toggle-switch">
                  <input type="checkbox" checked={dockMenuItems.includes(id)} onChange={() => toggleDockMenuItem(id)} />
                  <span className="slider"></span>
                </label>
              </SettingRow>
            ))}
          </SettingSection>

          <SettingSection id="dock-style" title={t("dock.section.style")}>
            <SettingRow icon={Scaling} label={t("dock.iconSize")} desc={t("dock.iconSize.desc", { size: dockIconSize })} settingKey="dock.iconSize">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="range"
                  min="28"
                  max="48"
                  step="2"
                  value={dockIconSize}
                  onChange={(e) => void setDockIconSize(parseInt(e.target.value, 10))}
                  className="settings-slider"
                />
                <span className="setting-value-badge">{dockIconSize}px</span>
              </div>
            </SettingRow>

            <SettingRow icon={MoveHorizontal} label={t("dock.iconGap")} desc={t("dock.iconGap.desc", { gap: dockIconGap })} settingKey="dock.iconGap">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="range"
                  min="6"
                  max="18"
                  step="2"
                  value={dockIconGap}
                  onChange={(e) => void setDockIconGap(parseInt(e.target.value, 10))}
                  className="settings-slider"
                />
                <span className="setting-value-badge">{dockIconGap}px</span>
              </div>
            </SettingRow>

            <SettingRow icon={MousePointerClick} label={t("dock.hoverScale")} desc={t("dock.hoverScale.desc", { percent: Math.round(dockHoverScale * 100) })} settingKey="dock.hoverScale">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="range"
                  min="1.0"
                  max="1.35"
                  step="0.05"
                  value={dockHoverScale}
                  onChange={(e) => void setDockHoverScale(parseFloat(e.target.value))}
                  className="settings-slider"
                />
                <span className="setting-value-badge">{Math.round(dockHoverScale * 100)}%</span>
              </div>
            </SettingRow>

            <SettingRow icon={History} label={t("dock.classicAnimations")} desc={t("dock.classicAnimations.desc")} settingKey="dock.classicAnimations">
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={dockClassicAnimations}
                  onChange={() => void setDockClassicAnimations(!dockClassicAnimations)}
                />
                <span className="slider"></span>
              </label>
            </SettingRow>

            <SettingRow icon={Waves} label={t("dock.wave")} desc={t("dock.wave.desc")} settingKey="dock.wave">
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={!dockClassicAnimations && dockWaveEnabled}
                  disabled={dockClassicAnimations}
                  onChange={() => void setDockWaveEnabled(!dockWaveEnabled)}
                />
                <span className="slider"></span>
              </label>
            </SettingRow>

            <SettingRow icon={ArrowUpFromLine} label={t("dock.bounce")} desc={t("dock.bounce.desc")} settingKey="dock.bounce">
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={!dockClassicAnimations && dockLaunchBounce}
                  disabled={dockClassicAnimations}
                  onChange={() => void setDockLaunchBounce(!dockLaunchBounce)}
                />
                <span className="slider"></span>
              </label>
            </SettingRow>

            <SettingRow icon={Square} label={t("dock.iconOnly")} desc={t("dock.iconOnly.desc")} settingKey="dock.iconOnly">
              <label className="toggle-switch">
                <input type="checkbox" checked={dockIconOnly} onChange={toggleDockIconOnly} />
                <span className="slider"></span>
              </label>
            </SettingRow>

            <SettingRow icon={PanelBottom} label={t("dock.indicator")} desc={t("dock.indicator.desc")} settingKey="dock.indicator">
              <Dropdown
                value={dockIndicator}
                options={[
                  { value: "dots", label: t("dock.indicator.dots") },
                  { value: "pill", label: t("dock.indicator.pill") },
                  { value: "bar", label: t("dock.indicator.bar") },
                  { value: "glow", label: t("dock.indicator.glow") },
                  { value: "fixed", label: t("dock.indicator.fixed") },
                  { value: "none", label: t("dock.indicator.none") },
                ]}
                onChange={changeDockIndicator}
              />
            </SettingRow>

            <SettingRow icon={Keyboard} label={t("dock.winNumber")} desc={t("dock.winNumber.desc")}>
              <label className="toggle-switch">
                <input type="checkbox" checked={dockWinNumberEnabled} onChange={toggleDockWinNumber} />
                <span className="slider"></span>
              </label>
            </SettingRow>

            {dockMode === "fixed" && (
              <SettingRow icon={Maximize2} label={t("dock.adaptive")} desc={t("dock.adaptive.desc")}>
                <label className="toggle-switch">
                  <input type="checkbox" checked={dockAdaptive} onChange={toggleDockAdaptive} />
                  <span className="slider"></span>
                </label>
              </SettingRow>
            )}

            <SettingRow
              icon={Shuffle}
              label={t("dock.mixed")}
              desc={dockMixedReorder ? t("dock.mixed.on") : t("dock.mixed.off")}
            >
              <label className="toggle-switch">
                <input type="checkbox" checked={dockMixedReorder} onChange={toggleDockMixedReorder} />
                <span className="slider"></span>
              </label>
            </SettingRow>

            <div className="setting-item" style={{ flexDirection: "column", alignItems: "flex-start", gap: "10px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px", width: "100%" }}>
                <div className="setting-icon-bg">
                  <Sparkles size={14} strokeWidth={1.5} />
                </div>
                <div className="setting-info">
                  <span className="setting-label">{t("dock.startIcon")}</span>
                  <span className="setting-desc">{t("dock.startIcon.desc")}</span>
                </div>
              </div>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", paddingLeft: "34px" }}>
                {START_ICON_PRESETS.map((icon) => (
                  <button
                    key={icon.key}
                    type="button"
                    onClick={() => handleStartIconChange(icon.key)}
                    className={`start-icon-tile${startIcon === icon.key ? " active" : ""}`}
                    title={icon.label}
                    aria-label={icon.label}
                  >
                    <img src={icon.src} alt={icon.label} style={{ width: "100%", height: "100%", objectFit: "contain" }} draggable={false} />
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => document.getElementById("start-icon-file-input")?.click()}
                  className={`start-icon-tile${startIcon.startsWith("custom:") ? " active" : ""}`}
                  title={t("dock.startIcon.custom")}
                  aria-label={t("dock.startIcon.custom")}
                >
                  {startIcon.startsWith("custom:") ? (
                    <img
                      src={startIcon.replace("custom:", "")}
                      alt={t("dock.startIcon.customAlt")}
                      style={{ width: "100%", height: "100%", objectFit: "contain", borderRadius: "8px" }}
                      draggable={false}
                    />
                  ) : (
                    <span style={{ fontSize: "20px" }}>+</span>
                  )}
                </button>
                {startIcon !== "default" && (
                  <button
                    type="button"
                    onClick={() => handleStartIconChange("default")}
                    className="start-icon-tile"
                    title={t("dock.startIcon.reset")}
                    aria-label={t("dock.startIcon.reset")}
                  >
                    <RotateCcw size={18} strokeWidth={1.5} />
                  </button>
                )}
              </div>
              <input
                id="start-icon-file-input"
                type="file"
                accept=".png,.ico,.jpg,.jpeg,.svg,.bmp"
                style={{ display: "none" }}
                onChange={handleStartIconUpload}
              />
            </div>
          </SettingSection>
        </>
      )}
    </>
  );
}
