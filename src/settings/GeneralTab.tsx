import { useEffect, useRef, useState } from "react";
import { Power, Download, Clock, CalendarDays, History, BatteryWarning, RefreshCw, LogOut, Languages, MemoryStick, Zap, Gauge, Gamepad2, Activity, VolumeX, BellOff, Cpu } from "lucide-react";
import { SettingRow } from "./SettingRow";
import { SettingSection } from "./SettingSection";
import { Dropdown } from "./Dropdown";
import { useSyncedSetting } from "./useSyncedSetting";
import { markLocalSettingWrites } from "../hooks/useSettingsSync";
import { notifyLocalSettingChanges } from "../utils/settingsHydration";
import { bridgeInvoke } from "../utils/tauriBridge";
import { LANGUAGES, getLanguagePreference, setLanguagePreference, useT } from "../i18n";

const parsePerfProfile = (v: unknown): string => {
  if (v === null || v === undefined || String(v).trim() === "") {
    try {
      if (typeof localStorage !== "undefined" && localStorage.getItem("nectar-ram-saver") === "true") {
        return "eco";
      }
    } catch {
      /* ignore */
    }
    return "balanced";
  }
  const s = String(v).trim().toLowerCase();
  return s === "eco" || s === "max" ? s : "balanced";
};
const parseMetricsInterval = (v: unknown): string => {
  const n = parseInt(String(v ?? "3000"), 10);
  if (n === 1500 || n === 3000 || n === 5000) return String(n);
  return "3000";
};
const parseBoolTrue = (v: unknown): boolean => v !== false && v !== "false";
const parseBoolFalse = (v: unknown): boolean => v === true || v === "true";

interface GeneralTabProps {
  autostart: boolean;
  weekStart: string;
  changeWeekStart: (value: string) => void;
  toggleAutostart: () => void;
  timeFormat24h: boolean;
  toggleTimeFormat24h: () => void;
  legacyMode: boolean;
  toggleLegacyMode: () => void;
  showUpdateIndicator: boolean;
  toggleUpdateIndicator: () => void;
  ramSaver: boolean;
  toggleRamSaver: () => void;
  ramUltra: boolean;
  toggleRamUltra: () => void;
  lowBatteryThreshold: number;
  hasBattery: boolean;
  handleThresholdChange: (val: number) => void;
  restartNectar: () => void;
  quitNectar: () => void;
}

