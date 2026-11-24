import { useEffect, useRef, useState } from "react";
import {
  Search,
  Keyboard,
  MoveVertical,
  MoveHorizontal,
  ListFilter,
  History,
  Zap,
  Globe,
  MonitorOff,
  Trash2,
  AlertTriangle,
  Tags,
} from "lucide-react";
import { SettingSection } from "./SettingSection";
import { SettingRow } from "./SettingRow";
import { Dropdown } from "./Dropdown";
import { ShortcutRecorder } from "./ShortcutRecorder";
import { useT } from "../i18n";
import { useSettingsSync } from "../hooks/useSettingsSync";
import { useSyncedSetting } from "./useSyncedSetting";
import { bridgeInvoke } from "../utils/tauriBridge";
import { isHotkeyConflicted, useHotkeyStatus } from "./useHotkeyStatus";

const parseLauncherWidth = (v: unknown): string => {
  const s = String(v ?? "660");
  return s === "580" || s === "660" || s === "740" ? s : "660";
};
const parseBoolTrue = (v: unknown): boolean => v !== false && v !== "false";

function persistSetting(key: string, value: string, setter: (v: string) => void) {
  setter(value);
  localStorage.setItem(key, value);
  return bridgeInvoke("save_setting", { key, value }).catch(() => {});
}

