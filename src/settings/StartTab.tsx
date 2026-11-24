import { useEffect, useState } from "react";
import {
  LayoutGrid,
  Keyboard,
  AlignHorizontalJustifyCenter,
  Sparkles,
  Columns3,
  AlertTriangle,
  Scaling,
  ListOrdered,
} from "lucide-react";
import { SettingSection } from "./SettingSection";
import { SettingRow } from "./SettingRow";
import { Dropdown } from "./Dropdown";
import { useT } from "../i18n";
import { useSettingsSync } from "../hooks/useSettingsSync";
import { useSyncedSetting } from "./useSyncedSetting";
import { bridgeInvoke } from "../utils/tauriBridge";

const parseTileSize = (v: unknown): string => {
  const s = String(v ?? "normal").trim().toLowerCase();
  return s === "compact" || s === "large" ? s : "normal";
};
const parseRecCount = (v: unknown): string => {
  const n = parseInt(String(v ?? "6"), 10);
  if (n === 2 || n === 4 || n === 6) return String(n);
  return "6";
};

export function StartTab({ legacyMode = false }: { legacyMode?: boolean }) {
  const t = useT();
  const [tileSize, setTileSize] = useSyncedSetting("nectar-start-tile-size", parseTileSize, (v) => v);
  const [recCount, setRecCount] = useSyncedSetting("nectar-start-rec-count", parseRecCount, (v) => v);
  const [customEnabled, setCustomEnabled] = useState(
    () => localStorage.getItem("nectar-start-custom-enabled") !== "false"
  );
  const [winkeyHook, setWinkeyHook] = useState(
    () => localStorage.getItem("nectar-start-winkey-hook") !== "false"
  );
  const [align, setAlign] = useState(
    () => localStorage.getItem("nectar-start-align") || "center"
  );
  const [showRecommended, setShowRecommended] = useState(
    () => localStorage.getItem("nectar-start-show-recommended") !== "false"
  );
  const [columns, setColumns] = useState(
    () => localStorage.getItem("nectar-start-columns") || "6"
  );

  useEffect(() => {
    let cancelled = false;
    bridgeInvoke<Record<string, unknown>>("load_settings")
      .then((s) => {
        if (cancelled || !s) return;
        if (s["nectar-start-custom-enabled"] !== undefined) {
          setCustomEnabled(String(s["nectar-start-custom-enabled"]) !== "false");
        }
        if (s["nectar-start-winkey-hook"] !== undefined) {
          setWinkeyHook(String(s["nectar-start-winkey-hook"]) !== "false");
        }
        if (s["nectar-start-align"] != null) {
          setAlign(String(s["nectar-start-align"]) || "center");
        }
        if (s["nectar-start-show-recommended"] !== undefined) {
          setShowRecommended(String(s["nectar-start-show-recommended"]) !== "false");
        }
        if (s["nectar-start-columns"] != null) {
          setColumns(String(s["nectar-start-columns"]) || "6");
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useSettingsSync({
    "nectar-start-custom-enabled": (v) => setCustomEnabled(v !== false && v !== "false"),
    "nectar-start-winkey-hook": (v) => setWinkeyHook(v !== false && v !== "false"),
    "nectar-start-align": (v) => setAlign(String(v || "center")),
    "nectar-start-show-recommended": (v) => setShowRecommended(v !== false && v !== "false"),
    "nectar-start-columns": (v) => setColumns(String(v || "6")),
  });

  const toggleBool = (key: string, current: boolean, setter: (v: boolean) => void) => {
    const next = !current;
    setter(next);
    const val = String(next);
    localStorage.setItem(key, val);
    bridgeInvoke("save_setting", { key, value: val }).catch(() => {});
  };

  const updateString = (key: string, value: string, setter: (v: string) => void) => {
    setter(value);
    localStorage.setItem(key, value);
    bridgeInvoke("save_setting", { key, value }).catch(() => {});
  };

  return (
    <>
      {legacyMode && (
        <div className="settings-legacy-banner" role="note">
          <AlertTriangle size={14} />
          <span>{t("settings.legacyDisabledNotice")}</span>
        </div>
      )}

      <SettingSection id="start-general" title={t("start.settings.title")} defaultOpen>
        <SettingRow icon={LayoutGrid} label={t("start.settings.enabled")} desc={t("start.settings.enabled.desc")}>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={customEnabled}
              onChange={() =>
                toggleBool("nectar-start-custom-enabled", customEnabled, setCustomEnabled)
              }
            />
            <span className="slider"></span>
          </label>
        </SettingRow>

        <SettingRow icon={Keyboard} label={t("start.settings.winKey")} desc={t("start.settings.winKey.desc")}>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={winkeyHook}
              onChange={() => toggleBool("nectar-start-winkey-hook", winkeyHook, setWinkeyHook)}
            />
            <span className="slider"></span>
          </label>
        </SettingRow>

        <SettingRow icon={AlignHorizontalJustifyCenter} label={t("start.settings.align")} desc={t("start.settings.align.desc")}>
          <Dropdown
            value={align}
            onChange={(val) => updateString("nectar-start-align", val, setAlign)}
            options={[
              { value: "center", label: t("start.settings.align.center") },
              { value: "left", label: t("start.settings.align.left") },
            ]}
          />
        </SettingRow>

        <SettingRow icon={Columns3} label={t("start.settings.columns")} desc={t("start.settings.columns.desc")} settingKey="start.settings.columns">
          <Dropdown
            value={columns}
            onChange={(val) => updateString("nectar-start-columns", val, setColumns)}
            options={["5", "6", "7"].map((n) => ({ value: n, label: n }))}
          />
        </SettingRow>

        <SettingRow icon={Scaling} label={t("start.settings.tileSize")} desc={t("start.settings.tileSize.desc")} settingKey="start.settings.tileSize">
          <Dropdown
            value={tileSize}
            onChange={(val) => void setTileSize(val)}
            options={[
              { value: "compact", label: t("start.settings.tileSize.compact") },
              { value: "normal", label: t("start.settings.tileSize.normal") },
              { value: "large", label: t("start.settings.tileSize.large") },
            ]}
          />
        </SettingRow>

        <SettingRow icon={Sparkles} label={t("start.settings.recommended")} desc={t("start.settings.recommended.desc")} divider={showRecommended} settingKey="start.settings.recommended">
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={showRecommended}
              onChange={() =>
                toggleBool("nectar-start-show-recommended", showRecommended, setShowRecommended)
              }
            />
            <span className="slider"></span>
          </label>
        </SettingRow>

        {showRecommended && (
          <SettingRow icon={ListOrdered} label={t("start.settings.recCount")} desc={t("start.settings.recCount.desc")} divider={false} settingKey="start.settings.recCount">
            <Dropdown
              value={recCount}
              onChange={(val) => void setRecCount(val)}
              options={["2", "4", "6"].map((n) => ({ value: n, label: n }))}
            />
          </SettingRow>
        )}
      </SettingSection>
    </>
  );
}
