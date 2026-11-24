import { useState, useEffect, useCallback, useRef } from "react";
import { parseCcLayout, parsePanelOrder, type CcLayout, type PanelId } from "../panelOrder";
import { bridgeEmit, bridgeInvoke, bridgeListen, isTauriRuntime } from "../utils/tauriBridge";
import {
  clearSettingsPreservingOnboarding,
  notifyLocalSettingChanges,
  syncSettingsMapToLocalStorage,
} from "../utils/settingsHydration";
import { getVersion } from "@tauri-apps/api/app";
import type { UpdateCheckResult } from "../updater";
import { clearLocalSettingWrites, markLocalSettingWrites, useSettingsSync } from "../hooks/useSettingsSync";
import { hexToHsl, DEFAULT_ACCENT_COLOR, STYLE_OPACITY, refreshThemeFromStorage, type ThemePreset } from "../theme";
import { sanitizeThemeSettings, type ThemeExportKey } from "../themePresets";
import { DEFAULT_DUAL_CLOCK_ZONE } from "../dualClock";
import { normalizeHex } from "./ColorPalettePicker";
import type { WidgetConfig, MonitorInfo, MonitorMode } from "./types";

const DEFAULT_SELECTION_COLOR = "#0a84ff";

function normalizeHexOrDefault(raw: string | null | undefined, fallback: string): string {
  return normalizeHex(raw) ?? fallback;
}

function saveSetting(key: string, value: string) {
  localStorage.setItem(key, value);
  bridgeInvoke("save_setting", { key, value }).catch(console.error);
}

function readBool(val: string | null): boolean {
  return val === "true";
}

export const DOCK_MENU_IDS = ["calendar", "settings", "taskmgr", "restart", "clearicons", "quit"];
const VALID_DOCK_INDICATORS = new Set(["dots", "pill", "bar", "glow", "fixed", "none"]);

function parseMenuItems(val: unknown): string[] {
  try {
    const parsed = typeof val === "string" ? JSON.parse(val) : val;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => DOCK_MENU_IDS.includes(id)) : DOCK_MENU_IDS;
  } catch {
    return DOCK_MENU_IDS;
  }
}

export interface HiddenDockApp { id: string; name: string }

function parseHiddenApps(val: unknown): HiddenDockApp[] {
  try {
    const parsed = typeof val === "string" ? JSON.parse(val) : val;
    return Array.isArray(parsed)
      ? parsed.filter((h): h is HiddenDockApp => !!h && typeof h.id === "string" && typeof h.name === "string")
      : [];
  } catch {
    return [];
  }
}

const readBoolDefaultTrue = (v: unknown): boolean => v !== false && v !== "false";
const readBoolDefaultFalse = (v: unknown): boolean => v === true || v === "true";
const readFiniteNumber = (fallback: number) => (v: unknown): number => {
  if (v === null || v === undefined || v === "") return fallback;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : fallback;
};
const readFiniteInt = (fallback: number) => (v: unknown): number => {
  if (v === null || v === undefined || v === "") return fallback;
  const n = typeof v === "number" ? Math.trunc(v) : parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
};
const DEFAULT_STATUS_WIDGETS: WidgetConfig = { left: ["weather"], right: ["layout", "battery"] };

function parseStatusWidgets(val: unknown): WidgetConfig {
  try {
    const parsed = typeof val === "string" ? JSON.parse(val) : val;
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as WidgetConfig).left) &&
      Array.isArray((parsed as WidgetConfig).right)
    ) {
      return {
        ...(parsed as WidgetConfig),
        left: (parsed as WidgetConfig).left.slice(0, 2),
        right: (parsed as WidgetConfig).right.slice(0, 2),
      };
    }
  } catch {}
  return DEFAULT_STATUS_WIDGETS;
}

