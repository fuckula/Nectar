import { StrictMode, useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Settings, Palette, PanelTop, Monitor, Layers, Info, Bug, Search, LayoutGrid } from "lucide-react";
import { WindowControls } from "./components/WindowControls";
import { NectarMotionProvider } from "./components/NectarMotionProvider";
import {
  useSettings,
  GeneralTab,
  AppearanceTab,
  NotchTab,
  CalendarSyncPage,
  DockTab,
  LauncherTab,
  StartTab,
  OverlaysTab,
  AboutTab,
  DiagnosticsTab,
} from "./settings/index";
import type { SettingsTab } from "./settings/index";
import { initTheme } from "./theme";
import { useT } from "./i18n";
import { SettingsSearchBox, SearchResults, useSearchHits } from "./settings/SettingsSearch";
import type { SearchEntry } from "./settings/searchIndex";
import { applyPreviewThemeParams, bridgeInvoke, bridgeListen, isTauriRuntime } from "./utils/tauriBridge";
import "./surfaces.css";
import "./Settings.css";

const appWindow = isTauriRuntime() ? getCurrentWebviewWindow() : null;

const TABS: { id: SettingsTab; labelKey: string; icon: typeof Settings }[] = [
  { id: "general", labelKey: "tabs.general", icon: Settings },
  { id: "appearance", labelKey: "tabs.appearance", icon: Palette },
  { id: "notch", labelKey: "tabs.notch", icon: PanelTop },
  { id: "dock", labelKey: "tabs.dock", icon: Monitor },
  { id: "launcher", labelKey: "tabs.launcher", icon: Search },
  { id: "start", labelKey: "tabs.start", icon: LayoutGrid },
  { id: "overlays", labelKey: "tabs.overlays", icon: Layers },
  { id: "about", labelKey: "tabs.about", icon: Info },
  { id: "diagnostics", labelKey: "tabs.diagnostics", icon: Bug },
];