export function LauncherTab({ legacyMode = false }: { legacyMode?: boolean }) {
  const t = useT();
  const [launcherWidth, setLauncherWidth] = useSyncedSetting("nectar-launcher-width", parseLauncherWidth, (v) => v);
  const [showChips, setShowChips] = useSyncedSetting("nectar-launcher-show-chips", parseBoolTrue, (v) => String(v));
  const [enabled, setEnabled] = useState(
    () => localStorage.getItem("nectar-launcher-enabled") !== "false"
  );
  const [hotkey, setHotkey] = useState(
    () => localStorage.getItem("nectar-launcher-hotkey") ?? "Alt+Space"
  );
  const [position, setPosition] = useState(
    () => localStorage.getItem("nectar-launcher-position") || "center"
  );
  const [maxResults, setMaxResults] = useState(
    () => localStorage.getItem("nectar-launcher-max-results") || "8"
  );
  const [showRecent, setShowRecent] = useState(
    () => localStorage.getItem("nectar-launcher-show-recent") !== "false"
  );
  // "Search files inline" removed: plain queries never search files; "? " prefix does.
  const [useEverything, setUseEverything] = useState(
    () => localStorage.getItem("nectar-launcher-everything") !== "false"
  );
  const [searchUrl, setSearchUrl] = useState(
    () =>
      localStorage.getItem("nectar-launcher-search-url") ||
      "https://www.google.com/search?q={query}"
  );
  const [fullscreenSuppress, setFullscreenSuppress] = useState(
    () => localStorage.getItem("nectar-launcher-fullscreen-suppress") !== "false"
  );
  const [clearedNote, setClearedNote] = useState(false);
  const clearedTimerRef = useRef<number | null>(null);
  const [hotkeyStatus, refreshHotkeyStatus] = useHotkeyStatus(`${hotkey}|${enabled}|${legacyMode}`);
  const hotkeyConflict =
    !legacyMode &&
    enabled &&
    isHotkeyConflicted(
      hotkey,
      hotkeyStatus?.launcher_ok,
      hotkeyStatus?.launcher_shortcut
    );

  useEffect(() => {
    return () => {
      if (clearedTimerRef.current !== null) {
        window.clearTimeout(clearedTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    bridgeInvoke<Record<string, unknown>>("load_settings")
      .then((s) => {
        if (cancelled || !s) return;
        if (s["nectar-launcher-enabled"] !== undefined) {
          setEnabled(String(s["nectar-launcher-enabled"]) !== "false");
        }
        if (s["nectar-launcher-hotkey"] !== undefined && s["nectar-launcher-hotkey"] !== null) {
          setHotkey(String(s["nectar-launcher-hotkey"]));
        }
        if (s["nectar-launcher-position"] != null) {
          setPosition(String(s["nectar-launcher-position"]) || "center");
        }
        if (s["nectar-launcher-max-results"] != null) {
          setMaxResults(String(s["nectar-launcher-max-results"]) || "8");
        }
        if (s["nectar-launcher-show-recent"] !== undefined) {
          setShowRecent(String(s["nectar-launcher-show-recent"]) !== "false");
        }
        if (s["nectar-launcher-search-url"] != null) {
          setSearchUrl(
            String(s["nectar-launcher-search-url"]) || "https://www.google.com/search?q={query}"
          );
        }
        if (s["nectar-launcher-fullscreen-suppress"] !== undefined) {
          setFullscreenSuppress(String(s["nectar-launcher-fullscreen-suppress"]) !== "false");
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useSettingsSync({
    "nectar-launcher-enabled": (v) => setEnabled(v !== false && v !== "false"),
    "nectar-launcher-hotkey": (v) =>
      setHotkey(v === null || v === undefined ? "Alt+Space" : String(v)),
    "nectar-launcher-position": (v) => setPosition(String(v || "center")),
    "nectar-launcher-max-results": (v) => setMaxResults(String(v || "8")),
    "nectar-launcher-show-recent": (v) => setShowRecent(v !== false && v !== "false"),
    "nectar-launcher-everything": (v) => setUseEverything(v !== false && v !== "false"),
    "nectar-launcher-search-url": (v) =>
      setSearchUrl(String(v || "https://www.google.com/search?q={query}")),
    "nectar-launcher-fullscreen-suppress": (v) =>
      setFullscreenSuppress(v !== false && v !== "false"),
  });

  const toggleBool = (key: string, current: boolean, setter: (v: boolean) => void) => {
    const next = !current;
    setter(next);
    const val = String(next);
    localStorage.setItem(key, val);
    bridgeInvoke("save_setting", { key, value: val }).catch(() => {});
  };

  const commitSearchUrl = () => {
    persistSetting(
      "nectar-launcher-search-url",
      searchUrl.trim() || "https://www.google.com/search?q={query}",
      setSearchUrl
    );
  };

  return (
    <>
      {legacyMode && (
        <div className="settings-legacy-banner" role="note">
          <AlertTriangle size={14} />
          <span>{t("settings.legacyDisabledNotice")}</span>
        </div>
      )}

      <SettingSection id="launcher-general" title={t("launcher.settings.general")} defaultOpen>
        <SettingRow icon={Search} label={t("launcher.settings.enabled")} desc={t("launcher.settings.enabled.desc")}>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={enabled}
              onChange={() => toggleBool("nectar-launcher-enabled", enabled, setEnabled)}
            />
            <span className="slider"></span>
          </label>
        </SettingRow>

        <SettingRow
          icon={Keyboard}
          label={t("launcher.settings.hotkey")}
          desc={t("launcher.settings.hotkey.desc")}
          divider={!hotkeyConflict}
        >
          <ShortcutRecorder
            value={hotkey}
            onCommit={(next) => {
              persistSetting("nectar-launcher-hotkey", next, setHotkey).then(refreshHotkeyStatus);
            }}
          />
        </SettingRow>
        {hotkeyConflict && (
          <>
            <div className="settings-inline-warning" role="alert">
              <AlertTriangle size={13} />
              <span>{t("settings.hotkeyConflict")}</span>
            </div>
            <div className="setting-divider" />
          </>
        )}

        <SettingRow icon={MoveVertical} label={t("launcher.settings.position")} desc={t("launcher.settings.position.desc")} settingKey="launcher.settings.position">
          <Dropdown
            value={position}
            onChange={(val) => persistSetting("nectar-launcher-position", val, setPosition)}
            options={[
              { value: "center", label: t("launcher.settings.pos.center") },
              { value: "bottom", label: t("launcher.settings.pos.bottom") },
            ]}
          />
        </SettingRow>

        <SettingRow icon={MoveHorizontal} label={t("launcher.settings.width")} desc={t("launcher.settings.width.desc")} settingKey="launcher.settings.width">
          <Dropdown
            value={launcherWidth}
            onChange={(val) => void setLauncherWidth(val)}
            options={[
              { value: "580", label: t("launcher.settings.width.compact") },
              { value: "660", label: t("launcher.settings.width.default") },
              { value: "740", label: t("launcher.settings.width.wide") },
            ]}
          />
        </SettingRow>

        <SettingRow icon={Tags} label={t("launcher.settings.showChips")} desc={t("launcher.settings.showChips.desc")} settingKey="launcher.settings.showChips">
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={showChips}
              onChange={() => void setShowChips(!showChips)}
            />
            <span className="slider"></span>
          </label>
        </SettingRow>

        <SettingRow icon={ListFilter} label={t("launcher.settings.maxResults")} desc={t("launcher.settings.maxResults.desc")}>
          <Dropdown
            value={maxResults}
            onChange={(val) => persistSetting("nectar-launcher-max-results", val, setMaxResults)}
            options={["6", "8", "10", "12"].map((n) => ({ value: n, label: n }))}
          />
        </SettingRow>

        <SettingRow icon={MonitorOff} label={t("launcher.settings.fullscreenSuppress")} desc={t("launcher.settings.fullscreenSuppress.desc")} divider={false}>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={fullscreenSuppress}
              onChange={() =>
                toggleBool(
                  "nectar-launcher-fullscreen-suppress",
                  fullscreenSuppress,
                  setFullscreenSuppress
                )
              }
            />
            <span className="slider"></span>
          </label>
        </SettingRow>
      </SettingSection>

      <SettingSection id="launcher-search" title={t("launcher.settings.search")}>
        <SettingRow icon={History} label={t("launcher.settings.showRecent")} desc={t("launcher.settings.showRecent.desc")}>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={showRecent}
              onChange={() => toggleBool("nectar-launcher-show-recent", showRecent, setShowRecent)}
            />
            <span className="slider"></span>
          </label>
        </SettingRow>

        <SettingRow icon={Zap} label={t("launcher.settings.everything")} desc={t("launcher.settings.everything.desc")}>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={useEverything}
              onChange={() =>
                toggleBool("nectar-launcher-everything", useEverything, setUseEverything)
              }
            />
            <span className="slider"></span>
          </label>
        </SettingRow>

        <SettingRow icon={Globe} label={t("launcher.settings.webUrl")} desc={t("launcher.settings.webUrl.desc")}>
          <input
            type="text"
            className="shortcut-input settings-url-input"
            value={searchUrl}
            onChange={(e) => setSearchUrl(e.target.value)}
            onBlur={commitSearchUrl}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.currentTarget.blur();
              }
            }}
          />
        </SettingRow>

        <SettingRow icon={Trash2} label={t("launcher.settings.clearHistory")} desc={t("launcher.settings.clearHistory.desc")} divider={false}>
          <button
            type="button"
            className="agent-sound-btn"
            onClick={() => {
              bridgeInvoke("clear_launcher_history")
                .then(() => {
                  setClearedNote(true);
                  if (clearedTimerRef.current !== null) {
                    window.clearTimeout(clearedTimerRef.current);
                  }
                  clearedTimerRef.current = window.setTimeout(() => {
                    setClearedNote(false);
                    clearedTimerRef.current = null;
                  }, 1800);
                })
                .catch(() => {});
            }}
          >
            {clearedNote ? t("launcher.settings.cleared") : t("launcher.settings.clearBtn")}
          </button>
        </SettingRow>
      </SettingSection>
    </>
  );
}