function parseModeByMonitor(val: unknown): Record<string, string> {
  if (!val) return {};
  try {
    const parsed = typeof val === "string" ? JSON.parse(val) : val;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

function parseDrives(val: unknown): string[] {
  try {
    const parsed = typeof val === "string" ? JSON.parse(val) : val;
    return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === "string") : [];
  } catch {
    return [];
  }
}

export function useSettings() {
  const [autostart, setAutostart] = useState(false);
  const [weatherEnabled, setWeatherEnabled] = useState(true);
  const [calendarEnabled, setCalendarEnabled] = useState(true);
  const [timerEnabled, setTimerEnabled] = useState(true);
  const [timerSoundEnabled, setTimerSoundEnabled] = useState(true);
  const [notchTimerProgress, setNotchTimerProgress] = useState(
    () => localStorage.getItem("nectar-notch-timer-progress") !== "false"
  );
  const [stopwatchEnabled, setStopwatchEnabled] = useState(true);
  const [dualClockEnabled, setDualClockEnabled] = useState(
    () => localStorage.getItem("nectar-dual-clock-enabled") === "true"
  );
  const [dualClockZone, setDualClockZone] = useState(
    () => localStorage.getItem("nectar-dual-clock-zone") || DEFAULT_DUAL_CLOCK_ZONE
  );
  const [dualClockLabel, setDualClockLabel] = useState(
    () => localStorage.getItem("nectar-dual-clock-label") || DEFAULT_DUAL_CLOCK_ZONE
  );
  const [musicModeEnabled, setMusicModeEnabled] = useState(true);
  const [musicCompactNotch, setMusicCompactNotch] = useState(true);
  const [agentApi, setAgentApi] = useState(() => localStorage.getItem("nectar-agent-api") === "true");
  const [notchScrollVolume, setNotchScrollVolume] = useState(
    () => localStorage.getItem("nectar-notch-scroll-volume") === "true"
  );
  const [rememberMode, setRememberMode] = useState(
    () => localStorage.getItem("nectar-notch-remember-mode") === "true"
  );
  const [shelfPersist, setShelfPersist] = useState(
    () => localStorage.getItem("nectar-shelf-persist") === "true"
  );
  const [volumeOverlayEnabled, setVolumeOverlayEnabled] = useState(true);
  const [volumeEdgeEnabled, setVolumeEdgeEnabled] = useState(
    () => localStorage.getItem("nectar-volume-edge-enabled") !== "false"
  );
  const [brightnessOverlayEnabled, setBrightnessOverlayEnabled] = useState(
    () => localStorage.getItem("nectar-brightness-overlay-enabled") !== "false"
  );
  const [brightnessEdgeEnabled, setBrightnessEdgeEnabled] = useState(
    () => localStorage.getItem("nectar-brightness-edge-enabled") !== "false"
  );
  const [mediaAmbienceEnabled, setMediaAmbienceEnabled] = useState(true);
  const [mediaCompactGlowEnabled, setMediaCompactGlowEnabled] = useState(true);
  const [mediaArtworkThemeEnabled, setMediaArtworkThemeEnabled] = useState(
    () => localStorage.getItem("nectar-media-artwork-theme") === "true"
  );
  const [mediaLayout, setMediaLayout] = useState<"classic" | "compact">(
    () => (localStorage.getItem("nectar-media-layout") as "classic" | "compact") || "classic"
  );
  const [cornersEnabled, setCornersEnabled] = useState(
    () => localStorage.getItem("nectar-corners-enabled") === "true"
  );
  const [showUpdateIndicator, setShowUpdateIndicator] = useState(
    () => localStorage.getItem("nectar-show-update-indicator") !== "false"
  );
  const [timeFormat24h, setTimeFormat24h] = useState(
    () => localStorage.getItem("nectar-time-format-24h") === "true"
  );
  const [legacyMode, setLegacyMode] = useState(
    () => localStorage.getItem("nectar-legacy-mode") === "true"
  );
  const [ramSaver, setRamSaver] = useState(() => {
    const prof = localStorage.getItem("nectar-perf-profile");
    if (prof && prof.trim() !== "") return prof.trim().toLowerCase() === "eco";
    return localStorage.getItem("nectar-ram-saver") === "true";
  });
  const [ramUltra, setRamUltra] = useState(
    () => localStorage.getItem("nectar-ram-ultra") === "true"
  );
  const [tempUnitFahrenheit, setTempUnitFahrenheit] = useState(false);
  const [cityName, setCityName] = useState("");
  const [cityQuery, setCityQuery] = useState("");
  const [citySearchResults, setCitySearchResults] = useState<
    Array<{ name: string; country: string; latitude: number; longitude: number }>
  >([]);
  const [showCityDropdown, setShowCityDropdown] = useState(false);
  const [statusWidgets, setStatusWidgets] = useState<WidgetConfig>({
    left: ["weather"],
    right: ["layout", "battery"],
  });
  const [dockEnabled, setDockEnabled] = useState(true);
  const [dockPreviewEnabled, setDockPreviewEnabled] = useState(true);
  const [dockAttentionEnabled, setDockAttentionEnabled] = useState(true);
  const [dockConsoleWindows, setDockConsoleWindows] = useState(() => localStorage.getItem("nectar-dock-console-windows") === "true");
  const [dockSearchEnabled, setDockSearchEnabled] = useState(true);
  const [dockSearchProvider, setDockSearchProvider] = useState(
    () => localStorage.getItem("nectar-dock-search-provider") || "nectar"
  );
  const [dockSearchShortcut, setDockSearchShortcut] = useState(
    () => localStorage.getItem("nectar-dock-search-shortcut") || ""
  );
  const [dockCalendarEnabled, setDockCalendarEnabled] = useState(true);
  const [dockTray, setDockTray] = useState(
    () => localStorage.getItem("nectar-dock-tray-enabled") !== "false"
  );
  const [dockShowDesktop, setDockShowDesktop] = useState(
    () => localStorage.getItem("nectar-dock-show-desktop-corner") === "true"
  );
  const [panelControlCenter, setPanelControlCenter] = useState(
    () => localStorage.getItem("nectar-panel-control-center-enabled") !== "false"
  );
  const [panelOrder, setPanelOrder] = useState<PanelId[] | null>(
    () => parsePanelOrder(localStorage.getItem("nectar-panel-order"))
  );
  const [ccLayout, setCcLayout] = useState<CcLayout>(
    () => parseCcLayout(localStorage.getItem("nectar-cc-layout"))
  );
  const [panelStatus, setPanelStatus] = useState(
    () => localStorage.getItem("nectar-panel-status-enabled") !== "false"
  );
  const [panelShelf, setPanelShelf] = useState(
    () => localStorage.getItem("nectar-panel-shelf-enabled") !== "false"
  );
  const [dockTaskView, setDockTaskView] = useState(
    () => localStorage.getItem("nectar-dock-taskview-enabled") === "true"
  );
  const [dockRecycle, setDockRecycle] = useState(
    () => localStorage.getItem("nectar-dock-recycle-enabled") === "true"
  );
  const [dockMenuItems, setDockMenuItems] = useState<string[]>(() => parseMenuItems(localStorage.getItem("nectar-dock-menu-items")));
  const [dockIndicator, setDockIndicator] = useState(() => localStorage.getItem("nectar-dock-indicator") ?? "bar");
  const [panelScrollDirection, setPanelScrollDirection] = useState(() => localStorage.getItem("nectar-notch-scroll-direction") ?? "down");
  const [weekStart, setWeekStart] = useState(() => localStorage.getItem("nectar-week-start") ?? "auto");
  const [dockDrives, setDockDrives] = useState<string[]>(() => parseDrives(localStorage.getItem("nectar-dock-drives")));
  const [hiddenDockApps, setHiddenDockApps] = useState<HiddenDockApp[]>(() => parseHiddenApps(localStorage.getItem("nectar-dock-hidden-apps")));
  const [dockIconOnly, setDockIconOnly] = useState(
    () => localStorage.getItem("nectar-dock-icon-only") === "true"
  );
  const [startIcon, setStartIcon] = useState(
    () => localStorage.getItem("nectar-start-icon") || "default"
  );
  const [dockAdaptive, setDockAdaptive] = useState(
    () => localStorage.getItem("nectar-dock-adaptive") === "true"
  );
  const [dockWinNumberEnabled, setDockWinNumberEnabled] = useState(
    () => localStorage.getItem("nectar-dock-win-number-enabled") !== "false"
  );
  const [dockMixedReorder, setDockMixedReorder] = useState(
    () => localStorage.getItem("nectar-dock-mixed-reorder") === "true"
  );
  const [dockMode, setDockMode] = useState(() => {
    const raw = localStorage.getItem("nectar-dock-mode") || "smart";
    return raw === "auto-hide" ? "smart" : raw;
  });
  const [dockReserveSpace, setDockReserveSpace] = useState(
    () => localStorage.getItem("nectar-dock-reserve-space") === "true"
  );
  const [notchMode, setNotchMode] = useState(() => {
    const raw = localStorage.getItem("nectar-notch-mode") || "fixed";
    return raw === "auto-hide" ? "smart" : raw;
  });
  const [dockMonitorMode, setDockMonitorMode] = useState<MonitorMode>(
    () => (localStorage.getItem("nectar-dock-monitor-mode") as MonitorMode) || "primary"
  );
  const [dockMonitorId, setDockMonitorId] = useState(
    () => localStorage.getItem("nectar-dock-monitor-id") || ""
  );
  const [notchMonitorMode, setNotchMonitorMode] = useState<MonitorMode>(
    () => (localStorage.getItem("nectar-notch-monitor-mode") as MonitorMode) || "primary"
  );
  const [notchMonitorId, setNotchMonitorId] = useState(
    () => localStorage.getItem("nectar-notch-monitor-id") || ""
  );
  const [dockModeByMonitor, setDockModeByMonitor] = useState<Record<string, string>>({});
  const [notchModeByMonitor, setNotchModeByMonitor] = useState<Record<string, string>>({});
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [lowBatteryThreshold, setLowBatteryThreshold] = useState(20);
  const [hasBattery, setHasBattery] = useState(() => localStorage.getItem("nectar-has-battery") !== "false");
  const [updateStatus, setUpdateStatus] = useState<
    "idle" | "checking" | "available" | "uptodate" | "error" | "downloading" | "installing"
  >("idle");
  const [updateVersion, setUpdateVersion] = useState("");
  const [appVersion, setAppVersion] = useState("");
  const [updaterDisabled, setUpdaterDisabled] = useState(true);
  const [autoUpdate, setAutoUpdate] = useState(
    () => localStorage.getItem("nectar-auto-update") === "true"
  );
  const [prereleaseChannel, setPrereleaseChannel] = useState(
    () => localStorage.getItem("nectar-update-channel") === "prerelease"
  );
  const [scale, setScale] = useState(
    () => readFiniteNumber(1.0)(localStorage.getItem("nectar-scale"))
  );
  const [themeMode, setThemeMode] = useState(
    () => localStorage.getItem("nectar-theme-mode") || "dark"
  );
  const [themeColor, setThemeColor] = useState(
    () => normalizeHexOrDefault(localStorage.getItem("nectar-theme-color"), "#007aff")
  );
  const [themeOpacity, setThemeOpacity] = useState(() =>
    Math.max(0.35, Math.min(1.0, readFiniteNumber(0.8)(localStorage.getItem("nectar-theme-opacity"))))
  );
  const [themeSaturation, setThemeSaturation] = useState(
    () => readFiniteNumber(0.5)(localStorage.getItem("nectar-theme-saturation"))
  );
  const [themeBrightness, setThemeBrightness] = useState(
    () => readFiniteNumber(0.15)(localStorage.getItem("nectar-theme-brightness"))
  );
  const [themeStyle, setThemeStyle] = useState(() => localStorage.getItem("nectar-theme-style") || "solid");
  const [themeAccent, setThemeAccent] = useState(() => localStorage.getItem("nectar-theme-accent") || "mono");
  const [themeAccentColor, setThemeAccentColor] = useState(
    () => normalizeHexOrDefault(localStorage.getItem("nectar-theme-accent-color"), DEFAULT_ACCENT_COLOR)
  );
  const [selectionColor, setSelectionColor] = useState(
    () => normalizeHexOrDefault(localStorage.getItem("nectar-selection-color"), DEFAULT_SELECTION_COLOR)
  );
  const [syncWindowsSelection, setSyncWindowsSelection] = useState(
    () => localStorage.getItem("nectar-sync-windows-selection") === "true"
  );
  const [selectionSyncError, setSelectionSyncError] = useState("");
  const [selectionNeedsExplorerRefresh, setSelectionNeedsExplorerRefresh] = useState(false);
  const [explorerRefreshState, setExplorerRefreshState] = useState<"idle" | "refreshing">("idle");
  const [explorerRefreshDone, setExplorerRefreshDone] = useState(false);
  const syncWindowsSelectionRef = useRef(syncWindowsSelection);
  syncWindowsSelectionRef.current = syncWindowsSelection;
  const selectionSyncTimerRef = useRef<number | null>(null);
  const pendingSelectionSyncHexRef = useRef<string | null>(null);
  const explorerRefreshDoneTimerRef = useRef<number | null>(null);
  const localWriteUntilRef = useRef<Map<string, number>>(new Map());
  const pendingBatchRef = useRef<Record<string, string | null>>({});
  const batchTimerRef = useRef<number | null>(null);
  const flushQueueRef = useRef<Promise<void>>(Promise.resolve());
  const themeModeSeqRef = useRef(0);

  const markLocalKeys = useCallback((keys: string[], ttlMs = 700) => {
    const until = Date.now() + ttlMs;
    for (const k of keys) {
      localWriteUntilRef.current.set(k, until);
    }
    markLocalSettingWrites(keys, ttlMs);
  }, []);

  const drainBatchQueue = useCallback(async () => {
    while (true) {
      const entries = pendingBatchRef.current;
      const keys = Object.keys(entries);
      if (keys.length === 0) break;
      pendingBatchRef.current = {};
      markLocalKeys(keys);
      try {
        await bridgeInvoke("save_settings_batch", { entries });
      } catch {
        for (const [k, v] of Object.entries(entries)) {
          await bridgeInvoke("save_setting", { key: k, value: v }).catch(console.error);
        }
      }
    }
  }, [markLocalKeys]);

  const flushSettingsBatch = useCallback(() => {
    if (batchTimerRef.current !== null) {
      window.clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
    }
    const next = flushQueueRef.current.then(drainBatchQueue, drainBatchQueue);
    flushQueueRef.current = next;
    return next;
  }, [drainBatchQueue]);

  const queueSettingsBatch = useCallback(
    (
      entries: Record<string, string | null>,
      options?: { immediate?: boolean; refreshTheme?: boolean }
    ) => {
      const keys = Object.keys(entries);
      if (keys.length === 0) return;
      markLocalKeys(keys);
      for (const [k, v] of Object.entries(entries)) {
        if (v === null || v === undefined) {
          localStorage.removeItem(k);
        } else {
          localStorage.setItem(k, v);
        }
        pendingBatchRef.current[k] = v;
      }
      if (options?.refreshTheme) {
        refreshThemeFromStorage();
      }
      if (options?.immediate) {
        void flushSettingsBatch();
        return;
      }
      if (batchTimerRef.current === null) {
        batchTimerRef.current = window.setTimeout(() => {
          batchTimerRef.current = null;
          void flushSettingsBatch();
        }, 75);
      }
    },
    [flushSettingsBatch, markLocalKeys]
  );

  useEffect(() => {
    const flushNow = () => {
      void flushSettingsBatch();
    };
    window.addEventListener("pointerup", flushNow, true);
    window.addEventListener("blur", flushNow);
    window.addEventListener("beforeunload", flushNow);
    return () => {
      window.removeEventListener("pointerup", flushNow, true);
      window.removeEventListener("blur", flushNow);
      window.removeEventListener("beforeunload", flushNow);
      void flushSettingsBatch();
    };
  }, [flushSettingsBatch]);
  const [exportStatus, setExportStatus] = useState<"idle" | "exporting" | "success" | "error">("idle");
  const [importStatus, setImportStatus] = useState<"idle" | "importing" | "success" | "error">("idle");
  const [resetStatus, setResetStatus] = useState<"idle" | "confirm" | "resetting">("idle");
  const [uninstallStatus, setUninstallStatus] = useState<"idle" | "confirm" | "uninstalling" | "error">("idle");
  const [uninstallError, setUninstallError] = useState("");
  const isMountedRef = useRef(true);
  const exportTimerRef = useRef<number | null>(null);
  const importTimerRef = useRef<number | null>(null);
  const resetTimerRef = useRef<number | null>(null);
  const uninstallTimerRef = useRef<number | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      for (const ref of [exportTimerRef, importTimerRef, resetTimerRef, uninstallTimerRef]) {
        if (ref.current !== null) {
          window.clearTimeout(ref.current);
          ref.current = null;
        }
      }
    };
  }, []);

  const scheduleStatusTimer = useCallback(
    (ref: { current: number | null }, fn: () => void, delayMs: number) => {
      if (ref.current !== null) {
        window.clearTimeout(ref.current);
      }
      ref.current = window.setTimeout(() => {
        ref.current = null;
        if (isMountedRef.current) fn();
      }, delayMs);
    },
    []
  );

  // ── Load all settings from backend + localStorage ──
  const loadAllSettings = useCallback(async (pruneAndReset = false) => {
    try {
      const settings = await bridgeInvoke<Record<string, unknown>>("load_settings");
      if (settings && typeof settings === "object" && !Array.isArray(settings)) {
        syncSettingsMapToLocalStorage(settings, pruneAndReset);
      }

      const getVal = (key: string): string | null => {
        const val = settings && typeof settings === "object" ? settings[key] : undefined;
        if (val !== undefined && val !== null) {
          return typeof val === "object" ? JSON.stringify(val) : String(val);
        }
        return pruneAndReset ? null : localStorage.getItem(key);
      };

      const apply = <T>(
        val: string | null,
        setter: (v: T) => void,
        transform: (v: string) => T,
        fallback?: T
      ) => {
        if (val !== null) setter(transform(val));
        else if (pruneAndReset && fallback !== undefined) setter(fallback);
      };

      apply(getVal("nectar-weather-enabled"), setWeatherEnabled, readBool, true);
      apply(getVal("nectar-calendar-enabled"), setCalendarEnabled, readBool, true);
      apply(getVal("nectar-timer-enabled") ?? getVal("nectar-calendar-enabled"), setTimerEnabled, readBool, true);
      apply(getVal("nectar-timer-sound-enabled"), setTimerSoundEnabled, readBool, true);
      apply(getVal("nectar-notch-timer-progress"), setNotchTimerProgress, readBool, true);
      apply(getVal("nectar-stopwatch-enabled") ?? getVal("nectar-calendar-enabled"), setStopwatchEnabled, readBool, true);
      apply(getVal("nectar-dual-clock-enabled"), setDualClockEnabled, readBool, false);
      apply(getVal("nectar-dual-clock-zone"), setDualClockZone, (v) => v || DEFAULT_DUAL_CLOCK_ZONE, DEFAULT_DUAL_CLOCK_ZONE);
      apply(getVal("nectar-dual-clock-label"), setDualClockLabel, (v) => v || DEFAULT_DUAL_CLOCK_ZONE, DEFAULT_DUAL_CLOCK_ZONE);
      apply(getVal("nectar-music-mode-enabled"), setMusicModeEnabled, readBool, true);
      apply(getVal("nectar-music-compact-notch"), setMusicCompactNotch, readBool, true);
      apply(getVal("nectar-notch-scroll-volume"), setNotchScrollVolume, (v) => v === "true", false);
      apply(getVal("nectar-agent-api"), setAgentApi, (v) => v === "true", false);
      apply(getVal("nectar-shelf-persist"), setShelfPersist, (v) => v === "true", false);
      apply(getVal("nectar-notch-remember-mode"), setRememberMode, (v) => v === "true", false);
      apply(getVal("nectar-volume-overlay-enabled"), setVolumeOverlayEnabled, readBool, true);
      apply(getVal("nectar-brightness-overlay-enabled"), setBrightnessOverlayEnabled, readBool, true);
      apply(getVal("nectar-media-ambience-enabled"), setMediaAmbienceEnabled, readBool, true);
      apply(getVal("nectar-media-compact-glow-enabled"), setMediaCompactGlowEnabled, readBool, true);
      apply(getVal("nectar-media-artwork-theme"), setMediaArtworkThemeEnabled, (v) => v === "true", false);
      apply(getVal("nectar-media-layout"), setMediaLayout, (v) => (v === "compact" ? "compact" : "classic"), "classic");
      apply(getVal("nectar-corners-enabled"), setCornersEnabled, readBool, false);
      apply(getVal("nectar-time-format-24h"), setTimeFormat24h, readBool, false);
      apply(getVal("nectar-legacy-mode"), setLegacyMode, readBool, false);
      apply(getVal("nectar-show-update-indicator"), setShowUpdateIndicator, readBool, true);
      const rawPerf = getVal("nectar-perf-profile");
      if (rawPerf !== undefined && rawPerf !== null && String(rawPerf).trim() !== "") {
        setRamSaver(String(rawPerf).trim().toLowerCase() === "eco");
      } else {
        apply(getVal("nectar-ram-saver"), setRamSaver, (v) => v === "true", false);
      }
      apply(getVal("nectar-ram-ultra"), setRamUltra, readBool, false);
      apply(getVal("nectar-auto-update"), setAutoUpdate, readBool, false);
      apply(getVal("nectar-update-channel"), setPrereleaseChannel, (v) => v === "prerelease", false);
      apply(getVal("nectar-volume-edge-enabled"), setVolumeEdgeEnabled, readBool, true);
      apply(getVal("nectar-brightness-edge-enabled"), setBrightnessEdgeEnabled, readBool, true);
      apply(getVal("nectar-dock-enabled"), setDockEnabled, readBool, true);
      apply(getVal("nectar-dock-preview-enabled"), setDockPreviewEnabled, readBool, true);
      apply(getVal("nectar-dock-attention-enabled"), setDockAttentionEnabled, (v) => v !== "false", true);
      apply(getVal("nectar-dock-console-windows"), setDockConsoleWindows, readBool, false);
      apply(getVal("nectar-dock-search-enabled"), setDockSearchEnabled, readBool, true);
      apply(getVal("nectar-dock-search-provider"), setDockSearchProvider, (v) => v || "nectar", "nectar");
      apply(getVal("nectar-dock-search-shortcut"), setDockSearchShortcut, (v) => v, "");
      apply(getVal("nectar-dock-calendar-enabled"), setDockCalendarEnabled, readBool, true);
      apply(getVal("nectar-dock-tray-enabled"), setDockTray, (v) => v !== "false", true);
      apply(getVal("nectar-dock-taskview-enabled"), setDockTaskView, readBool, false);
      apply(getVal("nectar-dock-show-desktop-corner"), setDockShowDesktop, readBool, false);
      apply(getVal("nectar-panel-control-center-enabled"), setPanelControlCenter, (v) => v !== "false", true);
      apply(getVal("nectar-panel-shelf-enabled"), setPanelShelf, (v) => v !== "false", true);
      apply(getVal("nectar-panel-status-enabled"), setPanelStatus, (v) => v !== "false", true);
      apply(getVal("nectar-panel-order"), setPanelOrder, (v) => parsePanelOrder(v), null);
      apply(getVal("nectar-cc-layout"), setCcLayout, (v) => parseCcLayout(v), {});
      apply(getVal("nectar-dock-recycle-enabled"), setDockRecycle, readBool, false);
      apply(getVal("nectar-week-start"), setWeekStart, (v) => v || "auto", "auto");
      apply(getVal("nectar-notch-scroll-direction"), setPanelScrollDirection, (v) => v || "down", "down");
      apply(getVal("nectar-dock-indicator"), setDockIndicator, (v) => v || "bar", "bar");
      apply(getVal("nectar-dock-menu-items"), setDockMenuItems, parseMenuItems, DOCK_MENU_IDS);
      apply(getVal("nectar-dock-drives"), setDockDrives, parseDrives, []);
      apply(getVal("nectar-dock-hidden-apps"), setHiddenDockApps, parseHiddenApps, []);
      apply(getVal("nectar-dock-icon-only"), setDockIconOnly, readBool, false);
      apply(getVal("nectar-start-icon"), setStartIcon, (v) => v || "default", "default");
      apply(getVal("nectar-dock-adaptive"), setDockAdaptive, readBool, false);
      apply(getVal("nectar-dock-win-number-enabled"), setDockWinNumberEnabled, readBool, true);
      apply(getVal("nectar-dock-mixed-reorder"), setDockMixedReorder, readBool, false);

      apply(getVal("nectar-temp-unit"), setTempUnitFahrenheit, (v) => v === "fahrenheit", false);
      apply(getVal("nectar-scale"), setScale, readFiniteNumber(1.0), 1.0);
      apply(getVal("nectar-low-battery-threshold"), setLowBatteryThreshold, readFiniteInt(20), 20);

      apply(getVal("nectar-notch-mode"), setNotchMode, (v) => (v === "auto-hide" ? "smart" : v || "fixed"), "fixed");
      apply(getVal("nectar-dock-mode"), setDockMode, (v) => (v === "auto-hide" ? "smart" : v || "smart"), "smart");
      apply(getVal("nectar-dock-reserve-space"), setDockReserveSpace, readBool, false);

      apply(getVal("nectar-dock-monitor-mode"), setDockMonitorMode, (v) => (v || "primary") as MonitorMode, "primary");
      apply(getVal("nectar-dock-monitor-id"), setDockMonitorId, (v) => v, "");
      apply(getVal("nectar-notch-monitor-mode"), setNotchMonitorMode, (v) => (v || "primary") as MonitorMode, "primary");
      apply(getVal("nectar-notch-monitor-id"), setNotchMonitorId, (v) => v, "");

      const dockByMonVal = getVal("nectar-dock-mode-by-monitor");
      if (dockByMonVal !== null) {
        setDockModeByMonitor(parseModeByMonitor(dockByMonVal));
      } else if (pruneAndReset) {
        setDockModeByMonitor({});
      }
      const notchByMonVal = getVal("nectar-notch-mode-by-monitor");
      if (notchByMonVal !== null) {
        setNotchModeByMonitor(parseModeByMonitor(notchByMonVal));
      } else if (pruneAndReset) {
        setNotchModeByMonitor({});
      }

      const savedCity = getVal("nectar-weather-city");
      if (savedCity) {
        setCityName(savedCity);
        setCityQuery(savedCity);
      } else if (pruneAndReset) {
        setCityName("");
        setCityQuery("");
      }

      apply(getVal("nectar-theme-mode"), setThemeMode, (v) => v || "dark", "dark");
      apply(getVal("nectar-theme-color"), setThemeColor, (v) => normalizeHexOrDefault(v, "#007aff"), "#007aff");
      apply(
        getVal("nectar-theme-opacity"),
        setThemeOpacity,
        (v) => Math.max(0.35, Math.min(1.0, readFiniteNumber(0.8)(v))),
        0.8
      );
      apply(getVal("nectar-theme-saturation"), setThemeSaturation, readFiniteNumber(0.5), 0.5);
      apply(getVal("nectar-theme-brightness"), setThemeBrightness, readFiniteNumber(0.15), 0.15);
      apply(getVal("nectar-theme-style"), setThemeStyle, (v) => v || "solid", "solid");
      apply(getVal("nectar-theme-accent"), setThemeAccent, (v) => v || "mono", "mono");
      apply(
        getVal("nectar-theme-accent-color"),
        setThemeAccentColor,
        (v) => normalizeHexOrDefault(v, DEFAULT_ACCENT_COLOR),
        DEFAULT_ACCENT_COLOR
      );
      apply(
        getVal("nectar-selection-color"),
        setSelectionColor,
        (v) => normalizeHexOrDefault(v, DEFAULT_SELECTION_COLOR),
        DEFAULT_SELECTION_COLOR
      );
      apply(
        getVal("nectar-sync-windows-selection"),
        setSyncWindowsSelection,
        readBool,
        false
      );

      const widgetsVal = getVal("nectar-status-widgets");
      if (widgetsVal !== null) {
        setStatusWidgets(parseStatusWidgets(widgetsVal));
      } else if (pruneAndReset) {
        setStatusWidgets(DEFAULT_STATUS_WIDGETS);
      }
    } catch (e) {
      console.error("Failed to load settings:", e);
    }
  }, []);

  // ── Initialize on mount ──
  useEffect(() => {
    loadAllSettings();
    if (!isTauriRuntime()) {
      setAppVersion("1.10.0");
      setMonitors([{ id: "primary", label: "Primary Display", x: 0, y: 0, width: 1920, height: 1080, is_primary: true }]);
      return;
    }

    bridgeInvoke<boolean>("get_autostart")
      .then((enabled) => setAutostart(Boolean(enabled)))
      .catch(() => {});

    getVersion()
      .then((ver) => setAppVersion(ver))
      .catch(() => setAppVersion(""));

    bridgeInvoke<boolean>("has_battery").then((present) => {
      const flag = Boolean(present);
      setHasBattery(flag);
      localStorage.setItem("nectar-has-battery", String(flag));
    }).catch(() => {});

    bridgeInvoke<{ updater_disabled?: boolean }>("get_runtime_state")
      .then((st) => {
        const disabled = Boolean(st?.updater_disabled ?? true);
        setUpdaterDisabled(disabled);
        if (!disabled) {
          checkForUpdates(false);
        }
      })
      .catch(() => {
        setUpdaterDisabled(true);
      });
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const refreshMonitors = () => {
      bridgeInvoke<MonitorInfo[]>("get_monitors").then(setMonitors).catch(() => {});
    };
    refreshMonitors();
    let cancelled = false;
    let stopMonitors: (() => void) | undefined;
    bridgeListen("monitors-changed", refreshMonitors).then((fn) => {
      if (cancelled) fn();
      else stopMonitors = fn;
    });
    return () => {
      cancelled = true;
      stopMonitors?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let stopReset: (() => void) | undefined;
    bridgeListen("settings-reset", () => {
      localWriteUntilRef.current.clear();
      clearLocalSettingWrites();
      try {
        clearSettingsPreservingOnboarding();
      } catch {
        // Ignore restricted storage errors
      }
      loadAllSettings(true);
    }).then((fn) => {
      if (cancelled) fn();
      else stopReset = fn;
    });
    return () => {
      cancelled = true;
      stopReset?.();
    };
  }, [loadAllSettings]);

  // ── Sync settings from other windows ──
  useSettingsSync({
    "nectar-dock-mode": (v) =>
      setDockMode(v === "auto-hide" ? "smart" : v ? String(v) : "smart"),
    "nectar-dock-reserve-space": (v) => setDockReserveSpace(readBoolDefaultFalse(v)),
    "nectar-notch-mode": (v) =>
      setNotchMode(v === "auto-hide" ? "smart" : v ? String(v) : "fixed"),
    "nectar-dock-monitor-mode": (v) => setDockMonitorMode((v ? String(v) : "primary") as MonitorMode),
    "nectar-dock-monitor-id": (v) => setDockMonitorId(v === null || v === undefined ? "" : String(v)),
    "nectar-notch-monitor-mode": (v) => setNotchMonitorMode((v ? String(v) : "primary") as MonitorMode),
    "nectar-notch-monitor-id": (v) => setNotchMonitorId(v === null || v === undefined ? "" : String(v)),
    "nectar-dock-mode-by-monitor": (v) => setDockModeByMonitor(parseModeByMonitor(v)),
    "nectar-notch-mode-by-monitor": (v) => setNotchModeByMonitor(parseModeByMonitor(v)),
    "nectar-dock-enabled": (v) => setDockEnabled(readBoolDefaultTrue(v)),
    "nectar-dock-tray-enabled": (v) => setDockTray(readBoolDefaultTrue(v)),
    "nectar-dock-taskview-enabled": (v) => setDockTaskView(readBoolDefaultFalse(v)),
    "nectar-dock-show-desktop-corner": (v) => setDockShowDesktop(readBoolDefaultFalse(v)),
    "nectar-panel-control-center-enabled": (v) => setPanelControlCenter(readBoolDefaultTrue(v)),
    "nectar-panel-shelf-enabled": (v) => setPanelShelf(readBoolDefaultTrue(v)),
    "nectar-panel-status-enabled": (v) => setPanelStatus(readBoolDefaultTrue(v)),
    "nectar-panel-order": (v) => setPanelOrder(parsePanelOrder(v === null ? null : String(v))),
    "nectar-cc-layout": (v) => setCcLayout(parseCcLayout(v === null ? null : String(v))),
    "nectar-dock-recycle-enabled": (v) => setDockRecycle(readBoolDefaultFalse(v)),
    "nectar-week-start": (v) => setWeekStart(v ? String(v) : "auto"),
    "nectar-notch-scroll-direction": (v) => setPanelScrollDirection(v ? String(v) : "down"),
    "nectar-dock-indicator": (v) => setDockIndicator(v ? String(v) : "bar"),
    "nectar-dock-menu-items": (v) => setDockMenuItems(parseMenuItems(v)),
    "nectar-dock-drives": (v) => setDockDrives(parseDrives(v)),
    "nectar-dock-hidden-apps": (v) => setHiddenDockApps(parseHiddenApps(v)),
    "nectar-dock-icon-only": (v) => setDockIconOnly(readBoolDefaultFalse(v)),
    "nectar-start-icon": (v) => setStartIcon(v ? String(v) : "default"),
    "nectar-dock-adaptive": (v) => setDockAdaptive(readBoolDefaultFalse(v)),
    "nectar-dock-win-number-enabled": (v) => setDockWinNumberEnabled(readBoolDefaultTrue(v)),
    "nectar-dock-preview-enabled": (v) => setDockPreviewEnabled(readBoolDefaultTrue(v)),
    "nectar-dock-attention-enabled": (v) => setDockAttentionEnabled(readBoolDefaultTrue(v)),
    "nectar-dock-console-windows": (v) => setDockConsoleWindows(readBoolDefaultFalse(v)),
    "nectar-dock-search-enabled": (v) => setDockSearchEnabled(readBoolDefaultTrue(v)),
    "nectar-dock-search-provider": (v) => setDockSearchProvider(v ? String(v) : "nectar"),
    "nectar-dock-search-shortcut": (v) =>
      setDockSearchShortcut(v === null || v === undefined ? "" : String(v)),
    "nectar-dock-calendar-enabled": (v) => setDockCalendarEnabled(readBoolDefaultTrue(v)),
    "nectar-dock-mixed-reorder": (v) => setDockMixedReorder(readBoolDefaultFalse(v)),
    "nectar-weather-enabled": (v) => setWeatherEnabled(readBoolDefaultTrue(v)),
    "nectar-calendar-enabled": (v) => setCalendarEnabled(readBoolDefaultTrue(v)),
    "nectar-timer-enabled": (v) => setTimerEnabled(readBoolDefaultTrue(v)),
    "nectar-timer-sound-enabled": (v) => setTimerSoundEnabled(readBoolDefaultTrue(v)),
    "nectar-notch-timer-progress": (v) => setNotchTimerProgress(readBoolDefaultTrue(v)),
    "nectar-stopwatch-enabled": (v) => setStopwatchEnabled(readBoolDefaultTrue(v)),
    "nectar-dual-clock-enabled": (v) => setDualClockEnabled(readBoolDefaultFalse(v)),
    "nectar-dual-clock-zone": (v) => setDualClockZone(v ? String(v) : DEFAULT_DUAL_CLOCK_ZONE),
    "nectar-dual-clock-label": (v) => setDualClockLabel(v ? String(v) : DEFAULT_DUAL_CLOCK_ZONE),
    "nectar-music-mode-enabled": (v) => setMusicModeEnabled(readBoolDefaultTrue(v)),
    "nectar-music-compact-notch": (v) => setMusicCompactNotch(readBoolDefaultTrue(v)),
    "nectar-notch-scroll-volume": (v) => setNotchScrollVolume(readBoolDefaultFalse(v)),
    "nectar-agent-api": (v) => setAgentApi(readBoolDefaultFalse(v)),
    "nectar-shelf-persist": (v) => setShelfPersist(readBoolDefaultFalse(v)),
    "nectar-notch-remember-mode": (v) => setRememberMode(readBoolDefaultFalse(v)),
    "nectar-media-ambience-enabled": (v) => setMediaAmbienceEnabled(readBoolDefaultTrue(v)),
    "nectar-media-compact-glow-enabled": (v) => setMediaCompactGlowEnabled(readBoolDefaultTrue(v)),
    "nectar-media-artwork-theme": (v) => setMediaArtworkThemeEnabled(readBoolDefaultFalse(v)),
    "nectar-media-layout": (v) => setMediaLayout(v === "compact" ? "compact" : "classic"),
    "nectar-corners-enabled": (v) => setCornersEnabled(readBoolDefaultFalse(v)),
    "nectar-show-update-indicator": (v) => setShowUpdateIndicator(readBoolDefaultTrue(v)),
    "nectar-time-format-24h": (v) => setTimeFormat24h(readBoolDefaultFalse(v)),
    "nectar-legacy-mode": (v) => setLegacyMode(readBoolDefaultFalse(v)),
    "nectar-ram-saver": (v) => setRamSaver(readBoolDefaultFalse(v)),
    "nectar-perf-profile": (v) => {
      if (v === null || v === undefined || String(v).trim() === "") {
        setRamSaver(localStorage.getItem("nectar-ram-saver") === "true");
        return;
      }
      setRamSaver(String(v).trim().toLowerCase() === "eco");
    },
    "nectar-ram-ultra": (v) => setRamUltra(readBoolDefaultFalse(v)),
    "nectar-low-battery-threshold": (v) => setLowBatteryThreshold(readFiniteInt(20)(v)),
    "nectar-scale": (v) => {
      const n = readFiniteNumber(1.0)(v);
      setScale(n > 0 ? n : 1.0);
    },
    "nectar-temp-unit": (v) => setTempUnitFahrenheit(v === "fahrenheit"),
    "nectar-auto-update": (v) => setAutoUpdate(readBoolDefaultFalse(v)),
    "nectar-update-channel": (v) => setPrereleaseChannel(v === "prerelease"),
    "nectar-volume-overlay-enabled": (v) => setVolumeOverlayEnabled(readBoolDefaultTrue(v)),
    "nectar-volume-edge-enabled": (v) => setVolumeEdgeEnabled(readBoolDefaultTrue(v)),
    "nectar-brightness-overlay-enabled": (v) => setBrightnessOverlayEnabled(readBoolDefaultTrue(v)),
    "nectar-brightness-edge-enabled": (v) => setBrightnessEdgeEnabled(readBoolDefaultTrue(v)),
    "nectar-theme-mode": (v) => setThemeMode(v ? String(v) : "dark"),
    "nectar-theme-color": (v) => setThemeColor(normalizeHexOrDefault(v === null ? null : String(v), "#007aff")),
    "nectar-theme-opacity": (v) =>
      setThemeOpacity(Math.max(0.35, Math.min(1.0, readFiniteNumber(0.8)(v)))),
    "nectar-theme-saturation": (v) => setThemeSaturation(readFiniteNumber(0.5)(v)),
    "nectar-theme-brightness": (v) => setThemeBrightness(readFiniteNumber(0.15)(v)),
    "nectar-theme-style": (v) => setThemeStyle(v ? String(v) : "solid"),
    "nectar-theme-accent": (v) => setThemeAccent(v ? String(v) : "mono"),
    "nectar-theme-accent-color": (v) =>
      setThemeAccentColor(normalizeHexOrDefault(v === null ? null : String(v), DEFAULT_ACCENT_COLOR)),
    "nectar-selection-color": (v) =>
      setSelectionColor(normalizeHexOrDefault(v === null ? null : String(v), DEFAULT_SELECTION_COLOR)),
    "nectar-sync-windows-selection": (v) => setSyncWindowsSelection(readBoolDefaultFalse(v)),
    "nectar-status-widgets": (v) => setStatusWidgets(parseStatusWidgets(v)),
    "nectar-weather-city": (v) => {
      const next = v === null || v === undefined ? "" : String(v);
      setCityName(next);
      setCityQuery(next);
    },
  }, undefined, {
    shouldIgnoreKey: (key) => (localWriteUntilRef.current.get(key) ?? 0) > Date.now(),
  });

  // ── Listen for system accent changes (adaptive theme) ──
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    bridgeListen<string>("system-accent-changed", (accent) => {
      const mode = localStorage.getItem("nectar-theme-mode") || "dark";
      if (mode === "adaptive") {
        try {
          const hsl = hexToHsl(accent);
          setThemeSaturation(hsl.s / 100);
          setThemeBrightness(hsl.l / 100);
        } catch (e) {
          console.error("Failed to parse system accent color change HSL:", e);
        }
      }
    }).then((fn) => {
      if (cancelled) fn();
      else stop = fn;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  // ── City search debounce ──
  useEffect(() => {
    if (cityQuery.trim().length < 2 || cityQuery === cityName) {
      setCitySearchResults([]);
      setShowCityDropdown(false);
      return;
    }

    let cancelled = false;
    let controller: AbortController | null = null;

    const timeout = setTimeout(async () => {
      controller = new AbortController();
      try {
        const res = await fetch(
          `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityQuery)}&count=5&language=en&format=json`,
          { signal: controller.signal }
        );
        if (cancelled) return;
        if (!res.ok) {
          setCitySearchResults([]);
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        if (data.results && data.results.length > 0) {
          setCitySearchResults(
            data.results.map((r: any) => ({
              name: r.name,
              country: r.country || "",
              latitude: r.latitude,
              longitude: r.longitude,
            }))
          );
          setShowCityDropdown(true);
        } else {
          setCitySearchResults([]);
        }
      } catch (err) {
        if (cancelled || (err instanceof Error && err.name === "AbortError")) return;
        setCitySearchResults([]);
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      controller?.abort();
    };
  }, [cityQuery, cityName]);

  // ── Update checker ──
  const checkForUpdates = async (manual = true) => {
    if (updaterDisabled) return;
    setUpdateStatus("checking");
    try {
      const result = await bridgeInvoke<UpdateCheckResult | null>("check_for_updates", { force: manual });
      if (result?.available) {
        setUpdateStatus("available");
        setUpdateVersion(result.version ?? "");
      } else {
        setUpdateStatus("uptodate");
      }
    } catch (e) {
      console.error("Updater error:", e);
      setUpdateStatus("error");
    }
  };

  const installUpdate = async () => {
    if (updaterDisabled) return;
    try {
      setUpdateStatus("downloading");
      await bridgeInvoke("install_update");
      setUpdateStatus("idle");
    } catch (e) {
      console.error(e);
      setUpdateStatus("error");
    }
  };

  // Reflect install progress triggered from any window (including auto-update).
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    bridgeListen<{ status: string; progress?: number }>("auto-update-status", (payload) => {
      switch (payload.status) {
        case "downloading":
          setUpdateStatus("downloading");
          break;
        case "installing":
          setUpdateStatus("installing");
          break;
        case "done":
          setUpdateStatus((prev) => (prev === "downloading" || prev === "installing" ? "idle" : prev));
          break;
      }
    }).then((fn) => {
      if (cancelled) fn();
      else stop = fn;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  // ── Autostart ──
  const toggleAutostart = async () => {
    try {
      const next = !(await bridgeInvoke<boolean>("get_autostart"));
      await bridgeInvoke("set_autostart", { enabled: next });
      setAutostart(next);
    } catch (err) {}
  };

  // ── Simple boolean toggles ──
  const toggleWeather = () => {
    const next = !weatherEnabled;
    setWeatherEnabled(next);
    saveSetting("nectar-weather-enabled", String(next));
  };

  const toggleCalendar = () => {
    const next = !calendarEnabled;
    setCalendarEnabled(next);
    saveSetting("nectar-calendar-enabled", String(next));
  };

  const toggleTimerEnabled = () => {
    const next = !timerEnabled;
    setTimerEnabled(next);
    saveSetting("nectar-timer-enabled", String(next));
  };

  const toggleTimerSound = () => {
    const next = !timerSoundEnabled;
    setTimerSoundEnabled(next);
    saveSetting("nectar-timer-sound-enabled", String(next));
  };

  const toggleNotchTimerProgress = () => {
    const next = !notchTimerProgress;
    setNotchTimerProgress(next);
    saveSetting("nectar-notch-timer-progress", String(next));
  };

  const toggleStopwatchEnabled = () => {
    const next = !stopwatchEnabled;
    setStopwatchEnabled(next);
    saveSetting("nectar-stopwatch-enabled", String(next));
  };

  const toggleDualClock = () => {
    const next = !dualClockEnabled;
    setDualClockEnabled(next);
    saveSetting("nectar-dual-clock-enabled", String(next));
  };

  const selectDualClockZone = ({ label, zone }: { label: string; zone: string }) => {
    setDualClockZone(zone);
    setDualClockLabel(label);
    saveSetting("nectar-dual-clock-zone", zone);
    saveSetting("nectar-dual-clock-label", label);
  };

  const toggleMusicMode = () => {
    const next = !musicModeEnabled;
    setMusicModeEnabled(next);
    saveSetting("nectar-music-mode-enabled", String(next));
  };

  const toggleMusicCompactNotch = () => {
    const next = !musicCompactNotch;
    setMusicCompactNotch(next);
    saveSetting("nectar-music-compact-notch", String(next));
  };

  const toggleAgentApi = () => {
    const next = !agentApi;
    setAgentApi(next);
    saveSetting("nectar-agent-api", String(next));
  };

  const toggleNotchScrollVolume = () => {
    const next = !notchScrollVolume;
    setNotchScrollVolume(next);
    saveSetting("nectar-notch-scroll-volume", String(next));
  };

  const toggleRememberMode = () => {
    const next = !rememberMode;
    setRememberMode(next);
    saveSetting("nectar-notch-remember-mode", String(next));
  };

  const toggleShelfPersist = () => {
    const next = !shelfPersist;
    setShelfPersist(next);
    saveSetting("nectar-shelf-persist", String(next));
  };

  const toggleMediaLayout = (layout: "classic" | "compact") => {
    setMediaLayout(layout);
    saveSetting("nectar-media-layout", layout);
  };

  const toggleVolumeOverlay = () => {
    const next = !volumeOverlayEnabled;
    setVolumeOverlayEnabled(next);
    saveSetting("nectar-volume-overlay-enabled", String(next));
  };

  const toggleVolumeEdge = () => {
    const next = !volumeEdgeEnabled;
    setVolumeEdgeEnabled(next);
    saveSetting("nectar-volume-edge-enabled", String(next));
  };

  const toggleBrightnessOverlay = () => {
    const next = !brightnessOverlayEnabled;
    setBrightnessOverlayEnabled(next);
    saveSetting("nectar-brightness-overlay-enabled", String(next));
  };

  const toggleBrightnessEdge = () => {
    const next = !brightnessEdgeEnabled;
    setBrightnessEdgeEnabled(next);
    saveSetting("nectar-brightness-edge-enabled", String(next));
  };

  const toggleAmbience = () => {
    const next = !mediaAmbienceEnabled;
    setMediaAmbienceEnabled(next);
    saveSetting("nectar-media-ambience-enabled", String(next));
  };

  const toggleCompactGlow = () => {
    const next = !mediaCompactGlowEnabled;
    setMediaCompactGlowEnabled(next);
    saveSetting("nectar-media-compact-glow-enabled", String(next));
  };

  const toggleArtworkTheme = () => {
    const next = !mediaArtworkThemeEnabled;
    setMediaArtworkThemeEnabled(next);
    saveSetting("nectar-media-artwork-theme", String(next));
  };

  const toggleCorners = () => {
    const next = !cornersEnabled;
    setCornersEnabled(next);
    saveSetting("nectar-corners-enabled", String(next));
  };

  const toggleUpdateIndicator = () => {
    const next = !showUpdateIndicator;
    setShowUpdateIndicator(next);
    saveSetting("nectar-show-update-indicator", String(next));
  };

  const toggleTimeFormat24h = () => {
    const next = !timeFormat24h;
    setTimeFormat24h(next);
    saveSetting("nectar-time-format-24h", String(next));
  };

  const toggleLegacyMode = () => {
    const next = !legacyMode;
    setLegacyMode(next);
    saveSetting("nectar-legacy-mode", String(next));
  };

  useEffect(() => {
    const onLocal = (e: Event) => {
      const keys = (e as CustomEvent<{ keys?: string[] }>).detail?.keys;
      if (!keys) return;
      if (keys.includes("nectar-perf-profile")) {
        const prof = localStorage.getItem("nectar-perf-profile");
        if (prof && prof.trim() !== "") {
          setRamSaver(prof.trim().toLowerCase() === "eco");
          return;
        }
      }
      if (keys.includes("nectar-ram-saver")) {
        setRamSaver(localStorage.getItem("nectar-ram-saver") === "true");
      }
    };
    window.addEventListener("nectar-local-setting", onLocal);
    return () => window.removeEventListener("nectar-local-setting", onLocal);
  }, []);

  const toggleRamSaver = () => {
    const next = !ramSaver;
    const nextProfile = next ? "eco" : "balanced";
    setRamSaver(next);
    localStorage.setItem("nectar-ram-saver", String(next));
    localStorage.setItem("nectar-perf-profile", nextProfile);
    markLocalSettingWrites(["nectar-ram-saver", "nectar-perf-profile"]);
    notifyLocalSettingChanges(["nectar-ram-saver", "nectar-perf-profile"]);
    queueSettingsBatch(
      {
        "nectar-ram-saver": String(next),
        "nectar-perf-profile": nextProfile,
      },
      { immediate: true }
    );
  };

  const toggleRamUltra = () => {
    const next = !ramUltra;
    setRamUltra(next);
    saveSetting("nectar-ram-ultra", String(next));
  };

  const toggleTempUnit = () => {
    const next = !tempUnitFahrenheit;
    setTempUnitFahrenheit(next);
    saveSetting("nectar-temp-unit", next ? "fahrenheit" : "celsius");
  };

  const toggleDock = () => {
    const next = !dockEnabled;
    setDockEnabled(next);
    saveSetting("nectar-dock-enabled", String(next));
  };

  const toggleDockPreview = () => {
    const next = !dockPreviewEnabled;
    setDockPreviewEnabled(next);
    saveSetting("nectar-dock-preview-enabled", String(next));
  };

  const toggleDockConsoleWindows = () => {
    const next = !dockConsoleWindows;
    setDockConsoleWindows(next);
    saveSetting("nectar-dock-console-windows", String(next));
  };

  const toggleDockAttention = () => {
    const next = !dockAttentionEnabled;
    setDockAttentionEnabled(next);
    saveSetting("nectar-dock-attention-enabled", String(next));
  };

  const handleDockSearchProviderChange = (provider: string) => {
    setDockSearchProvider(provider);
    saveSetting("nectar-dock-search-provider", provider);
  };

  const handleDockSearchShortcutChange = (shortcut: string) => {
    setDockSearchShortcut(shortcut);
    saveSetting("nectar-dock-search-shortcut", shortcut);
  };

  const toggleDockSearch = () => {
    const next = !dockSearchEnabled;
    setDockSearchEnabled(next);
    saveSetting("nectar-dock-search-enabled", String(next));
  };

  const toggleDockTray = () => {
    const next = !dockTray;
    setDockTray(next);
    saveSetting("nectar-dock-tray-enabled", String(next));
  };

  const toggleDockShowDesktop = () => {
    const next = !dockShowDesktop;
    setDockShowDesktop(next);
    saveSetting("nectar-dock-show-desktop-corner", String(next));
  };

  const togglePanelControlCenter = () => {
    const next = !panelControlCenter;
    setPanelControlCenter(next);
    saveSetting("nectar-panel-control-center-enabled", String(next));
  };

  const reorderPanels = (order: PanelId[]) => {
    setPanelOrder(order);
    saveSetting("nectar-panel-order", JSON.stringify(order));
  };

  const changeCcLayout = (next: CcLayout) => {
    setCcLayout(next);
    saveSetting("nectar-cc-layout", JSON.stringify(next));
  };

  const resetCcLayout = () => {
    setCcLayout({});
    localStorage.removeItem("nectar-cc-layout");
    bridgeInvoke("save_setting", { key: "nectar-cc-layout", value: null }).catch(() => {});
  };

  const resetPanelOrder = () => {
    setPanelOrder(null);
    localStorage.removeItem("nectar-panel-order");
    bridgeInvoke("save_setting", { key: "nectar-panel-order", value: null }).catch(() => {});
  };

  const togglePanelStatus = () => {
    const next = !panelStatus;
    setPanelStatus(next);
    saveSetting("nectar-panel-status-enabled", String(next));
  };

  const togglePanelShelf = () => {
    const next = !panelShelf;
    setPanelShelf(next);
    saveSetting("nectar-panel-shelf-enabled", String(next));
  };

  const toggleDockTaskView = () => {
    const next = !dockTaskView;
    setDockTaskView(next);
    saveSetting("nectar-dock-taskview-enabled", String(next));
  };

  const toggleDockRecycle = () => {
    const next = !dockRecycle;
    setDockRecycle(next);
    saveSetting("nectar-dock-recycle-enabled", String(next));
  };

  const toggleDockDrive = (letter: string) => {
    const next = dockDrives.includes(letter) ? dockDrives.filter((d) => d !== letter) : [...dockDrives, letter].sort();
    setDockDrives(next);
    saveSetting("nectar-dock-drives", JSON.stringify(next));
  };

  const toggleDockMenuItem = (id: string) => {
    const next = dockMenuItems.includes(id) ? dockMenuItems.filter((x) => x !== id) : DOCK_MENU_IDS.filter((x) => x === id || dockMenuItems.includes(x));
    setDockMenuItems(next);
    saveSetting("nectar-dock-menu-items", JSON.stringify(next));
  };

  const changeDockIndicator = (value: string) => {
    const valid = VALID_DOCK_INDICATORS.has(value) ? value : "dots";
    setDockIndicator(valid);
    queueSettingsBatch(
      { "nectar-dock-indicator": valid },
      { immediate: true, refreshTheme: true }
    );
    notifyLocalSettingChanges(["nectar-dock-indicator"]);
  };

  const changePanelScrollDirection = (value: string) => {
    setPanelScrollDirection(value);
    saveSetting("nectar-notch-scroll-direction", value);
  };

  const changeWeekStart = (value: string) => {
    setWeekStart(value);
    saveSetting("nectar-week-start", value);
  };

  const restoreHiddenDockApp = (id: string) => {
    const next = hiddenDockApps.filter((h) => h.id !== id);
    setHiddenDockApps(next);
    saveSetting("nectar-dock-hidden-apps", JSON.stringify(next));
  };

  const toggleDockCalendar = () => {
    const next = !dockCalendarEnabled;
    setDockCalendarEnabled(next);
    saveSetting("nectar-dock-calendar-enabled", String(next));
  };

  const toggleDockMixedReorder = () => {
    const next = !dockMixedReorder;
    setDockMixedReorder(next);
    saveSetting("nectar-dock-mixed-reorder", String(next));
  };

  const toggleDockIconOnly = () => {
    const next = !dockIconOnly;
    setDockIconOnly(next);
    saveSetting("nectar-dock-icon-only", String(next));
  };

  const handleStartIconChange = (icon: string) => {
    setStartIcon(icon);
    saveSetting("nectar-start-icon", icon);
  };

  const toggleDockAdaptive = () => {
    const next = !dockAdaptive;
    setDockAdaptive(next);
    saveSetting("nectar-dock-adaptive", String(next));
  };

  const toggleDockWinNumber = () => {
    const next = !dockWinNumberEnabled;
    setDockWinNumberEnabled(next);
    saveSetting("nectar-dock-win-number-enabled", String(next));
  };

  const toggleAutoUpdate = () => {
    const next = !autoUpdate;
    setAutoUpdate(next);
    saveSetting("nectar-auto-update", String(next));
  };

  const togglePrereleaseChannel = async () => {
    const next = !prereleaseChannel;
    const value = next ? "prerelease" : "stable";
    setPrereleaseChannel(next);
    localStorage.setItem("nectar-update-channel", value);
    await bridgeInvoke("save_setting", { key: "nectar-update-channel", value }).catch(console.error);
    checkForUpdates();
  };

  // ── Value setters ──
  const setDockModeValue = (newMode: string) => {
    setDockMode(newMode);
    if (dockMonitorMode !== "all" && Object.keys(dockModeByMonitor).length > 0) {
      setDockModeByMonitor({});
      saveSetting("nectar-dock-mode-by-monitor", "{}");
    }
    saveSetting("nectar-dock-mode", newMode);
  };

  const toggleDockReserveSpace = () => {
    const next = !dockReserveSpace;
    setDockReserveSpace(next);
    saveSetting("nectar-dock-reserve-space", String(next));
  };

  const setNotchModeValue = (newMode: string) => {
    setNotchMode(newMode);
    if (notchMonitorMode !== "all" && Object.keys(notchModeByMonitor).length > 0) {
      setNotchModeByMonitor({});
      saveSetting("nectar-notch-mode-by-monitor", "{}");
    }
    saveSetting("nectar-notch-mode", newMode);
  };

  const setDockMonitorModeValue = (mode: MonitorMode) => {
    setDockMonitorMode(mode);
    saveSetting("nectar-dock-monitor-mode", mode);
  };

  const setDockMonitorIdValue = (id: string) => {
    setDockMonitorId(id);
    saveSetting("nectar-dock-monitor-id", id);
  };

  const setNotchMonitorModeValue = (mode: MonitorMode) => {
    setNotchMonitorMode(mode);
    saveSetting("nectar-notch-monitor-mode", mode);
  };

  const setNotchMonitorIdValue = (id: string) => {
    setNotchMonitorId(id);
    saveSetting("nectar-notch-monitor-id", id);
  };

  const setDockModeForMonitor = (monitorId: string, mode: string | null) => {
    setDockModeByMonitor((prev) => {
      const next = { ...prev };
      if (mode === null) delete next[monitorId]; else next[monitorId] = mode;
      saveSetting("nectar-dock-mode-by-monitor", JSON.stringify(next));
      return next;
    });
  };

  const replaceDockModesByMonitor = (next: Record<string, string>) => {
    setDockModeByMonitor(next);
    saveSetting("nectar-dock-mode-by-monitor", JSON.stringify(next));
  };

  const replaceNotchModesByMonitor = (next: Record<string, string>) => {
    setNotchModeByMonitor(next);
    saveSetting("nectar-notch-mode-by-monitor", JSON.stringify(next));
  };

  const setNotchModeForMonitor = (monitorId: string, mode: string | null) => {
    setNotchModeByMonitor((prev) => {
      const next = { ...prev };
      if (mode === null) delete next[monitorId]; else next[monitorId] = mode;
      saveSetting("nectar-notch-mode-by-monitor", JSON.stringify(next));
      return next;
    });
  };

  const handleThresholdChange = (val: number) => {
    setLowBatteryThreshold(val);
    saveSetting("nectar-low-battery-threshold", val.toString());
  };

  const handleScaleChange = (val: number) => {
    setScale(val);
    saveSetting("nectar-scale", val.toString());
  };

  const handleWidgetsChange = (config: WidgetConfig) => {
    setStatusWidgets(config);
    saveSetting("nectar-status-widgets", JSON.stringify(config));
  };

  // ── Theme handlers ──
  const handleThemeModeChange = async (mode: string) => {
    const seq = ++themeModeSeqRef.current;
    setThemeMode(mode);

    if (mode === "adaptive") {
      try {
        const accentHex = await bridgeInvoke<string>("get_system_accent_color");
        if (seq !== themeModeSeqRef.current) return;
        const hsl = hexToHsl(accentHex || DEFAULT_ACCENT_COLOR);
        const sat = hsl.s / 100;
        const lit = hsl.l / 100;
        setThemeSaturation(sat);
        setThemeBrightness(lit);
        queueSettingsBatch(
          {
            "nectar-theme-saturation": String(sat),
            "nectar-theme-brightness": String(lit),
            "nectar-theme-mode": mode,
          },
          { immediate: true, refreshTheme: true }
        );
        return;
      } catch (e) {
        console.error("Failed to parse adaptive accent HSL:", e);
      }
    }

    queueSettingsBatch({ "nectar-theme-mode": mode }, { immediate: true, refreshTheme: true });
  };

  const handleThemeColorChange = (hex: string) => {
    const color = normalizeHexOrDefault(hex, DEFAULT_ACCENT_COLOR);

    try {
      const r = parseInt(color.slice(1, 3), 16) / 255;
      const g = parseInt(color.slice(3, 5), 16) / 255;
      const b = parseInt(color.slice(5, 7), 16) / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const l = (max + min) / 2;
      const d = max - min;
      const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
      const sat = Math.round(s * 10000) / 10000;
      const lit = Math.round(l * 10000) / 10000;
      setThemeSaturation(sat);
      setThemeBrightness(lit);
      if (d === 0) {
        // Preserve existing base hue in `nectar-theme-color` when an achromatic shade is picked.
        queueSettingsBatch(
          {
            "nectar-theme-saturation": String(sat),
            "nectar-theme-brightness": String(lit),
          },
          { refreshTheme: true }
        );
        return;
      }
      setThemeColor(color);
      queueSettingsBatch(
        {
          "nectar-theme-color": color,
          "nectar-theme-saturation": String(sat),
          "nectar-theme-brightness": String(lit),
        },
        { refreshTheme: true }
      );
    } catch (e) {
      console.error("Failed to parse custom color HSL:", e);
      setThemeColor(color);
      queueSettingsBatch({ "nectar-theme-color": color }, { refreshTheme: true });
    }
  };

  const handleOpacityChange = (value: number) => {
    const clamped = Math.max(0.35, Math.min(1.0, value));
    setThemeOpacity(clamped);
    queueSettingsBatch({ "nectar-theme-opacity": String(clamped) }, { refreshTheme: true });
  };

  const handleSaturationChange = (value: number) => {
    setThemeSaturation(value);
    queueSettingsBatch({ "nectar-theme-saturation": String(value) }, { refreshTheme: true });
  };

  const handleBrightnessChange = (value: number) => {
    setThemeBrightness(value);
    queueSettingsBatch({ "nectar-theme-brightness": String(value) }, { refreshTheme: true });
  };

  const handleThemeStyleChange = (style: string) => {
    setThemeStyle(style);
    const prevDefault = STYLE_OPACITY[themeStyle];
    const nextDefault = STYLE_OPACITY[style];
    const atStyleDefault =
      prevDefault !== undefined && Math.abs(themeOpacity - prevDefault) < 0.015;
    if (atStyleDefault && nextDefault !== undefined) {
      const clamped = Math.max(0.35, Math.min(1.0, nextDefault));
      setThemeOpacity(clamped);
      queueSettingsBatch(
        {
          "nectar-theme-opacity": String(clamped),
          "nectar-theme-style": style,
        },
        { immediate: true, refreshTheme: true }
      );
      return;
    }
    queueSettingsBatch({ "nectar-theme-style": style }, { immediate: true, refreshTheme: true });
  };

  const handleAccentChange = (accent: string) => {
    setThemeAccent(accent);
    queueSettingsBatch({ "nectar-theme-accent": accent }, { immediate: true, refreshTheme: true });
  };

  const handleAccentColorChange = (color: string) => {
    const normalized = normalizeHexOrDefault(color, DEFAULT_ACCENT_COLOR);
    setThemeAccentColor(normalized);
    queueSettingsBatch(
      { "nectar-theme-accent-color": normalized },
      { refreshTheme: true }
    );
  };

  const applyThemePreset = (preset: ThemePreset) => {
    const color = normalizeHexOrDefault(preset.color, DEFAULT_ACCENT_COLOR);
    const accent = normalizeHexOrDefault(preset.accent, DEFAULT_ACCENT_COLOR);
    setThemeMode("custom");
    setThemeColor(color);
    setThemeSaturation(preset.saturation);
    setThemeBrightness(preset.brightness);
    setThemeAccent("custom");
    setThemeAccentColor(accent);

    queueSettingsBatch(
      {
        "nectar-theme-mode": "custom",
        "nectar-theme-color": color,
        "nectar-theme-saturation": String(preset.saturation),
        "nectar-theme-brightness": String(preset.brightness),
        "nectar-theme-accent": "custom",
        "nectar-theme-accent-color": accent,
      },
      { immediate: true, refreshTheme: true }
    );
  };

  const applyThemeSettingsMap = useCallback(
    (
      rawMap: Partial<Record<ThemeExportKey, string>> | Record<string, unknown>,
      extraEntries?: Record<string, string | null>
    ) => {
      const clean = sanitizeThemeSettings(rawMap);
      const entries: Record<string, string | null> = { ...(clean as Record<string, string>) };
      if (extraEntries) {
        for (const [k, v] of Object.entries(extraEntries)) {
          if (k.startsWith("nectar-")) {
            entries[k] = v;
          }
        }
      }
      if (Object.keys(entries).length === 0) return;
      if (entries["nectar-theme-mode"]) setThemeMode(entries["nectar-theme-mode"]);
      if (entries["nectar-theme-style"]) setThemeStyle(entries["nectar-theme-style"]);
      if (entries["nectar-theme-color"]) setThemeColor(entries["nectar-theme-color"]);
      if (entries["nectar-theme-opacity"]) {
        const op = parseFloat(entries["nectar-theme-opacity"]);
        if (Number.isFinite(op)) setThemeOpacity(Math.max(0.35, Math.min(1.0, op)));
      }
      if (entries["nectar-theme-saturation"]) {
        const sat = parseFloat(entries["nectar-theme-saturation"]);
        if (Number.isFinite(sat)) setThemeSaturation(sat);
      }
      if (entries["nectar-theme-brightness"]) {
        const br = parseFloat(entries["nectar-theme-brightness"]);
        if (Number.isFinite(br)) setThemeBrightness(br);
      }
      if (entries["nectar-theme-accent"]) setThemeAccent(entries["nectar-theme-accent"]);
      if (entries["nectar-theme-accent-color"]) {
        setThemeAccentColor(entries["nectar-theme-accent-color"]);
      }
      if (entries["nectar-selection-color"]) {
        setSelectionColor(entries["nectar-selection-color"]);
      }
      if (entries["nectar-legacy-mode"]) {
        setLegacyMode(entries["nectar-legacy-mode"] === "true");
      }
      if (entries["nectar-dock-indicator"] && VALID_DOCK_INDICATORS.has(entries["nectar-dock-indicator"])) {
        setDockIndicator(entries["nectar-dock-indicator"]);
      }
      queueSettingsBatch(entries, { immediate: true, refreshTheme: true });
      notifyLocalSettingChanges(Object.keys(entries));
    },
    [queueSettingsBatch]
  );

  useEffect(() => {
    return () => {
      if (selectionSyncTimerRef.current !== null) {
        window.clearTimeout(selectionSyncTimerRef.current);
        selectionSyncTimerRef.current = null;
        const pendingHex = pendingSelectionSyncHexRef.current;
        pendingSelectionSyncHexRef.current = null;
        if (pendingHex && syncWindowsSelectionRef.current) {
          bridgeInvoke("sync_windows_selection_color", { hex: pendingHex }).catch(() => {});
        }
      }
      if (explorerRefreshDoneTimerRef.current !== null) {
        window.clearTimeout(explorerRefreshDoneTimerRef.current);
      }
    };
  }, []);

  const syncSelectionRegistryNow = useCallback(async (hex: string) => {
    try {
      await bridgeInvoke("sync_windows_selection_color", { hex });
      setSelectionNeedsExplorerRefresh(true);
      setExplorerRefreshDone(false);
    } catch (e) {
      setSelectionSyncError(typeof e === "string" ? e : String((e as Error)?.message ?? e));
    }
  }, []);

  const handleSelectionColorChange = (hex: string) => {
    const normalized = normalizeHexOrDefault(hex, DEFAULT_SELECTION_COLOR);
    setSelectionColor(normalized);
    setSelectionSyncError("");
    setExplorerRefreshDone(false);

    // Explicitly picking a selection color auto-enables Windows desktop selection sync
    // (safely preserving a registry backup so toggling Sync off still restores Windows defaults).
    const wasSynced = syncWindowsSelectionRef.current;
    if (!wasSynced) {
      syncWindowsSelectionRef.current = true;
      setSyncWindowsSelection(true);
      queueSettingsBatch(
        {
          "nectar-selection-color": normalized,
          "nectar-sync-windows-selection": "true",
        },
        { refreshTheme: true }
      );
    } else {
      queueSettingsBatch({ "nectar-selection-color": normalized }, { refreshTheme: true });
    }

    if (selectionSyncTimerRef.current !== null) {
      window.clearTimeout(selectionSyncTimerRef.current);
      selectionSyncTimerRef.current = null;
    }
    pendingSelectionSyncHexRef.current = normalized;
    selectionSyncTimerRef.current = window.setTimeout(() => {
      selectionSyncTimerRef.current = null;
      const targetHex = pendingSelectionSyncHexRef.current;
      pendingSelectionSyncHexRef.current = null;
      if (!targetHex || !syncWindowsSelectionRef.current) return;
      void syncSelectionRegistryNow(targetHex);
    }, 240);
  };

  const resetSelectionColor = () => {
    setSelectionColor(DEFAULT_SELECTION_COLOR);
    setSelectionSyncError("");
    setExplorerRefreshDone(false);
    if (selectionSyncTimerRef.current !== null) {
      window.clearTimeout(selectionSyncTimerRef.current);
      selectionSyncTimerRef.current = null;
    }
    pendingSelectionSyncHexRef.current = null;
    queueSettingsBatch(
      { "nectar-selection-color": DEFAULT_SELECTION_COLOR },
      { immediate: true, refreshTheme: true }
    );
    if (syncWindowsSelectionRef.current) {
      void syncSelectionRegistryNow(DEFAULT_SELECTION_COLOR);
    }
  };

  const toggleSyncWindowsSelection = () => {
    const next = !syncWindowsSelection;
    setSelectionSyncError("");
    setExplorerRefreshDone(false);
    if (selectionSyncTimerRef.current !== null) {
      window.clearTimeout(selectionSyncTimerRef.current);
      selectionSyncTimerRef.current = null;
    }
    pendingSelectionSyncHexRef.current = null;
    syncWindowsSelectionRef.current = next;
    setSyncWindowsSelection(next);
    queueSettingsBatch({ "nectar-sync-windows-selection": String(next) }, { immediate: true });
    (next
      ? bridgeInvoke("sync_windows_selection_color", { hex: selectionColor }).then(() => {
          setSelectionNeedsExplorerRefresh(true);
        })
      : bridgeInvoke("restore_windows_selection_color").then(() => {
          setSelectionNeedsExplorerRefresh(true);
        })
    ).catch((e) => {
      setSelectionSyncError(typeof e === "string" ? e : String((e as Error)?.message ?? e));
      syncWindowsSelectionRef.current = !next;
      setSyncWindowsSelection(!next);
      queueSettingsBatch({ "nectar-sync-windows-selection": String(!next) }, { immediate: true });
    });
  };

  const refreshDesktopSelection = async () => {
    if (explorerRefreshState === "refreshing") return;
    if (explorerRefreshDoneTimerRef.current !== null) {
      window.clearTimeout(explorerRefreshDoneTimerRef.current);
      explorerRefreshDoneTimerRef.current = null;
    }
    setSelectionSyncError("");
    setExplorerRefreshDone(false);
    setExplorerRefreshState("refreshing");
    try {
      await flushSettingsBatch();
      if (selectionSyncTimerRef.current !== null) {
        window.clearTimeout(selectionSyncTimerRef.current);
        selectionSyncTimerRef.current = null;
      }
      const pendingHex = pendingSelectionSyncHexRef.current;
      pendingSelectionSyncHexRef.current = null;
      if (pendingHex && syncWindowsSelectionRef.current) {
        await bridgeInvoke("sync_windows_selection_color", { hex: pendingHex });
      } else if (syncWindowsSelectionRef.current) {
        await bridgeInvoke("sync_windows_selection_color", { hex: selectionColor });
      }
      await bridgeInvoke("restart_explorer_for_theme");
      setSelectionNeedsExplorerRefresh(false);
      setExplorerRefreshDone(true);
      explorerRefreshDoneTimerRef.current = window.setTimeout(() => {
        explorerRefreshDoneTimerRef.current = null;
        setExplorerRefreshDone(false);
      }, 3000);
    } catch (e) {
      setSelectionSyncError(typeof e === "string" ? e : String((e as Error)?.message ?? e));
    } finally {
      setExplorerRefreshState("idle");
    }
  };

  // ── City search ──
  const selectCity = async (city: {
    name: string;
    country: string;
    latitude: number;
    longitude: number;
  }) => {
    setCityName(city.name);
    setCityQuery(city.name);
    setShowCityDropdown(false);
    setCitySearchResults([]);
    localStorage.setItem("nectar-weather-city", city.name);
    localStorage.setItem("nectar-weather-lat", city.latitude.toString());
    localStorage.setItem("nectar-weather-lon", city.longitude.toString());
    await bridgeInvoke("save_setting", { key: "nectar-weather-lat", value: city.latitude.toString() }).catch(() => {});
    await bridgeInvoke("save_setting", { key: "nectar-weather-lon", value: city.longitude.toString() }).catch(() => {});
    await bridgeInvoke("save_setting", { key: "nectar-weather-city", value: city.name }).catch(() => {});
    bridgeEmit("weather-refresh", { lat: city.latitude, lon: city.longitude, city: city.name });
  };

  const handleCityClear = async () => {
    setCityName("");
    setCityQuery("");
    setShowCityDropdown(false);
    setCitySearchResults([]);
    localStorage.removeItem("nectar-weather-city");
    localStorage.removeItem("nectar-weather-lat");
    localStorage.removeItem("nectar-weather-lon");
    await bridgeInvoke("save_setting", { key: "nectar-weather-lat", value: null }).catch(() => {});
    await bridgeInvoke("save_setting", { key: "nectar-weather-lon", value: null }).catch(() => {});
    await bridgeInvoke("save_setting", { key: "nectar-weather-city", value: null }).catch(() => {});
    bridgeEmit("weather-refresh", true);
  };

  // ── Export / Import ──
  const handleExportSettings = async () => {
    setExportStatus("exporting");
    try {
      const saved = await bridgeInvoke<boolean>("export_settings_dialog");
      if (!isMountedRef.current) return;
      if (saved) {
        setExportStatus("success");
        scheduleStatusTimer(exportTimerRef, () => setExportStatus("idle"), 2000);
      } else {
        setExportStatus("idle");
      }
    } catch (e) {
      console.error("Export failed:", e);
      if (!isMountedRef.current) return;
      setExportStatus("error");
      scheduleStatusTimer(exportTimerRef, () => setExportStatus("idle"), 3000);
    }
  };

  const handleImportSettings = async () => {
    setImportStatus("importing");
    try {
      const imported = await bridgeInvoke<boolean>("import_settings_dialog");
      if (!isMountedRef.current) return;
      if (imported) {
        const reloaded = await bridgeInvoke<Record<string, unknown>>("load_settings");
        if (!isMountedRef.current) return;
        if (reloaded && typeof reloaded === "object" && !Array.isArray(reloaded)) {
          syncSettingsMapToLocalStorage(reloaded, true);
        }
        await loadAllSettings(true);
        if (!isMountedRef.current) return;
        localWriteUntilRef.current.clear();
        clearLocalSettingWrites();
        refreshThemeFromStorage();
        setImportStatus("success");
        scheduleStatusTimer(importTimerRef, () => setImportStatus("idle"), 2000);
      } else {
        setImportStatus("idle");
      }
    } catch (e) {
      console.error("Import failed:", e);
      if (!isMountedRef.current) return;
      setImportStatus("error");
      scheduleStatusTimer(importTimerRef, () => setImportStatus("idle"), 3000);
    }
  };

  const handleResetSettings = async () => {
    if (resetStatus === "idle") {
      setResetStatus("confirm");
      scheduleStatusTimer(resetTimerRef, () => setResetStatus((s) => (s === "confirm" ? "idle" : s)), 4000);
      return;
    }
    if (resetStatus !== "confirm") return;
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }

    setResetStatus("resetting");
    try {
      await bridgeInvoke("reset_settings");
      localWriteUntilRef.current.clear();
      clearLocalSettingWrites();
      try {
        clearSettingsPreservingOnboarding();
      } catch {
        // Ignore restricted storage errors
      }
      refreshThemeFromStorage();
      await loadAllSettings(true);
      await bridgeInvoke("restart_nectar");
      if (isMountedRef.current && !isTauriRuntime()) {
        setResetStatus("idle");
      }
    } catch (e) {
      console.error("Reset failed:", e);
      if (isMountedRef.current) setResetStatus("idle");
    }
  };

  const handleUninstallNectar = async () => {
    if (uninstallStatus === "idle" || uninstallStatus === "error") {
      setUninstallStatus("confirm");
      scheduleStatusTimer(
        uninstallTimerRef,
        () => setUninstallStatus((s) => (s === "confirm" ? "idle" : s)),
        4000
      );
      return;
    }
    if (uninstallStatus !== "confirm") return;
    if (uninstallTimerRef.current !== null) {
      window.clearTimeout(uninstallTimerRef.current);
      uninstallTimerRef.current = null;
    }

    setUninstallStatus("uninstalling");
    try {
      await bridgeInvoke("uninstall_nectar");
    } catch (e) {
      console.error("Uninstall failed:", e);
      if (!isMountedRef.current) return;
      setUninstallError(typeof e === "string" ? e : String((e as Error)?.message ?? e));
      setUninstallStatus("error");
      scheduleStatusTimer(
        uninstallTimerRef,
        () => setUninstallStatus((s) => (s === "error" ? "idle" : s)),
        12000
      );
    }
  };

  return {
    // System
    autostart,
    toggleAutostart,
    autoUpdate,
    toggleAutoUpdate,
    prereleaseChannel,
    togglePrereleaseChannel,
    lowBatteryThreshold,
    handleThresholdChange,
    timeFormat24h,
    toggleTimeFormat24h,
    legacyMode,
    toggleLegacyMode,
    showUpdateIndicator,
    toggleUpdateIndicator,
    ramSaver,
    toggleRamSaver,
    ramUltra,
    toggleRamUltra,
    scale,
    handleScaleChange,
    cornersEnabled,
    toggleCorners,

    // Theme
    themeMode,
    handleThemeModeChange,
    themeColor,
    handleThemeColorChange,
    themeOpacity,
    handleOpacityChange,
    themeSaturation,
    handleSaturationChange,
    themeBrightness,
    handleBrightnessChange,
    themeStyle,
    handleThemeStyleChange,
    themeAccent,
    handleAccentChange,
    themeAccentColor,
    handleAccentColorChange,
    applyThemePreset,
    applyThemeSettingsMap,
    selectionColor,
    handleSelectionColorChange,
    resetSelectionColor,
    syncWindowsSelection,
    toggleSyncWindowsSelection,
    selectionSyncError,
    selectionNeedsExplorerRefresh,
    explorerRefreshState,
    explorerRefreshDone,
    refreshDesktopSelection,

    // Notch
    notchMode,
    setNotchModeValue,
    calendarEnabled,
    toggleCalendar,
    timerEnabled,
    toggleTimerEnabled,
    timerSoundEnabled,
    toggleTimerSound,
    notchTimerProgress,
    toggleNotchTimerProgress,
    stopwatchEnabled,
    toggleStopwatchEnabled,
    dualClockEnabled,
    toggleDualClock,
    dualClockZone,
    dualClockLabel,
    selectDualClockZone,
    musicModeEnabled,
    toggleMusicMode,
    musicCompactNotch,
    toggleMusicCompactNotch,
    agentApi,
    toggleAgentApi,
    notchScrollVolume,
    toggleNotchScrollVolume,
    shelfPersist,
    toggleShelfPersist,
    rememberMode,
    toggleRememberMode,
    mediaLayout,
    toggleMediaLayout,
    mediaAmbienceEnabled,
    toggleAmbience,
    mediaCompactGlowEnabled,
    toggleCompactGlow,
    mediaArtworkThemeEnabled,
    toggleArtworkTheme,

    // Weather
    weatherEnabled,
    toggleWeather,
    tempUnitFahrenheit,
    toggleTempUnit,
    cityName,
    cityQuery,
    setCityQuery,
    citySearchResults,
    showCityDropdown,
    setShowCityDropdown,
    selectCity,
    handleCityClear,

    // Widgets
    statusWidgets,
    handleWidgetsChange,
    hasBattery,

    // Dock
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
    dockTray,
    toggleDockTray,
    dockTaskView,
    toggleDockTaskView,
    dockShowDesktop,
    toggleDockShowDesktop,
    panelControlCenter,
    togglePanelControlCenter,
    panelShelf,
    togglePanelShelf,
    panelStatus,
    togglePanelStatus,
    panelOrder,
    reorderPanels,
    resetPanelOrder,
    ccLayout,
    changeCcLayout,
    resetCcLayout,
    dockRecycle,
    toggleDockRecycle,
    dockDrives,
    toggleDockDrive,
    weekStart,
    changeWeekStart,
    panelScrollDirection,
    changePanelScrollDirection,
    dockIndicator,
    changeDockIndicator,
    dockMenuItems,
    toggleDockMenuItem,
    hiddenDockApps,
    restoreHiddenDockApp,
    dockIconOnly,
    toggleDockIconOnly,
    startIcon,
    handleStartIconChange,
    dockAdaptive,
    toggleDockAdaptive,
    dockWinNumberEnabled,
    toggleDockWinNumber,
    dockMixedReorder,
    toggleDockMixedReorder,

    monitors,
    dockMonitorMode,
    setDockMonitorModeValue,
    dockMonitorId,
    setDockMonitorIdValue,
    notchMonitorMode,
    setNotchMonitorModeValue,
    notchMonitorId,
    setNotchMonitorIdValue,
    dockModeByMonitor,
    setDockModeForMonitor,
    replaceDockModesByMonitor,
    notchModeByMonitor,
    setNotchModeForMonitor,
    replaceNotchModesByMonitor,

    // Overlays
    volumeOverlayEnabled,
    toggleVolumeOverlay,
    volumeEdgeEnabled,
    toggleVolumeEdge,
    brightnessOverlayEnabled,
    toggleBrightnessOverlay,
    brightnessEdgeEnabled,
    toggleBrightnessEdge,

    // Updates
    updaterDisabled,
    updateStatus,
    updateVersion,
    appVersion,
    checkForUpdates,
    installUpdate,

    exportStatus,
    importStatus,
    handleExportSettings,
    handleImportSettings,
    resetStatus,
    handleResetSettings,
    uninstallStatus,
    uninstallError,
    handleUninstallNectar,

    // Utilities
    restartNectar: () => bridgeInvoke("restart_nectar"),
    quitNectar: () => bridgeInvoke("quit_nectar"),
  };
}