export function GeneralTab({
  autostart,
  weekStart,
  changeWeekStart,
  toggleAutostart,
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
  lowBatteryThreshold,
  hasBattery,
  handleThresholdChange,
  restartNectar,
  quitNectar,
}: GeneralTabProps) {
  const t = useT();
  const [perfProfile] = useSyncedSetting("nectar-perf-profile", parsePerfProfile, (v) => v);
  const [gameModeEnabled, setGameModeEnabled] = useSyncedSetting("nectar-game-mode", parseBoolTrue, (v) => String(v));
  const [gameModePausePolls, setGameModePausePolls] = useSyncedSetting("nectar-game-mode-pause-polls", parseBoolTrue, (v) => String(v));
  const [gameModeMuteAgents, setGameModeMuteAgents] = useSyncedSetting("nectar-game-mode-mute-agents", parseBoolTrue, (v) => String(v));
  const [gameModeSuppressToasts, setGameModeSuppressToasts] = useSyncedSetting("nectar-game-mode-suppress-toasts", parseBoolFalse, (v) => String(v));

  const [metricsInterval, setMetricsInterval] = useSyncedSetting("nectar-metrics-interval-ms", parseMetricsInterval, (v) => v);
  const [reclaimNote, setReclaimNote] = useState<string | null>(null);
  const [reclaiming, setReclaiming] = useState(false);
  const reclaimTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (reclaimTimerRef.current !== null) {
        window.clearTimeout(reclaimTimerRef.current);
        reclaimTimerRef.current = null;
      }
    };
  }, []);

  const handlePerfProfileChange = async (rawVal: string) => {
    const next = parsePerfProfile(rawVal);
    const eco = String(next === "eco");
    const nextInterval = next === "eco" ? "5000" : next === "max" ? "1500" : "3000";
    const entries = {
      "nectar-perf-profile": next,
      "nectar-ram-saver": eco,
      "nectar-metrics-interval-ms": nextInterval,
    };
    const keys = Object.keys(entries);
    try {
      for (const [k, v] of Object.entries(entries)) {
        localStorage.setItem(k, v);
      }
    } catch {
      /* ignore */
    }
    markLocalSettingWrites(keys);
    notifyLocalSettingChanges(keys);
    await bridgeInvoke("save_settings_batch", { entries }).catch(() => {});
  };

  const handleReclaimMemory = async () => {
    if (reclaiming) return;
    setReclaiming(true);
    try {
      const count = await bridgeInvoke<number>("reclaim_memory_now");
      if (!mountedRef.current) return;
      setReclaimNote(t("general.reclaimNow.done", { count: typeof count === "number" ? count : 0 }));
    } catch {
      if (!mountedRef.current) return;
      setReclaimNote(t("general.reclaimNow.error"));
    } finally {
      if (mountedRef.current) {
        setReclaiming(false);
        if (reclaimTimerRef.current !== null) {
          window.clearTimeout(reclaimTimerRef.current);
        }
        reclaimTimerRef.current = window.setTimeout(() => {
          reclaimTimerRef.current = null;
          if (mountedRef.current) setReclaimNote(null);
        }, 2500);
      }
    }
  };

  const languageOptions = [
    { value: "system", label: t("general.language.system") },
    ...Object.entries(LANGUAGES).map(([value, { name }]) => ({ value, label: name })),
  ];
  return (
    <>
      <SettingSection id="general-system" title={t("general.system")} defaultOpen>
        <SettingRow icon={Power} label={t("general.launchAtLogin")} desc={t("general.launchAtLogin.desc")} settingKey="general.launchAtLogin">
          <label className="toggle-switch">
            <input type="checkbox" checked={autostart} onChange={toggleAutostart} />
            <span className="slider"></span>
          </label>
        </SettingRow>

        <SettingRow icon={Download} label={t("general.updateIndicator")} desc={t("general.updateIndicator.desc")} settingKey="general.updateIndicator">
          <label className="toggle-switch">
            <input type="checkbox" checked={showUpdateIndicator} onChange={toggleUpdateIndicator} />
            <span className="slider"></span>
          </label>
        </SettingRow>

        <SettingRow icon={Languages} label={t("general.language")} desc={t("general.language.desc")} settingKey="general.language">
          <Dropdown value={getLanguagePreference()} options={languageOptions} onChange={setLanguagePreference} />
        </SettingRow>

        <SettingRow icon={CalendarDays} label={t("general.weekStart")} desc={t("general.weekStart.desc")} settingKey="general.weekStart">
          <Dropdown
            value={weekStart}
            options={[
              { value: "auto", label: t("general.weekStart.auto") },
              { value: "sunday", label: t("general.weekStart.sunday") },
              { value: "monday", label: t("general.weekStart.monday") },
            ]}
            onChange={changeWeekStart}
          />
        </SettingRow>

        <SettingRow icon={Clock} label={t("general.time24h")} desc={t("general.time24h.desc")} settingKey="general.time24h">
          <label className="toggle-switch">
            <input type="checkbox" checked={timeFormat24h} onChange={toggleTimeFormat24h} />
            <span className="slider"></span>
          </label>
        </SettingRow>

        <SettingRow
          icon={History}
          label={t("general.legacyMode")}
          desc={t("general.legacyMode.desc")}
          settingKey="general.legacyMode"
          divider={hasBattery}
        >
          <label className="toggle-switch">
            <input type="checkbox" checked={legacyMode} onChange={toggleLegacyMode} />
            <span className="slider"></span>
          </label>
        </SettingRow>

        {hasBattery && (
          <SettingRow
            icon={BatteryWarning}
            label={t("general.lowBattery")}
            desc={t("general.lowBattery.desc", { percent: lowBatteryThreshold })}
            settingKey="general.lowBattery"
            divider={false}
          >
            <input
              type="range"
              min="5"
              max="50"
              step="5"
              value={lowBatteryThreshold}
              onChange={(e) => handleThresholdChange(parseInt(e.target.value))}
              className="settings-slider"
            />
          </SettingRow>
        )}
      </SettingSection>

      <SettingSection id="general-performance" title={t("general.performance")} defaultOpen>
        <SettingRow icon={Gauge} label={t("general.perfProfile")} desc={t(`general.perfProfile.${perfProfile}.desc`)} settingKey="general.perfProfile">
          <Dropdown
            value={perfProfile}
            onChange={(val) => void handlePerfProfileChange(val)}
            options={[
              { value: "balanced", label: t("general.perfProfile.balanced") },
              { value: "eco", label: t("general.perfProfile.eco") },
              { value: "max", label: t("general.perfProfile.max") },
            ]}
          />
        </SettingRow>

        <SettingRow icon={Gamepad2} label={t("general.gameMode")} desc={t("general.gameMode.desc")} settingKey="general.gameMode">
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={gameModeEnabled}
              onChange={() => void setGameModeEnabled(!gameModeEnabled)}
            />
            <span className="slider"></span>
          </label>
        </SettingRow>

        {gameModeEnabled && (
          <>
            <SettingRow icon={Cpu} label={t("general.gameModePausePolls")} desc={t("general.gameModePausePolls.desc")} settingKey="general.gameModePausePolls">
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={gameModePausePolls}
                  onChange={() => void setGameModePausePolls(!gameModePausePolls)}
                />
                <span className="slider"></span>
              </label>
            </SettingRow>

            <SettingRow icon={VolumeX} label={t("general.gameModeMuteAgents")} desc={t("general.gameModeMuteAgents.desc")} settingKey="general.gameModeMuteAgents">
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={gameModeMuteAgents}
                  onChange={() => void setGameModeMuteAgents(!gameModeMuteAgents)}
                />
                <span className="slider"></span>
              </label>
            </SettingRow>

            <SettingRow icon={BellOff} label={t("general.gameModeSuppressToasts")} desc={t("general.gameModeSuppressToasts.desc")} settingKey="general.gameModeSuppressToasts">
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={gameModeSuppressToasts}
                  onChange={() => void setGameModeSuppressToasts(!gameModeSuppressToasts)}
                />
                <span className="slider"></span>
              </label>
            </SettingRow>
          </>
        )}

        <SettingRow icon={Activity} label={t("general.metricsInterval")} desc={t("general.metricsInterval.desc")} settingKey="general.metricsInterval">
          <Dropdown
            value={metricsInterval}
            onChange={(val) => void setMetricsInterval(val)}
            options={[
              { value: "1500", label: t("general.metricsInterval.fast") },
              { value: "3000", label: t("general.metricsInterval.balanced") },
              { value: "5000", label: t("general.metricsInterval.eco") },
            ]}
          />
        </SettingRow>

        <SettingRow icon={MemoryStick} label={t("general.ramSaver")} desc={t("general.ramSaver.desc")} settingKey="general.ramSaver">
          <label className="toggle-switch">
            <input type="checkbox" checked={ramSaver} onChange={toggleRamSaver} />
            <span className="slider"></span>
          </label>
        </SettingRow>

        <SettingRow icon={Zap} label={t("general.ramUltra")} desc={t("general.ramUltra.desc")} settingKey="general.ramUltra">
          <label className="toggle-switch">
            <input type="checkbox" checked={ramUltra} onChange={toggleRamUltra} />
            <span className="slider"></span>
          </label>
        </SettingRow>

        <SettingRow
          icon={MemoryStick}
          label={t("general.reclaimNow")}
          desc={reclaimNote || t("general.reclaimNow.desc")}
          settingKey="general.reclaimNow"
          divider={false}
        >
          <button
            type="button"
            className="agent-sound-btn"
            disabled={reclaiming}
            onClick={() => void handleReclaimMemory()}
          >
            {reclaiming ? t("general.reclaimNow.working") : t("general.reclaimNow.btn")}
          </button>
        </SettingRow>
      </SettingSection>

      <SettingSection id="general-app" title={t("general.app")}>
        <SettingRow icon={RefreshCw} label={t("general.restart")} desc={t("general.restart.desc")} settingKey="general.restart" action onClick={restartNectar} />
        <SettingRow icon={LogOut} label={t("general.quit")} desc={t("general.quit.desc")} settingKey="general.quit" action danger onClick={quitNectar} divider={false} />
      </SettingSection>
    </>
  );
}