function SettingsApp() {
  const t = useT();
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const settings = useSettings();
  const hits = useSearchHits(query);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current !== null) {
        window.clearTimeout(flashTimerRef.current);
        flashTimerRef.current = null;
      }
    };
  }, []);

  const pick = (entry: SearchEntry) => {
    setQuery("");
    setActiveTab(entry.tab);
    setPending(entry.key.startsWith("tabs.") ? null : entry.key);
  };

  useEffect(() => {
    if (!pending) return;
    const label = t(pending);
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      window.dispatchEvent(new Event("nectar-settings-reveal"));
      const exact = document.querySelector<HTMLElement>(
        `[data-setting-key="${CSS.escape(pending)}"]`
      );
      const exactTarget = exact
        ? exact.classList.contains("setting-item") ||
          exact.classList.contains("setting-section-header") ||
          exact.classList.contains("widget-config-zone")
          ? exact
          : exact.querySelector<HTMLElement>(".setting-item") ?? exact
        : null;
      const row =
        exactTarget ??
        Array.from(
          document.querySelectorAll<HTMLElement>(
            ".setting-item, .setting-section-header, .widget-config-zone"
          )
        ).find(
          (el) => (el.querySelector(".setting-label") ?? el.querySelector("span"))?.textContent?.trim() === label
        );
      if (row) {
        clearInterval(timer);
        row.scrollIntoView({ block: "center", behavior: "smooth" });
        row.classList.add("setting-flash");
        if (flashTimerRef.current !== null) {
          window.clearTimeout(flashTimerRef.current);
        }
        flashTimerRef.current = window.setTimeout(() => {
          row.classList.remove("setting-flash");
          flashTimerRef.current = null;
        }, 1800);
        setPending(null);
      } else if (tries > 20) {
        clearInterval(timer);
        setPending(null);
      }
    }, 80);
    return () => clearInterval(timer);
  }, [pending, activeTab]);

  useEffect(() => {
    applyPreviewThemeParams();
    return initTheme();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    bridgeListen<string>("settings-navigate", (target) => {
      if (target === "calendar-sync") setActiveTab("calendar-sync");
    }).then((fn) => {
      if (cancelled) fn();
      else stop = fn;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  useEffect(() => {
    const preventContext = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", preventContext as any);

    if (appWindow) {
      appWindow.clearEffects().catch(() => {})
        .finally(() => {
          requestAnimationFrame(() => requestAnimationFrame(() => bridgeInvoke("on_demand_window_ready").catch(() => {})));
        });
    }

    return () => {
      document.removeEventListener("contextmenu", preventContext as any);
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const scale = Number.isFinite(settings.scale) && settings.scale > 0 ? settings.scale : 1;
    bridgeInvoke("resize_settings_window", {
      width: Math.max(620, Math.round(760 * scale)),
      height: Math.max(480, Math.round(620 * scale)),
    }).catch(console.error);
  }, [settings.scale]);

  const activeScale = Number.isFinite(settings.scale) && settings.scale > 0 ? settings.scale : 1;

  return (
    <div className="settings-container" style={{ zoom: activeScale }}>
      <div className="title-bar" data-tauri-drag-region>
        <span className="title-text" data-tauri-drag-region>
          {t("settings.title")}
        </span>
        <WindowControls />
      </div>

      <div className="settings-body">
        <div className="settings-sidebar">
          <SettingsSearchBox query={query} setQuery={setQuery} onEnter={() => hits[0] && pick(hits[0])} />
          {TABS.map(({ id, labelKey, icon: Icon }) => (
            <button
              key={id}
              className={`sidebar-tab ${activeTab === id || (id === "notch" && activeTab === "calendar-sync") ? "active" : ""}`}
              onClick={() => {
                setQuery("");
                setPending(null);
                setActiveTab(id);
              }}
            >
              <div className="sidebar-tab-icon">
                <Icon size={14} strokeWidth={1.5} />
              </div>
              <span>{t(labelKey)}</span>
            </button>
          ))}
        </div>

        <div className="settings-content">
          {query.trim() && <SearchResults hits={hits} query={query} onPick={pick} />}
          {!query.trim() && activeTab === "general" && (
            <GeneralTab
              autostart={settings.autostart}
              weekStart={settings.weekStart}
              changeWeekStart={settings.changeWeekStart}
              toggleAutostart={settings.toggleAutostart}
              timeFormat24h={settings.timeFormat24h}
              toggleTimeFormat24h={settings.toggleTimeFormat24h}
              legacyMode={settings.legacyMode}
              toggleLegacyMode={settings.toggleLegacyMode}
              showUpdateIndicator={settings.showUpdateIndicator}
              toggleUpdateIndicator={settings.toggleUpdateIndicator}
              ramSaver={settings.ramSaver}
              toggleRamSaver={settings.toggleRamSaver}
              ramUltra={settings.ramUltra}
              toggleRamUltra={settings.toggleRamUltra}
              lowBatteryThreshold={settings.lowBatteryThreshold}
              hasBattery={settings.hasBattery}
              handleThresholdChange={settings.handleThresholdChange}
              restartNectar={settings.restartNectar}
              quitNectar={settings.quitNectar}
            />
          )}
          {!query.trim() && activeTab === "appearance" && (
            <AppearanceTab
              themeMode={settings.themeMode}
              handleThemeModeChange={settings.handleThemeModeChange}
              themeColor={settings.themeColor}
              handleThemeColorChange={settings.handleThemeColorChange}
              themeOpacity={settings.themeOpacity}
              handleOpacityChange={settings.handleOpacityChange}
              themeSaturation={settings.themeSaturation}
              handleSaturationChange={settings.handleSaturationChange}
              themeBrightness={settings.themeBrightness}
              handleBrightnessChange={settings.handleBrightnessChange}
              themeStyle={settings.themeStyle}
              handleThemeStyleChange={settings.handleThemeStyleChange}
              themeAccent={settings.themeAccent}
              handleAccentChange={settings.handleAccentChange}
              themeAccentColor={settings.themeAccentColor}
              handleAccentColorChange={settings.handleAccentColorChange}
              applyThemePreset={settings.applyThemePreset}
              applyThemeSettingsMap={settings.applyThemeSettingsMap}
              selectionColor={settings.selectionColor}
              handleSelectionColorChange={settings.handleSelectionColorChange}
              resetSelectionColor={settings.resetSelectionColor}
              syncWindowsSelection={settings.syncWindowsSelection}
              toggleSyncWindowsSelection={settings.toggleSyncWindowsSelection}
              selectionSyncError={settings.selectionSyncError}
              selectionNeedsExplorerRefresh={settings.selectionNeedsExplorerRefresh}
              explorerRefreshState={settings.explorerRefreshState}
              explorerRefreshDone={settings.explorerRefreshDone}
              refreshDesktopSelection={settings.refreshDesktopSelection}
              legacyMode={settings.legacyMode}
              cornersEnabled={settings.cornersEnabled}
              toggleCorners={settings.toggleCorners}
              scale={settings.scale}
              handleScaleChange={settings.handleScaleChange}
            />
          )}
          {!query.trim() && activeTab === "calendar-sync" && <CalendarSyncPage onBack={() => setActiveTab("notch")} />}
          {!query.trim() && activeTab === "notch" && (
            <NotchTab
              onOpenCalendarSync={() => setActiveTab("calendar-sync")}
              notchMode={settings.notchMode}
              setNotchModeValue={settings.setNotchModeValue}
              monitors={settings.monitors}
              notchMonitorMode={settings.notchMonitorMode}
              setNotchMonitorModeValue={settings.setNotchMonitorModeValue}
              notchMonitorId={settings.notchMonitorId}
              setNotchMonitorIdValue={settings.setNotchMonitorIdValue}
              notchModeByMonitor={settings.notchModeByMonitor}
              setNotchModeForMonitor={settings.setNotchModeForMonitor}
              replaceNotchModes={settings.replaceNotchModesByMonitor}
              calendarEnabled={settings.calendarEnabled}
              toggleCalendar={settings.toggleCalendar}
              timerEnabled={settings.timerEnabled}
              toggleTimerEnabled={settings.toggleTimerEnabled}
              timerSoundEnabled={settings.timerSoundEnabled}
              toggleTimerSound={settings.toggleTimerSound}
              notchTimerProgress={settings.notchTimerProgress}
              toggleNotchTimerProgress={settings.toggleNotchTimerProgress}
              stopwatchEnabled={settings.stopwatchEnabled}
              toggleStopwatchEnabled={settings.toggleStopwatchEnabled}
              legacyMode={settings.legacyMode}
              dualClockEnabled={settings.dualClockEnabled}
              toggleDualClock={settings.toggleDualClock}
              dualClockZone={settings.dualClockZone}
              dualClockLabel={settings.dualClockLabel}
              selectDualClockZone={settings.selectDualClockZone}
              musicModeEnabled={settings.musicModeEnabled}
              toggleMusicMode={settings.toggleMusicMode}
              musicCompactNotch={settings.musicCompactNotch}
              toggleMusicCompactNotch={settings.toggleMusicCompactNotch}
              mediaLayout={settings.mediaLayout}
              toggleMediaLayout={settings.toggleMediaLayout}
              mediaAmbienceEnabled={settings.mediaAmbienceEnabled}
              toggleAmbience={settings.toggleAmbience}
              mediaCompactGlowEnabled={settings.mediaCompactGlowEnabled}
              toggleCompactGlow={settings.toggleCompactGlow}
              artworkThemeEnabled={settings.mediaArtworkThemeEnabled}
              toggleArtworkTheme={settings.toggleArtworkTheme}
              agentApi={settings.agentApi}
              toggleAgentApi={settings.toggleAgentApi}
              panelScrollDirection={settings.panelScrollDirection}
              changePanelScrollDirection={settings.changePanelScrollDirection}
              notchScrollVolume={settings.notchScrollVolume}
              toggleNotchScrollVolume={settings.toggleNotchScrollVolume}
              shelfPersist={settings.shelfPersist}
              toggleShelfPersist={settings.toggleShelfPersist}
              rememberMode={settings.rememberMode}
              toggleRememberMode={settings.toggleRememberMode}
              panelControlCenter={settings.panelControlCenter}
              togglePanelControlCenter={settings.togglePanelControlCenter}
              panelShelf={settings.panelShelf}
              togglePanelShelf={settings.togglePanelShelf}
              panelStatus={settings.panelStatus}
              togglePanelStatus={settings.togglePanelStatus}
              panelOrder={settings.panelOrder}
              reorderPanels={settings.reorderPanels}
              resetPanelOrder={settings.resetPanelOrder}
              ccLayout={settings.ccLayout}
              changeCcLayout={settings.changeCcLayout}
              resetCcLayout={settings.resetCcLayout}
              weatherEnabled={settings.weatherEnabled}
              toggleWeather={settings.toggleWeather}
              tempUnitFahrenheit={settings.tempUnitFahrenheit}
              toggleTempUnit={settings.toggleTempUnit}
              cityName={settings.cityName}
              cityQuery={settings.cityQuery}
              setCityQuery={settings.setCityQuery}
              citySearchResults={settings.citySearchResults}
              showCityDropdown={settings.showCityDropdown}
              setShowCityDropdown={settings.setShowCityDropdown}
              selectCity={settings.selectCity}
              handleCityClear={settings.handleCityClear}
              statusWidgets={settings.statusWidgets}
              handleWidgetsChange={settings.handleWidgetsChange}
              hasBattery={settings.hasBattery}
            />
          )}
          {!query.trim() && activeTab === "dock" && (
            <DockTab
              dockEnabled={settings.dockEnabled}
              toggleDock={settings.toggleDock}
              dockMode={settings.dockMode}
              setDockModeValue={settings.setDockModeValue}
              dockReserveSpace={settings.dockReserveSpace}
              toggleDockReserveSpace={settings.toggleDockReserveSpace}
              dockPreviewEnabled={settings.dockPreviewEnabled}
              toggleDockPreview={settings.toggleDockPreview}
              dockAttentionEnabled={settings.dockAttentionEnabled}
              toggleDockAttention={settings.toggleDockAttention}
              dockConsoleWindows={settings.dockConsoleWindows}
              toggleDockConsoleWindows={settings.toggleDockConsoleWindows}
              dockSearchEnabled={settings.dockSearchEnabled}
              toggleDockSearch={settings.toggleDockSearch}
              dockSearchProvider={settings.dockSearchProvider}
              handleDockSearchProviderChange={settings.handleDockSearchProviderChange}
              dockSearchShortcut={settings.dockSearchShortcut}
              handleDockSearchShortcutChange={settings.handleDockSearchShortcutChange}
              dockCalendarEnabled={settings.dockCalendarEnabled}
              toggleDockCalendar={settings.toggleDockCalendar}
              legacyMode={settings.legacyMode}
              dockTray={settings.dockTray}
              toggleDockTray={settings.toggleDockTray}
              dockTaskView={settings.dockTaskView}
              toggleDockTaskView={settings.toggleDockTaskView}
              dockShowDesktop={settings.dockShowDesktop}
              toggleDockShowDesktop={settings.toggleDockShowDesktop}
              dockRecycle={settings.dockRecycle}
              toggleDockRecycle={settings.toggleDockRecycle}
              dockDrives={settings.dockDrives}
              toggleDockDrive={settings.toggleDockDrive}
              hiddenDockApps={settings.hiddenDockApps}
              restoreHiddenDockApp={settings.restoreHiddenDockApp}
              dockIndicator={settings.dockIndicator}
              changeDockIndicator={settings.changeDockIndicator}
              dockMenuItems={settings.dockMenuItems}
              toggleDockMenuItem={settings.toggleDockMenuItem}
              dockIconOnly={settings.dockIconOnly}
              toggleDockIconOnly={settings.toggleDockIconOnly}
              dockAdaptive={settings.dockAdaptive}
              toggleDockAdaptive={settings.toggleDockAdaptive}
              startIcon={settings.startIcon}
              handleStartIconChange={settings.handleStartIconChange}
              dockWinNumberEnabled={settings.dockWinNumberEnabled}
              toggleDockWinNumber={settings.toggleDockWinNumber}
              dockMixedReorder={settings.dockMixedReorder}
              toggleDockMixedReorder={settings.toggleDockMixedReorder}
              monitors={settings.monitors}
              dockMonitorMode={settings.dockMonitorMode}
              setDockMonitorModeValue={settings.setDockMonitorModeValue}
              dockMonitorId={settings.dockMonitorId}
              setDockMonitorIdValue={settings.setDockMonitorIdValue}
              dockModeByMonitor={settings.dockModeByMonitor}
              setDockModeForMonitor={settings.setDockModeForMonitor}
              replaceDockModes={settings.replaceDockModesByMonitor}
            />
          )}
          {!query.trim() && activeTab === "launcher" && <LauncherTab legacyMode={settings.legacyMode} />}
          {!query.trim() && activeTab === "start" && <StartTab legacyMode={settings.legacyMode} />}
          {!query.trim() && activeTab === "overlays" && (
            <OverlaysTab
              volumeOverlayEnabled={settings.volumeOverlayEnabled}
              toggleVolumeOverlay={settings.toggleVolumeOverlay}
              volumeEdgeEnabled={settings.volumeEdgeEnabled}
              toggleVolumeEdge={settings.toggleVolumeEdge}
              brightnessOverlayEnabled={settings.brightnessOverlayEnabled}
              toggleBrightnessOverlay={settings.toggleBrightnessOverlay}
              brightnessEdgeEnabled={settings.brightnessEdgeEnabled}
              toggleBrightnessEdge={settings.toggleBrightnessEdge}
            />
          )}
          {!query.trim() && activeTab === "about" && (
            <AboutTab
              appVersion={settings.appVersion}
              updaterDisabled={settings.updaterDisabled}
              autoUpdate={settings.autoUpdate}
              toggleAutoUpdate={settings.toggleAutoUpdate}
              prereleaseChannel={settings.prereleaseChannel}
              togglePrereleaseChannel={settings.togglePrereleaseChannel}
              updateStatus={settings.updateStatus}
              updateVersion={settings.updateVersion}
              checkForUpdates={settings.checkForUpdates}
              installUpdate={settings.installUpdate}
              exportStatus={settings.exportStatus}
              importStatus={settings.importStatus}
              handleExportSettings={settings.handleExportSettings}
              handleImportSettings={settings.handleImportSettings}
              resetStatus={settings.resetStatus}
              handleResetSettings={settings.handleResetSettings}
              uninstallStatus={settings.uninstallStatus}
              uninstallError={settings.uninstallError}
              handleUninstallNectar={settings.handleUninstallNectar}
            />
          )}
          {!query.trim() && activeTab === "diagnostics" && <DiagnosticsTab />}
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <NectarMotionProvider>
      <SettingsApp />
    </NectarMotionProvider>
  </StrictMode>
);
